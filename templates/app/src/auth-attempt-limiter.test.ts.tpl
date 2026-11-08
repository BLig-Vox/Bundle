import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "bundle/src/cli/program.ts";
import { withDatabase } from "bundle/src/database/connection.ts";
import type { Environment } from "bundle/src/database/config.ts";
import { createDatabaseAuthAttemptLimiter, authAttemptSql } from "./auth-attempt-limiter.ts";
import { appRoot } from "./auth.ts";
import { createRouter } from "./web/router.ts";
import { createRoutes } from "./web/routes.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(extra: Environment = {}, migrate = true) {
  await mkdir(join(appRoot, ".data"), { recursive: true });
  const root = await mkdtemp(join(appRoot, ".data/sql-limiter-")); roots.push(root);
  const env = { DB_CONNECTION: "sqlite", DB_DATABASE: join(root, "isolated.sqlite"), DATABASE_URL: undefined, ...extra };
  await mkdir(join(root, "src"));
  await mkdir(join(root, "database/migrations", env.DB_CONNECTION), { recursive: true });
  await symlink(join(appRoot, "src/models"), join(root, "src/models"));
  if (migrate) {
    const cli = (...args: string[]) => createCli({ root, env, output: () => {} }).parseAsync(args, { from: "user" });
    await cli("--force", "make:migration", "create_limiter");
    await cli("--force", "migrate");
  }
  const sql = (query: string) => withDatabase(orm => orm.em.getConnection().execute(query), { env, root: appRoot });
  return { env, sql, root };
}
const allowed = (decisions: { allowed: boolean }[]) => decisions.filter(d => d.allowed).length;

