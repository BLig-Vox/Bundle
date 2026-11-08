import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCli } from "./program.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-app-test-")); roots.push(root);
  const output: string[] = [];
  const run = (name: string, extra: string[] = []) => createCli({ root, env: { DB_CONNECTION: "invalid" }, output: value => output.push(value) })
    .parseAsync(["make:app", ...extra, "--", name], { from: "user" });
  return { root, output, run };
}
async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => entry.isDirectory()
    ? (await files(join(root, entry.name))).map(path => `${entry.name}/${path}`) : [entry.name]))).flat().sort();
}
const expected = ["database/migrations/sqlite/.gitkeep", "database/migrations/postgresql/.gitkeep", "database/migrations/mariadb/.gitkeep", ".env.example", ".gitignore", "README.md", "components.json", "database/seeders/DatabaseSeeder.ts", "index.html", "package.json", "scripts/bundle.ts", "scripts/production.ts", "scripts/dev.ts", "scripts/work-once.ts", "src/App.tsx", "src/ResourcePage.tsx", "src/ResourceNavigation.tsx", "src/resource-pages.tsx", "src/app.test.ts", "src/health.test.ts", "src/production.test.ts", "src/jobs/registry.ts", "src/components/ui/button.tsx", "src/index.css", "src/lib/utils.ts", "src/main.tsx", "src/models/User.ts", "src/models/Session.ts", "src/models/BundleJob.ts", "src/queue.ts", "src/auth-attempt-limiter.test.ts", "src/auth-attempt-limiter.ts", "src/models/AuthAttemptBucket.ts", "src/auth.test.ts", "src/auth.ts", "src/routes/Auth.ts", "src/models/Note.ts", "src/notes.test.ts", "src/routes/Notes.ts", "src/routes/Health.ts", "src/web/router.ts", "src/web/routes.ts", "src/web/resources.ts", "tsconfig.app.json", "tsconfig.json", "tsconfig.node.json", "tsconfig.server.json", "vite.config.ts"].sort();

test("make:app produces a complete editable frontend and explicit app-root Bundle integration", async () => {
  const { root, run, output } = await fixture(); await run("MyApp");
  const app = join(root, "myapp");
  expect(JSON.parse(output[0]!)).toMatchObject({ created: "myapp" });
  expect(JSON.parse(output[0]!).next).toContain("bun run dev to start Vite and Bundle together");
  expect(await files(app)).toEqual(expected);
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  expect(pkg.name).toBe("myapp");
  expect(pkg.scripts.dev).toBe("bun run scripts/dev.ts");
  for (const key of ["dev", "start:production", "build", "preview", "typecheck", "test", "bundle", "server", "db:migrate", "work:once"]) expect(pkg.scripts[key]).toBeTruthy();
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    expect(version).toMatch(name === "bundle" ? /^file:\// : /^\d+\.\d+\.\d+$/);
  }
  expect(pkg.bin).toBeUndefined();
  const vite = await readFile(join(app, "vite.config.ts"), "utf8");
  expect(vite).toContain("@tailwindcss/vite"); expect(vite).toContain('"/api"'); expect(vite).toContain('process.env.BUNDLE_PORT ?? "3000"'); expect(vite).toContain('process.env.VITE_PORT ?? "5173"');
  const components = JSON.parse(await readFile(join(app, "components.json"), "utf8"));
  expect(components).toMatchObject({ tsx: true, rsc: false, tailwind: { config: "", css: "src/index.css", cssVariables: true }, aliases: { ui: "@/components/ui", utils: "@/lib/utils" } });
  // Packaging contract; rendered forms and real interactions are checked by verify-app.ts.
  expect(await readFile(join(app, "src/App.tsx"), "utf8")).toBe(await readFile(new URL("../../templates/app/src/App.tsx.tpl", import.meta.url), "utf8"));
  expect(await readFile(join(app, "scripts/bundle.ts"), "utf8")).toContain("createCli({ root");
  expect(await readFile(join(app, "src/index.css"), "utf8")).toContain('@import "tailwindcss"');
  const notes = await readFile(join(app, "src/routes/Notes.ts"), "utf8");
  expect(notes).toContain('bundle/src/validation/schema.ts');
  expect(notes).toContain('readValidatedJson(request, noteSchema');
  expect(notes).not.toContain('Object.keys(input)');
  expect(notes).not.toContain("sessionUser");
  expect(notes).not.toContain("findOne");
  expect(notes).toContain("em.getReference(User, ownerId)");
  const queueModel = await readFile(join(app, "src/models/BundleJob.ts"), "utf8");
  expect(queueModel).toContain('tableName: "bundle_jobs"');
  expect(queueModel).toContain('name: "bundle_jobs_lease_pair"');
  expect(queueModel).toContain('name: "bundle_jobs_failure_pair"');
  expect(queueModel).toContain("'unregistered_job', 'invalid_payload'");
  expect(await readFile(join(app, "src/queue.ts"), "utf8")).toContain("createSqliteQueue({ root: appRoot })");
  const registry = await readFile(join(app, "src/jobs/registry.ts"), "utf8");
  expect(registry).toContain("createJobRegistry({})");
  const worker = await readFile(join(app, "scripts/work-once.ts"), "utf8");
  expect(worker).toContain("dispatchOne(queue, jobs)");
  expect(worker).not.toContain("dynamic import");
  expect(pkg.scripts["work:once"]).toBe("bun run scripts/work-once.ts");
  expect(await readFile(join(app, "src/web/routes.ts"), "utf8")).toContain("middleware: [requireAuth]");
  expect(await readdir(root)).toEqual(["myapp"]);
});

