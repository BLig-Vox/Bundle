import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./store.ts";
import { workQueue } from "./worker.ts";

test("lost heartbeat stops the owned job without acknowledging another claim",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bundle-queue-owner-"));
  await mkdir(join(root,"queue"),{mode:0o700});
  let now=0;
  const store=new QueueStore(join(root,"queue","jobs.sqlite"),()=>now);
  const controller=new AbortController();
  const marker=join(root,"started");
  let running:Promise<string>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await writeFile(join(root,"job.ts"),`import {writeFileSync} from "node:fs";export async function handle(){writeFileSync(${JSON.stringify(marker)},"yes");await new Promise(()=>{});}`);
    store.enqueue("default",{module:"job.ts",export:"handle",payload:null});
    running=workQueue({root,store,once:true,timeoutMs:10_000,signal:controller.signal}).then(()=>"finished",error=>String(error));
    const deadline=Date.now()+2000;
    while(!await Bun.file(marker).exists()&&Date.now()<deadline)await Bun.sleep(10);
    expect(await Bun.file(marker).exists()).toBe(true);
    now=20_000;
    const result=await Promise.race([running,new Promise<string>(resolve=>{timer=setTimeout(()=>resolve("timed out"),2500);})]);
    expect(result).toContain("ownership was lost");
    const recovered=store.reserve(["default"]);
    expect(recovered?.attempt).toBe(2);
    expect(store.listFailed()).toHaveLength(0);
    if(recovered)expect(store.ack(recovered.receipt)).toBe(true);
  }finally{
    clearTimeout(timer);controller.abort();await running;store.close();await rm(root,{recursive:true,force:true});
  }
},6000);

test("worker persists explicit attempt budget for failed execution",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bundle-queue-budget-"));
  const store=new QueueStore(join(root,"jobs.sqlite"));
  try {
    await writeFile(join(root,"job.ts"),"export function handle(){throw new Error('failure');}");
    store.enqueue("default",{module:"job.ts",export:"handle",payload:null},{maxAttempts:3});
    expect(await workQueue({root,store,once:true,maxAttempts:1})).toEqual({processed:1});
    expect(store.listFailed()).toHaveLength(1);
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test("idle queue cancellation is prompt and leaves a caller-owned store usable",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bundle-queue-idle-"));
  const store=new QueueStore(join(root,"jobs.sqlite"));
  const controller=new AbortController();
  try{
    const running=workQueue({root,store,signal:controller.signal,sleepMs:60_000});
    controller.abort();
    expect(await running).toEqual({processed:0});
    expect(store.enqueue("default",{module:"job.ts",export:"handle",payload:null})).toBeGreaterThan(0);
  }finally{controller.abort();store.close();await rm(root,{recursive:true,force:true});}
});
