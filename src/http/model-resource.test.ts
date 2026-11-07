import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntitySchema } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/sqlite';
import { Router, type HttpContext } from './router';
import { modelResourceFor, modelResourceMiddleware, type ModelResourceOptions } from './model-resource';

class Item { id!: number; name!: string; }
class Other { id!: number; name!: string; }
class Composite { left!: number; right!: number; name!: string; }
const schema = new EntitySchema<Item>({ class: Item, properties: { id: { type: 'number', primary: true }, name: { type: 'string' } } });
const otherSchema = new EntitySchema<Other>({ class: Other, properties: { id: { type: 'number', primary: true }, name: { type: 'string' } } });
const compositeSchema = new EntitySchema<Composite>({ class: Composite, properties: { left: { type: 'number', primary: true }, right: { type: 'number', primary: true }, name: { type: 'string' } } });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundle-resource-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const orm = await MikroORM.init({ entities: [schema, otherSchema, compositeSchema], dbName: join(root, 'test.sqlite') });
  cleanup.push(() => orm.close(true));
  await orm.schema.create();
  const supplied = orm.em.fork();
  const options: ModelResourceOptions<Item> = {
    model: Item, manager: () => supplied, parseId: value => Number(value),
    create: async context => { const value = await context.request.json() as { name?: string }; return typeof value.name === 'string' ? { name: value.name } : new Response('invalid', { status: 422 }); },
    update: async context => await context.request.json() as { name?: string },
    serialize: item => ({ id: item.id, name: item.name }),
  };
  const router = new Router();
  const middleware = modelResourceMiddleware(options);
  router.add('GET', '/items', context => modelResourceFor(context, Item).index(context), { middleware: [middleware] });
  router.add('POST', '/items', context => modelResourceFor(context, Item).store(context), { middleware: [middleware] });
  for (const [method, operation] of [['GET', 'show'], ['PATCH', 'update'], ['DELETE', 'destroy']] as const) {
    router.add(method, '/items/:id', context => modelResourceFor(context, Item)[operation](context), { middleware: [middleware] });
  }
  const request = (path: string, method = 'GET', body?: unknown) => router.fetch(new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { orm, supplied, options, router, request };
}

test('resource middleware requires explicit own data callbacks', () => {
  expect(() => modelResourceMiddleware({} as never)).toThrow();
  expect(() => modelResourceMiddleware({ get model() { throw new Error('getter invoked'); } } as never)).toThrow('Invalid resource options');
});

test('options reject unknown properties and do not invoke accessor callbacks', async () => {
  const { options } = await fixture();
  let invoked = false;
  const accessor = { ...options, get create() { invoked = true; return options.create; } };
  expect(() => modelResourceMiddleware(accessor)).toThrow();
  expect(invoked).toBe(false);
  expect(() => modelResourceMiddleware({ ...options, extra: true } as never)).toThrow();
  expect(() => modelResourceMiddleware(Object.assign(Object.create(options), {}))).toThrow();
});

test('real SQLite CRUD uses isolated forks and explicit validation', async () => {
  const { orm, supplied, request } = await fixture();
  const pending = supplied.create(Item, { name: 'not flushed' });
  let response = await request('/items', 'POST', { name: 'one' });
  expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
  const created = await response.json() as { id: number; name: string };
  expect(created.name).toBe('one');
  expect(await orm.em.fork().count(Item)).toBe(1);
  response = await request('/items'); expect(await response.json()).toEqual([created]);
  response = await request(`/items/${created.id}`); expect(await response.json()).toEqual(created);
  response = await request(`/items/${created.id}`, 'PATCH', { name: 'two' }); expect(response.status).toBe(200); expect((await response.json() as Item).name).toBe('two');
  response = await request('/items', 'POST', {}); expect(response.status).toBe(422); expect(response.headers.get('cache-control')).toBe('no-store');
  response = await request(`/items/${created.id}`, 'PATCH', { id: 99 }); expect(response.status).toBe(500);
  response = await request('/items/0'); expect(response.status).toBe(400); expect(response.headers.get('cache-control')).toBe('no-store');
  response = await request('/items/999'); expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toBe('no-store');
  response = await request(`/items/${created.id}`, 'DELETE'); expect(response.status).toBe(204); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await orm.em.fork().count(Item)).toBe(0);
  expect(pending.name).toBe('not flushed');
  await supplied.flush(); expect(await orm.em.fork().count(Item)).toBe(1);
});

