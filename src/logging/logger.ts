import { constants, watch } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const logLevels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
export type LogLevel = typeof logLevels[number];
export interface LogEntry { id: string; timestamp: string; level: LogLevel; message: string; context: Record<string, unknown> }
export interface ReadLogOptions { minimumLevel?: LogLevel; filter?: string; limit?: number; maxBytes?: number }
const secretName = /password|passwd|secret|token|credential|private|api.?key|app.?key|authorization/i;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const filename = "bundle.jsonl";

function level(value: unknown): asserts value is LogLevel {
  if (typeof value !== "string" || !logLevels.includes(value as LogLevel)) throw new Error("Unsupported log level.");
}

function sanitized(value: unknown, secrets: readonly string[], key = "", ancestors = new Set<object>(), depth = 0): unknown {
  if (depth > 20) throw new Error("Log context nesting is too deep.");
  if (secretName.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (/[a-z][a-z\d+.-]*:\/\/[^\s/@]+@/i.test(value)) return "[REDACTED]";
    let result = value;
    for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("Log context must be acyclic JSON data.");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Log context must use plain objects.");
  ancestors.add(value);
  try {
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key !== "string" || forbiddenKeys.has(key)) throw new Error("Unsupported log context key.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Log context accessors are not supported.");
      (result as Record<string, unknown>)[key] = sanitized(descriptor.value, secrets, key, ancestors, depth + 1);
    }
    return result;
  } finally { ancestors.delete(value); }
}

async function directory(root: string, create: boolean): Promise<string | undefined> {
  let path = await realpath(root);
  if (!(await lstat(path)).isDirectory()) throw new Error("Log root must be an existing directory.");
  for (const part of ["storage", "logs"]) {
    path = join(path, part);
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Log parents must be real directories, not files or symlinks.");
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return path;
}

/** Local structured logs. Context redaction is heuristic; do not log unknown secrets. */
export class Logger {
  constructor(private readonly options: { root: string; env?: Record<string, string | undefined>; clock?: () => number }) {}
  async log(severity: LogLevel, message: string, context: Record<string, unknown> = {}): Promise<void> {
    level(severity);
    if (typeof message !== "string" || !context || typeof context !== "object" || Array.isArray(context)) throw new Error("Log messages must be strings and context must be an object.");
    const secrets = Object.entries(this.options.env ?? process.env).filter(([key, value]) => secretName.test(key) && !!value).map(([, value]) => value!);
    const entry: LogEntry = {
      id: crypto.randomUUID(), timestamp: new Date((this.options.clock ?? Date.now)()).toISOString(), level: severity,
      message: sanitized(message, secrets) as string, context: sanitized(context, secrets) as Record<string, unknown>,
    };
    const content = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(content) > 16384) throw new Error("Log records are limited to 16 KiB.");
    const path = join((await directory(this.options.root, true))!, filename);
    const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error("Log destination must be a regular file without hard links.");
      if (info.size) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, info.size - 1);
        if (last[0] !== 10) throw new Error("Log file ends in an incomplete record; no append was written.");
      }
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
  }
}

function parseRecord(line: string, options: ReadLogOptions, filter?: RegExp): LogEntry | undefined {
  let entry: LogEntry;
  try {
    entry = JSON.parse(line);
    if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp)) || typeof entry.message !== "string" || !entry.context || typeof entry.context !== "object" || Array.isArray(entry.context)) throw new Error();
    level(entry.level);
  } catch { throw new Error("Invalid structured log record; raw contents are not printed."); }
  if (options.minimumLevel && logLevels.indexOf(entry.level) < logLevels.indexOf(options.minimumLevel)) return undefined;
  if (filter && !filter.test(entry.message)) return undefined;
  return entry;
}

function validateOptions(options: ReadLogOptions): RegExp | undefined {
  const limit = options.limit ?? 50;
  const maxBytes = options.maxBytes ?? 262144;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1048576) throw new Error("Log limits must be 1–1000 records and 1024–1048576 bytes.");
  if (options.minimumLevel !== undefined) level(options.minimumLevel);
  let filter: RegExp | undefined;
  try { if (options.filter !== undefined) filter = new RegExp(options.filter); }
  catch { throw new Error("Invalid log filter regular expression."); }
  return filter;
}

