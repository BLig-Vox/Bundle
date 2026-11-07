import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./store.ts";

const job = {module:"job.ts",export:"handle",payload:null};
function fixture(run: (store: QueueStore, advance: (ms:number)=>void)=>void) {
  const root=mkdtempSync(join(tmpdir(),"bundle-policy-")); let now=1000;
  const store=new QueueStore(join(root,"jobs.sqlite"),()=>now);
  try { run(store,ms=>{now+=ms;}); } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
}

test("lower budget fails exhausted eligible job and claims next without execution",()=>fixture((store,advance)=>{
  const first=store.enqueue("a",job,{maxAttempts:3});
  const old=store.reserve(["a"],{leaseMs:10})!; advance(10);
  const second=store.enqueue("a",job);
  const next=store.reserve(["a"],{maxAttempts:1})!;
  expect(next.id).toBe(second); expect(store.listFailed().map(x=>x.id)).toEqual([first]);
  expect(store.ack(old.receipt)).toBe(false);
}));
test("lower budget fails an exhausted ready job and preserves later priority",()=>fixture((store)=>{
  const id=store.enqueue("a",job,{maxAttempts:3}); const first=store.reserve(["a"])!;
  expect(store.settle(first.receipt,{outcome:"failed"})).toBe("released");
  const next=store.enqueue("b",job);
  expect(store.reserve(["a","b"],{maxAttempts:1})?.id).toBe(next);
  expect(store.listFailed().map(row=>row.id)).toEqual([id]);
  expect(store.retry(id)).toBe(true); const retry=store.reserve(["a"])!;
  expect(store.settle(retry.receipt,{outcome:"failed"})).toBe("failed");
}));
test("claim receives a full lease after scanning exhausted backlog",()=>{
  const root=mkdtempSync(join(tmpdir(),"bundle-policy-lease-")); let now=1000; let samples=0; let advancing=false;
  const store=new QueueStore(join(root,"jobs.sqlite"),()=>advancing && ++samples===1 ? 2000 : now);
  try {
    for(let i=0;i<100;i++) store.enqueue("a",job,{maxAttempts:3});
    for(let i=0;i<100;i++) {
      const claim=store.reserve(["a"])!;
      expect(store.settle(claim.receipt,{outcome:"failed",delayMs:1})).toBe("released");
    }
    store.enqueue("a",job);
    now=5000; advancing=true;
    const claim=store.reserve(["a"],{maxAttempts:1,leaseMs:1000})!;
    advancing=false; now=5999;
    expect(store.ack(claim.receipt)).toBe(true);
    expect(store.listFailed()).toHaveLength(100);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
test("clock rollback before publication cannot steal an unexpired receipt",()=>{
  const root=mkdtempSync(join(tmpdir(),"bundle-policy-clock-")); let now=1000; let samples=0; let rollback=false;
  const store=new QueueStore(join(root,"jobs.sqlite"),()=>rollback && ++samples===1 ? 2000 : now);
  try {
    store.enqueue("a",job); const owner=store.reserve(["a"],{leaseMs:500})!;
    rollback=true; expect(store.reserve(["a"],{maxAttempts:1})).toBeNull();
    rollback=false; expect(store.ack(owner.receipt)).toBe(true);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
test("higher budget recovers expired producer-exhausted work and persists",()=>fixture((store,advance)=>{
  store.enqueue("a",job,{maxAttempts:1}); const old=store.reserve(["a"],{leaseMs:10})!; advance(10);
  const recovered=store.reserve(["a"],{maxAttempts:2,leaseMs:10})!;
  expect(recovered.attempt).toBe(2); expect(store.heartbeat(old.receipt)).toBe(false);
  expect(store.settle(recovered.receipt,{outcome:"failed"})).toBe("failed");
}));
test("default crash exhaustion preserves producer policy",()=>fixture((store,advance)=>{
  store.enqueue("a",job,{maxAttempts:1}); store.reserve(["a"],{leaseMs:10}); advance(10);
  expect(store.reserve(["a"])).toBeNull(); expect(store.listFailed()).toHaveLength(1);
}));
test("live, unrelated, and future delayed jobs keep policy",()=>fixture((store,advance)=>{
  store.enqueue("a",job,{maxAttempts:2}); const live=store.reserve(["a"],{leaseMs:100})!;
  store.enqueue("b",job,{maxAttempts:2}); const other=store.reserve(["b"],{leaseMs:10})!;
  store.enqueue("a",job,{maxAttempts:2,availableAt:1100}); advance(10);
  expect(store.reserve(["a"],{maxAttempts:1})).toBeNull();
  expect(store.heartbeat(live.receipt,{leaseMs:100})).toBe(true);
  expect(store.settle(live.receipt,{outcome:"failed"})).toBe("released");
  expect(store.reserve(["b"])?.attempt).toBe(2);
  expect(store.ack(other.receipt)).toBe(false);
  advance(90); const ready=store.reserve(["a"])!;
  expect(ready.attempt).toBe(2); expect(store.settle(ready.receipt,{outcome:"failed"})).toBe("failed");
  const future=store.reserve(["a"])!; expect(store.settle(future.receipt,{outcome:"failed"})).toBe("released");
}));
test("cancellation refunds chosen max-one attempt; retry and backoff retain budget",()=>fixture((store,advance)=>{
  const id=store.enqueue("a",job,{maxAttempts:3}); const first=store.reserve(["a"],{maxAttempts:1})!;
  expect(store.settle(first.receipt,{outcome:"cancelled"})).toBe("released");
  const again=store.reserve(["a"])!; expect(again.attempt).toBe(1);
  expect(store.settle(again.receipt,{outcome:"failed",delayMs:10})).toBe("failed");
  expect(store.retry(id)).toBe(true); const retry=store.reserve(["a"],{maxAttempts:2})!;
  expect(retry.attempt).toBe(1); expect(store.settle(retry.receipt,{outcome:"failed",delayMs:10})).toBe("released");
  expect(store.reserve(["a"])).toBeNull(); advance(10); expect(store.reserve(["a"])?.attempt).toBe(2);
}));
test.each([0,101,1.5,NaN,Infinity])("invalid override %p never claims",value=>fixture(store=>{
  store.enqueue("a",job); expect(()=>store.reserve(["a"],{maxAttempts:value})).toThrow();
  expect(store.reserve(["a"])?.attempt).toBe(1);
}));
