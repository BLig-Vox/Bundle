import { pathToFileURL } from 'node:url';
import { checkedRouteFile } from '../http/route-definitions';
import { EventBus, validEventName, type EventListener } from './bus';

export interface ListenerReference { readonly module: string; readonly export: string; readonly method?: string }
export interface EventDefinition { readonly event: string; readonly listeners: readonly ListenerReference[] }
export type EventDefinitions = readonly EventDefinition[];
const branded = new WeakSet<object>();
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected plain event object');
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !keys.includes(key) || !d.enumerable || !('value' in d) || d.value === undefined) throw new Error('Invalid event property');
  }
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Expected dense event array');
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !d.enumerable || !('value' in d)) throw new Error('Invalid event array'); }
  return value;
}
function name(value: unknown): value is string { return typeof value === 'string' && identifier.test(value) && !forbidden.has(value); }
export function defineEvents(input: readonly EventDefinition[]): EventDefinitions {
  const result = array(input).map(item => {
    const obj = record(item, ['event', 'listeners']);
    if (!validEventName(obj.event)) throw new Error('Invalid event name');
    const listeners = array(obj.listeners).map(value => {
      const ref = record(value, ['module', 'export', 'method']);
      if (typeof ref.module !== 'string' || !/^(?:[A-Za-z0-9_$.-]+\/)*[A-Za-z0-9_$.-]+\.ts$/.test(ref.module) || ref.module.endsWith('.d.ts') || ref.module.split('/').some(part => part === '.' || part === '..') || ref.module === 'events.ts') throw new Error('Invalid event listener module');
      if (!name(ref.export) || (ref.method !== undefined && !name(ref.method))) throw new Error('Invalid listener export or method');
      return Object.freeze({ module: ref.module, export: ref.export, ...(ref.method === undefined ? {} : { method: ref.method as string }) });
    });
    return Object.freeze({ event: obj.event, listeners: Object.freeze(listeners) });
  });
  Object.freeze(result); branded.add(result); return result;
}
export function isDefinedEvents(value: unknown): value is EventDefinitions { return typeof value === 'object' && value !== null && branded.has(value); }
function isClass(value: unknown): boolean { return typeof value === 'function' && /^\s*class\b/.test(Function.prototype.toString.call(value)); }
/** Direct files are checked; their transitive imports execute as trusted code. */
export async function hydrateEvents(root: string, input: EventDefinitions): Promise<EventBus> {
  const bus = new EventBus();
  for (const definition of defineEvents(input)) for (const ref of definition.listeners) {
    const mod = await import(pathToFileURL(await checkedRouteFile(root, ref.module)).href);
    if (!Object.hasOwn(mod, ref.export)) throw new Error(`Missing event listener export ${ref.export}`);
    const target: unknown = mod[ref.export];
    let listener: EventListener;
    if (ref.method !== undefined) {
      if (!isClass(target)) throw new Error('Event listener must be a class');
      const cls = target as new () => object;
      const method = Object.getOwnPropertyDescriptor(cls.prototype, ref.method)?.value;
      if (typeof method !== 'function') throw new Error('Event listener method must be an own prototype method');
      listener = (payload, signal) => method.call(new cls(), payload, signal);
    } else {
      if (typeof target !== 'function' || isClass(target)) throw new Error('Event listener must be a function');
      listener = target as EventListener;
    }
    bus.on(definition.event, listener, { name: `${ref.module}#${ref.export}${ref.method === undefined ? '' : `.${ref.method}`}` });
  }
  return bus;
}
