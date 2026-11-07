import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRouter, type HttpHandler, type HttpMiddleware, type Router } from './router';

export interface RouteReference { readonly module: string; readonly export: string }
export interface HandlerReference extends RouteReference { readonly method?: string }
export interface RouteDefinition { readonly method: string; readonly path: string; readonly name?: string; readonly handler: HandlerReference; readonly middleware?: readonly RouteReference[] }
export type RouteDefinitions = readonly RouteDefinition[];
const defined = new WeakSet<object>();
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected a plain route object');
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !allowed.includes(key) || !d.enumerable || !('value' in d) || d.value === undefined) throw new Error('Invalid route property');
  }
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Expected a dense route array');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !('value' in d)) throw new Error('Invalid route array');
  }
  return value;
}
function safeName(value: unknown): value is string { return typeof value === 'string' && identifier.test(value) && !forbidden.has(value); }
function validModulePath(path: string): boolean {
  return /^(?:[A-Za-z0-9_$.-]+\/)*[A-Za-z0-9_$.-]+\.ts$/.test(path)
    && !path.endsWith('.d.ts') && path.split('/').every(part => part !== '.' && part !== '..');
}
function reference(value: unknown, handler: boolean): HandlerReference {
  const obj = record(value, handler ? ['module', 'export', 'method'] : ['module', 'export']);
  if (typeof obj.module !== 'string' || !validModulePath(obj.module)) throw new Error('Invalid root-relative TypeScript module path');
  if (obj.module === 'routes.ts') throw new Error('Route entrypoint routes.ts cannot be a handler or middleware module; use a separate module');
  if (!safeName(obj.export) || (obj.method !== undefined && !safeName(obj.method))) throw new Error('Invalid export or method name');
  return Object.freeze({ module: obj.module, export: obj.export, ...(obj.method === undefined ? {} : { method: obj.method as string }) });
}
/** Copy, validate and deeply freeze serializable route descriptors. Router closures cannot be cached. */
export function defineRoutes(input: readonly RouteDefinition[]): RouteDefinitions {
  const checker = createRouter();
  const result = array(input).map(item => {
    const obj = record(item, ['method', 'path', 'name', 'handler', 'middleware']);
    if (typeof obj.method !== 'string' || typeof obj.path !== 'string' || (obj.name !== undefined && typeof obj.name !== 'string')) throw new Error('Invalid route descriptor');
    const handler = reference(obj.handler, true);
    const middleware = obj.middleware === undefined ? undefined : Object.freeze(array(obj.middleware).map(item => reference(item, false)));
    checker.add(obj.method, obj.path, () => new Response(), { ...(obj.name === undefined ? {} : { name: obj.name }), middleware: [] });
    return Object.freeze({ method: obj.method, path: obj.path, ...(obj.name === undefined ? {} : { name: obj.name }), handler, ...(middleware === undefined ? {} : { middleware }) });
  });
  Object.freeze(result); defined.add(result); return result;
}
export function isDefinedRoutes(value: unknown): value is RouteDefinitions { return typeof value === 'object' && value !== null && defined.has(value); }

/** Canonical root aliases are allowed; beneath root no symlinked directories or multiply-linked files. Assumes no hostile concurrent tree mutation. */
export async function checkedRouteFile(root: string, relativePath: string): Promise<string> {
  if (!validModulePath(relativePath)) throw new Error('Invalid root-relative TypeScript module path');
  const canonical = await realpath(root);
  const parts = relativePath.split('/');
  let current = canonical;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe route module parent');
    const rel = relative(canonical, await realpath(current));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Route path escapes root');
  }
  const file = join(current, parts[parts.length - 1]!);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe route module file');
  const rel = relative(canonical, await realpath(file));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Route path escapes root');
  return file;
}
async function resolve(root: string, ref: RouteReference): Promise<unknown> {
  const module = await import(pathToFileURL(await checkedRouteFile(root, ref.module)).href);
  if (!Object.hasOwn(module, ref.export)) throw new Error(`Missing route export ${ref.export}`);
  return module[ref.export];
}
function isClass(value: unknown): boolean { return typeof value === 'function' && /^\s*class\b/.test(Function.prototype.toString.call(value)); }
export async function hydrateRoutes(root: string, input: RouteDefinitions): Promise<Router> {
  const definitions = defineRoutes(input);
  const router = createRouter();
  for (const route of definitions) {
    const target = await resolve(root, route.handler);
    let handler: HttpHandler;
    if (route.handler.method !== undefined) {
      if (!isClass(target)) throw new Error('Route controller must be a class');
      const cls = target as new () => object;
      const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, route.handler.method);
      if (!descriptor || typeof descriptor.value !== 'function') throw new Error('Route controller method must be an own prototype method');
      const method = descriptor.value as (this: object, ...args: Parameters<HttpHandler>) => ReturnType<HttpHandler>;
      handler = context => method.call(new cls(), context);
    } else {
      if (typeof target !== 'function' || isClass(target)) throw new Error('Route handler must be a function');
      handler = target as HttpHandler;
    }
    const middleware: HttpMiddleware[] = [];
    for (const ref of route.middleware ?? []) {
      const target = await resolve(root, ref);
      if (typeof target !== 'function' || isClass(target)) throw new Error('Route middleware must be a function');
      middleware.push(target as HttpMiddleware);
    }
    router.add(route.method, route.path, handler, { ...(route.name === undefined ? {} : { name: route.name }), middleware });
  }
  return router;
}
