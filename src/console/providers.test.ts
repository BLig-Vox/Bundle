import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceContainer } from './services';
import { bootProviders, defineProviders, loadProviderDefinitions } from './providers';

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'bundle-providers-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test('references are strictly validated, copied and frozen', () => {
  const input = [{ module: 'src/a.ts', export: 'A' }];
  const result = defineProviders(input);
  input[0]!.module = 'other.ts';
  expect(result[0]!.module).toBe('src/a.ts');
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0])).toBe(true);
  for (const bad of [[{module:'../a.ts', export:'A'}], [{module:'providers.ts', export:'A'}], [{module:'a.ts',export:'constructor'}], [{module:'a.ts',export:'A',extra:true}], Array(1), Array.from({length:65}, () => ({module:'a.ts', export:'A'})), [{module:'a.ts',export:'A'},{module:'a.ts',export:'A'}]]) {
    expect(() => defineProviders(bad as never)).toThrow();
  }
  const accessor = Object.defineProperty({export:'A'}, 'module', {enumerable:true,get(){ throw Error('getter executed'); }});
  expect(() => defineProviders([accessor] as never)).toThrow();
});

test('registers all before boot and disposes exactly once in reverse', async () => {
  const root = await fixture();
  await writeFile(join(root,'provider.ts'), `export class A { register(c) { globalThis.providerEvents.push('register A'); c.container.register('value','singleton',()=>42); } async boot(c) { globalThis.providerEvents.push('boot A'); } async dispose() { globalThis.providerEvents.push('dispose A'); } } export class B { register() { globalThis.providerEvents.push('register B'); } boot() { globalThis.providerEvents.push('boot B'); } dispose() { globalThis.providerEvents.push('dispose B'); } }`);
  (globalThis as any).providerEvents = [];
  const container = new ServiceContainer();
  const runtime = await bootProviders({root,container,definitions:[{module:'provider.ts',export:'A'},{module:'provider.ts',export:'B'}]});
  const scope = container.createScope(); expect(scope.resolve('value')).toBe(42);
  await Promise.all([runtime.dispose(),runtime.dispose()]);
  expect((globalThis as any).providerEvents).toEqual(['register A','register B','boot A','boot B','dispose B','dispose A']);
  await scope.dispose(); await container.dispose();
});

test('preflights all files before executing any provider import', async () => {
  const root = await fixture(); (globalThis as any).providerImported = false;
  await writeFile(join(root,'a.ts'), `globalThis.providerImported = true; export class A { register() {} }`);
  await expect(bootProviders({root,container:new ServiceContainer(),definitions:[{module:'a.ts',export:'A'},{module:'missing.ts',export:'B'}]})).rejects.toThrow();
  expect((globalThis as any).providerImported).toBe(false);
});

test('partial failure cleans up all constructed providers without exposing errors', async () => {
  const root = await fixture(); (globalThis as any).providerEvents = [];
  await writeFile(join(root,'a.ts'), `export class A { register() {} dispose() { globalThis.providerEvents.push('A'); throw Error('secret dispose'); } } export class B { register() { throw Error('secret register'); } dispose() { globalThis.providerEvents.push('B'); } }`);
  let failure: unknown;
  try { await bootProviders({root,container:new ServiceContainer(),definitions:[{module:'a.ts',export:'A'},{module:'a.ts',export:'B'}]}); } catch (e) { failure = e; }
  expect(failure).toBeInstanceOf(AggregateError); expect(String(failure)).not.toContain('secret');
  expect((globalThis as any).providerEvents).toEqual(['B','A']);
});

test('cancellation after registration cleans up and skips boot', async () => {
  const root = await fixture(); (globalThis as any).providerEvents = [];
  await writeFile(join(root,'a.ts'), `export class A { register(c) { globalThis.providerEvents.push('register'); globalThis.providerAbort.abort(); } boot() { globalThis.providerEvents.push('boot'); } dispose() { globalThis.providerEvents.push('dispose'); } }`);
  const abort = new AbortController(); (globalThis as any).providerAbort = abort;
  await expect(bootProviders({root,container:new ServiceContainer(),signal:abort.signal,definitions:[{module:'a.ts',export:'A'}]})).rejects.toThrow();
  expect((globalThis as any).providerEvents).toEqual(['register','dispose']);
});

test('loads explicit registry and uses its provider', async () => {
  const root = await fixture(); expect(await loadProviderDefinitions(root)).toEqual([]);
  await writeFile(join(root,'providers.ts'), `export default [{ module: 'a.ts', export: 'A' }];`);
  await writeFile(join(root,'a.ts'), `export class A { register(c) { c.container.register('registry-value','singleton',()=>9); } }`);
  const definitions = await loadProviderDefinitions(root); expect(Object.isFrozen(definitions)).toBe(true);
  const container = new ServiceContainer(); const lifecycle = await bootProviders({root,container});
  const scope = container.createScope(); expect(scope.resolve('registry-value')).toBe(9);
  await scope.dispose(); await lifecycle.dispose(); await container.dispose();
});

test('cached package providers load without a root registry or package source import',async()=>{
 const root=await fixture();await mkdir(join(root,'bootstrap/cache'),{recursive:true});
 await writeFile(join(root,'bootstrap/cache/packages.json'),JSON.stringify({version:1,packages:[{name:'local',providers:[{module:'a.ts',export:'A'}]}]})+'\n',{mode:0o600});
 await writeFile(join(root,'packages.ts'),`throw Error('must not import package source');`);
 await writeFile(join(root,'a.ts'),`export class A {register(c:any){c.container.register('from-cache','singleton',()=>19);}}`);
 expect(await loadProviderDefinitions(root)).toEqual([{module:'a.ts',export:'A'}]);
 const container=new ServiceContainer();let handle:{dispose():Promise<void>}|undefined;
 try{
  handle=await bootProviders({root,container});const scope=container.createScope();
  try{expect(scope.resolve('from-cache')).toBe(19);}finally{await scope.dispose();}
 }finally{try{await handle?.dispose();}finally{await container.dispose();}}
});

test('combined root and cached package provider references reject duplicate registration',async()=>{
 const root=await fixture();await mkdir(join(root,'bootstrap/cache'),{recursive:true});
 await writeFile(join(root,'bootstrap/cache/packages.json'),JSON.stringify({version:1,packages:[{name:'local',providers:[{module:'a.ts',export:'A'}]}]})+'\n',{mode:0o600});
 await writeFile(join(root,'providers.ts'),`export default [{module:'a.ts',export:'A'}];`);
 await expect(loadProviderDefinitions(root)).rejects.toThrow();
});

test('refuses symlinked registry', async () => {
  const root = await fixture();
  await writeFile(join(root,'actual.ts'), `export default [];`);
  await symlink(join(root,'actual.ts'),join(root,'providers.ts'));
  await expect(loadProviderDefinitions(root)).rejects.toThrow();
});

test('rejects nonclass and inherited or accessor lifecycle hooks', async () => {
  const root = await fixture();
  await writeFile(join(root,'a.ts'), `export function F() {} class Base { register() {} } export class Inherited extends Base {} export class Accessor { get register() { throw Error('getter'); } } export class Shadow { register() {} constructor() { this.register = () => {}; } }`);
  for (const name of ['F','Inherited','Accessor','Shadow']) await expect(bootProviders({root,container:new ServiceContainer(),definitions:[{module:'a.ts',export:name}]})).rejects.toThrow();
});
