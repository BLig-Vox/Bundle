import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PublicationAsset { readonly package: string; readonly tag: string; readonly source: string; readonly destination: string }
export interface PublicationManifest { readonly version: 1; readonly assets: readonly PublicationAsset[] }

export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
 if (value === null || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw Error();
 const descriptors = Object.getOwnPropertyDescriptors(value);
 if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) throw Error();
 const result: Record<string, unknown> = Object.create(null);
 for (const [key, descriptor] of Object.entries(descriptors)) {
  if (!descriptor.enumerable || !('value' in descriptor)) throw Error();
  result[key] = descriptor.value;
 }
 return result;
}
export function validName(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,127}$/.test(value); }
function validPath(value: unknown): value is string {
 return typeof value === 'string' && value.length <= 256 && /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/)*[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value);
}
function extension(path: string): string | undefined {
 if (path.endsWith('.d.ts')) return undefined;
 return /\.(ts|json|txt)$/.exec(path)?.[1];
}
function destination(path: string): boolean {
 const parts = path.split('/');
 if (parts[0] === 'config' && parts.length === 2) {
  const name = parts[1]!.slice(0,-3);
  return parts[1]!.endsWith('.ts') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !['constructor','prototype','__proto__'].includes(name);
 }
 if (parts[0] === 'lang' && parts.length === 2 && parts[1]!.endsWith('.ts')) {
  const name=parts[1]!.slice(0,-3); return name.length <= 35 && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(name);
 }
 return parts[0] === 'resources' && parts.length >= 2 && /\.(json|txt)$/.test(path);
}
export function definePublications(input: PublicationManifest): PublicationManifest {
 const root=record(input,['version','assets']);
 if (root.version !== 1 || !Array.isArray(root.assets) || Object.getPrototypeOf(root.assets) !== Array.prototype || root.assets.length > 128) throw Error('Invalid publication manifest');
 const array=root.assets;
 if (Reflect.ownKeys(array).length !== array.length + 1) throw Error('Invalid publication manifest');
 const assets: PublicationAsset[]=[]; const destinations=new Set<string>(); const packages=new Set<string>();
 for (let i=0;i<array.length;i++) {
  const descriptor=Object.getOwnPropertyDescriptor(array,String(i));
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw Error('Invalid publication manifest');
  const item=record(descriptor.value,['package','tag','source','destination']);
  if (!validName(item.package) || !validName(item.tag) || !validPath(item.source) || !validPath(item.destination) || !extension(item.source) || extension(item.source) !== extension(item.destination) || !destination(item.destination) || item.source === item.destination || destinations.has(item.destination)) throw Error('Invalid publication manifest');
  destinations.add(item.destination); packages.add(item.package); if (packages.size > 32) throw Error('Invalid publication manifest');
  assets.push(Object.freeze({package:item.package,tag:item.tag,source:item.source,destination:item.destination}));
 }
 return Object.freeze({version:1,assets:Object.freeze(assets)});
}
export async function canonicalRoot(root: string): Promise<string> {
 if (typeof root !== 'string' || !isAbsolute(root)) throw Error();
 const base=await realpath(root); if (!(await stat(base)).isDirectory()) throw Error(); return base;
}
export async function readPublicationManifest(root: string, signal?: AbortSignal): Promise<PublicationManifest> {
 try {
  signal?.throwIfAborted(); const base=await canonicalRoot(root); signal?.throwIfAborted();
  const file=join(base,'publish.ts'); const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try { const s=await handle.stat(); if (!s.isFile() || s.nlink !== 1 || s.size > 65536) throw Error(); }
  finally { await handle.close(); }
  signal?.throwIfAborted(); const loaded=await import(pathToFileURL(file).href); signal?.throwIfAborted();
  return definePublications(loaded.default);
 } catch { throw Error('Unable to read publication manifest'); }
}
