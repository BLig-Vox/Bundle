import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { QueueStore } from "./store.ts";

/** A dedicated local queue, independent of DB_CONNECTION and ORM application databases. */
export async function openLocalQueue(root: string, options: {upgrade?: boolean} = {}): Promise<QueueStore> {
  const canonical = await realpath(root);
  const directory = join(canonical,".bundle-queue");
  try { await mkdir(directory,{mode:0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe local queue directory.");
  return new QueueStore(join(directory,"queue.sqlite"), Date.now, options);
}
