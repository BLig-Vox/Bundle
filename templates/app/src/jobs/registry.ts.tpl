import { createJobRegistry } from "bundle/src/queue/worker.ts";

/** Add statically imported, schema-validated jobs here; no runtime discovery. */
export const jobs = createJobRegistry({});
