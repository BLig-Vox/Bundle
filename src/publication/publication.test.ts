import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePublications, readPublicationManifest } from './definitions.ts';
import { publishVendorResources } from './publish.ts';

const asset = {package:'demo', tag:'data', source:'vendor/data.json', destination:'resources/data.json'};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
async function fixture(assets: unknown[] = [asset]) {
 const root = await mkdtemp(join(tmpdir(), 'bundle-publication-')); roots.push(root);
 await mkdir(join(root,'vendor'));
 await writeFile(join(root,'vendor/data.json'), '{"ok":true}');
 await writeFile(join(root,'publish.ts'), `export default ${JSON.stringify({version:1,assets})};`);
 return root;
}
test('copies selected bytes privately without importing source', async () => {
 const root = await fixture();
 expect(await publishVendorResources({root,selection:{package:'demo'}})).toEqual({created:['resources/data.json']});
 expect(await readFile(join(root,'resources/data.json'),'utf8')).toBe('{"ok":true}');
 expect((await stat(join(root,'resources/data.json'))).mode & 0o777).toBe(0o600);
});
test('manifest is copied and frozen without executing getters', () => {
 const input = {version:1 as const,assets:[{...asset}]}; const result=definePublications(input);
 input.assets[0]!.tag='changed'; expect(result.assets[0]!.tag).toBe('data');
 expect(Object.isFrozen(result.assets[0])).toBe(true);
 let called=false; const evil={...asset}; Object.defineProperty(evil,'source',{enumerable:true,get(){called=true;return 'x';}});
 expect(() => definePublications({version:1,assets:[evil]})).toThrow(); expect(called).toBe(false);
});
test('preflights all conflicts before creating any output', async () => {
 const root = await fixture([asset,{...asset,destination:'resources/existing.json'}]);
 await mkdir(join(root,'resources')); await writeFile(join(root,'resources/existing.json'),'keep');
 await expect(publishVendorResources({root,selection:{all:true}})).rejects.toThrow();
 expect(await Bun.file(join(root,'resources/data.json')).exists()).toBe(false);
 expect(await readFile(join(root,'resources/existing.json'),'utf8')).toBe('keep');
});
test('rejects symlink sources and invalid selection', async () => {
 const root=await fixture([{...asset,source:'vendor/link.json'}]); await symlink('data.json',join(root,'vendor/link.json'));
 await expect(publishVendorResources({root,selection:{all:true}})).rejects.toThrow();
 await expect(publishVendorResources({root,selection:{}})).rejects.toThrow();
});

test('rejects invalid shapes, unsafe paths, duplicate outputs and bounds', () => {
 const bad = [
  {...asset,source:'../secret.json'}, {...asset,source:'vendor/item.d.ts',destination:'config/item.ts'},
  {...asset,destination:'config/__proto__.ts',source:'vendor/item.ts'},
  {...asset,destination:'lang/EN.ts',source:'vendor/item.ts'},
  {...asset,destination:'resources/x.html'}, {...asset,destination:'resources/../x.json'},
 ];
 for (const item of bad) expect(() => definePublications({version:1,assets:[item]})).toThrow();
 expect(() => definePublications({version:1,assets:[asset,asset]})).toThrow();
 expect(() => definePublications({version:1,assets:Array(1)})).toThrow();
 expect(() => definePublications({version:1,assets:Array.from({length:129},(_,i)=>({...asset,destination:`resources/a${i}.json`}))})).toThrow();
 expect(() => definePublications({version:1,assets:Array.from({length:33},(_,i)=>({...asset,package:`p${i}`,destination:`resources/a${i}.json`}))})).toThrow();
});

test('selection validation and pre-abort happen before manifest import', async () => {
 const root=await fixture(); const marker=join(root,'marker');
 await writeFile(join(root,'publish.ts'), `await Bun.write(${JSON.stringify(marker)}, 'executed'); export default ${JSON.stringify({version:1,assets:[asset]})}`);
 for (const selected of [{},{all:false},{all:true,tag:'data'},{tag:'BAD'}])
  await expect(publishVendorResources({root,selection:selected})).rejects.toThrow();
 const controller=new AbortController(); controller.abort();
 await expect(publishVendorResources({root,selection:{all:true},signal:controller.signal})).rejects.toThrow();
 expect(await Bun.file(marker).exists()).toBe(false);
});

