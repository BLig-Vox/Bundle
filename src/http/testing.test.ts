import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withHttpApplication } from "./testing.ts";
import { cacheRoutes } from "./route-cache.ts";
import { enableMaintenance, disableMaintenance } from "../maintenance/maintenance.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-http-test-")); roots.push(root);
  await writeFile(join(root, "routes.ts"), `export default { describe(){return []}, async fetch(request){const url=new URL(request.url); if(url.pathname==="/redirect")return Response.redirect("https://example.invalid/",302); return Response.json({method:request.method,path:url.pathname,body:request.method==="POST"?await request.text():null})} };`);
  return root;
}

test("native HTTP harness uses an owned live loopback listener and closes it", async () => {
  const root = await fixture(); let url = "";
  const result = await withHttpApplication({ root }, async client => {
    expect(Object.isFrozen(client)).toBe(true);
    const response = await client.request("/health"); url = response.url;
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect(await response.json()).toEqual({ method: "GET", path: "/health", body: null });
    expect(await (await client.request("/echo", { method: "POST", body: "native" })).json()).toEqual({ method: "POST", path: "/echo", body: "native" });
    const redirect = await client.request("/redirect"); expect(redirect.status).toBe(302); await redirect.body?.cancel();
    return 42;
  });
  expect(result).toBe(42);
  await expect(fetch(url)).rejects.toThrow();
});

test("callback failure and cancellation stop only the owned listener", async () => {
  const root = await fixture(); let url = "";
  await expect(withHttpApplication({ root }, async client => { const response = await client.request("/"); url = response.url; await response.body?.cancel(); throw new Error("fixture callback"); })).rejects.toThrow("fixture callback");
  await expect(fetch(url)).rejects.toThrow();
  const controller = new AbortController();
  await expect(withHttpApplication({ root, signal: controller.signal }, async client => { const response = await client.request("/"); url = response.url; await response.body?.cancel(); controller.abort(); return "not-success"; })).rejects.toThrow("cancelled");
  await expect(fetch(url)).rejects.toThrow();
});

test("client refuses external/ambiguous request targets without following redirects", async () => {
  const root = await fixture();
  await withHttpApplication({ root }, async client => {
    for (const path of ["https://example.invalid", "//example.invalid", "/\\example.invalid", "relative", "/x\n", "/x#fragment", "/" + "a".repeat(8192)]) {
      await expect(client.request(path)).rejects.toThrow("path");
    }
  });
});

test("actual worker consumes cached routes and live maintenance without source fallback", async () => {
  const root = await fixture();
  await writeFile(join(root, "Health.ts"), 'export function health(){return Response.json({cached:true})}');
  await writeFile(join(root, "routes.ts"), `import {defineRoutes} from ${JSON.stringify(new URL("./route-definitions.ts", import.meta.url).href)}; export default defineRoutes([{method:"GET",path:"/health",handler:{module:"Health.ts",export:"health"}}]);`);
  await cacheRoutes(root);
  await writeFile(join(root, "routes.ts"), 'throw new Error("cache must win");');
  await withHttpApplication({ root }, async client => {
    expect(await (await client.request("/health")).json()).toEqual({ cached: true });
    await enableMaintenance(root);
    const down = await client.request("/health"); expect(down.status).toBe(503); expect(down.headers.get("cache-control")).toContain("no-store"); await down.body?.cancel();
    await disableMaintenance(root);
    expect((await client.request("/health")).status).toBe(200);
  });
});

test("production worker serves descriptor-opened dist assets for GET and HEAD", async () => {
  if (process.platform !== "linux") return;
  const root = await fixture(); await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/index.html"), "<main>frontend</main>");
  await writeFile(join(root, "dist/app.js"), "export const ready = true;");
  await writeFile(join(root, "routes.ts"), 'export default {describe(){return []},fetch(){return new Response("not found",{status:404})}};');
  await withHttpApplication({ root }, async client => {
    const page = await client.request("/"); expect(page.status).toBe(200); expect(await page.text()).toBe("<main>frontend</main>");
    const asset = await client.request("/app.js"); expect(asset.status).toBe(200); expect(asset.headers.get("content-type")).toContain("javascript"); expect(await asset.text()).toContain("ready");
    const head = await client.request("/app.js", { method: "HEAD" }); expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("export const ready = true;"))); expect(await head.text()).toBe("");
  });
});

test("abort stops a pending owned request and retained clients cannot reopen listeners", async () => {
  const root = await fixture(); let url = ""; let retained: Parameters<Parameters<typeof withHttpApplication>[1]>[0] | undefined;
  await writeFile(join(root, "routes.ts"), 'export default {describe(){return []},fetch(request){return new URL(request.url).pathname==="/hang"?new Promise(()=>{}):new Response("ok")}};');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(withHttpApplication({ root, signal: controller.signal }, async client => {
      retained = client; const response = await client.request("/"); url = response.url; await response.body?.cancel();
      timer = setTimeout(() => controller.abort(), 20);
      await client.request("/hang");
    })).rejects.toThrow();
  } finally { clearTimeout(timer); }
  await expect(fetch(url)).rejects.toThrow();
  await expect(retained!.request("/")).rejects.toThrow("closed");
});

test("native RequestInit inherits dictionary members and reads non-enumerable fields", async () => {
  const root = await fixture();
  await withHttpApplication({ root }, async client => {
    for (const init of [Object.create({ method: "POST", body: "inherited" }), Object.defineProperties({}, { method: { value: "POST" }, body: { value: "hidden" } })]) {
      const native = new Request("http://127.0.0.1/", init);
      const response = await client.request("/", init);
      expect(await response.json()).toEqual({ method: native.method, path: "/", body: await native.text() });
    }
  });
});

test("abort during bounded owned shutdown cannot report successful completion", async () => {
  const root = await fixture(); const marker = join(root, "blocked.txt");
  await writeFile(join(root, "routes.ts"), `import {writeFileSync} from "node:fs"; export default {describe(){return []},fetch(){setTimeout(()=>{writeFileSync(${JSON.stringify(marker)},"blocked");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000)},0);return new Response("ok")}};`);
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(withHttpApplication({ root, signal: controller.signal }, async client => {
      const response = await client.request("/"); await response.text();
      const deadline = Date.now() + 1500;
      while (!(await Bun.file(marker).exists())) { if (Date.now() > deadline) throw new Error("fixture did not block"); await Bun.sleep(1); }
      timer = setTimeout(() => controller.abort(), 10);
      return "not-success";
    })).rejects.toThrow("cancelled");
  } finally { clearTimeout(timer); }
  expect(controller.signal.aborted).toBe(true);
});

test("closed option validation and preabort precede route import", async () => {
  const root = await fixture(); await writeFile(join(root, "routes.ts"), 'throw new Error("must not import");');
  const controller = new AbortController(); controller.abort();
  await expect(withHttpApplication({ root, signal: controller.signal }, async () => {})).rejects.toThrow("cancelled");
  const invalid = Object.defineProperty({ root }, "signal", { get() { throw new Error("getter executed"); } });
  await expect(withHttpApplication(invalid, async () => {})).rejects.toThrow("options");
});
