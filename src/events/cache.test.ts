import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cacheEvents, clearEventCache, loadApplicationEvents } from './cache';

const definitions = pathToFileURL(join(import.meta.dir, 'definitions.ts')).href;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundle-events-'));
  await writeFile(join(root, 'events.ts'), `import { defineEvents } from ${JSON.stringify(definitions)}; export default defineEvents([{event:'saved',listeners:[{module:'listener.ts',export:'listen'}]}]);`);
  await writeFile(join(root, 'listener.ts'), `import { appendFileSync } from 'node:fs'; export function listen(payload: unknown) { appendFileSync(${JSON.stringify(join(root, 'output'))}, String(payload)); }`);
  return root;
}
test('cache persists and dispatches in a separate process; clear is scoped', async () => {
  const root = await fixture();
  try {
    const path = await cacheEvents(root); expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(cacheEvents(root)).rejects.toThrow();
    await writeFile(join(root, 'events.ts'), 'throw new Error("cache was bypassed")');
    const cacheModule = pathToFileURL(join(import.meta.dir, 'cache.ts')).href;
    const script = `import {loadApplicationEvents} from ${JSON.stringify(cacheModule)}; const bus=await loadApplicationEvents(${JSON.stringify(root)}); await bus.dispatch('saved','ok');`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BUN_OPTIONS: '' } });
    const status = await child.exited; expect(await new Response(child.stderr).text()).toBe(''); expect(status).toBe(0);
    expect(await readFile(join(root, 'output'), 'utf8')).toBe('ok');
    expect(await clearEventCache(root)).toBe(true); expect(await clearEventCache(root)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rejects corrupt cache and symlinked cache file', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'bootstrap', 'cache'), { recursive: true });
    const path = join(root, 'bootstrap', 'cache', 'events.json');
    await writeFile(path, 'garbage'); await expect(loadApplicationEvents(root)).rejects.toThrow();
    await expect(clearEventCache(root)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('garbage');
    await rm(path); await symlink(join(root, 'events.ts'), path);
    await expect(clearEventCache(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('class listener gets a fresh instance per dispatch without executing during inspection', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'events.ts'), `import { defineEvents } from ${JSON.stringify(definitions)}; export default defineEvents([{event:'saved',listeners:[{module:'listener.ts',export:'Listener',method:'run'}]}]);`);
    await writeFile(join(root, 'listener.ts'), `import { appendFileSync } from 'node:fs'; export class Listener { count = 0; run() { appendFileSync(${JSON.stringify(join(root, 'output'))}, String(++this.count)); } }`);
    const bus = await loadApplicationEvents(root);
    expect(bus.describe()).toEqual([{ event: 'saved', listeners: 1, listenerNames: ['listener.ts#Listener.run'] }]);
    await expect(readFile(join(root, 'output'))).rejects.toThrow();
    await bus.dispatch('saved', null); await bus.dispatch('saved', null);
    expect(await readFile(join(root, 'output'), 'utf8')).toBe('11');
  } finally { await rm(root, { recursive: true, force: true }); }
});
