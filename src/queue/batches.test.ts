import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { workQueue } from "./worker.ts";
import { Database } from "bun:sqlite";
import { dispatchBatch } from "./dispatch.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QueueStore } from "./store.ts";

const job = { module: "job.ts", export: "run", payload: null };
test("batch persists acknowledged and failed membership and can retry", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-"));
  let now = 1000;
  const store = new QueueStore(join(root, "queue.sqlite"), () => now);
  try {
    const batch = store.enqueueBatch([{job}, {job, maxAttempts: 1}]);
    expect(store.getBatch(batch.id)?.pending).toBe(2);
    const first = store.reserve(["default"])!;
    expect(store.ack(first.receipt)).toBe(true);
    const second = store.reserve(["default"])!;
    expect(store.settle(second.receipt, {outcome: "failed"})).toBe("failed");
    expect(store.getBatch(batch.id)).toMatchObject({total: 2, pending: 0, succeeded: 1, failed: 1, cancelled: 0, finishedAt: now});
    now++;
    expect(store.retryBatch(batch.id)).toBe(1);
    expect(store.getBatch(batch.id)).toMatchObject({pending: 1, failed: 0, finishedAt: null});
  } finally { store.close(); rmSync(root, {recursive:true, force:true}); }
});

test("cancellation preserves live ownership and reconciles expired work", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-cancel-")); let now = 100;
  const a = new QueueStore(join(root,"queue.sqlite"), () => now), b = new QueueStore(join(root,"queue.sqlite"), () => now);
  try {
    const batch = a.enqueueBatch([{job}, {job}, {job,availableAt:10000}]);
    const live = a.reserve(["default"], {leaseMs:10})!;
    const expired = b.reserve(["default"], {leaseMs:5})!;
    expect(a.cancelBatch(batch.id)).toMatchObject({pending:2,cancelled:1,cancelledAt:100,finishedAt:null});
    now = 105;
    expect(b.getBatch(batch.id)).toMatchObject({pending:1,cancelled:2});
    expect(a.ack(expired.receipt)).toBe(false);
    expect(b.reserve(["default"])).toBeNull();
    expect(a.settle(live.receipt,{outcome:"failed"})).toBe("cancelled");
    expect(b.getBatch(batch.id)).toMatchObject({pending:0,cancelled:3,finishedAt:105});
    expect(() => a.retryBatch(batch.id)).toThrow();
  } finally { a.close(); b.close(); rmSync(root,{recursive:true,force:true}); }
});

test("clear, forgotten failures, individual retry, and pruning preserve history", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-history-")); let now = 100;
  const store = new QueueStore(join(root,"queue.sqlite"), () => now);
  try {
    const batch = store.enqueueBatch([{job,maxAttempts:1}, {job,maxAttempts:1}, {job}]);
    const first = store.reserve(["default"])!, second = store.reserve(["default"])!;
    expect(store.fail(first.receipt,"error")).toBe(true);
    expect(store.settle(second.receipt,{outcome:"failed"})).toBe("failed");
    expect(store.forgetFailed(first.id)).toBe(true);
    expect(store.clear("default")).toBe(1);
    expect(store.getBatch(batch.id)).toMatchObject({pending:0,failed:2,cancelled:1,finishedAt:100});
    expect(store.retry(second.id)).toBe(true);
    expect(store.getBatch(batch.id)).toMatchObject({pending:1,failed:1,finishedAt:null});
    const again = store.reserve(["default"])!;
    now = 101; expect(store.fail(again.receipt,"error")).toBe(true);
    expect(store.pruneBatches({before:101})).toBe(0);
    expect(store.pruneBatches({before:102})).toBe(1);
    expect(store.getBatch(batch.id)).toBeNull();
    expect(store.retry(second.id)).toBe(true);
    expect(store.reserve(["default"])?.id).toBe(second.id);
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});

test("verified v1 needs explicit upgrade and preserves raw jobs", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-upgrade-")), path = join(root,"queue.sqlite");
  const db = new Database(path); chmodSync(path,0o600);
  db.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, job TEXT NOT NULL, available INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, receipt TEXT, lease INTEGER, reason TEXT, failed_at INTEGER)");
  db.exec("PRAGMA application_id=1112626501; PRAGMA user_version=1");
  db.query("INSERT INTO jobs(queue,job,available,attempts,max_attempts) VALUES('default','not json',0,0,3)").run(); db.close();
  try {
    expect(() => new QueueStore(path)).toThrow("upgrade required");
    const store = new QueueStore(path, () => 100, {upgrade:true});
    try { expect(store.reserve(["default"])?.job).toBeNull(); } finally { store.close(); }
    const reopened = new QueueStore(path); reopened.close();
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("signal cancellation refunds attempts and live success after batch cancellation remains successful", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-signal-")); let now = 100;
  const store = new QueueStore(join(root,"queue.sqlite"), () => now);
  try {
    const batch = store.enqueueBatch([{job,maxAttempts:1}]);
    const first = store.reserve(["default"],{leaseMs:50})!;
    expect(store.settle(first.receipt,{outcome:"cancelled"})).toBe("released");
    expect(store.getBatch(batch.id)).toMatchObject({pending:1,cancelled:0});
    const next = store.reserve(["default"],{leaseMs:50})!;
    expect(next.attempt).toBe(1);
    expect(store.cancelBatch(batch.id)).toMatchObject({pending:1});
    now = 90;
    expect(store.ack(next.receipt)).toBe(true);
    expect(store.getBatch(batch.id)).toMatchObject({pending:0,succeeded:1,cancelled:0,finishedAt:90});
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});

test("invalid batch records, accessors, holes and size limits publish nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-invalid-")), path = join(root,"queue.sqlite");
  const store = new QueueStore(path), db = new Database(path);
  try {
    const sparse = Array(1) as {job:typeof job}[];
    const getter = Object.defineProperty({}, "job", {enumerable:true,get(){throw new Error("getter executed");}});
    const extra = {job, unexpected:true};
    const huge = Array.from({length:17}, () => ({job:{...job,payload:"x".repeat(63000)}}));
    for (const entries of [[], sparse, [getter], [extra], huge, Array.from({length:129},()=>({job}))]) {
      expect(() => store.enqueueBatch(entries as never)).toThrow();
    }
    expect((db.query("SELECT count(*) AS n FROM jobs").get() as {n:number}).n).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM batches").get() as {n:number}).n).toBe(0);
  } finally { db.close(); store.close(); rmSync(root,{recursive:true,force:true}); }
});

