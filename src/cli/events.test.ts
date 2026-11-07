import { test, expect } from 'bun:test';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerEvents } from './events';

test('event:generate exposes JSON results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-event-generate-cli-'));
  try {
    const definitions = pathToFileURL(join(import.meta.dir, '../events/definitions.ts')).href;
    await writeFile(join(root, 'events.ts'), `import { defineEvents } from ${JSON.stringify(definitions)}; export default defineEvents([]);`);
    const output: string[] = [];
    const program = new Command().exitOverride().option('--force');
    registerEvents(program, { root, output: text => output.push(text) });
    await program.parseAsync(['node', 'bundle', 'event:generate']);
    expect(JSON.parse(output[0]!)).toEqual({created: [], existing: []});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('event:generate sanitizes trusted source errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-event-error-'));
  try {
    await writeFile(join(root, 'events.ts'), `throw new Error('private source detail');`);
    const program = new Command().exitOverride();
    registerEvents(program, { root, output: () => {} });
    await expect(program.parseAsync(['node', 'bundle', 'event:generate'])).rejects.toThrow('Cannot generate registered event listeners.');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('event:list and event:clear operate on an empty project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-events-cli-'));
  try {
    const output: string[] = [];
    const make = () => { const program = new Command().option('--force'); registerEvents(program, { root, output: text => output.push(text) }); return program; };
    await make().parseAsync(['node', 'bundle', 'event:list', '--json']);
    expect(JSON.parse(output.pop()!)).toEqual({ events: [] });
    await make().parseAsync(['node', 'bundle', 'event:clear']);
    expect(JSON.parse(output.pop()!)).toEqual({ cleared: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
