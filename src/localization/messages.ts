import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Messages = Readonly<Record<string, string>>;
const keyPattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const namePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const localePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const size = (s: string) => Buffer.byteLength(s, 'utf8');
function text(value: unknown, max: number): value is string {
 return typeof value === 'string' && size(value) <= max && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value) && !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(value);
}
function entries(value: unknown, max: number): [string, unknown][] {
 if (typeof value !== 'object' || value === null || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw Error('Invalid language data');
 const keys = Reflect.ownKeys(value);
 if (keys.length > max || keys.some(k => typeof k !== 'string')) throw Error('Invalid language data');
 return (keys as string[]).map(k => {
  const descriptor = Object.getOwnPropertyDescriptor(value, k);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw Error('Invalid language data');
  return [k, descriptor.value];
 });
}
export function defineMessages(input: Readonly<Record<string, string>>): Messages {
 const result: Record<string,string> = Object.create(null);
 for (const [key,value] of entries(input,128)) {
  if (!keyPattern.test(key) || !text(value,4096)) throw Error('Invalid language data');
  result[key] = value;
 }
 if (size(JSON.stringify(result)) > 65536) throw Error('Invalid language data');
 return Object.freeze(result);
}
export const bundledMessages = defineMessages({'bundle.ready':'Bundle is ready.','bundle.greeting':'Hello, {name}.'});
export async function languageRoot(root: string): Promise<string> {
 if (typeof root !== 'string' || !isAbsolute(root)) throw Error('Invalid language root');
 const canonical = await realpath(root);
 if (!(await lstat(canonical)).isDirectory()) throw Error('Invalid language root');
 return canonical;
}
function validLocale(locale: unknown): locale is string { return typeof locale === 'string' && locale.length <= 35 && localePattern.test(locale); }
export async function loadMessages(root: string, locale = 'en'): Promise<Messages> {
 try {
  if (!validLocale(locale)) throw Error();
  const base = await languageRoot(root); const dir = join(base,'lang');
  try { const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && locale === 'en') return bundledMessages; throw error; }
  const path = join(dir, `${locale}.ts`);
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw Error(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && locale === 'en') return bundledMessages; throw error; }
  const module = await import(pathToFileURL(path).href);
  const loaded = defineMessages(module.default);
  return locale === 'en' ? defineMessages({...bundledMessages,...loaded}) : loaded;
 } catch { throw Error('Unable to load language resources'); }
}
export async function translate(root: string, key: string, options: {locale?: string; values?: Readonly<Record<string,string|number>>} = {}): Promise<string> {
 try {
  if (typeof key !== 'string' || !keyPattern.test(key)) throw Error();
  const opts = entries(options,2); let locale = 'en'; let values: unknown = {};
  for (const [name,value] of opts) {
   if (name === 'locale') { if (!validLocale(value)) throw Error(); locale = value; }
   else if (name === 'values') values = value;
   else throw Error();
  }
  const replacements = new Map<string,string>();
  for (const [name,value] of entries(values,32)) {
   if (!namePattern.test(name) || !(text(value,512) || (typeof value === 'number' && Number.isFinite(value)))) throw Error();
   replacements.set(name,String(value));
  }
  const catalogue = await loadMessages(root,locale);
  if (!Object.hasOwn(catalogue,key)) throw Error();
  const used = new Set<string>();
  const result = catalogue[key]!.replace(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g, (_match,name: string) => {
   const replacement = replacements.get(name); if (replacement === undefined) throw Error(); used.add(name); return replacement;
  });
  if (used.size !== replacements.size || size(result) > 8192) throw Error();
  return result;
 } catch { throw Error('Unable to translate language message'); }
}
