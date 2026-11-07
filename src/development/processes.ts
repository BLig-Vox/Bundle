import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DevelopmentProcess { readonly name: string; readonly argv: readonly string[] }
declare const brand: unique symbol;
export type DevelopmentDefinitions = readonly DevelopmentProcess[] & { readonly [brand]: true };
export interface RunDevelopmentOptions {
  root: string;
  definitions: DevelopmentDefinitions;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  output?: (text: string) => void;
  error?: (text: string) => void;
}
export interface DevelopmentResult {
  exitCode: number;
  cancelled: boolean;
  processes: readonly { name: string; exitCode: number }[];
}
const branded = new WeakSet<object>();
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Invalid development definitions');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !('value' in d)) throw new Error('Invalid development definitions');
  }
  return value;
}
export function defineDevelopment(input: readonly DevelopmentProcess[]): DevelopmentDefinitions {
  const names = new Set<string>();
  let bytes = 0;
  const result = array(input, 8).map(value => {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid development definition');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('name') || !keys.includes('argv')) throw new Error('Invalid development definition');
    const name = Object.getOwnPropertyDescriptor(value, 'name');
    const args = Object.getOwnPropertyDescriptor(value, 'argv');
    if (!name?.enumerable || !('value' in name) || !args?.enumerable || !('value' in args) || typeof name.value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name.value) || names.has(name.value)) throw new Error('Invalid development definition');
    names.add(name.value);
    const argv = array(args.value, 64);
    if (!argv.length) throw new Error('Invalid development arguments');
    for (const arg of argv) {
      if (typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) < 1 || Buffer.byteLength(arg) > 4096) throw new Error('Invalid development arguments');
      bytes += Buffer.byteLength(arg);
    }
    if (bytes > 65536 || typeof argv[0] !== 'string' || !/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/.test(argv[0]) || ['dev', 'dev:list'].includes(argv[0])) throw new Error('Invalid development arguments');
    return Object.freeze({name: name.value as string, argv: Object.freeze([...argv] as string[])});
  });
  Object.freeze(result);
  branded.add(result);
  return result as unknown as DevelopmentDefinitions;
}
function checkRoot(root: unknown): asserts root is string {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new Error('Invalid development root');
}
function checkSignal(signal: unknown): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid development signal');
}
function cancelled(signal?: AbortSignal): never {
  throw signal?.reason instanceof Error ? signal.reason : new Error('Development cancelled');
}
/** Imports trusted executable application code, not a sandbox. */
export async function loadDevelopment(root: string, signal?: AbortSignal): Promise<DevelopmentDefinitions> {
  checkRoot(root); checkSignal(signal);
  if (signal?.aborted) cancelled(signal);
  try {
    const canonical = await realpath(root);
    if (signal?.aborted) cancelled(signal);
    const file = join(canonical, 'dev.ts');
    const stat = await lstat(file);
    if (signal?.aborted) cancelled(signal);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error();
    const module = await import(pathToFileURL(file).href);
    if (signal?.aborted) cancelled(signal);
    if (!branded.has(module.default)) throw new Error();
    return module.default as DevelopmentDefinitions;
  } catch {
    if (signal?.aborted) cancelled(signal);
    throw new Error('Unable to load development processes');
  }
}
const runner = new URL('../cli/runner.ts', import.meta.url).href;
const script = `const {runCli} = await import(process.argv[1]); const root = process.argv[2]; process.exitCode = await runCli(process.argv.slice(3), {root, env: process.env});`;
function snapshotEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Invalid development environment');
  const copy: NodeJS.ProcessEnv = Object.create(null);
  for (const key of Reflect.ownKeys(env)) {
    const d = Object.getOwnPropertyDescriptor(env, key);
    if (typeof key !== 'string' || !key || key.includes('=') || key.includes('\0') || !d?.enumerable || !('value' in d) || (d.value !== undefined && (typeof d.value !== 'string' || d.value.includes('\0')))) throw new Error('Invalid development environment');
    copy[key] = d.value as string | undefined;
  }
  copy.BUNDLE_DEV_CHILD = '1';
  return copy;
}
/** Owns only the spawned CLI processes, never their descendants. */
export async function runDevelopment(options: RunDevelopmentOptions): Promise<DevelopmentResult> {
  if (!options || typeof options !== 'object') throw new Error('Invalid development options');
  const {root, definitions, signal, output, error} = options;
  checkRoot(root); checkSignal(signal);
  if (!branded.has(definitions) || !definitions.length || (output !== undefined && typeof output !== 'function') || (error !== undefined && typeof error !== 'function')) throw new Error('Invalid development options');
  const env = snapshotEnv(options.env === undefined || options.env === process.env ? Object.fromEntries(Object.entries(process.env)) : options.env);
  const entries = definitions.map(({name, argv}) => ({name, argv: [...argv]}));
  const abortCode = () => String(signal?.reason ?? '').includes('SIGINT') ? 130 : 143;
  if (signal?.aborted) return {exitCode: abortCode(), cancelled: true, processes: []};
  let canonical: string;
  try { canonical = await realpath(root); } catch { throw new Error('Unable to start development processes'); }
  if (signal?.aborted) return {exitCode: abortCode(), cancelled: true, processes: []};
  const children: {child: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>; name: string; timer?: ReturnType<typeof setTimeout>; done: boolean}[] = [];
  let first: number | undefined;
  let failure = false;
  let wasCancelled = false;
  const stop = (sig: 'SIGINT' | 'SIGTERM') => {
    for (const item of children) if (!item.done && !item.timer) {
      try { item.child.kill(sig); } catch { /* already exited */ }
      item.timer = setTimeout(() => { try { item.child.kill('SIGKILL'); } catch { /* already exited */ } }, 1000);
    }
  };
  const onAbort = () => { wasCancelled = true; stop(abortCode() === 130 ? 'SIGINT' : 'SIGTERM'); };
  const fail = () => { failure = true; stop('SIGTERM'); };
  signal?.addEventListener('abort', onAbort, {once: true});
  const tasks: Promise<{name: string; exitCode: number}>[] = [];
  try {
    if (signal?.aborted) onAbort();
    for (const entry of entries) {
      if (wasCancelled || failure) break;
      let child: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
      try {
        child = Bun.spawn([process.execPath, '-e', script, runner, canonical, ...entry.argv], {cwd: canonical, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
      } catch { fail(); break; }
      const item = {child, name: entry.name, done: false, timer: undefined as ReturnType<typeof setTimeout> | undefined};
      children.push(item);
      tasks.push((async () => {
        const controller = new AbortController();
        const stream = async (source: ReadableStream<Uint8Array>, write: (text: string) => void) => {
          const reader = source.getReader();
          const cancel = () => { void reader.cancel().catch(() => {}); };
          controller.signal.addEventListener('abort', cancel, {once: true});
          const decoder = new TextDecoder();
          try {
            while (!controller.signal.aborted) {
              const {done, value} = await reader.read();
              if (done) break;
              const text = decoder.decode(value, {stream: true});
              if (text) write(text);
            }
            if (!controller.signal.aborted) { const rest = decoder.decode(); if (rest) write(rest); }
          } catch { fail(); } finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
        };
        const streams = [stream(child.stdout, output ?? (s => { process.stdout.write(s); })), stream(child.stderr, error ?? (s => { process.stderr.write(s); }))];
        let code = 1;
        try {
          code = await child.exited;
          item.done = true;
          if (item.timer) clearTimeout(item.timer);
          if (first === undefined) { first = code; stop('SIGTERM'); }
        } catch { item.done = true; if (item.timer) clearTimeout(item.timer); fail(); }
        const timer = setTimeout(() => controller.abort(), 250);
        try { await Promise.all(streams); } finally { clearTimeout(timer); controller.abort(); }
        return {name: item.name, exitCode: code};
      })());
    }
    const processes = await Promise.all(tasks);
    if (failure) throw new Error('Development processes failed');
    return {exitCode: wasCancelled ? abortCode() : first ?? 1, cancelled: wasCancelled, processes};
  } finally {
    signal?.removeEventListener('abort', onAbort);
    for (const item of children) if (item.timer) clearTimeout(item.timer);
  }
}
