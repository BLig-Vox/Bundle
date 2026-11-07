import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, link, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineMessages, loadMessages, translate } from './messages.ts';

test('bundled English and explicit locale overrides are consumed', async () => {
 const root = await mkdtemp(join(tmpdir(), 'bundle-language-'));
 try {
  expect(await translate(root, 'bundle.greeting', { values: { name: '世界' } })).toBe('Hello, 世界.');
  await mkdir(join(root, 'lang'));
  await writeFile(join(root, 'lang/en.ts'), 'export default {"bundle.ready":"Ready!"}');
  expect((await loadMessages(root))['bundle.ready']).toBe('Ready!');
  expect((await loadMessages(root))['bundle.greeting']).toBe('Hello, {name}.');
  await writeFile(join(root, 'lang/fr.ts'), 'export default {"salut":"Bonjour"}');
  expect(await translate(root, 'salut', {locale:'fr'})).toBe('Bonjour');
  await expect(translate(root, 'bundle.ready', {locale:'fr'})).rejects.toThrow();
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('catalogues are copied and strict', () => {
 const input = {a:'hi'}; const out = defineMessages(input); input.a='changed';
 expect(out.a).toBe('hi'); expect(Object.isFrozen(out)).toBe(true);
 expect(() => defineMessages({a:'\u0000'})).toThrow();
 expect(() => defineMessages(Object.defineProperty({},'a',{get(){throw Error('getter')}}))).toThrow();
});

test('bounds Unicode, catalogue structure and replacements', async () => {
 expect(() => defineMessages({a: '😀'.repeat(1025)})).toThrow();
 expect(() => defineMessages({a: '\ud800'})).toThrow();
 expect(() => defineMessages(Object.fromEntries(Array.from({length:129},(_,i)=>[`k${i}`,'v'])))).toThrow();
 expect(() => defineMessages(Object.create({inherited:'v'}))).toThrow();
 expect(() => defineMessages({[Symbol('x')]:'v'} as unknown as Record<string,string>)).toThrow();
 const root=await mkdtemp(join(tmpdir(),'bundle-bounds-'));
 try {
  await expect(translate(root,'bundle.greeting')).rejects.toThrow();
  await expect(translate(root,'bundle.ready',{values:{unused:'x'}})).rejects.toThrow();
  await expect(translate(root,'bundle.greeting',{values:{name:'x'.repeat(513)}})).rejects.toThrow();
  await expect(translate(root,'bundle.greeting',{values:{name:Infinity}})).rejects.toThrow();
  await expect(loadMessages(root,'../en')).rejects.toThrow();
  await expect(loadMessages(root,'fr')).rejects.toThrow();
 } finally {await rm(root,{recursive:true,force:true});}
});
test('validates requests and source paths before importing trusted code', async () => {
 const root=await mkdtemp(join(tmpdir(),'bundle-import-'));
 try {
  await mkdir(join(root,'lang')); const marker=join(root,'marker');
  const source=join(root,'lang/en.ts');
  await writeFile(source, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); export default {a:'A'};`);
  await expect(translate(root,'bad key')).rejects.toThrow();
  await expect(readFile(marker)).rejects.toThrow();
  await link(source,join(root,'other')); await expect(loadMessages(root)).rejects.toThrow();
  await rm(join(root,'other')); await rm(source);
  await symlink(join(root,'other'),source); await expect(loadMessages(root)).rejects.toThrow();
  await rm(source); await writeFile(source,'x'.repeat(65537)); await expect(loadMessages(root)).rejects.toThrow();
  await expect(readFile(marker)).rejects.toThrow();
 } finally {await rm(root,{recursive:true,force:true});}
});


test('catalogue entry and byte limits accept boundaries and reject overflow', () => {
 const make = (count:number) => Object.fromEntries(Array.from({length:count},(_,i)=>[`k${i}`,'v']));
 expect(Object.keys(defineMessages(make(128)))).toHaveLength(128);
 expect(() => defineMessages(make(129))).toThrow();
 expect(defineMessages({a:'é'.repeat(2048)}).a).toHaveLength(2048);
 expect(() => defineMessages({a:'é'.repeat(2048)+'a'})).toThrow();
 const aggregate:Record<string,string> = {};
 for (let i=0;i<15;i++) aggregate[`k${i}`]='x'.repeat(4096);
 aggregate.last='';
 const remaining=65536-Buffer.byteLength(JSON.stringify(aggregate));
 aggregate.last='x'.repeat(remaining);
 expect(Buffer.byteLength(JSON.stringify(aggregate))).toBe(65536);
 expect(Object.keys(defineMessages(aggregate))).toHaveLength(16);
 aggregate.last+='x';
 expect(() => defineMessages(aggregate)).toThrow();
});

test('rejects getters and symbols without invoking getters', () => {
 let reads=0;
 const object=Object.defineProperty({},'a',{enumerable:true,get(){reads++; return 'v';}});
 expect(() => defineMessages(object)).toThrow(); expect(reads).toBe(0);
 const symbol=Object.assign({a:'v'},{[Symbol('s')]:'v'});
 expect(() => defineMessages(symbol)).toThrow();
 expect(() => defineMessages(Object.assign(Object.create({a:'v'}),{b:'v'}))).toThrow();
});

test('locale syntax and exact total-length bounds', async () => {
 const root=await mkdtemp(join(tmpdir(),'bundle-locale-'));
 try {
  await mkdir(join(root,'lang'));
  const long='abc-abcdefgh-abcdefgh-abcdefgh-abcd';
  expect(long.length).toBe(35);
  await writeFile(join(root,'lang/aa.ts'),"export default {a:'short'};");
  await writeFile(join(root,`lang/${long}.ts`),"export default {a:'long'};");
  expect((await loadMessages(root,'aa')).a).toBe('short');
  expect((await loadMessages(root,long)).a).toBe('long');
  await expect(loadMessages(root,'a')).rejects.toThrow();
  await expect(loadMessages(root,long+'e')).rejects.toThrow();
  await expect(loadMessages(root,'en--US')).rejects.toThrow();
 } finally {await rm(root,{recursive:true,force:true});}
});

test('replacement count, text, number and output byte boundaries', async () => {
 const root=await mkdtemp(join(tmpdir(),'bundle-values-'));
 try {
  await mkdir(join(root,'lang'));
  const names=Array.from({length:32},(_,i)=>`v${i}`);
  const long='{x}'.repeat(16);
  const source={many:names.map(n=>`{${n}}`).join(','), exact:long, excess:long+'{x}', literal:'{bad-name} {{word}} {x}', numeric:'{x}'};
  await writeFile(join(root,'lang/en.ts'),`export default ${JSON.stringify(source)};`);
  const values=Object.fromEntries(names.map(n=>[n,'x']));
  expect(await translate(root,'many',{values})).toBe(Array(32).fill('x').join(','));
  await expect(translate(root,'many',{values:{...values,extra:'x'}})).rejects.toThrow();
  expect(Buffer.byteLength(await translate(root,'exact',{values:{x:'é'.repeat(256)}}))).toBe(8192);
  await expect(translate(root,'excess',{values:{x:'x'.repeat(512)}})).rejects.toThrow();
  await expect(translate(root,'numeric',{values:{x:'x'.repeat(513)}})).rejects.toThrow();
  expect(await translate(root,'numeric',{values:{x:42.5}})).toBe('42.5');
  await expect(translate(root,'numeric',{values:{x:NaN}})).rejects.toThrow();
  await expect(translate(root,'numeric')).rejects.toThrow();
  await expect(translate(root,'numeric',{values:{x:1,unused:2}})).rejects.toThrow();
  expect(await translate(root,'literal',{values:{word:'W',x:'X'}})).toBe('{bad-name} {W} X');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('snapshots replacement values and options before asynchronous source loading', async () => {
 const root=await mkdtemp(join(tmpdir(),'bundle-snapshot-'));
 try {
  await mkdir(join(root,'lang'));
  await writeFile(join(root,'lang/en.ts'),"export default {hello:'Hi {name}'};");
  await writeFile(join(root,'lang/fr.ts'),"export default {hello:'Bonjour {name}'};");
  const values={name:'first'};const options={locale:'en',values};
  const pending=translate(root,'hello',options);
  values.name='second';options.locale='fr';
  expect(await pending).toBe('Hi first');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('canonical root alias shares fixed URL import lifetime', async () => {
 const root=await mkdtemp(join(tmpdir(),'bundle-lifetime-')); const holder=await mkdtemp(join(tmpdir(),'bundle-alias-'));
 try {
  await mkdir(join(root,'lang')); await symlink(root,join(holder,'alias'));
  const path=join(root,'lang/en.ts');
  await writeFile(path,"export default {a:'first'};");
  expect((await loadMessages(join(holder,'alias'))).a).toBe('first');
  await writeFile(path,"export default {a:'second'};");
  expect((await loadMessages(root)).a).toBe('first');
 } finally {await rm(root,{recursive:true,force:true}); await rm(holder,{recursive:true,force:true});}
});
