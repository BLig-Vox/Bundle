import { afterEach, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQueueControl } from '../queue/control.ts';

const roots:string[]=[];
afterEach(async()=>{for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
test('separate processes register and execute control commands', async () => {
  const root = await mkdtemp(join(tmpdir(),'bundle-control-cli-'));
  roots.push(root);
  const modulePath = join(import.meta.dir,'queue-control.ts');
  const script = `import {Command} from 'commander'; import {registerQueueControl} from ${JSON.stringify(modulePath)}; const p=new Command(); registerQueueControl(p,{root:process.argv[1],output:console.log}); await p.parseAsync(['bun','test',...process.argv.slice(2)]);`;
  async function run(...args:string[]) { const p=Bun.spawn([process.execPath,'-e',script,root,...args],{cwd:join(import.meta.dir,'../..'),stdout:'pipe',stderr:'pipe'}); return {status:await p.exited,out:await new Response(p.stdout).text(),err:await new Response(p.stderr).text()}; }
  const paused=await run('queue:pause','alpha'); expect(paused.status).toBe(0); expect(JSON.parse(paused.out).changed).toBe(true);
  expect((await readQueueControl(root)).pausedQueues).toEqual(['alpha']);
  expect(JSON.parse((await run('queue:pause','alpha')).out).changed).toBe(false);
  expect((await run('queue:restart')).status).toBe(0);
  expect((await run('queue:resume','alpha')).status).toBe(0);
  expect((await run('queue:pause','../bad')).status).not.toBe(0);
});
