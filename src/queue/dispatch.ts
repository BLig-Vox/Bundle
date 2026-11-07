import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openLocalQueue } from "./opening.ts";
import { encodeJob, prepareBatch, validateEnqueue, type BatchDispatch, type BatchEntry, type CommandQueueJob, type QueueJob } from "./store.ts";
import type { JobMiddlewareReference } from "./middleware-definitions.ts";

export async function dispatchBatch(options: {root: string; jobs: readonly BatchEntry[]}): Promise<BatchDispatch> {
  if (!options || typeof options.root !== "string" || !isAbsolute(options.root) || options.root.includes("\0")) throw new Error("An absolute project root is required");
  const entries = prepareBatch(options.jobs).map(entry => ({job: JSON.parse(entry.encoded) as QueueJob, queue: entry.queue, availableAt: entry.availableAt, maxAttempts: entry.maxAttempts}));
  const root = await realpath(options.root);
  const store = await openLocalQueue(root);
  try { return store.enqueueBatch(entries); } finally { store.close(); }
}

/** Persist explicit argv, which must not contain secrets. No environment or services are serialized. */
export async function dispatchCommand(options: {root: string; argv: readonly string[]; queue?: string; availableAt?: number; maxAttempts?: number; middleware?: readonly JobMiddlewareReference[]}): Promise<number> {
  if (!options || typeof options.root !== "string" || !isAbsolute(options.root) || options.root.includes("\0")) throw new Error("An absolute project root is required");
  const queue = options.queue ?? "default";
  const enqueueOptions = {availableAt: options.availableAt, maxAttempts: options.maxAttempts};
  validateEnqueue(queue, enqueueOptions);
  // Validation occurs before copying, so sparse arrays and accessors cannot be normalized away.
  const encoded = encodeJob({kind:"command",version:1,argv:options.argv as string[],...(options.middleware === undefined ? {} : {middleware:options.middleware})});
  const job = JSON.parse(encoded) as CommandQueueJob;
  const root = await realpath(options.root);
  const store = await openLocalQueue(root);
  try { return store.enqueue(queue, job, enqueueOptions); }
  finally { store.close(); }
}
