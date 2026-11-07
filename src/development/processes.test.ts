import { expect, test } from 'bun:test';
import { defineDevelopment, loadDevelopment, runDevelopment } from './processes.ts';
import { mkdtemp, mkdir, writeFile, rm, link, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundle-dev-test-'));
  await mkdir(join(root, 'src', 'commands'), {recursive: true});
  return root;
}

test('definitions copy, freeze, and reject recursion', () => {
  const argv = ['example', 'value'];
  const list = defineDevelopment([{name: 'one', argv}]);
  argv[1] = 'changed';
  expect(list[0]?.argv[1]).toBe('value');
  expect(Object.isFrozen(list)).toBe(true);
  expect(Object.isFrozen(list[0]?.argv)).toBe(true);
  expect(() => defineDevelopment([{name: 'x', argv: ['dev']}])).toThrow();
});

test('empty process groups refuse to run', async () => {
  await expect(runDevelopment({root: process.cwd(), definitions: defineDevelopment([])})).rejects.toThrow();
});

test('loads only a branded, regular single-link source', async () => {
  const root = await fixture();
  try {
    const module = new URL('./processes.ts', import.meta.url).href;
    await writeFile(join(root, 'dev.ts'), `import {defineDevelopment} from ${JSON.stringify(module)}; export default defineDevelopment([{name:'sample', argv:['list']}]);`);
    expect((await loadDevelopment(root))[0]?.name).toBe('sample');
    await link(join(root, 'dev.ts'), join(root, 'other.ts'));
    await expect(loadDevelopment(root)).rejects.toThrow();
    await rm(join(root, 'dev.ts'));
    await symlink(join(root, 'other.ts'), join(root, 'dev.ts'));
    await expect(loadDevelopment(root)).rejects.toThrow();
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('runs a rooted command and preserves its status and streamed output', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'src/commands/probe.ts'), `export default {name:'probe', description:'fixture', handle() { console.log('fixture-output'); return 7; }};`);
    let output = '';
    const result = await runDevelopment({root, definitions: defineDevelopment([{name:'probe', argv:['probe']}]), output: text => { output += text; }, error: () => {}});
    expect(result.exitCode).toBe(7);
    expect(result.processes).toEqual([{name:'probe', exitCode:7}]);
    expect(output).toContain('fixture-output');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('first completion stops a running sibling and reports actual statuses', async () => {
  const root = await fixture();
  try {
    const ready = join(root, 'ready');
    await writeFile(join(root, 'src/commands/hold.ts'), `export default {name:'hold',description:'fixture',async handle(){ await Bun.write(${JSON.stringify(ready)}, 'ready'); await new Promise(() => {}); }};`);
    await writeFile(join(root, 'src/commands/finish.ts'), `export default {name:'finish',description:'fixture',async handle(){ while (!(await Bun.file(${JSON.stringify(ready)}).exists())) await Bun.sleep(10); return 9; }};`);
    const result = await runDevelopment({root, definitions: defineDevelopment([{name:'hold',argv:['hold']},{name:'finish',argv:['finish']}]), output: () => {}, error: () => {}});
    expect(result.exitCode).toBe(9);
    expect(result.processes).toHaveLength(2);
    expect(result.processes[1]?.exitCode).toBe(9);
    expect(result.cancelled).toBe(false);
  } finally { await rm(root, {recursive:true, force:true}); }
}, 10000);

test('output failures terminate and reap the owned child', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'src/commands/hold.ts'), `export default {name:'hold',description:'fixture',async handle(){ console.log('ready'); await new Promise(() => {}); }};`);
    await expect(runDevelopment({root, definitions: defineDevelopment([{name:'hold',argv:['hold']}]), output: () => {throw new Error('sink');}, error: () => {}})).rejects.toThrow('Development processes failed');
  } finally { await rm(root, {recursive:true, force:true}); }
}, 10000);

test.each([['SIGINT', 130], ['SIGTERM', 143]])('active abort %s reaps the child', async (reason, code) => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'src/commands/hold.ts'), `export default {name:'hold',description:'fixture',async handle(){ console.log('ready'); await new Promise(() => {}); }};`);
    const controller = new AbortController();
    const result = await runDevelopment({root, definitions: defineDevelopment([{name:'hold',argv:['hold']}]), signal: controller.signal, output: text => {if (text.includes('ready')) controller.abort(reason);}, error: () => {}});
    expect(result.exitCode).toBe(code);
    expect(result.cancelled).toBe(true);
    expect(result.processes).toHaveLength(1);
  } finally { await rm(root, {recursive:true, force:true}); }
}, 10000);

