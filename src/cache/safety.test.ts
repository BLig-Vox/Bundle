import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCache } from "./cache.ts";

test("refuses unowned SQLite tables with internal-prefix lookalike names without adopting the file", () => {
 const dir = mkdtempSync(join(tmpdir(), "bundle-cache-prefix-"));
 try {
  const path = join(dir, "db.sqlite");
  const db = new Database(path); db.exec("CREATE TABLE sqliteXforeign (value TEXT); INSERT INTO sqliteXforeign VALUES ('preserve')"); db.close();
  expect(() => { const cache = new LocalCache(path, "a"); cache.close(); }).toThrow();
  const check = new Database(path, { readonly: true });
  try {
   expect(check.query("PRAGMA application_id").get()).toEqual({application_id: 0});
   expect(check.query("SELECT value FROM sqliteXforeign").all()).toEqual([{value: "preserve"}]);
   expect(check.query("SELECT name FROM sqlite_master WHERE name='entries'").get()).toBeNull();
  } finally { check.close(); }
 } finally { rmSync(dir, {recursive:true, force:true}); }
});

test("refuses unrelated SQLite databases without changing them", () => {
 const dir = mkdtempSync(join(tmpdir(), "bundle-cache-safe-"));
 try {
  const path = join(dir, "db.sqlite");
  const db = new Database(path); db.exec("CREATE TABLE bundle_migration_lock (id INTEGER); INSERT INTO bundle_migration_lock VALUES (1)"); db.close();
  expect(() => new LocalCache(path, "a")).toThrow();
  const check = new Database(path, { readonly: true });
  expect(check.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name: "bundle_migration_lock"}]);
  check.close();
 } finally { rmSync(dir, {recursive:true, force:true}); }
});
