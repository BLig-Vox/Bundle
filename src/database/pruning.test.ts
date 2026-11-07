import { expect, test } from 'bun:test';
import { EntitySchema, MikroORM } from '@mikro-orm/sqlite';
import { definePrunable, definePruning } from './pruning-definitions.ts';
import { pruneModels } from './pruning.ts';

class RecordRow { id!: number; eligible!: boolean }
const schema = new EntitySchema({ class: RecordRow, properties: { id: { type: 'number', primary: true, fieldName: 'row_id' }, eligible: { type: 'boolean' } } });
test('preview and bounded chunks operate on mapped primary keys', async () => {
  const orm = await MikroORM.init({ entities: [schema], dbName: ':memory:' });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    for (let i = 1; i <= 5; i++) em.create(RecordRow, { id: i, eligible: i < 5 });
    await em.flush();
    const definitions = definePruning([definePrunable({ name: 'RecordRow', model: RecordRow, where: () => ({ eligible: true }) })]);
    expect(await pruneModels(em, definitions, { pretend: true, limit: 3 })).toEqual({ pretend: true, models: [{ name: 'RecordRow', matched: 4, selected: 3, deleted: 0 }] });
    expect(await pruneModels(em, definitions, { force: true, chunkSize: 2, limit: 3 })).toEqual({ pretend: false, models: [{ name: 'RecordRow', matched: 4, selected: 3, deleted: 3 }] });
    expect(await em.fork().count(RecordRow, {})).toBe(2);
  } finally { await orm.close(true); }
});

test('refuses invalid later predicates before deleting any earlier rule', async () => {
  const orm = await MikroORM.init({ entities: [schema, filteredSchema], dbName: ':memory:' });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    em.create(RecordRow, { id: 1, eligible: true });
    await em.flush();
    const definitions = definePruning([
      definePrunable({ name: 'First', model: RecordRow, where: () => ({}) }),
      definePrunable({ name: 'Second', model: FilteredRow, where: () => null as any }),
    ]);
    await expect(pruneModels(em, definitions, { force: true })).rejects.toThrow('Unable to prune models');
    expect(await em.fork().count(RecordRow, {})).toBe(1);
    await expect(pruneModels(em, definitions, { pretend: true, models: ['missing'] })).rejects.toThrow();
  } finally { await orm.close(true); }
});

test('cancellation during a later delete rolls back its chunk and retains prior commits', async () => {
  class AbortRow { id!: number }
  const abort = new AbortController();
  let deletes = 0;
  const abortSchema = new EntitySchema({ class: AbortRow, properties: { id: { type: 'number', primary: true } }, filters: { gate: { name: 'gate', default: true, args: false, cond: (_args, type) => { if (type === 'delete' && ++deletes === 2) abort.abort(); return {}; } } } });
  const orm = await MikroORM.init({ entities: [abortSchema], dbName: ':memory:' });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    for (let id = 1; id <= 4; id++) em.create(AbortRow, { id });
    await em.flush();
    const definitions = definePruning([definePrunable({ name: 'AbortRow', model: AbortRow, where: () => ({}) })]);
    await expect(pruneModels(em, definitions, { force: true, chunkSize: 2, signal: abort.signal })).rejects.toThrow('Unable to prune models');
    expect((await em.fork().find(AbortRow, {}, { orderBy: { id: 'asc' } })).map(row => row.id)).toEqual([3, 4]);
  } finally { await orm.close(true); }
});

class BigRow { id!: bigint }
const bigSchema = new EntitySchema({ class: BigRow, properties: { id: { type: 'bigint', primary: true, fieldName: 'big_key' } } });
test('supports mapped native bigint primary keys', async () => {
  const orm = await MikroORM.init({ entities: [bigSchema], dbName: ':memory:' });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    em.create(BigRow, { id: 1n });
    await em.flush();
    const definitions = definePruning([definePrunable({ name: 'BigRow', model: BigRow, where: () => ({}) })]);
    expect(await pruneModels(em, definitions, { force: true })).toEqual({ pretend: false, models: [{ name: 'BigRow', matched: 1, selected: 1, deleted: 1 }] });
  } finally { await orm.close(true); }
});

