import { Database } from "bun:sqlite";
import { closeSync, fchmodSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { validateJobMiddlewareReferences, type JobMiddlewareReference } from "./middleware-definitions.ts";

export interface ModuleQueueJob { module: string; export: string; method?: string; payload: unknown; middleware?: readonly JobMiddlewareReference[] }
export interface CommandQueueJob { kind: "command"; version: 1; argv: string[]; payload?: never; module?: never; export?: never; method?: never; middleware?: readonly JobMiddlewareReference[] }
export type QueueJob = ModuleQueueJob | CommandQueueJob;
export interface Reservation { id: number; queue: string; job: QueueJob | null; attempt: number; receipt: string }
export interface FailedJob { id: number; queue: string; job: QueueJob | null; attempts: number; reason: string; failedAt: number }
export interface QueueSnapshot { ready: number; delayed: number; reserved: number; expired: number; failed: number }
export interface BatchEntry { job: QueueJob; queue?: string; availableAt?: number; maxAttempts?: number }
export interface BatchDispatch { id: string; jobIds: readonly number[] }
export interface BatchStatus { id: string; total: number; pending: number; succeeded: number; failed: number; cancelled: number; createdAt: number; cancelledAt: number | null; finishedAt: number | null }
export type FailureScope = { queue: string; all?: never } | { all: true; queue?: never };

function failureScope(scope: FailureScope): string | undefined {
  if (!scope || typeof scope !== "object") throw new Error("Select a queue or all failures");
  if (scope.all === true && scope.queue === undefined) return undefined;
  if (scope.all === undefined && scope.queue !== undefined) { queueName(scope.queue); return scope.queue; }
  throw new Error("Select a queue or all failures");
}

const APPLICATION_ID = 0x42515545;
const SCHEMA = `CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, job TEXT NOT NULL, available INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, receipt TEXT, lease INTEGER, reason TEXT, failed_at INTEGER)`;
const BATCH_SCHEMA = `CREATE TABLE batches (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, cancelled_at INTEGER, finished_at INTEGER)`;
const MEMBER_SCHEMA = `CREATE TABLE batch_members (job_id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, state TEXT NOT NULL)`;
const MAX_TIME = 8_640_000_000_000_000;
const MAX_DELAY = 30 * 24 * 60 * 60 * 1000;
const MAX_LEASE = 24 * 60 * 60 * 1000;
const MAX_JSON = 64 * 1024;
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function name(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && identifier.test(value) && !forbidden.has(value); }
function queueName(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error("Invalid queue name"); }
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
function jsonValue(value: unknown, seen: Set<object>, depth: number): void {
  if (depth > 64) throw new Error("JSON nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("Invalid JSON number"); return; }
  if (typeof value !== "object" || seen.has(value)) throw new Error("Invalid JSON value");
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("JSON must be plain");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) throw new Error("Invalid JSON properties");
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).length !== value.length + 1) throw new Error("Invalid JSON array");
    for (let i = 0; i < value.length; i++) {
      const d = descriptors[String(i)];
      if (!d || !d.enumerable || !("value" in d)) throw new Error("Invalid JSON array");
      jsonValue(d.value, seen, depth + 1);
    }
  } else for (const d of Object.values(descriptors)) {
    if (!d.enumerable || !("value" in d)) throw new Error("Invalid JSON property");
    jsonValue(d.value, seen, depth + 1);
  }
  seen.delete(value);
}
/** Validate and serialize a bounded executable job without opening queue storage. */
export function encodeJob(job: QueueJob): string {
  jsonValue(job, new Set(), 0);
  if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("Invalid job");
  const keys = Object.keys(job);
  if (job.middleware !== undefined) validateJobMiddlewareReferences(job.middleware);
  if ("kind" in job) {
    if (keys.length !== (Object.hasOwn(job,"middleware") ? 4 : 3) || !keys.every(k => ["kind", "version", "argv", "middleware"].includes(k)) || job.kind !== "command" || job.version !== 1 || !Array.isArray(job.argv) || job.argv.length < 1 || job.argv.length > 128 || job.argv.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")) || !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/.test(job.argv[0]!)) throw new Error("Invalid command envelope");
  } else {
    if (keys.some(k => !["module", "export", "method", "payload", "middleware"].includes(k)) || !keys.includes("payload") || !name(job.export) || (job.method !== undefined && !name(job.method))) throw new Error("Invalid job descriptor");
    if (typeof job.module !== "string" || job.module.length > 512 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(job.module)) throw new Error("Invalid job module");
  }
  const result = JSON.stringify(job);
  if (Buffer.byteLength(result) > MAX_JSON) throw new Error("Job exceeds JSON limit");
  return result;
}
// Unreadable or invalid rows remain intact in SQLite, but never escape as executable data.
function decodeJob(raw: string): QueueJob | null {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_JSON) return null;
    const job: unknown = JSON.parse(raw);
    encodeJob(job as QueueJob);
    return job as QueueJob;
  } catch { return null; }
}
export function validateEnqueue(queue: string, options: { availableAt?: number; maxAttempts?: number } = {}): void {
  queueName(queue);
  if (options.availableAt !== undefined) integer(options.availableAt, 0, MAX_TIME, "availability");
  if (options.maxAttempts !== undefined) integer(options.maxAttempts, 1, 100, "max attempts");
}
type PreparedBatchEntry = { queue: string; encoded: string; availableAt?: number; maxAttempts: number };
/** Snapshot and validate every entry before any storage is opened or modified. */
export function prepareBatch(entries: readonly BatchEntry[]): PreparedBatchEntry[] {
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype || entries.length < 1 || entries.length > 128 || Object.getOwnPropertySymbols(entries).length) throw new Error("Invalid batch");
  const arrayDescriptors = Object.getOwnPropertyDescriptors(entries);
  if (Object.keys(arrayDescriptors).length !== entries.length + 1) throw new Error("Invalid batch");
  let bytes = 0;
  const result: PreparedBatchEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const item = arrayDescriptors[String(i)];
    if (!item || !item.enumerable || !("value" in item)) throw new Error("Invalid batch");
    const entry: unknown = item.value;
    if (!entry || typeof entry !== "object" || (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) || Object.getOwnPropertySymbols(entry).length) throw new Error("Invalid batch entry");
    const fields = Object.getOwnPropertyDescriptors(entry);
    if (!Object.hasOwn(fields, "job") || Object.entries(fields).some(([key, d]) => !["job", "queue", "availableAt", "maxAttempts"].includes(key) || !d.enumerable || !("value" in d))) throw new Error("Invalid batch entry");
    const queue = fields.queue?.value === undefined ? "default" : fields.queue.value;
    const availableAt = fields.availableAt?.value;
    const maxAttempts = fields.maxAttempts?.value === undefined ? 3 : fields.maxAttempts.value;
    validateEnqueue(queue, {availableAt, maxAttempts});
    const encoded = encodeJob(fields.job!.value as QueueJob);
    bytes += Buffer.byteLength(encoded);
    if (bytes > 1024 * 1024) throw new Error("Batch exceeds size limit");
    result.push({queue, encoded, availableAt, maxAttempts});
  }
  return result;
}
function validateBatchId(id: string): void { if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid batch id"); }
function validatePath(path: string): { path: string; created: boolean } {
  if (typeof path !== "string" || !path || path.includes("\0") || path === ":memory:") throw new Error("Invalid queue path");
  const target = resolve(path);
  const parent = dirname(target);
  let current = isAbsolute(parent) ? sep : "";
  for (const component of parent.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const s = lstatSync(current);
    const trustedOwner = typeof process.getuid !== "function" || s.uid === 0 || s.uid === process.getuid();
    const writable = (s.mode & 0o022) !== 0;
    if (!s.isDirectory() || s.isSymbolicLink() || !trustedOwner || (writable && (current === parent || !(s.mode & 0o1000)))) throw new Error("Unsafe queue parent");
  }
  let created = false;
  try {
    const fd = openSync(target, "wx", 0o600);
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    created = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const s = lstatSync(target);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && s.uid !== process.getuid())) throw new Error("Unsafe queue file");
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      const sidecar = lstatSync(target + suffix);
      if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1 || (typeof process.getuid === "function" && sidecar.uid !== process.getuid())) throw new Error("Unsafe queue sidecar");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { path: target, created };
}
type Row = { id: number; queue: string; job: string; attempts: number; max_attempts: number; reason: string; failed_at: number };
export class QueueStore {
  private db: Database;
  constructor(path: string, private clock: () => number = Date.now, options: { upgrade?: boolean } = {}) {
    const file = validatePath(path);
    this.db = new Database(file.path, { create: false });
    try {
      this.db.exec("PRAGMA busy_timeout=5000");
      this.db.transaction(() => {
        const id = (this.db.query("PRAGMA application_id").get() as { application_id: number }).application_id;
        const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
        const objects = this.db.query("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as { type: string; name: string; sql: string }[];
        const matches = (expected: readonly [string, string][]) => objects.length === expected.length && expected.every(([name, sql], i) => objects[i]?.type === "table" && objects[i]?.name === name && objects[i]?.sql === sql);
        if (file.created) {
          if (id !== 0 || version !== 0 || objects.length) throw new Error("Invalid new queue database");
          this.db.exec(SCHEMA); this.db.exec(BATCH_SCHEMA); this.db.exec(MEMBER_SCHEMA);
          this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=2`);
        } else if (id === APPLICATION_ID && version === 1 && matches([["jobs", SCHEMA]])) {
          if (options.upgrade !== true) throw new Error("Queue database upgrade required");
          this.db.exec(BATCH_SCHEMA); this.db.exec(MEMBER_SCHEMA); this.db.exec("PRAGMA user_version=2");
        } else if (id !== APPLICATION_ID || version !== 2 || !matches([["batch_members", MEMBER_SCHEMA], ["batches", BATCH_SCHEMA], ["jobs", SCHEMA]])) throw new Error("Not a Bundle queue database");
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }
  private now(): number { return integer(this.clock(), 0, MAX_TIME - MAX_DELAY, "clock"); }
  private finish(now: number): void {
    this.db.query("UPDATE batches SET finished_at=? WHERE finished_at IS NULL AND NOT EXISTS (SELECT 1 FROM batch_members WHERE batch_id=batches.id AND state='pending')").run(now);
  }
  private reconcile(now: number): void {
    const eligible = "SELECT j.id FROM jobs j JOIN batch_members m ON m.job_id=j.id JOIN batches b ON b.id=m.batch_id WHERE b.cancelled_at IS NOT NULL AND m.state='pending' AND j.reason IS NULL AND (j.receipt IS NULL OR j.lease<=?)";
    this.db.query(`UPDATE batch_members SET state='cancelled' WHERE job_id IN (${eligible})`).run(now);
    this.db.query("DELETE FROM jobs WHERE id IN (SELECT job_id FROM batch_members WHERE state='cancelled') AND reason IS NULL AND (receipt IS NULL OR lease<=?)").run(now);
    this.finish(now);
  }
  private status(id: string): BatchStatus | null {
    return this.db.query(`SELECT b.id, count(m.job_id) AS total, count(*) FILTER (WHERE m.state='pending') AS pending, count(*) FILTER (WHERE m.state='succeeded') AS succeeded, count(*) FILTER (WHERE m.state='failed') AS failed, count(*) FILTER (WHERE m.state='cancelled') AS cancelled, b.created_at AS createdAt, b.cancelled_at AS cancelledAt, b.finished_at AS finishedAt FROM batches b JOIN batch_members m ON m.batch_id=b.id WHERE b.id=? GROUP BY b.id`).get(id) as BatchStatus | null;
  }
  enqueueBatch(entries: readonly BatchEntry[]): BatchDispatch {
    const prepared = prepareBatch(entries);
    return this.publishBatch(prepared);
  }
  /** Publish an already-snapshotted batch after all caller-controlled data was validated. */
  private publishBatch(entries: PreparedBatchEntry[]): BatchDispatch {
    return this.db.transaction(() => {
      const now = this.now(), id = randomBytes(16).toString("hex");
      this.db.query("INSERT INTO batches(id,created_at) VALUES(?,?)").run(id, now);
      const jobIds: number[] = [];
      for (const entry of entries) {
        const jobId = Number(this.db.query("INSERT INTO jobs(queue,job,available,attempts,max_attempts) VALUES(?,?,?,0,?)").run(entry.queue, entry.encoded, entry.availableAt ?? now, entry.maxAttempts).lastInsertRowid);
        this.db.query("INSERT INTO batch_members(job_id,batch_id,state) VALUES(?,?,'pending')").run(jobId, id);
        jobIds.push(jobId);
      }
      return {id, jobIds};
    }).immediate();
  }
  getBatch(id: string): BatchStatus | null {
    validateBatchId(id);
    return this.db.transaction(() => { this.reconcile(this.now()); return this.status(id); }).immediate();
  }
  cancelBatch(id: string): BatchStatus | null {
    validateBatchId(id);
    return this.db.transaction(() => {
      const now = this.now();
      this.db.query("UPDATE batches SET cancelled_at=coalesce(cancelled_at,?) WHERE id=?").run(now, id);
      this.reconcile(now);
      return this.status(id);
    }).immediate();
  }
  retryBatch(id: string): number | null {
    validateBatchId(id);
    return this.db.transaction(() => {
      const now = this.now();
      const batch = this.db.query("SELECT cancelled_at FROM batches WHERE id=?").get(id) as {cancelled_at: number | null} | null;
      if (!batch) return null;
      if (batch.cancelled_at !== null) throw new Error("Cancelled batch cannot be retried");
      const result = this.db.query("UPDATE jobs SET attempts=0,available=?,reason=NULL,failed_at=NULL,receipt=NULL,lease=NULL WHERE reason IS NOT NULL AND id IN (SELECT job_id FROM batch_members WHERE batch_id=? AND state='failed')").run(now, id);
      this.db.query("UPDATE batch_members SET state='pending' WHERE batch_id=? AND state='failed' AND job_id IN (SELECT id FROM jobs WHERE reason IS NULL)").run(id);
      if (result.changes) this.db.query("UPDATE batches SET finished_at=NULL WHERE id=?").run(id);
      return result.changes;
    }).immediate();
  }
  pruneBatches(options: {before: number}): number {
    if (!options || typeof options !== "object") throw new Error("Invalid cutoff");
    const before = integer(options.before, 0, MAX_TIME, "cutoff");
    return this.db.transaction(() => {
      this.db.query("DELETE FROM batch_members WHERE batch_id IN (SELECT id FROM batches WHERE finished_at IS NOT NULL AND finished_at<?)").run(before);
      return this.db.query("DELETE FROM batches WHERE finished_at IS NOT NULL AND finished_at<?").run(before).changes;
    }).immediate();
  }
  enqueue(queue: string, job: QueueJob, options: { availableAt?: number; maxAttempts?: number } = {}): number {
    validateEnqueue(queue, options); const encoded = encodeJob(job); const now = this.now();
    const available = integer(options.availableAt ?? now, 0, MAX_TIME, "availability");
    const max = integer(options.maxAttempts ?? 3, 1, 100, "max attempts");
    return Number(this.db.query("INSERT INTO jobs(queue,job,available,attempts,max_attempts) VALUES(?,?,?,0,?)").run(queue, encoded, available, max).lastInsertRowid);
  }
  reserve(queues: readonly string[], options: { leaseMs?: number; maxAttempts?: number } = {}): Reservation | null {
    if (!Array.isArray(queues) || !queues.length || queues.length > 64) throw new Error("Invalid queue list");
    for (const q of queues) queueName(q);
    const lease = integer(options.leaseMs ?? 30_000, 1, MAX_LEASE, "lease");
    const override = options.maxAttempts === undefined ? undefined : integer(options.maxAttempts, 1, 100, "max attempts");
    return this.db.transaction(() => {
      // Fix the eligibility horizon for this scan, but recheck it at each mutation
      // so a clock rollback cannot take a live receipt or prematurely fail work.
      const now = this.now();
      this.reconcile(now);
      for (const queue of queues) {
        let after = 0;
        for (;;) {
          const row = this.db.query("SELECT id,queue,job,attempts,max_attempts FROM jobs WHERE queue=? AND id>? AND reason IS NULL AND available<=? AND (receipt IS NULL OR lease<=?) AND NOT EXISTS (SELECT 1 FROM batch_members m JOIN batches b ON b.id=m.batch_id WHERE m.job_id=jobs.id AND b.cancelled_at IS NOT NULL) ORDER BY id LIMIT 1").get(queue, after, now, now) as Row | null;
          if (!row) break;
          after = row.id;
          const max = override ?? row.max_attempts;
          if (row.attempts >= max) {
            const publishedAt = this.now();
            const changed = this.db.query("UPDATE jobs SET max_attempts=?,reason='Maximum attempts reached',failed_at=?,receipt=NULL,lease=NULL WHERE id=? AND reason IS NULL AND available<=? AND (receipt IS NULL OR lease<=?)").run(max, publishedAt, row.id, publishedAt, publishedAt);
            if (changed.changes) { this.db.query("UPDATE batch_members SET state='failed' WHERE job_id=? AND state='pending'").run(row.id); this.finish(publishedAt); }
            continue;
          }
          const receipt = randomBytes(32).toString("hex");
          const publishedAt = this.now();
          const claimed = this.db.query("UPDATE jobs SET max_attempts=?,receipt=?,lease=?,attempts=attempts+1 WHERE id=? AND reason IS NULL AND available<=? AND (receipt IS NULL OR lease<=?)").run(max, receipt, publishedAt + lease, row.id, publishedAt, publishedAt);
          if (!claimed.changes) continue;
          return { id: row.id, queue: row.queue, job: decodeJob(row.job), attempt: row.attempts + 1, receipt };
        }
      }
      return null;
    }).immediate();
  }
  private receipt(receipt: string): void { if (typeof receipt !== "string" || !/^[a-f0-9]{64}$/.test(receipt)) throw new Error("Invalid receipt"); }
  ack(receipt: string): boolean {
    this.receipt(receipt);
    return this.db.transaction(() => {
      const now = this.now();
      const row = this.db.query("DELETE FROM jobs WHERE receipt=? AND lease>? AND reason IS NULL RETURNING id").get(receipt, now) as {id: number} | null;
      if (!row) return false;
      this.db.query("UPDATE batch_members SET state='succeeded' WHERE job_id=? AND state='pending'").run(row.id);
      this.finish(now);
      return true;
    }).immediate();
  }
  release(receipt: string, options: { delayMs?: number } = {}): boolean {
    return this.settle(receipt, { outcome: "failed", delayMs: options.delayMs }) !== null;
  }
  settle(receipt: string, options: { outcome: "failed" | "cancelled"; delayMs?: number }): "released" | "failed" | "cancelled" | null {
    this.receipt(receipt);
    if (!options || (options.outcome !== "failed" && options.outcome !== "cancelled")) throw new Error("Invalid settlement outcome");
    const delay = integer(options.delayMs ?? 0, 0, MAX_DELAY, "delay");
    return this.db.transaction(() => {
      const now = this.now();
      const cancelled = this.db.query("SELECT j.id FROM jobs j JOIN batch_members m ON m.job_id=j.id JOIN batches b ON b.id=m.batch_id WHERE j.receipt=? AND j.lease>? AND j.reason IS NULL AND b.cancelled_at IS NOT NULL").get(receipt, now) as {id: number} | null;
      if (cancelled) {
        this.db.query("DELETE FROM jobs WHERE id=?").run(cancelled.id);
        this.db.query("UPDATE batch_members SET state='cancelled' WHERE job_id=? AND state='pending'").run(cancelled.id);
        this.finish(now);
        return "cancelled";
      }
      const row = (options.outcome === "cancelled"
        ? this.db.query("UPDATE jobs SET receipt=NULL,lease=NULL,available=?,attempts=attempts-1 WHERE receipt=? AND lease>? AND reason IS NULL RETURNING id,reason").get(now + delay, receipt, now)
        : this.db.query("UPDATE jobs SET receipt=NULL,lease=NULL,available=?,reason=CASE WHEN attempts>=max_attempts THEN 'Maximum attempts reached' ELSE NULL END,failed_at=CASE WHEN attempts>=max_attempts THEN ? ELSE NULL END WHERE receipt=? AND lease>? AND reason IS NULL RETURNING id,reason").get(now + delay, now, receipt, now)) as { id: number; reason: string | null } | null;
      if (row?.reason) { this.db.query("UPDATE batch_members SET state='failed' WHERE job_id=? AND state='pending'").run(row.id); this.finish(now); }
      return row ? (row.reason === null ? "released" : "failed") : null;
    }).immediate();
  }
  heartbeat(receipt: string, options: { leaseMs?: number } = {}): boolean {
    this.receipt(receipt); const lease = integer(options.leaseMs ?? 30_000, 1, MAX_LEASE, "lease");
    return this.db.transaction(() => {
      const now = this.now();
      return this.db.query("UPDATE jobs SET lease=? WHERE receipt=? AND lease>? AND reason IS NULL").run(now + lease, receipt, now).changes > 0;
    }).immediate();
  }
  fail(receipt: string, reason: string): boolean {
    this.receipt(receipt); if (typeof reason !== "string" || !reason.length || Buffer.byteLength(reason) > 4096) throw new Error("Invalid failure reason");
    return this.db.transaction(() => {
      const now = this.now();
      const cancelled = this.db.query("SELECT j.id FROM jobs j JOIN batch_members m ON m.job_id=j.id JOIN batches b ON b.id=m.batch_id WHERE j.receipt=? AND j.lease>? AND j.reason IS NULL AND b.cancelled_at IS NOT NULL").get(receipt, now) as {id: number} | null;
      if (cancelled) {
        this.db.query("DELETE FROM jobs WHERE id=?").run(cancelled.id);
        this.db.query("UPDATE batch_members SET state='cancelled' WHERE job_id=? AND state='pending'").run(cancelled.id);
        this.finish(now); return true;
      }
      const row = this.db.query("UPDATE jobs SET reason=?,failed_at=?,receipt=NULL,lease=NULL WHERE receipt=? AND lease>? AND reason IS NULL RETURNING id").get(reason, now, receipt, now) as {id: number} | null;
      if (!row) return false;
      this.db.query("UPDATE batch_members SET state='failed' WHERE job_id=? AND state='pending'").run(row.id);
      this.finish(now); return true;
    }).immediate();
  }
  listFailed(queue?: string): FailedJob[] {
    if (queue !== undefined) queueName(queue);
    const rows = (queue === undefined ? this.db.query("SELECT * FROM jobs WHERE reason IS NOT NULL ORDER BY id LIMIT 1000").all() : this.db.query("SELECT * FROM jobs WHERE reason IS NOT NULL AND queue=? ORDER BY id LIMIT 1000").all(queue)) as Row[];
    return rows.map(row => ({ id: row.id, queue: row.queue, job: decodeJob(row.job), attempts: row.attempts, reason: row.reason, failedAt: row.failed_at }));
  }
  failedPage(options: { queue?: string; afterId?: number; limit?: number } = {}): { failed: FailedJob[]; nextAfterId: number | null } {
    if (options.queue !== undefined) queueName(options.queue);
    const after = integer(options.afterId ?? 0, 0, Number.MAX_SAFE_INTEGER, "cursor");
    const limit = integer(options.limit ?? 100, 1, 1000, "limit");
    const rows = (options.queue === undefined
      ? this.db.query("SELECT * FROM jobs WHERE reason IS NOT NULL AND id>? ORDER BY id LIMIT ?").all(after, limit + 1)
      : this.db.query("SELECT * FROM jobs WHERE reason IS NOT NULL AND queue=? AND id>? ORDER BY id LIMIT ?").all(options.queue, after, limit + 1)) as Row[];
    const failed = rows.slice(0, limit).map(row => ({ id: row.id, queue: row.queue, job: decodeJob(row.job), attempts: row.attempts, reason: row.reason, failedAt: row.failed_at }));
    return { failed, nextAfterId: rows.length > limit ? failed[failed.length - 1]!.id : null };
  }
  snapshot(queue: string): QueueSnapshot {
    queueName(queue);
    const now = this.now();
    return this.db.query(`SELECT
      count(*) FILTER (WHERE reason IS NULL AND receipt IS NULL AND available<=?) AS ready,
      count(*) FILTER (WHERE reason IS NULL AND receipt IS NULL AND available>?) AS delayed,
      count(*) FILTER (WHERE reason IS NULL AND receipt IS NOT NULL AND lease>?) AS reserved,
      count(*) FILTER (WHERE reason IS NULL AND receipt IS NOT NULL AND lease<=?) AS expired,
      count(*) FILTER (WHERE reason IS NOT NULL) AS failed
      FROM jobs WHERE queue=?`).get(now, now, now, now, queue) as QueueSnapshot;
  }
  clear(queue: string): number {
    queueName(queue);
    return this.db.transaction(() => {
      const now = this.now();
      this.db.query("UPDATE batch_members SET state='cancelled' WHERE state='pending' AND job_id IN (SELECT id FROM jobs WHERE queue=? AND receipt IS NULL AND reason IS NULL)").run(queue);
      const result = this.db.query("DELETE FROM jobs WHERE queue=? AND receipt IS NULL AND reason IS NULL").run(queue).changes;
      this.finish(now); return result;
    }).immediate();
  }
  flushFailed(scope: FailureScope): number {
    const queue = failureScope(scope);
    return this.db.transaction(() => queue === undefined
      ? this.db.query("DELETE FROM jobs WHERE reason IS NOT NULL").run().changes
      : this.db.query("DELETE FROM jobs WHERE reason IS NOT NULL AND queue=?").run(queue).changes).immediate();
  }
  pruneFailed(options: FailureScope & { before: number }): number {
    const queue = failureScope(options);
    const before = integer(options.before, 0, MAX_TIME, "cutoff");
    return this.db.transaction(() => queue === undefined
      ? this.db.query("DELETE FROM jobs WHERE reason IS NOT NULL AND failed_at<?").run(before).changes
      : this.db.query("DELETE FROM jobs WHERE reason IS NOT NULL AND queue=? AND failed_at<?").run(queue, before).changes).immediate();
  }
  retry(id: number): boolean {
    integer(id, 1, Number.MAX_SAFE_INTEGER, "id");
    return this.db.transaction(() => {
      const now = this.now();
      const result = this.db.query("UPDATE jobs SET attempts=0,available=?,reason=NULL,failed_at=NULL,receipt=NULL,lease=NULL WHERE id=? AND reason IS NOT NULL AND NOT EXISTS (SELECT 1 FROM batch_members m JOIN batches b ON b.id=m.batch_id WHERE m.job_id=jobs.id AND b.cancelled_at IS NOT NULL)").run(now, id);
      if (!result.changes) return false;
      this.db.query("UPDATE batches SET finished_at=NULL WHERE id=(SELECT batch_id FROM batch_members WHERE job_id=? AND state='failed')").run(id);
      this.db.query("UPDATE batch_members SET state='pending' WHERE job_id=? AND state='failed'").run(id);
      return true;
    }).immediate();
  }
  forgetFailed(id: number): boolean { integer(id, 1, Number.MAX_SAFE_INTEGER, "id"); return this.db.query("DELETE FROM jobs WHERE id=? AND reason IS NOT NULL").run(id).changes > 0; }
  close(): void { this.db.close(); }
}
