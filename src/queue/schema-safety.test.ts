import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./store.ts";

const LEGACY_SCHEMA = "CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, job TEXT NOT NULL, available INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, receipt TEXT, lease INTEGER, reason TEXT, failed_at INTEGER)";
function legacy(path: string): Database {
  const db = new Database(path); chmodSync(path, 0o600);
  db.exec(LEGACY_SCHEMA);
  db.exec("PRAGMA application_id=1112626501; PRAGMA user_version=1");
  return db;
}

for (const version of [1, 2]) {
  test.each([
    ["table", "CREATE TABLE sqliteXforeign (value TEXT)"],
    ["index", "CREATE INDEX sqliteXforeign ON jobs(queue)"],
    ["view", "CREATE VIEW sqliteXforeign AS SELECT 1 AS value"],
    // Harmless fixture: ownership validation must reject extra triggers even when they only read a constant.
    ["trigger", "CREATE TRIGGER sqliteXforeign AFTER INSERT ON jobs BEGIN SELECT 1; END"],
  ])(`version${version} refuses foreign %s objects with internal-prefix lookalike names without changing state`, (_kind, sql) => {
    const root = mkdtempSync(join(tmpdir(), "bundle-queue-schema-")), path = join(root, "queue.sqlite");
    try {
      if (version === 1) legacy(path).close(); else new QueueStore(path).close();
      const raw = new Database(path); try { raw.exec(sql!); } finally { raw.close(); }
      expect(() => { const store = new QueueStore(path, Date.now, { upgrade: true }); store.close(); }).toThrow();
      const check = new Database(path, { readonly: true });
      try {
        expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: version });
        expect(check.query("SELECT name FROM sqlite_master WHERE name='sqliteXforeign'").get()).toEqual({ name: "sqliteXforeign" });
        if (version === 1) expect(check.query("SELECT name FROM sqlite_master WHERE name='batches'").get()).toBeNull();
      } finally { check.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("explicit version1 upgrade preserves every ready delayed live failed and corrupt field", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-queue-upgrade-matrix-")), path = join(root, "queue.sqlite");
  try {
    const db = legacy(path);
    const insert = db.query("INSERT INTO jobs(queue,job,available,attempts,max_attempts,receipt,lease,reason,failed_at) VALUES(?,?,?,?,?,?,?,?,?)");
    insert.run("ready", '{"module":"job.ts","export":"run","payload":null}', 1000, 0, 3, null, null, null, null);
    insert.run("delayed", "corrupt delayed raw", 9000, 0, 5, null, null, null, null);
    insert.run("live", "corrupt live raw", 0, 2, 7, "b".repeat(64), 8000, null, null);
    insert.run("failed", "corrupt failed raw", 500, 4, 4, null, null, "Retained failure", 600);
    const before = db.query("SELECT * FROM jobs ORDER BY id").all();
    db.close();
    expect(() => new QueueStore(path)).toThrow("upgrade required");
    new QueueStore(path, () => 1000, { upgrade: true }).close();
    const check = new Database(path, { readonly: true });
    try {
      expect(check.query("SELECT * FROM jobs ORDER BY id").all()).toEqual(before);
      expect(check.query("SELECT count(*) AS n FROM batch_members").get()).toEqual({ n: 0 });
      expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally { check.close(); }
    new QueueStore(path).close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["unknown-version", "foreign-id", "altered-ddl"])("explicit upgrade rejects %s and preserves existing raw state", kind => {
  const root = mkdtempSync(join(tmpdir(), "bundle-queue-refuse-upgrade-")), path = join(root, "queue.sqlite");
  try {
    const db = new Database(path); chmodSync(path, 0o600);
    db.exec(kind === "altered-ddl" ? LEGACY_SCHEMA.replace("queue TEXT NOT NULL", "queue TEXT NOT NULL DEFAULT 'other'") : LEGACY_SCHEMA);
    db.exec(`PRAGMA application_id=${kind === "foreign-id" ? 7 : 1112626501}; PRAGMA user_version=${kind === "unknown-version" ? 3 : 1}`);
    db.query("INSERT INTO jobs(queue,job,available,attempts,max_attempts) VALUES('keep','untouched',0,0,3)").run();
    const before = db.query("SELECT * FROM jobs").all(); db.close();
    expect(() => { const store = new QueueStore(path, Date.now, { upgrade: true }); store.close(); }).toThrow();
    const check = new Database(path, { readonly: true });
    try {
      expect(check.query("SELECT * FROM jobs").all()).toEqual(before);
      expect(check.query("SELECT name FROM sqlite_master WHERE name='batches'").get()).toBeNull();
    } finally { check.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("version2 reopens with legitimate SQLite sequence autoindexes and statistics", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-queue-internal-")), path = join(root, "queue.sqlite");
  try {
    new QueueStore(path).close();
    const db = new Database(path); db.exec("ANALYZE");
    try { expect(db.query("SELECT name FROM sqlite_master WHERE name GLOB 'sqlite_*'").all().length).toBeGreaterThan(0); }
    finally { db.close(); }
    const reopened = new QueueStore(path);
    try { expect(reopened.enqueueBatch([{ job: { module: "job.ts", export: "run", payload: null } }]).jobIds).toHaveLength(1); }
    finally { reopened.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
