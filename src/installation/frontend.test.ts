import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseFixture } from "../database/testing.ts";
import { createProject } from "./project.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() { const result = await databaseFixture(); cleanups.push(result.cleanup); return result; }
async function install(root: string) {
  const child = Bun.spawn([process.execPath, "install", "--offline"], { cwd: root, env: { ...process.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status, out + err).toBe(0);
}

test("generated React/shadcn frontend installs from cache, typechecks, serves Vite Fast Refresh HMR and builds", async () => {
  const { root } = await fixture(); const project = await createProject({ parent: root, name: "mvc-workshop" });
  const packageJson = await Bun.file(join(project.directory, "package.json")).json();
  expect(packageJson.devDependencies.react).toBeString(); expect(packageJson.devDependencies.vite).toBeString();
  expect(packageJson.scripts.dev).toBe("bun run index.ts dev");
  expect(await Bun.file(join(project.directory, "components.json")).exists()).toBe(true);
  expect(await Bun.file(join(project.directory, "resources/js/components/ui/button.tsx")).exists()).toBe(true);
  expect(await Bun.file(join(project.directory, "resources/js/views/App.tsx")).exists()).toBe(true);
  expect(await Bun.file(join(project.directory, "dev.ts")).exists()).toBe(true);
  await install(project.directory);
  const checked = Bun.spawn([process.execPath, "run", "typecheck"], { cwd: project.directory, env: { ...process.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
  const [checkOut, checkErr, checkStatus] = await Promise.all([new Response(checked.stdout).text(), new Response(checked.stderr).text(), checked.exited]);
  expect(checkStatus, checkOut + checkErr).toBe(0);
  const web = Bun.spawn([process.execPath, "run", "index.ts", "ui:dev"], { cwd: project.directory, env: { ...process.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
  const reader = web.stdout.getReader(); const decoder = new TextDecoder(); let output = ""; let url = ""; let socket: WebSocket | undefined; const errorPromise = new Response(web.stderr).text();
  try {
    const deadline = Date.now() + 12000;
    let pendingRead: ReturnType<typeof reader.read> | undefined;
    while (!url && Date.now() < deadline) {
      pendingRead ??= reader.read();
      const line = await Promise.race([pendingRead, Bun.sleep(50).then(() => undefined)]);
      if (line === undefined) continue;
      pendingRead = undefined;
      if (line.done) break;
      if (line.value) { output += decoder.decode(line.value, { stream: true }); const match = output.match(/Vite frontend listening at (http:\/\/127\.0\.0\.1:\d+\/)/); if (match) url = match[1]!; }
    }
    if (!url) {
      const command = await Bun.file(`/proc/${web.pid}/cmdline`).text().catch(() => "");
      if (web.exitCode === null) { web.kill("SIGTERM"); await web.exited; }
      expect(url, `pid=${web.pid} status=${web.exitCode} command=${command} stdout=${output} stderr=${await errorPromise}`).not.toBe("");
    }
    expect(url, output).not.toBe("");
    const page = await fetch(url).catch(async cause => {
      if (web.exitCode === null) { web.kill("SIGTERM"); await web.exited; }
      throw new Error(`Vite advertised ${url} but did not accept a request. stdout=${output} stderr=${await errorPromise}`, { cause });
    }); expect(page.status).toBe(200); expect(await page.text()).toContain("main.tsx");
    const module = await fetch(new URL("/resources/js/views/App.tsx", url)); const transformed = await module.text();
    expect(module.status).toBe(200); expect(transformed).toContain("/\@react-refresh"); expect(transformed).toContain("createHotContext");
    socket = new WebSocket(url.replace("http:", "ws:"), "vite-hmr");
    const message = await Promise.race([
      new Promise<string>((resolve, reject) => { socket!.onmessage = event => resolve(String(event.data)); socket!.onerror = () => reject(new Error("Vite HMR socket failed.")); }),
      Bun.sleep(3000).then(() => { throw new Error("Vite HMR socket did not connect."); }),
    ]);
    expect(message).toContain('"type":"connected"');
    const app = join(project.directory, "resources/js/views/App.tsx"); const source = await Bun.file(app).text();
    await writeFile(app, `${source}\n// HMR fixture edit\n`);
    const update = await Promise.race([
      new Promise<string>((resolve, reject) => { socket!.onmessage = event => resolve(String(event.data)); socket!.onerror = () => reject(new Error("Vite HMR socket closed.")); }),
      Bun.sleep(5000).then(() => { throw new Error("Vite HMR update did not arrive."); }),
    ]);
    expect(update).toContain('"type":"update"'); expect(update).toContain("App.tsx");
  } finally {
    socket?.close(); if (web.exitCode === null) web.kill("SIGTERM"); await web.exited; await reader.cancel();
  }
  const build = Bun.spawn([process.execPath, "run", "index.ts", "ui:build"], { cwd: project.directory, env: { ...process.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
  const [buildOut, buildErr, buildStatus] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  expect(buildStatus, buildOut + buildErr).toBe(0); expect(await Bun.file(join(project.directory, "dist/index.html")).exists()).toBe(true);
}, 45000);