test("generated apps expose a distinct production start command and fail-closed entrypoint", async () => {
  const { root, run } = await fixture(); await run("ProdApp");
  const app = join(root, "prodapp");
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  expect(pkg.scripts["start:production"]).toBe("bun run scripts/production.ts");
  const source = await readFile(join(app, "scripts/production.ts"), "utf8");
  expect(source).toContain('mode: "app"');
  expect(source).toContain("APP_PUBLIC_ORIGIN");
  expect(source).toContain('"127.0.0.1"');
  expect(source).toContain("auth_attempt_bucket");
});

test("unsafe app names never write or print success", async () => {
  const { root, run, output } = await fixture();
  for (const name of ["", ".", "..", "../Escape", "/Escape", "Foo/Bar", "Foo\\Bar", "two words", "Foo\n", "Föö", "-foo", "foo-", "foo--bar", "CON", "lpt1", "package.json", "a".repeat(65)]) await expect(run(name)).rejects.toThrow("app name");
  expect(await readdir(root)).toEqual([]); expect(output).toEqual([]);
});

test("refuses every existing destination, including empty directories, files and dangling symlinks, with --force", async () => {
  for (const kind of ["empty", "nonempty", "file", "link", "dangling"]) {
    const { root, run, output } = await fixture(); const dest = join(root, "demo");
    if (kind === "file") await writeFile(dest, "owned");
    else if (kind === "link" || kind === "dangling") { if (kind === "link") await mkdir(join(root, "outside")); await symlink(join(root, "outside"), dest); }
    else { await mkdir(dest); if (kind === "nonempty") await writeFile(join(dest, "owned"), "keep"); }
    const before = await lstat(dest); await expect(run("Demo", ["--force"])).rejects.toThrow("already exists");
    expect((await lstat(dest)).ino).toBe(before.ino); expect(output).toEqual([]);
    if (kind === "nonempty") expect(await readFile(join(dest, "owned"), "utf8")).toBe("keep");
    expect((await readdir(root)).filter(name => name.startsWith(".bundle"))).toEqual([]);
  }
});

test("concurrent app creation publishes exactly one complete app", async () => {
  const { root, run, output } = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => run("Demo")));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(output).toHaveLength(1); expect(await files(join(root, "demo"))).toEqual(expected);
  expect(await readdir(root)).toEqual(["demo"]);
});

test("symlinked root or ancestor is refused", async () => {
  const { root } = await fixture(); await mkdir(join(root, "real")); await symlink(join(root, "real"), join(root, "link"));
  for (const path of [join(root, "link"), join(root, "link/child")]) {
    await mkdir(join(root, "real/child"), { recursive: true });
    await expect(createCli({ root: path }).parseAsync(["make:app", "Demo"], { from: "user" })).rejects.toThrow("symlink");
  }
  expect(await readdir(join(root, "real/child"))).toEqual([]);
});

