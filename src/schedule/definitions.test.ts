import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSchedules, loadSchedules } from './definitions';

const task = () => ({ id: 'daily', argv: ['list', '--json'], expression: '* * * * *' });
test('copies, normalizes and freezes definitions', () => {
  const input = task(); const result = defineSchedules([input]); input.argv.push('changed');
  expect(result).toEqual([{ id: 'daily', argv: ['list', '--json'], expression: '* * * * *', timezone: 'UTC', overlap: 'skip' }]);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0])).toBe(true); expect(Object.isFrozen(result[0]!.argv)).toBe(true);
});
test('rejects malformed closed shapes, duplicates and bounds', () => {
  const invalid: unknown[] = [[task(), task()], Array(1), [Object.assign(task(), { extra: 1 })], [{ ...task(), timezone: 'Europe/Paris' }], [{ ...task(), overlap: 'other' }], [{ ...task(), expression: 'bad' }], [{ ...task(), argv: [] }], [{ ...task(), argv: ['bad command'] }], [{ ...task(), argv: ['list', '\ud800'] }], [{ ...task(), argv: ['list', '\0'] }], [{ ...task(), argv: ['list', 'x'.repeat(4097)] }], Array.from({length: 129}, (_, i) => ({ ...task(), id: `x${i}` })), [Object.assign(task(), { [Symbol('x')]: 1 })], [Object.assign(Object.create({}), task())], [{ ...task(), argv: Array(1) }]];
  let accessed = false; const getter = task(); Object.defineProperty(getter, 'id', { enumerable: true, get() { accessed = true; return 'daily'; } }); invalid.push([getter]);
  for (const item of invalid) expect(() => defineSchedules(item as never)).toThrow();
  expect(accessed).toBe(false);
  expect(() => defineSchedules([{ ...task(), argv: ['list', ...Array(20).fill('x'.repeat(4096))] }])).toThrow();
  expect(() => defineSchedules(Array.from({length: 128}, (_, i) => ({ ...task(), id: `t${i}`, argv: ['list', ...Array(3).fill('x'.repeat(4096))] })))).toThrow();
});
test('loads only a safe root source with canonical aliases and generic errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bundle-schedule-')); const root = join(dir, 'root'); const alias = join(dir, 'alias');
  try {
    await mkdir(root); await symlink(root, alias);
    expect(await loadSchedules(root)).toEqual([]);
    await writeFile(join(root, 'schedule.ts'), `export default [{id:'one',argv:['list'],expression:'0 0 * * *'}]`);
    expect(await loadSchedules(alias)).toEqual(await loadSchedules(root));
    await rm(join(root, 'schedule.ts')); await writeFile(join(dir, 'outside.ts'), 'export default []'); await symlink(join(dir, 'outside.ts'), join(root, 'schedule.ts'));
    await expect(loadSchedules(root)).rejects.toThrow(); await rm(join(root, 'schedule.ts'));
    await link(join(dir, 'outside.ts'), join(root, 'schedule.ts')); await expect(loadSchedules(root)).rejects.toThrow(); await rm(join(root, 'schedule.ts'));
    await writeFile(join(root, 'schedule.ts'), 'x'.repeat(1048577)); await expect(loadSchedules(root)).rejects.toThrow();
    await expect(loadSchedules('relative')).rejects.toThrow();
    const bad = join(dir, 'bad'); await mkdir(bad); await writeFile(join(bad, 'schedule.ts'), `throw new Error('sensitive'); export default []`);
    await expect(loadSchedules(bad)).rejects.toThrow('Unable to load schedules');
    const generated = join(dir, 'generated'); await mkdir(generated);
    const definitions = new URL('./definitions.ts', import.meta.url).href;
    await writeFile(join(generated, 'schedule.ts'), `import { defineSchedules } from ${JSON.stringify(definitions)}; export default defineSchedules([{id:'generated',argv:['list'],expression:'* * * * *'}]);`);
    expect((await loadSchedules(generated))[0]?.id).toBe('generated');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
