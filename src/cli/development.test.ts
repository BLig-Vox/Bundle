import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDevelopment } from './development.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'bundle-dev-cli-')); roots.push(root); return root; }
function cli(root: string, env: NodeJS.ProcessEnv = {}, signal?: AbortSignal) {
  const output: string[] = [];
  const program = new Command().exitOverride().configureOutput({ writeErr() {} });
  registerDevelopment(program, { root, env, signal, output: text => output.push(text), error: text => output.push(text) });
  return { program, output };
}
test('registers foreground dev and explicit process list with no implicit options', () => {
  const { program } = cli('/tmp');
  expect(program.commands.map(command => command.name())).toEqual(['dev:list', 'dev']);
  expect(program.commands.flatMap(command => command.options)).toEqual([]);
});
test('nested development group refuses before importing source', async () => {
  const root = await fixture(); const marker = join(root, 'imported');
  await writeFile(join(root, 'dev.ts'), `await Bun.write(${JSON.stringify(marker)},'yes'); throw Error('PRIVATE');`);
  const { program, output } = cli(root, { BUNDLE_DEV_CHILD: '1' });
  await expect(program.parseAsync(['dev'], { from: 'user' })).rejects.toThrow('Nested development groups');
  expect(await Bun.file(marker).exists()).toBe(false); expect(output).toEqual([]);
});
test('pre-aborted development commands refuse with signal status before source import', async () => {
  const root = await fixture();
  for (const [name, reason, status] of [['dev', 'SIGINT', 130], ['dev:list', 'SIGTERM', 143]] as const) {
    const controller = new AbortController(); controller.abort(Error(reason)); const { program } = cli(root, {}, controller.signal);
    await expect(program.parseAsync([name], { from: 'user' })).rejects.toMatchObject({ exitCode: status });
  }
});
test('unknown development options fail before source import', async () => {
  const root = await fixture(); const { program, output } = cli(root);
  await expect(program.parseAsync(['dev', '--background'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.unknownOption' });
  expect(output).toEqual([]);
});
test('source import failures are generic and do not expose trusted exceptions', async () => {
  for (const name of ['dev', 'dev:list']) {
    const root = await fixture(); await writeFile(join(root, 'dev.ts'), `throw Error('PRIVATE_DEV_SOURCE');`); const { program, output } = cli(root);
    try { await program.parseAsync([name], { from: 'user' }); throw Error('Unexpected success'); }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_DEV_SOURCE'); expect(String(error)).toContain(name === 'dev' ? 'Development group failed.' : 'Unable to list development processes.'); }
    expect(output).toEqual([]);
  }
});
