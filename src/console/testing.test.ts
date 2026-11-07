import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCommand } from './testing.ts';

test('runs the real rooted CLI and exposes chainable assertions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-harness-'));
  try {
    const result = await testCommand(['list'], { root });
    expect(result.assertExitCode(0).assertOutputIncludes('bundle').assertNoError()).toBe(result);
    expect(Object.isFrozen(result)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundle-harness-'));
  await mkdir(join(root, 'src', 'commands'), { recursive: true });
  await writeFile(join(root, 'src', 'commands', 'Fixture.ts'), `
    export default { name: 'fixture', description: 'Fixture',
      arguments: [{name:'name', prompt:'Name'}],
      async handle({args}, {prompts, output, error, signal}) {
        const text = await prompts.text({message:'Text', validate: value => value === 'good' ? undefined : 'Try again', signal});
        const password = await prompts.password({message:'Secret', signal});
        const confirm = await prompts.confirm({message:'Confirm', default:true, signal});
        const options = [{label:'One', value:'one'}, {label:'Two', value:'two'}];
        const select = await prompts.select({message:'Select', options, signal});
        const multi = await prompts.multiselect({message:'Multi', options, signal});
        const search = await prompts.search({message:'Search', search: () => options, signal});
        output(JSON.stringify({name:args.name,text, passwordLength:password.length,confirm,select,multi,search}));
        error('diagnostic'); return 7;
      }
    };
  `);
  return root;
}

test('drives real native prompts with retries and isolated step input', async () => {
  const root = await fixture();
  try {
    const result = await testCommand(['fixture'], {root, prompts: [
      {method:'text', message:'Name', lines:['Ada', 'ignored']},
      {method:'text', message:'Text', lines:['bad', 'good']},
      {method:'password', message:'Secret', lines:['password-unique']},
      {method:'confirm', message:'Confirm', lines:['']},
      {method:'select', message:'Select', lines:['2']},
      {method:'multiselect', message:'Multi', lines:['1,2']},
      {method:'search', message:'Search', lines:['query', '1']},
    ]});
    result.assertExitCode(7).assertOutputIncludes('"name":"Ada"').assertOutputIncludes('"text":"good"').assertOutputIncludes('"confirm":true').assertOutputIncludes('"multi":["one","two"]').assertErrorIncludes('diagnostic').assertPromptIncludes('Try again');
    expect(result.promptOutput).not.toContain('password-unique');
    expect(() => result.assertNoError()).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reports prompt mismatch and unused steps independently of command status', async () => {
  const root = await fixture();
  try {
    await expect(testCommand(['fixture'], {root, prompts:[{method:'password',message:'Name',lines:['hidden']}]})).rejects.toThrow('prompt steps');
    await expect(testCommand(['list'], {root, prompts:[{method:'text',message:'unused',lines:['hidden']}]})).rejects.toThrow('prompt steps');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('enforces limits, snapshots input and preserves process state across concurrent calls', async () => {
  const root = await fixture();
  try {
    const exitCode = process.exitCode, stdin = process.stdin.isTTY, listeners = process.listenerCount('SIGINT');
    const args = ['list']; const env = { EXAMPLE: 'original' };
    const pending = testCommand(args, {root, env}); args[0] = 'not-a-command'; env.EXAMPLE = 'changed';
    const [first, second] = await Promise.all([pending, testCommand(['list'], {root})]);
    first.assertExitCode(0); second.assertExitCode(0);
    await expect(testCommand(['list'], {root, maxOutputBytes: 1})).rejects.toThrow('output limit');
    expect(process.exitCode).toBe(exitCode); expect(process.stdin.isTTY).toBe(stdin); expect(process.listenerCount('SIGINT')).toBe(listeners);
    await expect(testCommand(['list'], {root, prompts:[{method:'text',message:'X',lines:['bad\nline']}]})).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('settles provider disposal before reporting mismatch and overflow', async () => {
  const root = await fixture();
  try {
    const marker = join(root, 'disposed');
    await writeFile(join(root, 'providers.ts'), `export default [{module:'provider.ts',export:'Provider'}];`);
    await writeFile(join(root, 'provider.ts'), `import { appendFile } from 'node:fs/promises'; export class Provider { register() {} async dispose() { await appendFile(${JSON.stringify(marker)}, 'd'); } }`);
    await expect(testCommand(['fixture'], {root, prompts:[{method:'text',message:'wrong',lines:['secret']}]})).rejects.toThrow('prompt steps');
    expect(await readFile(marker, 'utf8')).toBe('d');
    await expect(testCommand(['list'], {root, maxOutputBytes:1})).rejects.toThrow('output limit');
    expect(await readFile(marker, 'utf8')).toBe('dd');
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('exhausted early prompt input reaches EOF without consuming later steps', async () => {
  const root = await fixture();
  try {
    await expect(testCommand(['fixture'], { root, prompts: [
      {method:'text', message:'Name', lines:['Ada']},
      {method:'text', message:'Text', lines:['bad']},
      {method:'password', message:'Secret', lines:['unused']},
    ]})).rejects.toThrow('prompt steps');
  } finally { await rm(root, {recursive:true,force:true}); }
});
