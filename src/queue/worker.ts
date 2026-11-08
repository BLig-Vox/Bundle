import { types } from "node:util";
import type { ClaimedJob, FailureResult } from "./sqlite.ts";
import type { ParseResult, Schema, Infer } from "../validation/schema.ts";

export type JobContext = Readonly<Pick<ClaimedJob, "id" | "queue" | "attempts">>;
type RuntimeDefinition = Readonly<{
  parse(input: unknown): ParseResult<unknown>;
  handle(payload: unknown, context: JobContext): void | Promise<void>;
}>;
type QueueWorkerApi = Pick<ReturnType<typeof import("./sqlite.ts").createSqliteQueue>, "claim" | "acknowledge" | "fail">;
type DispatchResult =
  | { status: "idle" }
  | { status: "processed" }
  | { status: "retrying" }
  | { status: "failed"; reason: "handler_failed" | "unregistered_job" | "invalid_payload" }
  | { status: "lost" };

const jobTypePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/** Create one statically registered job with schema-inferred handler input. */
export function defineJob<S extends Schema<unknown>>(
  validator: S,
  handler: (payload: Infer<S>, context: JobContext) => void | Promise<void>,
): RuntimeDefinition {
  if (!validator || typeof validator !== "object" || types.isProxy(validator)) throw new Error("Invalid job definition.");
  const prototype = Object.getPrototypeOf(validator);
  const parseMethod = Object.getOwnPropertyDescriptor(validator, "safeParse");
  if ((prototype !== Object.prototype && prototype !== null) || !parseMethod || !("value" in parseMethod)
    || typeof parseMethod.value !== "function" || typeof handler !== "function") {
    throw new Error("Invalid job definition.");
  }
  const safeParse = parseMethod.value as S["safeParse"];
  return Object.freeze({
    parse: (input: unknown) => safeParse(input),
    handle: (payload: unknown, context: JobContext) => handler(payload as Infer<S>, context),
  });
}

/** Snapshot a fixed object map; this never imports or discovers modules by job name. */
export function createJobRegistry(entries: Readonly<Record<string, RuntimeDefinition>>) {
  if (!entries || typeof entries !== "object" || types.isProxy(entries)) throw new Error("Invalid static job registry.");
  const prototype = Object.getPrototypeOf(entries);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid static job registry.");
  const handlers = new Map<string, RuntimeDefinition>();
  for (const key of Reflect.ownKeys(entries)) {
    if (typeof key !== "string" || !jobTypePattern.test(key)) throw new Error("Invalid job type in static registry.");
    const entry = Object.getOwnPropertyDescriptor(entries, key);
    if (!entry || !("value" in entry)) throw new Error("Invalid static job registry entry.");
    const definition = entry.value as RuntimeDefinition;
    if (!definition || typeof definition !== "object" || types.isProxy(definition)) throw new Error("Invalid static job definition.");
    const parse = Object.getOwnPropertyDescriptor(definition, "parse");
    const handle = Object.getOwnPropertyDescriptor(definition, "handle");
    if (!parse || !("value" in parse) || typeof parse.value !== "function"
      || !handle || !("value" in handle) || typeof handle.value !== "function") {
      throw new Error("Invalid static job definition.");
    }
    handlers.set(key, Object.freeze({ parse: parse.value, handle: handle.value }));
  }
  return Object.freeze({ get: (type: string) => handlers.get(type) });
}

function failureStatus(result: FailureResult, reason: "handler_failed" | "unregistered_job" | "invalid_payload"): DispatchResult {
  if (result.status === "lost") return { status: "lost" };
  return result.status === "retrying" ? { status: "retrying" } : { status: "failed", reason };
}

/** Claim and execute at most one due job; exceptions are intentionally not logged or persisted. */
export async function dispatchOne(
  queue: QueueWorkerApi,
  registry: ReturnType<typeof createJobRegistry>,
  queueName = "default",
): Promise<DispatchResult> {
  const job = await queue.claim(queueName);
  if (!job) return { status: "idle" };
  const definition = registry.get(job.type);
  if (!definition) return failureStatus(await queue.fail(job, "unregistered_job"), "unregistered_job");

  let payload: unknown;
  let parsed: ParseResult<unknown>;
  try {
    payload = JSON.parse(job.payloadJson) as unknown;
    parsed = definition.parse(payload);
  } catch {
    return failureStatus(await queue.fail(job, "invalid_payload"), "invalid_payload");
  }
  if (!parsed || parsed.success !== true) {
    return failureStatus(await queue.fail(job, "invalid_payload"), "invalid_payload");
  }

  try {
    await definition.handle(parsed.data, Object.freeze({ id: job.id, queue: job.queue, attempts: job.attempts }));
  } catch {
    return failureStatus(await queue.fail(job), "handler_failed");
  }
  return await queue.acknowledge(job) ? { status: "processed" } : { status: "lost" };
}
