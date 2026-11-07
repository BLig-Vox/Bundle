import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, readdir, readlink, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

type ScheduleLockRecord = { version: 1; key: string; pid: number; pidNamespace: string; start: string; token: string };
type ProcessIdentity = { state: string; start: string };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ESRCH";
const owned = (info: Stats) => typeof process.getuid !== "function" || info.uid === process.getuid();
const lockName = (key: string) => `${createHash("sha256").update(key).digest("hex")}.lock`;
const mutationName = ".schedule-mutation.lock";

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^[0-9]+$/.test(fields[19] ?? "")) throw new Error("Invalid process identity.");
    return { state: fields[0]!, start: fields[19]! };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function processMayExist(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function processNamespace(pid: number): Promise<string> {
  try {
    const value = await readlink(`/proc/${pid}/ns/pid`);
    if (!/^pid:\[\d+\]$/.test(value)) throw new Error("Invalid PID namespace identity.");
    return value;
  } catch { throw new Error("Unable to verify PID namespace; scheduler lock is preserved."); }
}

async function lockDirectory(root: string, create: boolean): Promise<{ path: string; info: Stats } | undefined> {
  if (typeof root !== "string" || !root || !isAbsolute(root) || root.includes("\0")) throw new Error("Invalid scheduler root.");
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new Error("Unsafe scheduler root.");
  const path = join(canonical, ".bundle-command-locks");
  if (create) try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  let info: Stats;
  try { info = await lstat(path); }
  catch (error) { if (!create && missing(error)) return undefined; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info) || (info.mode & 0o7777) !== 0o700) throw new Error("Unsafe scheduler lock directory.");
  return { path, info };
}

async function readHandle(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const buffer = Buffer.alloc(4097);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  if (bytesRead > 4096) throw new Error("Scheduler lock record too large.");
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
}

function parseRecord(text: string): ScheduleLockRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid scheduler lock record; inspect and preserve it."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scheduler lock record; inspect and preserve it.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "key,pid,pidNamespace,start,token,version" || record.version !== 1 ||
      typeof record.key !== "string" || !/^schedule:[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(record.key) ||
      !Number.isSafeInteger(record.pid) || Number(record.pid) < 1 || typeof record.pidNamespace !== "string" || !/^pid:\[\d+\]$/.test(record.pidNamespace) ||
      typeof record.start !== "string" || !/^\d+$/.test(record.start) ||
      typeof record.token !== "string" || !/^[0-9a-f]{64}$/.test(record.token) || JSON.stringify(record) + "\n" !== text) {
    throw new Error("Invalid scheduler lock record; inspect and preserve it.");
  }
  return record as ScheduleLockRecord;
}

async function readLockFile(path: string): Promise<{ text: string; info: Stats } | undefined> {
  let info: Stats;
  try { info = await lstat(path); } catch (error) { if (missing(error)) return undefined; throw error; }
  if (info.nlink === 0) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owned(info) || (info.mode & 0o7777) !== 0o600 || info.size > 4096) throw new Error("Unsafe scheduler lock artifact; inspect and preserve it.");
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const actual = await handle.stat();
    if (actual.dev !== info.dev || actual.ino !== info.ino || !actual.isFile() || !owned(actual) || (actual.mode & 0o7777) !== 0o600) throw new Error("Scheduler lock artifact changed; inspect and preserve it.");
    if (actual.nlink === 0) return undefined;
    if (actual.nlink !== 1) throw new Error("Unsafe scheduler lock artifact; inspect and preserve it.");
    return { text: await readHandle(handle), info: actual };
  } finally { await handle.close(); }
}


async function mutationGate(directory: { path: string; info: Stats }, wait: boolean): Promise<(() => Promise<void>) | undefined> {
  const path = join(directory.path, mutationName);
  const token = randomBytes(32).toString("hex");
  const attempts = wait ? 50 : 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let info: Stats;
      try { info = await lstat(path); } catch (inspectionError) {
        if (!missing(inspectionError)) throw inspectionError;
        if (attempt + 1 < attempts) continue;
        return undefined;
      }
      if (info.nlink === 0) { if (attempt + 1 < attempts) continue; return undefined; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owned(info) || (info.mode & 0o7777) !== 0o600) throw new Error("Unsafe scheduler mutation lock; inspect and preserve it.");
      if (attempt + 1 < attempts) { await Bun.sleep(10); continue; }
      return undefined;
    }
    const own = await handle.stat();
    try { await handle.writeFile(token); await handle.sync(); }
    catch (error) {
      await handle.close();
      const current = await lstat(path).catch(() => undefined);
      if (current?.dev === own.dev && current.ino === own.ino) await unlink(path);
      throw error;
    }
    return async () => {
      try {
        const currentDirectory = await lstat(directory.path);
        const current = await lstat(path);
        if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.dev !== directory.info.dev || currentDirectory.ino !== directory.info.ino ||
            !current.isFile() || current.isSymbolicLink() || current.dev !== own.dev || current.ino !== own.ino || !owned(current) || (current.mode & 0o7777) !== 0o600) {
          throw new Error("Scheduler mutation lock changed; inspect and preserve it.");
        }
        if (current.nlink === 0) return;
        if (current.nlink !== 1 || await readHandle(handle) !== token) throw new Error("Scheduler mutation lock changed; inspect and preserve it.");
        await unlink(path);
      } finally { await handle.close(); }
    };
  }
  return undefined;
}

