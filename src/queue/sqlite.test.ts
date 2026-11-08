import { afterEach, expect, test } from "bun:test";
import { databaseFixture } from "../database/testing.ts";
import { withDatabase } from "../database/connection.ts";
import type { Environment } from "../database/config.ts";
import { createSqliteQueue } from "./sqlite.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const { root, env, cleanup } = await databaseFixture();
  cleanups.push(cleanup);
  await withDatabase(async orm => {
    await orm.em.getConnection().execute(`create table bundle_jobs (
      id integer primary key autoincrement,
      queue_name text not null,
      job_type text not null,
      payload_json text not null,
      available_at integer not null,
      reserved_at integer,
      reservation_token text,
      attempts integer not null default 0,
      max_attempts integer not null,
      failed_at integer,
      failure_code text,
      created_at integer not null
    )`);
  }, { root, env });
  return { root, env, queue: createSqliteQueue({ root, env }) };
}

async function countRows(env: Environment, root: string) {
  return withDatabase(async orm => orm.em.getConnection().execute<Array<{ count: number }>>("select count(*) as count from bundle_jobs"), { root, env });
}

async function expireLease(env: Environment, root: string, job: { id: number; reservedAt: number }) {
  await withDatabase(async orm => orm.em.getConnection().execute(
    "update bundle_jobs set reserved_at = ? where id = ?", [job.reservedAt - 300_001, job.id]), { root, env });
}

test("durable SQLite queue claims FIFO jobs once and acknowledges only the current lease", async () => {
  const { queue } = await fixture();
  const firstId = await queue.enqueue("default", "mail.welcome", { userId: 7 });
  const secondId = await queue.enqueue("default", "mail.receipt", { orderId: 9 });
  const first = await queue.claim("default");
  expect(first).toMatchObject({ id: firstId, queue: "default", type: "mail.welcome", payloadJson: '{"userId":7}', attempts: 1, maxAttempts: 3 });
  expect(first?.reservationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const second = await queue.claim("default");
  expect(second?.id).toBe(secondId);
  expect(await queue.claim("default")).toBeNull();
  expect(await queue.acknowledge(first!)).toBe(true);
  expect(await queue.acknowledge(first!)).toBe(false);
  expect(await queue.acknowledge(second!)).toBe(true);
});

test("expired leases are reclaimed with a new token and stale workers cannot acknowledge", async () => {
  const { queue, env, root } = await fixture();
  const id = await queue.enqueue("default", "reports.build", { reportId: 1 }, { maxAttempts: 2 });
  const first = await queue.claim("default");
  expect(first?.id).toBe(id);
  await expireLease(env, root, first!);
  const second = await queue.claim("default");
  expect(second).toMatchObject({ id, attempts: 2 });
  expect(second?.reservationToken).not.toBe(first?.reservationToken);
  expect(await queue.acknowledge(first!)).toBe(false);
  expect(await queue.fail(second!)).toEqual({ status: "failed" });
  expect(await queue.claim("default")).toBeNull();
});

test("failed jobs retry with bounded exponential delay, then become terminal without storing error text", async () => {
  const { queue, env, root } = await fixture();
  const id = await queue.enqueue("default", "email.send", { address: "person@example.test" }, { maxAttempts: 2 });
  const first = await queue.claim("default");
  expect(first?.id).toBe(id);
  const retry = await queue.fail(first!);
  expect(retry.status).toBe("retrying");
  if (retry.status !== "retrying") throw new Error("expected a retry");
  expect(retry.availableAt).toBeGreaterThan(first!.reservedAt + 900);
  expect(retry.availableAt).toBeLessThan(first!.reservedAt + 10_000);
  await withDatabase(async orm => orm.em.getConnection().execute("update bundle_jobs set available_at = 0 where id = ?", [id]), { root, env });
  const second = await queue.claim("default");
  expect(second).toMatchObject({ id, attempts: 2 });
  expect(await queue.fail(second!)).toEqual({ status: "failed" });
  const rows = await withDatabase(async orm => orm.em.getConnection().execute<Array<{ attempts: number; failure_code: string; failed_at: number; payload_json: string }>>(
    "select attempts, failure_code, failed_at, payload_json from bundle_jobs where id = ?", [id]), { root, env });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ attempts: 2, failure_code: "handler_failed", payload_json: '{"address":"person@example.test"}' });
  expect(rows[0]!.failed_at).toBeGreaterThan(first!.reservedAt);
  expect(JSON.stringify(rows)).not.toContain("SECRET");
});

