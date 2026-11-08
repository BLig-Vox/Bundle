import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "bundle/src/cli/program.ts";
import { withDatabase } from "bundle/src/database/connection.ts";
import { createRouter } from "bundle/src/web/router.ts";
import { createAuthHandlers, createProcessAuthAttemptLimiter, productionLimiterError, type AuthAttemptLimiter } from "./routes/Auth.ts";
import { appRoot } from "./routes/Notes.ts";
import { createRoutes } from "./web/routes.ts";
import { RouteContext } from "./web/router.ts";
import { authenticatedUserId, createRequireAuth } from "./auth.ts";
import { User } from "./models/User.ts";
import { Session } from "./models/Session.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(extra = {}, limiter?: AuthAttemptLimiter) {
  await mkdir(join(appRoot, ".data"), { recursive: true });
  const directory = await mkdtemp(join(appRoot, ".data/auth-")); roots.push(directory);
  const env = { DB_CONNECTION: "sqlite", DB_DATABASE: join(directory, "auth.sqlite"), APP_PUBLIC_ORIGIN: "http://localhost", ...extra };
  // CLI migrations run against the generated models, with all migration files
  // and database state isolated per test (including from an existing app DB).
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "database/migrations/sqlite"), { recursive: true });
  await symlink(join(appRoot, "src/models"), join(directory, "src/models"));
  const command = (...args: string[]) => createCli({ root: directory, env, output: () => {} }).parseAsync(args, { from: "user" });
  await command("--force", "make:migration", "create_auth");
  await command("--force", "migrate");
  const router = createRouter(createRoutes(env, limiter));
  const call = (path: string, body?: unknown, cookie = "", origin: string | null = "http://localhost", more = {}) => router(new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie, ...(origin === null ? {} : { origin }), ...more },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { call, env, dispatch: router };
}
const credentials = { email: "  Alice@Example.COM  ", password: "a long password!" };
const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0]!;

test("register/login/me/notes/logout use hashed credentials and revocable rotating sessions", async () => {
  const { call, env } = await fixture();
  expect((await call("/api/notes")).status).toBe(401);
  const registered = await call("/api/auth/register", credentials);
  expect(registered.status).toBe(201);
  expect(await registered.json()).toEqual({ id: 1, email: "alice@example.com" });
  const cookie = cookieOf(registered);
  expect(cookie).toMatch(/^bundle_session=[A-Za-z0-9_-]{43}$/);
  for (const flag of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(registered.headers.get("set-cookie")).toContain(flag);
  expect(registered.headers.get("set-cookie")).not.toContain("Domain");
  expect(registered.headers.get("cache-control")).toBe("no-store");
  await withDatabase(async orm => {
    const em = orm.em.fork(); const user = await em.findOneOrFail(User, 1); const session = await em.findOneOrFail(Session, { id: 1 });
    expect(user.passwordHash).toStartWith("$argon2id$");
    expect(await Bun.password.verify(credentials.password, user.passwordHash)).toBe(true);
    expect(JSON.stringify(user)).not.toContain(credentials.password);
    expect(session.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.tokenHash).not.toBe(cookie.split("=")[1]);
    expect(JSON.stringify(session)).not.toContain(cookie.split("=")[1]!);
  }, { root: appRoot, env });
  expect((await call("/api/auth/register", credentials)).status).toBe(400);
  expect((await call("/api/auth/login", { ...credentials, password: "wrong password!" })).status).toBe(401);
  const login = await call("/api/auth/login", credentials, cookie);
  expect(login.status).toBe(200); const next = cookieOf(login); expect(next).not.toBe(cookie);
  expect((await call("/api/auth/me", undefined, cookie)).status).toBe(401);
  expect(await (await call("/api/auth/me", undefined, next)).json()).toEqual({ id: 1, email: "alice@example.com" });
  expect((await call("/api/notes", { body: "spoof", owner: 2 }, next)).status).toBe(400);
  const created = await call("/api/notes", { body: "  private  " }, next);
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: 1, body: "private" });
  const bob = cookieOf(await call("/api/auth/register", { ...credentials, email: "bob@example.com" }, next));
  // Register also revokes the presented session, even when switching accounts.
  expect((await call("/api/auth/me", undefined, next)).status).toBe(401);
  expect(await (await call("/api/notes", undefined, bob)).json()).toEqual([]);
  const alice = cookieOf(await call("/api/auth/login", credentials));
  expect(await (await call("/api/notes", undefined, alice)).json()).toEqual([{ id: 1, body: "private" }]);
  const logout = await call("/api/auth/logout", {}, alice);
  expect(logout.status).toBe(204); expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await call("/api/auth/me", undefined, alice)).status).toBe(401);
  await withDatabase(async orm => {
    const em = orm.em.fork(); await em.nativeUpdate(Session, {}, { expiresAt: new Date(0) });
  }, { root: appRoot, env });
  expect((await call("/api/auth/me", undefined, bob)).status).toBe(401);
  expect((await call("/api/notes", { body: "no" }, bob)).status).toBe(401);
  expect((await call("/api/auth/me", undefined, "bundle_session=malformed")).status).toBe(401);
  expect((await call("/api/auth/me", undefined, `${bob}; ${bob}`)).status).toBe(401);
});

