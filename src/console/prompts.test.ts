import { test, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createPrompts } from './prompts';

function fixture(tty = true) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = tty; input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough(); let rendered = '';
  output.on('data', (chunk) => { rendered += chunk.toString(); });
  return { input, output, get rendered() { return rendered; }, prompts: createPrompts({ input, output }) };
}

test('text retries async validation and accepts Unicode', async () => {
  const f = fixture();
  const result = f.prompts.text({ message: 'Name', validate: async (v) => v.length < 2 ? 'Too short' : undefined });
  f.input.write('x\n'); await Bun.sleep(0); f.input.write('雪人\n');
  expect(await result).toBe('雪人'); expect(f.rendered).toContain('Too short');
});

test('password never renders secret and restores raw mode', async () => {
  const f = fixture(); const result = f.prompts.password({ message: 'Password' });
  expect(f.input.isRaw).toBe(true); f.input.write('sëcret\n');
  expect(await result).toBe('sëcret'); expect(f.rendered).not.toContain('sëcret'); expect(f.input.isRaw).toBe(false);
});

test('real PTY rejects concurrent adapters, hides password, and restores terminal flags', () => {
  const python = `
import os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
code = "import {createPrompts} from './src/console/prompts.ts'; const s={input:process.stdin,output:process.stdout}; const a=createPrompts(s), b=createPrompts(s); const first=a.password({message:'Secret'}); try { await b.password({message:'Other'}); process.stdout.write('BAD'); } catch { process.stdout.write('REJECTED'); } const v=await first; process.stdout.write('OK '+v.length);"
p = subprocess.Popen(['bun', '-e', code], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'BUN_OPTIONS': ''})
out = b''
deadline = time.monotonic() + 5
while b'REJECTED' not in out and time.monotonic() < deadline:
    if select.select([master], [], [], 0.1)[0]: out += os.read(master, 4096)
if b'REJECTED' not in out:
    p.kill(); raise RuntimeError('concurrency not rejected: ' + repr(out))
os.write(master, b'supersecret\\n')
while p.poll() is None and time.monotonic() < deadline:
    if select.select([master], [], [], 0.1)[0]: out += os.read(master, 4096)
if p.poll() is None: p.kill(); raise RuntimeError('child timed out: ' + repr(out))
while select.select([master], [], [], 0)[0]:
    try: out += os.read(master, 4096)
    except OSError: break
after = termios.tcgetattr(slave)
assert p.returncode == 0, out
assert b'supersecret' not in out, out
assert b'OK 11' in out, out
assert before == after, (before, after)
`;
  const result = spawnSync('python3', ['-I', '-c', python], { cwd: import.meta.dir + '/../..', encoding: 'utf8', timeout: 7000 });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
}, 9000);

test('selection retries invalid indices and supports multiple values', async () => {
  const f = fixture(); const result = f.prompts.multiselect({ message: 'Pick', options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }] });
  f.input.write('3\n'); await Bun.sleep(0); f.input.write('2,1\n');
  expect(await result).toEqual([2, 1]); expect(f.rendered).toContain('Invalid selection');
});

test('search invokes async provider and selects result', async () => {
  const f = fixture(); const result = f.prompts.search({ message: 'Find', search: async (q) => [{ label: q, value: q.toUpperCase() }] });
  f.input.write('café\n'); await Bun.sleep(0); f.input.write('1\n'); expect(await result).toBe('CAFÉ');
});

test('noninteractive requires a valid default and validates it', async () => {
  const f = fixture(false);
  await expect(f.prompts.text({ message: 'x' })).rejects.toThrow();
  expect(await f.prompts.confirm({ message: 'x', default: false })).toBe(false);
  await expect(f.prompts.text({ message: 'x', default: 'bad', validate: () => 'invalid' })).rejects.toThrow();
  await expect(f.prompts.select({ message: 'x', options: [{ label: 'a', value: 'a' }], default: 'b' })).rejects.toThrow();
});

test('abort interrupts a pending async search provider', async () => {
  const f = fixture(); const controller = new AbortController();
  const result = f.prompts.search({ message: 'Find', signal: controller.signal, search: () => new Promise<never>(() => {}) });
  f.input.write('query\n'); await Bun.sleep(0); controller.abort();
  const outcome = await Promise.race([result.then(() => 'resolved', () => 'aborted'), Bun.sleep(50).then(() => 'timeout')]);
  expect(outcome).toBe('aborted'); expect(f.input.listenerCount('data')).toBe(0);
});

test('adapters sharing input reject concurrent prompts', async () => {
  const f = fixture(); const other = createPrompts({ input: f.input, output: f.output });
  const controller = new AbortController();
  const first = f.prompts.password({ message: 'secret', signal: controller.signal });
  const secondController = new AbortController();
  const second = other.password({ message: 'other', signal: secondController.signal });
  const status = await Promise.race([second.then(() => 'resolved', () => 'rejected'), Bun.sleep(50).then(() => 'timeout')]);
  secondController.abort(); controller.abort(); await Promise.allSettled([first, second]);
  expect(status).toBe('rejected');
});

test('sequential prompts preserve typeahead but clear it across password transitions', async () => {
  const f = fixture(); const first = f.prompts.text({ message: 'first' });
  f.input.write('first\nsecond\n'); expect(await first).toBe('first');
  expect(await f.prompts.text({ message: 'second' })).toBe('second');
  const third = f.prompts.text({ message: 'third' }); f.input.write('third\nstale\n'); expect(await third).toBe('third');
  const secret = f.prompts.password({ message: 'secret' }); f.input.write('password\nleaked\n'); expect(await secret).toBe('password');
  const last = f.prompts.text({ message: 'last' }); f.input.write('fresh\n'); expect(await last).toBe('fresh');
});

test('split CRLF does not create a phantom search selection', async () => {
  const f = fixture(); const queries: string[] = [];
  const result = f.prompts.search({ message: 'Find', search: (q) => { queries.push(q); return [{ label: q, value: q }]; } });
  f.input.write('abc\r'); await Bun.sleep(0); f.input.write('\n1\n');
  expect(await result).toBe('abc'); expect(queries).toEqual(['abc']);
});

test('oversized input fails closed and releases the input', async () => {
  const f = fixture(); const result = f.prompts.text({ message: 'x' });
  f.input.write('x'.repeat(65_537)); await expect(result).rejects.toThrow('buffer limit');
  const next = f.prompts.text({ message: 'next' }); f.input.write('ok\n'); expect(await next).toBe('ok');
});

test('already ended input rejects rather than hanging', async () => {
  const f = fixture(); f.input.resume(); f.input.end(); await new Promise<void>((resolve) => f.input.once('end', resolve));
  const result = await Promise.race([f.prompts.text({ message: 'x' }).then(() => 'resolved', () => 'rejected'), Bun.sleep(50).then(() => 'timeout')]);
  expect(result).toBe('rejected');
});

test('abort and concurrency clean up listeners and raw mode', async () => {
  const f = fixture(); const controller = new AbortController();
  const first = f.prompts.password({ message: 'x', signal: controller.signal });
  await expect(f.prompts.text({ message: 'other' })).rejects.toThrow();
  controller.abort(); await expect(first).rejects.toThrow();
  expect(f.input.isRaw).toBe(false); expect(f.input.listenerCount('data')).toBe(0);
});
