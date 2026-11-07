import { expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePackages, clearPackageCache, loadCachedPackages } from './cache';

test('discovers metadata without executing provider code and clears it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    await writeFile(join(root, 'packages.ts'), `export default [{name:'demo',providers:[{module:'provider.ts',export:'Provider'}]}]`);
    await writeFile(join(root, 'provider.ts'), `throw new Error('must not execute')`);
    expect(await cachePackages(root)).toMatchObject({ packages: 1, providers: 1 });
    expect(await loadCachedPackages(root)).toEqual([{name:'demo',providers:[{module:'provider.ts',export:'Provider'}]}]);
    await expect(cachePackages(root)).rejects.toThrow();
    expect(await clearPackageCache(root)).toBe(true);
    expect(await loadCachedPackages(root)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects corrupt caches without clearing or overwriting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    const dir = join(root, 'bootstrap/cache'); await mkdir(dir, { recursive: true });
    const path = join(dir, 'packages.json');
    for (const bytes of ['{"version":1,"packages":[],"version":1}', '{"version":1,"packages":[{"name":"a","name":"b","providers":[]}]}', '{"version":1,"packages":[],"extra":1}', Buffer.from([0xff])]) {
      await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600);
      await expect(loadCachedPackages(root)).rejects.toThrow();
      await expect(clearPackageCache(root)).rejects.toThrow();
      await expect(cachePackages(root, { overwrite: true })).rejects.toThrow();
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects permissive, hardlinked and symlinked cache files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    const dir = join(root, 'bootstrap/cache'); await mkdir(dir, { recursive: true });
    const path = join(dir, 'packages.json'); const other = join(root, 'other');
    await writeFile(path, '{"version":1,"packages":[]}', { mode: 0o644 }); await chmod(path, 0o644);
    await expect(loadCachedPackages(root)).rejects.toThrow();
    await chmod(path, 0o600); await link(path, other);
    await expect(loadCachedPackages(root)).rejects.toThrow();
    await rm(path); await symlink(other, path);
    await expect(clearPackageCache(root)).rejects.toThrow();
    expect(await readFile(other, 'utf8')).toContain('packages');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit replacement succeeds and leaves shared directory permissions unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    const dir = join(root, 'bootstrap/cache'); await mkdir(dir, { recursive: true }); await chmod(dir, 0o755);
    const first = await cachePackages(root);
    const second = await cachePackages(root, { overwrite: true });
    expect(second.path).toBe(first.path);
    const { stat } = await import('node:fs/promises');
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checks cancellation immediately before publishing after final target inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    const controller = new AbortController(); let checks = 0;
    Object.defineProperty(controller.signal, 'aborted', { get() { return ++checks >= 6; } });
    await expect(cachePackages(root, { signal: controller.signal })).rejects.toThrow();
    expect(await loadCachedPackages(root)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reads during initial create-only link publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    const publish = cachePackages(root);
    const reader = async () => { for (let i = 0; i < 100; i++) { const value = await loadCachedPackages(root); expect(value === undefined || value.length === 0).toBe(true); } };
    await Promise.all([publish, reader(), reader()]);
    expect(await loadCachedPackages(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reads during repeated atomic replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    await cachePackages(root);
    const writer = async () => { for (let i = 0; i < 20; i++) await cachePackages(root, { overwrite: true }); };
    const reader = async () => { for (let i = 0; i < 100; i++) expect(await loadCachedPackages(root)).toEqual([]); };
    await Promise.all([writer(), reader(), reader()]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('accepts canonical root aliases and refuses oversized or multiply linked sources', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    const root = join(base, 'root'); const alias = join(base, 'alias'); await mkdir(root); await symlink(root, alias);
    const result = await cachePackages(alias);
    expect(result.path).toBe(join(root, 'bootstrap/cache/packages.json'));
    const source = join(root, 'packages.ts');
    await writeFile(source, ' '.repeat(1024 * 1024 + 1));
    await expect(cachePackages(root, { overwrite: true })).rejects.toThrow();
    await writeFile(source, 'export default []'); await link(source, join(root, 'other.ts'));
    await expect(cachePackages(root, { overwrite: true })).rejects.toThrow();
    expect(await loadCachedPackages(alias)).toEqual([]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('preflight failure preserves existing cache and force is required for replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-packages-'));
  try {
    const first = await cachePackages(root);
    await expect(cachePackages(root)).rejects.toThrow();
    await writeFile(join(root, 'packages.ts'), `export default [{name:'bad',providers:[{module:'missing.ts',export:'P'}]}]`);
    await expect(cachePackages(root, { overwrite: true })).rejects.toThrow();
    expect(await loadCachedPackages(root)).toEqual([]);
    expect(await readFile(first.path, 'utf8')).toContain('packages');
  } finally { await rm(root, { recursive: true, force: true }); }
});