test('cancellation during manifest import prevents output', async () => {
 const root=await fixture();
 let notify!: () => void; let release!: () => void;
 const started=new Promise<void>(resolve => { notify=resolve; });
 const gate=new Promise<void>(resolve => { release=resolve; });
 const globals=globalThis as unknown as Record<string, unknown>;
 globals.__bundlePublicationGate={notify,gate};
 try {
  await writeFile(join(root,'publish.ts'),`globalThis.__bundlePublicationGate.notify(); await globalThis.__bundlePublicationGate.gate; export default ${JSON.stringify({version:1,assets:[asset]})}`);
  const controller=new AbortController(); const pending=publishVendorResources({root,selection:{all:true},signal:controller.signal});
  await started; controller.abort(); release(); await expect(pending).rejects.toThrow();
  expect(await Bun.file(join(root,'resources/data.json')).exists()).toBe(false);
 } finally { release(); delete globals.__bundlePublicationGate; }
});

test('refuses oversized individual and aggregate sources', async () => {
 const root=await fixture(); await writeFile(join(root,'vendor/data.json'),Buffer.alloc(65537));
 await expect(publishVendorResources({root,selection:{all:true}})).rejects.toThrow();
 const many=Array.from({length:17},(_,i)=>({...asset,source:`vendor/${i}.json`,destination:`resources/${i}.json`}));
 const other=await fixture(many);
 for (let i=0;i<17;i++) await writeFile(join(other,`vendor/${i}.json`),Buffer.alloc(65536));
 await expect(publishVendorResources({root:other,selection:{all:true}})).rejects.toThrow();
 expect(await Bun.file(join(other,'resources/0.json')).exists()).toBe(false);
});

test('snapshots selection before asynchronous root lookup', async () => {
 const root=await fixture(); const chosen={package:'demo'};
 const pending=publishVendorResources({root,selection:chosen}); chosen.package='other';
 expect(await pending).toEqual({created:['resources/data.json']});
});

test('rejects hardlinked sources and dangling destination links without output', async () => {
 const root=await fixture(); await link(join(root,'vendor/data.json'),join(root,'vendor/second.json'));
 await expect(publishVendorResources({root,selection:{all:true}})).rejects.toThrow();
 const other=await fixture(); await mkdir(join(other,'resources')); await symlink('missing',join(other,'resources/data.json'));
 await expect(publishVendorResources({root:other,selection:{all:true}})).rejects.toThrow();
 expect((await readFile(join(other,'vendor/data.json'),'utf8'))).toBe('{"ok":true}');
});

test('copies TypeScript bytes without executing the source', async () => {
 const root=await fixture([{...asset,source:'vendor/code.ts',destination:'config/code.ts'}]);
 const marker=join(root,'marker'); const contents=`await Bun.write(${JSON.stringify(marker)}, 'bad'); export default {};`;
 await writeFile(join(root,'vendor/code.ts'),contents);
 await publishVendorResources({root,selection:{all:true}});
 expect(await readFile(join(root,'config/code.ts'),'utf8')).toBe(contents); expect(await Bun.file(marker).exists()).toBe(false);
});

test('rejects destination ancestor collisions in either order before creating directories', async () => {
 const child={...asset,destination:'resources/data.json/nested.json'};
 for (const assets of [[asset,child],[child,asset]]) {
  const root=await fixture(assets);
  await expect(publishVendorResources({root,selection:{all:true}})).rejects.toThrow();
  await expect(stat(join(root,'resources'))).rejects.toThrow();
 }
});

test('rejects selected source destination overlap before creating files', async () => {
 const root=await fixture([asset,{...asset,source:'resources/data.json',destination:'resources/second.json'}]);
 await expect(publishVendorResources({root,selection:{all:true}})).rejects.toThrow();
 expect(await Bun.file(join(root,'resources/data.json')).exists()).toBe(false);
});

