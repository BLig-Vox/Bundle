import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MikroORM } from "@mikro-orm/core";
import { databaseOptions, type DatabaseDriver, type Environment } from "../database/config.ts";

export interface IsolatedDatabaseTestOptions {
  root: string;
  files: readonly string[];
  processes?: number;
  filter?: string;
  coverage?: boolean;
  env?: Environment;
  signal?: AbortSignal;
  output?: (text: string) => void;
  error?: (text: string) => void;
}
const RUN_VARIABLE = "BUNDLE_TEST_DATABASE_RUN";
function snapshotEnvironment(value: unknown): Environment | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid test environment.");
  const result: Environment = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Invalid test environment.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== "string") || key.includes("=") || key.includes("\\0")) throw new TypeError("Invalid test environment.");
    result[key] = descriptor.value as string | undefined;
  }
  return Object.freeze(result);
}
async function identity(pid: number) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? "")) throw new Error("Invalid process identity.");
    if (!/^\d+$/.test(fields[2] ?? "")) throw new Error("Invalid process group identity.");
    return { state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), start: fields[19]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw error;
  }
}
async function processGroupMembers(group: number): Promise<number[]> {
  const members: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    const pid = Number(entry); const current = await identity(pid);
    if (current && current.group === group && current.state !== "Z") members.push(pid);
  }
  return members;
}
async function waitForProcessGroupExit(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await processGroupMembers(group)).length === 0) return true;
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  return (await processGroupMembers(group)).length === 0;
}
function signalProcessGroup(group: number, signal: NodeJS.Signals): void {
  try { process.kill(-group, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function signalOwnedProcessGroup(group: number, start: string | undefined, signal: NodeJS.Signals): Promise<boolean> {
  if (!start) return false;
  const leader = await identity(group);
  if (!leader || leader.state === "Z" || leader.group !== group || leader.parent !== process.pid || leader.start !== start) return false;
  signalProcessGroup(group, signal);
  return true;
}
async function observeProcessDescendants(rootPid: number, observed: Map<number, string>): Promise<void> {
  const current = new Map<number, NonNullable<Awaited<ReturnType<typeof identity>>>>();
  for (const entry of await readdir("/proc")) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    const pid = Number(entry); const value = await identity(pid);
    if (value && value.state !== "Z") current.set(pid, value);
  }
  const parents = new Set([rootPid, ...observed.keys()]); let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, value] of current) if (!parents.has(pid) && parents.has(value.parent)) {
      observed.set(pid, value.start); parents.add(pid); changed = true;
    }
  }
}

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error("Unsafe private test database directory.");
  return info;
}
async function privateJson(path: string): Promise<Record<string, unknown>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error("Unsafe test database metadata.");
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > 4096) throw new Error("Oversized test database metadata.");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid test database metadata.");
    return value as Record<string, unknown>;
  } finally { await handle.close(); }
}
async function exclusive(path: string, text: string) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); } finally { await handle.close(); }
}
async function migrationDirectory(root: string) {
  let path = root;
  for (const part of ["database", "migrations", "sqlite"]) {
    path = join(path, part); const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("SQLite test migrations require existing unlinked directories.");
  }
  for (const name of await readdir(path)) {
    const entry = await lstat(join(path, name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("SQLite test migrations must be regular single-link source files.");
  }
  return path;
}

/** Internal fixed-preload preparation; returns child environment without patching the host. */
export async function reserveDatabaseTestWorker(run: string) {
  if (process.platform !== "linux" || !isAbsolute(run) || run.includes("\0")) throw new Error("Isolated SQLite tests require Linux process identities.");
  await privateDirectory(run);
  const manifest = await privateJson(join(run, "manifest.json"));
  if (manifest.version !== 1 || typeof manifest.root !== "string" || !isAbsolute(manifest.root) || typeof manifest.token !== "string" || !/^[0-9a-f-]{36}$/.test(manifest.token) || Object.keys(manifest).sort().join() !== "root,token,version") throw new Error("Invalid test database manifest.");
  const root = await realpath(manifest.root);
  const migrations = await migrationDirectory(root);
  const current = await identity(process.pid);
  if (!current) throw new Error("Missing worker identity.");
  // Publish identity before allocating its DB directory so every crash window is observable.
  await exclusive(join(run, `worker-${process.pid}.json`), JSON.stringify({ version: 1, pid: process.pid, parent: current.parent, start: current.start, token: manifest.token }));
  const directory = join(run, `db-${process.pid}`);
  await mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
  const database = join(directory, "database.sqlite");
  await exclusive(database, "");
  const environment: Environment = Object.freeze({ APP_ENV: "test", NODE_ENV: "test", DB_CONNECTION: "sqlite", DB_DATABASE: database, DATABASE_URL: "", DB_HOST: "", DB_PORT: "", DB_USERNAME: "", DB_PASSWORD: "", BUNDLE_CONNECTIONS: "{}" });
  let initialization: Promise<void> | undefined;
  return Object.freeze({ environment, initialize: () => initialization ??= (async () => {
    const options = databaseOptions(environment, root);
    options.migrations = { ...options.migrations, path: migrations, pathTs: migrations, snapshot: false, snapshotOnMigrate: false };
    const orm = await MikroORM.init<DatabaseDriver>(options);
    try { await orm.connect(); await orm.migrator.up(); }
    finally { await orm.close(true); }
  })() });
}

async function forward(stream: ReadableStream<Uint8Array>, write: (text: string) => void, signal: AbortSignal) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    for (;;) { const { value, done } = await reader.read(); if (done) break; const text = decoder.decode(value, { stream: true }); if (text) write(text); }
    const remainder = decoder.decode(); if (remainder) write(remainder);
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Explicit SQLite-only native test setup; never opens/resets the selected application database. */
export async function runIsolatedDatabaseTests(options: IsolatedDatabaseTestOptions): Promise<number> {
  if (!options || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError("Invalid isolated test options.");
  const allowed = new Set(["root", "files", "processes", "filter", "coverage", "env", "signal", "output", "error"]);
  for (const key of Reflect.ownKeys(options)) if (typeof key !== "string" || !allowed.has(key) || !("value" in Object.getOwnPropertyDescriptor(options, key)!)) throw new TypeError("Invalid isolated test options.");
  const { root, signal, output = text => { process.stdout.write(text); }, error = text => { process.stderr.write(text); }, filter, coverage } = options;
  const processes = options.processes ?? 2;
  if (process.platform !== "linux" || typeof process.getuid !== "function") throw new Error("Isolated SQLite tests require Linux process identities.");
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) throw new TypeError("An absolute test root is required.");
  if (!Array.isArray(options.files) || options.files.length > 128 || options.files.some(file => typeof file !== "string" || file.startsWith("-") || file.includes("\0") || Buffer.byteLength(file) > 4096)) throw new TypeError("Invalid test files.");
  const files = [...options.files];
  if (!Number.isSafeInteger(processes) || processes < 1 || processes > 16) throw new TypeError("Isolated test processes must be1–16.");
  if (filter !== undefined && (typeof filter !== "string" || Buffer.byteLength(filter) > 8192)) throw new TypeError("Invalid test filter.");
  if (coverage !== undefined && typeof coverage !== "boolean") throw new TypeError("Invalid test coverage choice.");
  if (typeof output !== "function" || typeof error !== "function" || (signal !== undefined && !(signal instanceof AbortSignal))) throw new TypeError("Invalid test I/O or signal.");
  const env = { ...(snapshotEnvironment(options.env) ?? process.env) };
  if ((env.DB_CONNECTION ?? "sqlite") !== "sqlite" || env.DATABASE_URL) throw new Error("Isolated test databases currently support SQLite only.");
  const check = () => { if (signal?.aborted) throw new Error("Test database run cancelled."); };
  check(); const canonical = await realpath(root); await migrationDirectory(canonical); check();
  const parent = join(canonical, ".bundle-test-databases");
  try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await privateDirectory(parent);
  const run = await mkdtemp(join(parent, "run-")); const owned = await privateDirectory(run); const token = randomUUID();
  let child: ReturnType<typeof Bun.spawn<"inherit", "pipe", "pipe">> | undefined;
  let childGroupStart: string | undefined;
  let monitorDescendants = false;
  const observedDescendants = new Map<number, string>();
  let descendantTrackingFailure: unknown;
  let descendantWatcher: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const stop = () => stopPromise ??= (async () => {
    if (!child) return;
    const group = child.pid;
    if (child.exitCode === null) {
      if (!(await signalOwnedProcessGroup(group, childGroupStart, "SIGTERM"))) { try { child.kill("SIGTERM"); } catch { /* The direct owned child is already exiting. */ } }
      const timer = setTimeout(() => {
        if (child?.exitCode !== null) return;
        void (async () => {
          if (!(await signalOwnedProcessGroup(group, childGroupStart, "SIGKILL"))) { try { child?.kill("SIGKILL"); } catch { /* The direct owned child is already exiting. */ } }
        })().catch(() => {});
      }, 1000);
      try { await child.exited; } finally { clearTimeout(timer); }
    }
    if (!(await waitForProcessGroupExit(group, 1000))) throw new Error("Owned test process group did not quiesce; fixture preserved.");
  })();
  const abort = () => { void stop(); };
  const io = new AbortController(); let failure: unknown; let status = 1;
  let forwarding: Promise<unknown> = Promise.resolve();
  try {
    await exclusive(join(run, "manifest.json"), JSON.stringify({ version: 1, root: canonical, token })); check();
    const args = [process.execPath, "test", "--preload", fileURLToPath(new URL("./database-preload.ts", import.meta.url)), `--parallel=${processes}`, "--parallel-delay=0"];
    if (filter !== undefined) args.push("--test-name-pattern", filter);
    if (coverage) args.push("--coverage"); args.push(...files);
    child = Bun.spawn(args, { cwd: canonical, env: { ...env, APP_ENV: "test", NODE_ENV: "test", [RUN_VARIABLE]: run }, stdin: "inherit", stdout: "pipe", stderr: "pipe", detached: true });
    const leader = await identity(child.pid);
    if (leader && leader.group === child.pid && leader.parent === process.pid && leader.state !== "Z") childGroupStart = leader.start;
    monitorDescendants = true;
    descendantWatcher = (async () => {
      while (monitorDescendants) {
        try { await observeProcessDescendants(child!.pid, observedDescendants); }
        catch (error) { descendantTrackingFailure ??= error; return; }
        await Bun.sleep(10);
      }
    })();
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    forwarding = Promise.all([forward(child.stdout, output, io.signal), forward(child.stderr, error, io.signal)]).catch(async () => { failure ??= new Error("Native test output failed."); await stop(); });
    status = await child.exited;
    const timer = setTimeout(() => io.abort(), 250);
    try { await forwarding; } finally { clearTimeout(timer); }
  } catch (error) { failure ??= error; }
  finally {
    await stop(); io.abort(); await forwarding;
    monitorDescendants = false; await descendantWatcher;
    try {
      const current = await privateDirectory(run);
      if (current.dev !== owned.dev || current.ino !== owned.ino) throw new Error("Test fixture identity changed.");
      const manifest = await privateJson(join(run, "manifest.json")); if (manifest.token !== token || manifest.root !== canonical) throw new Error("Test fixture ownership changed.");
      const names = await readdir(run);
      const records = new Map<number, Record<string, unknown>>();
      const databases = new Set<number>();
      for (const name of names) {
        if (name === "manifest.json") continue;
        if (/^db-[1-9]\d*$/.test(name)) {
          const pid = Number(name.slice(3));
          if (databases.has(pid)) throw new Error("Duplicate test worker database.");
          databases.add(pid);
          const directory = join(run, name); await privateDirectory(directory);
          for (const file of await readdir(directory)) {
            if (!new Set(["database.sqlite", "database.sqlite-journal", "database.sqlite-wal", "database.sqlite-shm"]).has(file)) throw new Error("Unknown worker database state.");
            const info = await lstat(join(directory, file));
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid!()) throw new Error("Unsafe worker database file.");
          }
          continue;
        }
        if (!/^worker-[1-9]\d*\.json$/.test(name)) throw new Error("Unknown test fixture state.");
        const record = await privateJson(join(run, name));
        if (record.version !== 1 || record.token !== token || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1 || (record.pid !== child?.pid && record.parent !== child?.pid) || typeof record.start !== "string" || !/^\d+$/.test(record.start) || name !== `worker-${record.pid}.json` || records.has(Number(record.pid))) throw new Error("Unverified test worker ownership.");
        records.set(Number(record.pid), record);
      }
      for (const pid of databases) if (!records.has(pid)) throw new Error("Unregistered worker database state.");
      for (const [pid, record] of records) {
        const deadline = Date.now() + 1000;
        for (;;) {
          const live = await identity(pid);
          if (!live || live.start !== record.start || live.state === "Z") break;
          const expectedParent = pid === child?.pid ? process.pid : child?.pid;
          if (live.parent !== expectedParent || record.parent !== expectedParent) throw new Error("Test worker parent identity changed; fixture preserved.");
          if (Date.now() >= deadline) throw new Error("Test worker still active; fixture preserved.");
          await Bun.sleep(10);
        }
      }
      if (descendantTrackingFailure) throw new Error("Unable to verify test process descendants.");
      for (const [pid, start] of observedDescendants) {
        const current = await identity(pid);
        if (current && current.start === start && current.state !== "Z") throw new Error("A test descendant remains active; fixture preserved.");
      }
      await rm(run, { recursive: true });
    } catch { failure ??= new Error("Test database fixture preserved for inspection: " + run); }
    signal?.removeEventListener("abort", abort);
  }
  if (failure !== undefined) throw failure;
  return signal?.aborted ? 130 : status;
}
