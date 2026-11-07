import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHttp } from "./http.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-http-cli-")); roots.push(root);
  await writeFile(join(root, "routes.ts"), `import {createRouter} from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../http/router.ts")).href)};
const router = createRouter();
router.add("GET", "/health", () => Response.json({ok:true}), {name:"health"});
router.add("POST", "/invoices", () => Response.json({created:true}), {name:"invoices.create",middleware:[async function audit(_context,next) { return next(); }]});
export default router;\n`);
  const output: string[] = [];
  const errors: string[] = [];
  function cli() { const program = new Command().exitOverride().configureOutput({writeErr:text=>errors.push(text)}); registerHttp(program, {root, output: text => output.push(text)}); return program; }
  return { root, output, errors, cli };
}

test("route list filters actual registrations without executing handlers", async () => {
  const { cli, output } = await fixture();
  await cli().parseAsync(["route:list", "--json", "--path", "invoice", "--method", "post", "--name", "create"], {from:"user"});
  const result = JSON.parse(output.pop()!);
  expect(result.routes).toHaveLength(1);
  expect(result.routes[0]).toMatchObject({method:"POST",path:"/invoices",name:"invoices.create"});
  await cli().parseAsync(["route:list", "--verbose"], {from:"user"});
  expect(output.join("")).toContain("audit");
});

test("serve reports a live ephemeral address and cleans up on timeout", async () => {
  const { root } = await fixture();
  let ready!: (url: string) => void;
  const listening = new Promise<string>(resolve => ready = resolve);
  const program = new Command().exitOverride();
  registerHttp(program, {root, output: text => { const info = JSON.parse(text); if (info.listening) ready(info.listening); }});
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  const running = program.parseAsync(["serve", "--port", "0", "--timeout", "1000"], {from:"user"});
  // If startup fails, this race rejects instead of waiting forever for readiness.
  const url = await Promise.race([listening, running.then(() => { throw new Error("server stopped before ready"); })]);
  expect(await (await fetch(new URL("health", url))).json()).toEqual({ok:true});
  await running;
  expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  await expect(fetch(new URL("health", url))).rejects.toThrow();
});

test.each([["SIGTERM", 143], ["SIGINT", 130]] as const)("%s interrupts a pending route import in an actual CLI process", async (signal, status) => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'console.log("IMPORT_STARTED"); await new Promise(() => {}); export default {};');
  const runner = pathToFileURL(join(import.meta.dir, "runner.ts")).href;
  const script = `import {runCli} from ${JSON.stringify(runner)}; process.exitCode = await runCli(["serve", "--port", "0"], {root:${JSON.stringify(root)}});`;
  const child = Bun.spawn([process.execPath, "-e", script], {stdout:"pipe", stderr:"pipe"});
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  try {
    const output = await Promise.race([reader.read(), Bun.sleep(3000).then(() => { throw new Error("import did not start"); })]);
    expect(new TextDecoder().decode(output.value)).toContain("IMPORT_STARTED");
    child.kill(signal);
    expect(await Promise.race([child.exited, Bun.sleep(2000).then(() => "timed out")])).toBe(status);
    await stderr;
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await reader.cancel();
  }
}, 6000);

test("serve fails if its worker exits after reporting readiness", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "routes.ts"), 'export default { fetch() { process.exit(7); }, describe() { return []; } };');
  const controller = new AbortController();
  let ready!: (url: string) => void;
  const listening = new Promise<string>(resolve => { ready = resolve; });
  const program = new Command().exitOverride();
  registerHttp(program, {root, signal: controller.signal, output: text => ready(JSON.parse(text).listening)});
  const running = program.parseAsync(["serve", "--port", "0"], {from:"user"}).then(() => "success", error => String(error));
  try {
    const url = await Promise.race([listening, Bun.sleep(3000).then(() => { throw new Error("readiness timed out"); })]);
    await fetch(url).catch(() => {});
    const result = await Promise.race([running, Bun.sleep(1000).then(() => "timed out")]);
    expect(result).toContain("HTTP server");
    expect(result).not.toBe("success");
  } finally { controller.abort(); await running; }
}, 6000);

test("serve rejects unsupported bind syntax without opening a listener", async () => {
  const { cli, errors } = await fixture();
  await expect(cli().parseAsync(["serve", "--host", "http://localhost"], {from:"user"})).rejects.toThrow("Invalid");
  await expect(cli().parseAsync(["serve", "--port", "65536"], {from:"user"})).rejects.toThrow("port");
  expect(errors.join("")).toContain("HTTP port must be");
});