test('snapshot, duplicate binding, cleanup and sanitized failures', async () => {
  const { options, supplied } = await fixture();
  let captured: HttpContext | undefined;
  const middleware = modelResourceMiddleware(options);
  const writer = supplied.fork(); writer.create(Item, { name: 'snapshot' }); await writer.flush();
  (options as { serialize: ModelResourceOptions<Item>['serialize'] }).serialize = () => { throw Error('secret'); };
  const router = new Router().add('GET', '/one', async context => { captured = context; return modelResourceFor(context, Item).index(context); }, { middleware: [middleware] });
  const snapshot = await router.fetch(new Request('http://localhost/one'));
  expect(snapshot.status).toBe(200); expect(await snapshot.json()).toEqual([{ id: 1, name: 'snapshot' }]);
  expect(() => modelResourceFor(captured!, Item)).toThrow();
  const duplicate = new Router().add('GET', '/', () => new Response('never'), { middleware: [middleware, middleware] });
  const response = await duplicate.fetch(new Request('http://localhost/')); expect(response.status).toBe(500); expect(await response.text()).toBe('Internal Server Error');
  expect(await supplied.count(Item)).toBe(1);
});

test.each(['serializer', 'registration'] as const)('sanitized %s failures preserve no-store without private error text', async scenario => {
  const { options, orm } = await fixture();
  const middleware = modelResourceMiddleware({ ...options, serialize: () => { throw Error('private-resource-exception'); } });
  const router = scenario === 'serializer'
    ? new Router().add('POST', '/', c => modelResourceFor(c, Item).store(c), { middleware: [middleware] })
    : new Router().add('GET', '/', c => modelResourceFor(c, Item).index(c));
  const response = await router.fetch(new Request('http://localhost/', scenario === 'serializer'
    ? { method: 'POST', body: JSON.stringify({ name: 'committed before serialization' }) } : {}));
  expect(response.status).toBe(500);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).toBe('Internal Server Error');
  expect(await orm.em.fork().count(Item)).toBe(scenario === 'serializer' ? 1 : 0);
});

test.each(['index', 'show'] as const)('observes abort after serializer wrapper completion before %s response', async operation => {
  const { options, orm } = await fixture();
  const writer = orm.em.fork(); writer.create(Item, { name: 'must not be emitted' }); await writer.flush();
  const abort = new AbortController();
  const middleware = modelResourceMiddleware({ ...options, serialize: item => {
    queueMicrotask(() => queueMicrotask(() => abort.abort()));
    return { id: item.id, name: item.name };
  } });
  const route = new Router().add('GET', '/items/:id', context => modelResourceFor(context, Item)[operation](context), { middleware: [middleware] });
  const response = await route.fetch(new Request('http://localhost/items/1', { signal: abort.signal }));
  expect(abort.signal.aborted).toBe(true);
  expect(response.status).toBe(500);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).toBe('Internal Server Error');
});

test('aborting during a parser prevents persistence', async () => {
  const { options, orm } = await fixture();
  const abort = new AbortController();
  const middleware = modelResourceMiddleware({ ...options, create: async () => { await Promise.resolve(); abort.abort(); return { name: 'no' }; } });
  const router = new Router().add('POST', '/', context => modelResourceFor(context, Item).store(context), { middleware: [middleware] });
  const response = await router.fetch(new Request('http://localhost/', { method: 'POST', signal: abort.signal }));
  expect(response.status).toBe(500); expect(await orm.em.fork().count(Item)).toBe(0);
});

test('index is limited to 100 and output size is bounded', async () => {
  const { orm, options } = await fixture();
  const writer = orm.em.fork();
  for (let i = 0; i < 101; i++) writer.create(Item, { name: String(i) });
  await writer.flush();
  const route = (middleware: ReturnType<typeof modelResourceMiddleware<Item>>) => new Router().add('GET', '/', c => modelResourceFor(c, Item).index(c), { middleware: [middleware] });
  const response = await route(modelResourceMiddleware(options)).fetch(new Request('http://localhost/'));
  expect((await response.json() as unknown[]).length).toBe(100);
  const oversized = await route(modelResourceMiddleware({ ...options, serialize: () => 'x'.repeat(1024 * 1024) })).fetch(new Request('http://localhost/'));
  expect(oversized.status).toBe(500); expect(await oversized.text()).toBe('Internal Server Error');
});

test('validation response statuses and native manager are enforced', async () => {
  const { options } = await fixture();
  const invoke = async (custom: ModelResourceOptions<Item>) => new Router().add('POST', '/', c => modelResourceFor(c, Item).store(c), { middleware: [modelResourceMiddleware(custom)] }).fetch(new Request('http://localhost/', { method: 'POST' }));
  expect((await invoke({ ...options, create: () => new Response(null, { status: 200 }) })).status).toBe(500);
  const rejected = await invoke({ ...options, create: () => new Response('no', { status: 400, headers: { 'cache-control': 'public' } }) });
  expect(rejected.status).toBe(400); expect(rejected.headers.get('cache-control')).toBe('no-store');
  expect((await invoke({ ...options, manager: () => ({ fork() {} }) as never })).status).toBe(500);
});

