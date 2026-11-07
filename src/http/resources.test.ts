import { expect, test } from 'bun:test';
import { resource, resourceCollection } from './resources';

test('transforms fields and returns collection metadata and pagination', async () => {
  const select = (user: { id: number; password: string }) => ({ id: user.id });
  expect(await resource({ id: 1, password: 'secret' }, select).json()).toEqual({ data: { id: 1 } });
  const response = resourceCollection([{ id: 1, password: 'secret' }], select, { meta: { source: 'test' }, pagination: { page: 1, perPage: 10, total: 11 } });
  expect(await response.json()).toEqual({ data: [{ id: 1 }], meta: { source: 'test' }, pagination: { page: 1, perPage: 10, total: 11, lastPage: 2 } });
});

test('rejects lossy values, accessors, cycles and invalid pagination', () => {
  for (const value of [undefined, NaN, 1n, new Date(), { x: undefined }, [, 1], Object.defineProperty({}, 'x', { enumerable: true, get() { throw Error('secret'); } })]) {
    expect(() => resource(value, x => x)).toThrow();
  }
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  expect(() => resource(cyclic, x => x)).toThrow();
  expect(() => resourceCollection([], x => x, { pagination: { page: 0, perPage: 1, total: 0 } })).toThrow();
});
