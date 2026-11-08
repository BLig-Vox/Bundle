import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCli } from "./program.ts";
import { registerRoute } from "./route-registration.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-inspect-"));
  roots.push(root);
  const put = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const run = async (...args: string[]) => {
    const output: string[] = [];
    await createCli({ root, env: { DB_CONNECTION: "invalid", DATABASE_URL: "postgres://secret", BUNDLE_CONNECTIONS: "invalid" }, output: text => output.push(text) })
      .parseAsync(args, { from: "user" });
    expect(output).toHaveLength(1);
    return output[0]!;
  };
  return { root, put, run, json: async () => JSON.parse(await run("inspect", "--json")) };
}

test("inspect --json has a stable explicit schema for missing project files", async () => {
  const { json } = await fixture();
  expect(await json()).toEqual({
    schemaVersion: 1,
    framework: { name: "bundle", version: JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version },
    package: { status: "missing", name: null, version: null },
    sourceRoots: [], models: [], routes: { status: "missing", entries: [] },
    migrations: "unknown", auth: { status: "unknown", caveat: null },
    next: { scaffold: "bun run bundle make:app my-app", dev: "bun run bundle serve", verify: "bun test && bun run typecheck" },
  });
});

test("inspect sorts roots/models/routes and never executes handlers, models or config", async () => {
  const { root, put, run, json } = await fixture();
  const marker = join(root, "executed");
  const hostile = 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "executed"); throw new Error("SECRET_PROJECT_CODE_EXECUTED");';
  await put("package.json", JSON.stringify({ name: "example", version: "1.2.3", password: "SECRET", scripts: { dev: "SECRET" } }));
  await put("src/models/Zebra.ts", hostile);
  await put("src/models/Alpha.ts", hostile);
  await put("templates/app/src/models/User.ts.tpl", hostile);
  await put("mikro-orm.config.ts", hostile);
  await registerRoute(root, "Zebra", "/zebra");
  await registerRoute(root, "Alpha", "/alpha");
  await put("src/routes/Alpha.ts", hostile);
  const result = await json();
  expect(result.package).toEqual({ status: "ok", name: "example", version: "1.2.3" });
  expect(result.sourceRoots).toEqual(["src", "templates/app/src"]);
  expect(result.models).toEqual(["src/models/Alpha.ts", "src/models/Zebra.ts", "templates/app/src/models/User.ts.tpl"]);
  expect(result.routes).toEqual({ status: "trusted", entries: [{ path: "/alpha", methods: ["GET", "HEAD"] }, { path: "/zebra", methods: ["GET", "HEAD"] }] });
  expect(await run("inspect", "--json")).toBe(await run("inspect", "--json"));
  const human = await run("inspect");
  expect(human).toContain("migrations: unknown");
  expect(human).toContain("bun run bundle serve");
  expect(human).not.toContain("SECRET");
  expect(human.split("\n").length).toBeLessThanOrEqual(10);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("inspect rejects the entire hostile manifest without evaluating literal-looking entries", async () => {
  const { root, put, json } = await fixture();
  await registerRoute(root, "Health", "/health");
  const file = join(root, "src/web/routes.ts");
  const marker = join(root, "manifest-executed");
  await put("src/web/routes.ts", await readFile(file, "utf8") + '\nimport { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "executed"); throw new Error("SECRET_MANIFEST_EXECUTED");\n');
  expect((await json()).routes).toEqual({ status: "untrusted", entries: [] });
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("inspect recognizes shipped auth methods and warns about auth readiness", async () => {
  const { put, json } = await fixture();
  await put("src/web/routes.ts", await readFile(new URL("../../templates/app/src/web/routes.ts.tpl", import.meta.url), "utf8"));
  await put("src/web/resources.ts", await readFile(new URL("../../templates/app/src/web/resources.ts.tpl", import.meta.url), "utf8"));
  const result = await json();
  expect(result.routes.status).toBe("trusted");
  expect(result.routes.entries.find((entry: { path: string }) => entry.path === "/api/notes").methods).toEqual(["GET", "HEAD", "POST"]);
  expect(result.routes.entries.find((entry: { path: string }) => entry.path === "/api/auth/password").methods).toEqual(["POST"]);
  expect(result.auth.status).toBe("generated-template");
  expect(result.auth.caveat).toContain("not production-ready");
  expect(result.next.dev).toBe("bun run dev");
  expect(result.next.scaffold).toBe("bun run bundle make:model Product");
});

test("inspect malformed and non-object packages redact contents and parsing errors", async () => {
  const { put, json, run } = await fixture();
  for (const source of ['{"password":"SECRET", broken', 'null', '[]', '42']) {
    await put("package.json", source);
    expect((await json()).package).toEqual({ status: "invalid", name: null, version: null });
    expect(await run("inspect", "--json")).not.toContain("SECRET");
  }
  await put("package.json", '{"name":"postgres://SECRET@host/db","version":{"password":"SECRET"}}');
  expect((await json()).package).toEqual({ status: "ok", name: null, version: null });
});

test("inspect skips symlink files and source directories", async () => {
  const { root, put, json } = await fixture();
  await put("outside/package.json", '{"name":"secret","version":"1.0.0"}');
  await put("outside/src/models/Secret.ts", "throw 1;");
  await symlink(join(root, "outside/package.json"), join(root, "package.json"));
  await symlink(join(root, "outside/src"), join(root, "src"));
  const result = await json();
  expect(result.package.status).toBe("unreadable");
  expect(result.sourceRoots).toEqual([]);
  expect(result.models).toEqual([]);
  expect(result.routes.entries).toEqual([]);
});

test("inspect bounds package reads and handles non-file manifests without exposing contents", async () => {
  const { root, put, json } = await fixture();
  await put("package.json", JSON.stringify({ name: "example", password: "SECRET".repeat(50000) }));
  await mkdir(join(root, "src/web/routes.ts"), { recursive: true });
  const result = await json();
  expect(result.package).toEqual({ status: "unreadable", name: null, version: null });
  expect(result.routes).toEqual({ status: "unreadable", entries: [] });
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("inspect appears in list and help", async () => {
  const { run } = await fixture();
  expect(await run("list")).toContain("inspect");
  const command = createCli().commands.find(command => command.name() === "inspect");
  expect(command?.helpInformation()).toContain("--json");
});

test("inspect real entry point uses cwd and emits only JSON without loading project modules", async () => {
  const { root, put } = await fixture();
  await put("package.json", '{"name":"cwd-project","version":"0.2.0"}');
  await put("src/web/routes.ts", 'throw new Error("SECRET_EXECUTED");');
  await put("mikro-orm.config.ts", 'throw new Error("SECRET_EXECUTED");');
  const child = Bun.spawn([process.execPath, new URL("../../index.ts", import.meta.url).pathname, "inspect", "--json"], {
    cwd: root, env: { ...process.env, DB_CONNECTION: "invalid", DATABASE_URL: "postgres://SECRET" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).not.toContain("SECRET");
  expect(JSON.parse(stdout).package.name).toBe("cwd-project");
  expect(JSON.parse(stdout).routes).toEqual({ status: "untrusted", entries: [] });
});

test("inspect recognizes shipped Home and rejects expression-based methods", async () => {
  const { put, json } = await fixture();
  await put("src/web/routes.ts", await readFile(new URL("../web/routes.ts", import.meta.url), "utf8"));
  expect((await json()).routes).toEqual({ status: "trusted", entries: [{ path: "/", methods: ["GET", "HEAD"] }] });
  await put("src/web/routes.ts", 'export const routes = [{ path: "/api/auth/login", methods: (() => { throw new Error("SECRET"); })(), handler: () => new Response() }];');
  expect((await json()).routes).toEqual({ status: "untrusted", entries: [] });
});
