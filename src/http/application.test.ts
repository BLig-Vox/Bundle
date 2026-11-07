import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadApplicationRouter, startApplicationServer } from "./application.ts";
import { enableMaintenance, disableMaintenance } from "../maintenance/maintenance.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-http-")); roots.push(root);
  const source = `import {createRouter} from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "router.ts")).href)};
const router = createRouter();
router.add("GET", "/hello/:name", ({params}) => Response.json({hello: params.name}), {name:"greeting"});
export default router;\n`;
  return { root, source };
}

test("loads trusted application routes and serves actual local HTTP requests", async () => {
  const { root, source } = await fixture();
  await writeFile(join(root, "routes.ts"), source);
  const router = await loadApplicationRouter(root);
  expect((await router.fetch(new Request("http://localhost/hello/reader"))).status).toBe(200);
  const server = await startApplicationServer({ root, port: 0 });
  try {
    const response = await fetch(new URL("hello/Ada", server.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: "Ada" });
    expect((await fetch(new URL("unknown", server.url))).status).toBe(404);
  } finally { await server.stop(); }
  await server.stop();
  await expect(fetch(new URL("hello/Ada", server.url))).rejects.toThrow();
});

test("server and maintenance controls share a canonical project-root alias", async () => {
  const {root,source} = await fixture();
  const aliasRoot = await fixture();
  const alias = join(aliasRoot.root,"app");
  await writeFile(join(root,"routes.ts"),source);
  await symlink(root,alias);
  const server = await startApplicationServer({root:alias,port:0});
  try {
    const url = new URL("hello/reader",server.url);
    expect((await fetch(url)).status).toBe(200);
    await enableMaintenance(alias,{retrySeconds:2});
    expect((await fetch(url)).status).toBe(503);
    expect(await disableMaintenance(alias)).toBe(true);
    expect((await fetch(url)).status).toBe(200);
  } finally { await server.stop(); }
});

test("actual routes consume bounded validation and explicit JSON resources", async () => {
  const { root } = await fixture();
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, name)).href);
  await writeFile(join(root, "routes.ts"), `
import { createRouter } from ${moduleUrl("router.ts")};
import { rules, validateRequest } from ${moduleUrl("validation.ts")};
import { resource, resourceCollection } from ${moduleUrl("resources.ts")};
const router = createRouter();
router.add("POST", "/customers", async ({request}) => {
  const result = await validateRequest(request, rules.object({name:rules.string({min:1,max:30})}), {maxBytes:256});
  if (!result.ok) return Response.json({errors:result.errors},{status:422});
  return resource(result.value, value => ({name:value.name}), {status:201});
});
router.add("GET", "/customers", () => resourceCollection([{name:"Ada",secret:"do-not-expose"}], value => ({name:value.name}), {pagination:{page:1,perPage:10,total:1}}));
export default router;\n`);
  const server = await startApplicationServer({ root, port: 0 });
  try {
    const url = new URL("customers", server.url);
    const accepted = await fetch(url, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Ada"})});
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toEqual({data:{name:"Ada"}});
    const invalid = await fetch(url, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:1,private:"submitted-secret"})});
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).not.toContain("submitted-secret");
    const collection = await (await fetch(url)).json() as {data: unknown; pagination: {lastPage: number}};
    expect(collection.data).toEqual([{name:"Ada"}]);
    expect(collection.pagination.lastPage).toBe(1);
    expect(JSON.stringify(collection)).not.toContain("do-not-expose");
  } finally { await server.stop(); }
});

test("refuses missing, invalid and unsafe route sources", async () => {
  const { root, source } = await fixture();
  await expect(loadApplicationRouter(root)).rejects.toThrow("routes.ts");
  await writeFile(join(root, "outside.ts"), source);
  await symlink(join(root, "outside.ts"), join(root, "routes.ts"));
  await expect(loadApplicationRouter(root)).rejects.toThrow("regular");
  await rm(join(root, "routes.ts"));
  await mkdir(join(root, "routes.ts"));
  await expect(loadApplicationRouter(root)).rejects.toThrow("regular");
  const bad = await fixture();
  await writeFile(join(bad.root, "routes.ts"), "export default {};\n");
  await expect(loadApplicationRouter(bad.root)).rejects.toThrow("router");
});

test("aborted server startup never imports application code", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'throw new Error("must not import cancelled source");');
  const controller = new AbortController(); controller.abort();
  await expect(startApplicationServer({ root, signal: controller.signal })).rejects.toThrow("HTTP server startup cancelled.");
});

