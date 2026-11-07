import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineRoutes, hydrateRoutes } from './route-definitions';

test('validates, freezes and hydrates route references with fresh class instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routes-'));
  try {
    await writeFile(join(root, 'handlers.ts'), `export class Controller { #n = 0; show(ctx) { return new Response(String(++this.#n) + ctx.state.get('tag')); } }\nexport async function tag(ctx, next) { ctx.state.set('tag', '!'); return next(); }`);
    const definitions = defineRoutes([{ method: 'GET', path: '/x', handler: { module: 'handlers.ts', export: 'Controller', method: 'show' }, middleware: [{ module: 'handlers.ts', export: 'tag' }] }]);
    expect(Object.isFrozen(definitions[0]!.handler)).toBe(true);
    const router = await hydrateRoutes(root, definitions);
    expect(await (await router.fetch(new Request('http://localhost/x'))).text()).toBe('1!');
    expect(await (await router.fetch(new Request('http://localhost/x'))).text()).toBe('1!');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects direct entrypoint references in cacheable handlers and middleware', () => {
  expect(() => defineRoutes([{ method: 'GET', path: '/', handler: { module: 'routes.ts', export: 'index' } }])).toThrow('entrypoint');
  expect(() => defineRoutes([{ method: 'GET', path: '/', handler: { module: 'handler.ts', export: 'index' }, middleware: [{ module: 'routes.ts', export: 'audit' }] }])).toThrow('entrypoint');
});

test('rejects malformed definitions and unsafe module files', async () => {
  expect(() => defineRoutes([{ method: 'GET', path: '/', handler: { module: '../x.ts', export: 'x' } }])).toThrow();
  expect(() => defineRoutes([{ method: 'GET', path: '/', handler: { module: 'x.ts', export: 'constructor' } }])).toThrow();
  expect(() => defineRoutes([{ method: 'GET', path: '/', handler: { module: 'x.ts', export: 'x' }, extra: true }] as never)).toThrow();
  const root = await mkdtemp(join(tmpdir(), 'routes-'));
  try {
    await writeFile(join(root, 'good.ts'), 'export const value = 1;');
    await symlink(join(root, 'good.ts'), join(root, 'sym.ts'));
    await link(join(root, 'good.ts'), join(root, 'hard.ts'));
    for (const file of ['sym.ts', 'hard.ts', 'good.ts']) {
      await expect(hydrateRoutes(root, defineRoutes([{ method: 'GET', path: '/', handler: { module: file, export: 'value' } }]))).rejects.toThrow();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('hydrates direct functions and rejects missing exports, invalid controllers and unsafe parents', async () => {
 const root = await mkdtemp(join(tmpdir(), 'route-exports-'));
 try {
  await writeFile(join(root, 'handler.ts'), `export function index() { return new Response('ok'); } export class Controller { get value() { return () => new Response(); } }`);
  const definition = (handler: {module: string; export: string; method?: string}) => defineRoutes([{ method: 'GET', path: '/', handler }]);
  const router = await hydrateRoutes(root, definition({module: 'handler.ts', export: 'index'}));
  expect(await (await router.fetch(new Request('http://localhost/'))).text()).toBe('ok');
  await expect(hydrateRoutes(root, definition({module: 'handler.ts', export: 'missing'}))).rejects.toThrow();
  await expect(hydrateRoutes(root, definition({module: 'handler.ts', export: 'Controller'}))).rejects.toThrow();
  await expect(hydrateRoutes(root, definition({module: 'handler.ts', export: 'Controller', method: 'value'}))).rejects.toThrow();
  await symlink(root, join(root, 'linked'));
  await expect(hydrateRoutes(root, definition({module: 'linked/handler.ts', export: 'index'}))).rejects.toThrow();
 } finally { await rm(root, { recursive: true, force: true }); }
});
