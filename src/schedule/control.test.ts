import { afterEach, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScheduleControl, pauseSchedule, resumeSchedule, interruptSchedule } from './control.ts';

const roots: string[] = [];
async function root() { const r = await mkdtemp(join(tmpdir(), 'bundle-schedule-control-')); roots.push(r); return r; }
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, {recursive:true, force:true}); });
test('default and persisted controls round trip', async () => {
  const r = await root();
  const baseline = await readScheduleControl(r);
  expect(baseline).toEqual({version:1, paused:false, generation:'00000000-0000-4000-8000-000000000000'});
  const paused = await pauseSchedule(r);
  expect(paused.generation).toBe(baseline.generation);
  expect(paused.paused).toBe(true);
  expect(paused.generation).toMatch(/^[0-9a-f-]{36}$/);
  const interrupted = await interruptSchedule(r);
  expect(interrupted.paused).toBe(true);
  expect(interrupted.generation).not.toBe(paused.generation);
  expect((await resumeSchedule(r)).paused).toBe(false);
  expect(await readScheduleControl(r)).toEqual({...interrupted, paused:false});
});

test('private modes, canonical aliases, and idempotent state', async () => {
  const r = await root(), alias = join(r, 'alias');
  await symlink(r, alias);
  const state = await pauseSchedule(alias);
  expect(await pauseSchedule(r)).toEqual(state);
  expect(await readScheduleControl(alias)).toEqual(state);
  const dir = join(r, '.bundle-schedule');
  expect((await lstat(dir)).mode & 0o7777).toBe(0o700);
  expect((await lstat(join(dir, 'control.json'))).mode & 0o7777).toBe(0o600);
  await expect(readScheduleControl('.')).rejects.toThrow();
});

test('unsafe and corrupt state is preserved without mutation', async () => {
  const samples = [
    '{', '{"version":1,"paused":false,"generation":""}',
    '{"version":1,"version":1,"paused":false,"generation":"550e8400-e29b-41d4-a716-446655440000"}',
    '{"version":1,"paused":false,"generation":"550e8400-e29b-41d4-a716-446655440000","extra":1}',
    'x'.repeat(65537),
  ];
  for (const sample of samples) {
    const r = await root(), dir = join(r, '.bundle-schedule'), path = join(dir, 'control.json');
    await mkdir(dir, {mode:0o700}); await writeFile(path, sample, {mode:0o600});
    await expect(readScheduleControl(r)).rejects.toThrow();
    await expect(pauseSchedule(r)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(sample);
  }
});

test('refuses symlink, hardlink, bad modes and stale lock', async () => {
  const r = await root(), dir = join(r, '.bundle-schedule'), path = join(dir,'control.json');
  await pauseSchedule(r);
  const original = await readFile(path, 'utf8');
  const other = join(r,'other');
  await link(path, other);
  await expect(readScheduleControl(r)).rejects.toThrow();
  await rm(other); await rm(path); await symlink(other,path);
  await expect(readScheduleControl(r)).rejects.toThrow();
  await expect(interruptSchedule(r)).rejects.toThrow();
  await rm(path); await writeFile(path, original, {mode:0o644});
  await expect(readScheduleControl(r)).rejects.toThrow();
  await chmod(path,0o600);
  const lock = join(dir,'.control.lock'); await writeFile(lock,'foreign', {mode:0o600});
  await expect(resumeSchedule(r)).rejects.toThrow();
  expect(await readFile(lock,'utf8')).toBe('foreign');
  expect(await readFile(path,'utf8')).toBe(original);
  await chmod(dir,0o755); await expect(readScheduleControl(r)).rejects.toThrow();
});

test('atomic readers tolerate repeated publication and replacement', async () => {
  const r = await root();
  let done = false;
  const writer = (async () => { try { for (let i=0; i<120; i++) await interruptSchedule(r); } finally { done=true; } })();
  const readers = Array.from({length:4}, async () => {
    do { const state=await readScheduleControl(r); expect(state.version).toBe(1); expect(state.paused).toBe(false); } while (!done);
  });
  await Promise.all([writer,...readers]);
});

test('native failures do not reveal project paths', async () => {
  const r=await root(), secret=join(r,'secret-missing');
  for (const call of [readScheduleControl, pauseSchedule, resumeSchedule, interruptSchedule]) {
    try { await call(secret); throw new Error('unexpected success'); }
    catch (error) { expect(String(error)).not.toContain(secret); }
  }
});
