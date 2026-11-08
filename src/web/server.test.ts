import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePage } from "../cli/pages.ts";
import { createAppHandler, createPageHandler, startServer, validateAddress } from "./server.ts";

const roots: string[] = [];
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(source?: string) {
  const root = await mkdtemp(join(tmpdir(), "bundle-web-"));
  roots.push(root);
  if (source !== undefined) {
    await mkdir(join(root, "src/pages"), { recursive: true });
    await writeFile(join(root, "src/pages/Home.ts"), source);
  }
  return root;
}
async function serve(root: string) {
  const handler = await createPageHandler(root);
  return { url: new URL("http://127.0.0.1/"), request: (input: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(input instanceof Request ? input : new Request(input.toString(), init))) };
}
function secure(response: Response) {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("cache-control")).toBe("no-store");
}

test("validates explicit numeric addresses and ports, with loopback defaults", () => {
  expect(validateAddress()).toEqual({ hostname: "127.0.0.1", port: 3000 });
  expect(validateAddress("::1", "0")).toEqual({ hostname: "::1", port: 0 });
  expect(validateAddress("0.0.0.0", 65535)).toEqual({ hostname: "0.0.0.0", port: 65535 });
  for (const host of ["", "localhost", "https://127.0.0.1", "127.0.0.1:3000", "127.0.0.1\n", "[::1]", "999.0.0.1"]) {
    expect(() => validateAddress(host, 0)).toThrow("host");
  }
  for (const port of ["", " 80", "80\n", "1e3", "0x50", "1.5", "-1", "65536", NaN, Infinity, 0.5, -1, 65536]) {
    expect(() => validateAddress(undefined, port)).toThrow("port");
  }
});

test("serves generated Home only at /, ignores query props, and snapshots HTML at startup", async () => {
  const root = await fixture();
  await generatePage(root, "Home");
  const server = await serve(root);
  const response = await server.request(new URL('/?heading=%3Cscript%3Ebad%3C/script%3E', server.url));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  secure(response);
  const html = await response.text();
  expect(html).toContain("<h1>Home</h1>");
  expect(html).not.toContain("<script>");
  const head = await server.request(server.url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await head.text()).toBe("");
  await rm(join(root, "src/pages/Home.ts"));
  expect(await (await server.request(server.url)).text()).toBe(html);
});

test("missing Home and unknown paths return secure 404 without loading other files", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/pages"), { recursive: true });
  const marker = join(root, "executed");
  await writeFile(join(root, "src/pages/Other.ts"), `await Bun.write(${JSON.stringify(marker)}, 'loaded'); export function render() { return 'secret'; }`);
  const server = await serve(root);
  for (const path of ["/", "/Other", "/src/pages/Other.ts", "/%2e%2e/Other.ts", "/%2fOther", "/.env", "/favicon.ico"]) {
    const response = await server.request(new URL(path, server.url));
    expect(response.status).toBe(404);
    secure(response);
    expect(await response.text()).toBe("Not Found");
  }
  expect(await Bun.file(marker).exists()).toBe(false);
  const head = await server.request(server.url, { method: "HEAD" });
  expect(head.status).toBe(404);
  expect(await head.text()).toBe("");
});

