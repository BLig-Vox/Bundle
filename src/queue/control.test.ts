import { afterEach, test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, mkdir, chmod, symlink, link, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQueueControl, pauseQueue, resumeQueue, requestQueueRestart } from './control.ts';
import { QueueStore } from './store.ts';
import { workQueue } from './worker.ts';

const roots: string[] = [];
afterEach(async()=>{for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
const root = async () => {const path=await mkdtemp(join(tmpdir(), 'bundle-control-'));roots.push(path);return path;};
const statePath = (r: string) => join(r, '.bundle-queue', 'control.json');
test('persists idempotent pause and resume, and fresh restart generations', async () => {
  const r = await root();
  expect(await readQueueControl(r)).toEqual({version:1,restartToken:null,pausedQueues:[]});
  await expect(lstat(join(r,'.bundle-queue','queue.sqlite'))).rejects.toThrow();
  expect((await pauseQueue(r,'alpha')).changed).toBe(true);
  expect((await pauseQueue(r,'alpha')).changed).toBe(false);
  expect((await resumeQueue(r,'missing')).changed).toBe(false);
  const first = await requestQueueRestart(r), second = await requestQueueRestart(r);
  expect(first.state.restartToken).not.toBe(second.state.restartToken);
  expect((await resumeQueue(r,'alpha')).state.pausedQueues).toEqual([]);
  expect((await lstat(statePath(r))).mode & 0o7777).toBe(0o600);
});
test('rejects invalid names without creating storage', async () => {
  const r = await root();
  await expect(pauseQueue(r,'../bad')).rejects.toThrow();
  await expect(lstat(join(r,'.bundle-queue'))).rejects.toThrow();
});
test('preserves malformed, ambiguous and oversized state', async () => {
  for (const text of ['{}',String.raw`{"version":1,"version":1,"restartToken":null,"pausedQueues":[]}`, '{"version":1,"\\u0076ersion":1,"restartToken":null,"pausedQueues":[]}', '{"version":1,"restartToken":null,"pausedQueues":["a","a"]}', '{"version":1,"restartToken":null,"pausedQueues":[],"extra":1}', 'x'.repeat(65537)]) {
    const r = await root(); await mkdir(join(r,'.bundle-queue')); await writeFile(statePath(r),text,{mode:0o600});
    await expect(pauseQueue(r,'a')).rejects.toThrow(); expect(await readFile(statePath(r),'utf8')).toBe(text);
  }
});
test('refuses symlinks, hardlinks, wrong modes, and stale locks', async () => {
  for (const kind of ['directory','file','hardlink','mode','lock']) {
    const r = await root(), dir = join(r,'.bundle-queue'), target=join(r,'target');
    if (kind === 'directory') { await mkdir(target); await symlink(target,dir); }
    else { await mkdir(dir); if (kind === 'lock') await writeFile(join(dir,'.control.lock'),'stale'); else { await writeFile(target,'{}',{mode:0o600}); if (kind === 'file') await symlink(target,statePath(r)); else if (kind === 'hardlink') await link(target,statePath(r)); else { await writeFile(statePath(r),'{}'); await chmod(statePath(r),0o644); } } }
    await expect(pauseQueue(r,'a')).rejects.toThrow();
    if (kind !== 'lock') await expect(readQueueControl(r)).rejects.toThrow();
    if (kind === 'lock') expect(await readFile(join(dir,'.control.lock'),'utf8')).toBe('stale');
  }
});
function writer(r: string, count: number) {
  const modulePath = join(import.meta.dir,'control.ts');
  const script = `import {pauseQueue,resumeQueue} from ${JSON.stringify(modulePath)}; const root=process.argv[1]; for(let i=0;i<${count};i++){await pauseQueue(root,'alpha');await resumeQueue(root,'alpha');}`;
  return Bun.spawn([process.execPath,'-e',script,r],{stdout:'ignore',stderr:'pipe'});
}
test('concurrent readers survive atomic first publication and replacements', async () => {
  const r=await root(), child=writer(r,1000);
  try {
    for(let i=0;i<8000;i++) {
      const state=await readQueueControl(r);
      expect(state.version).toBe(1);
    }
    expect(await child.exited).toBe(0);
  } finally { child.kill(); await child.exited; }
},30000);
test('idle worker survives concurrent control changes and observes restart', async () => {
  const r=await root(), store=new QueueStore(join(r,'jobs.sqlite')), controller=new AbortController();
  const running=workQueue({root:r,store,sleepMs:1,signal:controller.signal});
  const child=writer(r,1000);
  try {
    expect(await child.exited).toBe(0);
    await requestQueueRestart(r);
    expect(await running).toEqual({processed:0});
  } finally { child.kill(); controller.abort(); await running.catch(()=>{}); store.close(); }
},30000);
test('enforces 128 queue limit and accepts root aliases', async () => {
  const r = await root(), alias = `${r}-alias`; roots.push(alias); await symlink(r,alias);
  for (let i=0;i<128;i++) await pauseQueue(alias,`q${i}`);
  await expect(pauseQueue(r,'overflow')).rejects.toThrow();
  expect((await readQueueControl(r)).pausedQueues.length).toBe(128);
});
