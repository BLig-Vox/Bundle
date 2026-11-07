import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedRouteFile } from '../http/route-definitions';
import { EventBus } from './bus';
import { defineEvents, hydrateEvents, isDefinedEvents, type EventDefinitions } from './definitions';

const MAX_CACHE_BYTES = 1024 * 1024;
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
async function cacheDirectory(root: string, create: boolean): Promise<string | undefined> {
  let current = await realpath(root);
  for (const part of ['bootstrap', 'cache']) {
    current = join(current, part);
    if (create) { try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe event cache directory');
    } catch (error) { if (!create && missing(error)) return undefined; throw error; }
  }
  return current;
}
async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe event cache file');
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}
/** Load the trusted root events.ts; ordinary arrays are not cacheable. */
export async function readEventDefinitions(root: string): Promise<EventDefinitions> {
  const path = await checkedRouteFile(root, 'events.ts');
  const source = await import(pathToFileURL(path).href);
  if (!isDefinedEvents(source.default)) throw new Error('events.ts must default export defineEvents([...])');
  return source.default;
}
/** Read validated serialized definitions; undefined means absent, never corrupt. Does not execute modules. */
export async function loadCachedEvents(root: string): Promise<EventDefinitions | undefined> {
  const dir = await cacheDirectory(root, false);
  if (!dir) return undefined;
  const path = join(dir, 'events.json');
  if (!await fileExists(path)) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CACHE_BYTES) throw new Error('Unsafe or oversized event cache');
    const bytes = Buffer.alloc(MAX_CACHE_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_CACHE_BYTES) throw new Error('Oversized event cache');
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'events,version' || (data as { version: unknown }).version !== 1) throw new Error('Invalid event cache format');
    return defineEvents((data as { events: EventDefinitions }).events);
  } catch (error) { throw new Error(`Cannot load event cache ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  finally { await handle.close(); }
}
/** Validates and hydrates before publishing; only explicit overwrite may replace an existing cache. */
export async function cacheEvents(root: string, options: { overwrite?: boolean } = {}): Promise<string> {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Reflect.ownKeys(options).some(key => key !== 'overwrite') || (options.overwrite !== undefined && typeof options.overwrite !== 'boolean')) throw new Error('Only boolean overwrite is supported');
  const existing = await cacheDirectory(root, false);
  if (existing && await fileExists(join(existing, 'events.json')) && !options.overwrite) throw new Error('Event cache already exists');
  const definitions = await readEventDefinitions(root);
  await hydrateEvents(root, definitions);
  const content = `${JSON.stringify({ version: 1, events: definitions }, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_CACHE_BYTES) throw new Error('Event cache exceeds size limit');
  const dir = (await cacheDirectory(root, true))!;
  const path = join(dir, 'events.json');
  await fileExists(path);
  const temporary = join(dir, `.events-${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600); await handle.writeFile(content); await handle.sync(); await handle.close();
    await cacheDirectory(root, false); await fileExists(path);
    if (options.overwrite) await rename(temporary, path);
    else { await link(temporary, path); await unlink(temporary); }
  } catch (error) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  return path;
}
export async function clearEventCache(root: string): Promise<boolean> {
  const dir = await cacheDirectory(root, false);
  if (!dir) return false;
  const path = join(dir, 'events.json');
  if (!await fileExists(path)) return false;
  // Validate ownership/format without importing listeners before removing state.
  await loadCachedEvents(root);
  try { await unlink(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}

/** Cache takes precedence; absent cache and entrypoint produce an empty bus. */
export async function loadApplicationEvents(root: string): Promise<EventBus> {
  const cached = await loadCachedEvents(root);
  if (cached !== undefined) return hydrateEvents(root, cached);
  try { await checkedRouteFile(root, 'events.ts'); } catch (error) { if (missing(error)) return new EventBus(); throw error; }
  return hydrateEvents(root, await readEventDefinitions(root));
}
