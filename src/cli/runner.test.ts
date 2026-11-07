import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationCli, runCli } from "./runner.ts";
import { LifecycleRegistry } from "../console/command.ts";
import { ServiceContainer } from "../console/services.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture(source?: string) {
  const root = await mkdtemp(join(tmpdir(), "bundle-runner-"));
  roots.push(root);
  if (source) {
    const dir = join(root, "src", "commands");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "fixture.ts"), source);
  }
  const out: string[] = [], err: string[] = [];
  return { root, out, err, context: { root, env: { DB_PASSWORD: "secret-value" }, output: (s: string) => out.push(s), error: (s: string) => err.push(s) } };
}
const source = `export default { name: "example:run", description: "Example runtime", arguments: [{name: "value"}], async handle({args}, {output}) { output(args.value); return 23; } };`;

test("application providers boot before command imports once across nested calls and dispose in ownership order", async () => {
  const f = await fixture();
  const events = join(f.root, "provider-events");
  const booted = join(f.root, "provider-booted");
  await writeFile(join(f.root, "Provider.ts"), `import {appendFile} from 'node:fs/promises';const log=(s:string)=>appendFile(${JSON.stringify(events)},s+'\\n');export class Provider {async register(c:any){await log('register');c.container.register('message','singleton',()=>({text:'ready',dispose(){return log('singleton-dispose');}}));let n=0;c.container.register('scoped','scoped',()=>{const id=++n;return {dispose(){return log('scope-'+id);}};});}async boot(){await log('boot');await Bun.write(${JSON.stringify(booted)},'ready');}dispose(){return log('provider-dispose');}}`);
  await writeFile(join(f.root, "providers.ts"), `export default [{module:'Provider.ts',export:'Provider'}];`);
  await mkdir(join(f.root, "src/commands"), {recursive:true});
  await writeFile(join(f.root, "src/commands/Commands.ts"), `if(!await Bun.file(${JSON.stringify(booted)}).exists())throw Error('command imported before boot');export const outer={name:'outer',description:'Outer',async handle(_i:any,c:any){c.services.resolve('scoped');c.output(c.services.resolve('message').text);return c.call(['inner']);}};export const inner={name:'inner',description:'Inner',handle(_i:any,c:any){c.services.resolve('scoped');c.output(c.services.resolve('message').text);}};`);
  expect(await runCli(["outer"], f.context)).toBe(0);
  expect(f.out).toEqual(["ready", "ready"]);
  expect((await readFile(events,"utf8")).trim().split('\n')).toEqual(["register","boot","scope-2","scope-1","provider-dispose","singleton-dispose"]);
});

test("failed provider boot cleans instances and prevents trusted command imports", async () => {
  const f = await fixture(`await Bun.write(import.meta.dir+'/imported','bad');export default {name:'unexpected',description:'No',handle(){}};`);
  await writeFile(join(f.root,"Provider.ts"), `export class Provider {register(){}boot(){throw Error('private-provider-value');}async dispose(){await Bun.write(${JSON.stringify(join(f.root,'disposed'))},'yes');}}`);
  await writeFile(join(f.root,"providers.ts"), `export default [{module:'Provider.ts',export:'Provider'}];`);
  expect(await runCli(["--version"], f.context)).toBe(1);
  expect(await Bun.file(join(f.root,'src/commands/imported')).exists()).toBe(false);
  expect(await Bun.file(join(f.root,'disposed')).exists()).toBe(true);
  expect(f.err.join(' ')).not.toContain('private-provider-value');
  expect(f.out).toEqual([]);
});

