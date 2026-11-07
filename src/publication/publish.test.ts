import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as publication from './publish.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true}))); });
const assets = [
 {package:'demo', tag:'core', source:'vendor/a.ts', destination:'config/a.ts'},
 {package:'demo', tag:'extra', source:'vendor/b.ts', destination:'config/b.ts'},
 {package:'other', tag:'core', source:'vendor/c.ts', destination:'config/c.ts'},
 {package:'demo', tag:'core', source:'vendor/missing.json', destination:'resources/data.json'},
];
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'bundle-config-publish-')); roots.push(root);
 await mkdir(join(root,'vendor'));
 for (const name of ['a','b','c']) await writeFile(join(root,`vendor/${name}.ts`),`export default {name:'${name}'};`);
 await writeFile(join(root,'publish.ts'),`export default ${JSON.stringify({version:1,assets})};`);
 return root;
}

test('configuration publication selects only matching config destinations', async () => {
 const root=await fixture();
 expect(await publication.publishConfigurationResources({root,selection:{package:'demo',tag:'core'}})).toEqual({created:['config/a.ts']});
 expect(await readFile(join(root,'config/a.ts'),'utf8')).toContain("name:'a'");
 expect(await Bun.file(join(root,'resources/data.json')).exists()).toBe(false);
 const other=await fixture();
 expect(await publication.publishConfigurationResources({root:other,selection:{all:true}})).toEqual({created:['config/a.ts','config/b.ts','config/c.ts']});
 const tagged=await fixture();
 expect(await publication.publishConfigurationResources({root:tagged,selection:{tag:'core'}})).toEqual({created:['config/a.ts','config/c.ts']});
 const packaged=await fixture();
 expect(await publication.publishConfigurationResources({root:packaged,selection:{package:'demo'}})).toEqual({created:['config/a.ts','config/b.ts']});
});

test('configuration publication validates selectors and cancellation before import', async () => {
 const root=await fixture(); const marker=join(root,'marker');
 await writeFile(join(root,'publish.ts'),`await Bun.write(${JSON.stringify(marker)}, 'called'); export default ${JSON.stringify({version:1,assets})};`);
 for (const selection of [{},{all:false},{all:true,tag:'core'},{package:'BAD'}])
  await expect(publication.publishConfigurationResources({root,selection})).rejects.toThrow();
 const controller=new AbortController(); controller.abort();
 await expect(publication.publishConfigurationResources({root,selection:{all:true},signal:controller.signal})).rejects.toThrow();
 expect(await Bun.file(marker).exists()).toBe(false);
});

test('configuration publication fails on no matches, invalid manifest and selected conflicts before writes', async () => {
 const root=await fixture();
 await expect(publication.publishConfigurationResources({root,selection:{tag:'absent'}})).rejects.toThrow();
 await mkdir(join(root,'config')); await writeFile(join(root,'config/b.ts'),'keep');
 await expect(publication.publishConfigurationResources({root,selection:{all:true}})).rejects.toThrow();
 expect(await Bun.file(join(root,'config/a.ts')).exists()).toBe(false);
 expect(await readFile(join(root,'config/b.ts'),'utf8')).toBe('keep');
 const invalid=await fixture();
 await writeFile(join(invalid,'publish.ts'),`export default ${JSON.stringify({version:1,assets:[...assets,{...assets[3],destination:'../escape.json'}]})};`);
 await expect(publication.publishConfigurationResources({root:invalid,selection:{all:true}})).rejects.toThrow();
 expect(await Bun.file(join(invalid,'config/a.ts')).exists()).toBe(false);
 const nonconfig=await fixture();
 await writeFile(join(nonconfig,'publish.ts'),`export default ${JSON.stringify({version:1,assets:[assets[3]]})};`);
 await expect(publication.publishConfigurationResources({root:nonconfig,selection:{all:true}})).rejects.toThrow();
 const ancestor=await fixture(); await writeFile(join(ancestor,'config'),'not a directory');
 await expect(publication.publishConfigurationResources({root:ancestor,selection:{all:true}})).rejects.toThrow();
 expect(await readFile(join(ancestor,'config'),'utf8')).toBe('not a directory');
});

test('abort during manifest import prevents configuration publication', async () => {
 const root=await fixture();
 let notify!: () => void; let release!: () => void;
 const started=new Promise<void>(resolve => { notify=resolve; });
 const gate=new Promise<void>(resolve => { release=resolve; });
 const globals=globalThis as unknown as Record<string, unknown>;
 globals.__configPublicationGate={notify,gate};
 try {
  await writeFile(join(root,'publish.ts'),`globalThis.__configPublicationGate.notify(); await globalThis.__configPublicationGate.gate; export default ${JSON.stringify({version:1,assets})}`);
  const controller=new AbortController();
  const pending=publication.publishConfigurationResources({root,selection:{all:true},signal:controller.signal});
  await started; controller.abort(); release(); await expect(pending).rejects.toThrow();
  expect(await Bun.file(join(root,'config/a.ts')).exists()).toBe(false);
 } finally { release(); delete globals.__configPublicationGate; }
});
