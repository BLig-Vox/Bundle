import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheRoutes, clearRouteCache, loadCachedRoutes } from './route-cache';

test('publishes a persistent cache, refuses collision and preserves other caches', async () => {
 const root = await mkdtemp(join(tmpdir(), 'route-cache-'));
 try {
  await writeFile(join(root, 'routes.ts'), `import { defineRoutes } from ${JSON.stringify(new URL('./route-definitions.ts', import.meta.url).href)}; export default defineRoutes([{method:'GET',path:'/',handler:{module:'handler.ts',export:'index'}}]);`);
  await writeFile(join(root, 'handler.ts'), `export function index() { return new Response('ok'); }`);
  await mkdir(join(root, 'bootstrap/cache'), { recursive: true });
  await writeFile(join(root, 'bootstrap/cache/config.json'), 'keep');
  const path = await cacheRoutes(root);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await loadCachedRoutes(root))?.[0]?.path).toBe('/');
  expect(await cacheRoutes(root, { overwrite: true })).toBe(path);
  await expect(cacheRoutes(root)).rejects.toThrow();
  expect(await readFile(join(root, 'bootstrap/cache/config.json'), 'utf8')).toBe('keep');
  expect(await clearRouteCache(root)).toBe(true);
  expect(await loadCachedRoutes(root)).toBeUndefined();
  expect(path).toBe(join(root, 'bootstrap/cache/routes.json'));
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects corrupt and symlink caches', async () => {
 const root = await mkdtemp(join(tmpdir(), 'route-cache-'));
 try {
  await mkdir(join(root, 'bootstrap/cache'), { recursive: true });
  const path = join(root, 'bootstrap/cache/routes.json');
  await writeFile(path, '{bad');
  await expect(loadCachedRoutes(root)).rejects.toThrow();
  await rm(path);
  await symlink(join(root, 'missing'), path);
  await expect(loadCachedRoutes(root)).rejects.toThrow();
  await expect(clearRouteCache(root)).rejects.toThrow();
 } finally { await rm(root, { recursive: true, force: true }); }
});


test('persists across processes and hydrates without executing routes.ts', async () => {
 const root = await mkdtemp(join(tmpdir(), 'route-process-'));
 try {
  const definitions = new URL('./route-definitions.ts', import.meta.url).href;
  const cache = new URL('./route-cache.ts', import.meta.url).href;
  await writeFile(join(root, 'routes.ts'), `import { defineRoutes } from ${JSON.stringify(definitions)}; export default defineRoutes([{method:'GET',path:'/',handler:{module:'handler.ts',export:'index'}}]);`);
  await writeFile(join(root, 'handler.ts'), `export function index() { return new Response('persisted'); }`);
  await cacheRoutes(root);
  await writeFile(join(root, 'routes.ts'), `throw new Error('source must not run')`);
  const code = `import { loadCachedRoutes } from ${JSON.stringify(cache)}; import { hydrateRoutes } from ${JSON.stringify(definitions)}; const root = ${JSON.stringify(root)}; const router = await hydrateRoutes(root, await loadCachedRoutes(root)); console.log(await (await router.fetch(new Request('http://localhost/'))).text());`;
  const process = Bun.spawn([processPath(), '-e', code], { env: { ...processEnv(), BUN_OPTIONS: '' }, stdout: 'pipe', stderr: 'pipe' });
  expect(await process.exited).toBe(0);
  expect((await new Response(process.stdout).text()).trim()).toBe('persisted');
 } finally { await rm(root, { recursive: true, force: true }); }
});
function processPath(): string { return process.execPath; }
function processEnv(): NodeJS.ProcessEnv { return process.env; }

test('rejects closure routers, unknown cache format and unsafe parents', async () => {
 const root = await mkdtemp(join(tmpdir(), 'route-refuse-'));
 const outside = await mkdtemp(join(tmpdir(), 'route-outside-'));
 try {
  await writeFile(join(root, 'routes.ts'), `export default { fetch() {} }`);
  await expect(cacheRoutes(root)).rejects.toThrow('not cacheable');
  await mkdir(join(root, 'bootstrap/cache'), { recursive: true });
  await writeFile(join(root, 'bootstrap/cache/routes.json'), JSON.stringify({version: 1, routes: [], extra: true}));
  await expect(loadCachedRoutes(root)).rejects.toThrow();
  await rm(join(root, 'bootstrap'), { recursive: true });
  await symlink(outside, join(root, 'bootstrap'));
  await expect(loadCachedRoutes(root)).rejects.toThrow();
  await expect(clearRouteCache(root)).rejects.toThrow();
 } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});


test('rejects hard-linked cache files and invalid cache options', async () => {
 const root = await mkdtemp(join(tmpdir(), 'route-hardlink-'));
 try {
  await mkdir(join(root, 'bootstrap/cache'), { recursive: true });
  const path = join(root, 'bootstrap/cache/routes.json');
  await writeFile(path, '{}');
  await link(path, join(root, 'other'));
  await expect(loadCachedRoutes(root)).rejects.toThrow();
  await expect(clearRouteCache(root)).rejects.toThrow();
  await expect(cacheRoutes(root, { overwrite: true })).rejects.toThrow();
  await expect(cacheRoutes(root, { unknown: true } as never)).rejects.toThrow();
 } finally { await rm(root, { recursive: true, force: true }); }
});
