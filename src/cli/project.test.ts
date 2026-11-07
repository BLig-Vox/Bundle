import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { runCli } from "./runner.ts";
import { databaseFixture } from "../database/testing.ts";
import { testCommand } from "../console/testing.ts";
import { startApplicationServer } from "../http/application.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() {
  const value = await databaseFixture(); cleanups.push(value.cleanup);
  return { ...value, run: async (...args: string[]) => {
    let output = "";
    await createCli({ root: value.root, env: value.env, output: text => { output = text; } }).parseAsync(args, { from: "user" });
    return JSON.parse(output);
  } };
}
async function child(root: string, ...args: string[]) {
  const process = Bun.spawn([Bun.which("bun")!, "run", "index.ts", ...args], { cwd: root, env: { ...Bun.env, BUN_OPTIONS: "", DATABASE_URL: "", DB_CONNECTION: "sqlite", DB_DATABASE: ".data/application.sqlite", NODE_ENV: "test", APP_ENV: "test", BUNDLE_CONNECTIONS: "{}" }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(error).toBe(""); expect(code).toBe(0); return output;
}

test("new creates an offline runnable native application without copying parent state", async () => {
  const { root, run } = await fixture();
  await writeFile(join(root, ".env"), "APP_PRIVATE_MARKER=not-template-data\n");
  await mkdir(join(root, "config")); await writeFile(join(root, "config/private.ts"), "export default { privateMarker: true };\n");
  const result = await run("new", "created-app");
  const destination = join(root, "created-app");
  expect(result.directory).toBe(destination); expect(result.driver).toBe("sqlite"); expect(result.testing).toBe("bun");
  expect(await readFile(join(destination, ".env"), "utf8")).not.toContain("not-template-data");
  for (const path of ["config/private.ts", "test.sqlite", ".data/application.sqlite", "node_modules", "bun.lock", ".git"]) expect(await Bun.file(join(destination, path)).exists()).toBe(false);
  expect((await stat(join(destination, ".env"))).mode & 0o777).toBe(0o600);
  expect((await stat(destination)).mode & 0o777).toBe(0o700);
  expect(await child(destination, "list", "--raw")).toContain("new");
  expect(JSON.parse(await child(destination, "route:list", "--json")).routes[0].path).toBe("/health");
  await child(destination, "route:cache");
  const server = await startApplicationServer({ root: destination, port: 0 });
  try { const response = await fetch(new URL("/health", server.url)); expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "ok" }); }
  finally { await server.stop(); }
  expect(await Bun.file(join(destination, ".data/application.sqlite")).exists()).toBe(false);
  expect(JSON.parse(await child(destination, "migrate")).migrated).toHaveLength(1);
  expect(JSON.parse(await child(destination, "db:seed")).seeded).toBe("DatabaseSeeder");
  for (const args of [["test", "tests/Unit/Application.test.ts"], ["check"]]) {
    const process = Bun.spawn([Bun.which("bun")!, ...args], { cwd: destination, env: { ...Bun.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(`${output}${error}`).not.toContain("fail)"); expect(code).toBe(0);
  }
}, 30000);

test.each(["sqlite", "postgresql", "mariadb"])("new configures only the explicit %s database and Bun testing", async driver => {
  const { root, run } = await fixture();
  const result = await run("new", "configured", "--driver", driver, "--without-http");
  expect(result.driver).toBe(driver); expect(result.http).toBe(false);
  expect(await readFile(join(root, "configured/.env"), "utf8")).toContain(`DB_CONNECTION=${driver}`);
  expect(await Bun.file(join(root, "configured/routes.ts")).exists()).toBe(false);
  expect(await Bun.file(join(root, "configured/.data/application.sqlite")).exists()).toBe(false);
});

test("generated native Bun test handles parent paths with spaces and Unicode", async () => {
  const { root, run } = await fixture();
  const parent = join(root, "parent with spaces ü"); await mkdir(parent);
  const created = await run("new", "space-app", "--parent", parent);
  const process = Bun.spawn([Bun.which("bun")!, "test", "tests/Unit/Application.test.ts"], { cwd: created.directory, env: { ...Bun.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(`${output}${error}`).toContain("1 pass"); expect(code).toBe(0);
});

test("new interactive setup consumes the real native prompt harness", async () => {
  const { root } = await fixture();
  const result = await testCommand(["new", "--interactive"], { root, prompts: [
    { method: "text", message: "Application name", lines: ["interactive-app"] },
    { method: "select", message: "Database driver", lines: ["2"] },
    { method: "confirm", message: "Include health route", lines: ["no"] },
  ] });
  result.assertExitCode(0).assertNoError();
  const output = JSON.parse(result.output);
  expect(output.driver).toBe("postgresql"); expect(output.testing).toBe("bun"); expect(output.http).toBe(false);
  expect(await Bun.file(join(root, "interactive-app/routes.ts")).exists()).toBe(false);
});

test("new refuses every existing destination and invalid input without changing parent files", async () => {
  const { root, run } = await fixture();
  await mkdir(join(root, "existing")); await writeFile(join(root, "existing/preserve.txt"), "preserve\n");
  await symlink(join(root, "absent"), join(root, "linked"));
  for (const name of ["existing", "linked", "../escape", "Uppercase", "a/b", "x".repeat(65)]) {
    await expect(run("--force", "new", name)).rejects.toThrow();
  }
  expect(await readFile(join(root, "existing/preserve.txt"), "utf8")).toBe("preserve\n");
  await expect(run("new", "invalid-driver", "--driver", "invalid")).rejects.toThrow();
  expect(await Bun.file(join(root, "invalid-driver/package.json")).exists()).toBe(false);
  await expect(run("new")).rejects.toThrow();
});

test.each(["commands", "providers", "package-cache"] as const)("new bypasses unrelated application %s bootstrap", async kind => {
  const { root } = await fixture(); const marker = join(root, "imported-marker");
  const source = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); throw new Error("application source must not execute"); export default {};\n`;
  if (kind === "providers") await writeFile(join(root, "providers.ts"), source);
  else if (kind === "commands") { await mkdir(join(root, "src/commands")); await writeFile(join(root, "src/commands/Probe.ts"), source); }
  else { await mkdir(join(root, "bootstrap/cache"), { recursive: true }); await writeFile(join(root, "bootstrap/cache/packages.json"), "invalid unrelated cache"); }
  const result = await testCommand(["--force", "new", "independent"], { root });
  result.assertExitCode(0).assertNoError();
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await Bun.file(join(root, "independent/package.json")).exists()).toBe(true);
});

test.each([["--path", "new", "list"], ["--database", "new", "list"], ["list", "new"]].map(args => ({ args })))("installer recognition preserves ordinary application bootstrap for %j", async ({ args }) => {
  const { root } = await fixture(); const marker = join(root, "imported-marker");
  await mkdir(join(root, "src/commands"));
  await writeFile(join(root, "src/commands/Probe.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); throw new Error("ordinary application bootstrap"); export default {};\n`);
  const result = await testCommand(args, { root }); result.assertExitCode(1);
  expect(await Bun.file(marker).exists()).toBe(true);
});

test("outer installer selection and argv are snapshotted before asynchronous bootstrap", async () => {
  const { root, env } = await fixture(); const args = ["new", "snapshot-app"];
  let output = "";
  const result = runCli(args, { root, env, output: text => { output += text; }, error: () => {}, handleSignals: false });
  args.splice(0, args.length, "not-an-installer");
  expect(await result).toBe(0); expect(JSON.parse(output).directory).toBe(join(root, "snapshot-app"));
});

test("generated actual entrypoint creates a child without importing its unrelated command modules", async () => {
  const { root, run } = await fixture(); const base = await run("new", "base-app");
  const marker = join(base.directory, "imported-marker");
  await mkdir(join(base.directory, "src/commands"));
  await writeFile(join(base.directory, "src/commands/Probe.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); throw new Error("must not import"); export default {};\n`);
  const created = JSON.parse(await child(base.directory, "new", "nested"));
  expect(created.directory).toBe(join(base.directory, "nested"));
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await Bun.file(join(created.directory, "src/commands/Probe.ts")).exists()).toBe(false);
}, 30000);

test("new checks pre-aborted signals before creating any destination", async () => {
  const { root, env } = await fixture();
  const signal = AbortSignal.abort();
  await expect(createCli({ root, env, signal, output: () => {} }).parseAsync(["new", "cancelled"], { from: "user" })).rejects.toThrow();
  expect(await Bun.file(join(root, "cancelled/package.json")).exists()).toBe(false);
});
