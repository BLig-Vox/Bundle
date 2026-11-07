import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./store.ts";

const job = { module: "jobs/A.ts", export: "A", payload: null };
test("failed keyset pages continue after deletion and filter over 1000 failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-queue-page-"));
  const store = new QueueStore(join(dir, "queue.sqlite"), () => 1000);
  try {
    for (let i = 0; i < 1003; i++) { store.enqueue(i % 2 ? "b" : "a", job); const claim = store.reserve([i % 2 ? "b" : "a"])!; store.fail(claim.receipt, "private"); }
    const first = store.failedPage({limit: 1000});
    expect(first.failed).toHaveLength(1000);
    expect(first.nextAfterId).toBe(first.failed[999]!.id);
    store.forgetFailed(first.nextAfterId!);
    store.enqueue("a",job); store.fail(store.reserve(["a"])!.receipt,"private");
    expect(store.failedPage({afterId:first.nextAfterId!,limit:1000}).failed).toHaveLength(4);
    expect(store.failedPage({queue:"a",limit:1000}).failed).toHaveLength(503);
    expect(store.failedPage({limit:1}).nextAfterId).not.toBeNull();
    for (const options of [{limit:0},{limit:1001},{limit:1.5},{afterId:-1},{afterId:Number.MAX_SAFE_INTEGER+1},{queue:"../x"}]) expect(() => store.failedPage(options)).toThrow();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("snapshot and scoped cleanup preserve reservations and strict cutoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-queue-state-")); let now = 1000;
  const store = new QueueStore(join(dir, "queue.sqlite"), () => now);
  try {
    store.enqueue("q",job); const expired = store.reserve(["q"],{leaseMs:10})!;
    store.enqueue("q",job); const reserved = store.reserve(["q"],{leaseMs:100})!;
    store.enqueue("q",job); store.enqueue("q",job,{availableAt:2000});
    store.enqueue("other",job);
    store.enqueue("failure",job); store.fail(store.reserve(["failure"])!.receipt,"secret");
    now=1010;
    expect(store.snapshot("q")).toEqual({ready:1,delayed:1,reserved:1,expired:1,failed:0});
    expect(store.clear("q")).toBe(2);
    expect(store.snapshot("q")).toEqual({ready:0,delayed:0,reserved:1,expired:1,failed:0});
    expect(store.ack(reserved.receipt)).toBe(true); expect(store.ack(expired.receipt)).toBe(false);
    expect(store.pruneFailed({queue:"failure",before:1000})).toBe(0);
    expect(store.pruneFailed({queue:"failure",before:1001})).toBe(1);
    expect(store.snapshot("other").ready).toBe(1);
    store.enqueue("failure",job); store.fail(store.reserve(["failure"])!.receipt,"secret");
    store.enqueue("another",job); store.fail(store.reserve(["another"])!.receipt,"secret");
    expect(store.flushFailed({queue:"failure"})).toBe(1);
    expect(store.snapshot("another").failed).toBe(1);
    expect(store.flushFailed({all:true})).toBe(1);
    expect(store.snapshot("other").ready).toBe(1);
    expect(() => store.pruneFailed({all:true,before:-1})).toThrow();
    expect(() => store.flushFailed({} as never)).toThrow();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