/** Acquires an owned overlap lock for one configured scheduler task. */
export async function acquireScheduleLock(root: string, id: string): Promise<null | (() => Promise<void>)> {
  if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new Error("Invalid scheduled task id.");
  const directory = (await lockDirectory(root, true))!;
  const gate = await mutationGate(directory, true);
  if (!gate) throw new Error("Scheduler lock administration is busy; retry later.");
  const key = `schedule:${id}`;
  const path = join(directory.path, lockName(key));
  const token = randomBytes(32).toString("hex");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let own: Stats | undefined;
  try {
    const identity = await processIdentity(process.pid);
    if (process.platform === "linux" && !identity) throw new Error("Unable to verify scheduler process identity.");
    const namespace = process.platform === "linux" ? await processNamespace(process.pid) : "pid:[0]";
    try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let info: Stats;
      try { info = await lstat(path); } catch (inspectionError) { if (missing(inspectionError)) return null; throw inspectionError; }
      if (info.nlink === 0) return null;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owned(info) || (info.mode & 0o7777) !== 0o600) throw new Error("Unsafe scheduler lock artifact.");
      return null;
    }
    own = await handle.stat();
    const record: ScheduleLockRecord = { version: 1, key, pid: process.pid, pidNamespace: namespace, start: identity?.start ?? "0", token };
    await handle.writeFile(JSON.stringify(record) + "\n");
    await handle.sync();
    const ownerHandle = handle;
    return async () => {
      try {
        const currentDirectory = await lstat(directory.path);
        const current = await lstat(path);
        if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.dev !== directory.info.dev || currentDirectory.ino !== directory.info.ino ||
            !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== own!.dev || current.ino !== own!.ino || !owned(current) || (current.mode & 0o7777) !== 0o600) {
          throw new Error("Schedule lock owner artifact was replaced; refusing release.");
        }
        if (parseRecord(await readHandle(ownerHandle)).token !== token) throw new Error("Schedule lock owner token changed; refusing release.");
        await unlink(path);
      } finally { await ownerHandle.close(); }
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (own) {
      const current = await lstat(path).catch(() => undefined);
      if (current?.dev === own.dev && current.ino === own.ino) await unlink(path).catch(() => {});
    }
    throw error;
  } finally { await gate(); }
}

/** Removes only process-identity-verified stale scheduler locks; unknown state is preserved. */
export async function clearStaleScheduleLocks(root: string): Promise<{ cleared: number; active: number }> {
  if (process.platform !== "linux") throw new Error("Stale scheduler lock clearing requires Linux process identities.");
  const directory = await lockDirectory(root, false);
  if (!directory) return { cleared: 0, active: 0 };
  const gate = await mutationGate(directory, false);
  if (!gate) throw new Error("Scheduler lock state is busy; retry after active lock administration finishes.");
  try {
    const namespace = await processNamespace(process.pid);
    const names = await readdir(directory.path);
    const stale: Array<{ path: string; info: Stats }> = [];
    let active = 0;
    for (const name of names) {
      if (name === mutationName || !name.endsWith(".lock")) continue;
      if (!/^[0-9a-f]{64}\.lock$/.test(name)) throw new Error("Unknown scheduler lock entry; inspect and preserve it.");
      const path = join(directory.path, name);
      const lock = await readLockFile(path);
      if (!lock) continue;
      const { text, info } = lock;
      // The shared registry also contains generic command locks. Their legacy
      // token-only records (including older scheduler locks) cannot be safely
      // attributed here, so leave them untouched and continue scanning.
      if (/^[0-9a-f]{64}$/.test(text)) continue;
      const record = parseRecord(text);
      if (name !== lockName(record.key)) throw new Error("Scheduler lock identity mismatch; inspect and preserve it.");
      if (record.pidNamespace !== namespace) throw new Error("Scheduler lock belongs to a different PID namespace; preserving it.");
      const current = await processIdentity(record.pid);
      if (current) {
        if (current.state !== "Z" && current.start === record.start) { active++; continue; }
        stale.push({ path, info });
        continue;
      }
      // procfs may hide a live process as ENOENT (for example hidepid=2).
      // Signal 0 distinguishes a gone PID from an inaccessible live owner;
      // inability to verify must preserve the lock rather than enable overlap.
      if (processMayExist(record.pid)) throw new Error("Unable to verify scheduler lock owner; preserving it.");
      stale.push({ path, info });
    }
    let cleared = 0;
    for (const entry of stale) {
      let current: Stats | undefined;
      try { current = await lstat(entry.path); } catch (error) { if (!missing(error)) throw error; }
      if (!current || current.nlink === 0) continue;
      if (current.dev !== entry.info.dev || current.ino !== entry.info.ino || current.nlink !== 1 || current.isSymbolicLink()) throw new Error("Scheduler lock changed during cleanup; inspect and preserve it.");
      await unlink(entry.path);
      cleared++;
    }
    return { cleared, active };
  } finally { await gate(); }
}
