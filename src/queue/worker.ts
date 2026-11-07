import { runQueuedJob, type JobExecutionResult } from "./execution.ts";
import type { QueueStore } from "./store.ts";
import { readQueueControl, validateQueueName } from "./control.ts";

export interface QueueWorkResult {
  readonly id: number;
  readonly queue: string;
  readonly attempt: number;
  readonly outcome: JobExecutionResult["status"];
  readonly settlement: "acknowledged" | "released" | "failed" | "cancelled";
  readonly commandExitCode?: number;
}
export interface QueueWorkOptions {
  root: string;
  store: QueueStore;
  queues?: readonly string[];
  signal?: AbortSignal;
  once?: boolean;
  stopWhenEmpty?: boolean;
  maxJobs?: number;
  maxAttempts?: number;
  sleepMs?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  onResult?: (result: QueueWorkResult) => void | Promise<void>;
}
function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid queue ${label}.`);
  return value;
}
async function idle(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort",finish); resolve(); };
    const timer = setTimeout(finish,milliseconds);
    signal.addEventListener("abort",finish,{once:true});
    if (signal.aborted) finish();
  });
}

/** Caller owns the store. Claims are at-least-once; never acknowledge an expired/lost receipt. */
export async function workQueue(options: QueueWorkOptions): Promise<{processed: number}> {
  const timeoutMs = bounded(options.timeoutMs ?? 60_000,1,86_399_000,"timeout");
  const sleepMs = bounded(options.sleepMs ?? 1000,1,2_147_483_647,"sleep");
  const retryDelayMs = bounded(options.retryDelayMs ?? 1000,0,30*24*60*60*1000,"backoff");
  const maxJobs = options.maxJobs === undefined ? Infinity : bounded(options.maxJobs,1,Number.MAX_SAFE_INTEGER,"job limit");
  const maxAttempts = options.maxAttempts === undefined ? undefined : bounded(options.maxAttempts,1,100,"max attempts");
  const leaseMs = Math.max(1000,timeoutMs+1000);
  const signal = options.signal ?? new AbortController().signal;
  const queues = options.queues ?? ["default"];
  if (!Array.isArray(queues) || !queues.length || queues.length > 64) throw new Error("Invalid queue list.");
  for (const queue of queues) validateQueueName(queue);
  let processed = 0;
  if (signal.aborted) return {processed};
  const baseline = (await readQueueControl(options.root)).restartToken;
  while (!signal.aborted && processed < maxJobs) {
    // Observe controls only between jobs: active work keeps its owner/lease and settles first.
    const control = await readQueueControl(options.root);
    if (signal.aborted || control.restartToken !== baseline) break;
    const selected = queues.filter(queue=>!control.pausedQueues.includes(queue));
    const reservation = selected.length ? options.store.reserve(selected,{leaseMs,maxAttempts}) : null;
    if (!reservation) {
      if (options.once || options.stopWhenEmpty) break;
      await idle(sleepMs,signal);
      continue;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort",abort,{once:true});
    if (signal.aborted) abort();
    let lost = false;
    const heartbeat = setInterval(() => {
      try { if (options.store.heartbeat(reservation.receipt,{leaseMs})) return; }
      catch { /* A failed renewal cannot prove continued ownership. */ }
      lost = true; controller.abort();
    },Math.min(1000,Math.floor(leaseMs/3)));
    let execution: JobExecutionResult;
    try { execution = await runQueuedJob({root:options.root,job:reservation.job,timeoutMs,signal:controller.signal}); }
    finally { clearInterval(heartbeat); signal.removeEventListener("abort",abort); }
    if (lost) throw new Error("Queue reservation ownership was lost; the owned job was stopped without acknowledging it.");
    const completed = execution.status === "completed";
    const settlement = completed
      ? (options.store.ack(reservation.receipt) ? "acknowledged" : null)
      : options.store.settle(reservation.receipt,{outcome:execution.status === "cancelled" ? "cancelled" : "failed",delayMs:execution.status === "cancelled" ? 0 : retryDelayMs});
    if (!settlement) throw new Error("Queue reservation ownership expired before settlement; no successful acknowledgment is claimed.");
    processed++;
    await options.onResult?.({id:reservation.id,queue:reservation.queue,attempt:reservation.attempt,outcome:execution.status,settlement,...(execution.commandExitCode === undefined ? {} : {commandExitCode:execution.commandExitCode})});
    if (options.once) break;
  }
  return {processed};
}