test("expired final attempts become terminal, and stale failure reports do not alter a new lease", async () => {
  const { queue, env, root } = await fixture();
  const id = await queue.enqueue("default", "index.rebuild", { index: "catalog" }, { maxAttempts: 1 });
  const first = await queue.claim("default");
  await expireLease(env, root, first!);
  expect(await queue.claim("default")).toBeNull();
  const rows = await withDatabase(async orm => orm.em.getConnection().execute<Array<{ failed_at: number | null; failure_code: string | null }>>(
    "select failed_at, failure_code from bundle_jobs where id = ?", [id]), { root, env });
  expect(rows[0]!.failed_at).toBeGreaterThan(first!.reservedAt);
  expect(rows[0]).toMatchObject({ failure_code: "attempts_exhausted" });
  expect(await queue.fail(first!)).toEqual({ status: "lost" });
});

test("payloads, queue names, job names and retry options are bounded before writes", async () => {
  const { queue, env, root } = await fixture();
  await expect(queue.enqueue("default", "email.send", { body: "x".repeat(17_000) })).rejects.toThrow("16 KiB");
  for (const queueName of ["", "Upper", "../escape", "a".repeat(65)]) {
    await expect(queue.enqueue(queueName, "email.send", {})).rejects.toThrow("queue name");
  }
  for (const type of ["", "../escape", "a".repeat(129)]) {
    await expect(queue.enqueue("default", type, {})).rejects.toThrow("job type");
  }
  await expect(queue.enqueue("default", "email.send", {}, { maxAttempts: 21 })).rejects.toThrow("maxAttempts");
  await expect(queue.enqueue("default", "email.send", {}, { delayMs: -1 })).rejects.toThrow("delayMs");
  expect(await countRows(env, root)).toEqual([{ count: 0 }]);
});

test("concurrent workers atomically reserve distinct jobs", async () => {
  const { queue } = await fixture();
  await queue.enqueue("default", "cleanup.one", { id: 1 });
  await queue.enqueue("default", "cleanup.two", { id: 2 });
  const claims = await Promise.all([queue.claim("default"), queue.claim("default")]);
  expect(claims.every(Boolean)).toBe(true);
  expect(new Set(claims.map(job => job!.id)).size).toBe(2);
});

test("job timestamps use the configured SQLite clock, not a worker-supplied skewed clock", async () => {
  const { root, env } = await fixture();
  const options = Object.assign({ root, env }, { now: () => 1 });
  const queue = createSqliteQueue(options);
  const id = await queue.enqueue("default", "clock.check", {});
  const rows = await withDatabase(async orm => orm.em.getConnection().execute<Array<{ created_at: number; available_at: number }>>(
    "select created_at, available_at from bundle_jobs where id = ?", [id]), { root, env });
  expect(rows[0]!.created_at).toBeGreaterThan(1_600_000_000_000);
  expect(rows[0]!.available_at).toBe(rows[0]!.created_at);
});

test("the durable queue refuses unimplemented database drivers before connecting", async () => {
  const queue = createSqliteQueue({ root: "/unused", env: { DB_CONNECTION: "postgresql", DB_DATABASE: "jobs" } });
  await expect(queue.enqueue("default", "reports.build", {})).rejects.toThrow("SQLite only");
  await expect(queue.claim()).rejects.toThrow("SQLite only");
});
