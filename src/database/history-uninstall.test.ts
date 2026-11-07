import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { projectRoot } from "./config.ts";
const sourceSnapshot = Bun.file(join(projectRoot, "database/migrations/sqlite/.snapshot.json"));
const originalSnapshot = await sourceSnapshot.exists() ? await sourceSnapshot.text() : null;
afterEach(async () => { expect(await sourceSnapshot.exists() ? await sourceSnapshot.text() : null).toBe(originalSnapshot); });
import { openDatabase } from "./connection.ts";
import { databaseFixture } from "./testing.ts";

async function isolatedDatabase() {
  const fixture = await databaseFixture();
  try {
    const orm = await openDatabase({ ...fixture.env, DB_DATABASE: ":memory:" }, fixture.root);
    return { orm, close: async () => { try { await orm.close(true); } finally { await fixture.cleanup(); } } };
  } catch (error) { await fixture.cleanup(); throw error; }
}
import { uninstallMigrationHistory } from "./history-uninstall.ts";

test("preview preserves and forced uninstall removes only migration history", async () => {
  const { orm, close } = await isolatedDatabase();
  try {
    await orm.migrator.up();
    expect(await uninstallMigrationHistory(orm, { pretend: true })).toEqual({ pretend: true, installed: true, removed: false });
    expect(await uninstallMigrationHistory(orm, { force: true })).toEqual({ pretend: false, installed: true, removed: true });
    const tables = await orm.em.fork().getKysely().introspection.getTables();
    expect(tables.some(table => table.name === "mikro_orm_migrations")).toBe(false);
    expect(tables.some(table => table.name === "users")).toBe(true);
  } finally { await close(); }
});

test("requires force, validates options, observes cancellation and reports absent history", async () => {
  const { orm, close } = await isolatedDatabase();
  try {
    await expect(uninstallMigrationHistory(orm)).rejects.toThrow();
    await expect(uninstallMigrationHistory(orm, { pretend: true, extra: true } as never)).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    await expect(uninstallMigrationHistory(orm, { pretend: true, signal: abort.signal })).rejects.toThrow();
    expect(await uninstallMigrationHistory(orm, { pretend: true })).toEqual({ pretend: true, installed: false, removed: false });
  } finally { await close(); }
});

for (const [name, statements] of [
  ["extra column", ["alter table mikro_orm_migrations add column foreign_data text"]],
  ["index", ["create index foreign_index on mikro_orm_migrations(name)"]],
  ["trigger", ["create trigger foreign_trigger after insert on mikro_orm_migrations begin select 1; end"]],
  ["inbound foreign key", ["create table dependent (history_id integer references mikro_orm_migrations(id))"]],
  ["dependent view", ["create view dependent as select * from mikro_orm_migrations"]],
  ["live lock", ["create table bundle_migration_lock (id text, owner text)", "insert into bundle_migration_lock values ('migrations', 'owner')"]],
] as const) {
  test(`refuses ${name} without altering history`, async () => {
    const { orm, close } = await isolatedDatabase();
    try {
      await orm.migrator.up();
      for (const sql of statements) await orm.driver.execute(sql);
      await expect(uninstallMigrationHistory(orm, { force: true })).rejects.toThrow();
      expect(await orm.driver.execute("select name from sqlite_schema where name = ?", ["mikro_orm_migrations"], "all")).toHaveLength(1);
    } finally { await close(); }
  });
}

test("refuses a view at the history name", async () => {
  const { orm, close } = await isolatedDatabase();
  try {
    await orm.driver.execute("create view mikro_orm_migrations as select 1 as id");
    await expect(uninstallMigrationHistory(orm, { force: true })).rejects.toThrow();
  } finally { await close(); }
});
