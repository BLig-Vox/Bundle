import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./store.ts";

const job = {module:"job.ts", export:"handle", payload:null};

for (const exhausted of [false, true]) {
  test(`batch reserve clock rollback preserves live receipt, ${exhausted ? "exhausted" : "claim"} branch`, () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-batch-clock-"));
    let rollback = false, samples = 0;
    const store = new QueueStore(join(root,"queue.sqlite"), () => rollback && ++samples === 1 ? 2000 : 1000);
    try {
      const batch = store.enqueueBatch([{job,maxAttempts:2}]);
      const owner = store.reserve(["default"],{leaseMs:500})!;
      rollback = true;
      expect(store.reserve(["default"],{maxAttempts:exhausted ? 1 : 2})).toBeNull();
      expect(samples).toBeGreaterThanOrEqual(2);
      rollback = false;
      expect(store.getBatch(batch.id)).toMatchObject({pending:1,failed:0,succeeded:0,finishedAt:null});
      expect(store.listFailed()).toHaveLength(0);
      expect(store.heartbeat(owner.receipt,{leaseMs:500})).toBe(true);
      expect(store.ack(owner.receipt)).toBe(true);
      expect(store.getBatch(batch.id)).toMatchObject({pending:0,succeeded:1,failed:0});
    } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
  });
}

type Operation = "ack" | "settle" | "clear" | "retry" | "retryBatch";
for (const operation of ["ack", "settle", "clear", "retry", "retryBatch"] as const satisfies readonly Operation[]) {
  test(`${operation} rolls back job, member and batch changes on SQLite failure`, () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-batch-tx-")), path = join(root,"queue.sqlite");
    let now = 1000;
    const store = new QueueStore(path, () => now), db = new Database(path);
    try {
      const batch = store.enqueueBatch([{job,maxAttempts:1}]);
      const claim = operation === "clear" ? null : store.reserve(["default"],{leaseMs:500})!;
      if (operation === "retry" || operation === "retryBatch") {
        expect(store.fail(claim!.receipt,"failure")).toBe(true);
        now++;
      }
      const snapshot = () => ({
        jobs: db.query("SELECT * FROM jobs ORDER BY id").all(),
        members: db.query("SELECT * FROM batch_members ORDER BY job_id").all(),
        batches: db.query("SELECT * FROM batches ORDER BY id").all(),
      });
      const before = snapshot();
      // Abort after preceding transaction writes, rather than altering the stored data.
      const trigger = operation === "retry" ? "BEFORE UPDATE ON batch_members WHEN NEW.state='pending'"
        : operation === "retryBatch" ? "BEFORE UPDATE ON batches WHEN NEW.finished_at IS NULL"
        : "BEFORE UPDATE ON batches WHEN NEW.finished_at IS NOT NULL";
      db.exec(`CREATE TRIGGER injected_failure ${trigger} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      try {
        expect(() => {
          switch (operation) {
            case "ack": store.ack(claim!.receipt); break;
            case "settle": store.settle(claim!.receipt,{outcome:"failed"}); break;
            case "clear": store.clear("default"); break;
            case "retry": store.retry(batch.jobIds[0]!); break;
            case "retryBatch": store.retryBatch(batch.id); break;
          }
        }).toThrow("injected failure");
        expect(snapshot()).toEqual(before);
      } finally { db.exec("DROP TRIGGER injected_failure"); }
      store.close(); db.close();
      const reopened = new QueueStore(path, () => now);
      try {
        expect(reopened.getBatch(batch.id)).toMatchObject(operation.startsWith("retry")
          ? {pending:0,failed:1,finishedAt:1000}
          : {pending:1,failed:0,cancelled:0,finishedAt:null});
        if (claim && !operation.startsWith("retry")) expect(reopened.ack(claim.receipt)).toBe(true);
      } finally { reopened.close(); }
    } finally {
      try { db.close(); } catch {}
      try { store.close(); } catch {}
      rmSync(root,{recursive:true,force:true});
    }
  });
}

test("failure, retry, cancelled lease reconciliation and pruned failure history survive reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-batch-reopen-")), path = join(root,"queue.sqlite");
  let now = 1000, store = new QueueStore(path, () => now);
  try {
    const failed = store.enqueueBatch([{job,maxAttempts:1},{job,maxAttempts:1}]);
    const first = store.reserve(["default"],{leaseMs:10})!, second = store.reserve(["default"],{leaseMs:10})!;
    expect(store.fail(first.receipt,"failure")).toBe(true);
    expect(store.fail(second.receipt,"failure")).toBe(true);
    store.close(); store = new QueueStore(path, () => now);
    expect(store.getBatch(failed.id)).toMatchObject({pending:0,failed:2,finishedAt:1000});
    expect(store.retry(first.id)).toBe(true);
    store.close(); store = new QueueStore(path, () => now);
    expect(store.getBatch(failed.id)).toMatchObject({pending:1,failed:1,finishedAt:null});
    expect(store.pruneFailed({all:true,before:1001})).toBe(1);
    store.close(); store = new QueueStore(path, () => now);
    expect(store.getBatch(failed.id)).toMatchObject({pending:1,failed:1});
    expect(store.retryBatch(failed.id)).toBe(0);
    const again = store.reserve(["default"],{leaseMs:10})!;
    expect(store.ack(again.receipt)).toBe(true);
    const cancelled = store.enqueueBatch([{job}]);
    const live = store.reserve(["default"],{leaseMs:10})!;
    expect(store.cancelBatch(cancelled.id)).toMatchObject({pending:1,cancelled:0,cancelledAt:1000});
    store.close(); now = 1010; store = new QueueStore(path, () => now);
    expect(store.getBatch(cancelled.id)).toMatchObject({pending:0,cancelled:1,finishedAt:1010});
    expect(store.ack(live.receipt)).toBe(false);
    store.close(); store = new QueueStore(path, () => now);
    expect(store.getBatch(cancelled.id)).toMatchObject({pending:0,cancelled:1,finishedAt:1010});
    expect(store.getBatch(failed.id)).toMatchObject({pending:0,succeeded:1,failed:1});
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});
