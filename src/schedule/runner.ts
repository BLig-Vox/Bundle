import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { acquireScheduleLock } from './locks.ts';
import { createPrompts } from '../console/prompts.ts';
import { compileCron, isCronDue } from './cron.ts';
import { defineSchedules, loadSchedules, type ScheduleDefinition } from './definitions.ts';
import { readScheduleControl } from './control.ts';

export interface ScheduleResult {
  id: string;
  outcome: 'completed' | 'failed' | 'skipped-overlap' | 'skipped-paused' | 'cancelled';
  exitCode?: number;
}
export interface ScheduleRunResult {
  scheduledAt: string;
  status: number;
  results: ScheduleResult[];
  interrupted?: true;
}
export interface RunScheduleOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  at?: Date;
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Schedule cancelled.');
}
function minute(at: Date): number {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error('Invalid schedule time.');
  return Math.floor(at.getTime() / 60_000) * 60_000;
}
async function canonicalRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Schedule root must be absolute.');
  try { return await realpath(root); } catch { throw new Error('Invalid schedule root.'); }
}
function checkedDefinitions(definitions: readonly ScheduleDefinition[]): readonly ScheduleDefinition[] {
  const copied = defineSchedules(definitions);
  // A fresh runCli would reset recursion depth; refuse accidental direct scheduler recursion.
  if (copied.some(task => task.argv[0] === 'schedule:run' || task.argv[0] === 'schedule:work' || task.argv[0] === 'schedule:test')) throw new Error('Recursive scheduler target refused.');
  return copied;
}

/** Metadata only: explicit argv may contain secrets and is not included. */
export function listSchedules(definitions: readonly ScheduleDefinition[], at: Date) {
  const date = new Date(minute(at));
  return checkedDefinitions(definitions).map(task => ({
    id: task.id, expression: task.expression, timezone: 'UTC' as const,
    overlap: task.overlap ?? 'skip', due: isCronDue(compileCron(task.expression), date),
  }));
}

async function runSlot(root: string, definitions: readonly ScheduleDefinition[], options: RunScheduleOptions, at: Date, generation: string): Promise<ScheduleRunResult> {
  const time = new Date(minute(at));
  const tasks = checkedDefinitions(definitions);
  checkSignal(options.signal);
  const result: ScheduleRunResult = { scheduledAt: time.toISOString(), status: 0, results: [] };
  for (const task of tasks) {
    if (!isCronDue(compileCron(task.expression), time)) continue;
    if (options.signal?.aborted) break;
    const control = await readScheduleControl(root);
    if (options.signal?.aborted) break;
    if (control.generation !== generation) { result.interrupted = true; break; }
    if (control.paused) { result.results.push({id:task.id,outcome:'skipped-paused'}); continue; }
    let release: null | (() => Promise<void>) = null;
    try {
      if (task.overlap !== 'allow') {
        release = await acquireScheduleLock(root, task.id);
        if (!release) { result.results.push({id:task.id,outcome:'skipped-overlap'}); continue; }
      }
      checkSignal(options.signal);
      const {runCli} = await import('../cli/runner.ts');
      checkSignal(options.signal);
      const prompts = createPrompts({ input: Readable.from([]), output: new Writable({write(_chunk,_encoding,callback){callback();}}) });
      const exitCode = await runCli(task.argv, {root,env:options.env,signal:options.signal,handleSignals:false,prompts,output:()=>{},error:()=>{}});
      if (options.signal?.aborted) result.results.push({id:task.id,outcome:'cancelled'});
      else result.results.push({id:task.id,outcome:exitCode === 0 ? 'completed' : 'failed',exitCode});
    } catch {
      result.results.push({id:task.id,outcome:options.signal?.aborted ? 'cancelled' : 'failed'});
    } finally {
      if (release) {
        try { await release(); }
        catch { throw new Error('Schedule lock release failed; inspect owned state.'); }
      }
    }
    if (options.signal?.aborted) break;
  }
  if (!options.signal?.aborted && !result.interrupted) {
    const control = await readScheduleControl(root);
    if (control.generation !== generation) result.interrupted = true;
  }
  if (options.signal?.aborted || result.results.some(row => row.outcome === 'failed' || row.outcome === 'cancelled')) result.status = 1;
  return result;
}

