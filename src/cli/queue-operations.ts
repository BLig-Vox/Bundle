import { CommanderError, InvalidArgumentError, type Command } from "commander";
import { openLocalQueue } from "../queue/opening.ts";
import type { FailureScope } from "../queue/store.ts";
import { loadApplicationEvents } from "../events/cache.ts";

const MAX_TIME = 8_640_000_000_000_000;
function queueName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new InvalidArgumentError("Invalid queue name.");
  return value;
}
function bounded(max: number): (value: string) => number {
  return value => {
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new InvalidArgumentError(`Expected an integer from 0 to ${max}.`);
    return Number(value);
  };
}
function scope(options: { queue?: string; all?: boolean }): FailureScope {
  if ((options.queue !== undefined) === (options.all === true)) throw new Error("Select exactly one of --queue or --all.");
  return options.queue !== undefined ? { queue: options.queue } : { all: true };
}
export function registerQueueOperations(program: Command, context: { root: string; output: (text: string) => void; signal?: AbortSignal }): void {
  const force = () => { if (program.opts().force !== true) throw new Error("Queue deletion requires --force."); };
  program.command("queue:monitor").description("Snapshot local queue counts")
    .requiredOption("--queue <name>", "Queue to inspect", queueName)
    .option("--max <count>", "Maximum active jobs", bounded(Number.MAX_SAFE_INTEGER))
    .action(async (options: { queue: string; max?: number }) => {
      const store = await openLocalQueue(context.root);
      try {
        const counts = store.snapshot(options.queue);
        const active = counts.ready + counts.delayed + counts.reserved + counts.expired;
        const exceeded = options.max !== undefined && active > options.max;
        const metadata = { queue: options.queue, ...counts, ...(options.max === undefined ? {} : { max: options.max, exceeded }) };
        context.output(JSON.stringify(metadata));
        if (exceeded) {
          try {
            const events = await loadApplicationEvents(context.root);
            await events.dispatch("queue.busy", metadata, context.signal);
          } catch {
            throw new Error("Queue threshold event dispatch failed.");
          }
          throw new CommanderError(1, "bundle.queueThreshold", "Queue threshold exceeded.");
        }
      } finally { store.close(); }
    });
  program.command("queue:clear <queue>").description("Delete only unreserved jobs in a queue; requires --force")
    .action(async (raw: string) => {
      const queue = queueName(raw); force();
      const store = await openLocalQueue(context.root);
      try { context.output(JSON.stringify({ queue, removed: store.clear(queue) })); } finally { store.close(); }
    });
  program.command("queue:flush").description("Delete scoped failed history; requires --force")
    .option("--queue <name>", "Queue to select", queueName).option("--all", "Select all queues")
    .action(async (options: { queue?: string; all?: boolean }) => {
      const selected = scope(options); force();
      const store = await openLocalQueue(context.root);
      try { context.output(JSON.stringify({ ...selected, removed: store.flushFailed(selected) })); } finally { store.close(); }
    });
  program.command("queue:prune-failed").description("Delete scoped failures strictly before a cutoff; requires --force")
    .option("--queue <name>", "Queue to select", queueName).option("--all", "Select all queues")
    .requiredOption("--before <epoch-ms>", "Strict cutoff in epoch milliseconds", bounded(MAX_TIME))
    .action(async (options: { queue?: string; all?: boolean; before: number }) => {
      const selected = scope(options); force();
      const store = await openLocalQueue(context.root);
      try { context.output(JSON.stringify({ ...selected, before: options.before, removed: store.pruneFailed({ ...selected, before: options.before }) })); } finally { store.close(); }
    });
}
