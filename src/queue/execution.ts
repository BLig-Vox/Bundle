import type { QueueJob } from "./store.ts";
export type ExecutableJob = QueueJob | null;
export interface JobExecutionResult { readonly status: "completed" | "failed" | "cancelled" | "timed-out"; readonly commandExitCode?: number }

/** Execute trusted application code only in an owned worker, never the embedding host. */
export async function runQueuedJob(options: {root: string; job: ExecutableJob; timeoutMs?: number; signal?: AbortSignal}): Promise<JobExecutionResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Job timeout must be a positive bounded millisecond integer.");
  if (options.signal?.aborted) return {status:"cancelled"};
  let worker: Worker;
  try { worker = new Worker(new URL("./execution-worker.ts",import.meta.url).href); }
  catch { return {status:"failed"}; }
  return new Promise<JobExecutionResult>(resolve => {
    let outcome: JobExecutionResult | undefined;
    let stopping: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => interrupt("timed-out"),timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout); clearTimeout(stopping);
      options.signal?.removeEventListener("abort",abort);
    };
    const interrupt = (status: "cancelled" | "timed-out") => {
      if (outcome) return;
      outcome = {status};
      worker.postMessage({type:"abort"});
      // Cooperative cleanup first; synchronous loops/imports cannot pin the host.
      stopping = setTimeout(() => worker.terminate(),250);
    };
    const abort = () => interrupt("cancelled");
    worker.addEventListener("error",event => { event.preventDefault(); outcome ??= {status:"failed"}; worker.terminate(); });
    worker.addEventListener("message",event => {
      if (event.data?.type !== "done" || !["completed","failed"].includes(event.data.status)) return;
      const code = event.data.commandExitCode;
      outcome ??= Number.isInteger(code) && code >= 0 && code <= 255 ? {status:event.data.status, commandExitCode:code} : {status:event.data.status};
      worker.terminate();
    });
    worker.addEventListener("close",() => { cleanup(); resolve(outcome ?? {status:"failed"}); });
    options.signal?.addEventListener("abort",abort,{once:true});
    if (options.signal?.aborted) abort();
    else {
      try { worker.postMessage({type:"start",root:options.root,job:options.job}); }
      catch { outcome ??= {status:"failed"}; worker.terminate(); }
    }
  });
}
