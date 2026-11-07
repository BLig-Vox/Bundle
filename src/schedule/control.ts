import { randomBytes, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface ScheduleControl { version: 1; paused: boolean; generation: string }
const limit = 64 * 1024;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const owned = (s: Stats) => typeof process.getuid !== 'function' || s.uid === process.getuid();
const clean = (): ScheduleControl => ({version: 1, paused: false, generation: '00000000-0000-4000-8000-000000000000'});
async function directory(root: string, create: boolean): Promise<string | undefined> {
  if (typeof root !== 'string' || !root || !isAbsolute(root) || root.includes('\0')) throw new Error('Invalid project root.');
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new Error('Unsafe project root.');
  const dir = join(canonical, '.bundle-schedule');
  if (create) try { await mkdir(dir, {mode: 0o700}); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  try {
    const s = await lstat(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || !owned(s) || (s.mode & 0o7777) !== 0o700) throw new Error('Unsafe schedule directory.');
  } catch (e) { if (missing(e) && !create) return undefined; throw e; }
  return dir;
}
function parse(text: string): ScheduleControl {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid schedule control state.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid schedule control state.');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'generation,paused,version' || o.version !== 1 || typeof o.paused !== 'boolean' || typeof o.generation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(o.generation)) throw new Error('Invalid schedule control state.');
  const keys = new Set<string>();
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (/^\s*:/.test(text.slice(match.index + match[0].length))) {
      const key = JSON.parse(match[0]) as string;
      if (keys.has(key)) throw new Error('Invalid schedule control state.');
      keys.add(key);
    }
  }
  return o as unknown as ScheduleControl;
}
async function stateAt(path: string): Promise<{state: ScheduleControl; info: Stats} | undefined> {
  // An exclusive first publication briefly has two links; replacement can unlink
  // the inode between lstat, open and fstat. Retry only these unstable snapshots.
  // A persistent hardlink or perpetual churn must fail closed, never look absent.
  let observed = false;
  for (let attempt = 0; attempt < 64; attempt++) {
    let info: Stats;
    try { info = await lstat(path); } catch (e) {
      if (!missing(e)) throw e;
      if (!observed) return undefined;
      await new Promise(resolve => setTimeout(resolve,1)); continue;
    }
    observed = true;
    if (!info.isFile() || info.isSymbolicLink() || !owned(info) || info.size > limit || (info.mode & 0o7777) !== 0o600) throw new Error('Unsafe schedule control state.');
    if (info.nlink !== 1) { await new Promise(resolve => setTimeout(resolve,1)); continue; }
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if (missing(e)) { await new Promise(resolve => setTimeout(resolve,1)); continue; } throw e; }
    try {
      const actual = await handle.stat();
      if (actual.dev !== info.dev || actual.ino !== info.ino || actual.nlink !== 1) {
        await new Promise(resolve => setTimeout(resolve,1)); continue;
      }
      if (!actual.isFile() || !owned(actual) || actual.size > limit || (actual.mode & 0o7777) !== 0o600) throw new Error('Unsafe schedule control state.');
      const buffer = Buffer.alloc(limit + 1), {bytesRead} = await handle.read(buffer,0,buffer.length,0);
      if (bytesRead > limit) throw new Error('Schedule control state too large.');
      let text: string; try { text = new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)); } catch { throw new Error('Invalid schedule control encoding.'); }
      return {state: parse(text), info: actual};
    } finally { await handle.close(); }
  }
  throw new Error('Schedule control state remained unstable or unsafe.');
}
async function unchanged(path: string, previous: {info: Stats} | undefined): Promise<void> {
  let current: Stats | undefined;
  try { current = await lstat(path); } catch (e) { if (!missing(e)) throw e; }
  if (!previous ? current !== undefined : !current || current.dev !== previous.info.dev || current.ino !== previous.info.ino || current.size !== previous.info.size || current.mtimeMs !== previous.info.mtimeMs || current.ctimeMs !== previous.info.ctimeMs || current.nlink !== 1) throw new Error('Schedule control state changed.');
}
async function removeOwned(path: string, own: Stats): Promise<void> {
  try { const s = await lstat(path); if (s.dev === own.dev && s.ino === own.ino) await unlink(path); } catch (e) { if (!missing(e)) throw e; }
}
async function mutate(root: string, change: (state: ScheduleControl) => ScheduleControl): Promise<ScheduleControl> {
  const dir = (await directory(root,true))!, lock = join(dir,'.control.lock');
  const lockHandle = await open(lock,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
  const lockInfo = await lockHandle.stat();
  try {
    const path = join(dir,'control.json'), old = await stateAt(path), result = change(old?.state ?? clean());
    if (old && result.paused === old.state.paused && result.generation === old.state.generation) return result;
    const data = JSON.stringify(result) + '\n';
    if (Buffer.byteLength(data) > limit) throw new Error('Schedule control state too large.');
    const temporary = join(dir, `.control-${randomBytes(16).toString('hex')}.tmp`);
    const handle = await open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
    const own = await handle.stat();
    try {
      await handle.chmod(0o600); await handle.writeFile(data); await handle.sync(); await handle.close();
      await unchanged(path,old);
      if (old) await rename(temporary,path); else { await link(temporary,path); await unlink(temporary); }
    } finally { await handle.close().catch(() => {}); await removeOwned(temporary,own); }
    return result;
  } finally { await lockHandle.close(); await removeOwned(lock,lockInfo); }
}
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch { throw new Error('Unable to access schedule control.'); }
}
export async function readScheduleControl(root: string): Promise<ScheduleControl> {
  return safe(async () => {
    const dir = await directory(root,false); return dir ? (await stateAt(join(dir,'control.json')))?.state ?? clean() : clean();
  });
}
export async function pauseSchedule(root: string): Promise<ScheduleControl> {
  return safe(() => mutate(root, state => ({...state, paused:true})));
}
export async function resumeSchedule(root: string): Promise<ScheduleControl> {
  return safe(() => mutate(root, state => ({...state, paused:false})));
}
export async function interruptSchedule(root: string): Promise<ScheduleControl> {
  return safe(() => mutate(root, state => ({...state, generation:randomUUID()})));
}
