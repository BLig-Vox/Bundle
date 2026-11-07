import { test, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { openLocalQueue } from './opening.ts';
import { requestQueueRestart } from './control.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenQueue } from './listener.ts';

test('runs two fresh child cycles with an explicit root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-listen-'));
  try {
    const result = await listenQueue({root, maxCycles: 2, sleepMs: 1, output: () => {}, error: () => {}});
    expect(result.cycles).toBe(2);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('acknowledges jobs across processes and reloads changed source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-listen-jobs-'));
  const job = join(root, 'job.ts'), marker = join(root, 'marker');
  const replacement = `import {appendFileSync} from 'node:fs'; export function handle(){appendFileSync(${JSON.stringify(marker)},'second\\n');}`;
  try {
    await writeFile(job, `import {appendFileSync,writeFileSync} from 'node:fs'; export function handle(){appendFileSync(${JSON.stringify(marker)},'first\\n');writeFileSync(${JSON.stringify(job)},${JSON.stringify(replacement)});}`);
    const store = await openLocalQueue(root);
    store.enqueue('default', {module:'job.ts', export:'handle', payload:null});
    store.enqueue('default', {module:'job.ts', export:'handle', payload:null});
    store.close();
    expect(await listenQueue({root,maxCycles:2,sleepMs:1,output:()=>{},error:()=>{}})).toEqual({cycles:2});
    expect(await readFile(marker,'utf8')).toBe('first\nsecond\n');
    const reopened = await openLocalQueue(root);
    try { expect(reopened.snapshot('default').ready).toBe(0); } finally { reopened.close(); }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('accepts an absolute symlink alias and trailing path as root', async () => {
  const parent = await mkdtemp(join(tmpdir(),'bundle-listen-alias-'));
  try {
    const root = join(parent,'actual'), alias = join(parent,'alias');
    await mkdir(root); await symlink(root,alias);
    expect(await listenQueue({root:alias + '/',maxCycles:1,sleepMs:1,output:()=>{},error:()=>{}})).toEqual({cycles:1});
    expect(await Bun.file(join(root,'.bundle-queue','queue.sqlite')).exists()).toBe(true);
  } finally { await rm(parent,{recursive:true,force:true}); }
});

test.each(['stdout','stderr'] as const)('%s writer failure terminates and reaps active child', async channel => {
  const root = await mkdtemp(join(tmpdir(),'bundle-listen-writer-'));
  const marker = join(root,'pid');
  let pid = 0;
  try {
    await mkdir(join(root,'src','commands'),{recursive:true});
    await writeFile(join(root,'src','commands','stuck.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},String(process.pid)); process.on('SIGTERM',()=>{});process.${channel}.write('trigger');await new Promise(()=>setInterval(()=>{},1000));`);
    const failure = () => {throw new Error('SECRET');};
    const result = listenQueue({root,output:channel === 'stdout' ? failure : ()=>{},error:channel === 'stderr' ? failure : ()=>{}});
    await expect(result).rejects.toThrow('Queue listener child output failed.');
    pid = Number(await readFile(marker,'utf8'));
    expect(() => process.kill(pid,0)).toThrow();
  } finally { if (pid) try { process.kill(pid,'SIGKILL'); } catch {} else if (await Bun.file(marker).exists()) { try { process.kill(Number(await readFile(marker,'utf8')),'SIGKILL'); } catch {} } await rm(root,{recursive:true,force:true}); }
},10000);

test('pre-abort and invalid options create no state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-listen-invalid-'));
  try {
    const controller = new AbortController(); controller.abort();
    expect(await listenQueue({root,signal:controller.signal})).toEqual({cycles:0});
    await expect(listenQueue({root,maxCycles:0})).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test.each(['SIGINT','SIGTERM'])('cancellation %s kills an uncooperative startup child', async signal => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-listen-stuck-'));
  const marker = join(root,'pid');
  const controller = new AbortController();
  let running: Promise<{cycles:number}> | undefined;
  try {
    await mkdir(join(root,'src','commands'),{recursive:true});
    await writeFile(join(root,'src','commands','stuck.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},String(process.pid)); process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});await new Promise(()=>setInterval(()=>{},1000));`);
    running = listenQueue({root,signal:controller.signal,output:()=>{},error:()=>{}});
    const deadline = Date.now()+5000; while (!await Bun.file(marker).exists() && Date.now()<deadline) await Bun.sleep(10);
    expect(await Bun.file(marker).exists()).toBe(true);
    const pid = Number(await readFile(marker,'utf8'));
    controller.abort(new Error(signal));
    expect(await running).toEqual({cycles:1});
    expect(() => process.kill(pid,0)).toThrow();
  } finally { controller.abort(); await running?.catch(()=>{}); await rm(root,{recursive:true,force:true}); }
},10000);

test('cancellation does not wait for inherited grandchild pipes', async () => {
  const root = await mkdtemp(join(tmpdir(),'bundle-listen-grandchild-'));
  const marker = join(root,'pid');
  const controller = new AbortController();
  let running: Promise<{cycles:number}> | undefined;
  let pid = 0;
  try {
    await mkdir(join(root,'src','commands'),{recursive:true});
    await writeFile(join(root,'src','commands','stuck.ts'), `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});writeFileSync(${JSON.stringify(marker)},String(p.pid));await new Promise(()=>setInterval(()=>{},1000));`);
    running = listenQueue({root,signal:controller.signal,output:()=>{},error:()=>{}});
    const deadline=Date.now()+5000; while (!await Bun.file(marker).exists() && Date.now()<deadline) await Bun.sleep(10);
    pid=Number(await readFile(marker,'utf8')); expect(pid).toBeGreaterThan(0);
    controller.abort();
    const outcome = await Promise.race([running, Bun.sleep(2500).then(()=>null)]);
    expect(outcome).toEqual({cycles:1});
    expect(() => process.kill(pid,0)).not.toThrow();
  } finally {
    controller.abort(); if (pid) try {process.kill(pid,'SIGKILL');} catch {}
    await running?.catch(()=>{}); await rm(root,{recursive:true,force:true});
  }
},10000);

test('child import failure stops without respawning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-listen-fail-'));
  try {
    await mkdir(join(root,'src','commands'),{recursive:true});
    await writeFile(join(root,'src','commands','bad.ts'), `throw new Error('SECRET');`);
    await expect(listenQueue({root,maxCycles:5,sleepMs:1,output:()=>{},error:()=>{}})).rejects.toThrow('Queue listener child failed.');
    expect(await Bun.file(join(root,'.bundle-queue','queue.sqlite')).exists()).toBe(false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('restart requested during a job waits for it and skips the next child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-listen-restart-'));
  const started = join(root,'started'), release = join(root,'release');
  try {
    await writeFile(join(root,'job.ts'), `import {writeFileSync,existsSync} from 'node:fs'; export async function handle(){writeFileSync(${JSON.stringify(started)},'yes');while(!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);}`);
    const store = await openLocalQueue(root);
    store.enqueue('default',{module:'job.ts',export:'handle',payload:null}); store.close();
    const running = listenQueue({root,maxCycles:3,sleepMs:1,output:()=>{},error:()=>{}});
    const deadline = Date.now()+5000; while (!await Bun.file(started).exists() && Date.now()<deadline) await Bun.sleep(10);
    expect(await Bun.file(started).exists()).toBe(true);
    await requestQueueRestart(root); await writeFile(release,'yes');
    expect(await running).toEqual({cycles:1});
    const reopened=await openLocalQueue(root); try {expect(reopened.snapshot('default').reserved).toBe(0);} finally {reopened.close();}
  } finally { await writeFile(release,'yes').catch(()=>{}); await rm(root,{recursive:true,force:true}); }
},10000);