async function openLog(root: string): Promise<FileHandle | undefined> {
  const parent = await directory(root, false);
  if (!parent) return undefined;
  let handle: FileHandle;
  try { handle = await open(join(parent, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error("Log source must be a regular file without hard links.");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function snapshot(handle: FileHandle, size: number, options: ReadLogOptions, filter?: RegExp) {
  const maxBytes = options.maxBytes ?? 262144;
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(Math.min(size, maxBytes));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  const data = buffer.subarray(0, bytesRead);
  const last = data.lastIndexOf(10);
  let first = 0;
  if (start) {
    const preceding = Buffer.alloc(1);
    await handle.read(preceding, 0, 1, start - 1);
    if (preceding[0] !== 10) {
      const newline = data.indexOf(10);
      first = newline < 0 ? data.length : newline + 1;
    }
  }
  const entries: LogEntry[] = [];
  if (last >= first) for (const line of data.subarray(first, last).toString("utf8").split("\n")) {
    if (!line) continue;
    const entry = parseRecord(line, options, filter);
    if (entry) entries.push(entry);
  }
  return { entries: entries.slice(-(options.limit ?? 50)), truncated: start > 0, offset: last < 0 ? start : start + last + 1, skipPartial: start > 0 && first === data.length && last < 0 };
}

export async function readLogs(root: string, options: ReadLogOptions = {}): Promise<{ entries: LogEntry[]; truncated: boolean }> {
  const filter = validateOptions(options);
  const handle = await openLog(root);
  if (!handle) return { entries: [], truncated: false };
  try {
    const result = await snapshot(handle, (await handle.stat()).size, options, filter);
    return { entries: result.entries, truncated: result.truncated };
  } finally { await handle.close(); }
}

/** Follow complete records with a bounded buffer, reporting possible gaps on rotation or truncation. */
export async function* followLogs(root: string, options: ReadLogOptions & { signal: AbortSignal; onWarning?: (message: string) => void }): AsyncGenerator<LogEntry, undefined> {
  const filter = validateOptions(options);
  const warn = options.onWarning ?? console.warn;
  if (options.signal.aborted) return undefined;
  const parent = await directory(root, false);
  if (!parent) throw new Error("No log directory exists yet; write a structured log before following.");
  let changed = true;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => { changed = true; wake?.(); wake = undefined; };
  const watcher = watch(parent, (_event, name) => { if (name === filename || name === null) notify(); });
  watcher.on("error", error => { failure = error; notify(); });
  options.signal.addEventListener("abort", notify, { once: true });
  let handle: FileHandle | undefined;
  let offset = 0;
  let pending = Buffer.alloc(0);
  let anchor = Buffer.alloc(0);
  let skipPartial = false;
  const readAnchor = async (source: FileHandle, position: number) => {
    const bytes = Buffer.alloc(Math.min(64, position));
    const { bytesRead } = await source.read(bytes, 0, bytes.length, position - bytes.length);
    return bytes.subarray(0, bytesRead);
  };
  try {
    warn("In-place rewrites between watch events can cause undetectable log gaps.");
    handle = await openLog(root);
    if (handle) {
      const initial = await snapshot(handle, (await handle.stat()).size, options, filter);
      offset = initial.offset;
      anchor = await readAnchor(handle, offset);
      skipPartial = initial.skipPartial;
      if (initial.truncated) warn("Initial log inspection was byte-limited; older records were not read.");
      for (const entry of initial.entries) {
        if (options.signal.aborted) break;
        yield entry;
      }
    }
    while (!options.signal.aborted) {
      if (failure) throw new Error("Log directory watcher failed.");
      changed = false;
      if (handle) {
        const info = await handle.stat();
        if (info.size < offset || (offset > 0 && !(await readAnchor(handle, offset)).equals(anchor))) {
          warn("Log truncation or rewrite detected; records may have been missed.");
          offset = 0; anchor = Buffer.alloc(0); pending = Buffer.alloc(0); skipPartial = false;
        }
        while (offset < info.size && !options.signal.aborted) {
          const buffer = Buffer.alloc(Math.min(65536, info.size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          anchor = Buffer.concat([anchor, buffer.subarray(0, bytesRead)]).subarray(-64);
          pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
          let newline: number;
          while ((newline = pending.indexOf(10)) >= 0) {
            const line = pending.subarray(0, newline);
            pending = pending.subarray(newline + 1);
            if (skipPartial) { skipPartial = false; continue; }
            if (line.length > 16384) throw new Error("Structured log record exceeds the size limit.");
            if (line.length) {
              const entry = parseRecord(line.toString("utf8"), options, filter);
              if (entry) yield entry;
            }
            if (options.signal.aborted) break;
          }
          if (pending.length > 16384 && !skipPartial) throw new Error("Structured log record exceeds the size limit.");
          if (skipPartial && pending.length > 16384) pending = Buffer.alloc(0);
        }
      }
      const candidate = await openLog(root);
      if (candidate) {
        const nextInfo = await candidate.stat();
        const previousInfo = await handle?.stat();
        if (!previousInfo || nextInfo.ino !== previousInfo.ino || nextInfo.dev !== previousInfo.dev) {
          if (handle) {
            warn("Log rotation detected; records may have been missed.");
            await handle.close();
          }
          handle = candidate; offset = 0; anchor = Buffer.alloc(0); pending = Buffer.alloc(0); skipPartial = false;
          changed = true;
        } else await candidate.close();
      }
      // fs.watch may coalesce or omit notifications. A bounded rescan prevents a
      // missed event from leaving complete appended records unread indefinitely.
      if (!changed && !options.signal.aborted) await new Promise<void>(resolve => {
        const timer = setTimeout(notify, 100);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    return undefined;
  } finally {
    try { await handle?.close(); }
    finally {
      watcher.close();
      options.signal.removeEventListener("abort", notify);
    }
  }
}