test("batch publication rolls back completely on database write failure", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-rollback-")), path = join(root, "queue.sqlite");
  const store = new QueueStore(path); const db = new Database(path);
  try {
    db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON batch_members WHEN NEW.job_id=2 BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => store.enqueueBatch([{job},{job}])).toThrow();
    expect((db.query("SELECT count(*) AS n FROM jobs").get() as {n:number}).n).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM batches").get() as {n:number}).n).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM batch_members").get() as {n:number}).n).toBe(0);
    db.exec("DROP TRIGGER reject_second");
  } finally { db.close(); store.close(); rmSync(root,{recursive:true,force:true}); }
});

test("exhaustion and failed-history deletion retain truthful batch counts", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-exhaust-")); let now = 100;
  const store = new QueueStore(join(root,"queue.sqlite"), () => now);
  try {
    const batch = store.enqueueBatch([{job,maxAttempts:1},{job,maxAttempts:1}]);
    const first = store.reserve(["default"],{leaseMs:5})!;
    now = 105;
    const second = store.reserve(["default"],{leaseMs:5})!;
    expect(first.id).not.toBe(second.id);
    expect(store.ack(first.receipt)).toBe(false);
    expect(store.fail(second.receipt,"error")).toBe(true);
    expect(store.flushFailed({all:true})).toBe(2);
    expect(store.getBatch(batch.id)).toMatchObject({failed:2,pending:0,finishedAt:105});
    expect(store.retryBatch(batch.id)).toBe(0);
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});

test("worker reports cancelled settlement when a cancelled batch's active handler fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-live-worker-"));
  const store = new QueueStore(join(root,"queue.sqlite"));
  const marker = join(root,"started"), release = join(root,"release");
  let running: Promise<{processed: number}> | undefined;
  try {
    writeFileSync(join(root,"job.ts"), `import {writeFileSync,existsSync} from 'node:fs'; export async function run(){writeFileSync(${JSON.stringify(marker)},'1'); while(!existsSync(${JSON.stringify(release)})) await Bun.sleep(5); throw new Error('failed');}`);
    const batch = store.enqueueBatch([{job}]); const results: string[] = [];
    running = workQueue({root,store,once:true,onResult:result=>{results.push(result.settlement);}});
    const deadline = Date.now()+5000;
    while (!await Bun.file(marker).exists() && Date.now()<deadline) await Bun.sleep(5);
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(store.cancelBatch(batch.id)?.pending).toBe(1);
    writeFileSync(release,"1");
    await running;
    expect(results).toEqual(["cancelled"]);
    expect(store.getBatch(batch.id)).toMatchObject({pending:0,cancelled:1});
  } finally { writeFileSync(release,"1"); await running?.catch(() => {}); store.close(); rmSync(root,{recursive:true,force:true}); }
}, 10000);

test("real worker executes mixed module and command batch and persists successes", async () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-worker-"));
  const store = new QueueStore(join(root,"queue.sqlite"));
  try {
    writeFileSync(join(root,"job.ts"), "export function run() {};");
    const batch = store.enqueueBatch([{job}, {job:{kind:"command",version:1,argv:["list"]}}]);
    expect(await workQueue({root,store,stopWhenEmpty:true})).toEqual({processed:2});
    expect(store.getBatch(batch.id)).toMatchObject({pending:0,succeeded:2,failed:0,cancelled:0});
    store.close();
    const reopened = new QueueStore(join(root,"queue.sqlite"));
    try { expect(reopened.getBatch(batch.id)).toMatchObject({total:2,succeeded:2}); } finally { reopened.close(); }
  } finally { try { store.close(); } catch {} rmSync(root,{recursive:true,force:true}); }
});

test("dispatch snapshots entries before async work and rejects invalid batches before storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-dispatch-"));
  try {
    await expect(dispatchBatch({root,jobs:[]})).rejects.toThrow();
    const entries = [{job:{module:"job.ts",export:"run",payload:{value:1}}}];
    const pending = dispatchBatch({root,jobs:entries}); entries[0]!.job.payload.value = 2;
    const batch = await pending;
    const store = new QueueStore(join(root,".bundle-queue","queue.sqlite"));
    try { expect(store.reserve(["default"])?.job).toEqual({module:"job.ts",export:"run",payload:{value:1}}); expect(store.getBatch(batch.id)?.total).toBe(1); }
    finally { store.close(); }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
