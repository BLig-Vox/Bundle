import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readQueueControl, validateQueueName } from './control.ts';

export interface ListenQueueOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  queues?: readonly string[];
  sleepMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxCycles?: number;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export function validateListenOptions(options: ListenQueueOptions): void {
  if (typeof options.root !== 'string' || !isAbsolute(options.root) || options.root.includes('\0')) throw new Error('Expected an absolute canonical root.');
  const queues = options.queues ?? ['default'];
  if (!Array.isArray(queues) || queues.length < 1 || queues.length > 64) throw new Error('Invalid queues.');
  for (const queue of queues) validateQueueName(queue);
  const bounded = (n: number | undefined, min: number, max: number) => {
    if (n !== undefined && (!Number.isSafeInteger(n) || n < min || n > max)) throw new Error('Invalid queue listener option.');
  };
  bounded(options.sleepMs, 1, 2_147_483_647);
  bounded(options.timeoutMs, 1, 86_399_000);
  bounded(options.maxAttempts, 1, 100);
  bounded(options.retryDelayMs, 0, 2_592_000_000);
  bounded(options.maxCycles, 1, Number.MAX_SAFE_INTEGER);
}

const runner = new URL('../cli/runner.ts', import.meta.url).href;
const script = `const {runCli} = await import(process.argv[1]); const root = process.argv[2]; process.exitCode = await runCli(process.argv.slice(3), {root, env: process.env});`;

async function stream(readable: ReadableStream<Uint8Array>, write: (text: string) => void, signal: AbortSignal, fail: () => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = readable.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once:true});
  if (signal.aborted) cancel();
  try {
    while (!signal.aborted) {
      const {done, value} = await reader.read();
      if (done) break;
      const text = decoder.decode(value, {stream: true});
      if (text) write(text);
    }
    if (!signal.aborted) { const rest = decoder.decode(); if (rest) write(rest); }
  } catch { fail(); }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, {once: true});
    if (signal?.aborted) finish();
  });
}

/** Each cycle uses a fresh trusted CLI process. This is not a process-group supervisor. */
export async function listenQueue(options: ListenQueueOptions): Promise<{cycles: number}> {
  validateListenOptions(options);
  if (options.signal?.aborted) return {cycles: 0};
  const root = await realpath(options.root);
  const baseline = (await readQueueControl(root)).restartToken;
  const args = ['queue:work', '--once', '--queue', (options.queues ?? ['default']).join(',')];
  for (const [flag, value] of [['--sleep', options.sleepMs], ['--timeout', options.timeoutMs], ['--tries', options.maxAttempts], ['--backoff', options.retryDelayMs]] as const) {
    if (value !== undefined) args.push(flag, String(value));
  }
  let cycles = 0;
  while (!options.signal?.aborted && (options.maxCycles === undefined || cycles < options.maxCycles)) {
    if ((await readQueueControl(root)).restartToken !== baseline || options.signal?.aborted) break;
    const child = Bun.spawn([process.execPath, '-e', script, runner, root, ...args], {
      cwd: root, env: options.env ?? process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    cycles++;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (signal: 'SIGINT' | 'SIGTERM') => {
      if (killTimer) return;
      try { child.kill(signal); } catch { /* already exited */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 1000);
    };
    const abort = () => stop(String(options.signal?.reason ?? '').includes('SIGINT') ? 'SIGINT' : 'SIGTERM');
    const streamAbort = new AbortController();
    let streamFailed = false;
    const fail = () => { streamFailed = true; stop('SIGTERM'); streamAbort.abort(); };
    options.signal?.addEventListener('abort', abort, {once: true});
    if (options.signal?.aborted) abort();
    try {
      const out = stream(child.stdout, options.output ?? (s => { process.stdout.write(s); }), streamAbort.signal, fail);
      const err = stream(child.stderr, options.error ?? (s => { process.stderr.write(s); }), streamAbort.signal, fail);
      const status = await child.exited;
      // Descendants can inherit these pipes after the owned process exits. Allow
      // ordinary EOF/tail flushing briefly, but never supervise descendants.
      const drainTimer = setTimeout(() => streamAbort.abort(), 250);
      try { await Promise.all([out, err]); } finally { clearTimeout(drainTimer); }
      if (streamFailed) throw new Error('Queue listener child output failed.');
      if (!options.signal?.aborted && status !== 0) throw new Error('Queue listener child failed.');
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
    }
    if (!options.signal?.aborted) await delay(options.sleepMs ?? 1000, options.signal);
  }
  return {cycles};
}