test('accepts exactly 128 assets and 32 packages and rejects one more', () => {
 const items=Array.from({length:128},(_,i)=>({...asset,package:`p${i%32}`,destination:`resources/${i}.json`}));
 expect(definePublications({version:1,assets:items}).assets).toHaveLength(128);
 expect(() => definePublications({version:1,assets:[...items,{...asset,destination:'resources/extra.json'}]})).toThrow();
 expect(() => definePublications({version:1,assets:[...items.slice(0,32),{...asset,package:'p32',destination:'resources/extra.json'}]})).toThrow();
});

test('accepts exact path segment and selector length bounds', () => {
 const path=[ 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), `${'d'.repeat(56)}.json` ].join('/');
 expect(path.length).toBe(256);
 const item={...asset,package:'p'.repeat(128),tag:'t'.repeat(128),source:path};
 expect(definePublications({version:1,assets:[item]}).assets[0]).toEqual(item);
 expect(() => definePublications({version:1,assets:[{...item,package:'p'.repeat(129)}]})).toThrow();
 expect(() => definePublications({version:1,assets:[{...item,tag:'t'.repeat(129)}]})).toThrow();
 expect(() => definePublications({version:1,assets:[{...item,source:`${'a'.repeat(65)}/x.json`}]})).toThrow();
 expect(() => definePublications({version:1,assets:[{...item,source:`z/${path}`}]})).toThrow();
});

test('accepts 64 KiB sources and exactly 1 MiB selected content', async () => {
 const many=Array.from({length:16},(_,i)=>({...asset,source:`vendor/${i}.json`,destination:`resources/${i}.json`}));
 const root=await fixture(many);
 for (let i=0;i<16;i++) await writeFile(join(root,`vendor/${i}.json`),Buffer.alloc(65536,i));
 const result=await publishVendorResources({root,selection:{all:true}});
 expect(result.created).toHaveLength(16);
 expect((await stat(join(root,'resources/15.json'))).size).toBe(65536);
});

test('rejects symbols, inherited records, array accessors and extra fields without getters', () => {
 let invoked=false;
 const extra={...asset}; Object.defineProperty(extra,'extra',{enumerable:true,get(){invoked=true;return 'x';}});
 expect(() => definePublications({version:1,assets:[extra]})).toThrow();
 const symbol={...asset,[Symbol('secret')]:1};
 expect(() => definePublications({version:1,assets:[symbol]})).toThrow();
 const inherited=Object.assign(Object.create({inherited:true}),asset);
 expect(() => definePublications({version:1,assets:[inherited]})).toThrow();
 const array=[asset]; Object.defineProperty(array,'0',{enumerable:true,get(){invoked=true;return asset;}});
 expect(() => definePublications({version:1,assets:array})).toThrow();
 const extended=[asset]; Object.defineProperty(extended,'extra',{enumerable:true,get(){invoked=true;return 1;}});
 expect(() => definePublications({version:1,assets:extended})).toThrow();
 expect(invoked).toBe(false);
});

test('rejects missing, oversized, and hardlinked publication manifests', async () => {
 const missing=await fixture(); await rm(join(missing,'publish.ts'));
 await expect(readPublicationManifest(missing)).rejects.toThrow();
 const large=await fixture(); await writeFile(join(large,'publish.ts'),Buffer.alloc(65537));
 await expect(readPublicationManifest(large)).rejects.toThrow();
 const linked=await fixture(); await link(join(linked,'publish.ts'),join(linked,'other.ts'));
 await expect(readPublicationManifest(linked)).rejects.toThrow();
});

test('canonical aliases work and manifest imports retain fixed URL lifetime', async () => {
 const root=await fixture(); await symlink(root,join(root,'alias'));
 expect((await readPublicationManifest(join(root,'alias'))).assets[0]?.tag).toBe('data');
 await writeFile(join(root,'publish.ts'),`export default ${JSON.stringify({version:1,assets:[{...asset,tag:'changed'}]})}`);
 expect((await readPublicationManifest(root)).assets[0]?.tag).toBe('data');
 expect(await publishVendorResources({root:join(root,'alias'),selection:{tag:'data'}})).toEqual({created:['resources/data.json']});
});

test('rejects a symlinked destination parent before publication', async () => {
 const root=await fixture(); await symlink('vendor',join(root,'resources'));
 await expect(publishVendorResources({root,selection:{all:true}})).rejects.toThrow();
 expect(await Bun.file(join(root,'vendor/data.json')).text()).toBe('{"ok":true}');
});
