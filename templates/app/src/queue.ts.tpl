import { createSqliteQueue } from "bundle/src/queue/sqlite.ts";
import { appRoot } from "./auth.ts";

/** Persistent SQLite queue primitives; migrate the bundle_jobs table before use. */
export const queue = createSqliteQueue({ root: appRoot });
export type { ClaimedJob, FailureResult } from "bundle/src/queue/sqlite.ts";
