import { CommanderError, InvalidArgumentError, type Command } from 'commander';
import { listenQueue, validateListenOptions } from '../queue/listener.ts';

function bounded(min: number, max: number): (value: string) => number {
  return value => {
    const n = Number(value);
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`);
    return n;
  };
}
function queues(value: string): string[] {
  const names = value.split(',');
  if (names.length > 64 || names.some(name => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))) throw new InvalidArgumentError('Expected comma-separated queue names.');
  return names;
}

export function registerQueueListen(program: Command, context: {root: string; env: NodeJS.ProcessEnv; output?: (text: string) => void; error?: (text: string) => void; signal?: AbortSignal}): void {
  program.command('queue:listen').description('Run one fresh local queue worker per cycle')
    .option('--queue <names>', 'Queue priority order', queues, ['default'])
    .option('--sleep <milliseconds>', 'Delay after every cycle', bounded(1, 2_147_483_647), 1000)
    .option('--timeout <milliseconds>', 'Job timeout', bounded(1, 86_399_000), 60_000)
    .option('--tries <count>', 'Maximum job attempts', bounded(1, 100))
    .option('--backoff <milliseconds>', 'Retry delay', bounded(0, 2_592_000_000), 1000)
    .option('--max-cycles <count>', 'Stop after child invocations', bounded(1, Number.MAX_SAFE_INTEGER))
    .action(async (flags: {queue:string[]; sleep:number; timeout:number; tries?:number; backoff:number; maxCycles?:number}) => {
      const options = {root: context.root, env: context.env, queues: flags.queue, sleepMs: flags.sleep, timeoutMs: flags.timeout, maxAttempts: flags.tries, retryDelayMs: flags.backoff, maxCycles: flags.maxCycles, output: context.output, error: context.error};
      validateListenOptions(options);
      const controller = new AbortController();
      let status = 0;
      const abort = () => controller.abort(context.signal?.reason);
      const interrupt = () => { status ||= 130; controller.abort(new Error('SIGINT')); };
      const terminate = () => { status ||= 143; controller.abort(new Error('SIGTERM')); };
      context.signal?.addEventListener('abort', abort, {once:true});
      if (context.signal?.aborted) abort();
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      try {
        await listenQueue({...options, signal: controller.signal});
        if (status) throw new CommanderError(status, 'bundle.queueListenExit', 'Queue listener stopped by a signal.');
      } finally {
        context.signal?.removeEventListener('abort', abort);
        process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      }
    });
}
