import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerQueueBatches } from "./queue-batches.ts";
import { openLocalQueue } from "../queue/opening.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(options: { signal?: AbortSignal; output?: (text: string) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bundle-batch-cli-")); roots.push(root);
  const output: string[] = [];
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeErr() {} }).option("--force");
    registerQueueBatches(program, { root, signal: options.signal, output: options.output ?? (text => output.push(text)) });
    await program.parseAsync(args, { from: "user" });
    return JSON.parse(output.at(-1)!);
  };
  return { root, output, run };
}

test("invalid batch ids, cutoffs and missing force refuse before storage", async () => {
  const { root, run } = await fixture();
  for (const args of [
    ["queue:batch", "bad"], ["queue:cancel-batch", "../outside"], ["queue:retry-batch", "A".repeat(32)],
    ["queue:batch", "a".repeat(31)], ["queue:batch", "a".repeat(33)], ["queue:prune-batches"],
    ["queue:prune-batches", "--before", "0"], ["--force", "queue:prune-batches", "--before", "-1"],
    ["--force", "queue:prune-batches", "--before", "1e3"], ["--force", "queue:prune-batches", "--before", "01"],
    ["--force", "queue:prune-batches", "--before", "8640000000000001"], ["queue:upgrade"],
  ]) {
    await expect(run(...args)).rejects.toThrow();
    await expect(lstat(join(root, ".bundle-queue"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("pre-aborted batch operations never create queue storage", async () => {
  const controller = new AbortController(); controller.abort();
  const { root, output, run } = await fixture({ signal: controller.signal });
  for (const args of [["queue:batch", "a".repeat(32)], ["queue:cancel-batch", "a".repeat(32)], ["queue:retry-batch", "a".repeat(32)], ["--force", "queue:upgrade"], ["--force", "queue:prune-batches", "--before", "0"]]) {
    await expect(run(...args)).rejects.toThrow("cancelled");
    await expect(lstat(join(root, ".bundle-queue"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(output).toEqual([]);
});

test("batch CLI sanitizes unsafe databases and preserves foreign state even with force", async () => {
  const { root, output, run } = await fixture();
  await mkdir(join(root, ".bundle-queue"), { mode: 0o700 });
  const path = join(root, ".bundle-queue", "queue.sqlite");
  const foreign = new Database(path);
  foreign.exec("CREATE TABLE PRIVATE_FOREIGN_STATE (secret TEXT); INSERT INTO PRIVATE_FOREIGN_STATE VALUES ('PRIVATE_CONTENT')");
  foreign.close(); await chmod(path, 0o600);
  for (const args of [["queue:batch", "a".repeat(32)], ["--force", "queue:upgrade"]]) {
    try { await run(...args); throw new Error("Expected refusal"); }
    catch (error) {
      expect((error as Error).message).toContain("Local queue batch operation failed");
      expect((error as Error).message).not.toContain("PRIVATE");
    }
  }
  const check = new Database(path, { readonly: true });
  try { expect(check.query("SELECT secret FROM PRIVATE_FOREIGN_STATE").get()).toEqual({ secret: "PRIVATE_CONTENT" }); }
  finally { check.close(); }
  expect(output).toEqual([]);
});

test("batch CLI reads and mutates real lifecycle metadata without leaking descriptors", async () => {
  const { root, output, run } = await fixture();
  const store = await openLocalQueue(root);
  let id: string;
  try {
    const batch = store.enqueueBatch([
      { job: { module: "jobs/Private.ts", export: "Private", payload: "PRIVATE_PAYLOAD" }, maxAttempts: 1 },
      { job: { kind: "command", version: 1, argv: ["private:command", "PRIVATE_ARGV"] } },
    ]);
    id = batch.id;
    const receipt = store.reserve(["default"])!.receipt;
    expect(store.fail(receipt, "PRIVATE_REASON")).toBe(true);
  } finally { store.close(); }
  expect(await run("queue:batch", id!)).toMatchObject({ id: id!, total: 2, pending: 1, failed: 1 });
  expect(await run("queue:retry-batch", id!)).toEqual({ id: id!, retried: 1 });
  expect(await run("queue:cancel-batch", id!)).toMatchObject({ pending: 0, failed: 0, cancelled: 2 });
  await expect(run("queue:retry-batch", id!)).rejects.toThrow();
  expect(await run("--force", "queue:prune-batches", "--before", "8640000000000000")).toEqual({ before: 8640000000000000, removed: 1 });
  await expect(run("queue:batch", id!)).rejects.toThrow();
  for (const line of output) expect(line).not.toContain("PRIVATE");
});
