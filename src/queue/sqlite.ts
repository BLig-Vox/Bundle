import { randomBytes } from "node:crypto";
import { databaseSettings, projectRoot, type Environment } from "../database/config.ts";
import { withDatabase } from "../database/connection.ts";

type QueueOptions = {
  root?: string;
  env?: Environment;
  leaseMs?: number;
};

export type ClaimedJob = Readonly<{
  id: number;
  queue: string;
  type: string;
  payloadJson: string;
  availableAt: number;
  reservedAt: number;
  reservationToken: string;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
}>;

export type FailureCode = "handler_failed" | "attempts_exhausted" | "unregistered_job" | "invalid_payload";
export type FailureResult =
  | { status: "lost" }
  | { status: "failed" }
  | { status: "retrying"; availableAt: number };

type ClaimedRow = {
  id: number;
  queue_name: string;
  job_type: string;
  payload_json: string;
  available_at: number;
  reserved_at: number;
  reservation_token: string;
  attempts: number;
  max_attempts: number;
  created_at: number;
};

const maxPayloadBytes = 16 * 1024;
const maxDelayMs = 7 * 24 * 60 * 60 * 1000;
const maxLeaseMs = 24 * 60 * 60 * 1000;
const sqliteNow = "cast(round((julianday('now') - 2440587.5) * 86400000) as integer)";

function queueName(value: string) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error("Invalid queue name: use 1–64 lowercase letters, numbers, hyphens or underscores.");
  }
  return value;
}

function jobType(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error("Invalid job type: use 1–128 ASCII letters, numbers, dots, hyphens or underscores, starting with a letter.");
  }
  return value;
}

function serializedPayload(value: unknown) {
  let json: string | undefined;
  try { json = JSON.stringify(value); }
  catch { throw new Error("Job payload must be JSON serializable."); }
  if (json === undefined) throw new Error("Job payload must be JSON serializable.");
  if (Buffer.byteLength(json, "utf8") > maxPayloadBytes) throw new Error("Job payload exceeds the 16 KiB limit.");
  return json;
}

function lease(job: ClaimedJob) {
  if (!Number.isSafeInteger(job.id) || job.id < 1 || !/^[A-Za-z0-9_-]{43}$/.test(job.reservationToken)) {
    throw new Error("Invalid claimed job lease.");
  }
}

/**
 * SQLite-only durable queue primitives. Jobs are at-least-once: handlers must be
 * idempotent, and applications must migrate bundle_jobs before dispatch/worker use.
 * The reservation token fences acknowledgements from workers whose lease expired.
 */