test("all mutations require exact configured Origin and ignore spoofed Host/forwarded headers", async () => {
  const { call } = await fixture();
  for (const path of ["/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/auth/password", "/api/notes"]) {
    for (const origin of [null, "null", "https://evil.example", "http://localhost.evil", "http://localhost/"]) {
      expect((await call(path, credentials, "", origin, { host: "evil.example", "x-forwarded-host": "evil.example" })).status).toBe(403);
    }
  }
});

test("production rejects the default auth limiter before database initialization", () => {
  expect(() => createAuthHandlers({ NODE_ENV: "production", APP_PUBLIC_ORIGIN: "https://app.example", DB_CONNECTION: "invalid" }))
    .toThrow("Production auth requires an explicitly injected shared AuthAttemptLimiter. Implement and review a cross-process adapter, then pass it to createRoutes(env, limiter).");
});

test("production rejects explicit process scope and missing limiter before database or listener startup", () => {
  const listener = spyOn(Bun, "serve").mockImplementation(() => { throw new Error("must not listen"); });
  try {
    for (const production of [{ NODE_ENV: "production" }, { APP_ENV: "production" }]) {
      for (const limiter of [undefined, createProcessAuthAttemptLimiter()]) {
        // An invalid DB target must never mask the fixed limiter configuration error.
        const env = { ...production, APP_PUBLIC_ORIGIN: "https://app.example", DB_CONNECTION: "invalid" };
        for (const create of [createAuthHandlers, createRoutes]) {
          expect(() => create(env, limiter)).toThrow(productionLimiterError);
          expect(() => create({ ...env, APP_PUBLIC_ORIGIN: undefined }, limiter)).toThrow(productionLimiterError);
        }
      }
    }
    expect(listener).not.toHaveBeenCalled();
  } finally { listener.mockRestore(); }
});