test('prunes exact SQLite bigint keys beyond safe integer without deleting the adjacent key', async () => {
  const orm = await MikroORM.init({ entities: [bigSchema], dbName: ':memory:' });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    await em.getConnection().execute('insert into big_row (big_key) values (9007199254740993), (9007199254740994)');
    const definitions = definePruning([definePrunable({ name: 'BigRow', model: BigRow, where: () => ({}) })]);
    expect(await pruneModels(em, definitions, { force: true, limit: 1 })).toEqual({ pretend: false, models: [{ name: 'BigRow', matched: 2, selected: 1, deleted: 1 }] });
    const rows = await em.getConnection().execute('select cast(big_key as text) as id from big_row');
    expect(rows.map(row => row.id)).toEqual(['9007199254740994']);
  } finally { await orm.close(true); }
});

class TextRow { id!: string }
const textSchema = new EntitySchema({ class: TextRow, properties: { id: { type: 'string', primary: true, fieldName: 'text_key' } } });
test('selects string primary keys in deterministic order without entity hydration', async () => {
  const orm = await MikroORM.init({ entities: [textSchema], dbName: ':memory:' });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    for (const id of ['c', 'a', 'b']) em.create(TextRow, { id });
    await em.flush();
    const definitions = definePruning([definePrunable({ name: 'TextRow', model: TextRow, where: () => ({}) })]);
    expect(await pruneModels(em, definitions, { force: true, limit: 2, chunkSize: 1 })).toEqual({ pretend: false, models: [{ name: 'TextRow', matched: 3, selected: 2, deleted: 2 }] });
    expect((await em.fork().find(TextRow, {})).map(row => row.id)).toEqual(['c']);
  } finally { await orm.close(true); }
});

class FilteredRow { id!: number; visible!: boolean }
const filteredSchema = new EntitySchema({ class: FilteredRow, properties: { id: { type: 'number', primary: true, fieldName: 'mapped_id' }, visible: { type: 'boolean' } }, filters: { visibleOnly: { name: 'visibleOnly', cond: { visible: true }, default: true } } });
test('native default filters apply to count, selected raw mapped keys, and deletion', async () => {
  const orm = await MikroORM.init({ entities: [filteredSchema], dbName: ':memory:' });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    em.create(FilteredRow, { id: 1, visible: false });
    em.create(FilteredRow, { id: 2, visible: true });
    em.create(FilteredRow, { id: 3, visible: true });
    await em.flush();
    const definitions = definePruning([definePrunable({ name: 'FilteredRow', model: FilteredRow, where: () => ({}) })]);
    expect(await pruneModels(em, definitions, { force: true, chunkSize: 1 })).toEqual({ pretend: false, models: [{ name: 'FilteredRow', matched: 2, selected: 2, deleted: 2 }] });
    expect((await em.fork().find(FilteredRow, {}, { filters: false })).map(row => row.id)).toEqual([1]);
  } finally { await orm.close(true); }
});

test('a failed later chunk rolls back that chunk while preserving earlier commits and caller pending state', async () => {
  const orm = await MikroORM.init({ entities: [schema], dbName: ':memory:' });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    for (let i = 1; i <= 5; i++) em.create(RecordRow, { id: i, eligible: true });
    await em.flush();
    await em.getConnection().execute(`create trigger block_four before delete on record_row when old.row_id = 4 begin select raise(abort, 'private failure'); end`);
    em.create(RecordRow, { id: 6, eligible: false });
    const definitions = definePruning([definePrunable({ name: 'RecordRow', model: RecordRow, where: () => ({ eligible: true }) })]);
    await expect(pruneModels(em, definitions, { force: true, chunkSize: 2 })).rejects.toThrow('Unable to prune models');
    expect((await em.fork().find(RecordRow, {}, { orderBy: { id: 'asc' } })).map(row => row.id)).toEqual([3, 4, 5]);
    await em.flush();
    expect(await em.fork().count(RecordRow, { id: 6 })).toBe(1);
  } finally { await orm.close(true); }
});
