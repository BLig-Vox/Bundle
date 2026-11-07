import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './runner.ts';
import { PassThrough, Writable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { createPrompts } from '../console/prompts.ts';
const roots: string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'bundle-schedule-cli-'));roots.push(root);await mkdir(join(root,'src','commands'),{recursive:true});return root;}

test('schedule list metadata and one due failure produce real runner status',async()=>{
 const root=await fixture();const output:string[]=[];const error:string[]=[];
 await writeFile(join(root,'schedule.ts'),`export default [{id:'failing',argv:['report:fail','secret-arg'],expression:'* * * * *'}];`);
 await writeFile(join(root,'src','commands','Fail.ts'),`export default {name:'report:fail',description:'Fail',arguments:[{name:'value'}],handle(){return 9;}};`);
 const ctx={root,env:{DB_CONNECTION:'invalid'},output:(s:string)=>output.push(s),error:(s:string)=>error.push(s)};
 expect(await runCli(['schedule:list','--json','--at','2026-11-07T12:30:00Z'],ctx)).toBe(0);
 expect(JSON.parse(output.join('')).tasks).toMatchObject([{id:'failing',due:true}]);
 expect(output.join('')).not.toContain('secret-arg');output.length=0;
 expect(await runCli(['schedule:run','--at','2026-11-07T12:30:00Z'],ctx)).toBe(1);
 expect(JSON.parse(output.join('')).results).toMatchObject([{id:'failing',outcome:'failed',exitCode:9}]);
});

test('scheduler rejects unsupported dates and work limits before application schedule import',async()=>{
 const root=await fixture();
 await writeFile(join(root,'schedule.ts'),`await Bun.write(${JSON.stringify(join(root,'imported'))},'unsafe side effect');export default [];`);
 for(const args of [['schedule:run','--at','2026-02-30T00:00:00Z'],['schedule:run','--at','2026-11-07T12:30:00+02:00'],['schedule:work','--sleep','0'],['schedule:work','--max-cycles','0']]){
  expect(await runCli(args,{root,output:()=>{},error:()=>{}})).toBe(1);
 }
 expect(await Bun.file(join(root,'imported')).exists()).toBe(false);
});

test('scheduler preserves embedding host signal ownership when handleSignals is false',async()=>{
 const root=await fixture();let hostSignals=0;let emitted=false;
 const host=()=>{hostSignals++;};process.on('SIGTERM',host);
 try {
  const status=await runCli(['schedule:work','--sleep','1','--max-cycles','2'],{root,handleSignals:false,error:()=>{},output:()=>{
   if(!emitted){emitted=true;queueMicrotask(()=>process.emit('SIGTERM'));}
  }});
  expect(status).toBe(0);expect(hostSignals).toBe(1);
 }finally{process.off('SIGTERM',host);}
});

test('schedule:test consumes the embedding host selection adapter and selected failure status',async()=>{
 const root=await fixture();const marker=join(root,'selected');
 await writeFile(join(root,'schedule.ts'),`export default [{id:'first',argv:['report:selected','private-first'],expression:'0 0 31 2 *'},{id:'second',argv:['report:selected','private-second'],expression:'0 0 31 2 *'}];`);
 await writeFile(join(root,'src','commands','Selected.ts'),`export default {name:'report:selected',description:'Selected',arguments:[{name:'value'}],async handle(i:any){await Bun.write(${JSON.stringify(marker)},i.args.value);return 9;}};`);
 const input=Object.assign(new PassThrough(),{isTTY:true});let promptOutput='';const output:string[]=[];
 const prompts=createPrompts({input,output:new Writable({write(chunk,_encoding,callback){promptOutput+=chunk.toString();callback();}})});
 input.end('2\n');
 try{
  expect(await runCli(['schedule:test'],{root,prompts,output:s=>output.push(s),error:()=>{}})).toBe(1);
  expect(await readFile(marker,'utf8')).toBe('private-second');
  expect(JSON.parse(output.join('')).results).toEqual([{id:'second',outcome:'failed',exitCode:9}]);
  expect(promptOutput).toContain('Select a scheduled task');
  expect(promptOutput).not.toMatch(/private-first|private-second/);
 }finally{input.destroy();}
});

