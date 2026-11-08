import { dispatchOne } from "bundle/src/queue/worker.ts";
import { jobs } from "../src/jobs/registry.ts";
import { queue } from "../src/queue.ts";

try {
  const result = await dispatchOne(queue, jobs);
  console.log(JSON.stringify(result));
} catch {
  console.error("Queue worker failed; verify the database configuration and migrations.");
  process.exitCode = 1;
}
