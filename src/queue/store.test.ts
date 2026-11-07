import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./store";

test("reserves priority jobs and rejects expired receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-queue-"));
  let now = 1000;
  const store = new QueueStore(join(dir, "queue.sqlite"), () => now);
  try {
    store.enqueue("low", { module: "jobs/A.ts", export: "A", payload: null });
    store.enqueue("high", { module: "jobs/B.ts", export: "B", payload: { x: 1 } });
    const first = store.reserve(["high", "low"], { leaseMs: 10 })!;
    expect(first.queue).toBe("high");
    now += 10;
    expect(store.ack(first.receipt)).toBe(false);
    const again = store.reserve(["high"], { leaseMs: 10 })!;
    expect(again.id).toBe(first.id);
    expect(again.attempt).toBe(2);
    expect(store.ack(again.receipt)).toBe(true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("settlement reports final failure and cancellation refunds the claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-queue-settle-"));
  let now = 1000;
  const store = new QueueStore(join(dir, "queue.sqlite"), () => now);
  const job = { module: "jobs/A.ts", export: "A", payload: null };
  try {
    const failedId = store.enqueue("failed", job, { maxAttempts: 1 });
    const failedClaim = store.reserve(["failed"])!;
    expect(store.settle(failedClaim.receipt, { outcome: "failed" })).toBe("failed");
    expect(store.listFailed("failed").map(item => item.id)).toEqual([failedId]);
    expect(store.settle(failedClaim.receipt, { outcome: "failed" })).toBeNull();

    store.enqueue("cancelled", job, { maxAttempts: 1 });
    const cancelled = store.reserve(["cancelled"])!;
    expect(store.settle(cancelled.receipt, { outcome: "cancelled", delayMs: 10 })).toBe("released");
    expect(store.listFailed("cancelled")).toEqual([]);
    expect(store.reserve(["cancelled"])).toBeNull();
    now += 10;
    const again = store.reserve(["cancelled"])!;
    expect(again.id).toBe(cancelled.id);
    expect(again.attempt).toBe(1);
    expect(store.settle(again.receipt, { outcome: "failed" })).toBe("failed");

    store.enqueue("retry", job, { maxAttempts: 2 });
    const retry = store.reserve(["retry"], { leaseMs: 10 })!;
    expect(store.settle(retry.receipt, { outcome: "failed", delayMs: 5 })).toBe("released");
    expect(store.reserve(["retry"])).toBeNull();
    now += 5;
    const next = store.reserve(["retry"], { leaseMs: 10 })!;
    expect(next.attempt).toBe(2);
    now += 10;
    expect(store.settle(next.receipt, { outcome: "cancelled" })).toBeNull();
    expect(store.settle(next.receipt, { outcome: "failed" })).toBeNull();
    expect(store.settle("0".repeat(64), { outcome: "cancelled" })).toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
