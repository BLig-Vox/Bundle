import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./store";

// A separate process owns the SQLite write lock while the synchronous store call waits.
async function withWriteLock<T>(path: string, releaseFile: string, action: () => T): Promise<{ result: T; releasedAt: number }> {
  const code = `import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs';
    const db = new Database(process.argv[1]); db.exec('BEGIN IMMEDIATE');
    console.log('locked'); await Bun.sleep(800);
    writeFileSync(process.argv[2], String(Date.now())); db.exec('COMMIT'); db.close();`;
  const child = Bun.spawn([process.execPath, "-e", code, path, releaseFile], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" },
  });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    const result = action();
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    return { result, releasedAt: Number(readFileSync(releaseFile, "utf8")) };
  } finally {
    child.kill();
    await child.exited;
    reader.releaseLock();
  }
}

const job = { module: "jobs/Run.ts", export: "Run", payload: null };

test("reservation lease starts after the contended write lock is released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-queue-timing-"));
  const path = join(dir, "q.sqlite");
  const samples: number[] = [];
  const store = new QueueStore(path, () => { const now = Date.now(); samples.push(now); return now; });
  try {
    store.enqueue("q", job);
    samples.length = 0;
    const { result, releasedAt } = await withWriteLock(path, join(dir, "release"), () => store.reserve(["q"], { leaseMs: 250 }));
    expect(result).not.toBeNull();
    expect(samples.length).toBeGreaterThan(0);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(releasedAt);
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query("SELECT lease FROM jobs WHERE id=?").get(result!.id) as { lease: number };
      expect(row.lease).toBeGreaterThanOrEqual(releasedAt + 250);
    } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const operation of ["ack", "release", "heartbeat", "fail", "settle-failed", "settle-cancelled"] as const) {
  test(`${operation} rejects a receipt that expires while waiting for the write lock`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-queue-timing-"));
    const path = join(dir, "q.sqlite");
    const samples: number[] = [];
    const store = new QueueStore(path, () => { const now = Date.now(); samples.push(now); return now; });
    try {
      store.enqueue("q", job);
      const reservation = store.reserve(["q"], { leaseMs: 250 })!;
      samples.length = 0;
      const { result, releasedAt } = await withWriteLock(path, join(dir, "release"), () => {
        switch (operation) {
          case "ack": return store.ack(reservation.receipt);
          case "release": return store.release(reservation.receipt, { delayMs: 100 });
          case "heartbeat": return store.heartbeat(reservation.receipt, { leaseMs: 100 });
          case "fail": return store.fail(reservation.receipt, "failed");
          case "settle-failed": return store.settle(reservation.receipt, { outcome: "failed" });
          case "settle-cancelled": return store.settle(reservation.receipt, { outcome: "cancelled" });
        }
      });
      expect(result).toBe(operation.startsWith("settle-") ? null : false);
      expect(samples.length).toBeGreaterThan(0);
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(releasedAt);
      const recovered = store.reserve(["q"]);
      expect(recovered?.id).toBe(reservation.id);
      expect(recovered?.attempt).toBe(2);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
