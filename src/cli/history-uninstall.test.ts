import { afterEach, expect, test } from 'bun:test';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCli } from './program.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'bundle-history-cli-')); roots.push(root); return root; }
test('history uninstall requires force before resolving even an invalid target', async () => {
  const root = await fixture(); const output: string[] = [];
  const cli = createCli({ root, env: { DB_CONNECTION: 'invalid', BUNDLE_CONNECTIONS: 'invalid' }, output: text => output.push(text) });
  await expect(cli.parseAsync(['migrate:uninstall'], { from: 'user' })).rejects.toThrow('pass --force');
  expect(output).toEqual([]);
});
test('history preview and forced removal refuse missing SQLite without creating parents', async () => {
  const root = await fixture(); const database = join(root, 'absent', 'test.sqlite');
  for (const args of [['migrate:uninstall', '--pretend'], ['--force', 'migrate:uninstall']]) {
    const cli = createCli({ root, env: { DB_CONNECTION: 'sqlite', DB_DATABASE: database }, output() { throw Error('Unexpected output'); } });
    await expect(cli.parseAsync(args, { from: 'user' })).rejects.toThrow('Migration history uninstall failed.');
    await expect(lstat(join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
test('history uninstall rejects memory, symlinks, hardlinks, directories and unsupported drivers before opening', async () => {
  const root = await fixture(); const original = join(root, 'original.sqlite'); await writeFile(original, 'untouched');
  const symbolic = join(root, 'symbolic.sqlite'); await symlink(original, symbolic);
  const hard = join(root, 'hard.sqlite'); await link(original, hard);
  for (const database of [':memory:', symbolic, hard, root]) {
    const cli = createCli({ root, env: { DB_CONNECTION: 'sqlite', DB_DATABASE: database }, output() { throw Error('Unexpected output'); } });
    await expect(cli.parseAsync(['--force', 'migrate:uninstall'], { from: 'user' })).rejects.toThrow('Migration history uninstall failed.');
    expect(await readFile(original, 'utf8')).toBe('untouched');
  }
  const cli = createCli({ root, env: { DB_CONNECTION: 'postgresql', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: 'unused' }, output() { throw Error('Unexpected output'); } });
  await expect(cli.parseAsync(['migrate:uninstall', '--pretend'], { from: 'user' })).rejects.toThrow('Migration history uninstall failed.');
});
test('history uninstall pre-abort refuses before filesystem or database work', async () => {
  const root = await fixture(); const controller = new AbortController(); controller.abort(Error('SIGTERM'));
  const cli = createCli({ root, env: { DB_CONNECTION: 'invalid' }, signal: controller.signal, output() { throw Error('Unexpected output'); } });
  await expect(cli.parseAsync(['--force', 'migrate:uninstall'], { from: 'user' })).rejects.toThrow('cancelled');
});
test('history uninstall rejects unsupported flags rather than pretending isolation/graceful success', async () => {
  const root = await fixture();
  for (const flag of ['--isolated', '--graceful', '--cascade']) {
    const cli = createCli({ root, env: { DB_CONNECTION: 'invalid' }, output() {} });
    cli.configureOutput().writeErr = () => {};
    await expect(cli.parseAsync(['--force', 'migrate:uninstall', flag], { from: 'user' })).rejects.toMatchObject({ code: 'commander.unknownOption' });
  }
});
