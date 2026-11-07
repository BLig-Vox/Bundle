import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireScheduleLock, clearStaleScheduleLocks } from "./locks.ts";
import { acquireCommandLock } from "../console/isolation.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "bundle-schedule-locks-")); roots.push(root); return root; }
function lockPath(root: string, key: string) { return join(root, ".bundle-command-locks", `${createHash("sha256").update(key).digest("hex")}.lock`); }
function currentStart() { return readFile(`/proc/${process.pid}/stat`, "utf8").then(text => text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/)[19]!); }
function currentNamespace() { return readlink("/proc/self/ns/pid"); }

test.skipIf(process.platform !== "linux")("schedule lock inspection preserves live owners and removes only verified stale locks", async () => {
  const root = await fixture();
  const release = await acquireScheduleLock(root, "report");
  expect(release).not.toBeNull();
  try { expect(await clearStaleScheduleLocks(root)).toEqual({ cleared: 0, active: 1 }); }
  finally { await release!(); }

  const path = lockPath(root, "schedule:report");
  await mkdir(join(root, ".bundle-command-locks"), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ version: 1, key: "schedule:report", pid: process.pid, pidNamespace: await currentNamespace(), start: "0", token: randomBytes(32).toString("hex") }) + "\n", { mode: 0o600 });
  expect(await clearStaleScheduleLocks(root)).toEqual({ cleared: 1, active: 0 });
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(process.platform !== "linux")("lock cleanup refuses a different PID namespace instead of declaring the owner stale", async () => {
  const root = await fixture();
  await mkdir(join(root, ".bundle-command-locks"), { mode: 0o700 });
  const key = "schedule:foreign";
  const path = lockPath(root, key);
  await writeFile(path, JSON.stringify({ version: 1, key, pid: process.pid, pidNamespace: "pid:[0]", start: "0", token: randomBytes(32).toString("hex") }) + "\n", { mode: 0o600 });
  await expect(clearStaleScheduleLocks(root)).rejects.toThrow(/namespace/i);
  expect(await Bun.file(path).exists()).toBe(true);
});

test.skipIf(process.platform !== "linux")("legacy token-only locks are preserved for manual inspection", async () => {
  const root = await fixture();
  await mkdir(join(root, ".bundle-command-locks"), { mode: 0o700 });
  const path = lockPath(root, "schedule:legacy");
  const token = randomBytes(32).toString("hex");
  await writeFile(path, token, { mode: 0o600 });
  expect(await clearStaleScheduleLocks(root)).toEqual({ cleared: 0, active: 0 });
  expect(await readFile(path, "utf8")).toBe(token);
});

test.skipIf(process.platform !== "linux")("schedule lock clearing preserves malformed records without deleting them", async () => {
  const root = await fixture();
  await mkdir(join(root, ".bundle-command-locks"), { mode: 0o700 });
  const path = lockPath(root, "schedule:malformed");
  await writeFile(path, "not-a-lock-record", { mode: 0o600 });
  await expect(clearStaleScheduleLocks(root)).rejects.toThrow(/unsafe|invalid|inspect/i);
  expect(await readFile(path, "utf8")).toBe("not-a-lock-record");
});

test.skipIf(process.platform !== "linux")("schedule lock owner identity uses Linux process start time", async () => {
  const root = await fixture();
  const release = await acquireScheduleLock(root, "identity");
  try {
    const record = JSON.parse(await readFile(lockPath(root, "schedule:identity"), "utf8"));
    expect(record).toMatchObject({ version: 1, key: "schedule:identity", pid: process.pid, pidNamespace: await currentNamespace(), start: await currentStart() });
    expect(typeof record.token).toBe("string");
  } finally { await release?.(); }
});

test("contenders tolerate a scheduler owner releasing its lock during acquisition", async () => {
  const root = await fixture();
  for (let round = 0; round < 100; round++) {
    const owner = await acquireScheduleLock(root, "race");
    expect(owner).not.toBeNull();
    const contenders = Array.from({ length: 4 }, () => acquireScheduleLock(root, "race"));
    await owner!();
    const results = await Promise.all(contenders);
    await Promise.all(results.filter((release): release is () => Promise<void> => release !== null).map(release => release()));
  }
});

test("scheduler work fails visibly rather than misreporting overlap while the lock registry is busy", async () => {
  const root = await fixture();
  const directory = join(root, ".bundle-command-locks");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, ".schedule-mutation.lock"), randomBytes(32).toString("hex"), { mode: 0o600 });
  await expect(acquireScheduleLock(root, "report")).rejects.toThrow(/administration.*busy/i);
  expect(await readdir(directory)).toEqual([".schedule-mutation.lock"]);
});

test.skipIf(process.platform !== "linux")("stale scheduler cleanup preserves unrelated generic command locks", async () => {
  const root = await fixture();
  const release = await acquireCommandLock(root, "unrelated:command");
  expect(release).not.toBeNull();
  try {
    const key = "schedule:stale";
    const path = lockPath(root, key);
    await writeFile(path, JSON.stringify({ version: 1, key, pid: process.pid, pidNamespace: await currentNamespace(), start: "0", token: randomBytes(32).toString("hex") }) + "\n", { mode: 0o600 });
    expect(await clearStaleScheduleLocks(root)).toEqual({ cleared: 1, active: 0 });
    expect(await Bun.file(lockPath(root, "unrelated:command")).exists()).toBe(true);
  } finally { await release!(); }
});

test.skipIf(process.platform === "linux")("stale scheduler cleanup refuses unsupported non-Linux process identity", async () => {
  await expect(clearStaleScheduleLocks(await fixture())).rejects.toThrow(/linux/i);
});
