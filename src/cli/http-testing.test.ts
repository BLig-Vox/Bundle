import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { databaseFixture } from "../database/testing.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() {
  const value = await databaseFixture(); cleanups.push(value.cleanup);
  const root = join(value.root, "space é"); await mkdir(root);
  await cp(new URL("../", import.meta.url), join(root, "src"), { recursive: true });
  await writeFile(join(root, "routes.ts"), 'export default {describe(){return []},fetch(){return Response.json({ok:true})}};');
  return { root, cli: () => createCli({ root, env: value.env, output() {} }) };
}
async function consume(root: string, path: string) {
  const child = Bun.spawn([process.execPath, "test", path], { cwd: root, env: { ...process.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status).toBe(0); expect(out + err).toContain("1 pass");
}

test("make:test --http generates and consumes a nested real-worker Bun feature test", async () => {
  const { root, cli } = await fixture();
  await cli().parseAsync(["make:test", "Admin/HealthTest", "--http", "/health"], { from: "user" });
  const path = "tests/Feature/Admin/HealthTest.test.ts";
  const source = await readFile(join(root, path), "utf8"); expect(source).toContain("withHttpApplication"); expect(source).toContain("../../../src/http/testing.ts");
  await consume(root, path);
});

test("actual CLI entrypoint generates an executable native HTTP feature test", async () => {
  const { root } = await fixture();
  for (const file of ["index.ts", "package.json"]) await cp(new URL(`../../${file}`, import.meta.url), join(root, file));
  const child = Bun.spawn([process.execPath, join(root, "index.ts"), "make:test", "EntrypointHttp", "--http", "/health"], { cwd: root, env: { ...process.env, BUN_OPTIONS: "", APP_ENV: "test", NODE_ENV: "test", DATABASE_URL: "", BUNDLE_CONNECTIONS: "{}" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status, out + err).toBe(0); expect(err).toBe(""); expect(out).toContain("EntrypointHttp.test.ts");
  await consume(root, "tests/Feature/EntrypointHttp.test.ts");
});

test("published custom HTTP test stub is consumed with JSON-safe selected paths", async () => {
  const { root, cli } = await fixture();
  await cli().parseAsync(["stub:publish"], { from: "user" });
  const stub = join(root, "stubs/http-test.ts.stub");
  await writeFile(stub, (await readFile(stub, "utf8")).replace("toBe(200)", "toBe(201)"));
  await writeFile(join(root, "routes.ts"), 'export default {describe(){return []},fetch(){return new Response("fixture",{status:201})}};');
  const path = '/a$&"quoted';
  await cli().parseAsync(["make:test", "CustomHttp", "--http", path], { from: "user" });
  expect(await readFile(join(root, "tests/Feature/CustomHttp.test.ts"), "utf8")).toContain(`client.request(${JSON.stringify(path)})`);
  await consume(root, "tests/Feature/CustomHttp.test.ts");
});

test("HTTP generation never imports application routes and never overwrites", async () => {
  const { root, cli } = await fixture();
  await writeFile(join(root, "routes.ts"), 'throw new Error("generation must not import routes");');
  await cli().parseAsync(["make:test", "HttpExample", "--http", "/health"], { from: "user" });
  const path = join(root, "tests/Feature/HttpExample.test.ts"); const before = await readFile(path, "utf8");
  await expect(cli().parseAsync(["--force", "make:test", "HttpExample", "--http", "/health"], { from: "user" })).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(before);
});

test("HTTP test option/target/filename and linked-parent preflight preserve new outputs", async () => {
  const { root, cli } = await fixture();
  for (const args of [
    ["make:test", "Conflict", "--unit", "--http", "/health"],
    ["make:test", "External", "--http", "//example.invalid"],
    ["make:test", "A".repeat(248), "--http", "/health"],
  ]) await expect(cli().parseAsync(args, { from: "user" })).rejects.toThrow();
  expect(await Bun.file(join(root, "tests/Feature/Conflict.test.ts")).exists()).toBe(false);
  await mkdir(join(root, "elsewhere")); await mkdir(join(root, "tests"), { recursive: true });
  await symlink(join(root, "elsewhere"), join(root, "tests/Feature"));
  await expect(cli().parseAsync(["make:test", "Linked", "--http", "/health"], { from: "user" })).rejects.toThrow();
  expect(await Bun.file(join(root, "elsewhere/Linked.test.ts")).exists()).toBe(false);
});
