import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedRouteFile } from '../http/route-definitions';
import { definePackages, type PackageDefinition } from './definitions';

const limit = 1024 * 1024;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Package operation cancelled.'); };
async function canonical(root: string): Promise<string> {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Invalid package root.');
  const result = await realpath(root);
  if (!(await lstat(result)).isDirectory()) throw new Error('Invalid package root.');
  return result;
}
async function directory(root: string, create: boolean): Promise<string | undefined> {
  let dir = await canonical(root);
  for (const part of ['bootstrap', 'cache']) {
    dir = join(dir, part);
    if (create) try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    try { const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe package directory.'); }
    catch (e) { if (!create && missing(e)) return undefined; throw e; }
  }
  return dir;
}
function safe(s: Stats): boolean {
  return s.isFile() && s.nlink === 1 && (s.mode & 0o7777) === 0o600 && (typeof process.getuid !== 'function' || s.uid === process.getuid()) && s.size <= limit;
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

// JSON.parse accepts duplicate object names. Scan its already-valid input preserving object scope.
function parseStrict(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) { const c = text[i++]!; if (c === '\\') i++; else if (c === '"') return JSON.parse(text.slice(start, i)) as string; }
    throw new Error('Invalid JSON.');
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new Error('Invalid JSON.');
    ws(); const c = text[i];
    if (c === '{') {
      i++; ws(); const names = new Set<string>();
      if (text[i] === '}') { i++; return; }
      while (true) { ws(); const key = string(); if (names.has(key)) throw new Error('Duplicate JSON key.'); names.add(key); ws(); i++; value(depth + 1); ws(); if (text[i++] === '}') break; }
    } else if (c === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      while (true) { value(depth + 1); ws(); if (text[i++] === ']') break; }
    } else if (c === '"') { string(); }
    else { while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++; }
  };
  value(0); return parsed;
}
async function readAt(path: string): Promise<{ definitions: readonly PackageDefinition[]; stat: Stats } | undefined> {
  for (let attempt = 0; attempt < 64; attempt++) {
    let before: Stats;
    try { before = await lstat(path); } catch (e) { if (missing(e)) return undefined; throw e; }
    if (!safe(before)) {
      if (before.isFile() && before.nlink === 2 && attempt < 63) { await new Promise(r => setTimeout(r, 2)); continue; }
      if (before.isFile() && before.nlink === 0) {
        try { if (!same(before, await lstat(path))) continue; } catch (e) { if (missing(e)) continue; throw e; }
      }
      throw new Error('Unsafe package cache.');
    }
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if (missing(e)) continue; throw e; }
    try {
      const stat = await handle.stat();
      if (!same(before, stat)) continue;
      if (!safe(stat)) {
        let now: Stats;
        try { now = await lstat(path); } catch (e) { if (missing(e)) continue; throw e; }
        if (!same(stat, now)) continue;
        throw new Error('Unsafe package cache.');
      }
      const buffer = Buffer.alloc(limit + 1); let count = 0;
      while (count < buffer.length) { const r = await handle.read(buffer, count, buffer.length - count, count); if (!r.bytesRead) break; count += r.bytesRead; }
      if (count > limit) throw new Error('Oversized package cache.');
      const data = parseStrict(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)));
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'packages,version' || (data as {version: unknown}).version !== 1) throw new Error('Invalid package cache.');
      return { definitions: definePackages((data as {packages: PackageDefinition[]}).packages), stat };
    } finally { await handle.close(); }
  }
  throw new Error('Package cache changed.');
}
export async function readPackageDefinitions(root: string, signal?: AbortSignal): Promise<readonly PackageDefinition[]> {
  try {
    abort(signal); const dir = await canonical(root); const file = join(dir, 'packages.ts');
    let stat: Stats;
    try { stat = await lstat(file); } catch (e) { if (missing(e)) { abort(signal); return definePackages([]); } throw e; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error('Unsafe package source.');
    abort(signal); const source = await import(pathToFileURL(file).href); abort(signal);
    return definePackages(source.default);
  } catch { throw new Error('Package definition loading failed.'); }
}
export async function loadCachedPackages(root: string): Promise<readonly PackageDefinition[] | undefined> {
  try { const dir = await directory(root, false); return dir ? (await readAt(join(dir, 'packages.json')))?.definitions : undefined; }
  catch { throw new Error('Package cache loading failed.'); }
}
export async function cachePackages(root: string, options: { overwrite?: boolean; signal?: AbortSignal } = {}): Promise<{path: string; packages: number; providers: number}> {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Reflect.ownKeys(options).some(k => k !== 'overwrite' && k !== 'signal') || (options.overwrite !== undefined && typeof options.overwrite !== 'boolean')) throw new Error('Invalid options.');
    abort(options.signal); const canonicalRoot = await canonical(root);
    const existingDir = await directory(canonicalRoot, false);
    const old = existingDir ? await readAt(join(existingDir, 'packages.json')) : undefined;
    if (old && !options.overwrite) throw new Error('Package cache exists.');
    const definitions = await readPackageDefinitions(canonicalRoot, options.signal);
    for (const item of definitions) for (const ref of item.providers) { abort(options.signal); await checkedRouteFile(canonicalRoot, ref.module); }
    abort(options.signal);
    const content = JSON.stringify({ version: 1, packages: definitions }) + '\n';
    if (Buffer.byteLength(content) > limit) throw new Error('Package cache too large.');
    const dir = (await directory(canonicalRoot, true))!; const path = join(dir, 'packages.json');
    const temp = join(dir, `.packages-${crypto.randomUUID()}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const own = await handle.stat();
    try {
      await handle.chmod(0o600); await handle.writeFile(content); await handle.sync(); await handle.close(); abort(options.signal);
      await directory(canonicalRoot, false);
      const current = await readAt(path);
      if ((!old && current) || (old && (!current || !same(old.stat, current.stat)))) throw new Error('Package cache changed.');
      // Once publication starts, cancellation cannot roll back an already committed link or rename.
      abort(options.signal);
      if (old) await rename(temp, path); else { await link(temp, path); await unlink(temp); }
    } finally {
      await handle.close().catch(() => {});
      try { const s = await lstat(temp); if (same(s, own)) await unlink(temp); } catch (e) { if (!missing(e)) throw e; }
    }
    return { path, packages: definitions.length, providers: definitions.reduce((n, p) => n + p.providers.length, 0) };
  } catch { throw new Error('Package discovery failed.'); }
}
export async function clearPackageCache(root: string): Promise<boolean> {
  try {
    const dir = await directory(root, false); if (!dir) return false;
    const path = join(dir, 'packages.json'); const old = await readAt(path); if (!old) return false;
    const current = await lstat(path); if (!safe(current) || !same(current, old.stat)) throw new Error('Package cache changed.');
    await unlink(path); return true;
  } catch (e) { if (missing(e)) return false; throw new Error('Package cache clear failed.'); }
}
