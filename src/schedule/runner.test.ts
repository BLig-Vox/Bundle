import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCommandLock } from '../console/isolation.ts';
import { runDueSchedules, runScheduledTask, workSchedules } from './runner.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(expression = '* * * * *', extra = '') {
  const root = await mkdtemp(join(tmpdir(), 'bundle-schedule-run-')); roots.push(root);
  await mkdir(join(root, 'src', 'commands'), {recursive:true});
  await writeFile(join(root, 'schedule.ts'), `export default [{id:'report',argv:['report:daily','literal space;not-shell'],expression:${JSON.stringify(expression)}}${extra}];`);
  await writeFile(join(root, 'src', 'commands', 'Report.ts'), `import {appendFile} from 'node:fs/promises';import {join} from 'node:path';export default {name:'report:daily',description:'Scheduled fixture',arguments:[{name:'value'}],async handle(i:any,c:any){await appendFile(join(c.root,'ran'),JSON.stringify(i.args.value)+'\\n');c.output('private-output');}};`);
  return root;
}
const at = () => new Date('2026-11-07T12:30:45Z');

test('selected execution ignores due expression but retains pause and owned overlap',async()=>{
 const {pauseSchedule,resumeSchedule}=await import('./control.ts');
 const root=await fixture('0 0 31 2 *');
 expect((await runDueSchedules({root,at:at()})).results).toEqual([]);
 await pauseSchedule(root);
 expect((await runScheduledTask({root,id:'report'})).results).toEqual([{id:'report',outcome:'skipped-paused'}]);
 expect(await Bun.file(join(root,'ran')).exists()).toBe(false);
 await resumeSchedule(root);
 const release=await acquireCommandLock(root,'schedule:report');
 try{expect((await runScheduledTask({root,id:'report'})).results).toEqual([{id:'report',outcome:'skipped-overlap'}]);}
 finally{await release!();}
 expect((await runScheduledTask({root,id:'report'})).results).toEqual([{id:'report',outcome:'completed',exitCode:0}]);
 expect((await readFile(join(root,'ran'),'utf8')).trim().split('\n')).toHaveLength(1);
});

test('selected unknown invalid cancelled or recursive tasks never enter execution',async()=>{
 const root=await fixture();
 for(const id of ['missing','bad id',''])await expect(runScheduledTask({root,id})).rejects.toThrow();
 await expect(runScheduledTask({root,id:'report',signal:AbortSignal.abort()})).rejects.toThrow();
 expect(await Bun.file(join(root,'ran')).exists()).toBe(false);
 const recursive=await fixture('* * * * *',",{id:'recursive',argv:['schedule:test','--task','recursive'],expression:'* * * * *'}");
 await expect(runScheduledTask({root:recursive,id:'recursive'})).rejects.toThrow();
 expect(await readdir(recursive)).not.toContain('.bundle-command-locks');
});

test('due execution consumes exact argv and releases owned overlap lock', async () => {
  const root = await fixture();
  const result = await runDueSchedules({root, at:at(), env:{DB_CONNECTION:'invalid'}});
  expect(result.status).toBe(0);
  expect(result.results).toEqual([{id:'report',outcome:'completed',exitCode:0}]);
  expect(await readFile(join(root,'ran'),'utf8')).toBe('"literal space;not-shell"\n');
  expect(await readdir(join(root,'.bundle-command-locks'))).toEqual([]);
});

test('non-due and contended schedules do not invoke command handlers', async () => {
  const root = await fixture('31 * * * *');
  expect((await runDueSchedules({root,at:at()})).results).toEqual([]);
  expect(await Bun.file(join(root,'ran')).exists()).toBe(false);
  const dueRoot = await fixture();
  const release = await acquireCommandLock(dueRoot,'schedule:report');
  try {
    expect((await runDueSchedules({root:dueRoot,at:at()})).results).toEqual([{id:'report',outcome:'skipped-overlap'}]);
    expect(await Bun.file(join(dueRoot,'ran')).exists()).toBe(false);
  } finally { await release!(); }
});

test('failure statuses stay failed and later due work still executes', async () => {
  const root = await fixture('* * * * *', ",{id:'bad',argv:['report:fail'],expression:'* * * * *'}");
  await writeFile(join(root,'src','commands','Fail.ts'), `export default {name:'report:fail',description:'Failure',handle(){return 7;}};`);
  const result = await runDueSchedules({root,at:at()});
  expect(result.status).toBe(1);
  expect(result.results).toEqual([{id:'report',outcome:'completed',exitCode:0},{id:'bad',outcome:'failed',exitCode:7}]);
});

