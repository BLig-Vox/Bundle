import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followLogs, Logger, readLogs } from "./logger.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-logging-"));
  roots.push(root);
  return root;
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for log follower.")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

describe("bounded structured local logging", () => {
  test("persists timestamped records and masks sensitive keys and known secrets", async () => {
    const root = await fixture();
    const logger = new Logger({ root, env: { API_TOKEN: "known-token-value" }, clock: () => Date.UTC(2026, 10, 7) });
    await logger.log("info", "service started with known-token-value", { healthy: true, nested: { password: "unknown-password" }, endpoints: ["postgres://u:pass@host/db"] });
    const result = await readLogs(root);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.timestamp).toBe("2026-11-07T00:00:00.000Z");
    expect(entry.level).toBe("info");
    expect(entry.context.healthy).toBe(true);
    expect(entry.context.nested).toEqual({ password: "[REDACTED]" });
    expect(entry.context.endpoints).toEqual(["[REDACTED]"]);
    expect(JSON.stringify(result)).not.toContain("known-token-value");
    expect(JSON.stringify(result)).not.toContain("unknown-password");
    const file = Bun.file(join(root, "storage", "logs", "bundle.jsonl"));
    expect((await file.stat()).mode & 0o777).toBe(0o600);
  });

  test("reading is side-effect-free and filters severity, message and recent count", async () => {
    const root = await fixture();
    expect(await readLogs(root)).toEqual({ entries: [], truncated: false });
    expect(await Bun.file(join(root, "storage")).exists()).toBe(false);
    const logger = new Logger({ root });
    await logger.log("debug", "before");
    await logger.log("error", "selected one");
    await logger.log("critical", "selected two");
    await logger.log("warning", "not selected");
    const result = await readLogs(root, { minimumLevel: "error", filter: "selected", limit: 1 });
    expect(result.entries.map(entry => entry.message)).toEqual(["selected two"]);
    await expect(readLogs(root, { filter: "[" })).rejects.toThrow("filter");
    await expect(readLogs(root, { limit: 0 })).rejects.toThrow();
  });

  test("follows newly appended records and terminates via an abort signal", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    await logger.log("info", "first");
    const controller = new AbortController();
    const warnings: string[] = [];
    const stream = followLogs(root, { signal: controller.signal, onWarning: message => warnings.push(message) });
    try {
      expect((await stream.next()).value?.message).toBe("first");
      const next = stream.next();
      await logger.log("warning", "second");
      expect((await next).value?.message).toBe("second");
      controller.abort();
      expect((await stream.next()).done).toBe(true);
      expect(warnings.join(" ")).toContain("undetectable");
    } finally { controller.abort(); await stream.return(undefined); }
  }, 5000);

  test("bounded reads report truncation rather than loading an unbounded file", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    for (let i = 0; i < 12; i++) await logger.log("info", `entry ${i} ${"x".repeat(8000)}`);
    const result = await readLogs(root, { maxBytes: 16000, limit: 50 });
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.at(-1)?.message).toStartWith("entry 11 ");
    expect(result.entries.length).toBeLessThan(12);
  });

  test("follow delivers every appended record even beyond the initial line limit", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    await logger.log("info", "initial");
    const controller = new AbortController();
    const warnings: string[] = [];
    const stream = followLogs(root, { signal: controller.signal, limit: 1, onWarning: message => warnings.push(message) });
    try {
      expect((await stream.next()).value?.message).toBe("initial");
      for (const message of ["one", "two", "three"]) await logger.log("info", message);
      expect((await stream.next()).value?.message).toBe("one");
      expect((await stream.next()).value?.message).toBe("two");
      expect((await stream.next()).value?.message).toBe("three");
      expect(warnings.join(" ")).toContain("undetectable");
    } finally { controller.abort(); await stream.return(undefined); }
  });

  test("follow warns on rotation and reads the replacement", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    await logger.log("info", "before");
    const controller = new AbortController();
    const warnings: string[] = [];
    const stream = followLogs(root, { signal: controller.signal, onWarning: (message: string) => warnings.push(message) } as Parameters<typeof followLogs>[1]);
    try {
      expect((await stream.next()).value?.message).toBe("before");
      await rename(join(root, "storage", "logs", "bundle.jsonl"), join(root, "storage", "logs", "old.jsonl"));
      await logger.log("info", "after");
      expect((await stream.next()).value?.message).toBe("after");
      expect(warnings.join(" ")).toContain("rotation");
    } finally { controller.abort(); await stream.return(undefined); }
  });

  test("follow detects a truncate and regrowth past the prior offset", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    await logger.log("info", "before");
    const controller = new AbortController();
    const warnings: string[] = [];
    const stream = followLogs(root, { signal: controller.signal, onWarning: message => warnings.push(message) });
    try {
      expect((await stream.next()).value?.message).toBe("before");
      const path = join(root, "storage", "logs", "bundle.jsonl");
      const record = JSON.stringify({ id: "new", timestamp: new Date().toISOString(), level: "info", message: "replacement".repeat(50), context: {} }) + "\n";
      await writeFile(path, record);
      expect((await stream.next()).value?.message).toBe("replacement".repeat(50));
      expect(warnings.join(" ")).toContain("truncation");
    } finally { controller.abort(); await stream.return(undefined); }
  });

  test("follow warns after truncation and resumes at the start", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    await logger.log("info", "before");
    const controller = new AbortController();
    const warnings: string[] = [];
    let observed!: () => void;
    const truncated = new Promise<void>(resolve => { observed = resolve; });
    const stream = followLogs(root, { signal: controller.signal, onWarning: message => {
      warnings.push(message);
      if (message.includes("truncation")) observed();
    } });
    try {
      expect((await stream.next()).value?.message).toBe("before");
      await writeFile(join(root, "storage", "logs", "bundle.jsonl"), "");
      const next = stream.next();
      await deadline(truncated);
      await logger.log("info", "after");
      expect((await deadline(next)).value?.message).toBe("after");
      expect(warnings.join(" ")).toContain("truncation");
    } finally { controller.abort(); await stream.return(undefined); }
  });

  test("follow rescans an open rotated file when its writes generate no watched-directory events", async () => {
    const root = await fixture();
    const outside = await fixture();
    const logger = new Logger({ root });
    await logger.log("info", "before");
    const controller = new AbortController();
    const warnings: string[] = [];
    const stream = followLogs(root, { signal: controller.signal, onWarning: message => warnings.push(message) });
    try {
      expect((await stream.next()).value?.message).toBe("before");
      const moved = join(outside, "moved.jsonl");
      await rename(join(root, "storage", "logs", "bundle.jsonl"), moved);
      const next = stream.next();
      // Let the rename event drain before appending through the other directory.
      await Bun.sleep(250);
      const record = JSON.stringify({ id: "moved", timestamp: new Date().toISOString(), level: "info", message: "after", context: {} });
      await appendFile(moved, record + "\n");
      expect((await deadline(next)).value?.message).toBe("after");
      expect(warnings.join(" ")).toContain("undetectable");
    } finally { controller.abort(); await stream.return(undefined); }
  });

  test("follow retries incomplete records without parsing their partial contents", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    await logger.log("info", "before");
    const controller = new AbortController();
    const warnings: string[] = [];
    const stream = followLogs(root, { signal: controller.signal, onWarning: message => warnings.push(message) });
    try {
      expect((await stream.next()).value?.message).toBe("before");
      const path = join(root, "storage", "logs", "bundle.jsonl");
      const entry = JSON.stringify({ id: "partial", timestamp: new Date().toISOString(), level: "info", message: "after", context: {} });
      await appendFile(path, entry.slice(0, 20));
      const next = stream.next();
      await new Promise(resolve => setTimeout(resolve, 30));
      await appendFile(path, entry.slice(20) + "\n");
      expect((await next).value?.message).toBe("after");
      expect(warnings.join(" ")).toContain("undetectable");
    } finally { controller.abort(); await stream.return(undefined); }
  });

  test("bounded read retains a record starting exactly at the byte boundary", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    for (const n of [1, 2, 3]) await logger.log("info", `${n}${"x".repeat(600)}`);
    const bytes = await readFile(join(root, "storage", "logs", "bundle.jsonl"));
    const result = await readLogs(root, { maxBytes: bytes.length - bytes.indexOf(10) - 1 });
    expect(result.entries.map(entry => entry.message[0])).toEqual(["2", "3"]);
  });

  test("rejects nonobject context before writing and leaves subsequent records readable", async () => {
    const root = await fixture();
    const logger = new Logger({ root });
    await expect(logger.log("info", "bad", "text" as unknown as Record<string, unknown>)).rejects.toThrow();
    await logger.log("info", "good");
    expect((await readLogs(root)).entries.map(entry => entry.message)).toEqual(["good"]);
  });

  test("rejects symlinked paths and invalid records without touching outside targets", async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(outside, join(root, "storage"));
    const logger = new Logger({ root });
    await expect(logger.log("info", "not written")).rejects.toThrow("symlink");
    await expect(readLogs(root)).rejects.toThrow("symlink");
    expect(await Bun.file(join(outside, "logs", "bundle.jsonl")).exists()).toBe(false);
    const valid = await fixture();
    await mkdir(join(valid, "storage", "logs"), { recursive: true });
    await writeFile(join(valid, "storage", "logs", "bundle.jsonl"), "not-json\n");
    await expect(readLogs(valid)).rejects.toThrow("record");
    const invalid = new Logger({ root: valid });
    await expect(invalid.log("unsupported" as "info", "invalid")).rejects.toThrow("level");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(invalid.log("info", "invalid context", cycle)).rejects.toThrow();
    expect(await readFile(join(valid, "storage", "logs", "bundle.jsonl"), "utf8")).toBe("not-json\n");
  });
});