test("unsupported methods return 405 and Allow without rendering from requests", async () => {
  const server = await serve(await fixture());
  for (const path of ["/", "/unknown"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await server.request(new URL(path, server.url), { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      secure(response);
      expect(await response.text()).toBe("Method Not Allowed");
    }
  }
});

test("import/render/contract failures give generic secure 500 responses without stacks", async () => {
  for (const source of [
    'throw new Error("private-import-secret");',
    'export function render() { throw new Error("private-render-secret"); }',
    'export async function render() { throw new Error("private-async-secret"); }',
    'export const render = 42;',
    'export function render() { return new Response("private-response-secret"); }',
  ]) {
    const server = await serve(await fixture(source));
    const response = await server.request(server.url);
    expect(response.status).toBe(500);
    secure(response);
    expect(await response.text()).toBe("Internal Server Error");
    expect((await server.request(new URL("/unknown", server.url))).status).toBe(404);
    const head = await server.request(server.url, { method: "HEAD" });
    expect(head.status).toBe(500);
    expect(await head.text()).toBe("");
  }
});

test("rejects symlinked source, pages, and Home before executing external code", async () => {
  for (const segment of ["src", "src/pages", "src/pages/Home.ts"]) {
    const root = await fixture();
    const outside = join(root, "outside");
    const marker = join(root, "executed");
    await mkdir(join(outside, "pages"), { recursive: true });
    const file = join(outside, "pages/Home.ts");
    await writeFile(file, `await Bun.write(${JSON.stringify(marker)}, 'loaded'); export function render() { return 'secret'; }`);
    if (segment !== "src") await mkdir(join(root, "src"));
    if (segment === "src/pages/Home.ts") await mkdir(join(root, "src/pages"));
    await symlink(segment === "src" ? outside : segment === "src/pages" ? join(outside, "pages") : file, join(root, segment));
    await expect(serve(root)).rejects.toThrow("symlink");
    expect(await Bun.file(marker).exists()).toBe(false);
  }
});

// Keep actual socket coverage; skip only when the host forbids listening.
let canListen = true;
try {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  await probe.stop(true);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  canListen = false;
}

test.skipIf(!canListen)("Bun.serve listens on loopback port zero and serves Home over HTTP", async () => {
  const root = await fixture();
  await generatePage(root, "Home");
  const server = await startServer({ root, port: 0 });
  servers.push(server);
  expect(server.hostname).toBe("127.0.0.1");
  expect(server.port).toBeGreaterThan(0);
  const response = await fetch(server.url);
  expect(response.status).toBe(200);
  secure(response);
  expect(await response.text()).toContain("<h1>Home</h1>");
});

test("server handler loads the selected root's static manifest and only registered generated routes", async () => {
  const { createServerHandler } = await import("./server.ts");
  const { generateRoute } = await import("../cli/routes.ts");
  const root = await fixture('export function render() { return "fallback must not run"; }');
  await generateRoute(root, "Greeting");
  await mkdir(join(root, "src/web"));
  await writeFile(join(root, "src/web/routes.ts"), 'import { handler } from "../routes/Greeting.ts"; export const routes = [{ path: "/hello", handler }];');
  const marker = join(root, "executed");
  await writeFile(join(root, "src/routes/Unregistered.ts"), `await Bun.write(${JSON.stringify(marker)}, 'loaded');`);
  const handler = await createServerHandler(root);
  const response = await handler(new Request("http://localhost/hello?name=ignored"));
  expect(response.status).toBe(200);
  secure(response);
  expect(await response.text()).toContain("<h1>Greeting</h1>");
  for (const path of ["/", "/Unregistered", "/src/routes/Unregistered.ts", "/.env", "/%2fhello"]) {
    expect((await handler(new Request(`http://localhost${path}`))).status).toBe(404);
  }
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("root project manifest imports and dispatches Home", async () => {
  const { createServerHandler } = await import("./server.ts");
  const { projectRoot } = await import("../database/config.ts");
  const handler = await createServerHandler(projectRoot);
  const response = await handler(new Request("http://localhost/"));
  expect(response.status).toBe(200);
  secure(response);
  expect(await response.text()).toContain("<h1>Home</h1>");
});

test("only absent manifests use the legacy Home snapshot fallback", async () => {
  const { createServerHandler } = await import("./server.ts");
  const handler = await createServerHandler(await fixture('export function render() { return "legacy Home"; }'));
  expect(await (await handler(new Request("http://localhost/"))).text()).toBe("legacy Home");
  for (const source of [
    'export const routes = [];',
    'throw new Error("private-manifest-secret");',
    'export const routes = null;',
    'export const routes = [{ path: "/", handler: 42 }];',
    'export const routes = [{ path: "/../secret", handler() {} }];',
    'export const routes = [{ path: "/", handler() {} }, { path: "/", handler() {} }];',
  ]) {
    const root = await fixture('throw new Error("must not load fallback");');
    await mkdir(join(root, "src/web"));
    await writeFile(join(root, "src/web/routes.ts"), source);
    if (source.includes("= [];")) {
      expect((await (await createServerHandler(root))(new Request("http://localhost/"))).status).toBe(404);
    } else {
      await expect(createServerHandler(root)).rejects.toThrow(/^Unable to load routes manifest\.$/);
    }
  }
});

test("refuses symlinked or nonregular manifest entry paths before import", async () => {
  const { createServerHandler } = await import("./server.ts");
  for (const segment of ["src", "src/web", "src/web/routes.ts"]) {
    const root = await fixture();
    const outside = join(root, "outside");
    await mkdir(join(outside, "web"), { recursive: true });
    const marker = join(root, "executed");
    const file = join(outside, "web/routes.ts");
    await writeFile(file, `await Bun.write(${JSON.stringify(marker)}, 'loaded'); export const routes = [];`);
    if (segment !== "src") await mkdir(join(root, "src"));
    if (segment === "src/web/routes.ts") await mkdir(join(root, "src/web"));
    await symlink(segment === "src" ? outside : segment === "src/web" ? join(outside, "web") : file, join(root, segment));
    await expect(createServerHandler(root)).rejects.toThrow("symlink");
    expect(await Bun.file(marker).exists()).toBe(false);
  }
  const root = await fixture();
  await mkdir(join(root, "src/web/routes.ts"), { recursive: true });
  await expect(createServerHandler(root)).rejects.toThrow("regular file");
});


test("production app handler serves built assets while routing API paths without SPA fallback", async () => {
  const root = await fixture();
  await mkdir(join(root, "dist/assets"), { recursive: true });
  await mkdir(join(root, "src/web"), { recursive: true });
  await writeFile(join(root, "dist/index.html"), '<!doctype html><script type="module" src="/assets/app-0123456789.js"></script>');
  await writeFile(join(root, "dist/assets/app-0123456789.js"), "export const ready = true;");
  await writeFile(join(root, "dist/assets/theme.css"), "body { color: black; }");
  await writeFile(join(root, "src/web/routes.ts"), 'export const routes = [{ path: "/api/health", handler: () => Response.json({ status: "ok" }) }];');
  const handler = await createAppHandler(root);
  const page = await handler(new Request("http://localhost/"));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await page.text()).toContain("/assets/app-0123456789.js");
  const asset = await handler(new Request("http://localhost/assets/app-0123456789.js?v=1"));
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await asset.text()).toBe("export const ready = true;");
  const css = await handler(new Request("http://localhost/assets/theme.css"));
  expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect(css.headers.get("cache-control")).toBe("no-store");
  const spa = await handler(new Request("http://localhost/tasks/42"));
  expect(spa.status).toBe(200);
  expect(await spa.text()).toContain("<!doctype html>");
  for (const path of ["/assets/missing.js", "/assets/missing", "/assets%2ftheme.css", "/.env", "/%ZZ"]) {
    const missingAsset = await handler(new Request(`http://localhost${path}`));
    expect(missingAsset.status).toBe(404);
    expect(await missingAsset.text()).toBe("Not Found");
  }
  const api = await handler(new Request("http://localhost/api/health"));
  expect(api.status).toBe(200);
  expect(await api.json()).toEqual({ status: "ok" });
  const apiMissing = await handler(new Request("http://localhost/api/missing"));
  expect(apiMissing.status).toBe(404);
  expect(await apiMissing.text()).toBe("Not Found");
  const forbiddenMethod = await handler(new Request("http://localhost/tasks/42", { method: "POST" }));
  expect(forbiddenMethod.status).toBe(405);
  expect(forbiddenMethod.headers.get("allow")).toBe("GET, HEAD");
  const head = await handler(new Request("http://localhost/assets/app-0123456789.js", { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("production app refuses symlinks, unsupported file types, and missing build output", async () => {
  const missing = await fixture();
  await expect(createAppHandler(missing)).rejects.toThrow("static assets");
  for (const unsafe of ["symlink", "extension"]) {
    const root = await fixture();
    await mkdir(join(root, "dist/assets"), { recursive: true });
    await writeFile(join(root, "dist/index.html"), "app");
    if (unsafe === "symlink") {
      const outside = join(root, "outside.js");
      await writeFile(outside, "private");
      await symlink(outside, join(root, "dist/assets/leak.js"));
      await expect(createAppHandler(root)).rejects.toThrow("symlink");
    } else {
      await writeFile(join(root, "dist/assets/private.php"), "private");
      await expect(createAppHandler(root)).rejects.toThrow("unsupported static asset");
    }
  }
});

test("app server mode fails before binding when the production build is absent", async () => {
  const root = await fixture();
  const listener = spyOn(Bun, "serve").mockImplementation(() => { throw new Error("listener must not start"); });
  try {
    await expect(startServer({ root, mode: "app", port: 0 })).rejects.toThrow("static assets");
    expect(listener).not.toHaveBeenCalled();
  } finally { listener.mockRestore(); }
});

test("startServer installs the manifest router with production errors and loopback defaults", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/web"), { recursive: true });
  await writeFile(join(root, "src/web/routes.ts"), 'export const routes = [{ path: "/registered", handler: () => new Response("registered") }];');
  let captured: any;
  const fake = { stop() {} };
  const spy = spyOn(Bun, "serve").mockImplementation(((options: any) => { captured = options; return fake; }) as any);
  try {
    expect(await startServer({ root, port: 0 })).toBe(fake as any);
    expect(captured.hostname).toBe("127.0.0.1");
    expect(captured.port).toBe(0);
    expect(captured.development).toBe(false);
    const response = await captured.fetch(new Request("http://localhost/registered"));
    secure(response);
    expect(await response.text()).toBe("registered");
    const failure = captured.error(new Error("private-secret"));
    secure(failure);
    expect(await failure.text()).toBe("Internal Server Error");
  } finally { spy.mockRestore(); }
});

test("route startup preserves explicit public configuration errors before listening", async () => {
  const { RouteConfigurationError } = await import("./server.ts");
  const root = await fixture();
  await mkdir(join(root, "src/web"), { recursive: true });
  await writeFile(join(root, "src/web/routes.ts"), `import { RouteConfigurationError } from "${import.meta.dir}/server.ts"; throw new RouteConfigurationError("Install reviewed app configuration.");`);
  const listener = spyOn(Bun, "serve").mockImplementation(() => { throw new Error("listener must not start"); });
  try {
    for (const mode of [undefined, "routes"] as const) {
      await expect(startServer({ root, port: 0, mode })).rejects.toThrow("Install reviewed app configuration.");
    }
    expect(listener).not.toHaveBeenCalled();
    expect(new RouteConfigurationError("safe")).toBeInstanceOf(Error);
  } finally { listener.mockRestore(); }
});
