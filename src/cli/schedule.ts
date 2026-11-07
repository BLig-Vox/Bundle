import { CommanderError, InvalidArgumentError, type Command } from 'commander';
import { loadSchedules } from '../schedule/definitions.ts';
import { listSchedules, runDueSchedules, runScheduledTask, workSchedules } from '../schedule/runner.ts';
import { createPrompts } from '../console/prompts.ts';

function utcDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new InvalidArgumentError('Expected an exact UTC ISO date/time ending Z.');
  const date = new Date(value);
  const normalized = value.includes('.') ? value.replace(/\.(\d+)Z$/, (_all, digits: string) => `.${digits.padEnd(3,'0')}Z`) : value.replace(/Z$/,'.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) throw new InvalidArgumentError('Invalid UTC schedule date/time.');
  return date;
}
function positive(value: string): number {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) throw new InvalidArgumentError('Expected a positive safe integer.');
  return number;
}
interface ScheduleCliContext {
  root: string;
  env: NodeJS.ProcessEnv;
  output: (text: string) => void;
  signal?: AbortSignal;
  handleSignals?: boolean;
  prompts?: ReturnType<typeof createPrompts>;
}
async function withSignals<T>(signal: AbortSignal | undefined, handleSignals: boolean | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let status = 0;
  const abort = () => controller.abort();
  const interrupt = () => { status ||= 130; controller.abort(); };
  const terminate = () => { status ||= 143; controller.abort(); };
  signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) abort();
  if (handleSignals !== false) { process.on('SIGINT',interrupt); process.on('SIGTERM',terminate); }
  try {
    const result = await work(controller.signal);
    if (status) throw new CommanderError(status,'bundle.scheduleSignal','Scheduler stopped by signal.');
    return result;
  } catch (error) {
    if (status) throw new CommanderError(status,'bundle.scheduleSignal','Scheduler stopped by signal.');
    throw error;
  } finally {
    signal?.removeEventListener('abort',abort);
    process.off('SIGINT',interrupt); process.off('SIGTERM',terminate);
  }
}
export function registerSchedule(program: Command, context: ScheduleCliContext): void {
  program.command('schedule:list').description('Inspect explicit UTC command schedules without executing')
    .option('--json','Output safe metadata as JSON')
    .option('--at <utc-iso>','Evaluate due metadata at an exact UTC time',utcDate)
    .action(async (flags: {json?:boolean;at?:Date}) => {
      context.signal?.throwIfAborted();
      const at = flags.at ?? new Date();
      const tasks = listSchedules(await loadSchedules(context.root),at);
      context.signal?.throwIfAborted();
      if (flags.json) context.output(JSON.stringify({scheduledAt:at.toISOString(),tasks}));
      else context.output(tasks.length ? tasks.map(row => `${row.id}\t${row.timezone}\t${row.expression}\t${row.due?'due':'not-due'}`).join('\n') : 'No schedules configured.');
    });
  program.command('schedule:run').description('Execute due commands for one UTC minute slot')
    .option('--at <utc-iso>','Select an exact UTC minute (no backfill)',utcDate)
    .action(async (flags:{at?:Date}) => {
      const result = await withSignals(context.signal, context.handleSignals, signal => runDueSchedules({root:context.root,env:context.env,signal,at:flags.at}));
      context.output(JSON.stringify(result));
      if (result.status !== 0) throw new CommanderError(1,'bundle.scheduleFailed','One or more scheduled tasks failed.');
    });
  program.command('schedule:test').description('Select and execute one configured task irrespective of due time')
    .option('--task <id>','Explicit task id (otherwise interactive selection)')
    .action(async (flags:{task?:string}) => {
      const result = await withSignals(context.signal,context.handleSignals,async signal => {
        signal.throwIfAborted();
        let id = flags.task;
        if (id === undefined) {
          const definitions = await loadSchedules(context.root);
          signal.throwIfAborted();
          if (!definitions.length) throw new Error('No scheduled tasks configured.');
          const prompts = context.prompts ?? createPrompts({input:process.stdin,output:process.stderr});
          id = await prompts.select({message:'Select a scheduled task',options:definitions.map(item=>({label:item.id,value:item.id})),signal});
          signal.throwIfAborted();
        }
        return runScheduledTask({root:context.root,id,env:context.env,signal});
      });
      context.output(JSON.stringify(result));
      if (result.status !== 0) throw new CommanderError(1,'bundle.scheduleFailed','Selected scheduled task failed.');
    });
  program.command('schedule:work').description('Poll observed UTC minutes with local deduplication')
    .option('--sleep <milliseconds>','Polling delay (1..2147483647)',positive,1000)
    .option('--max-cycles <count>','Stop after polling cycles',positive)
    .action(async (flags:{sleep:number;maxCycles?:number}) => {
      if (flags.sleep > 2_147_483_647) throw new InvalidArgumentError('Polling delay exceeds maximum.');
      const result = await withSignals(context.signal, context.handleSignals, signal => workSchedules({root:context.root,env:context.env,signal,sleepMs:flags.sleep,maxCycles:flags.maxCycles,onResult:row=>context.output(JSON.stringify(row))}));
      context.output(JSON.stringify(result));
      if (result.failedRuns) throw new CommanderError(1,'bundle.scheduleFailed','Scheduled work reported failures.');
    });
}