test("explicit shared test adapter is awaited by register/login after Origin and before parsing or DB", async () => {
  let calls = 0;
  // Contract test double only; real SQL coordination is tested separately below.
  const limiter: AuthAttemptLimiter = { scope: "shared", async consume() { calls++; return { allowed: false, retryAfterSeconds: 7.2 }; } };
  const router = createRouter(createRoutes({ NODE_ENV: "production", APP_PUBLIC_ORIGIN: "https://app.example", DB_CONNECTION: "invalid" }, limiter));
  for (const path of ["register", "login"]) {
    for (const origin of [undefined, "https://evil.example", "https://app.example"]) {
      const response = await router(new Request(`https://app.example/api/auth/${path}`, {
        method: "POST", headers: origin ? { origin } : {}, body: "{broken",
      }));
      expect(response.status).toBe(origin === "https://app.example" ? 429 : 403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (response.status === 429) expect(response.headers.get("retry-after")).toBe("8");
    }
  }
  expect(calls).toBe(2);
  for (const consume of [async () => { throw new Error("private provider secret"); }, () => ({ allowed: false as const, retryAfterSeconds: NaN })]) {
    const failed = createRouter(createRoutes({ NODE_ENV: "production", APP_PUBLIC_ORIGIN: "https://app.example", DB_CONNECTION: "invalid" }, { scope: "shared", consume }));
    const response = await failed(new Request("https://app.example/api/auth/login", { method: "POST", headers: { origin: "https://app.example" } }));
    expect(response.status).toBe(500); expect(await response.text()).toBe("Internal Server Error");
  }
});

test("shared injection retains origin/config safety and development defaults stay isolated", async () => {
  const shared: AuthAttemptLimiter = { scope: "shared", consume: () => ({ allowed: true }) };
  for (const create of [createAuthHandlers, createRoutes]) {
    for (const production of [{ NODE_ENV: "production" }, { APP_ENV: "production" }]) {
      expect(() => create(production, shared)).toThrow("APP_PUBLIC_ORIGIN is required in production.");
      expect(() => create({ ...production, APP_PUBLIC_ORIGIN: "http://app.example" }, shared)).toThrow("APP_PUBLIC_ORIGIN must be an exact origin");
    }
    expect(() => create({ APP_PUBLIC_ORIGIN: "https://app.example/path" }, shared)).toThrow();
  }
  const local = createProcessAuthAttemptLimiter();
  expect(local.scope).toBe("process"); expect(Object.isFrozen(local)).toBe(true);
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    for (let i = 0; i < 20; i++) expect(await local.consume()).toEqual({ allowed: true });
    expect(await local.consume()).toEqual({ allowed: false, retryAfterSeconds: 60 });
    clock.mockReturnValue(61_000);
    expect(await local.consume()).toEqual({ allowed: true });
  } finally { clock.mockRestore(); }
  for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test", VITE_PORT: "5199" }]) {
    const auth = createAuthHandlers({ ...env, DB_CONNECTION: "invalid" });
    const origin = `http://127.0.0.1:${env.VITE_PORT ?? "5173"}`;
    expect((await auth.login(new Request("https://untrusted.example/api/auth/login", { method: "POST", headers: { origin: "https://untrusted.example" } }))).status).toBe(403);
    const router = createRouter([{ path: "/", methods: ["POST"], handler: auth.login }]);
    for (let i = 0; i < 21; i++) {
      const response = await router(new Request("http://untrusted.example/", { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" }));
      expect(response.status).toBe(i < 20 ? 400 : 429);
    }
    // A new handler set gets its own development bucket, as before.
    const fresh = createRouter([{ path: "/", methods: ["POST"], handler: createAuthHandlers(env).login }]);
    expect((await fresh(new Request("http://localhost/", { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" }))).status).toBe(400);
  }
});

test("production cookies are Secure and production requires a fixed HTTPS origin", async () => {
  const { call } = await fixture({ NODE_ENV: "production", APP_PUBLIC_ORIGIN: "https://app.example" }, { scope: "shared", consume: () => ({ allowed: true }) });
  const r = await call("/api/auth/register", credentials, "", "https://app.example");
  expect(r.status).toBe(201); expect(r.headers.get("set-cookie")).toContain("; Secure");
  const changed = await call("/api/auth/password", { currentPassword: credentials.password, newPassword: "a new secure password" }, cookieOf(r), "https://app.example");
  expect(changed.status).toBe(204); expect(changed.headers.get("set-cookie")).toContain("; Secure");
  const logout = await call("/api/auth/logout", {}, cookieOf(changed), "https://app.example");
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0; Secure");
  for (const env of [{ NODE_ENV: "production" }, { APP_ENV: "production" }, { NODE_ENV: "production", APP_PUBLIC_ORIGIN: "http://app.example" }, { APP_PUBLIC_ORIGIN: "https://app.example/path" }]) {
    expect(() => createAuthHandlers(env, { scope: "shared", consume: () => ({ allowed: true }) })).toThrow();
  }
});

test("credentials have exact schema, ASCII email policy and bounded unmodified passwords", async () => {
  const { call } = await fixture();
  for (const body of [null, [], {}, { ...credentials, extra: 1 }, { ...credentials, password: "short" }, { ...credentials, password: "é".repeat(513) },
    ...["a@b", "a b@example.com", "é@example.com", "K@example.com", "a..b@example.com", "a@example..com", "a".repeat(255) + "@example.com"].map(email => ({ ...credentials, email }))]) {
    const response = await call("/api/auth/register", body);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid credentials.");
  }
  const r = await call("/api/auth/register", { ...credentials, password: "  password with spaces  " });
  expect(r.status).toBe(201);
  expect((await call("/api/auth/login", { ...credentials, password: "password with spaces" })).status).toBe(401);
});

test("bounded process-local auth limiter rejects excess attempts without trusting forwarded IP", async () => {
  const { call } = await fixture();
  for (let i = 0; i < 20; i++) expect((await call("/api/auth/login", {}, "", "http://localhost", { "x-forwarded-for": String(i) })).status).toBe(400);
  const r = await call("/api/auth/login", {}); expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBeTruthy();
});

test("auth bounds JSON, sanitizes database failures, and never trusts a request-derived development origin", async () => {
  const { call, env } = await fixture();
  const auth = createAuthHandlers(env);
  const router = createRouter([{ path: "/api/auth/register", methods: ["POST"], handler: auth.register }]);
  for (const [body, type, status] of [["{broken", "application/json", 400], ["{}", "text/plain", 415], ["x".repeat(4097), "application/json", 413]] as const) {
    const r = await router(new Request("http://localhost/api/auth/register", { method: "POST", headers: { origin: "http://localhost", "content-type": type }, body }));
    expect(r.status).toBe(status); expect(r.headers.get("cache-control")).toBe("no-store");
  }
  await withDatabase(orm => orm.schema.drop(), { root: appRoot, env });
  const failed = await call("/api/auth/login", credentials);
  expect(failed.status).toBe(500); expect(await failed.text()).toBe("Internal Server Error");
  const local = createAuthHandlers({ ...env, APP_PUBLIC_ORIGIN: undefined, VITE_PORT: "5199" });
  const spoofed = await local.register(new Request("https://evil.example/api/auth/register", { method: "POST", headers: { origin: "https://evil.example", host: "evil.example", "x-forwarded-host": "evil.example" } }));
  expect(spoofed.status).toBe(403);
  const allowed = await local.logout(new Request("http://untrusted.example/api/auth/logout", { method: "POST", headers: { origin: "http://127.0.0.1:5199" } }));
  expect(allowed.status).toBe(204);
});

const replacement = "  a new password!  ";
const change = { currentPassword: credentials.password, newPassword: replacement };
async function snapshot(env: Awaited<ReturnType<typeof fixture>>["env"]) {
  return withDatabase(async orm => ({
    users: await orm.em.fork().getConnection().execute("select * from users order by id"),
    sessions: await orm.em.fork().getConnection().execute("select * from sessions order by id"),
  }), { root: appRoot, env });
}

test("password change rotates current session, revokes every device and replaces Argon2id credential", async () => {
  const { call, env } = await fixture();
  const first = cookieOf(await call("/api/auth/register", credentials));
  const second = cookieOf(await call("/api/auth/login", credentials));
  const bob = cookieOf(await call("/api/auth/register", { ...credentials, email: "bob@example.com" }));
  const r = await call("/api/auth/password", change, first);
  expect(r.status).toBe(204); expect(await r.text()).toBe("");
  expect(r.headers.get("cache-control")).toBe("no-store");
  for (const flag of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(r.headers.get("set-cookie")).toContain(flag);
  const rotated = cookieOf(r); expect(rotated).not.toBe(first); expect(rotated).not.toBe(second);
  for (const cookie of [first, second]) expect((await call("/api/auth/me", undefined, cookie)).status).toBe(401);
  for (const cookie of [rotated, bob]) expect((await call("/api/auth/me", undefined, cookie)).status).toBe(200);
  await withDatabase(async orm => {
    const em = orm.em.fork(); const user = await em.findOneOrFail(User, 1);
    expect(user.passwordHash).toStartWith("$argon2id$");
    expect(await Bun.password.verify(replacement, user.passwordHash)).toBe(true);
    const sessions = await em.find(Session, { user: 1 }); expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sessions[0]!.tokenHash).not.toBe(rotated.split("=")[1]);
  }, { root: appRoot, env });
  expect((await call("/api/auth/login", credentials)).status).toBe(401);
  expect((await call("/api/auth/login", { ...credentials, password: replacement })).status).toBe(200);
});

test("wrong current password leaves credential and all sessions unchanged", async () => {
  const { call, env } = await fixture();
  const cookies = [cookieOf(await call("/api/auth/register", credentials)), cookieOf(await call("/api/auth/login", credentials))];
  const before = await snapshot(env);
  const r = await call("/api/auth/password", { ...change, currentPassword: "wrong password!" }, cookies[0]);
  expect(r.status).toBe(401); expect(await r.text()).toBe("Invalid credentials.");
  expect(r.headers.get("set-cookie")).toBeNull(); expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await snapshot(env)).toEqual(before);
  for (const cookie of cookies) expect((await call("/api/auth/me", undefined, cookie)).status).toBe(200);
});

test("password requires a live session and exact schema with character and UTF-8 bounds", async () => {
  const { call, env } = await fixture();
  const cookie = cookieOf(await call("/api/auth/register", credentials)); const before = await snapshot(env);
  for (const token of ["", "bundle_session=bad", `${cookie}; ${cookie}`]) expect((await call("/api/auth/password", change, token)).status).toBe(401);
  for (const body of [null, [], {}, { ...change, extra: true }, { newPassword: replacement }, { currentPassword: credentials.password },
    ...["currentPassword", "newPassword"].flatMap(key => [null, 123, "short", "é".repeat(513)].map(value => ({ ...change, [key]: value })))]) {
    const r = await call("/api/auth/password", body, cookie); expect(r.status).toBe(400); expect(await r.text()).toBe("Invalid credentials."); expect(r.headers.get("set-cookie")).toBeNull();
  }
  expect(await snapshot(env)).toEqual(before);
  const r = await call("/api/auth/password", { ...change, newPassword: "é".repeat(512) }, cookie); expect(r.status).toBe(204);
  expect((await call("/api/auth/login", { ...credentials, password: "é".repeat(512) })).status).toBe(200);
});

test("password bounds raw JSON bytes and sanitizes database errors with atomic rollback", async () => {
  const { call, env } = await fixture(); const cookie = cookieOf(await call("/api/auth/register", credentials));
  const auth = createAuthHandlers(env); const router = createRouter([{ path: "/api/auth/password", methods: ["POST"], handler: auth.password }]);
  for (const [body, type, status] of [["{broken", "application/json", 400], ["{}", "text/plain", 415], ["é".repeat(2049), "application/json", 413]] as const) {
    const r = await router(new Request("http://localhost/api/auth/password", { method: "POST", headers: { origin: "http://localhost", cookie, "content-type": type }, body }));
    expect(r.status).toBe(status); expect(r.headers.get("cache-control")).toBe("no-store");
  }
  const before = await snapshot(env);
  await withDatabase(orm => orm.em.getConnection().execute("create trigger fail_rotation before insert on sessions begin select raise(abort, 'SECRET_DATABASE_FAILURE'); end"), { root: appRoot, env });
  const r = await call("/api/auth/password", change, cookie);
  expect(r.status).toBe(500); expect(await r.text()).toBe("Internal Server Error"); expect(r.headers.get("set-cookie")).toBeNull();
  expect(await snapshot(env)).toEqual(before); expect((await call("/api/auth/me", undefined, cookie)).status).toBe(200);
});

test("password change cannot overwrite a credential changed after verification", async () => {
  const { call, env } = await fixture(); const cookie = cookieOf(await call("/api/auth/register", credentials));
  const hash = Bun.password.hash; const newer = await hash("a newer password!", { algorithm: "argon2id" });
  Bun.password.hash = (async (...args: Parameters<typeof hash>) => {
    const result = await hash(...args);
    await withDatabase(orm => orm.em.nativeUpdate(User, { id: 1 }, { passwordHash: newer }), { root: appRoot, env });
    return result;
  }) as typeof hash;
  try {
    const r = await call("/api/auth/password", change, cookie);
    expect(r.status).toBe(401); expect(await r.text()).toBe("Invalid credentials."); expect(r.headers.get("set-cookie")).toBeNull();
    await withDatabase(async orm => { expect((await orm.em.fork().findOneOrFail(User, 1)).passwordHash).toBe(newer); expect(await orm.em.fork().count(Session, { user: 1 })).toBe(1); }, { root: appRoot, env });
  } finally { Bun.password.hash = hash; }
});


test("password rechecks session revocation after hashing and accepts the minimum length unchanged", async () => {
  const { call, env } = await fixture(); const cookie = cookieOf(await call("/api/auth/register", credentials));
  const before = (await snapshot(env)).users;
  const hash = Bun.password.hash;
  Bun.password.hash = (async (...args: Parameters<typeof hash>) => {
    const result = await hash(...args);
    await withDatabase(orm => orm.em.fork().nativeDelete(Session, {}), { root: appRoot, env });
    return result;
  }) as typeof hash;
  try {
    const r = await call("/api/auth/password", change, cookie);
    expect(r.status).toBe(401); expect(r.headers.get("set-cookie")).toBeNull();
    expect((await snapshot(env)).users).toEqual(before); expect((await snapshot(env)).sessions).toEqual([]);
  } finally { Bun.password.hash = hash; }
  const login = cookieOf(await call("/api/auth/login", credentials));
  expect((await call("/api/auth/password", { ...change, newPassword: " 1234567890 " }, login)).status).toBe(204);
  expect((await call("/api/auth/login", { ...credentials, password: " 1234567890 " })).status).toBe(200);
});


test("Notes middleware shares only a user ID, never session credentials, and denies before next", async () => {
  const { call, env } = await fixture();
  const cookie = cookieOf(await call("/api/auth/register", credentials));
  const writes: unknown[][] = [];
  const context = new RouteContext();
  const original = context.set.bind(context);
  context.set = (key, value) => { writes.push([key, value]); original(key, value); };
  let calls = 0;
  const middleware = createRequireAuth(env);
  const next = async () => { calls++; expect(context.get(authenticatedUserId)).toBe(1); return new Response("ok"); };
  const allowed = await middleware(new Request("http://localhost/api/notes", { headers: { cookie } }), next, context);
  expect(allowed.status).toBe(200);
  expect(writes).toEqual([[authenticatedUserId, 1]]);
  expect(calls).toBe(1);
  for (const presented of ["", "bundle_session=bad", `${cookie}; ${cookie}`]) {
    const denied = await middleware(new Request("http://localhost/api/notes", { headers: { cookie: presented } }), next, new RouteContext());
    expect(denied.status).toBe(401);
  }
  await withDatabase(orm => orm.em.fork().nativeUpdate(Session, {}, { expiresAt: new Date(0) }), { root: appRoot, env });
  const expired = await middleware(new Request("http://localhost/api/notes", { headers: { cookie } }), next, new RouteContext());
  expect(expired.status).toBe(401);
  expect(calls).toBe(1);
  expect(writes).toEqual([[authenticatedUserId, 1]]);
});


test("session list is minimal, active, bounded, newest-first and revocation is scoped", async () => {
  const { call, env, dispatch } = await fixture();
  const first = cookieOf(await call("/api/auth/register", credentials));
  const second = cookieOf(await call("/api/auth/login", credentials));
  const foreign = cookieOf(await call("/api/auth/register", { ...credentials, email: "bob@example.com" }));
  const remove = (id: string, cookie = first, origin: string | null = "http://localhost") => dispatch(new Request(`http://localhost/api/auth/sessions/${id}`, {
    method: "DELETE", headers: { cookie, ...(origin === null ? {} : { origin }) },
  }));
  expect((await call("/api/auth/sessions")).status).toBe(401);
  const listed = await call("/api/auth/sessions", undefined, first);
  expect(listed.status).toBe(200); expect(listed.headers.get("cache-control")).toBe("no-store");
  const rows = await listed.json() as { id: number; expiresAt: string; current: boolean }[];
  expect(rows).toHaveLength(2); expect(rows.map(row => row.id)).toEqual([2, 1]);
  expect(rows.map(row => row.current)).toEqual([false, true]);
  for (const row of rows) { expect(Object.keys(row).sort()).toEqual(["current", "expiresAt", "id"]); expect(new Date(row.expiresAt).toISOString()).toBe(row.expiresAt); }
  const body = JSON.stringify(rows);
  await withDatabase(async orm => { for (const row of await orm.em.fork().find(Session, {})) expect(body).not.toContain(row.tokenHash); }, { root: appRoot, env });
  expect(body).not.toContain(first.split("=")[1]!);
  const current = await remove("1"); expect(current.status).toBe(409); expect(await current.text()).toBe("Cannot revoke current session.");
  for (const id of ["0", "01", "-1", "1.0", "1e0", "9007199254740992", "%201", "%2B1"]) {
    const response = await remove(id); expect(response.status).toBe(400); expect(await response.text()).toBe("Invalid session ID.");
  }
  for (const id of ["3", "999999"]) { const response = await remove(id); expect(response.status).toBe(404); expect(await response.text()).toBe("Not Found"); expect(response.headers.get("cache-control")).toBe("no-store"); }
  expect((await call("/api/auth/me", undefined, foreign)).status).toBe(200);
  const revoked = await remove("2"); expect(revoked.status).toBe(204); expect(await revoked.text()).toBe(""); expect(revoked.headers.get("cache-control")).toBe("no-store");
  expect((await remove("2")).status).toBe(404);
  expect((await call("/api/auth/me", undefined, second)).status).toBe(401);
  expect((await call("/api/notes", undefined, second)).status).toBe(401);
  await withDatabase(async orm => {
    const em = orm.em.fork();
    em.persist(em.create(Session, { user: 1, tokenHash: "f".repeat(64), expiresAt: new Date(0) }));
    for (let i = 0; i < 55; i++) em.persist(em.create(Session, { user: 1, tokenHash: String(i).padStart(64, "0"), expiresAt: new Date(Date.now() + 60_000) }));
    await em.flush();
  }, { root: appRoot, env });
  const capped = await (await call("/api/auth/sessions", undefined, first)).json() as typeof rows;
  expect(capped).toHaveLength(50); expect(capped.every((row, i) => row.id !== 4 && (!i || row.id < capped[i - 1]!.id))).toBe(true);
  const expired = await remove("4"); expect(expired.status).toBe(404); expect(await expired.text()).toBe("Not Found");
  expect((await remove("1", second)).status).toBe(401);
});

test("session revocation checks Origin before any database/session lookup and sanitizes failures", async () => {
  const { call, env, dispatch } = await fixture();
  const cookie = cookieOf(await call("/api/auth/register", credentials));
  await withDatabase(orm => orm.schema.drop(), { root: appRoot, env });
  for (const origin of [null, "null", "https://evil.example", "http://localhost/"]) {
    const response = await dispatch(new Request("http://localhost/api/auth/sessions/1", { method: "DELETE", headers: { cookie, ...(origin === null ? {} : { origin }) } }));
    expect(response.status).toBe(403); expect(await response.text()).toBe("Forbidden"); expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const [path, method] of [["/api/auth/sessions", "GET"], ["/api/auth/sessions/1", "DELETE"]]) {
    const response = await dispatch(new Request(`http://localhost${path}`, { method, headers: { cookie, origin: "http://localhost" } }));
    expect(response.status).toBe(500); expect(await response.text()).toBe("Internal Server Error"); expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const [path, method, allow] of [["/api/auth/sessions", "POST", "GET, HEAD"], ["/api/auth/sessions/1", "GET", "DELETE"]]) {
    const response = await dispatch(new Request(`http://localhost${path}`, { method })); expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe(allow);
  }
});

test("persistent SQL limiter coordinates independent factories against one migrated database", async () => {
  const { env } = await fixture();
  const { createDatabaseAuthAttemptLimiter } = await import("./auth-attempt-limiter.ts");
  const first = createDatabaseAuthAttemptLimiter(env);
  const second = createDatabaseAuthAttemptLimiter({ ...env });
  expect(first.scope).toBe("shared");
  for (let i = 0; i < 20; i++) {
    expect(await (i % 2 ? first : second).consume()).toEqual({ allowed: true });
  }
  for (const limiter of [first, second, createDatabaseAuthAttemptLimiter({ ...env })]) {
    const decision = await limiter.consume();
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(61);
    }
  }
  const router = createRouter(createRoutes(env, second));
  const response = await router(new Request("http://localhost/api/auth/login", {
    method: "POST", headers: { origin: "http://localhost" }, body: "invalid credentials",
  }));
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(61);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await withDatabase(async orm => {
    const rows = await orm.em.getConnection().execute("select * from auth_attempt_bucket");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].slot_0).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(["id", ...Array.from({ length: 20 }, (_, i) => `slot_${i}`)].sort());
  }, { root: appRoot, env });
});
