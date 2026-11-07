import { expect, test } from 'bun:test';
import { definePackages } from './definitions';

test('validates and snapshots package definitions', () => {
  const input = [{ name: 'demo', providers: [{ module: 'provider.ts', export: 'Provider' }] }];
  const result = definePackages(input);
  input[0]!.providers[0]!.module = 'changed.ts';
  expect(result[0]!.providers[0]!.module).toBe('provider.ts');
  expect(Object.isFrozen(result[0]!.providers)).toBe(true);
});

test('rejects invalid names, duplicate providers, sparse arrays and accessor records', () => {
  expect(() => definePackages([{ name: 'Bad', providers: [] }])).toThrow();
  const ref = { module: 'provider.ts', export: 'Provider' };
  expect(() => definePackages([{ name: 'a', providers: [ref] }, { name: 'b', providers: [ref] }])).toThrow();
  expect(() => definePackages(new Array(1))).toThrow();
  expect(() => definePackages([{ get name(): string { throw new Error('executed'); }, providers: [] }])).toThrow('Invalid');
  expect(() => definePackages(Array.from({ length: 33 }, (_, i) => ({ name: `p${i}`, providers: [] })))).toThrow();
  expect(() => definePackages([{ name: 'a', providers: Array.from({ length: 64 }, (_, i) => ({ module: `p${i}.ts`, export: 'P' })) }, { name: 'b', providers: [ref] }])).toThrow();
});