test('later coverage: invalid descriptors and argument bounds are rejected without getters', () => {
  let accessed = false;
  const bad = {get name() { accessed = true; return 'x'; }, argv:['list']};
  expect(() => defineDevelopment([bad])).toThrow();
  expect(accessed).toBe(false);
  expect(() => defineDevelopment([{name:'x', argv:['list', 'x'.repeat(4097)]}])).toThrow();
  expect(() => defineDevelopment([{name:'x', argv:['list']}, {name:'x', argv:['list']}])).toThrow();
  expect(() => defineDevelopment([{name:'x', argv:['dev:list']}])).toThrow();
  const sparse = Array(1) as string[];
  expect(() => defineDevelopment([{name:'x', argv:sparse}])).toThrow();
});

test('later coverage: environment is snapshotted before awaiting the root', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'src/commands/probe.ts'), `export default {name:'probe',description:'fixture',handle(){ console.log(process.env.PROBE_VALUE); }};`);
    const env = {...process.env, PROBE_VALUE:'before'};
    let output = '';
    const pending = runDevelopment({root, env, definitions: defineDevelopment([{name:'x', argv:['probe']}]), output: text => {output += text;}, error: () => {}});
    env.PROBE_VALUE = 'after';
    expect((await pending).exitCode).toBe(0);
    expect(output).toContain('before');
    expect(output).not.toContain('after');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('later coverage: pre-aborted source is not imported', async () => {
  const root = await fixture();
  try {
    const marker = join(root, 'executed');
    await writeFile(join(root, 'dev.ts'), `await Bun.write(${JSON.stringify(marker)}, 'executed'); export default [];`);
    const controller = new AbortController(); controller.abort();
    await expect(loadDevelopment(root, controller.signal)).rejects.toThrow();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('later coverage: inherited pipes are drained only briefly after exit', async () => {
  const root = await fixture();
  const pidfile = join(root, 'pid');
  try {
    await writeFile(join(root, 'src/commands/spawn.ts'), `export default {name:'spawn',description:'fixture',async handle(){ const child = Bun.spawn([process.execPath,'-e','setTimeout(() => {}, 10000)'], {stdin:'ignore', stdout:'inherit', stderr:'inherit'}); child.unref(); await Bun.write(${JSON.stringify(pidfile)}, String(child.pid)); }};`);
    const started = Date.now();
    const result = await runDevelopment({root, definitions: defineDevelopment([{name:'spawn',argv:['spawn']}]), output: () => {}, error: () => {}});
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  } finally {
    try { process.kill(Number(await readFile(pidfile, 'utf8')), 'SIGKILL'); } catch { /* already exited or not started */ }
    await rm(root, {recursive:true, force:true});
  }
}, 10000);

test('later coverage: partial spawn failure reaps earlier child', async () => {
  const root = await fixture();
  const original = Bun.spawn;
  let count = 0;
  let exited: Promise<number> | undefined;
  try {
    await writeFile(join(root, 'src/commands/hold.ts'), `export default {name:'hold',description:'fixture',async handle(){ await new Promise(() => {}); }};`);
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      if (++count === 2) throw new Error('controlled spawn failure');
      const child = original(...args);
      exited = child.exited;
      return child;
    }) as typeof Bun.spawn;
    await expect(runDevelopment({root, definitions: defineDevelopment([{name:'one',argv:['hold']},{name:'two',argv:['hold']}]), output: () => {}, error: () => {}})).rejects.toThrow('Development processes failed');
    expect(count).toBe(2);
    expect(exited).toBeDefined();
    expect(await exited).toBeNumber();
  } finally { Bun.spawn = original; await rm(root, {recursive:true, force:true}); }
}, 10000);

test('already aborted run does not start children', async () => {
  const root = await fixture();
  try {
    const controller = new AbortController(); controller.abort('SIGINT');
    const result = await runDevelopment({root, definitions: defineDevelopment([{name:'probe', argv:['probe']}]), signal: controller.signal});
    expect(result).toEqual({exitCode:130, cancelled:true, processes:[]});
  } finally { await rm(root, {recursive:true, force:true}); }
});
