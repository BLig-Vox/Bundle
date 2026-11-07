import { expect, test } from "bun:test";
import { renderSessionTableMigration } from "./session-table.ts";

test("session table migration renders bounded dialect-specific schema and rollback", () => {
  const quote = (name: string) => `\`${name}\``;
  const sqlite = renderSessionTableMigration("sqlite", quote);
  expect(sqlite.up).toHaveLength(3);
  expect(sqlite.up[0]).toContain("`id` text NOT NULL PRIMARY KEY");
  expect(sqlite.up[0]).toContain("`last_activity` integer NOT NULL");
  expect(sqlite.up[1]).toContain("`user_id`");
  expect(sqlite.up[2]).toContain("`last_activity`");
  expect(sqlite.down).toEqual(["DROP TABLE IF EXISTS `sessions`;"]);

  const postgresql = renderSessionTableMigration("postgresql", quote);
  expect(postgresql.up[0]).toContain("`id` varchar(255) NOT NULL PRIMARY KEY");
  expect(postgresql.up[0]).toContain("`payload` text NOT NULL");
  expect(postgresql.up[0]).toContain("`last_activity` integer NOT NULL");

  const mariadb = renderSessionTableMigration("mariadb", quote);
  expect(mariadb.up[0]).toContain("`payload` longtext NOT NULL");
  expect(mariadb.up[0]).toContain("`ip_address` varchar(45)");

  expect(() => renderSessionTableMigration("mysql" as never, quote)).toThrow("Unsupported session-table migration dialect");
  expect(() => renderSessionTableMigration("sqlite", name => `'${name}'`)).toThrow("Invalid quoted session-table identifier");
});