test("automatic providers refuse caller-owned containers without importing or mutating them", async () => {
  const f=await fixture();const container=new ServiceContainer();
  container.register('host','singleton',()=>({value:42}));
  await writeFile(join(f.root,'Provider.ts'),`await Bun.write(${JSON.stringify(join(f.root,'imported'))},'bad');export class Provider {register(c:any){c.container.register('unexpected','singleton',()=>1);}}`);
  await writeFile(join(f.root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
  try {
    expect(await runCli(['--version'],{...f.context,container})).toBe(1);
    expect(await Bun.file(join(f.root,'imported')).exists()).toBe(false);
    const scope=container.createScope();
    expect(scope.resolve<{value:number}>('host').value).toBe(42);
    expect(()=>scope.resolve('unexpected')).toThrow('Missing service');
    await scope.dispose();
  } finally {await container.dispose();}
});

test("provider disposal failure still releases owned singleton resources with generic errors",async()=>{
  const f=await fixture(`export default {name:'provided',description:'Provided',handle(_i:any,c:any){c.services.resolve('resource');}};`);
  await writeFile(join(f.root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
  await writeFile(join(f.root,'Provider.ts'),`export class Provider {register(c:any){c.container.register('resource','singleton',()=>({dispose(){return Bun.write(${JSON.stringify(join(f.root,'service-disposed'))},'yes');}}));}dispose(){throw Error('private-dispose-value');}}`);
  expect(await runCli(['provided'],f.context)).toBe(1);
  expect(await Bun.file(join(f.root,'service-disposed')).exists()).toBe(true);
  expect(f.err.join(' ')).toContain('provider disposal failed');
  expect(f.err.join(' ')).not.toContain('private-dispose-value');
});

test('provider boot observes runner signal ownership and prevents command import on cancellation',async()=>{
  for(const handleSignals of [true,false]){
    const f=await fixture(`await Bun.write(import.meta.dir+'/imported','yes');export default {name:'provided',description:'Provided',handle(){}};`);
    await writeFile(join(f.root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
    await writeFile(join(f.root,'Provider.ts'),`export class Provider {register(){}async boot(){process.emit('SIGTERM');await Promise.resolve();}dispose(){return Bun.write(${JSON.stringify(join(f.root,'disposed'))},'yes');}}`);
    let hostSignals=0;const host=()=>{hostSignals++;};const before=process.listenerCount('SIGTERM');process.on('SIGTERM',host);
    try {
      expect(await runCli(['provided'],{...f.context,handleSignals})).toBe(handleSignals?143:0);
      expect(await Bun.file(join(f.root,'src/commands/imported')).exists()).toBe(!handleSignals);
      expect(await Bun.file(join(f.root,'disposed')).exists()).toBe(true);
      expect(hostSignals).toBe(1);
      expect(process.listenerCount('SIGTERM')).toBe(before+1);
    } finally {process.off('SIGTERM',host);}
  }
});

test('a throwing handler error sink cannot skip scope cleanup before provider disposal',async()=>{
 const f=await fixture(`export default {name:'provided',description:'Provided',handle(_i:any,c:any){c.services.resolve('resource');throw Error('command failed');}};`);
 const events=join(f.root,'cleanup-events');const lifecycle:string[]=[];
 await writeFile(join(f.root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
 await writeFile(join(f.root,'Provider.ts'),`import {appendFile} from 'node:fs/promises';const log=(s:string)=>appendFile(${JSON.stringify(events)},s+'\\n');export class Provider {register(c:any){c.container.register('resource','scoped',()=>({dispose(){return log('scope');}}));}dispose(){return log('provider');}}`);
 await expect(runCli(['provided'],{...f.context,onLifecycle(event){lifecycle.push(event.phase);},error(){throw Error('sink failed');}})).rejects.toThrow('sink failed');
 expect((await readFile(events,'utf8')).trim().split('\n')).toEqual(['scope','provider']);
 expect(lifecycle).toEqual(['start','finish']);
});

test('a throwing cleanup error sink cannot prevent owned container disposal',async()=>{
 const f=await fixture(`export default {name:'provided',description:'Provided',handle(_i:any,c:any){c.services.resolve('resource');}};`);
 await writeFile(join(f.root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
 await writeFile(join(f.root,'Provider.ts'),`export class Provider {register(c:any){c.container.register('resource','singleton',()=>({dispose(){return Bun.write(${JSON.stringify(join(f.root,'service-disposed'))},'yes');}}));}dispose(){throw Error('private-dispose-value');}}`);
 await expect(runCli(['provided'],{...f.context,error(){throw Error('sink failed');}})).rejects.toThrow('sink failed');
 expect(await Bun.file(join(f.root,'service-disposed')).exists()).toBe(true);
});

test('runner retains signal handling through provider and singleton disposal',async()=>{
 for(const phase of ['provider','service']){
  const f=await fixture(`export default {name:'provided',description:'Provided',handle(_i:any,c:any){c.services.resolve('resource');}};`);
  await writeFile(join(f.root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
  await writeFile(join(f.root,'Provider.ts'),`let signal:AbortSignal;export class Provider {register(c:any){signal=c.signal;c.container.register('resource','singleton',()=>({async dispose(){${phase==='service'?"process.emit('SIGTERM');":""}await Bun.write(${JSON.stringify(join(f.root,'service-disposed'))},String(signal.aborted));}}));}async dispose(){${phase==='provider'?"process.emit('SIGTERM');":""}await Bun.write(${JSON.stringify(join(f.root,'provider-disposed'))},String(signal.aborted));}}`);
  let hostSignals=0;const host=()=>{hostSignals++;};const before=process.listenerCount('SIGTERM');process.on('SIGTERM',host);
  try {
   expect(await runCli(['provided'],f.context)).toBe(143);
   expect(hostSignals).toBe(1);
   expect(await readFile(join(f.root,'service-disposed'),'utf8')).toBe('true');
   expect(await readFile(join(f.root,'provider-disposed'),'utf8')).toBe(phase==='provider'?'true':'false');
   expect(process.listenerCount('SIGTERM')).toBe(before+1);
  }finally{process.off('SIGTERM',host);}
 }
});

test('build-only application CLI does not automatically bootstrap providers',async()=>{
 const f=await fixture(source);
 await writeFile(join(f.root,'providers.ts'),`throw Error('build-only must not import provider registry');export default [];`);
 const cli=await createApplicationCli(f.context);
 expect(cli.commands.some(command=>command.name()==='example:run')).toBe(true);
});

test('package discovery cancellation during trusted source import refuses publication and preserves prior metadata',async()=>{
 for(const previous of [false,true]){
  const f=await fixture();const controller=new AbortController();const key='package-import-'+crypto.randomUUID();
  const global=globalThis as unknown as Record<string,unknown>;global[key]=()=>controller.abort();
  const cache=join(f.root,'bootstrap/cache/packages.json');const old=JSON.stringify({version:1,packages:[]})+'\n';
  if(previous){await mkdir(join(f.root,'bootstrap/cache'),{recursive:true});await writeFile(cache,old,{mode:0o600});}
  await writeFile(join(f.root,'packages.ts'),`(globalThis as any)[${JSON.stringify(key)}]();await Promise.resolve();export default [{name:'new-metadata',providers:[]}];`);
  try{
   expect(await runCli([...(previous?['--force']:[]),'package:discover'],{...f.context,handleSignals:false,signal:controller.signal})).toBe(1);
   expect(controller.signal.aborted).toBe(true);
   if(previous)expect(await readFile(cache,'utf8')).toBe(old);else expect(await Bun.file(cache).exists()).toBe(false);
  }finally{delete global[key];}
 }
});

test('cached package bootstrap retains caller-container and pre-abort ownership boundaries',async()=>{
 for(const mode of ['caller','cancelled']){
  const f=await fixture();const container=new ServiceContainer();const controller=new AbortController();
  await mkdir(join(f.root,'bootstrap/cache'),{recursive:true});
  await writeFile(join(f.root,'bootstrap/cache/packages.json'),JSON.stringify({version:1,packages:[{name:'local',providers:[{module:'Provider.ts',export:'Provider'}]}]})+'\n',{mode:0o600});
  await writeFile(join(f.root,'Provider.ts'),`await Bun.write(${JSON.stringify(join(f.root,'provider-imported'))},'bad');export class Provider {register(){}}`);
  if(mode==='cancelled')controller.abort();
  try{
   expect(await runCli(['--version'],{...f.context,...(mode==='caller'?{container}:{signal:controller.signal})})).toBe(1);
   expect(await Bun.file(join(f.root,'provider-imported')).exists()).toBe(false);
   container.register('still-owned','singleton',()=>true);
  }finally{await container.dispose();}
 }
});

test("nested calls use fresh parsers, scoped services, lifecycle events, and exact status", async () => {
  const f = await fixture(`export const outer = {name: "outer", description: "Outer", async handle(_, ctx) { ctx.output(String(await ctx.call(["inner", "nested"]))); }}; export const inner = {name: "inner", description: "Inner", arguments: [{name:"value"}], async handle({args}, ctx) { ctx.output(args.value); ctx.output(String(!!ctx.services && !!ctx.signal)); return 23; }};`);
  const events: string[] = [];
  expect(await runCli(["outer"], { ...f.context, onLifecycle: event => { events.push(`${event.phase}:${event.args[0]}${event.phase === "finish" ? `:${event.status}` : ""}`); } })).toBe(0);
  expect(f.out).toEqual(["nested", "true", "23"]);
  expect(events).toEqual(["start:outer", "start:inner", "finish:inner:23", "finish:outer:0"]);
});

test("nested recursion is bounded and parent cancellation reaches children", async () => {
  const f = await fixture(`export default {name: "recurse", description: "Recurse", async handle(_, ctx) { if (ctx.signal.aborted) { ctx.output("aborted"); return 7; } return await ctx.call(["recurse"]); }};`);
  expect(await runCli(["recurse"], { ...f.context, maxCallDepth: 2 })).toBe(1);
  expect(f.err.join(" ")).toContain("depth");
  const controller = new AbortController(); controller.abort();
  expect(await runCli(["recurse"], { ...f.context, signal: controller.signal })).toBe(7);
  expect(f.out).toContain("aborted");
});

test("runner disposes nested scopes before parent scope and reports disposal failure", async () => {
  const f = await fixture(`export const outer = {name:"outer", description:"Outer", async handle(_, ctx) { ctx.services.resolve("resource"); return ctx.call(["inner"]); }}; export const inner = {name:"inner", description:"Inner", async handle(_, ctx) { ctx.services.resolve("resource"); }};`);
  const container = new ServiceContainer();
  const disposed: number[] = []; let id = 0;
  container.register("resource", "scoped", () => { const current = ++id; return { async dispose() { disposed.push(current); if (current === 2) throw Error("cleanup failed"); } }; });
  expect(await runCli(["outer"], { ...f.context, container })).toBe(1);
  expect(disposed).toEqual([2, 1]);
  expect(f.err.join(" ")).toContain("Service disposal failed");
  await container.dispose();
});

test("async lifecycle failures are reported and finish follows a failed handler", async () => {
  const f = await fixture(`export default {name:"broken", description:"Broken", async handle() { throw Error("handler failed"); }};`);
  const events: string[] = [];
  expect(await runCli(["broken"], { ...f.context, async onLifecycle(event) { events.push(event.phase); if (event.phase === "finish") throw Error("listener failed"); } })).toBe(1);
  expect(events).toEqual(["start", "finish"]);
  expect(f.err.join(" ")).toContain("handler failed");
  expect(f.err.join(" ")).toContain("listener failed");
});

test("parent abort is delivered to an active nested command", async () => {
  const f = await fixture(`export const outer = {name:"outer", description:"Outer", async handle(_, ctx) { return ctx.call(["inner"]); }}; export const inner = {name:"inner", description:"Inner", async handle(_, ctx) { ctx.output("ready"); await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, {once:true})); ctx.output("aborted"); return 17; }};`);
  const controller = new AbortController();
  expect(await runCli(["outer"], { ...f.context, signal: controller.signal, output: text => { f.out.push(text); if (text === "ready") queueMicrotask(() => controller.abort()); } })).toBe(17);
  expect(f.out).toEqual(["ready", "aborted"]);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`process ${signal} reaches nested handler and listeners are removed`, async () => {
    const f = await fixture(`export const outer = {name:"outer", description:"Outer", async handle(_, ctx) { return ctx.call(["inner"]); }}; export const inner = {name:"inner", description:"Inner", async handle(_, ctx) { ctx.output("ready"); await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, {once:true})); return 19; }};`);
    const host = join(f.root, "host.ts");
    await writeFile(host, `import { runCli } from ${JSON.stringify(new URL("./runner.ts", import.meta.url).href)}; const before = process.listenerCount(${JSON.stringify(signal)}); const status = await runCli(["outer"], {root:${JSON.stringify(f.root)}}); console.log("listeners=" + (process.listenerCount(${JSON.stringify(signal)}) - before)); process.exitCode = status;`);
    const child = Bun.spawn([process.execPath, host], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    child.kill(signal);
    let rest = "";
    for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
    expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
    expect(rest).toContain("listeners=0");
    expect(await new Response(child.stderr).text()).toBe("");
  });
}

test("builder discovers commands and list/help include them", async () => {
  const f = await fixture(source);
  const program = await createApplicationCli(f.context);
  expect(program.commands.some(command => command.name() === "example:run")).toBe(true);
  expect(await runCli(["list"], f.context)).toBe(0);
  expect(f.out.join("\n")).toContain("example:run");
  expect(await runCli(["example:run", "--help"], f.context)).toBe(0);
  expect(f.out.join("\n")).toContain("Example runtime");
});

test("runner returns exact handler status without changing process state", async () => {
  const f = await fixture(source);
  const before = process.exitCode;
  expect(await runCli(["example:run", "hello"], f.context)).toBe(23);
  expect(f.out).toContain("hello");
  expect(process.exitCode).toBe(before);
});

test("parser errors use injected error sink; missing directory is supported", async () => {
  const f = await fixture();
  expect(await runCli(["--version"], f.context)).toBe(0);
  expect(await runCli(["--not-an-option"], f.context)).toBe(1);
  expect(f.err.join("\n")).toContain("unknown option");
});

test("a Bun process can translate the runner result to its exit status", async () => {
  const f = await fixture(source);
  const host = join(f.root, "host.ts");
  await writeFile(host, `import { runCli } from ${JSON.stringify(new URL("./runner.ts", import.meta.url).href)};\nprocess.exitCode = await runCli(process.argv.slice(2), { root: ${JSON.stringify(f.root)} });`);
  const child = Bun.spawn([process.execPath, host, "example:run", "process-value"], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(23);
  expect(stdout).toContain("process-value");
  expect(stderr).toBe("");
});

test("runner redacts handler failures and reports collisions", async () => {
  const f = await fixture(`export default {name: "broken", description: "Broken", handle() { throw new Error("password secret-value"); }};`);
  expect(await runCli(["broken"], f.context)).toBe(1);
  expect(f.err.join("\n")).toContain("[redacted]");
  expect(f.err.join("\n")).not.toContain("secret-value");
  const collision = await fixture(`export default {name: "list", description: "Collision", handle() {}};`);
  expect(await runCli([], collision.context)).toBe(1);
  expect(collision.err.join("\n")).toContain("conflicts");
});

test("SIGTERM during start prevents version parsing and preserves signal status", async () => {
  const f = await fixture();
  const status = await runCli(["--version"], {...f.context, async onLifecycle(event) { if (event.phase === "start") { process.emit("SIGTERM"); await Promise.resolve(); } }});
  expect(status).toBe(143); expect(f.out).toEqual([]);
});

test("lifecycle registry orders listeners, supports unsubscribe and continues after errors", async () => {
  const f = await fixture(); const lifecycle = new LifecycleRegistry(); const events: string[] = [];
  lifecycle.subscribe(event => { events.push(`a:${event.phase}`); if (event.phase === "start") throw Error("listener failure"); });
  const unsubscribe = lifecycle.subscribe(event => { events.push(`removed:${event.phase}`); }); unsubscribe();
  lifecycle.subscribe(async event => { events.push(`b:${event.phase}`); });
  expect(await runCli(["--version"], {...f.context, lifecycle})).toBe(1);
  expect(events).toEqual(["a:start", "b:start", "a:finish", "b:finish"]);
  expect(f.err.join(" ")).toContain("listener failure"); expect(f.out).toEqual([]);
});

test("duplicate lifecycle subscriptions unsubscribe independently", async () => {
  const registry = new LifecycleRegistry(); let calls = 0; const listener = () => { calls++; };
  const first = registry.subscribe(listener); registry.subscribe(listener); first(); first();
  await registry.emit({phase:"start", args:[]}); expect(calls).toBe(1);
});
