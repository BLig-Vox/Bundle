import { expect, test } from "bun:test";
import { createCli } from "./program.ts";

test("serve is discoverable and documents loopback defaults", () => {
  const program = createCli({ env: { DB_CONNECTION: "invalid" } });
  const command = program.commands.find(command => command.name() === "serve");
  expect(command).toBeDefined();
  expect(command!.helpInformation()).toContain("127.0.0.1");
  expect(command!.helpInformation()).toContain("3000");
  expect(command!.helpInformation()).toContain("--mode");
  expect(command!.helpInformation()).toContain("routes");
  expect(command!.helpInformation().replace(/\s+/g, " ")).toContain("PUT, PATCH, DELETE, OPTIONS");
  expect(command!.helpInformation()).toContain("GET/HEAD default");
});

test("serve rejects invalid address options before starting or touching a database", async () => {
  for (const args of [["--mode", "unknown"], ["--host", "localhost"], ["--port", "1e3"], ["--port", "65536"]]) {
    await expect(createCli({ env: { DB_CONNECTION: "invalid" } }).parseAsync(["serve", ...args], { from: "user" })).rejects.toThrow(/host|port|mode/);
  }
});

test("serve CLI wires explicit modes to only the selected root's fixed entry without database access", async () => {
  const { spyOn } = await import("bun:test");
  const { mkdir, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "bundle-serve-mode-"));
  let captured: any;
  const spy = spyOn(Bun, "serve").mockImplementation(((options: any) => {
    captured = options;
    return { url: new URL("http://127.0.0.1:12345/"), stop() {} };
  }) as any);
  try {
    await mkdir(join(root, "src/web"), { recursive: true });
    await mkdir(join(root, "src/pages"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/index.html"), "dist");
    await writeFile(join(root, "src/web/routes.ts"), 'export const routes = [{ path: "/", handler: () => new Response("route") }];');
    await writeFile(join(root, "src/pages/Home.ts"), 'export function render() { return "page"; }');
    for (const [mode, body] of [["routes", "route"], ["pages", "page"], ["app", "dist"]]) {
      const output: string[] = [];
      await createCli({ root, env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) })
        .parseAsync(["serve", "--mode", mode!, "--port", "0"], { from: "user" });
      expect(captured.hostname).toBe("127.0.0.1");
      expect(captured.port).toBe(0);
      expect(captured.development).toBe(false);
      expect(await (await captured.fetch(new Request("http://localhost/"))).text()).toBe(body!);
      expect(JSON.parse(output[0]!)).toEqual({ listening: "http://127.0.0.1:12345/" });
    }
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
