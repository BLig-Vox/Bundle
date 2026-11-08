import { afterEach, expect, test } from "bun:test";
import { databaseFixture } from "../database/testing.ts";
import { withDatabase } from "../database/connection.ts";
import { schema } from "../validation/schema.ts";
import type { Schema } from "../validation/schema.ts";
import { createSqliteQueue } from "./sqlite.ts";
import { createJobRegistry, defineJob, dispatchOne } from "./worker.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const { root, env, cleanup } = await databaseFixture();
  cleanups.push(cleanup);
  await withDatabase(async orm => {
    await orm.em.getConnection().execute(`create table bundle_jobs (
      id integer primary key autoincrement, queue_name text not null, job_type text not null,
      payload_json text not null, available_at integer not null, reserved_at integer,
      reservation_token text, attempts integer not null default 0, max_attempts integer not null,
      failed_at integer, failure_code text, created_at integer not null
    )`);
  }, { root, env });
  return { root, env, queue: createSqliteQueue({ root, env }) };
}

async function rows(root: string, env: Record<string, string | undefined>) {
  return withDatabase(async orm => orm.em.getConnection().execute<Array<{
    failed_at: number | null; failure_code: string | null; attempts: number; payload_json: string;
  }>>("select failed_at, failure_code, attempts, payload_json from bundle_jobs order by id"), { root, env });
}

test("static registered jobs validate payloads before invoking typed handlers and acknowledge success", async () => {
  const { queue, root, env } = await fixture();
  const handled: Array<{ reportId: number; attempt: number }> = [];
  const registry = createJobRegistry({
    "reports.generate": defineJob(schema.object({ reportId: schema.number({ integer: true, min: 1 }) }), async (payload, context) => {
      handled.push({ ...payload, attempt: context.attempts });
    }),
  });
  await queue.enqueue("default", "reports.generate", { reportId: 42 });
  expect(await dispatchOne(queue, registry)).toEqual({ status: "processed" });
  expect(handled).toEqual([{ reportId: 42, attempt: 1 }]);
  expect(await rows(root, env)).toEqual([]);
});

test("unknown job types fail terminally without importing or retrying a handler", async () => {
  const { queue, root, env } = await fixture();
  await queue.enqueue("default", "reports.missing", { reportId: 7 }, { maxAttempts: 5 });
  expect(await dispatchOne(queue, createJobRegistry({}))).toEqual({ status: "failed", reason: "unregistered_job" });
  expect(await rows(root, env)).toMatchObject([{ failure_code: "unregistered_job", attempts: 1 }]);
  expect(await dispatchOne(queue, createJobRegistry({}))).toEqual({ status: "idle" });
});

test("invalid persisted payloads fail terminally without calling the handler", async () => {
  const { queue, root, env } = await fixture();
  let called = false;
  const registry = createJobRegistry({
    "reports.generate": defineJob(schema.object({ reportId: schema.number({ integer: true, min: 1 }) }), () => { called = true; }),
  });
  await queue.enqueue("default", "reports.generate", { reportId: "not-an-integer" });
  expect(await dispatchOne(queue, registry)).toEqual({ status: "failed", reason: "invalid_payload" });
  expect(called).toBe(false);
  expect(await rows(root, env)).toMatchObject([{ failure_code: "invalid_payload", attempts: 1 }]);
});

test("handler exceptions are retried without persisting exception messages", async () => {
  const { queue, root, env } = await fixture();
  const registry = createJobRegistry({
    "reports.generate": defineJob(schema.object({ reportId: schema.number({ integer: true }) }), () => { throw new Error("SECRET handler details"); }),
  });
  await queue.enqueue("default", "reports.generate", { reportId: 42 });
  expect(await dispatchOne(queue, registry)).toEqual({ status: "retrying" });
  const stored = JSON.stringify(await rows(root, env));
  expect(stored).not.toContain("SECRET");
  expect(stored).not.toContain("handler details");
});

test("job definitions reject schema accessors without executing them", () => {
  let accessed = false;
  const hostile = Object.defineProperty({}, "safeParse", { get() { accessed = true; throw new Error("SECRET getter"); } });
  expect(() => defineJob(hostile as unknown as Schema<unknown>, () => {})).toThrow("Invalid job definition");
  expect(accessed).toBe(false);
});

test("job registry snapshots entries and rejects invalid registered names", async () => {
  const definition = defineJob(schema.object({}), () => {});
  const entries = { "reports.generate": definition };
  const registry = createJobRegistry(entries);
  entries["reports.generate"] = defineJob(schema.object({}), () => { throw new Error("mutated"); });
  const { queue } = await fixture();
  await queue.enqueue("default", "reports.generate", {});
  expect(await dispatchOne(queue, registry)).toEqual({ status: "processed" });
  expect(() => createJobRegistry({ "../escape": definition })).toThrow("job type");
});
