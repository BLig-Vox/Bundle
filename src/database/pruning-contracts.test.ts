import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntitySchema, MikroORM } from '@mikro-orm/sqlite';
import { definePrunable, definePruning, loadPruning, pruningEntries } from './pruning-definitions.ts';
import { pruneModels } from './pruning.ts';
import UserSchema, { User } from '../models/User.ts';
import PostSchema, { Post } from '../models/Post.ts';

class Example {}
test('pruning definitions validate closed own-data configurations without evaluating accessors', () => {
  const valid = { name: 'Example', model: Example, where: () => ({}) };
  let accesses = 0;
  const invalid: unknown[] = [null, [], Object.create(valid), { ...valid, extra: true }, { ...valid, model: {} }, { ...valid, where: null }, { ...valid, name: 'constructor' }, { ...valid, name: 'a'.repeat(129) }, { ...valid, name: '' }, { ...valid, name: 'bad-name' }, { ...valid, where: undefined }, Object.defineProperty({ ...valid }, 'hidden', { value: true }), { ...valid, get name() { accesses++; return 'Getter'; } }];
  for (const input of invalid) expect(() => definePrunable(input as any)).toThrow();
  expect(accesses).toBe(0);
  const rule = definePrunable(Object.assign(Object.create(null), valid));
  const input = [rule]; const definitions = definePruning(input); input.length = 0;
  expect(Object.isFrozen(rule)).toBe(true); expect(definitions).toEqual([rule]);
  expect(() => definePruning([{ name: 'Unbranded' }])).toThrow();
  expect(() => definePruning(Object.assign([rule], { extra: true }))).toThrow();
});
test('pruning snapshots original model and predicate references', () => {
  const where = () => ({ id: 1 }); const input = { name: 'Example', model: Example, where };
  const rule = definePrunable(input); input.model = class Changed {}; input.where = () => ({ id: 2 });
  const [entry] = pruningEntries(definePruning([rule]));
  expect(entry!.model).toBe(Example); expect(entry!.where).toBe(where);
});
test('pruning source errors are generic, unbranded exports refuse and fixed URLs retain module identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-pruning-source-contract-'));
  try {
    const path = join(root, 'pruning.ts');
    await writeFile(path, `import {definePruning} from ${JSON.stringify(import.meta.resolve('./pruning-definitions.ts'))}; export default definePruning([]);`);
    const first = await loadPruning(root);
    await writeFile(path, `throw Error('PRIVATE_CHANGED_SOURCE');`);
    expect(await loadPruning(root)).toBe(first);
    const invalid = await mkdtemp(join(tmpdir(), 'bundle-pruning-invalid-'));
    try { await writeFile(join(invalid, 'pruning.ts'), 'export default [];'); await expect(loadPruning(invalid)).rejects.toThrow('Unable to load pruning rules'); }
    finally { await rm(invalid, { recursive: true, force: true }); }
    const broken = await mkdtemp(join(tmpdir(), 'bundle-pruning-broken-'));
    try { await writeFile(join(broken, 'pruning.ts'), `throw Error('PRIVATE_SOURCE_ERROR');`); try { await loadPruning(broken); throw Error('Unexpected success'); } catch (error) { expect(String(error)).toBe('Error: Unable to load pruning rules'); } }
    finally { await rm(broken, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('pruning refuses abort observed after trusted source import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-pruning-source-abort-')); const controller = new AbortController();
  const key = `__bundle_pruning_abort_${crypto.randomUUID()}`;
  (globalThis as any)[key] = () => controller.abort();
  try {
    await writeFile(join(root, 'pruning.ts'), `import {definePruning} from ${JSON.stringify(import.meta.resolve('./pruning-definitions.ts'))}; globalThis[${JSON.stringify(key)}](); export default definePruning([]);`);
    await expect(loadPruning(root, controller.signal)).rejects.toThrow('Unable to load pruning rules');
    expect(controller.signal.aborted).toBe(true);
  } finally { delete (globalThis as any)[key]; await rm(root, { recursive: true, force: true }); }
});