export function createSqliteQueue(options: QueueOptions = {}) {
  const root = options.root ?? projectRoot;
  const env = options.env ?? process.env;
  const leaseMs = options.leaseMs ?? 5 * 60 * 1000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > maxLeaseMs) {
    throw new Error("Queue leaseMs must be an integer from 1000 through 86400000.");
  }
  const assertSqlite = () => {
    if (databaseSettings(env, root).connection !== "sqlite") throw new Error("Durable queue currently supports SQLite only.");
  };
  async function enqueue(queue: string, type: string, payload: unknown, config: { delayMs?: number; maxAttempts?: number } = {}) {
    assertSqlite();
    queue = queueName(queue);
    type = jobType(type);
    const payloadJson = serializedPayload(payload);
    const delayMs = config.delayMs ?? 0;
    const maxAttempts = config.maxAttempts ?? 3;
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > maxDelayMs) {
      throw new Error("Queue delayMs must be an integer from 0 through 604800000.");
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new Error("Queue maxAttempts must be an integer from 1 through 20.");
    }
    return withDatabase(async orm => {
      const rows = await orm.em.getConnection().execute<Array<{ id: number }>>(
        `insert into bundle_jobs (queue_name, job_type, payload_json, available_at, attempts, max_attempts, created_at)
         values (?, ?, ?, ${sqliteNow} + ?, 0, ?, ${sqliteNow}) returning id`,
        [queue, type, payloadJson, delayMs, maxAttempts],
      );
      if (!rows[0] || !Number.isSafeInteger(rows[0].id) || rows[0].id < 1) throw new Error("Queue insert did not return a job ID.");
      return rows[0].id;
    }, { root, env });
  }

  async function claim(queue = "default"): Promise<ClaimedJob | null> {
    assertSqlite();
    queue = queueName(queue);
    const token = randomBytes(32).toString("base64url");
    return withDatabase(async orm => {
      const connection = orm.em.getConnection();
      return connection.transactional(async tx => {
        // Reap a worker that consumed its final attempt and then died mid-handler.
        await connection.execute(
          `update bundle_jobs set failed_at = ${sqliteNow}, failure_code = 'attempts_exhausted', reserved_at = null, reservation_token = null
           where queue_name = ? and failed_at is null and attempts >= max_attempts
             and reserved_at is not null and reserved_at <= ${sqliteNow} - ?`,
          [queue, leaseMs], "run", tx,
        );
        // One atomic UPDATE...RETURNING prevents two SQLite workers from claiming one row.
        const rows = await connection.execute<ClaimedRow[]>(
          `update bundle_jobs set reserved_at = ${sqliteNow}, reservation_token = ?, attempts = attempts + 1
           where id = (
             select id from bundle_jobs
             where queue_name = ? and failed_at is null and attempts < max_attempts
               and available_at <= ${sqliteNow} and (reserved_at is null or reserved_at <= ${sqliteNow} - ?)
             order by available_at, id limit 1
           ) and failed_at is null
           returning id, queue_name, job_type, payload_json, available_at, reserved_at, reservation_token, attempts, max_attempts, created_at`,
          [token, queue, leaseMs], "all", tx,
        );
        const row = rows[0];
        if (!row) return null;
        return Object.freeze({
          id: row.id, queue: row.queue_name, type: row.job_type, payloadJson: row.payload_json,
          availableAt: row.available_at, reservedAt: row.reserved_at, reservationToken: row.reservation_token,
          attempts: row.attempts, maxAttempts: row.max_attempts, createdAt: row.created_at,
        });
      });
    }, { root, env });
  }

  async function acknowledge(job: ClaimedJob): Promise<boolean> {
    assertSqlite();
    lease(job);
    return withDatabase(async orm => {
      const rows = await orm.em.getConnection().execute<Array<{ id: number }>>(
        "delete from bundle_jobs where id = ? and reservation_token = ? and failed_at is null returning id",
        [job.id, job.reservationToken],
      );
      return rows.length === 1;
    }, { root, env });
  }

  async function fail(job: ClaimedJob, reason: Exclude<FailureCode, "attempts_exhausted"> = "handler_failed"): Promise<FailureResult> {
    assertSqlite();
    lease(job);
    if (reason !== "handler_failed" && reason !== "unregistered_job" && reason !== "invalid_payload") {
      throw new Error("Invalid queue failure code.");
    }
    const permanent = reason !== "handler_failed";
    return withDatabase(async orm => {
      const rows = await orm.em.getConnection().execute<Array<{ attempts: number; max_attempts: number; available_at: number }>>(
        `update bundle_jobs set
           reserved_at = null,
           reservation_token = null,
           failed_at = case when attempts >= max_attempts or ? then ${sqliteNow} else null end,
           failure_code = case when attempts >= max_attempts or ? then case when ? then 'handler_failed' else ? end else null end,
           available_at = case when attempts >= max_attempts or ? then available_at
             else ${sqliteNow} + min(60000, 1000 * (1 << min(attempts - 1, 6))) end
         where id = ? and reservation_token = ? and failed_at is null
         returning attempts, max_attempts, available_at`,
        [permanent, permanent, !permanent, reason, permanent, job.id, job.reservationToken],
      );
      const row = rows[0];
      if (!row) return { status: "lost" };
      return permanent || row.attempts >= row.max_attempts
        ? { status: "failed" }
        : { status: "retrying", availableAt: row.available_at };
    }, { root, env });
  }

  return Object.freeze({ enqueue, claim, acknowledge, fail });
}
