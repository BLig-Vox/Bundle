import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePrunable, definePruning, loadPruning } from './pruning-definitions.ts';

class Example {}
test('snapshots branded rules and rejects duplicates', () => {
  const input = { name: 'Example', model: Example, where: () => ({}) };
  const rule = definePrunable(input);
  input.name = 'Changed';
  expect(rule.name).toBe('Example');
  expect(Object.keys(rule)).toEqual(['name']);
  expect(definePruning([rule])).toHaveLength(1);
  expect(() => definePruning([rule, rule])).toThrow();
});

test('rejects accessors, symbols, sparse lists, duplicate identities and oversized registries', () => {
  let called = false;
  expect(() => definePrunable({ get name() { called = true; return 'Example'; }, model: Example, where: () => ({}) })).toThrow();
  expect(called).toBe(false);
  expect(() => definePrunable({ name: 'Example', model: Example, where: () => ({}), [Symbol('extra')]: true })).toThrow();
  const rule = definePrunable({ name: 'Example', model: Example, where: () => ({}) });
  const other = definePrunable({ name: 'Other', model: Example, where: () => ({}) });
  expect(() => definePruning([rule, other])).toThrow();
  expect(() => definePruning(new Array(1))).toThrow();
  expect(() => definePruning(new Array(33).fill(rule))).toThrow();
  expect(Object.isFrozen(definePruning([rule]))).toBe(true);
});

test('loads only a bounded single-link trusted source and rejects pre-abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-pruning-'));
  try {
    const file = join(root, 'pruning.ts');
    await writeFile(file, `import { definePruning } from ${JSON.stringify(import.meta.resolve('./pruning-definitions.ts'))}; export default definePruning([]);`);
    expect(await loadPruning(root)).toEqual([]);
    await link(file, join(root, 'linked.ts'));
    await expect(loadPruning(root)).rejects.toThrow('Unable to load pruning rules');
    await rm(join(root, 'linked.ts'));
    await rm(file);
    await symlink(join(root, 'absent.ts'), file);
    await expect(loadPruning(root)).rejects.toThrow('Unable to load pruning rules');
    await rm(file);
    await writeFile(file, ' '.repeat(65537));
    await expect(loadPruning(root)).rejects.toThrow('Unable to load pruning rules');
    const abort = new AbortController(); abort.abort();
    await expect(loadPruning(root, abort.signal)).rejects.toThrow('Unable to load pruning rules');
    await expect(loadPruning('relative')).rejects.toThrow('Unable to load pruning rules');
  } finally { await rm(root, { recursive: true, force: true }); }
});
