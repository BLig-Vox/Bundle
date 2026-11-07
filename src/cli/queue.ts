import { CommanderError, InvalidArgumentError, type Command } from "commander";
import { openLocalQueue } from "../queue/opening.ts";
import { workQueue } from "../queue/worker.ts";

function integer(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError("Expected a bounded nonnegative integer.");
  return Number(value);
}
function boundedInteger(min: number, max: number): (value: string) => number {
  return value => {
    const number = integer(value);
    if (number < min || number > max) throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`);
    return number;
  };
}
function queues(value: string): string[] {
  const names = value.split(",");
  if (!names.length || names.length > 64 || names.some(name => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))) throw new InvalidArgumentError("Expected comma-separated queue names.");
  return names;
}
export function registerQueue(program: Command, context: {root: string; output: (text: string) => void; signal?: AbortSignal}): void {
  program.command("queue:work").description("Consume dedicated local SQLite jobs in owned workers; delivery is at least once")
    .option("--queue <names>","Queue priority order, comma-separated",queues,["default"])
    .option("--once","Attempt at most one currently available job")
    .option("--stop-when-empty","Stop when no selected job is currently due")
    .option("--max-jobs <count>","Stop after this many attempted jobs",boundedInteger(1,Number.MAX_SAFE_INTEGER))
    .option("--tries <count>","Maximum attempts for newly claimed jobs",boundedInteger(1,100))
    .option("--sleep <milliseconds>","Idle poll interval in milliseconds",boundedInteger(1,2_147_483_647),1000)
    .option("--timeout <milliseconds>","Owned job lifetime limit in milliseconds",boundedInteger(1,86_399_000),60_000)
    .option("--backoff <milliseconds>","Delay failed attempts before retry eligibility",boundedInteger(0,30*24*60*60*1000),1000)
    .action(async (options: {queue: string[]; once?: boolean; stopWhenEmpty?: boolean; maxJobs?: number; tries?: number; sleep: number; timeout: number; backoff: number}) => {
      const controller = new AbortController();
      let status = 0;
      const abort = () => controller.abort(context.signal?.reason);
      const interrupt = () => { status ||= 130; controller.abort(); };
      const terminate = () => { status ||= 143; controller.abort(); };
      context.signal?.addEventListener("abort",abort,{once:true});
      if (context.signal?.aborted) abort();
      process.on("SIGINT",interrupt); process.on("SIGTERM",terminate);
      let store: Awaited<ReturnType<typeof openLocalQueue>> | undefined;
      try {
        store = await openLocalQueue(context.root);
        await workQueue({root:context.root,store,queues:options.queue,once:options.once,stopWhenEmpty:options.stopWhenEmpty,maxJobs:options.maxJobs,maxAttempts:options.tries,sleepMs:options.sleep,timeoutMs:options.timeout,retryDelayMs:options.backoff,signal:controller.signal,onResult:result=>context.output(JSON.stringify(result))});
        if (status) throw new CommanderError(status,"bundle.queueExit","Queue worker was stopped by a signal.");
      } finally {
        store?.close();
        context.signal?.removeEventListener("abort",abort);
        process.off("SIGINT",interrupt); process.off("SIGTERM",terminate);
      }
    });
  program.command("queue:failed").description("Page through local failed-job metadata, never payloads")
    .option("--queue <name>","Filter one queue",value=>{
      const selected=queues(value);
      if(selected.length!==1)throw new InvalidArgumentError("Expected one queue name.");
      return selected[0]!;
    })
    .option("--limit <count>","Page size from 1 to 1000",boundedInteger(1,1000),1000)
    .option("--after <id>","Continue after a numeric job ID",boundedInteger(0,Number.MAX_SAFE_INTEGER),0)
    .action(async (options: {queue?: string;limit:number;after:number}) => {
      const store = await openLocalQueue(context.root);
      try {
        const page=store.failedPage({queue:options.queue,limit:options.limit,afterId:options.after});
        context.output(JSON.stringify({failed:page.failed.map(row=>({id:row.id,queue:row.queue,attempts:row.attempts,failedAt:row.failedAt,reason:"Recorded job failure"})),nextAfterId:page.nextAfterId}));
      } finally { store.close(); }
    });
  program.command("queue:retry <id>").description("Requeue one local failed job and reset its attempts")
    .action(async (raw: string) => {
      const id = integer(raw);
      const store = await openLocalQueue(context.root);
      try { context.output(JSON.stringify({id,retried:store.retry(id)})); } finally { store.close(); }
    });
  program.command("queue:forget <id>").description("Remove one local failed job; requires --force")
    .action(async (raw: string) => {
      if (program.opts().force !== true) throw new Error("Failed-job deletion requires --force.");
      const id = integer(raw);
      const store = await openLocalQueue(context.root);
      try { context.output(JSON.stringify({id,removed:store.forgetFailed(id)})); } finally { store.close(); }
    });
}