/** One selected minute, no persisted once-only guarantee or catch-up. Trusted work is cooperative. */
export async function runDueSchedules(options: RunScheduleOptions): Promise<ScheduleRunResult> {
  const at = new Date(minute(options.at ?? new Date()));
  checkSignal(options.signal);
  const root = await canonicalRoot(options.root);
  checkSignal(options.signal);
  const baseline = await readScheduleControl(root);
  checkSignal(options.signal);
  const definitions = checkedDefinitions(await loadSchedules(root));
  checkSignal(options.signal);
  return runSlot(root,definitions,options,at,baseline.generation);
}

/** Execute one explicit configured task irrespective of due time; controls/overlap still apply. */
export async function runScheduledTask(options: Omit<RunScheduleOptions, 'at'> & {id:string}): Promise<ScheduleRunResult> {
  if (typeof options.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(options.id)) throw new Error('Invalid scheduled task selection.');
  checkSignal(options.signal);
  const root = await canonicalRoot(options.root);
  checkSignal(options.signal);
  const baseline = await readScheduleControl(root);
  checkSignal(options.signal);
  const definitions = checkedDefinitions(await loadSchedules(root));
  checkSignal(options.signal);
  const task = definitions.find(item => item.id === options.id);
  if (!task) throw new Error('Scheduled task selection not found.');
  return runSlot(root,[{...task,expression:'* * * * *'}],options,new Date(),baseline.generation);
}

export interface WorkScheduleOptions extends Omit<RunScheduleOptions, 'at'> {
  sleepMs?: number;
  maxCycles?: number;
  /** Caller-provided clock; defaults to real wall time. */
  now?: () => Date;
  onResult?: (result: ScheduleRunResult) => void | Promise<void>;
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort',finish); resolve(); };
    const timer = setTimeout(finish,ms);
    signal?.addEventListener('abort',finish,{once:true});
    if (signal?.aborted) finish();
  });
}

/** Polls observed UTC minutes with an in-process high-water mark, not a persistent scheduler. */
export async function workSchedules(options: WorkScheduleOptions): Promise<{cycles:number;runs:number;failedRuns:number;interrupted?:true}> {
  const sleepMs = options.sleepMs ?? 1000;
  const maxCycles = options.maxCycles ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(sleepMs) || sleepMs < 1 || sleepMs > 2_147_483_647 || !Number.isSafeInteger(maxCycles) || maxCycles < 1 || (options.now !== undefined && typeof options.now !== 'function') || (options.onResult !== undefined && typeof options.onResult !== 'function')) throw new Error('Invalid scheduler work options.');
  checkSignal(options.signal);
  const root = await canonicalRoot(options.root);
  checkSignal(options.signal);
  const baseline = await readScheduleControl(root);
  checkSignal(options.signal);
  const definitions = checkedDefinitions(await loadSchedules(root));
  checkSignal(options.signal);
  let highWater = -Infinity;
  const counts: {cycles:number;runs:number;failedRuns:number;interrupted?:true} = {cycles:0,runs:0,failedRuns:0};
  while (!options.signal?.aborted && counts.cycles < maxCycles) {
    const control = await readScheduleControl(root);
    if (options.signal?.aborted) break;
    if (control.generation !== baseline.generation) { counts.interrupted = true; break; }
    let at: Date;
    try { at = options.now ? options.now() : new Date(); }
    catch { throw new Error('Schedule clock failed.'); }
    const slot = minute(at);
    counts.cycles++;
    if (slot > highWater) {
      highWater = slot;
      const result = await runSlot(root,definitions,options,new Date(slot),baseline.generation);
      counts.runs++;
      if (result.status !== 0) counts.failedRuns++;
      if (options.onResult) {
        try { await options.onResult(result); } catch { throw new Error('Schedule result output failed.'); }
      }
      if (result.interrupted) { counts.interrupted = true; break; }
    }
    if (counts.cycles < maxCycles && !options.signal?.aborted) await delay(sleepMs,options.signal);
  }
  return counts;
}
