import { test, expect } from 'bun:test';
import { Command } from 'commander';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerQueueListen } from './queue-listen.ts';

test.each([['--tries','101'],['--queue','bad/name'],['--queue',''],['--sleep','0'],['--timeout','86400000'],['--backoff','-1'],['--max-cycles','0']])('rejects %s %s before touching queue storage', async (flag, value) => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-listen-cli-'));
  try {
    const program = new Command().exitOverride().configureOutput({writeErr: () => {}});
    registerQueueListen(program, {root, env: {}});
    await expect(program.parseAsync(['queue:listen', flag, value], {from: 'user'})).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, {recursive:true, force:true}); }
});
