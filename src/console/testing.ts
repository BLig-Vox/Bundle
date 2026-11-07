import { AssertionError } from 'node:assert';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { runCli } from '../cli/runner.ts';
import { createPrompts } from './prompts.ts';

export type PromptStep = Readonly<{ method: 'text' | 'password' | 'confirm' | 'select' | 'multiselect' | 'search'; message: string; lines: readonly string[] }>;
export type CommandTestOptions = Readonly<{ root: string; env?: Record<string, string | undefined>; prompts?: readonly PromptStep[]; signal?: AbortSignal; maxOutputBytes?: number }>;
export type CommandTestResult = Readonly<{
  exitCode: number; output: string; error: string; promptOutput: string;
  assertExitCode(value: number): CommandTestResult;
  assertOutputIncludes(value: string): CommandTestResult;
  assertErrorIncludes(value: string): CommandTestResult;
  assertPromptIncludes(value: string): CommandTestResult;
  assertNoError(): CommandTestResult;
}>;

function ownRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected a plain data object');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor || !('value' in descriptor)) throw new TypeError('Unexpected or non-data property');
  }
}
function dense(value: unknown, min: number, max: number): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError('Invalid list');
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || !('value' in Object.getOwnPropertyDescriptor(value, i)!)) throw new TypeError('Invalid list');
  if (Reflect.ownKeys(value).some(k => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= value.length))) throw new TypeError('Invalid list');
}
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
function snapshot(argv: readonly string[], options: CommandTestOptions) {
  ownRecord(options, ['root', 'env', 'prompts', 'signal', 'maxOutputBytes']);
  if (!Object.hasOwn(options, 'root') || typeof options.root !== 'string' || !isAbsolute(options.root)) throw new TypeError('Root must be absolute');
  dense(argv, 0, 128);
  let total = 0;
  const args = argv.map(v => { if (typeof v !== 'string' || bytes(v) > 4096 || v.includes('\0')) throw new TypeError('Invalid argument'); total += bytes(v); return v; });
  if (total > 65536) throw new TypeError('Arguments exceed limit');
  const source = options.env ?? { ...process.env };
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Invalid environment');
  const env: Record<string, string | undefined> = Object.create(null);
  for (const key of Reflect.ownKeys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key);
    if (typeof key !== 'string' || !desc || !('value' in desc) || (desc.value !== undefined && typeof desc.value !== 'string')) throw new TypeError('Invalid environment');
    env[key] = desc.value;
  }
  const steps = options.prompts ?? [];
  dense(steps, 0, 64); total = 0;
  const prompts = steps.map(step => {
    ownRecord(step, ['method', 'message', 'lines']);
    if (!['method', 'message', 'lines'].every(key => Object.hasOwn(step, key)) || !['text', 'password', 'confirm', 'select', 'multiselect', 'search'].includes(step.method as string) || typeof step.message !== 'string' || !bytes(step.message) || bytes(step.message) > 4096) throw new TypeError('Invalid prompt step');
    dense(step.lines, 1, 32);
    const lines = step.lines.map(line => { if (typeof line !== 'string' || bytes(line) > 4096 || /[\p{Cc}\p{Cs}]/u.test(line)) throw new TypeError('Invalid prompt line'); total += bytes(line); return line; });
    return Object.freeze({ method: step.method as PromptStep['method'], message: step.message, lines: Object.freeze(lines) });
  });
  if (total > 65536) throw new TypeError('Prompt input exceeds limit');
  const max = options.maxOutputBytes ?? 1048576;
  if (!Number.isInteger(max) || max < 1 || max > 1048576) throw new TypeError('Invalid output limit');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('Invalid signal');
  return { root: options.root, args, env, prompts, max, signal: options.signal };
}

