import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateApp } from "../src/cli/apps.ts";

// Real generated-app acceptance. Linked dependencies verify app behavior, not installation.
// BUN_INSTALL_CACHE_DIR may point at an existing Bun cache.
// BUNDLE_NPM_REGISTRY selects a cached registry; BUNDLE_INSTALL_OFFLINE=1 forbids network.
const root = await mkdtemp(join(tmpdir(), "bundle-app-acceptance-"));
try {
  const app = join(root, await generateApp(root, "Acceptance"));
  const env = { ...process.env, DB_CONNECTION: "sqlite", DB_DATABASE: join(app, ".data/bundle.sqlite"), APP_PUBLIC_ORIGIN: "http://localhost", DATABASE_URL: undefined };
  async function run(args: string[]) {
    console.log(`\n> bun ${args.join(" ")}`);
    const child = Bun.spawn([process.execPath, ...args], { cwd: app, env, stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => child.kill(), args.includes("test") ? 120_000 : 45_000);
    try {
      const code = await child.exited;
      if (code !== 0) throw new Error(`Generated app verification failed: bun ${args.join(" ")} (exit ${code}).`);
    } finally { clearTimeout(timer); }
  }
  if (process.env.BUNDLE_ACCEPTANCE_NODE_MODULES) {
    await symlink(resolve(process.env.BUNDLE_ACCEPTANCE_NODE_MODULES), join(app, "node_modules"));
    console.log("Using linked dependencies; this run does not verify fresh installation.");
  } else {
    await run(["install", process.env.BUNDLE_INSTALL_OFFLINE === "1" ? "--offline" : "--prefer-offline", "--cache-dir", process.env.BUN_INSTALL_CACHE_DIR ?? join(root, "cache"), ...(process.env.BUNDLE_NPM_REGISTRY ? ["--registry", process.env.BUNDLE_NPM_REGISTRY] : [])]);
  }
  await mkdir(join(app, "acceptance"));
  await writeFile(join(app, "acceptance/frontend.test.ts"), await readFile(new URL("../templates/acceptance/frontend.test.ts.tpl", import.meta.url), "utf8"));
  // Build the output before checking rendered UI, so missing affordances are a behavioral RED.
  await run(["run", "build"]);
  await run(["test", "./acceptance/frontend.test.ts", "--test-name-pattern", "frontend renders"]);
  const contextContract = (await readFile(new URL("../src/web/context.test.ts", import.meta.url), "utf8"))
    .replace('from "./router.ts"', 'from "./web/router.ts"');
  await writeFile(join(app, "src/context.test.ts"), contextContract);
  const paramsContract = (await readFile(new URL("../src/web/route-params.test.ts", import.meta.url), "utf8"))
    .replace('from "./router.ts"', 'from "./web/router.ts"');
  await writeFile(join(app, "src/route-params.test.ts"), paramsContract);
  const methodsContract = (await readFile(new URL("../src/web/route-methods.test.ts", import.meta.url), "utf8"))
    .replace('from "./router.ts"', 'from "./web/router.ts"');
  await writeFile(join(app, "src/route-methods.test.ts"), methodsContract);
  await run(["run", "bundle", "make:request", "CreatePost", "--field", "title:string", "--field", "count:integer", "--field", "published:boolean?"]);
  await writeFile(join(app, "src/request.test.ts"), `
import { expect, test } from "bun:test";
import { readValidatedJson } from "bundle/src/web/request.ts";
import { createRouter } from "bundle/src/web/router.ts";
import { createPost, type CreatePost } from "./requests/CreatePost.ts";
test("generated request schema infers parsed data in a real handler", async () => {
  const router = createRouter([{ path: "/", methods: ["POST"], async handler(request) {
    const data = await readValidatedJson(request, createPost, { maxBytes: 1024 });
    const typed: CreatePost = data;
    const count: number = data.count;
    const published: boolean | undefined = data.published;
    // @ts-expect-error Schema output must infer number, never any.
    const wrong: string = data.count;
    return Response.json(typed);
  } }]);
  for (const [body, status, expected] of [
    [{ title: " hello ", count: 2 }, 200, { title: "hello", count: 2 }],
    [{ title: "ok", count: "2" }, 400, "Invalid request body"],
    [{ title: "ok", count: 2, secret: "private" }, 400, "Invalid request body"],
  ] as const) {
    const response = await router(new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(response.status).toBe(status);
    expect(status === 200 ? await response.json() : await response.text()).toEqual(expected);
  }
});
`);
  for (const args of [
    ["run", "typecheck"], ["run", "test"], ["run", "build"],
    ["run", "bundle", "about"], ["run", "bundle", "make:migration", "create_auth_notes"],
    ["run", "db:migrate"], ["run", "bundle", "db:seed"], ["run", "bundle", "db:table", "notes"],
    ["run", "bundle", "make:model", "Measurement", ...["string", "text", "integer", "number", "boolean", "date", "json"].flatMap(type => ["--field", `v${type}:${type}`, "--field", `n${type}:${type}?`]), "-m", "-s"],
    ["run", "db:migrate"], ["run", "bundle", "db:seed", "MeasurementSeeder"],
    ["run", "bundle", "make:resource", "Task", ...["title:string", "body:text?", "label:string?", "count:integer", "price:number", "done:boolean", "rank:integer?", "ratio:number?", "active:boolean?"].flatMap(field => ["--field", field]), "--migration"],
    ["run", "db:migrate"],
  ]) {
    console.log(`\n> bun ${args.join(" ")}`);
    const child = Bun.spawn([process.execPath, ...args], { cwd: app, env, stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => child.kill(), args.includes("test") ? 120_000 : 45_000);
    const code = await child.exited;
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Generated app verification failed: bun ${args.join(" ")} (exit ${code}). Install/network failures are not a passing acceptance check.`);
  }
  await writeFile(join(app, "scripts/verify-model.ts"), [
    'import { strict as assert } from "node:assert";',
    'import { fileURLToPath } from "node:url";',
    'import { withDatabase } from "bundle/src/database/connection.ts";',
    'import { Measurement } from "../src/models/Measurement.ts";',
    'import type { RequiredEntityData } from "@mikro-orm/core";',
    'const root = fileURLToPath(new URL("../", import.meta.url));',
    'const values = { vstring: "hello", vtext: "long text", vinteger: -42, vnumber: 1.25, vboolean: false, vdate: new Date("2026-01-02T03:04:05.000Z"), vjson: { a: [1, true, null, "ok"] } };',
    'const valid: RequiredEntityData<Measurement> = values;',
    '// @ts-expect-error Required properties cannot be omitted.',
    'const missing: RequiredEntityData<Measurement> = {};',
    'const { vjson, ...withoutJson } = values;',
    '// @ts-expect-error Non-nullable JSON fields remain required.',
    'const missingJson: RequiredEntityData<Measurement> = withoutJson;',
    '// @ts-expect-error Integer fields do not accept strings.',
    'const wrong: RequiredEntityData<Measurement> = { ...values, vinteger: "42" };',
    '// @ts-expect-error JSON class properties do not accept functions.',
    'const unsafe: Measurement["vjson"] = () => 1;',
    'await withDatabase(async orm => {',
    '  const em = orm.em.fork();',
    '  const omitted = em.create(Measurement, valid);',
    '  const explicit = em.create(Measurement, { ...values, nstring: null, ntext: null, ninteger: null, nnumber: null, nboolean: null, ndate: null, njson: null });',
    '  const populated = em.create(Measurement, { ...values, nstring: values.vstring, ntext: values.vtext, ninteger: values.vinteger, nnumber: values.vnumber, nboolean: values.vboolean, ndate: values.vdate, njson: values.vjson });',
    '  await em.flush(); em.clear();',
    '  for (const entity of [omitted, explicit, populated]) {',
    '    const loaded = await em.findOneOrFail(Measurement, { id: entity.id });',
    '    for (const key of Object.keys(values) as (keyof typeof values)[]) assert.deepEqual(loaded[key], values[key]);',
    '    const nullable = { nstring: values.vstring, ntext: values.vtext, ninteger: values.vinteger, nnumber: values.vnumber, nboolean: values.vboolean, ndate: values.vdate, njson: values.vjson };',
    '    for (const key of Object.keys(nullable) as (keyof typeof nullable)[]) assert.deepEqual(loaded[key], entity === populated ? nullable[key] : null);',
    '  }',
    '  assert.equal(await em.count(Measurement, { vstring: "hello", vinteger: -42, vboolean: false }), 3);',
    '}, { root });',
  ].join("\n"));
  await writeFile(join(app, "scripts/verify-resource.test.ts"), await readFile(new URL("../templates/acceptance/resource.test.ts.tpl", import.meta.url), "utf8"));
  for (const args of [["run", "typecheck"], ["run", "build"], ["run", "scripts/verify-model.ts"], ["test", "./scripts/verify-resource.test.ts"]]) {
    console.log(`\n> bun ${args.join(" ")}`);
    const child = Bun.spawn([process.execPath, ...args], { cwd: app, env, stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => child.kill(), args.includes("test") ? 120_000 : 45_000);
    const code = await child.exited;
    clearTimeout(timer);
    if (code !== 0) throw new Error("Generated model typecheck/SQLite persistence acceptance failed.");
  }
  // Exercise the migrated app manifest in-process; no listening socket or external server.
  await writeFile(join(app, "scripts/verify-notes.ts"), [
    'import { strict as assert } from "node:assert";',
    'import { fileURLToPath } from "node:url";',
    'import { createRouteHandler } from "bundle/src/web/server.ts";',
    'const root = fileURLToPath(new URL("../", import.meta.url));',
    'const handler = await createRouteHandler(root);',
    'const credentials = { email: "acceptance@example.com", password: "unique acceptance password" };',
    'let cookie = "";',
    'const call = (path: string, body?: unknown) => handler(new Request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin: "http://localhost", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }));',
    'assert.equal((await call("/api/notes")).status, 401);',
    'const registered = await call("/api/auth/register", credentials); assert.equal(registered.status, 201);',
    'cookie = registered.headers.get("set-cookie")!.split(";")[0]!;',
    'const oldCookie = cookie;',
    'const login = await call("/api/auth/login", credentials); assert.equal(login.status, 200);',
    'cookie = login.headers.get("set-cookie")!.split(";")[0]!; assert.notEqual(cookie, oldCookie);',
    'assert.equal((await handler(new Request("http://localhost/api/auth/me", { headers: { cookie: oldCookie } }))).status, 401);',
    'const me = await (await call("/api/auth/me")).json() as { id: number; email: string }; assert.equal(me.email, credentials.email); assert.ok(Number.isSafeInteger(me.id));',
    'const deviceCookie = cookie;',
    'cookie = "";',
    'const device = await call("/api/auth/login", credentials); assert.equal(device.status, 200);',
    'cookie = device.headers.get("set-cookie")!.split(";")[0]!;',
    'const sessionResponse = await call("/api/auth/sessions"); assert.equal(sessionResponse.status, 200); assert.equal(sessionResponse.headers.get("cache-control"), "no-store");',
    'const sessions = await sessionResponse.json() as { id: number; expiresAt: string; current: boolean }[]; assert.equal(sessions.length, 2); assert.deepEqual(sessions.map(row => row.current), [true, false]);',
    'for (const row of sessions) { assert.deepEqual(Object.keys(row).sort(), ["current", "expiresAt", "id"]); assert.equal(new Date(row.expiresAt).toISOString(), row.expiresAt); }',
    'const revoke = (id: number) => handler(new Request(`http://localhost/api/auth/sessions/${id}`, { method: "DELETE", headers: { origin: "http://localhost", cookie } }));',
    'assert.equal((await revoke(sessions[0]!.id)).status, 409); const revoked = await revoke(sessions[1]!.id); assert.equal(revoked.status, 204); assert.equal(revoked.headers.get("cache-control"), "no-store");',
    'assert.equal((await handler(new Request("http://localhost/api/auth/me", { headers: { cookie: deviceCookie } }))).status, 401); assert.equal((await (await call("/api/auth/sessions")).json() as unknown[]).length, 1);',
    'const previousCookie = cookie;',
    'const changed = await call("/api/auth/password", { currentPassword: credentials.password, newPassword: "new acceptance password!" }); assert.equal(changed.status, 204);',
    'assert.equal(changed.headers.get("cache-control"), "no-store");',
    'cookie = changed.headers.get("set-cookie")!.split(";")[0]!; assert.notEqual(cookie, previousCookie);',
    'for (const old of [deviceCookie, previousCookie]) assert.equal((await handler(new Request("http://localhost/api/auth/me", { headers: { cookie: old } }))).status, 401);',
    'assert.equal((await call("/api/auth/login", credentials)).status, 401);',
    'assert.equal((await call("/api/auth/me")).status, 200);',
    'const created = await call("/api/notes", { body: "  Acceptance note  " });',
    'assert.equal(created.status, 201);',
    'const note = await created.json() as { id: number; body: string };',
    'assert.equal(note.body, "Acceptance note"); assert.ok(Number.isSafeInteger(note.id));',
    'const listed = await call("/api/notes"); assert.equal(listed.status, 200);',
    'assert.equal(listed.headers.get("cache-control"), "no-store");',
    'assert.deepEqual(await listed.json(), [note]);',
    'const head = await handler(new Request("http://localhost/api/notes", { method: "HEAD", headers: { cookie } }));',
    'assert.equal(head.status, 200); assert.equal(await head.text(), "");',
    'assert.equal((await call("/api/auth/logout", {})).status, 204);',
    'assert.equal((await call("/api/auth/me")).status, 401);',
    'assert.equal((await call("/api/notes")).status, 401);',
  ].join("\n"));
  const api = Bun.spawn([process.execPath, "run", "scripts/verify-notes.ts"], { cwd: app, env, stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => api.kill(), 45_000);
  const code = await api.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error("Generated app migrated Notes API acceptance failed.");
  await run(["test", "./acceptance/frontend.test.ts"]);
  if (!process.env.BUNDLE_ACCEPTANCE_DOM_MODULE) console.log("DOM interactions not run: set BUNDLE_ACCEPTANCE_DOM_MODULE to an installed jsdom module. Rendered UI and runtime API acceptance still ran.");
  if (process.env.BUNDLE_ACCEPTANCE_FIREFOX === "1") {
    // Reserve distinct ports together; failure to bind is an explicit failed browser run.
    const sockets: ReturnType<typeof Bun.serve>[] = [];
    let vitePort: number; let apiPort: number;
    try {
      for (let i = 0; i < 2; i++) sockets.push(Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }));
      vitePort = sockets[0]!.port!; apiPort = sockets[1]!.port!;
    } finally { for (const socket of sockets) await socket.stop(true); }
    const origin = `http://127.0.0.1:${vitePort}`;
    const dev = Bun.spawn([process.execPath, "run", "dev"], {
      cwd: app, env: { ...env, VITE_PORT: String(vitePort), BUNDLE_PORT: String(apiPort), APP_PUBLIC_ORIGIN: origin }, stdout: "inherit", stderr: "inherit",
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
        await Bun.sleep(100);
      }
      if (!ready) throw new Error("Generated Vite/API servers did not become ready for Firefox.");
      const browser = Bun.spawn(["python3", new URL("../templates/acceptance/frontend.py", import.meta.url).pathname, origin], { env, stdout: "inherit", stderr: "inherit" });
      const deadline = setTimeout(() => browser.kill(), 90_000);
      try { if (await browser.exited !== 0) throw new Error("Firefox UI acceptance failed; this is not a passing browser run."); }
      finally { clearTimeout(deadline); }
    } finally { dev.kill("SIGTERM"); await dev.exited; }
  } else console.log("Firefox not requested. Set BUNDLE_ACCEPTANCE_FIREFOX=1 for real HTTP/browser acceptance (requires Python, Firefox and loopback sockets).");
  console.log("Generated app typecheck, tests, production build, rendered account UI, generated request/helper inference, SQLite CLI, all model field types/nullable values and auth/session-revocation/password-change/Notes/resource CRUD API workflow passed.");
} finally { await rm(root, { recursive: true, force: true }); }