test('schedule:test refuses empty registries or cancellation after selection',async()=>{
 const root=await fixture();const controller=new AbortController();let calls=0;
 const prompts={...createPrompts({input:new PassThrough(),output:new Writable({write(_chunk,_encoding,callback){callback();}})}),select:async<T>(options:{options:readonly {value:T}[]})=>{calls++;controller.abort();return options.options[0]!.value;}};
 expect(await runCli(['schedule:test'],{root,prompts,output:()=>{},error:()=>{}})).toBe(1);
 expect(calls).toBe(0);
 await writeFile(join(root,'schedule.ts'),`export default [{id:'chosen',argv:['report:selected'],expression:'* * * * *'}];`);
 await writeFile(join(root,'src','commands','Selected.ts'),`export default {name:'report:selected',description:'Not after cancellation',async handle(){await Bun.write(${JSON.stringify(join(root,'ran'))},'bad');}};`);
 expect(await runCli(['schedule:test'],{root,prompts,signal:controller.signal,output:()=>{},error:()=>{}})).toBe(1);
 expect(calls).toBe(1);expect(await Bun.file(join(root,'ran')).exists()).toBe(false);
});

test('schedule:test rejects an adapter value not in the configured registry',async()=>{
 const root=await fixture();const marker=join(root,'ran');
 await writeFile(join(root,'schedule.ts'),`export default [{id:'configured',argv:['report:selected'],expression:'* * * * *'}];`);
 await writeFile(join(root,'src','commands','Selected.ts'),`export default {name:'report:selected',description:'Not for unknown selection',async handle(){await Bun.write(${JSON.stringify(marker)},'bad');}};`);
 const prompts={...createPrompts({input:new PassThrough(),output:new Writable({write(_chunk,_encoding,callback){callback();}})}),select:async<T>()=>'missing' as T};
 expect(await runCli(['schedule:test'],{root,prompts,output:()=>{},error:()=>{}})).toBe(1);
 expect(await Bun.file(marker).exists()).toBe(false);
});

test('schedule consumers use noninteractive prompts instead of shared stdin',async()=>{
 const root=await fixture();
 await writeFile(join(root,'schedule.ts'),`export default [{id:'prompt',argv:['report:prompt'],expression:'* * * * *'}];`);
 await writeFile(join(root,'src','commands','Prompt.ts'),`export default {name:'report:prompt',description:'Prompt',async handle(_i:any,c:any){await c.prompts.text({message:'private prompt'});await Bun.write(${JSON.stringify(join(root,'prompted'))},'bad');}};`);
 const output:string[]=[];
 expect(await runCli(['schedule:run'],{root,output:s=>output.push(s),error:()=>{}})).toBe(1);
 expect(output.join('')).not.toContain('private prompt');
 expect(await Bun.file(join(root,'prompted')).exists()).toBe(false);
});

test.skipIf(process.platform !== 'linux')('schedule:clear-cache requires force and removes only a verified stale lock',async()=>{
 const root=await fixture();const directory=join(root,'.bundle-command-locks');await mkdir(directory,{mode:0o700});
 const key='schedule:report';const path=join(directory,`${createHash('sha256').update(key).digest('hex')}.lock`);
 await writeFile(path,JSON.stringify({version:1,key,pid:process.pid,pidNamespace:await readlink('/proc/self/ns/pid'),start:'0',token:randomBytes(32).toString('hex')})+'\n',{mode:0o600});
 const output:string[]=[];const context={root,output:(value:string)=>output.push(value),error:()=>{}};
 expect(await runCli(['schedule:clear-cache'],context)).not.toBe(0);
 expect(await Bun.file(path).exists()).toBe(true);
 expect(await runCli(['--force','schedule:clear-cache'],context)).toBe(0);
 expect(JSON.parse(output.at(-1)!)).toEqual({cleared:1,active:0});
 expect(await Bun.file(path).exists()).toBe(false);
});
