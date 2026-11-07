import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerModelPrune } from './model-prune.ts';
import { createCli } from './program.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundle-prune-cli-')); roots.push(root); return root;
}
function command(root: string, signal?: AbortSignal) {
  const program = new Command().option('--force').exitOverride().configureOutput({ writeErr() {} });
  let opens = 0;
  registerModelPrune(program, { root, signal, output() { throw new Error('Unexpected output'); }, database: async () => { opens++; throw new Error('Unexpected database open'); } });
  return { program, opens: () => opens };
}
async function source(root: string) {
  const sdk = pathToFileURL(join(import.meta.dir, '../database/pruning-definitions.ts')).href;
  await writeFile(join(root, 'pruning.ts'), `import { definePruning } from ${JSON.stringify(sdk)}; export default definePruning([]);`);
}
test('pruning refuses mutation without force before importing source or opening database', async () => {
  const root = await fixture(); const marker = join(root, 'imported');
  await writeFile(join(root, 'pruning.ts'), `await Bun.write(${JSON.stringify(marker)}, 'secret'); throw Error('private-source-detail');`);
  const cli = command(root);
  await expect(cli.program.parseAsync(['model:prune'], { from: 'user' })).rejects.toThrow('requires --force');
  expect(cli.opens()).toBe(0); expect(await Bun.file(marker).exists()).toBe(false);
});
test('pruning validates selectors and bounds before source import or database open', async () => {
  const root = await fixture();
  for (const args of [['--chunk', '0'], ['--chunk', '1001'], ['--limit', '10001'], ['--model', 'User,User'], ['--model', 'constructor'], ['--model', 'User,']]) {
    const cli = command(root);
    await expect(cli.program.parseAsync(['model:prune', '--pretend', ...args], { from: 'user' })).rejects.toThrow();
    expect(cli.opens()).toBe(0);
  }
});
test('unknown configured selectors refuse before database open', async () => {
  const root = await fixture(); await source(root); const cli = command(root);
  await expect(cli.program.parseAsync(['model:prune', '--pretend', '--model', 'Missing'], { from: 'user' })).rejects.toThrow('Model pruning failed.');
  expect(cli.opens()).toBe(0);
});
test('pre-aborted pruning never imports source or opens database', async () => {
  const root = await fixture(); const controller = new AbortController(); controller.abort(); const cli = command(root, controller.signal);
  await expect(cli.program.parseAsync(['--force', 'model:prune'], { from: 'user' })).rejects.toThrow('cancelled');
  expect(cli.opens()).toBe(0);
});
test('pruning source failures do not leak trusted exception detail', async () => {
  const root = await fixture(); await writeFile(join(root, 'pruning.ts'), `throw Error('private-source-detail');`); const cli = command(root);
  try { await cli.program.parseAsync(['model:prune', '--pretend'], { from: 'user' }); throw Error('expected refusal'); }
  catch (error) { expect(String(error)).toContain('Model pruning failed.'); expect(String(error)).not.toContain('private-source-detail'); }
  expect(cli.opens()).toBe(0);
});
test('actual CLI database injection refuses missing SQLite without creating parents or files', async () => {
  const root = await fixture(); await source(root);
  const database = join(root, 'missing-parent', 'missing.sqlite');
  const cli = createCli({ root, env: { DB_CONNECTION: 'sqlite', DB_DATABASE: database }, output() { throw Error('Unexpected output'); } });
  await expect(cli.parseAsync(['model:prune', '--pretend'], { from: 'user' })).rejects.toThrow('Model pruning failed.');
  expect(await Bun.file(database).exists()).toBe(false);
  await expect(lstat(join(root, 'missing-parent'))).rejects.toMatchObject({ code: 'ENOENT' });
});
test('pruning emits only after owned database cleanup and suppresses completion-aborted output', async () => {
  const { MikroORM, SqliteDriver } = await import('@mikro-orm/sqlite');
  const { default: user } = await import('../models/User.ts');
  const { default: post } = await import('../models/Post.ts');
  for (const cancelAfterWork of [false, true]) {
    const root = await fixture(); await source(root);
    const orm = await MikroORM.init({ driver: SqliteDriver, dbName: ':memory:', entities: [user, post], logger() {} });
    const controller = new AbortController(); let closed = false; const output: string[] = [];
    const program = new Command().option('--force').exitOverride();
    registerModelPrune(program, { root, signal: controller.signal, output(text) { expect(closed).toBe(true); output.push(text); }, database: async work => {
      try { const result = await work(orm); if (cancelAfterWork) controller.abort(); return result; }
      finally { await orm.close(true); closed = true; }
    } });
    const running = program.parseAsync(['model:prune', '--pretend'], { from: 'user' });
    if (cancelAfterWork) { await expect(running).rejects.toThrow('cancelled'); expect(output).toEqual([]); }
    else { await running; expect(output.map(text => JSON.parse(text))).toEqual([{ pretend: true, models: [] }]); }
    expect(closed).toBe(true);
  }
});
test('actual CLI rejects SQLite memory, symlink and hardlink targets without modifying files', async () => {
  const root = await fixture(); await source(root);
  const original = join(root, 'original.sqlite'); await writeFile(original, 'preserve-unopened-file');
  const symbolic = join(root, 'symbolic.sqlite'); await symlink(original, symbolic);
  const hard = join(root, 'hard.sqlite'); await link(original, hard);
  for (const database of [':memory:', symbolic, hard, root]) {
    const cli = createCli({ root, env: { DB_CONNECTION: 'sqlite', DB_DATABASE: database }, output() { throw Error('Unexpected output'); } });
    await expect(cli.parseAsync(['--force', 'model:prune'], { from: 'user' })).rejects.toThrow('Model pruning failed.');
    expect(await readFile(original, 'utf8')).toBe('preserve-unopened-file');
  }
});