for (const driver of ["postgresql", "mariadb"] as const) {
  test(`${driver} generates portable auth bucket checks offline with the real ORM`, async () => {
    await withDatabase(async orm => {
      const ddl = await orm.schema.getCreateSchemaSQL({ wrap: false });
      // Server platforms can emit CHECKs as separate ALTER TABLE statements.
      const bucket = ddl.split(";").filter(statement => /(?:create|alter) table [^;]*auth_attempt_bucket/i.test(statement)).join(";");
      expect(bucket).toMatch(/create table/i);
      const normalized = bucket.replace(/["`]/g, "").toLowerCase();
      expect(normalized).not.toContain("typeof(");
      expect(normalized).toContain("constraint auth_bucket_singleton check (id = 1)");
      for (let i = 0; i < 20; i++) {
        expect(normalized).toContain(`constraint auth_bucket_slot_${i} check (slot_${i} >= 0 and slot_${i} <= 9007199254740991)`);
        expect(normalized).toContain(`slot_${i} int`);
        if (i < 19) expect(normalized).toContain(`slot_${i} <= slot_${i + 1}`);
      }
      expect(normalized).toContain("constraint auth_bucket_order check (");
    }, {
      env: { DB_CONNECTION: driver, DB_DATABASE: "bundle_offline_schema", DATABASE_URL: undefined },
      root: appRoot, connect: false,
    });
  });
}

test("SQLite strict rolling window admits at most 20 across a real 60-second boundary", async () => {
  const { env, sql } = await fixture();
  const clock = async () => Number((await sql("select (julianday('now') - 2440587.5) * 86400 as seconds"))[0].seconds);
  const waitUntil = async (target: number) => {
    while (await clock() < target) await new Promise(resolve => setTimeout(resolve, 25));
  };
  const firstBefore = await clock();
  expect((await createDatabaseAuthAttemptLimiter(env).consume()).allowed).toBe(true);
  const firstAfter = await clock();
  await waitUntil(firstAfter + 1.5);
  const laterBefore = await clock();
  for (let i = 0; i < 19; i++) expect((await createDatabaseAuthAttemptLimiter(env).consume()).allowed).toBe(true);
  expect((await createDatabaseAuthAttemptLimiter(env).consume()).allowed).toBe(false);
  // Only the first admission has expired. A fixed window incorrectly admits 20.
  await waitUntil(firstAfter + 60.1);
  expect(await clock()).toBeLessThan(laterBefore + 60);
  const decisions = [];
  for (let i = 0; i < 20; i++) decisions.push(await createDatabaseAuthAttemptLimiter(env).consume());
  expect(allowed(decisions)).toBe(1);
  // The 19 later admissions and new admissions share a single 60-second interval.
  expect(19 + allowed(decisions)).toBeLessThanOrEqual(20);
  expect(firstAfter).toBeGreaterThanOrEqual(firstBefore);
}, 90000);

test("SQLite concurrent independent factories have exactly 20 admissions and one bounded row; expired slots are reused", async () => {
  const { env, sql } = await fixture();
  const decisions = await Promise.all(Array.from({ length: 32 }, () => createDatabaseAuthAttemptLimiter({ ...env }).consume()));
  expect(allowed(decisions)).toBe(20);
  for (const d of decisions) if (!d.allowed) {
    expect(d.retryAfterSeconds).toBeGreaterThan(0); expect(d.retryAfterSeconds).toBeLessThanOrEqual(61);
  }
  const [before] = await sql("select * from auth_attempt_bucket");
  for (let i = 0; i < 25; i++) expect((await createDatabaseAuthAttemptLimiter(env).consume()).allowed).toBe(false);
  expect(await sql("select * from auth_attempt_bucket")).toEqual([before]);
  await sql(`update auth_attempt_bucket set ${Array.from({ length: 20 }, (_, i) => `slot_${i} = 0`).join(", ")}`);
  expect(await createDatabaseAuthAttemptLimiter(env).consume()).toEqual({ allowed: true });
  expect((await sql("select * from auth_attempt_bucket"))[0].slot_18).toBe(0);
  await expect(sql(`insert into auth_attempt_bucket select 2, ${Array(20).fill("0").join(", ")}`)).rejects.toThrow();
  for (const value of ["-1", "'bad'", "9007199254740992", "null"]) {
    await expect(sql(`update auth_attempt_bucket set slot_19 = ${value}`)).rejects.toThrow();
  }
  await expect(sql("update auth_attempt_bucket set slot_0 = slot_19 + 1")).rejects.toThrow();
  // Bound storage stays at one row and twenty slots after repeated expiry/reuse.
  expect(Object.keys((await sql("select * from auth_attempt_bucket"))[0])).toHaveLength(21);
}, 20000);

async function worker(env: Environment, count: number) {
  const source = `import { createDatabaseAuthAttemptLimiter } from ${JSON.stringify(new URL("./auth-attempt-limiter.ts", import.meta.url).href)};
const limiter = createDatabaseAuthAttemptLimiter(${JSON.stringify(env)});
const results = []; for (let i = 0; i < ${count}; i++) results.push(await limiter.consume());
console.log(JSON.stringify(results));`;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Limiter child failed (${code}): ${err}`);
    return JSON.parse(out) as { allowed: boolean; retryAfterSeconds?: number }[];
  } finally { clearTimeout(timer); }
}

test("SQLite independent processes coordinate a cold bucket and retain the active window after every process exits", async () => {
  const { env, sql } = await fixture();
  const batches = await Promise.all(Array.from({ length: 4 }, () => worker(env, 8)));
  expect(allowed(batches.flat())).toBe(20);
  const [before] = await sql("select * from auth_attempt_bucket");
  const [restarted] = await worker(env, 1);
  expect(restarted!.allowed).toBe(false);
  expect(restarted!.retryAfterSeconds).toBeGreaterThan(0);
  expect(restarted!.retryAfterSeconds).toBeLessThanOrEqual(61);
  expect(await sql("select * from auth_attempt_bucket")).toEqual([before]);
}, 20000);

test("missing migration and unavailable DB fail closed through real auth routes", async () => {
  const { env, sql } = await fixture({}, false);
  const limiter = createDatabaseAuthAttemptLimiter(env);
  await expect(limiter.consume()).rejects.toThrow();
  const router = createRouter(createRoutes({ ...env, APP_PUBLIC_ORIGIN: "https://app.example", NODE_ENV: "production" }, limiter));
  const response = await router(new Request("https://app.example/api/auth/register", { method: "POST", headers: { origin: "https://app.example" }, body: "{}" }));
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("Internal Server Error");
  await expect(createDatabaseAuthAttemptLimiter({ ...env, DB_DATABASE: "/dev/null/unavailable.sqlite" }).consume()).rejects.toThrow();
  expect((await sql("select name from sqlite_master where name = 'users'"))).toEqual([]);
});

test("SQLite write failure rolls back admission and fails closed without altering the active bucket", async () => {
  const { env, sql } = await fixture();
  const limiter = createDatabaseAuthAttemptLimiter(env);
  expect(await limiter.consume()).toEqual({ allowed: true });
  const before = await sql("select * from auth_attempt_bucket");
  await sql("create trigger reject_limiter_update before update on auth_attempt_bucket begin select raise(abort, 'unavailable'); end");
  await expect(limiter.consume()).rejects.toThrow();
  expect(await sql("select * from auth_attempt_bucket")).toEqual(before);
  await sql("drop trigger reject_limiter_update");
  expect(await createDatabaseAuthAttemptLimiter(env).consume()).toEqual({ allowed: true });
  expect((await sql("select * from auth_attempt_bucket"))[0].slot_18).toBeGreaterThan(0);
});

test("SQLite-only SQL plan and unsupported-driver refusal before connection", () => {
  const plan = authAttemptSql("sqlite");
  expect(plan.insert).toContain("on conflict (id) do nothing");
  expect(plan.lock).toContain("where id = 1");
  expect(plan.clock).toContain("julianday('now')");
  expect(plan.update.match(/\?/g)).toHaveLength(20);
  for (const driver of ["postgresql", "mariadb", "mysql"]) {
    expect(() => authAttemptSql(driver)).toThrow("Unsupported auth limiter database driver");
    expect(() => createDatabaseAuthAttemptLimiter({ DB_CONNECTION: driver })).toThrow();
  }
  expect(() => createDatabaseAuthAttemptLimiter({ DB_CONNECTION: "sqlite", DB_DATABASE: ":memory:" })).toThrow("persistent SQLite");
});

test("SQLite expires individual slots, retains the newest twenty, and ignores process time", async () => {
  const { env, sql } = await fixture();
  const limiter = createDatabaseAuthAttemptLimiter(env);
  await limiter.consume();
  await sql(`update auth_attempt_bucket set ${Array.from({ length: 20 }, (_, i) => `slot_${i} = cast(round((julianday('now') - 2440587.5) * 86400000) - ${i < 10 ? 61000 : 1000} as integer)`).join(", ")}`);
  const before = (await sql("select * from auth_attempt_bucket"))[0];
  const originalNow = Date.now;
  Date.now = () => 9_000_000_000_000;
  try {
    const decisions = [];
    for (let i = 0; i < 20; i++) decisions.push(await limiter.consume());
    expect(allowed(decisions)).toBe(10);
  } finally { Date.now = originalNow; }
  const after = (await sql("select * from auth_attempt_bucket"))[0];
  for (let i = 0; i < 10; i++) expect(after[`slot_${i}`]).toBe(before[`slot_${i + 10}`]);
  for (let i = 10; i < 20; i++) expect(after[`slot_${i}`]).toBeGreaterThan(before.slot_19);
  expect(Object.keys(after)).toHaveLength(21);
});

for (const [label, assignment, stored] of [
  ["negative", "slot_0 = -1", -1],
  ["fractional", "slot_19 = 0.5", 0.5],
  ["text", "slot_19 = 'bad'", "bad"],
] as const) {
  test(`SQLite ${label} persisted slot fails closed even if constraints were bypassed externally`, async () => {
    const { env, sql } = await fixture();
    await createDatabaseAuthAttemptLimiter(env).consume();
    await withDatabase(async orm => {
      const connection = orm.em.getConnection();
      await connection.execute("pragma ignore_check_constraints = on");
      await connection.execute(`update auth_attempt_bucket set ${assignment}`);
    }, { env, root: appRoot });
    const before = await sql("select * from auth_attempt_bucket");
    expect(before[0][label === "negative" ? "slot_0" : "slot_19"]).toBe(stored);
    await expect(createDatabaseAuthAttemptLimiter(env).consume()).rejects.toThrow("Invalid auth limiter database state");
    expect(await sql("select * from auth_attempt_bucket")).toEqual(before);
  });
}

test("SQLite backward clock state stays ordered and denies without extending history", async () => {
  const { env, sql } = await fixture();
  await createDatabaseAuthAttemptLimiter(env).consume();
  await sql(`update auth_attempt_bucket set ${Array.from({ length: 20 }, (_, i) => `slot_${i} = cast(round((julianday('now') - 2440587.5) * 86400000) + 120000 as integer)`).join(", ")}`);
  const before = await sql("select * from auth_attempt_bucket");
  const result = await createDatabaseAuthAttemptLimiter(env).consume();
  expect(result.allowed).toBe(false);
  expect(await sql("select * from auth_attempt_bucket")).toEqual(before);
});

test("production uses the real SQL factory across register/login, retaining the Origin gate", async () => {
  const { env, sql } = await fixture();
  const configured = { ...env, APP_PUBLIC_ORIGIN: "https://app.example" };
  const routers = [
    createRouter(createRoutes({ ...configured, NODE_ENV: "production" }, createDatabaseAuthAttemptLimiter(configured))),
    createRouter(createRoutes({ ...configured, APP_ENV: "production" }, createDatabaseAuthAttemptLimiter(configured))),
  ];
  const call = (i: number, origin = "https://app.example") => routers[i % 2]!(new Request(`https://app.example/api/auth/${i % 2 ? "login" : "register"}`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
  }));
  expect((await call(0, "https://evil.example")).status).toBe(403);
  expect(await sql("select * from auth_attempt_bucket")).toEqual([]);
  for (let i = 0; i < 20; i++) expect((await call(i)).status).toBe(400);
  for (let i = 0; i < 2; i++) expect((await call(i)).status).toBe(429);
  expect((await sql("select * from auth_attempt_bucket"))[0].slot_0).toBeGreaterThan(0);
});
