import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerScheduleControl } from './schedule-control.ts';
import { readScheduleControl } from '../schedule/control.ts';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
test('registered commands consume persistent control state', async()=>{
 const root=await mkdtemp(join(tmpdir(),'bundle-schedule-cli-')); roots.push(root);
 const output:string[]=[];
 async function run(command:string) { const program=new Command(); registerScheduleControl(program,{root,output:text=>output.push(text)}); await program.parseAsync(['bun','test',command]); return JSON.parse(output.pop()!); }
 expect((await run('schedule:pause')).paused).toBe(true);
 const previous=await readScheduleControl(root);
 expect((await run('schedule:interrupt')).generation).not.toBe(previous.generation);
 expect((await run('schedule:resume')).paused).toBe(false);
});

test('separate processes execute the registered command module', async () => {
 const root=await mkdtemp(join(tmpdir(),'bundle-schedule-cli-process-')); roots.push(root);
 const modulePath=join(import.meta.dir,'schedule-control.ts');
 const script=`import {Command} from 'commander'; import {registerScheduleControl} from ${JSON.stringify(modulePath)}; const p=new Command(); registerScheduleControl(p,{root:process.argv[1],output:console.log}); await p.parseAsync(['bun','test',...process.argv.slice(2)]);`;
 async function run(command:string, path=root) { const p=Bun.spawn([process.execPath,'-e',script,path,command],{cwd:join(import.meta.dir,'../..'),env:{...process.env,BUN_OPTIONS:''},stdout:'pipe',stderr:'pipe'}); const [status,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]); return {status,out,err}; }
 const pause=await run('schedule:pause'); expect(pause.status).toBe(0); expect(JSON.parse(pause.out).operation).toBe('pause'); expect((await readScheduleControl(root)).paused).toBe(true);
 const token=(await readScheduleControl(root)).generation;
 const interrupt=await run('schedule:interrupt'); expect(interrupt.status).toBe(0); expect(JSON.parse(interrupt.out).generation).not.toBe(token);
 expect((await run('schedule:resume')).status).toBe(0); expect((await readScheduleControl(root)).paused).toBe(false);
 const secret=join(root,'missing-secret'); const failed=await run('schedule:pause',secret); expect(failed.status).not.toBe(0); expect(failed.err).not.toContain(secret);
});
