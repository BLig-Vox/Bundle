import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface MaintenanceOptions { retrySeconds?: number; refreshSeconds?: number }
export interface MaintenanceState extends MaintenanceOptions { version: 1 }
const limit = 4096;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

function optionsValid(value: unknown): value is MaintenanceOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const o = value as Record<string, unknown>;
  return Reflect.ownKeys(o).every(key => key === "retrySeconds" || key === "refreshSeconds")
    && (o.retrySeconds === undefined || (Number.isInteger(o.retrySeconds) && (o.retrySeconds as number) >= 0 && (o.retrySeconds as number) <= 86400))
    && (o.refreshSeconds === undefined || (Number.isInteger(o.refreshSeconds) && (o.refreshSeconds as number) >= 1 && (o.refreshSeconds as number) <= 86400));
}

async function directory(root: string, create: boolean): Promise<string | undefined> {
  if (typeof root !== "string" || !root || root.includes("\0")) throw new Error("Invalid project root.");
  // Resolve caller aliases once, consistently with route/configuration roots;
  // symlinks beneath that canonical root remain forbidden.
  let current = await realpath(root);
  if (!(await lstat(current)).isDirectory()) throw new Error("Unsafe project root.");
  for (const part of ["storage", "framework"]) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe maintenance directory.");
    } catch (error) { if (missing(error) && !create) return undefined; throw error; }
  }
  return current;
}

async function stateAt(path: string): Promise<{ state: MaintenanceState; info: Stats } | undefined> {
  let info: Stats;
  try { info = await lstat(path); } catch (error) { if (missing(error)) return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit || (info.mode & 0o7777) !== 0o600) throw new Error("Unsafe maintenance state.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== info.dev || actual.ino !== info.ino || actual.size > limit || (actual.mode & 0o7777) !== 0o600) throw new Error("Maintenance state changed.");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("Maintenance state too large.");
    let value: unknown, text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)); value = JSON.parse(text); } catch { throw new Error("Invalid maintenance state."); }
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).version !== 1) throw new Error("Invalid maintenance state.");
    const { version: _version, ...options } = value as Record<string, unknown>;
    if (!optionsValid(options)) throw new Error("Invalid maintenance state.");
    // Valid state values are all numbers, so every JSON string token is a member name.
    const names = new Set<string>();
    for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      const name = JSON.parse(match[0]) as string;
      if (names.has(name)) throw new Error("Duplicate maintenance state key.");
      names.add(name);
    }
    return { state: value as MaintenanceState, info: actual };
  } finally { await handle.close(); }
}

async function unchanged(path: string, previous: { info: Stats } | undefined): Promise<void> {
  let current: Stats | undefined;
  try { current = await lstat(path); } catch (error) { if (!missing(error)) throw error; }
  if (!previous ? current !== undefined : !current || current.dev !== previous.info.dev || current.ino !== previous.info.ino || current.size !== previous.info.size || current.mtimeMs !== previous.info.mtimeMs || current.ctimeMs !== previous.info.ctimeMs || current.nlink !== 1) throw new Error("Maintenance state changed.");
}

async function locked<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const path = join(dir, ".down.lock");
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const own = await handle.stat();
  try { return await action(); } finally {
    await handle.close();
    try { const current = await lstat(path); if (current.dev === own.dev && current.ino === own.ino) await unlink(path); } catch (error) { if (!missing(error)) throw error; }
  }
}

export async function readMaintenance(root: string): Promise<MaintenanceState | undefined> {
  const dir = await directory(root, false);
  return dir ? (await stateAt(join(dir, "down.json")))?.state : undefined;
}

export async function enableMaintenance(root: string, options: MaintenanceOptions = {}): Promise<void> {
  if (!optionsValid(options)) throw new Error("Invalid maintenance options.");
  const dir = (await directory(root, true))!;
  await locked(dir, async () => {
    const path = join(dir, "down.json"), old = await stateAt(path);
    const temporary = join(dir, `.down-${randomBytes(16).toString("hex")}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const own = await handle.stat();
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify({ version: 1, ...options }) + "\n");
      await handle.sync();
      await handle.close();
      await unchanged(path, old);
      if (old) await rename(temporary, path);
      else { await link(temporary, path); await unlink(temporary); }
    } finally {
      await handle.close().catch(() => {});
      try { const current = await lstat(temporary); if (current.dev === own.dev && current.ino === own.ino) await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
    }
  });
}

export async function disableMaintenance(root: string): Promise<boolean> {
  const dir = await directory(root, false);
  if (!dir) return false;
  return locked(dir, async () => {
    const path = join(dir, "down.json"), old = await stateAt(path);
    if (!old) return false;
    await unchanged(path, old);
    await unlink(path);
    return true;
  });
}

export async function maintenanceResponse(root: string, _request: Request): Promise<Response | undefined> {
  const state = await readMaintenance(root);
  if (!state) return undefined;
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (state.retrySeconds !== undefined) headers.set("Retry-After", String(state.retrySeconds));
  if (state.refreshSeconds !== undefined) headers.set("Refresh", String(state.refreshSeconds));
  return new Response(JSON.stringify({ error: "Service Unavailable" }), { status: 503, headers });
}
