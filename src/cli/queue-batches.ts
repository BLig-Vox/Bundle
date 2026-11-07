import { InvalidArgumentError, type Command } from "commander";
import { openLocalQueue } from "../queue/opening.ts";
import type { QueueStore } from "../queue/store.ts";

const MAX_TIME = 8_640_000_000_000_000;
function batchId(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new InvalidArgumentError("Expected a 32-character lowercase hexadecimal batch ID.");
  return value;
}
function cutoff(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_TIME) throw new InvalidArgumentError("Expected a bounded nonnegative epoch-millisecond cutoff.");
  return Number(value);
}

/** Batch metadata never exposes job payloads, command argv or trusted failure details. */
export function registerQueueBatches(program: Command, context: { root: string; output: (text: string) => void; signal?: AbortSignal }): void {
  const checkSignal = () => { if (context.signal?.aborted) throw new Error("Queue batch operation cancelled."); };
  const force = () => { if (program.opts().force !== true) throw new Error("Queue history deletion or schema upgrade requires --force."); };
  const useStore = async (operation: (store: QueueStore) => unknown, upgrade = false): Promise<void> => {
    checkSignal();
    let store: QueueStore | undefined;
    try {
      store = await openLocalQueue(context.root, upgrade ? { upgrade: true } : undefined);
      checkSignal();
      const result = operation(store);
      checkSignal();
      context.output(JSON.stringify(result));
    } catch {
      checkSignal();
      throw new Error("Local queue batch operation failed. Version1 queues require quiescing all old processes before explicit queue:upgrade --force; unsafe state must be inspected, never reset.");
    } finally { store?.close(); }
  };
  program.command("queue:batch <id>").description("Inspect persisted local batch counts, never job data")
    .action(async (raw: string) => {
      const id = batchId(raw);
      await useStore(store => {
        const status = store.getBatch(id);
        if (status === null) throw new Error("Unknown batch.");
        return status;
      });
    });
  program.command("queue:cancel-batch <id>").description("Prevent new batch claims without interrupting already-owned handlers")
    .action(async (raw: string) => {
      const id = batchId(raw);
      await useStore(store => {
        const status = store.cancelBatch(id);
        if (status === null) throw new Error("Unknown batch.");
        return status;
      });
    });
  program.command("queue:retry-batch <id>").description("Requeue only retained failures of a noncancelled local batch")
    .action(async (raw: string) => {
      const id = batchId(raw);
      await useStore(store => {
        const retried = store.retryBatch(id);
        if (retried === null) throw new Error("Unknown batch.");
        return { id, retried };
      });
    });
  program.command("queue:prune-batches").description("Delete only terminal batch history strictly before cutoff; requires --force")
    .requiredOption("--before <epoch-ms>", "Strict observed-finish cutoff in epoch milliseconds", cutoff)
    .action(async (options: { before: number }) => {
      force();
      await useStore(store => ({ before: options.before, removed: store.pruneBatches({ before: options.before }) }));
    });
  program.command("queue:upgrade").description("Explicitly upgrade a quiescent owned version1 queue; requires --force")
    .action(async () => {
      force();
      await useStore(() => ({ version: 2 }), true);
    });
}
