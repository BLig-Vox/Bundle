import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export type PromptValidator<T> = (value: T) => string | undefined | void | Promise<string | undefined | void>;
export interface PromptOptions<T> { message: string; default?: T; validate?: PromptValidator<T>; signal?: AbortSignal }
export interface PromptChoice<T> { label: string; value: T }
export interface ChoiceOptions<T> extends PromptOptions<T> { options: readonly PromptChoice<T>[] }
export interface MultiChoiceOptions<T> extends PromptOptions<T[]> { options: readonly PromptChoice<T>[] }
export interface SearchOptions<T> extends PromptOptions<T> { search: (query: string) => readonly PromptChoice<T>[] | Promise<readonly PromptChoice<T>[]> }
export interface PromptStreams { input: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown }; output: Writable }

interface InputState { active: boolean; buffer: string; decoder: StringDecoder; skipLf: boolean }
const inputs = new WeakMap<Readable, InputState>();
const MAX_BUFFER = 65_536;

/** Creates a sequential, line-oriented prompt adapter. Input must be a TTY for interaction. */
export function createPrompts({ input, output }: PromptStreams) {
  let state = inputs.get(input);
  if (!state) { state = { active: false, buffer: '', decoder: new StringDecoder('utf8'), skipLf: false }; inputs.set(input, state); }
  const shared = state;
  const clearBuffer = () => { shared.buffer = ''; shared.decoder = new StringDecoder('utf8'); shared.skipLf = false; };
  const write = (text: string) => { output.write(text); };
  async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    if (signal.aborted) throw new Error('Prompt aborted');
    let abort = () => {};
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => reject(new Error('Prompt aborted'));
        signal.addEventListener('abort', abort, { once: true });
        operation.then(resolve, reject);
        if (signal.aborted) abort();
      });
    } finally { signal.removeEventListener('abort', abort); }
  }
  async function run<T>(options: PromptOptions<T>, read: (line: () => Promise<string>) => Promise<T>, validDefault: (value: T) => boolean = () => true, secret = false): Promise<T> {
    if (shared.active) throw new Error('A prompt is already active on this input');
    shared.active = true;
    let completed = false;
    const signal = options.signal;
    let cleanup = () => {};
    try {
      if (signal?.aborted) throw new Error('Prompt aborted');
      const hasDefault = Object.prototype.hasOwnProperty.call(options, 'default') && options.default !== undefined;
      const validate = async (value: T) => {
        if (!validDefault(value)) return 'Invalid selection';
        return await abortable(Promise.resolve(options.validate?.(value)), signal);
      };
      if (!input.isTTY) {
        if (!hasDefault) throw new Error('Prompt requires an interactive terminal or a valid default');
        const value = options.default as T;
        const error = await validate(value);
        if (signal?.aborted) throw new Error('Prompt aborted');
        if (error) throw new Error(`Invalid default: ${error}`);
        return value;
      }
      if (secret && typeof input.setRawMode !== 'function') throw new Error('Password input requires terminal raw mode');
      const wasRaw = input.isRaw === true;
      const wasFlowing = input.readableFlowing === true;
      if (secret) {
        clearBuffer();
        while (input.readableLength > 0) input.read();
      }
      let ended = input.readableEnded || input.destroyed || input.closed; let failure: Error | undefined;
      let waiter: (() => void) | undefined;
      const wake = () => { const current = waiter; waiter = undefined; current?.(); };
      const onData = (data: Buffer | string) => {
        const part = typeof data === 'string' ? data : shared.decoder.write(data);
        if (shared.buffer.length + part.length > MAX_BUFFER) { clearBuffer(); failure = new Error('Prompt input exceeds buffer limit'); }
        else shared.buffer += part;
        wake();
      };
      const onEnd = () => { ended = true; wake(); };
      const onError = (error: Error) => { failure = error; wake(); };
      const onAbort = () => { failure = new Error('Prompt aborted'); wake(); };
      input.on('data', onData); input.on('end', onEnd); input.on('error', onError); input.on('close', onEnd);
      signal?.addEventListener('abort', onAbort, { once: true });
      cleanup = () => {
        input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onError); input.removeListener('close', onEnd);
        signal?.removeEventListener('abort', onAbort);
        if (!wasFlowing) input.pause();
        if (secret) {
          try { while (input.readableLength > 0) input.read(); }
          finally { if (input.isRaw !== wasRaw) input.setRawMode?.(wasRaw); }
        }
      };
      if (secret && !wasRaw) input.setRawMode?.(true);
      input.resume();
      const line = async () => {
        let value = '';
        for (;;) {
          if (failure) throw failure;
          while (shared.buffer.length) {
            const char = String.fromCodePoint(shared.buffer.codePointAt(0)!); shared.buffer = shared.buffer.slice(char.length);
            if (shared.skipLf) { shared.skipLf = false; if (char === '\n') continue; }
            if (char === '\u0003' || char === '\u0004') throw new Error('Prompt aborted');
            if (char === '\r' || char === '\n') { if (char === '\r') shared.skipLf = true; write('\n'); return value; }
            if (char === '\u007f' || char === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
            if (char >= ' ') value += char;
            if (value.length > MAX_BUFFER) throw new Error('Prompt input exceeds buffer limit');
          }
          if (ended) throw new Error('Prompt input ended');
          await new Promise<void>((resolve) => { waiter = resolve; });
        }
      };
      for (;;) {
        if (signal?.aborted) throw new Error('Prompt aborted');
        const value = await read(line);
        if (signal?.aborted) throw new Error('Prompt aborted');
        const error = await validate(value);
        if (signal?.aborted) throw new Error('Prompt aborted');
        if (!error) { completed = true; return value; }
        write(`${error}\n`);
      }
    } finally {
      try { cleanup(); } finally {
        if (secret || !completed) {
          const skipLf = secret && completed && shared.skipLf;
          clearBuffer(); shared.skipLf = skipLf;
        }
        shared.active = false;
      }
    }
  }
  const ask = (message: string) => write(`${message}: `);
  const text = (options: PromptOptions<string>) => run(options, async (line) => { ask(options.message); const value = await line(); return value || options.default || ''; });
  const password = (options: PromptOptions<string>) => run(options, async (line) => { ask(options.message); const value = await line(); return value || options.default || ''; }, undefined, true);
  const confirm = (options: PromptOptions<boolean>) => run(options, async (line) => {
    for (;;) { ask(`${options.message} [y/n]`); const value = (await line()).trim().toLowerCase();
      if (!value && options.default !== undefined) return options.default;
      if (value === 'y' || value === 'yes') return true;
      if (value === 'n' || value === 'no') return false;
      write('Enter yes or no\n');
    }
  });
  const choices = <T>(items: readonly PromptChoice<T>[]) => { items.forEach((item, index) => write(`${index + 1}) ${item.label}\n`)); };
  const index = (value: string, length: number) => { if (!/^[1-9]\d*$/.test(value)) return -1; const i = Number(value) - 1; return Number.isSafeInteger(i) && i < length ? i : -1; };
  const select = <T>(options: ChoiceOptions<T>) => run(options, async (line) => {
    for (;;) { choices(options.options); ask(options.message); const value = (await line()).trim();
      if (!value && options.default !== undefined) return options.default;
      const i = index(value, options.options.length); if (i >= 0) return options.options[i]!.value;
      write('Invalid selection\n'); }
  }, (value) => options.options.some((item) => Object.is(item.value, value)));
  const multiselect = <T>(options: MultiChoiceOptions<T>) => run(options, async (line) => {
    for (;;) { choices(options.options); ask(options.message); const value = (await line()).trim();
      if (!value && options.default !== undefined) return options.default;
      const indices = value.split(',').map((part) => index(part.trim(), options.options.length));
      if (indices.every((i) => i >= 0) && new Set(indices).size === indices.length) return indices.map((i) => options.options[i]!.value);
      write('Invalid selection\n'); }
  }, (values) => Array.isArray(values) && new Set(values).size === values.length && values.every((value) => options.options.some((item) => Object.is(item.value, value))));
  const search = <T>(options: SearchOptions<T>) => run(options, async (line) => {
    for (;;) { ask(options.message); const query = await line(); const items = await abortable(Promise.resolve(options.search(query)), options.signal);
      if (options.signal?.aborted) throw new Error('Prompt aborted');
      choices(items); ask('Selection'); const choice = (await line()).trim(); const i = index(choice, items.length);
      if (i >= 0) return items[i]!.value;
      write('Invalid selection\n'); }
  });
  return { text, password, confirm, select, multiselect, search };
}
