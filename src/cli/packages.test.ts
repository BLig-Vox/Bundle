import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPackages } from './packages';

test('package commands discover and clear metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-package-cli-'));
  try {
    const output: string[] = [];
    const program = new Command().option('--force');
    registerPackages(program, { root, output: text => output.push(text) });
    await program.parseAsync(['node', 'bundle', 'package:discover']);
    expect(JSON.parse(output[0]!).packages).toBe(0);
    await program.parseAsync(['node', 'bundle', 'package:clear']);
    expect(JSON.parse(output[1]!).cleared).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
