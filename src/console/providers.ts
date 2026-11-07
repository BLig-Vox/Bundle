import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedRouteFile } from '../http/route-definitions';
import type { ServiceContainer } from './services';
import { loadCachedPackages } from '../packages/cache';

export interface ProviderReference { readonly module: string; readonly export: string }
export interface ProviderContext { readonly root: string; readonly container: ServiceContainer; readonly signal: AbortSignal }
export interface ApplicationProvider {
  register(context: ProviderContext): void | Promise<void>;
  boot?(context: ProviderContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const modulePath = /^(?:[A-Za-z0-9_$.-]+\/)*[A-Za-z0-9_$.-]+\.ts$/;
const forbidden = new Set(['constructor', 'prototype', '__proto__']);

/** Validate and snapshot explicit provider references without invoking accessors. */
export function defineProviders(input: readonly ProviderReference[]): readonly ProviderReference[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 64 || Reflect.ownKeys(input).length !== input.length + 1) throw new Error('Invalid provider definitions.');
  const seen = new Set<string>();
  const result: ProviderReference[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = Object.getOwnPropertyDescriptor(input, String(i));
    if (!item || !item.enumerable || !('value' in item)) throw new Error('Invalid provider definitions.');
    const value: unknown = item.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid provider reference.');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('module') || !keys.includes('export')) throw new Error('Invalid provider reference.');
    const mod = Object.getOwnPropertyDescriptor(value, 'module');
    const exp = Object.getOwnPropertyDescriptor(value, 'export');
    if (!mod || !exp || !mod.enumerable || !exp.enumerable || !('value' in mod) || !('value' in exp)) throw new Error('Invalid provider reference.');
    const m: unknown = mod.value, e: unknown = exp.value;
    if (typeof m !== 'string' || m.length > 256 || !modulePath.test(m) || m.endsWith('.d.ts') || m === 'providers.ts' || m.split('/').some(p => p === '.' || p === '..') || typeof e !== 'string' || e.length > 128 || !identifier.test(e) || forbidden.has(e)) throw new Error('Invalid provider reference.');
    const key = `${m}\0${e}`;
    if (seen.has(key)) throw new Error('Duplicate provider reference.');
    seen.add(key); result.push(Object.freeze({ module: m, export: e }));
  }
  return Object.freeze(result);
}

async function canonicalRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Invalid provider root.');
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new Error('Invalid provider root.');
  return canonical;
}
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw new Error('Provider operation cancelled.'); }

export async function loadProviderDefinitions(root: string, signal: AbortSignal = new AbortController().signal): Promise<readonly ProviderReference[]> {
  try {
    checkAbort(signal);
    const canonical = await canonicalRoot(root); checkAbort(signal);
    // Read only published metadata: discovery source is never implicit here.
    const packages = await loadCachedPackages(canonical); checkAbort(signal);
    const discovered = (packages ?? []).flatMap(item => item.providers);
    const file = join(canonical, 'providers.ts');
    let stat;
    try { stat = await lstat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { checkAbort(signal); return defineProviders(discovered); }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Unsafe provider registry.');
    checkAbort(signal);
    const source = await import(pathToFileURL(file).href); checkAbort(signal);
    return defineProviders([...defineProviders(source.default), ...discovered]);
  } catch { throw new Error('Provider definition loading failed.'); }
}

type ProviderClass = new () => ApplicationProvider;
function hooks(value: unknown): ProviderClass {
  if (typeof value !== 'function' || !/^\s*class\b/.test(Function.prototype.toString.call(value))) throw new Error('Invalid provider class.');
  const prototype = value.prototype as object;
  for (const name of ['register', 'boot', 'dispose']) {
    const own = Object.getOwnPropertyDescriptor(prototype, name);
    if (own ? !('value' in own) || typeof own.value !== 'function' : name === 'register' || name in prototype) throw new Error('Invalid provider hook.');
  }
  return value as ProviderClass;
}

export async function bootProviders(options: { root: string; container: ServiceContainer; signal?: AbortSignal; definitions?: readonly ProviderReference[] }): Promise<{ dispose(): Promise<void> }> {
  const signal = options.signal ?? new AbortController().signal;
  const instances: { instance: ApplicationProvider; dispose?: ApplicationProvider['dispose']; boot?: ApplicationProvider['boot'] }[] = [];
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposal ??= (async () => {
    const errors: Error[] = [];
    for (const provider of instances.reverse()) {
      try { await provider.dispose?.call(provider.instance); } catch { errors.push(new Error('Provider disposal failed.')); }
    }
    if (errors.length) throw new AggregateError(errors, 'Provider disposal failed.');
  })();
  try {
    checkAbort(signal);
    const root = await canonicalRoot(options.root); checkAbort(signal);
    const definitions = options.definitions === undefined ? await loadProviderDefinitions(root, signal) : defineProviders(options.definitions);
    checkAbort(signal);
    const paths: string[] = [];
    for (const ref of definitions) { checkAbort(signal); paths.push(await checkedRouteFile(root, ref.module)); checkAbort(signal); }
    const context: ProviderContext = Object.freeze({ root, container: options.container, signal });
    for (let i = 0; i < definitions.length; i++) {
      checkAbort(signal);
      const mod = await import(pathToFileURL(paths[i]!).href); checkAbort(signal);
      const ref = definitions[i]!;
      if (!Object.hasOwn(mod, ref.export)) throw new Error('Missing provider export.');
      const Provider = hooks(mod[ref.export]);
      const prototype = Provider.prototype;
      const register = Object.getOwnPropertyDescriptor(prototype, 'register')!.value as ApplicationProvider['register'];
      const boot = Object.getOwnPropertyDescriptor(prototype, 'boot')?.value as ApplicationProvider['boot'];
      const cleanup = Object.getOwnPropertyDescriptor(prototype, 'dispose')?.value as ApplicationProvider['dispose'];
      const instance = new Provider(); instances.push({ instance, boot, dispose: cleanup }); checkAbort(signal);
      if (['register', 'boot', 'dispose'].some(name => Object.hasOwn(instance, name))) throw new Error('Invalid provider hook.');
      await register.call(instance, context); checkAbort(signal);
    }
    for (const provider of instances) { checkAbort(signal); await provider.boot?.call(provider.instance, context); checkAbort(signal); }
    return { dispose };
  } catch {
    const errors: Error[] = [new Error('Provider bootstrap failed.')];
    try { await dispose(); } catch { errors.push(new Error('Provider disposal failed.')); }
    throw new AggregateError(errors, 'Provider bootstrap failed.');
  }
}
