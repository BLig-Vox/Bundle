import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouteHandler, startServer } from "./server.ts";
import { createRouter } from "./router.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(source?: string) {
  const root = await mkdtemp(join(tmpdir(), "bundle-routes-"));
  roots.push(root);
  await mkdir(join(root, "src/web"), { recursive: true });
  if (source !== undefined) await writeFile(join(root, "src/web/routes.ts"), source);
  return root;
}
function secure(response: Response) {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

test("root-specific fixed manifest uses static imports; unregistered files never execute", async () => {
  const root = await fixture('import { handler } from "../routes/Greeting.ts"; export const routes = [{ path: "/greeting", handler }];');
  await mkdir(join(root, "src/routes"));
  await writeFile(join(root, "src/routes/Greeting.ts"), 'let n = 0; export function handler(request: Request) { return new Response(`${request.method}:${++n}`, { status: 201, headers: { "X-App": "yes", "Cache-Control": "public" } }); }');
  const marker = join(root, "executed");
  await writeFile(join(root, "src/routes/Unregistered.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed");`);
  const handle = await createRouteHandler(root);
  for (const [method, body] of [["GET", "GET:1"], ["HEAD", ""], ["GET", "GET:3"]]) {
    const response = await handle(new Request("http://localhost/greeting?name=ignored", { method }));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-app")).toBe("yes");
    secure(response);
    expect(await response.text()).toBe(body!);
  }
  await rm(join(root, "src/web/routes.ts"));
  for (const path of ["/", "/Greeting", "/src/routes/Unregistered.ts", "/%2fGreeting", "/.env"]) {
    const response = await handle(new Request(`http://localhost${path}`));
    expect(response.status).toBe(404);
    secure(response);
  }
  expect(await Bun.file(marker).exists()).toBe(false);
  const other = await createRouteHandler(await fixture());
  expect((await other(new Request("http://localhost/"))).status).toBe(404);
  expect((await other(new Request("http://localhost/greeting"))).status).toBe(404);
});

test("router preserves method, HEAD, generic errors and security headers on every outcome", async () => {
  const handle = createRouter([
    { path: "/", handler: () => { throw new Error("private-secret"); } },
    { path: "/async", handler: async () => { throw new Error("private-secret"); } },
    { path: "/contract", handler: (() => "private-secret") as any },
  ]);
  for (const path of ["/", "/async", "/contract", "/unknown"]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await handle(new Request(`http://localhost${path}`, { method }));
      const status = !["GET", "HEAD"].includes(method) ? 405 : path === "/unknown" ? 404 : 500;
      expect(response.status).toBe(status);
      secure(response);
      if (status === 405) expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(await response.text()).toBe(method === "HEAD" ? "" : status === 405 ? "Method Not Allowed" : status === 404 ? "Not Found" : "Internal Server Error");
    }
  }
});

test("invalid manifests fail at startup with generic errors", async () => {
  for (const source of [
    'throw new Error("private-secret");', 'export const routes = {};', 'export const routes = [null];',
    'export const routes = [{ path: "/", handler: 42 }];',
    'export const routes = [{ path: "/:id?", handler() {} }];',
    'export const routes = [{ path: "/", handler() {} }, { path: "/", handler() {} }];',
  ]) {
    await expect(createRouteHandler(await fixture(source))).rejects.toThrow("Unable to load route manifest.");
  }
  await expect(startServer({ root: await fixture(), mode: "invalid" as any, port: 0 })).rejects.toThrow("mode");
});

test("manifest path refuses symlinks and nonregular entries before code executes", async () => {
  for (const segment of ["src", "src/web", "src/web/routes.ts"]) {
    const root = await fixture();
    const outside = await fixture('throw new Error("must not execute");');
    await rm(join(root, segment), { recursive: true, force: true });
    await symlink(join(outside, segment), join(root, segment));
    await expect(createRouteHandler(root)).rejects.toThrow("symlink");
  }
  const root = await fixture();
  await mkdir(join(root, "src/web/routes.ts"));
  await expect(createRouteHandler(root)).rejects.toThrow("regular file");
});

test("explicit modes execute only their selected fixed entry", async () => {
  const { createServerHandler } = await import("./server.ts");
  const routesRoot = await fixture('export const routes = [{ path: "/", handler: () => new Response("route") }];');
  await mkdir(join(routesRoot, "src/pages"));
  await writeFile(join(routesRoot, "src/pages/Home.ts"), 'throw new Error("page must not execute");');
  const routes = await createServerHandler(routesRoot, "routes");
  expect(await (await routes(new Request("http://localhost/"))).text()).toBe("route");
  const missingRoot = await fixture();
  await mkdir(join(missingRoot, "src/pages"));
  await writeFile(join(missingRoot, "src/pages/Home.ts"), 'throw new Error("page must not execute");');
  expect((await (await createServerHandler(missingRoot, "routes"))(new Request("http://localhost/"))).status).toBe(404);
  const pagesRoot = await fixture('throw new Error("manifest must not execute");');
  await mkdir(join(pagesRoot, "src/pages"));
  await writeFile(join(pagesRoot, "src/pages/Home.ts"), 'export function render() { return "page"; }');
  const pages = await createServerHandler(pagesRoot, "pages");
  expect(await (await pages(new Request("http://localhost/"))).text()).toBe("page");
});

test("fixed manifest accepts explicit methods with HEAD alias and precise Allow", async () => {
  const root = await fixture('export const routes = [{ path: "/notes", methods: ["GET", "POST"], handler: (request: Request) => Response.json({ method: request.method }) }];');
  const handle = await createRouteHandler(root);
  for (const method of ["GET", "POST", "HEAD", "DELETE"]) {
    const response = await handle(new Request("http://localhost/notes", { method }));
    secure(response);
    expect(response.status).toBe(method === "DELETE" ? 405 : 200);
    if (method === "DELETE") expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
    else if (method === "HEAD") expect(await response.text()).toBe("");
    else expect(await response.json()).toEqual({ method });
  }
  for (const methods of ['[]', '["HEAD"]', '["TRACE"]', 'null']) {
    await expect(createRouteHandler(await fixture('export const routes = [{ path: "/", methods: ' + methods + ', handler: () => new Response() }];'))).rejects.toThrow("Unable to load route manifest.");
  }
});
