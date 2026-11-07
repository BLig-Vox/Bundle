import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore, type QueueJob } from "./store";

const job: QueueJob = { module: "jobs/Run.ts", export: "Run", payload: { data: [1, true] } };
function fixture() { const dir = mkdtempSync(join(tmpdir(), "bundle-queue-")); return { dir, path: join(dir, "queue.sqlite"), clean: () => rmSync(dir, { recursive: true, force: true }) }; }

test("delays, heartbeat, expiry, exhausted crashes and retry persist", () => {
  const f = fixture(); let now = 10_000; let store = new QueueStore(f.path, () => now);
  try {
    const id = store.enqueue("default", job, { availableAt: now + 20, maxAttempts: 2 });
    expect(store.reserve(["default"])).toBeNull(); now += 20;
    const first = store.reserve(["default"], { leaseMs: 10 })!;
    now += 9; expect(store.heartbeat(first.receipt, { leaseMs: 10 })).toBe(true);
    now += 2; expect(store.reserve(["default"])).toBeNull();
    store.close(); store = new QueueStore(f.path, () => now);
    now += 8; const second = store.reserve(["default"], { leaseMs: 10 })!;
    expect(second.attempt).toBe(2); expect(store.release(first.receipt)).toBe(false);
    now += 10; expect(store.fail(second.receipt, "late")).toBe(false);
    expect(store.reserve(["default"])).toBeNull(); expect(store.listFailed()[0]?.id).toBe(id);
    expect(store.retry(id)).toBe(true); const retried = store.reserve(["default"])!;
    expect(retried.attempt).toBe(1); expect(store.fail(retried.receipt, "bad")).toBe(true);
    expect(store.listFailed("default")[0]?.reason).toBe("bad"); expect(store.forgetFailed(id)).toBe(true);
    expect(store.listFailed()).toEqual([]);
  } finally { store.close(); f.clean(); }
});

test("validates lossless descriptors, limits and FIFO", () => {
  const f = fixture(); const store = new QueueStore(f.path, () => 1000);
  try {
    for (const payload of [undefined, NaN, Infinity, -0, { x: undefined }, new Date(), [,,], 1n]) expect(() => store.enqueue("q", { ...job, payload })).toThrow();
    for (const module of ["../x.ts", "/x.ts", "x.js", "x/../a.ts", "./a.ts"]) expect(() => store.enqueue("q", { ...job, module })).toThrow();
    expect(() => store.enqueue("q", { ...job, export: "constructor" })).toThrow();
    expect(() => store.enqueue("q", { ...job, payload: "x".repeat(65536) })).toThrow();
    expect(() => store.enqueue("q", job, { maxAttempts: 101 })).toThrow();
    expect(() => store.reserve(["q"], { leaseMs: 0 })).toThrow();
    const a = store.enqueue("q", job), b = store.enqueue("q", job);
    expect(store.reserve(["q"])?.id).toBe(a); expect(store.reserve(["q"])?.id).toBe(b);
  } finally { store.close(); f.clean(); }
});

test("rejects unrelated database, hardlinks, symlinks and unsafe parents", () => {
  const f = fixture();
  try {
    const db = new Database(f.path); db.exec("CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('keep')"); db.close(); chmodSync(f.path, 0o600);
    const before = readFileSync(f.path); expect(() => new QueueStore(f.path)).toThrow(); expect(readFileSync(f.path)).toEqual(before);
    const link = join(f.dir, "hard"); linkSync(f.path, link); expect(() => new QueueStore(f.path)).toThrow();
    const sym = join(f.dir, "sym"); symlinkSync(f.path, sym); expect(() => new QueueStore(sym)).toThrow();
    const parent = join(f.dir, "bad"); mkdirSync(parent); chmodSync(parent, 0o777); expect(() => new QueueStore(join(parent, "db"))).toThrow();
    chmodSync(parent, 0o1777); expect(() => new QueueStore(join(parent, "db"))).toThrow();
    const parentlink = join(f.dir, "parentlink"); symlinkSync(f.dir, parentlink); expect(() => new QueueStore(join(parentlink, "new"))).toThrow();
    const ownedPath = join(f.dir, "owned"); const owned = new QueueStore(ownedPath); owned.close();
    symlinkSync(join(f.dir, "missing"), `${ownedPath}-journal`); expect(() => new QueueStore(ownedPath)).toThrow();
  } finally { f.clean(); }
});

test("creation forces exact private mode even with restrictive umask", () => {
  const f = fixture(); const previous = process.umask(0o777);
  try { const store = new QueueStore(f.path); store.close(); expect(lstatSync(f.path).mode & 0o777).toBe(0o600); }
  finally { process.umask(previous); f.clean(); }
});
