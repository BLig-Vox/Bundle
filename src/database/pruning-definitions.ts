import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EntityClass, FilterQuery } from '@mikro-orm/sqlite';

export interface Prunable { readonly name: string }
export type PruningDefinitions = readonly Prunable[];
type State = { model: EntityClass<any>; where: (signal: AbortSignal) => FilterQuery<any> | Promise<FilterQuery<any>> };
const rules = new WeakMap<object, State>();
const lists = new WeakSet<object>();

export function pruningRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid pruning configuration');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !d || !d.enumerable || !('value' in d) || d.value === undefined) throw new Error('Invalid pruning configuration');
    result[key] = d.value;
  }
  return result;
}
export function pruningArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Invalid pruning configuration');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !('value' in d)) throw new Error('Invalid pruning configuration');
  }
  return value;
}
export function pruningName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
}
export function definePrunable<T extends object>(input: { name: string; model: EntityClass<T>; where: (signal: AbortSignal) => FilterQuery<T> | Promise<FilterQuery<T>> }): Prunable {
  const item = pruningRecord(input, ['name', 'model', 'where']);
  if (!pruningName(item.name) || typeof item.model !== 'function' || typeof item.where !== 'function') throw new Error('Invalid pruning rule');
  const rule = Object.freeze({ name: item.name });
  rules.set(rule, { model: item.model as EntityClass<any>, where: item.where as State['where'] });
  return rule;
}
export function definePruning(input: readonly Prunable[]): PruningDefinitions {
  const names = new Set<string>(); const models = new Set<Function>();
  const result = pruningArray(input, 32).map(value => {
    const state = typeof value === 'object' && value !== null ? rules.get(value) : undefined;
    if (!state || names.has((value as Prunable).name) || models.has(state.model)) throw new Error('Invalid pruning rules');
    names.add((value as Prunable).name); models.add(state.model);
    return value as Prunable;
  });
  Object.freeze(result); lists.add(result); return result;
}
export function pruningEntries(value: PruningDefinitions): readonly { name: string; model: EntityClass<any>; where: State['where'] }[] {
  if (!value || !lists.has(value)) throw new Error('Invalid pruning rules');
  return value.map(rule => ({ name: rule.name, ...rules.get(rule)! }));
}
export function checkPruningAbort(signal: AbortSignal): void { if (signal.aborted) throw new Error('Pruning cancelled'); }
export async function loadPruning(root: string, signal?: AbortSignal): Promise<PruningDefinitions> {
  try {
    if (typeof root !== 'string' || !isAbsolute(root) || (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error();
    const active = signal ?? new AbortController().signal;
    checkPruningAbort(active);
    const canonical = await realpath(root); checkPruningAbort(active);
    const file = join(canonical, 'pruning.ts');
    const stat = await lstat(file); checkPruningAbort(active);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error();
    const module = await import(pathToFileURL(file).href); checkPruningAbort(active);
    pruningEntries(module.default); return module.default;
  } catch { throw new Error('Unable to load pruning rules'); }
}