test("staging and publication failures leave no destination or temporary files", async () => {
  const { generateApp } = await import("./apps.ts");
  for (const phase of ["write", "publish"]) {
    const { root } = await fixture(); let writes = 0;
    await expect(generateApp(root, "Demo", {
      writeFile: async (...args: Parameters<typeof writeFile>) => { if (phase === "write" && ++writes === 4) throw new Error("injected write"); return writeFile(...args); },
      rename: async () => { throw new Error("injected publish"); },
    })).rejects.toThrow(`injected ${phase}`);
    expect(await readdir(root)).toEqual([]);
  }
});

test("destination appearing during staging is preserved", async () => {
  const { generateApp } = await import("./apps.ts"); const { root } = await fixture(); let created = false;
  await expect(generateApp(root, "Demo", { writeFile: async (...args: Parameters<typeof writeFile>) => {
    if (!created) { created = true; await mkdir(join(root, "demo")); await writeFile(join(root, "demo/owned"), "keep"); }
    return writeFile(...args);
  } })).rejects.toThrow("already exists");
  expect(await files(root)).toEqual(["demo/owned"]); expect(await readFile(join(root, "demo/owned"), "utf8")).toBe("keep");
});

test("generated auth and Notes flow uses CLI-migrated app SQLite, not framework fixtures", async () => {
  // Keep this backend-only fixture below the checkout so native module discovery
  // resolves the repository's installed ORM without claiming app installation.
  const root = await mkdtemp(join(import.meta.dir, "../../.data/app-backend-")); roots.push(root);
  await createCli({ root, output: () => {} }).parseAsync(["make:app", "DataApp"], { from: "user" });
  const app = join(root, "dataapp");
  await mkdir(join(app, "node_modules"));
  await symlink(join(import.meta.dir, "../.."), join(app, "node_modules/bundle"));
  const { createRouteHandler } = await import("../web/server.ts");
  const handler = await createRouteHandler(app);
  const response = await handler(new Request("http://localhost/api/health"));
  expect(await response.json()).toEqual({ status: "ok" });
  expect((await handler(new Request("http://localhost/"))).status).toBe(404);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  // The real, unchanged manifest must guard Notes before parsing or opening SQLite.
  for (const method of ["GET", "POST"]) {
    const denied = await handler(new Request("http://localhost/api/notes", {
      method, headers: { origin: "http://127.0.0.1:5173", "content-type": "application/json" },
      body: method === "POST" ? "{broken" : undefined,
    }));
    expect(denied.status).toBe(401);
  }
  for (const origin of [undefined, "http://evil.example", "http://127.0.0.1:5173/"]) {
    const denied = await handler(new Request("http://localhost/api/notes", {
      method: "POST", headers: { ...(origin ? { origin } : {}), cookie: "bundle_session=" + "a".repeat(43) }, body: "{broken",
    }));
    expect(denied.status).toBe(403);
  }
  const output: string[] = [];
  const command = (...args: string[]) => createCli({ root: app, env: { DB_CONNECTION: "sqlite" }, output: text => output.push(text) }).parseAsync(args, { from: "user" });
  await command("about"); expect(JSON.parse(output.at(-1)!).database.database).toBe(join(app, ".data/bundle.sqlite"));
  await command("make:migration", "create_notes"); await command("migrate"); await command("db:seed"); await command("db:table", "notes");
  expect(JSON.parse(output.at(-1)!).name).toBe("notes");
  const registered = await handler(new Request("http://localhost/api/auth/register", {
    method: "POST", headers: { origin: "http://127.0.0.1:5173", "content-type": "application/json" },
    body: JSON.stringify({ email: "cli@example.com", password: "long cli password" }),
  }));
  expect(registered.status).toBe(201);
  const oldCookie = registered.headers.get("set-cookie")!.split(";")[0]!;
  const login = await handler(new Request("http://localhost/api/auth/login", {
    method: "POST", headers: { origin: "http://127.0.0.1:5173", cookie: oldCookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "CLI@example.com", password: "long cli password" }),
  }));
  expect(login.status).toBe(200);
  let cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).not.toBe(oldCookie);
  expect((await handler(new Request("http://localhost/api/auth/me", { headers: { cookie: oldCookie } }))).status).toBe(401);
  expect(await (await handler(new Request("http://localhost/api/auth/me", { headers: { cookie } }))).json()).toEqual({ id: 1, email: "cli@example.com" });
  const changed = await handler(new Request("http://localhost/api/auth/password", {
    method: "POST", headers: { origin: "http://127.0.0.1:5173", cookie, "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "long cli password", newPassword: "new cli password!" }),
  }));
  expect(changed.status).toBe(204);
  const previous = cookie; cookie = changed.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).not.toBe(previous);
  expect((await handler(new Request("http://localhost/api/auth/me", { headers: { cookie: previous } }))).status).toBe(401);
  const created = await handler(new Request("http://localhost/api/notes", {
    method: "POST", body: '{"body":"  API note  "}', headers: { origin: "http://127.0.0.1:5173", cookie, "content-type": "application/json" },
  }));
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: 1, body: "API note" });
  expect(await (await handler(new Request("http://localhost/api/notes", { headers: { cookie } }))).json()).toEqual([
    { id: 1, body: "API note" },
  ]);
  const { withDatabase } = await import("../database/connection.ts");
  await withDatabase(async orm => {
    const notes = await orm.em.fork().getConnection().execute("select body, owner_id from notes");
    expect(notes).toEqual([{ body: "API note", owner_id: 1 }]);
  }, { root: app, env: { DB_CONNECTION: "sqlite" } });
  expect((await handler(new Request("http://localhost/api/auth/logout", {
    method: "POST", headers: { origin: "http://127.0.0.1:5173", cookie },
  }))).status).toBe(204);
  for (const path of ["/api/auth/me", "/api/notes"]) expect((await handler(new Request(`http://localhost${path}`, { headers: { cookie } }))).status).toBe(401);
});