test('pre-cancelled and invalid options create no scheduler locks or work', async () => {
  const root = await fixture(); const signal = AbortSignal.abort();
  await expect(runDueSchedules({root,at:at(),signal})).rejects.toThrow();
  await expect(runDueSchedules({root,at:new Date(NaN)})).rejects.toThrow();
  await expect(workSchedules({root,maxCycles:0})).rejects.toThrow();
  expect(await Bun.file(join(root,'ran')).exists()).toBe(false);
  expect(await readdir(root)).not.toContain('.bundle-command-locks');
});

test('work never replays an observed minute including backward clock movement', async () => {
  const root = await fixture(); let index=0;
  const times=['2026-11-07T12:30:00Z','2026-11-07T12:30:59Z','2026-11-07T12:29:00Z','2026-11-07T12:31:00Z'];
  const result=await workSchedules({root,maxCycles:4,sleepMs:1,now:()=>new Date(times[index++]!)});
  expect(result).toEqual({cycles:4,runs:2,failedRuns:0});
  expect((await readFile(join(root,'ran'),'utf8')).trim().split('\n')).toHaveLength(2);
});

test('work cancellation during root resolution never starts trusted schedule imports', async () => {
  const root = await fixture();
  const marker = join(root, 'import-side-effect');
  await writeFile(join(root, 'schedule.ts'), `await Bun.write(${JSON.stringify(marker)},'imported');export default [];`);
  const controller = new AbortController();
  const pending = workSchedules({root,signal:controller.signal,maxCycles:1});
  queueMicrotask(() => controller.abort());
  await expect(pending).rejects.toThrow();
  expect(await Bun.file(marker).exists()).toBe(false);
});

test('first pause publication does not masquerade as scheduler interruption', async () => {
  const {pauseSchedule}=await import('./control.ts');
  const root=await fixture();let index=0;let paused=false;const outcomes:string[]=[];
  const slots=['2026-11-07T12:30:00Z','2026-11-07T12:31:00Z','2026-11-07T12:32:00Z'];
  const result=await workSchedules({root,sleepMs:1,maxCycles:3,now:()=>new Date(slots[index++]!),onResult:async row=>{
    outcomes.push(...row.results.map(item=>item.outcome));
    if(!paused){paused=true;await pauseSchedule(root);}
  }});
  expect(result).toEqual({cycles:3,runs:3,failedRuns:0});
  expect(outcomes).toEqual(['completed','skipped-paused','skipped-paused']);
});

test('work resumes only future observed slots after a paused minute', async () => {
  const {pauseSchedule,resumeSchedule}=await import('./control.ts');
  const root=await fixture();await pauseSchedule(root);
  let index=0;const outcomes:string[]=[];
  const slots=['2026-11-07T12:30:00Z','2026-11-07T12:30:59Z','2026-11-07T12:31:00Z'];
  const result=await workSchedules({root,sleepMs:1,maxCycles:3,now:()=>new Date(slots[index++]!),onResult:async row=>{
    outcomes.push(...row.results.map(item=>item.outcome));
    if(outcomes.length===1)await resumeSchedule(root);
  }});
  expect(result).toEqual({cycles:3,runs:2,failedRuns:0});
  expect(outcomes).toEqual(['skipped-paused','completed']);
  expect((await readFile(join(root,'ran'),'utf8')).trim().split('\n')).toHaveLength(1);
});

test('corrupt scheduler control refuses before trusted schedule source import', async () => {
  const root=await fixture();const marker=join(root,'import-side-effect');
  await writeFile(join(root,'schedule.ts'),`await Bun.write(${JSON.stringify(marker)},'bad');export default [];`);
  await mkdir(join(root,'.bundle-schedule'),{mode:0o700});
  await writeFile(join(root,'.bundle-schedule','control.json'),'private-corrupt-control',{mode:0o600});
  await expect(runDueSchedules({root,at:at()})).rejects.toThrow();
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await readFile(join(root,'.bundle-schedule','control.json'),'utf8')).toBe('private-corrupt-control');
});

test('direct scheduler recursion refuses before any command or lock', async () => {
  const root = await fixture('* * * * *', ",{id:'recursive',argv:['schedule:run'],expression:'* * * * *'}");
  await expect(runDueSchedules({root,at:at()})).rejects.toThrow();
  expect(await Bun.file(join(root,'ran')).exists()).toBe(false);
  expect(await readdir(root)).not.toContain('.bundle-command-locks');
});
