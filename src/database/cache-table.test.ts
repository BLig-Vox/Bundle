import { expect, test } from "bun:test";
import { renderCacheTableMigration, type CacheTableDialect } from "./cache-table.ts";

const quote = (identifier: string) => `"${identifier}"`;

test.each([
  ["sqlite", "text", "text", "integer"],
  ["postgresql", "varchar(32)", "text", "bigint"],
  ["mariadb", "varchar(32)", "longtext", "bigint"],
] as const)("cache migration defines entry expiry and lease schema for %s", (dialect, namespaceType, valueType, expiryType) => {
  const migration = renderCacheTableMigration(dialect as CacheTableDialect, quote);
  expect(migration.up).toHaveLength(4);
  expect(migration.up[0]).toContain(`\"namespace\" ${namespaceType} NOT NULL`);
  expect(migration.up[0]).toContain(`\"value\" ${valueType} NOT NULL`);
  expect(migration.up[0]).toContain(`\"expires_at\" ${expiryType} NULL`);
  expect(migration.up[0]).toContain('PRIMARY KEY ("namespace", "cache_key")');
  expect(migration.up[1]).toContain('bundle_cache_entries_expiration_index');
  expect(migration.up[2]).toContain('"owner" varchar(32) NOT NULL');
  expect(migration.up[3]).toContain('bundle_cache_locks_expiration_index');
  expect(migration.down).toEqual([
    'DROP TABLE IF EXISTS "bundle_cache_locks";',
    'DROP TABLE IF EXISTS "bundle_cache_entries";',
  ]);
});

test("cache migration rejects unsupported dialects and invalid identifier quoting", () => {
  expect(() => renderCacheTableMigration("mysql" as CacheTableDialect, quote)).toThrow(/dialect/i);
  expect(() => renderCacheTableMigration("sqlite", () => "unsafe; DROP TABLE users")).toThrow(/identifier/i);
});