/** Runs trusted commands with isolated injected I/O; direct process output is not captured. */
export async function testCommand(argv: readonly string[], options: CommandTestOptions): Promise<CommandTestResult> {
  const config = snapshot(argv, options);
  const root = await realpath(config.root);
  const activeInputs = new Set<PassThrough>();
  const overflowAbort = new AbortController();
  let output = '', error = '', promptOutput = '', count = 0, overflow = false, mismatch = false, index = 0, activePrompt = false;
  const capture = (kind: 'output' | 'error' | 'promptOutput', text: string) => {
    if (overflow) return;
    count += bytes(text);
    if (count > config.max) { overflow = true; overflowAbort.abort(); throw new Error('Harness output limit exceeded'); }
    if (kind === 'output') output += text; else if (kind === 'error') error += text; else promptOutput += text;
  };
  const terminal = new Writable({ write(chunk, _encoding, callback) { try { capture('promptOutput', String(chunk)); callback(); } catch (e) { callback(e as Error); } } });
  // Writable errors must not become uncaught process errors; the final failure is reported after cleanup.
  terminal.on('error', () => { overflow = true; });
  type Adapter = ReturnType<typeof createPrompts>;
  const wrap = <K extends keyof Adapter>(method: K): Adapter[K] => {
    const wrapped = (opts: { message: string; signal?: AbortSignal }) => {
      if (activePrompt) { mismatch = true; return Promise.reject(new Error('A prompt is already active on this input')); }
      const step = config.prompts[index++];
      if (!step || step.method !== method || step.message !== opts.message) { mismatch = true; throw new Error('Harness prompt mismatch'); }
      const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
      input.isTTY = true; input.isRaw = false; input.setRawMode = mode => { input.isRaw = mode; };
      activeInputs.add(input);
      activePrompt = true;
      const native = createPrompts({ input, output: terminal });
      const signal = AbortSignal.any([overflowAbort.signal, ...(config.signal ? [config.signal] : []), ...(opts.signal ? [opts.signal] : [])]);
      const result = (native[method] as (o: never) => Promise<unknown>)({ ...opts, signal } as never);
      queueMicrotask(() => { if (!input.destroyed) input.end(step.lines.join('\n') + '\n'); });
      return result.finally(() => { activePrompt = false; activeInputs.delete(input); input.destroy(); });
    };
    return wrapped as Adapter[K];
  };
  const prompts: Adapter = { text: wrap('text'), password: wrap('password'), confirm: wrap('confirm'), select: wrap('select'), multiselect: wrap('multiselect'), search: wrap('search') };
  let exitCode = 1; let failure: unknown;
  try { exitCode = await runCli(config.args, { root, env: config.env, output: text => capture('output', text), error: text => capture('error', text), prompts, signal: config.signal, handleSignals: false }); }
  catch (e) { failure = e; }
  finally { for (const input of activeInputs) input.destroy(); terminal.destroy(); }
  if (overflow) throw new Error('Harness output limit exceeded');
  if (mismatch || index !== config.prompts.length) throw new Error('Harness prompt steps did not match');
  if (failure) throw failure;
  const fail = (message: string): never => { throw new AssertionError({ message }); };
  const stringArg = (v: unknown) => { if (typeof v !== 'string') throw new TypeError('Expected a string'); };
  const result: CommandTestResult = Object.freeze({
    exitCode, output, error, promptOutput,
    assertExitCode(value: number) { if (!Number.isInteger(value) || value < 0 || value > 255) throw new TypeError('Invalid exit code'); if (exitCode !== value) fail(`Expected exit code ${value}, received ${exitCode}`); return result; },
    assertOutputIncludes(value: string) { stringArg(value); if (!output.includes(value)) fail('Output did not include expected text'); return result; },
    assertErrorIncludes(value: string) { stringArg(value); if (!error.includes(value)) fail('Error did not include expected text'); return result; },
    assertPromptIncludes(value: string) { stringArg(value); if (!promptOutput.includes(value)) fail('Prompt output did not include expected text'); return result; },
    assertNoError() { if (error) fail('Expected no error output'); return result; },
  });
  return result;
}