test("generated notes API tests use direct requests and real isolated SQLite", async () => {
  const root = await mkdtemp(join(import.meta.dir, "../../.data/app-notes-")); roots.push(root);
  await createCli({ root, output: () => {} }).parseAsync(["make:app", "NotesApp"], { from: "user" });
  const app = join(root, "notesapp");
  // Backend fixture only: installed-app acceptance separately performs a real bun install.
  await mkdir(join(app, "node_modules"));
  await symlink(join(import.meta.dir, "../.."), join(app, "node_modules/bundle"));
  const child = Bun.spawn([process.execPath, "test", "./src"], { cwd: app, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, output: code === 0 ? "passed" : stdout + stderr }).toEqual({ code: 0, output: "passed" });
}, 120_000);

test("generated app typed middleware manifest executes through real direct route handlers", async () => {
  const { root, run } = await fixture(); await run("MiddlewareApp");
  const app = join(root, "middlewareapp");
  await mkdir(join(app, "node_modules"));
  await symlink(join(import.meta.dir, "../.."), join(app, "node_modules/bundle"));
  await writeFile(join(app, "src/web/routes.ts"), `
import type { Middleware, Route } from "./router.ts";
import { HttpError } from "bundle/src/web/http-error.ts";
export const events: string[] = [];
const wrap = (name: string): Middleware => async (request, next) => {
  events.push(name + ":" + request.method);
  const response = await next();
  events.push(name + ":after");
  return response;
};
const auth: Middleware = (request, next) => request.headers.has("authorization") ? next() : new Response("Unauthorized", { status: 401 });
const middleware: Middleware[] = [wrap("outer"), auth, wrap("inner")];
export const routes: readonly Route[] = [
  { path: "/api/protected", methods: ["GET", "POST"], middleware, handler: request => new Response(request.method) },
  { path: "/api/error", middleware: [async () => { throw new Error("private-secret"); }], handler: () => new Response("bad") },
  { path: "/api/safe", middleware: [() => { throw new HttpError(400, "Safe error"); }], handler: () => new Response("bad") },
  { path: "/api/twice", middleware: [async (_request, next) => { await next(); return next(); }], handler: () => { events.push("once"); return new Response("ok"); } },
];
export function mutate() { middleware.length = 0; }
`);
  const { createRouteHandler } = await import("../web/server.ts");
  const handler = await createRouteHandler(app);
  const manifest = await import(join(app, "src/web/routes.ts"));
  manifest.mutate();
  for (const method of ["GET", "HEAD", "POST"]) {
    manifest.events.length = 0;
    const blocked = await handler(new Request("http://localhost/api/protected", { method }));
    expect(blocked.status).toBe(401);
    expect(await blocked.text()).toBe(method === "HEAD" ? "" : "Unauthorized");
    expect(manifest.events).toEqual([`outer:${method}`, "outer:after"]);
    manifest.events.length = 0;
    const allowed = await handler(new Request("http://localhost/api/protected", { method, headers: { authorization: "test" } }));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe(method === "HEAD" ? "" : method);
    expect(manifest.events).toEqual([`outer:${method}`, `inner:${method}`, "inner:after", "outer:after"]);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(allowed.headers.get("x-frame-options")).toBe("DENY");
  }
  for (const [path, status, body] of [["error", 500, "Internal Server Error"], ["safe", 400, "Safe error"], ["twice", 500, "Internal Server Error"]] as const) {
    const response = await handler(new Request(`http://localhost/api/${path}`));
    expect(response.status).toBe(status); expect(await response.text()).toBe(body);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
  expect(manifest.events.filter((event: string) => event === "once")).toHaveLength(1);
  const unsupported = await handler(new Request("http://localhost/api/protected", { method: "DELETE" }));
  expect(unsupported.status).toBe(405); expect(unsupported.headers.get("allow")).toBe("GET, HEAD, POST");
  expect((await handler(new Request("http://localhost/api/protected/"))).status).toBe(404);
});

test("generated production startup fails closed before DB/listener and supports static shared injection", async () => {
  const root = await mkdtemp(join(import.meta.dir, "../../.data/app-limiter-")); roots.push(root);
  const message = "Production auth requires an explicitly injected shared AuthAttemptLimiter. Implement and review a cross-process adapter, then pass it to createRoutes(env, limiter).";
  for (const kind of ["absent", "local", "shared", "missing-origin", "stock"] as const) {
    await createCli({ root, output: () => {} }).parseAsync(["make:app", kind], { from: "user" });
    const app = join(root, kind);
    await mkdir(join(app, "node_modules"));
    await symlink(join(import.meta.dir, "../.."), join(app, "node_modules/bundle"));
    const manifest = join(app, "src/web/routes.ts");
    let source = await readFile(manifest, "utf8");
    const defaultRoutes = `const production = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
export const routes = production
  ? createRoutes(process.env, createDatabaseAuthAttemptLimiter())
  : createRoutes();`;
    if (kind === "absent") source = source.replace(defaultRoutes, `export const routes = createRoutes(process.env, undefined);`);
    else if (kind === "local") {
      source = `import { createProcessAuthAttemptLimiter } from "../routes/Auth.ts";
` + source.replace(defaultRoutes, `export const routes = createRoutes(process.env, createProcessAuthAttemptLimiter());`);
    } else if (kind === "shared" || kind === "missing-origin") {
      // Test double only, never generated as an application/provider adapter.
      await writeFile(join(app, "src/test-limiter.ts"), `import type { AuthAttemptLimiter } from "./routes/Auth.ts";
export const testLimiter: AuthAttemptLimiter = { scope: "shared", consume: async () => ({ allowed: false, retryAfterSeconds: 9 }) };
`);
      source = `import { testLimiter } from "../test-limiter.ts";
` + source.replace(defaultRoutes, `export const routes = createRoutes(process.env, testLimiter);`);
    }
    await writeFile(manifest, source);
    for (const productionVariable of ["NODE_ENV", "APP_ENV"]) {
      const child = Bun.spawn([process.execPath, "-e", `
import { startServer } from "bundle/src/web/server.ts";
import { MikroORM } from "@mikro-orm/core";
let database = 0, listeners = 0;
MikroORM.init = async () => { database++; throw new Error("database must not initialize"); };
Bun.serve = () => { listeners++; return {}; };
try {
  await startServer({ root: process.cwd(), port: 0 });
  console.log(JSON.stringify({ database, listeners, accepted: true }));
} catch (error) {
  console.log(JSON.stringify({ database, listeners, message: error.message }));
}
`], { cwd: app, env: { ...process.env, NODE_ENV: undefined, APP_ENV: undefined, [productionVariable]: "production", APP_PUBLIC_ORIGIN: kind === "missing-origin" ? undefined : "https://app.example", DB_CONNECTION: kind === "stock" ? "sqlite" : "invalid", DB_DATABASE: join(app, ".data/production.sqlite") }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual(kind === "shared" || kind === "stock"
        ? { database: 0, listeners: 1, accepted: true }
        : { database: 0, listeners: 0, message: kind === "missing-origin" ? "Unable to load routes manifest." : message });
    }
  }
}, 30_000);
