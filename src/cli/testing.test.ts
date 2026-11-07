import { afterEach, describe, expect, test } from "bun:test";
import { Command, CommanderError } from "commander";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "../database/config.ts";
import { registerTesting } from "./testing.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  await mkdir(join(projectRoot, ".data"), { recursive: true });
  const root = await mkdtemp(join(projectRoot, ".data", "test-wrapper-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const output: string[] = [];
  const errors: string[] = [];
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeOut: text => output.push(text), writeErr: text => errors.push(text) });
    registerTesting(program, { root, env: process.env, output: text => output.push(text), error: text => errors.push(text) });
    await program.parseAsync(["test", ...args], { from: "user" });
  };
  return { root, output, errors, run };
}

describe("native Bun test command", () => {
  test("runs selected files with name filtering and relays actual child output", async () => {
    const { root, output, errors, run } = await fixture();
    await writeFile(join(root, "selected.test.ts"), `import { test, expect } from "bun:test";
test("selected", () => { console.log("selected test ran"); expect(process.env.BUNDLE_TEST_SENTINEL).toBe("inherited"); });
test("not selected", () => { throw new Error("must not run"); });\n`);
    await writeFile(join(root, "other.test.ts"), `import { test } from "bun:test"; test("other", () => { throw new Error("wrong file"); });\n`);
    const previous = process.env.BUNDLE_TEST_SENTINEL;
    process.env.BUNDLE_TEST_SENTINEL = "inherited";
    try { await run("./selected.test.ts", "--filter", "^selected$"); }
    finally { if (previous === undefined) delete process.env.BUNDLE_TEST_SENTINEL; else process.env.BUNDLE_TEST_SENTINEL = previous; }
    expect(output.join("")).toContain("selected test ran");
    expect(errors.join("")).toContain("1 pass");
    expect(errors.join("")).toContain("0 fail");
  });

  test("preserves native failure exit status instead of reporting success", async () => {
    const { root, errors, run } = await fixture();
    await writeFile(join(root, "failure.test.ts"), `import { test } from "bun:test"; test("fails", () => { throw new Error("fixture failure"); });\n`);
    let failure: unknown;
    try { await run("./failure.test.ts"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CommanderError);
    expect((failure as CommanderError).exitCode).toBe(1);
    expect(errors.join("")).toContain("fixture failure");
  });

  test("runs native worker processes with isolated globals", async () => {
    const { root, run } = await fixture();
    const log = join(root, "workers.jsonl");
    await writeFile(log, "");
    for (const name of ["first", "second"]) {
      await writeFile(join(root, `${name}.test.ts`), `import { test, expect } from "bun:test";
import { appendFileSync, readFileSync, watch } from "node:fs";
test(${JSON.stringify(name)}, async () => {
  expect((globalThis as any).bundleMarker).toBeUndefined();
  (globalThis as any).bundleMarker = true;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, name: ${JSON.stringify(name)} }) + "\\n");
  // Neither file may complete until both are running, proving worker concurrency.
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(${JSON.stringify(log)}, check);
    const timer = setTimeout(() => { watcher.close(); reject(new Error("Workers did not overlap")); }, 3000);
    function check() {
      if (readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length === 2) {
        clearTimeout(timer); watcher.close(); resolve();
      }
    }
    check();
  });
});\n`);
    }
    await run("--parallel", "--processes", "2");
    const rows = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.name).sort()).toEqual(["first", "second"]);
    expect(rows.every(row => row.pid !== process.pid)).toBe(true);
    expect(new Set(rows.map(row => row.pid)).size).toBe(2);
  });

  test("emits native coverage for actual test execution", async () => {
    const { root, output, errors, run } = await fixture();
    await writeFile(join(root, "value.ts"), "export const add = (left: number, right: number) => left + right;\n");
    await writeFile(join(root, "coverage.test.ts"), `import { test, expect } from "bun:test"; import { add } from "./value.ts"; test("adds", () => expect(add(1, 2)).toBe(3));\n`);
    await run("--coverage");
    expect(output.join("") + errors.join("")).toContain("value.ts");
    expect(output.join("") + errors.join("")).toContain("100.00");
  });

  test("rejects worker controls without parallel mode and option-like file patterns", async () => {
    const { run } = await fixture();
    await expect(run("--processes", "0")).rejects.toThrow();
    await expect(run("--processes", "2")).rejects.toThrow("--parallel");
    await expect(run("--", "--preload=untrusted.ts")).rejects.toThrow("file");
  });
});