test('owned fork is cleared on handler failure without clearing supplied manager', async () => {
  const { options, supplied } = await fixture();
  const owned = supplied.fork();
  const fork = spyOn(supplied, 'fork').mockReturnValue(owned);
  const ownedClear = spyOn(owned, 'clear');
  const suppliedClear = spyOn(supplied, 'clear');
  const route = new Router().add('GET', '/', async () => { await Promise.resolve(); throw new Error('secret'); }, { middleware: [modelResourceMiddleware(options)] });
  expect((await route.fetch(new Request('http://localhost/'))).status).toBe(500);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(ownedClear).toHaveBeenCalledTimes(1);
  expect(suppliedClear).not.toHaveBeenCalled();
  fork.mockRestore(); ownedClear.mockRestore(); suppliedClear.mockRestore();
});

test('scalar IDs enforce positive safe numbers and bounded ASCII strings before query', async () => {
  const { options, supplied } = await fixture();
  let parsed: string | number = 1;
  const owned = supplied.fork();
  const fork = spyOn(supplied, 'fork').mockReturnValue(owned);
  const find = spyOn(owned, 'findOne');
  const route = new Router().add('GET', '/:id', c => modelResourceFor(c, Item).show(c), { middleware: [modelResourceMiddleware({ ...options, parseId: () => parsed })] });
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '', '-x', 'x/y', 'é', 'x'.repeat(129)]) {
    parsed = value;
    const response = await route.fetch(new Request('http://localhost/x'));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(find).not.toHaveBeenCalled();
  for (const value of [1, Number.MAX_SAFE_INTEGER, 'a', 'a_.:-', 'x'.repeat(128)]) {
    parsed = value;
    expect((await route.fetch(new Request('http://localhost/x'))).status).toBe(404);
  }
  expect(find).toHaveBeenCalledTimes(5);
  find.mockRestore(); fork.mockRestore();
});

test('composite primary keys and missing registrations fail closed', async () => {
  const { supplied } = await fixture();
  const middleware = modelResourceMiddleware<Composite>({ model: Composite, manager: () => supplied, parseId: Number, create: () => ({ left: 1, right: 2, name: 'x' }), update: () => ({}), serialize: value => value });
  const composite = new Router().add('GET', '/', c => modelResourceFor(c, Composite).index(c), { middleware: [middleware] });
  const response = await composite.fetch(new Request('http://localhost/'));
  expect(response.status).toBe(500); expect(await response.text()).toBe('Internal Server Error');
  const missing = new Router().add('GET', '/', c => modelResourceFor(c, Item).index(c));
  expect((await missing.fetch(new Request('http://localhost/'))).status).toBe(500);
});

test('aborts after awaited provider, update and serializer stop subsequent operations', async () => {
  const { options, orm } = await fixture();
  const writer = orm.em.fork();
  writer.create(Item, { name: 'original' }); await writer.flush();
  const execute = async (method: string, operation: 'store' | 'update' | 'show', modified: ModelResourceOptions<Item>, signal: AbortSignal) => {
    const route = new Router().add(method, '/:id', c => modelResourceFor(c, Item)[operation](c), { middleware: [modelResourceMiddleware(modified)] });
    return route.fetch(new Request('http://localhost/1', { method, signal }));
  };
  let aborted = new AbortController();
  let createCalled = false;
  let response = await execute('POST', 'store', { ...options, manager: async () => { await Promise.resolve(); aborted.abort(); return options.manager({} as HttpContext); }, create: () => { createCalled = true; return { name: 'new' }; } }, aborted.signal);
  expect(response.status).toBe(500); expect(createCalled).toBe(false); expect(await orm.em.fork().count(Item)).toBe(1);
  aborted = new AbortController();
  response = await execute('PATCH', 'update', { ...options, update: async () => { await Promise.resolve(); aborted.abort(); return { name: 'changed' }; } }, aborted.signal);
  expect(response.status).toBe(500); expect((await orm.em.fork().findOneOrFail(Item, { id: 1 })).name).toBe('original');
  aborted = new AbortController();
  response = await execute('GET', 'show', { ...options, serialize: async () => { await Promise.resolve(); aborted.abort(); return { name: 'not returned' }; } }, aborted.signal);
  expect(response.status).toBe(500); expect(await response.text()).toBe('Internal Server Error');
});

test('nested distinct bindings survive await and are cleaned after failure', async () => {
  const { options, supplied } = await fixture();
  const a = modelResourceMiddleware(options);
  const b = modelResourceMiddleware({ ...options, model: Other, manager: () => supplied });
  let context: HttpContext | undefined;
  const route = new Router().add('GET', '/', async c => {
    context = c;
    await Promise.resolve();
    expect(modelResourceFor(c, Item)).toBeDefined(); expect(modelResourceFor(c, Other)).toBeDefined();
    throw new Error('private');
  }, { middleware: [a, b] });
  const response = await route.fetch(new Request('http://localhost/'));
  expect(response.status).toBe(500); expect(await response.text()).toBe('Internal Server Error');
  expect(() => modelResourceFor(context!, Item)).toThrow(); expect(() => modelResourceFor(context!, Other)).toThrow();
});
