import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJobMiddlewareReferences } from "./middleware-definitions.ts";
import { runJobMiddleware } from "./middleware.ts";

test("strict bounded references are copied and reject unsafe shapes", () => {
  const source = [{ module: "src/jobs/Check.ts", export: "Check", method: "handle" }];
  const copy = validateJobMiddlewareReferences(source);
  expect(validateJobMiddlewareReferences(Array(16).fill(source[0]))).toHaveLength(16);
  expect(copy).toEqual(source); expect(copy).not.toBe(source); expect(copy[0]).not.toBe(source[0]);
  for (const value of [new Array(1), Array(17).fill(source[0]), [{...source[0], extra: 1}], [{...source[0], module: "../bad.ts"}], [{...source[0], module: "bad.d.ts"}], [{...source[0], export: "constructor"}], [{...source[0], export: "a".repeat(129)}], [Object.defineProperty({}, "module", {get() { throw Error("getter invoked"); }, enumerable:true})], Object.assign([], {[Symbol()]: 1})]) {
    expect(() => validateJobMiddlewareReferences(value)).toThrow();
  }
});

test("nests middleware and awaits downstream even when next is not awaited", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-job-middleware-"));
  try {
    await writeFile(join(root, "hooks.ts"), `export function outer(ctx, next) { ctx.job.push('outer'); next(); }\nexport class Inner { handle(ctx, next) { ctx.job.push('inner'); return next(); } }`);
    const job: string[] = [];
    await runJobMiddleware({root, references:[{module:"hooks.ts",export:"outer"},{module:"hooks.ts",export:"Inner",method:"handle"}], context:{job,signal:new AbortController().signal}, run:async()=>{ await Bun.sleep(10); job.push("run"); }});
    expect(job).toEqual(["outer", "inner", "run"]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("class instances are fresh and invalid exports or unsafe modules fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-job-middleware-"));
  try {
    await writeFile(join(root,"hooks.ts"), `export class Hook { n = 0; handle(ctx, next) { ctx.job.push(++this.n); return next(); } }\nexport class Base { handle() {} }\nexport class Child extends Base {}\nexport const value = 1;`);
    const job: number[] = []; const context = {job,signal:new AbortController().signal};
    const options = {root,context,run:async()=>{}};
    for (let i = 0; i < 2; i++) await runJobMiddleware({...options,references:[{module:"hooks.ts",export:"Hook",method:"handle"}]});
    expect(job).toEqual([1,1]);
    for (const reference of [{module:"hooks.ts",export:"Child",method:"handle"},{module:"hooks.ts",export:"Hook"},{module:"hooks.ts",export:"value"},{module:"hooks.ts",export:"missing"}]) await expect(runJobMiddleware({...options,references:[reference]})).rejects.toThrow();
    await symlink(join(root,"hooks.ts"),join(root,"link.ts"));
    await expect(runJobMiddleware({...options,references:[{module:"link.ts",export:"Hook"}]})).rejects.toThrow();
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("explicit recovery tracks native promises and nested failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-job-middleware-"));
  try {
    await writeFile(join(root,"hooks.ts"), `export function recover(ctx, next) { const p = next.recover(() => { ctx.job.push('recovered'); }); ctx.job.push(p instanceof Promise); }\nexport function fail() { throw Error('nested'); }\nexport async function caught(_, next) { try { await next(); } catch {} }\nexport function plain(ctx, next) { ctx.job.push(next() instanceof Promise); }\nexport function broken(_, next) { next.recover(() => { throw Error('recovery failed'); }); }\nexport function mixed(_, next) { next(); next.recover(() => {}); }\nexport function mixedReverse(_, next) { next.recover(() => {}); next(); }\nexport function late(ctx, next) { ctx.job.push(next); }`);
    const job: unknown[] = []; const context = {job,signal:new AbortController().signal};
    const ref = (name:string) => [{module:"hooks.ts",export:name}];
    const options = {root,context,run:async()=>{throw Error('job');}};
    await runJobMiddleware({...options,references:ref("recover")});
    await runJobMiddleware({...options,references:[...ref("recover"),...ref("fail")]});
    expect(job).toEqual([true,"recovered",true,"recovered"]);
    await expect(runJobMiddleware({...options,references:ref("caught")})).rejects.toThrow("job");
    await expect(runJobMiddleware({...options,references:ref("broken")})).rejects.toThrow("recovery failed");
    await expect(runJobMiddleware({...options,references:ref("mixed")})).rejects.toThrow("next");
    await expect(runJobMiddleware({...options,references:ref("mixedReverse")})).rejects.toThrow("next");
    await runJobMiddleware({...options,references:ref("plain"),run:async()=>{}});
    expect(job.at(-1)).toBe(true);
    await runJobMiddleware({...options,references:ref("late")});
    const late = job.at(-1) as {():Promise<void>;recover(handler:()=>void):Promise<void>};
    await expect(late()).rejects.toThrow("next");
    await expect(late.recover(()=>{})).rejects.toThrow("next");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("unawaited explicit recovery is awaited to completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-job-middleware-"));
  try {
    await writeFile(join(root,"hooks.ts"), `export function recover(ctx, next) { next.recover(async () => { ctx.job.started(); await ctx.job.gate; }); }`);
    let started!: () => void; const entered = new Promise<void>(resolve=>{started=resolve;});
    let release!: () => void; const gate = new Promise<void>(resolve=>{release=resolve;});
    let finished = false;
    const completion = runJobMiddleware({root,references:[{module:"hooks.ts",export:"recover"}],context:{job:{gate,started},signal:new AbortController().signal},run:async()=>{throw Error("job");}}).then(()=>{finished=true;});
    await entered; expect(finished).toBe(false); release(); await completion; expect(finished).toBe(true);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("short circuit, downstream errors, duplicate next and cancellation propagate", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-job-middleware-"));
  try {
    await writeFile(join(root,"hooks.ts"), `export function stop() {}\nexport function forget(_, next) { next(); }\nexport async function twice(_, next) { await next(); await next(); }`);
    const context = {job:null, signal:new AbortController().signal}; let ran = false;
    const options = {root, context, run:async()=>{ran=true;}};
    await runJobMiddleware({...options,references:[{module:"hooks.ts",export:"stop"}]}); expect(ran).toBe(false);
    await expect(runJobMiddleware({...options,references:[{module:"hooks.ts",export:"forget"}],run:async()=>{throw Error("downstream");}})).rejects.toThrow("downstream");
    await expect(runJobMiddleware({...options,references:[{module:"hooks.ts",export:"twice"}]})).rejects.toThrow("next");
    const controller = new AbortController(); controller.abort();
    await expect(runJobMiddleware({...options,references:[],context:{job:null,signal:controller.signal}})).rejects.toThrow();
    const later = new AbortController();
    await expect(runJobMiddleware({...options,references:[],context:{job:null,signal:later.signal},run:async()=>{later.abort();}})).rejects.toThrow();
  } finally { await rm(root,{recursive:true,force:true}); }
});
