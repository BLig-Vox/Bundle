import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../logging/logger.ts";
import { registerLogging } from "./logging.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-pail-"));
  roots.push(root);
  const output: string[] = [];
  const warnings: string[] = [];
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride().allowExcessArguments(false).configureOutput({ writeErr: () => {} });
    registerLogging(program, { root, env: {}, output: text => output.push(text), error: text => warnings.push(text) });
    await program.parseAsync(["pail", ...args], { from: "user" });
    return output.at(-1)!;
  };
  return { root, output, warnings, run, logger: new Logger({ root, env: {} }) };
}

test("pail selects real local structured logs and escapes terminal controls", async () => {
  const { run, logger } = await fixture();
  await logger.log("info", "ignored");
  await logger.log("error", "selected \u001b[31mmessage");
  const result = JSON.parse(await run("--json", "--level", "error", "--filter", "selected"));
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].level).toBe("error");
  const rendered = await run("--level", "error");
  expect(rendered).toContain("selected");
  expect(rendered).not.toContain("\u001b");
});

test("pail follows with a bounded timeout and leaves no signal listeners behind", async () => {
  const { run, logger, output, warnings } = await fixture();
  await logger.log("info", "existing record");
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  await run("--follow", "--timeout", "30", "--json");
  expect(output.some(line => line.includes("existing record"))).toBe(true);
  expect(warnings.join(" ")).toContain("undetectable");
  expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
});

test("pail reports rotation gaps separately from JSON records", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-pail-"));
  roots.push(root);
  const logger = new Logger({ root });
  await logger.log("info", "initial");
  const output: string[] = [];
  const warnings: string[] = [];
  const program = new Command().exitOverride();
  registerLogging(program, { root, env: {}, output: text => output.push(text), error: (text: string) => warnings.push(text) } as Parameters<typeof registerLogging>[1]);
  let finished = false;
  const run = program.parseAsync(["pail", "--follow", "--timeout", "1000", "--json"], { from: "user" }).finally(() => { finished = true; });
  try {
    while (!output.length && !finished) await Bun.sleep(5);
    expect(output.length).toBeGreaterThan(0);
    await rename(join(root, "storage", "logs", "bundle.jsonl"), join(root, "storage", "logs", "old.jsonl"));
    await logger.log("info", "replacement");
    await run;
    expect(output.map(line => JSON.parse(line).message)).toContain("replacement");
    expect(warnings.join(" ")).toContain("rotation");
  } finally { await run; }
});

test("pail refuses invalid controls without writing logs or starting a watcher", async () => {
  const { run } = await fixture();
  await expect(run("--lines", "0")).rejects.toThrow();
  await expect(run("--level", "unsupported")).rejects.toThrow();
  await expect(run("--timeout", "10")).rejects.toThrow("--follow");
  expect(JSON.parse(await run("--json"))).toEqual({ entries: [], truncated: false });
});
