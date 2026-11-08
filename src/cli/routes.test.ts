import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { createRouteHandler } from "../web/server.ts";
import { projectRoot } from "../database/config.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(projectRoot, ".data/route-test-"));
  roots.push(root);
  const output: string[] = [];
  const run = (...args: string[]) => createCli({ root, env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) }).parseAsync(args, { from: "user" });
  return { root, output, run };
}

test("make:route generates an editable typed safe handler that serves end to end", async () => {
  const { root, output, run } = await fixture();
  await run("make:route", "Greeting");
  const result = JSON.parse(output[0]!);
  expect(result).toEqual({
    created: "src/routes/Greeting.ts",
    registration: {
      manifest: "src/web/routes.ts",
      import: 'import { handler as GreetingHandler } from "../routes/Greeting.ts";',
      entry: '{ path: "/greeting", handler: GreetingHandler },',
    },
  });
  expect(await Bun.file(join(root, "src/web/routes.ts")).exists()).toBe(false);
  await mkdir(join(root, "src/web"));
  const manifest = `${result.registration.import}\nexport const routes = [${result.registration.entry}];\n`;
  await writeFile(join(root, "src/web/routes.ts"), manifest);
  await run("make:route", "Other");
  expect(await readFile(join(root, "src/web/routes.ts"), "utf8")).toBe(manifest);
  const file = join(root, "src/routes/Greeting.ts");
  expect(await readFile(file, "utf8")).toContain("request: Request): Response");
  const route = await createRouteHandler(root);
  const response = await route(new Request("http://127.0.0.1/greeting?name=<script>", { headers: { Host: "evil.example" } }));
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toContain("<h1>Greeting</h1>");
  await writeFile(file, "// edited");
  await expect(run("make:route", "Greeting", "--force")).rejects.toThrow("already exists");
  expect(await readFile(file, "utf8")).toBe("// edited");
  expect(await readFile(join(root, "src/web/routes.ts"), "utf8")).toBe(manifest);
});

test("route scaffold rejects unsafe names, symlinks, collisions, and concurrent overwrite", async () => {
  const { root, run } = await fixture();
  for (const name of ["../Escape", "Name.ts", "lower", "CON", "Name\n"]) await expect(run("make:route", name)).rejects.toThrow("PascalCase");
  expect(await readdir(root)).toEqual([]);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => run("make:route", "Safe")));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const directory = join(root, "src/routes");
  await mkdir(join(directory, "Directory.ts"));
  await symlink(join(root, "missing"), join(directory, "Linked.ts"));
  for (const name of ["Directory", "Linked"]) await expect(run("make:route", name)).rejects.toThrow("already exists");
  expect((await readdir(directory)).sort()).toEqual(["Directory.ts", "Linked.ts", "Safe.ts"]);
  for (const segment of ["src", "src/routes"]) {
    const f = await fixture();
    await mkdir(join(f.root, "outside"));
    if (segment.includes("/")) await mkdir(join(f.root, "src"));
    await symlink(join(f.root, "outside"), join(f.root, segment));
    await expect(f.run("make:route", "Safe")).rejects.toThrow("real directory");
    expect(await readdir(join(f.root, "outside"))).toEqual([]);
  }
});

let canListen = true;
try {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  await probe.stop(true);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  canListen = false;
}

test.skipIf(!canListen)("real serve CLI runs an explicitly registered generated route and shuts down cleanly", async () => {
  const { root } = await fixture();
  for (const path of ["src", "index.ts", "package.json"]) await cp(join(projectRoot, path), join(root, path), { recursive: true });
  // Auto-registration is intentionally limited to Bundle-generated manifests.
  // This copied framework manifest is custom code, so start with no app manifest.
  await rm(join(root, "src/web/routes.ts"));
  await createCli({ root, output: () => {} }).parseAsync(["make:route", "Greeting", "--register", "--path", "/hello"], { from: "user" });
  await createCli({ root, output: () => {} }).parseAsync(["make:route", "ParamGreeting", "--register", "--path", "/hello/:name"], { from: "user" });
  // An unregistered module must never be discovered or executed.
  await writeFile(join(root, "src/routes/Unregistered.ts"), 'throw new Error("must not execute");');
  const child = Bun.spawn(["bun", "run", "index.ts", "serve", "--mode", "routes", "--port", "0"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, DB_CONNECTION: "invalid" } });
  try {
    const reader = child.stdout.getReader();
    const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("serve startup timed out")), 5000))]);
    const { listening: url } = JSON.parse(new TextDecoder().decode(first.value));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await (await fetch(new URL("/hello", url))).text()).toContain("<h1>Greeting</h1>");
    expect(await (await fetch(new URL("/hello/%E9%9B%AA", url))).text()).toContain("<h1>ParamGreeting</h1>");
    const bad = await fetch(new URL("/hello/%2F", url));
    expect(bad.status).toBe(400); expect(await bad.text()).toBe("Bad Request");
    const post = await fetch(new URL("/hello/abc", url), { method: "POST" });
    expect(post.status).toBe(405); expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(new URL("/Unregistered", url))).status).toBe(404);
    reader.releaseLock();
  } finally { child.kill(); await child.exited; }
});

