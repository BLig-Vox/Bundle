import { test, expect } from 'bun:test';
import { link, lstat, mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const definitions = pathToFileURL(join(import.meta.dir, '../events/definitions.ts')).href;
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'bundle-event-generation-'));
  await writeFile(join(root, 'events.ts'), `import { defineEvents } from ${JSON.stringify(definitions)};\nexport default defineEvents(${source});\n`);
  return root;
}

test('generates registered listeners and preserves existing files', async () => {
  const root = await fixture(`[{event:'order.created',listeners:[{module:'src/listeners/Orders/Notify.ts',export:'Notify',method:'handle'},{module:'src/listeners/Orders/Notify.ts',export:'Notify',method:'handle'},{module:'other.ts',export:'callback'}]}]`);
  try {
    await writeFile(join(root, 'other.ts'), 'throw new Error("must not import");');
    const { generateRegisteredEventListeners } = await import('./event-generation');
    expect(await generateRegisteredEventListeners(root)).toEqual({created:['src/listeners/Orders/Notify.ts'],existing:['other.ts']});
    const generated = await readFile(join(root, 'src/listeners/Orders/Notify.ts'), 'utf8');
    expect(generated).toContain('export class Notify');
    expect(await generateRegisteredEventListeners(root)).toEqual({created:[],existing:['src/listeners/Orders/Notify.ts','other.ts']});
    expect(await readFile(join(root, 'src/listeners/Orders/Notify.ts'), 'utf8')).toBe(generated);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('preflights unsafe parents, invalid templates, and bounds', async () => {
  const { generateRegisteredEventListeners } = await import('./event-generation');
  const root = await fixture(`[{event:'a',listeners:[{module:'src/listeners/First.ts',export:'First',method:'handle'},{module:'src/listeners/Unsafe/Other.ts',export:'Other',method:'handle'}]}]`);
  try {
    await mkdir(join(root, 'src/listeners'), {recursive:true});
    await symlink(root, join(root, 'src/listeners/Unsafe'));
    await expect(generateRegisteredEventListeners(root)).rejects.toThrow();
    expect(await Bun.file(join(root, 'src/listeners/First.ts')).exists()).toBe(false);
  } finally { await rm(root, {recursive:true,force:true}); }
  const badTemplate = await fixture(`[{event:'a',listeners:[{module:'src/listeners/First.ts',export:'First',method:'handle'}]}]`);
  try {
    await mkdir(join(badTemplate, 'stubs'));
    await writeFile(join(badTemplate, 'stubs/listener.ts.stub'), 'export class {{name}} { invalid syntax ! }');
    await expect(generateRegisteredEventListeners(badTemplate)).rejects.toThrow();
    expect(await Bun.file(join(badTemplate, 'src/listeners/First.ts')).exists()).toBe(false);
  } finally { await rm(badTemplate, {recursive:true,force:true}); }
  const tooMany = await fixture(JSON.stringify(Array.from({length:129}, () => ({event:'a',listeners:[]}))));
  try { await expect(generateRegisteredEventListeners(tooMany)).rejects.toThrow(); }
  finally { await rm(tooMany, {recursive:true,force:true}); }
});

test('uses custom listener stub, ignores cache, and dispatches only when invoked', async () => {
  const { generateRegisteredEventListeners } = await import('./event-generation');
  const { readEventDefinitions } = await import('../events/cache');
  const { hydrateEvents } = await import('../events/definitions');
  const root = await fixture(`[{event:'a',listeners:[{module:'src/listeners/Custom.ts',export:'Custom',method:'handle'}]}]`);
  try {
    await mkdir(join(root, 'stubs'));
    const marker = join(root, 'called');
    await writeFile(join(root, 'stubs/listener.ts.stub'), `import { writeFileSync } from 'node:fs'; export class {{name}} { handle() { writeFileSync(${JSON.stringify(marker)}, 'called'); } }`);
    await mkdir(join(root, 'bootstrap/cache'), {recursive:true});
    const cache = join(root, 'bootstrap/cache/events.json');
    await writeFile(cache, 'stale cache');
    const source = await readFile(join(root, 'events.ts'), 'utf8');
    expect(await generateRegisteredEventListeners(root)).toEqual({created:['src/listeners/Custom.ts'],existing:[]});
    expect(await readFile(cache, 'utf8')).toBe('stale cache');
    expect(await readFile(join(root, 'events.ts'), 'utf8')).toBe(source);
    expect(await Bun.file(marker).exists()).toBe(false);
    const bus = await hydrateEvents(root, await readEventDefinitions(root));
    expect(await Bun.file(marker).exists()).toBe(false);
    await bus.dispatch('a', null);
    expect(await readFile(marker, 'utf8')).toBe('called');
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('missing source refuses and empty source succeeds', async () => {
  const { generateRegisteredEventListeners } = await import('./event-generation');
  const empty = await fixture('[]');
  const missing = await mkdtemp(join(tmpdir(), 'bundle-event-missing-'));
  try {
    expect(await generateRegisteredEventListeners(empty)).toEqual({created:[],existing:[]});
    await expect(generateRegisteredEventListeners(missing)).rejects.toThrow();
  } finally { await rm(empty, {recursive:true,force:true}); await rm(missing, {recursive:true,force:true}); }
});

test('total reference boundary accepts256 deduplicated entries and rejects257 before output',async()=>{
 const {generateRegisteredEventListeners}=await import('./event-generation');
 for(const count of [256,257]){
  const root=await fixture(JSON.stringify([{event:'bounded',listeners:Array.from({length:count},()=>({module:'src/listeners/Bounded.ts',export:'Bounded',method:'handle'}))}]));
  try{
   if(count===256)expect(await generateRegisteredEventListeners(root)).toEqual({created:['src/listeners/Bounded.ts'],existing:[]});
   else{await expect(generateRegisteredEventListeners(root)).rejects.toThrow();expect(await Bun.file(join(root,'src/listeners/Bounded.ts')).exists()).toBe(false);}
  }finally{await rm(root,{recursive:true,force:true});}
 }
});

test('hardlinked or dangling listener files refuse before earlier planned output',async()=>{
 const {generateRegisteredEventListeners}=await import('./event-generation');
 for(const kind of ['hardlink','dangling']){
  const root=await fixture(`[{event:'checked',listeners:[{module:'src/listeners/First.ts',export:'First',method:'handle'},{module:'src/listeners/Unsafe.ts',export:'Unsafe',method:'handle'}]}]`);
  try{
   await mkdir(join(root,'src/listeners'),{recursive:true});
   if(kind==='hardlink'){await writeFile(join(root,'foreign.ts'),'export class Unsafe {}');await link(join(root,'foreign.ts'),join(root,'src/listeners/Unsafe.ts'));}
   else await symlink(join(root,'missing.ts'),join(root,'src/listeners/Unsafe.ts'));
   await expect(generateRegisteredEventListeners(root)).rejects.toThrow();
   expect(await Bun.file(join(root,'src/listeners/First.ts')).exists()).toBe(false);
   const state=await lstat(join(root,'src/listeners/Unsafe.ts'));
   expect(kind==='hardlink'?state.nlink===2:state.isSymbolicLink()).toBe(true);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});

test('preflights every reference before writing', async () => {
  const root = await fixture(`[{event:'a',listeners:[{module:'src/listeners/First.ts',export:'First',method:'handle'},{module:'missing.ts',export:'fn'}]}]`);
  try {
    const { generateRegisteredEventListeners } = await import('./event-generation');
    await expect(generateRegisteredEventListeners(root)).rejects.toThrow();
    expect(await Bun.file(join(root, 'src/listeners/First.ts')).exists()).toBe(false);
  } finally { await rm(root, {recursive:true,force:true}); }
});