test("aborting during a pending route import promptly terminates startup", async () => {
  const { root } = await fixture();
  const marker = join(root, "started");
  await writeFile(join(root, "routes.ts"), `await Bun.write(${JSON.stringify(marker)}, "started"); await new Promise(() => {}); export default {};`);
  const controller = new AbortController();
  const starting = startApplicationServer({ root, port: 0, signal: controller.signal });
  const result = starting.then(server => server.stop().then(() => "started"), error => String(error));
  try {
    const deadline = Date.now() + 3000;
    while (!await Bun.file(marker).exists() && Date.now() < deadline) await Bun.sleep(10);
    expect(await Bun.file(marker).exists()).toBe(true);
    controller.abort();
    expect(await Promise.race([result, Bun.sleep(500).then(() => "timed out")])).toContain("cancelled");
  } finally { controller.abort(); }
}, 5000);

test("worker serves a generic 500 for route failures", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'export default { fetch() { throw new Error("route-secret"); }, describe() { return []; } };');
  const server = await startApplicationServer({ root, port: 0 });
  try {
    const response = await fetch(server.url);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({error:"Internal server error"});
  } finally { await server.stop(); }
});

test("stopping closes active connections and post-start abort is caller-owned", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'export default { fetch() { return new Promise(() => {}); }, describe() { return []; } };');
  const controller = new AbortController();
  const server = await startApplicationServer({ root, port: 0, signal: controller.signal });
  controller.abort();
  const pending = fetch(server.url).then(() => "responded", () => "closed");
  await Bun.sleep(50);
  await server.stop();
  expect(await Promise.race([pending, Bun.sleep(1000).then(() => "timed out")])).toBe("closed");
  await expect(fetch(server.url)).rejects.toThrow();
});

test("stop interrupts a synchronously stuck request without killing the host", async () => {
  const { root } = await fixture();
  const marker = join(root, "handler-started");
  await writeFile(join(root, "routes.ts"), `import {writeFileSync} from "node:fs"; export default { fetch() { writeFileSync(${JSON.stringify(marker)}, "yes"); while (true) {} }, describe() { return []; } };`);
  const application = pathToFileURL(join(import.meta.dir, "application.ts")).href;
  const script = `import {startApplicationServer} from ${JSON.stringify(application)}; const server = await startApplicationServer({root:${JSON.stringify(root)},port:0}); process.on("SIGTERM", async () => { await server.stop(); console.log("STOPPED"); }); console.log(server.url.href);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const errors = new Response(child.stderr).text();
  try {
    const ready = await Promise.race([reader.read(), Bun.sleep(3000).then(() => { throw new Error("readiness timed out"); })]);
    const url = new TextDecoder().decode(ready.value).trim();
    const request = fetch(url).catch(() => undefined);
    const deadline = Date.now() + 3000;
    while (!await Bun.file(marker).exists() && Date.now() < deadline) await Bun.sleep(10);
    expect(await Bun.file(marker).exists()).toBe(true);
    child.kill("SIGTERM");
    const output = await Promise.race([reader.read(), Bun.sleep(2000).then(() => { throw new Error("stop timed out"); })]);
    expect(new TextDecoder().decode(output.value)).toContain("STOPPED");
    expect(await child.exited).toBe(0);
    await request;
    expect(await errors).toBe("");
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await reader.cancel();
  }
}, 8000);

test("server refuses unsafe route paths and occupied ports", async () => {
  const { root, source } = await fixture();
  await writeFile(join(root, "outside.ts"), source);
  await symlink(join(root, "outside.ts"), join(root, "routes.ts"));
  await expect(startApplicationServer({ root, port: 0 })).rejects.toThrow("startup failed");
  await rm(join(root, "routes.ts"));
  await writeFile(join(root, "routes.ts"), source);
  const server = await startApplicationServer({ root, port: 0 });
  try { await expect(startApplicationServer({ root, port: Number(server.url.port) })).rejects.toThrow("startup failed"); }
  finally { await server.stop(); }
});

test("worker startup failure rejects without exposing route errors", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'throw new Error("route-secret");');
  const result = await startApplicationServer({ root, port: 0 }).then(() => "started", error => String(error));
  expect(result).toContain("startup failed");
  expect(result).not.toContain("route-secret");
});

test("reports asynchronous worker failure after readiness", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'setTimeout(() => { throw new Error("worker-secret"); }, 200); export default { fetch() { return new Response("ok"); }, describe() { return []; } };');
  const server = await startApplicationServer({ root, port: 0 });
  try {
    expect(await Promise.race([server.closed.then(() => "closed"), Bun.sleep(1500).then(() => "timed out")])).toBe("closed");
  } finally { await server.stop(); }
});

test("worker exit during startup rejects rather than hanging", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'process.exit(7);');
  const starting = startApplicationServer({ root, port: 0 }).then(() => "started", error => String(error));
  const result = await Promise.race([starting, Bun.sleep(2000).then(() => "timed out")]);
  expect(result).toContain("startup failed");
}, 3000);

test("validates bind host and port before importing application code", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'throw new Error("must not load invalid bind target");');
  for (const options of [{ host: "http://localhost" }, { host: "localhost/path" }, { host: "" }, { port: -1 }, { port: 65536 }, { port: 1.2 }]) {
    await expect(startApplicationServer({ root, ...options })).rejects.toThrow("Invalid");
  }
});