class Simple { id!: number }
class Composite { a!: number; b!: number }
class Unmapped {}
const simpleSchema = new EntitySchema({ class: Simple, properties: { id: { type: 'number', primary: true } } });
const compositeSchema = new EntitySchema({ class: Composite, properties: { a: { type: 'number', primary: true }, b: { type: 'number', primary: true } } });
test('invalid pruning options and pre-abort refuse before owned fork or predicates', async () => {
  const orm = await MikroORM.init({ entities: [simpleSchema], dbName: ':memory:' });
  try {
    const em = orm.em.fork(); let forks = 0, predicates = 0;
    const original = em.fork; em.fork = ((...args: any[]) => { forks++; return original.apply(em, args as any); }) as typeof em.fork;
    const definitions = definePruning([definePrunable({ name: 'Simple', model: Simple, where: () => { predicates++; return {}; } })]);
    const abort = new AbortController(); abort.abort();
    for (const options of [{}, { force: false }, { pretend: true, chunkSize: 0 }, { pretend: true, limit: 10001 }, { pretend: true, models: ['Missing'] }, { pretend: true, models: ['Simple', 'Simple'] }, { pretend: true, models: [] }, { pretend: true, models: undefined }, { pretend: true, signal: abort.signal }, { pretend: true, extra: 1 }]) {
      await expect(pruneModels(em, definitions, options as any)).rejects.toThrow('Unable to prune models');
    }
    expect(forks).toBe(0); expect(predicates).toBe(0);
  } finally { await orm.close(true); }
});
test('all selected metadata is validated before earlier valid rules delete', async () => {
  const orm = await MikroORM.init({ entities: [simpleSchema, compositeSchema], dbName: ':memory:' });
  try {
    await orm.schema.create(); const em = orm.em.fork(); em.create(Simple, { id: 1 }); await em.flush();
    for (const model of [Composite, Unmapped]) {
      const definitions = definePruning([definePrunable({ name: 'First', model: Simple, where: () => ({}) }), definePrunable({ name: 'Invalid', model, where: () => ({}) })]);
      await expect(pruneModels(em, definitions, { force: true })).rejects.toThrow('Unable to prune models');
      expect(await em.fork().count(Simple, {})).toBe(1);
    }
  } finally { await orm.close(true); }
});
test('cancellation after a native commit refuses success without undoing committed rows', async () => {
  const controller = new AbortController(); let enabled = false;
  const orm = await MikroORM.init({ entities: [simpleSchema], dbName: ':memory:', subscribers: [{ afterTransactionCommit() { if (enabled) controller.abort(); } }] });
  try {
    await orm.schema.create(); const em = orm.em.fork(); for (const id of [1, 2, 3]) em.create(Simple, { id }); await em.flush();
    const definitions = definePruning([definePrunable({ name: 'Simple', model: Simple, where: () => ({}) })]);
    enabled = true;
    await expect(pruneModels(em, definitions, { force: true, chunkSize: 1, signal: controller.signal })).rejects.toThrow('Unable to prune models');
    expect(controller.signal.aborted).toBe(true);
    expect((await em.fork().find(Simple, {}, { orderBy: { id: 'asc' } })).map(row => row.id)).toEqual([2, 3]);
  } finally { await orm.close(true); }
});
test('selected native bulk pruning keeps unselected rows, cascades normally and skips entity hooks', async () => {
  let removedHooks = 0, loadedHooks = 0;
  const orm = await MikroORM.init({ entities: [UserSchema, PostSchema], dbName: ':memory:', subscribers: [{ beforeDelete() { removedHooks++; }, onLoad() { loadedHooks++; } }] });
  try {
    await orm.schema.create(); const em = orm.em.fork();
    const removed = em.create(User, { name: 'Expired', email: 'expired@example.invalid' });
    const kept = em.create(User, { name: 'Protected', email: 'protected@example.invalid' });
    em.create(Post, { title: 'Cascade', slug: 'cascade', body: 'private', author: removed });
    em.create(Post, { title: 'Keep', slug: 'keep', body: 'private', author: kept }); await em.flush();
    let unselectedCalls = 0;
    const definitions = definePruning([definePrunable({ name: 'Users', model: User, where: () => ({ id: removed.id }) }), definePrunable({ name: 'Posts', model: Post, where: () => { unselectedCalls++; return {}; } })]);
    expect(await pruneModels(em, definitions, { force: true, models: ['Users'], chunkSize: 1 })).toEqual({ pretend: false, models: [{ name: 'Users', matched: 1, selected: 1, deleted: 1 }] });
    expect(unselectedCalls).toBe(0); expect(removedHooks).toBe(0); expect(loadedHooks).toBe(0);
    expect(await em.fork().count(User, {})).toBe(1); expect(await em.fork().count(Post, {})).toBe(1);
  } finally { await orm.close(true); }
});