test("real generated CLI registers parameter handlers and serves them through the fixed manifest", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "node_modules"));
  await symlink(projectRoot, join(root, "node_modules/bundle"));
  await cp(join(projectRoot, "templates/app/scripts/bundle.ts.tpl"), join(root, "scripts/bundle.ts"));
  const child = Bun.spawn([process.execPath, "scripts/bundle.ts", "make:route", "UserNote", "--register", "--path", "/users/:userId/notes/:note_id"], {
    cwd: root, env: { ...process.env, DB_CONNECTION: "invalid" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(stderr).toBe("");
  expect(JSON.parse(stdout).registered.path).toBe("/users/:userId/notes/:note_id");
  await writeFile(join(root, "src/routes/Unregistered.ts"), 'throw new Error("must never execute");');
  // Edit only the generated handler, retaining the actual CLI-generated manifest.
  await writeFile(join(root, "src/routes/UserNote.ts"), `import type { RouteContext } from "bundle/src/web/router.ts";
export function handler(_request: Request, context?: RouteContext) { return Response.json(context!.params); }
`);
  const router = await createRouteHandler(root);
  expect(await (await router(new Request("http://localhost/users/%E9%9B%AA/notes/%252F"))).json()).toEqual({ userId: "雪", note_id: "%2F" });
  expect((await router(new Request("http://localhost/users/%2F/notes/1"))).status).toBe(400);
  expect((await router(new Request("http://localhost/Unregistered"))).status).toBe(404);
});

test("real generated CLI registers routes edited for DELETE/PATCH; wrong verbs never reach handlers", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "node_modules"));
  await symlink(projectRoot, join(root, "node_modules/bundle"));
  await cp(join(projectRoot, "templates/app/scripts/bundle.ts.tpl"), join(root, "scripts/bundle.ts"));
  for (const name of ["RemoveItem", "EditItem"]) {
    const child = Bun.spawn([process.execPath, "scripts/bundle.ts", "make:route", name, "--register", "--path", `/${name}/:id`], {
      cwd: root, env: { ...process.env, DB_CONNECTION: "invalid" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(err).toBe("");
    expect(JSON.parse(out).registered.path).toBe(`/${name}/:id`);
    await writeFile(join(root, `src/routes/${name}.ts`), `import type { RouteContext } from "bundle/src/web/router.ts";
export let calls = 0;
export function handler(request: Request, ctx?: RouteContext) { calls++; return Response.json({ method: request.method, id: ctx!.params.id, calls }); }
`);
  }
  const manifest = join(root, "src/web/routes.ts");
  await writeFile(manifest, (await readFile(manifest, "utf8"))
    .replace('handler: RemoveItemHandler', 'methods: ["DELETE"], handler: RemoveItemHandler')
    .replace('handler: EditItemHandler', 'methods: ["PATCH"], handler: EditItemHandler'));
  await writeFile(join(root, "src/routes/Unregistered.ts"), 'throw new Error("must never execute");');
  const router = await createRouteHandler(root);
  for (const [name, declared] of [["RemoveItem", "DELETE"], ["EditItem", "PATCH"]]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"].filter(verb => verb !== declared)) {
      const response = await router(new Request(`http://localhost/${name}/42`, { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(declared!);
      expect(await response.text()).toBe(method === "HEAD" ? "" : "Method Not Allowed");
    }
    const response = await router(new Request(`http://localhost/${name}/%E9%9B%AA`, { method: declared }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: declared, id: "雪", calls: 1 });
  }
  expect((await router(new Request("http://localhost/Unregistered"))).status).toBe(404);
});
