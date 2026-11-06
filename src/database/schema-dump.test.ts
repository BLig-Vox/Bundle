import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseSettings } from "./config.ts";
import { openDatabase, withDatabase } from "./connection.ts";
import { dumpSchema, restoreSchema, type NativeSchemaCommand, type NativeSchemaTools } from "./schema-dump.ts";
import { databaseFixture } from "./testing.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() {
  const result = await databaseFixture();
  cleanups.push(result.cleanup);
  return { ...result, connection: "sqlite" as const, migrationsPath: databaseSettings(result.env, result.root).migrationsPath };
}

describe("SQLite live schema dumps", () => {
  test("round trips live tables, indexes, views, triggers and all history columns, excluding application rows and locks", async () => {
    const source = await fixture();
    const target = await fixture();
    const dump = await withDatabase(async orm => {
      await orm.migrator.up();
      const db = orm.driver.getConnection();
      await db.execute("create table custom_parent (id integer primary key, secret text)");
      await db.execute("create table custom_child (id integer primary key, parent_id integer references custom_parent(id), touched text)");
      await db.execute("create index custom_child_parent on custom_child(parent_id)");
      await db.execute("create view custom_view as select id from custom_parent");
      await db.execute("create trigger custom_touch after insert on custom_parent begin insert into custom_child (parent_id, touched) values (new.id, 'trigger fired'); end");
      await db.execute("insert into custom_parent (id, secret) values (42, 'PRIVATE APPLICATION ROW')");
      await db.execute("alter table mikro_orm_migrations add column custom_history text");
      const historyColumns = await db.execute("pragma table_info(mikro_orm_migrations)") as Array<{ name: string }>;
      if (!historyColumns.some(column => column.name === "batch")) await db.execute("alter table mikro_orm_migrations add column batch integer not null default 1");
      await db.execute("update mikro_orm_migrations set custom_history = 'history '' quoted', batch = 7");
      await db.execute("create table bundle_migration_lock (id text primary key, owner text)");
      await db.execute("insert into bundle_migration_lock values ('migration', 'PRIVATE LOCK OWNER')");
      return dumpSchema(orm, source);
    }, source);
    expect(dump.file).toBe(join(source.root, "database/schema/sqlite-schema.sql"));
    expect(dump.pruned).toEqual([]);
    const sql = await readFile(dump.file, "utf8");
    expect(sql).toStartWith('-- Bundle schema dump v1: sqlite\n-- Bundle migration names: ["Migration20261106000000"]\n');
    expect(sql).not.toContain("PRIVATE APPLICATION ROW");
    expect(sql).not.toContain("PRIVATE LOCK OWNER");
    expect(sql).not.toContain("bundle_migration_lock");
    expect(sql).not.toContain("CREATE TABLE sqlite_sequence");
    expect(sql.indexOf("CREATE TABLE custom_parent")).toBeLessThan(sql.indexOf("CREATE TABLE custom_child"));
    await withDatabase(async orm => {
      const db = orm.driver.getConnection();
      // Empty history installed by migration inspection must not block automatic loading.
      await orm.migrator.getExecuted();
      await db.execute("create table bundle_migration_lock (id text primary key, owner text)");
      await db.execute("insert into bundle_migration_lock values ('migration', 'owned-by-current-command')");
      expect(await restoreSchema(orm, { ...target, file: dump.file })).toEqual({ loaded: true, file: dump.file });
      expect(await db.execute("select * from custom_parent")).toEqual([]);
      expect(await db.execute("select * from custom_child")).toEqual([]);
      expect(await db.execute("select * from custom_view")).toEqual([]);
      const rows = await db.execute("select batch, custom_history from mikro_orm_migrations");
      expect(rows).toEqual([{ batch: 7, custom_history: "history ' quoted" }]);
      expect(await orm.migrator.getPending()).toEqual([]);
      expect(await db.execute("select owner from bundle_migration_lock")).toEqual([{ owner: "owned-by-current-command" }]);
      await db.execute("insert into custom_parent (id) values (99)");
      expect(await db.execute("select parent_id, touched from custom_child")).toEqual([{ parent_id: 99, touched: "trigger fired" }]);
      await expect(db.execute("insert into custom_child (parent_id) values (1000)")).rejects.toThrow();
      expect((await db.execute("select name from sqlite_master where type = 'index' and name = 'custom_child_parent'")).length).toBe(1);
      await expect(restoreSchema(orm, { ...target, file: dump.file })).rejects.toThrow("empty application database");
    }, target);
  });

  test("requires exclusive output unless forced and resolves custom files against root", async () => {
    const setup = await fixture();
    await withDatabase(async orm => {
      await orm.migrator.up();
      const dump = await dumpSchema(orm, { ...setup, file: "custom.sql" });
      const original = await readFile(dump.file, "utf8");
      await expect(dumpSchema(orm, { ...setup, file: "custom.sql" })).rejects.toThrow();
      expect(await readFile(dump.file, "utf8")).toBe(original);
      await orm.driver.getConnection().execute("create table later_live_table (id integer)");
      await dumpSchema(orm, { ...setup, file: "custom.sql", force: true });
      expect(await readFile(dump.file, "utf8")).toContain("later_live_table");
      expect((await readdir(setup.root)).filter(name => name.startsWith(".bundle-schema-"))).toEqual([]);
      await symlink(dump.file, join(setup.root, "symlink.sql"));
      await expect(dumpSchema(orm, { ...setup, file: "symlink.sql", force: true })).rejects.toThrow("symlink");
    }, setup);
  });

  test("returns loaded:false for missing dumps and rejects mismatched or missing dialect markers", async () => {
    const setup = await fixture();
    await withDatabase(async orm => {
      expect((await restoreSchema(orm, setup)).loaded).toBe(false);
      await writeFile(join(setup.root, "invalid.sql"), "create table wrong(id integer)");
      await expect(restoreSchema(orm, { ...setup, file: "invalid.sql" })).rejects.toThrow("dialect marker");
      await writeFile(join(setup.root, "invalid.sql"), "-- Bundle schema dump v1: postgresql\ncreate table wrong(id integer)");
      await expect(restoreSchema(orm, { ...setup, file: "invalid.sql" })).rejects.toThrow("dialect marker");
      expect(await orm.driver.getConnection().execute("select name from sqlite_master where name='wrong'")).toEqual([]);
    }, setup);
  });

  test("refuses existing empty application tables, views, triggers, and populated history without modifying them", async () => {
    const setup = await fixture();
    const file = join(setup.root, "restore.sql");
    await writeFile(file, "-- Bundle schema dump v1: sqlite\ncreate table restored (id integer);\n");
    await withDatabase(async orm => {
      const db = orm.driver.getConnection();
      await db.execute("create table existing (id integer)");
      await expect(restoreSchema(orm, { ...setup, file })).rejects.toThrow("empty application database");
      await db.execute("drop table existing");
      await db.execute("create view existing_view as select 1 as id");
      await expect(restoreSchema(orm, { ...setup, file })).rejects.toThrow("empty application database");
      await db.execute("drop view existing_view");
      await orm.migrator.getExecuted();
      await db.execute("create trigger history_trigger after insert on mikro_orm_migrations begin select 1; end");
      await expect(restoreSchema(orm, { ...setup, file })).rejects.toThrow("empty application database");
      await db.execute("drop trigger history_trigger");
      await db.execute("insert into mikro_orm_migrations (name) values ('already_executed')");
      await expect(restoreSchema(orm, { ...setup, file })).rejects.toThrow("empty migration history");
      expect(await db.execute("select name from mikro_orm_migrations")).toEqual([{ name: "already_executed" }]);
      expect(await db.execute("select name from sqlite_master where name='restored'")).toEqual([]);
    }, setup);
  });

  test("rolls back failed loads and restores both the prior history table and foreign-key mode", async () => {
    const setup = await fixture();
    const file = join(setup.root, "broken.sql");
    await writeFile(file, "-- Bundle schema dump v1: sqlite\ncreate table partial(id integer);\nthis is not SQL;\n");
    await withDatabase(async orm => {
      await orm.migrator.getExecuted();
      const db = orm.driver.getConnection();
      const historyBefore = await db.execute("select sql from sqlite_master where name = 'mikro_orm_migrations'");
      for (const mode of ["ON", "OFF"]) {
        await db.execute(`pragma foreign_keys = ${mode}`);
        await expect(restoreSchema(orm, { ...setup, file })).rejects.toThrow();
        expect(await db.execute("pragma foreign_keys")).toEqual([{ foreign_keys: mode === "ON" ? 1 : 0 }]);
        expect(await db.execute("select sql from sqlite_master where name = 'mikro_orm_migrations'")).toEqual(historyBefore);
        expect(await db.execute("select name from sqlite_master where name = 'partial'")).toEqual([]);
      }
      await writeFile(file, "-- Bundle schema dump v1: sqlite\ncreate table parent(id integer primary key);\ncreate table child(parent_id integer references parent(id));\ninsert into child values(99);\n");
      await expect(restoreSchema(orm, { ...setup, file })).rejects.toThrow("foreign-key references");
      expect(await db.execute("select name from sqlite_master where name = 'child'")).toEqual([]);
    }, setup);
  });

  test("supports virtual table schema without including shadow-table rows", async () => {
    const source = await fixture();
    const target = await fixture();
    const dump = await withDatabase(async orm => {
      await orm.driver.getConnection().execute("create virtual table search using fts5(body)");
      await orm.driver.getConnection().execute("insert into search values ('private searchable text')");
      return dumpSchema(orm, source);
    }, source);
    expect(await readFile(dump.file, "utf8")).not.toContain("private searchable text");
    await withDatabase(async orm => {
      await restoreSchema(orm, { ...target, file: dump.file });
      expect(await orm.driver.getConnection().execute("select * from search")).toEqual([]);
    }, target);
  });
});

describe("schema pruning safety", () => {
  test("requires force and no pending migrations, preserving migration files on refusal", async () => {
    const setup = await fixture();
    await withDatabase(async orm => {
      await expect(dumpSchema(orm, { ...setup, prune: true })).rejects.toThrow("--force");
      await expect(dumpSchema(orm, { ...setup, prune: true, force: true })).rejects.toThrow("pending");
      expect((await readdir(setup.migrationsPath)).filter(file => file.endsWith(".ts"))).toHaveLength(1);
    }, setup);
  });

  test("prunes only discovered migration sources after a successful dump and preserves snapshots and other files", async () => {
    const setup = await fixture();
    const snapshot = join(setup.migrationsPath, ".snapshot.json");
    await writeFile(join(setup.migrationsPath, "notes.txt"), "keep unrelated non-source files");
    await withDatabase(async orm => {
      await orm.migrator.up();
      const originalSnapshot = await readFile(snapshot, "utf8");
      const dump = await dumpSchema(orm, { ...setup, prune: true, force: true });
      expect(dump.pruned).toEqual([join(setup.migrationsPath, "Migration20261106000000.ts")]);
      expect((await readFile(dump.file, "utf8"))).toContain("Migration20261106000000");
      expect((await readdir(setup.migrationsPath)).sort()).toEqual([".snapshot.json", "notes.txt"]);
      expect(await readFile(snapshot, "utf8")).toBe(originalSnapshot);
    }, setup);
  });

  test("refuses unrelated TypeScript, disguised non-migration classes, and symlinks without removing sources", async () => {
    const setup = await fixture();
    const unrelated = join(setup.migrationsPath, "Helper.ts");
    await writeFile(unrelated, "export const unrelated = true;");
    await withDatabase(async orm => {
      await orm.migrator.up({ migrations: ["Migration20261106000000"] });
      await expect(dumpSchema(orm, { ...setup, prune: true, force: true })).rejects.toThrow("unrelated");
    }, setup);
    // A separate fixture prevents MikroORM from trying to import an unrelated file as a migration.
    const disguised = await fixture();
    await writeFile(join(disguised.migrationsPath, "MigrationUnrelated.ts"), "export class MigrationUnrelated { }");
    await withDatabase(async orm => {
      await expect(dumpSchema(orm, { ...disguised, prune: true, force: true })).rejects.toThrow("standard exported");
    }, disguised);
    const linked = await fixture();
    await symlink(join(linked.migrationsPath, "Migration20261106000000.ts"), join(linked.migrationsPath, "MigrationLinked.ts"));
    await withDatabase(async orm => {
      await expect(dumpSchema(orm, { ...linked, prune: true, force: true })).rejects.toThrow("symlinks");
      expect((await lstat(join(linked.migrationsPath, "Migration20261106000000.ts"))).isFile()).toBe(true);
    }, linked);
  });

  test("refuses dump output inside the migration directory without changing its snapshot or sources", async () => {
    const setup = await fixture();
    await withDatabase(async orm => {
      await orm.migrator.up();
      const snapshot = join(setup.migrationsPath, ".snapshot.json");
      const original = await readFile(snapshot, "utf8");
      await expect(dumpSchema(orm, { ...setup, file: snapshot, force: true, prune: true })).rejects.toThrow("outside the migration directory");
      expect(await readFile(snapshot, "utf8")).toBe(original);
      expect((await readdir(setup.migrationsPath)).filter(file => file.endsWith(".ts"))).toHaveLength(1);
    }, setup);
  });

  test("never prunes when persisting fails", async () => {
    const setup = await fixture();
    await mkdir(join(setup.root, "not-a-file.sql"));
    await withDatabase(async orm => {
      await orm.migrator.up();
      await expect(dumpSchema(orm, { ...setup, file: "not-a-file.sql", force: true, prune: true })).rejects.toThrow("non-file");
      expect((await readdir(setup.migrationsPath)).filter(file => file.endsWith(".ts"))).toHaveLength(1);
    }, setup);
  });
});

describe("native schema adapters without live servers", () => {
  async function server(connection: "postgresql" | "mariadb", sslmode = "require") {
    const setup = await fixture();
    const orm = await openDatabase({ DB_CONNECTION: connection, DATABASE_URL: `${connection}://native-user:private-password@127.0.0.1:5444/unused?sslmode=${sslmode}` }, undefined, false);
    cleanups.push(() => orm.close(true));
    const schema = connection === "postgresql" ? "public" : "unused";
    let tables: Array<{ name: string; schema: string; isView: boolean }> = [{ name: "mikro_orm_migrations", schema, isView: false }];
    spyOn(orm.em, "fork").mockImplementation(() => ({ getKysely: () => ({ introspection: { getTables: async () => tables } }) }) as never);
    const queries: string[] = [];
    spyOn(orm.driver.getConnection(), "execute").mockImplementation((async (sql: string) => { queries.push(sql); return []; }) as never);
    const commands: NativeSchemaCommand[] = [];
    const native: NativeSchemaTools = {
      which: name => `/native/${name}`,
      execute: async command => {
        commands.push(command);
        if (command.args.includes("--section=pre-data")) return "CREATE SCHEMA public;\nCREATE TABLE sample (id integer);\nCREATE FUNCTION schema_text() RETURNS text AS $$\nCREATE SCHEMA literal_inside_function;\n$$ LANGUAGE sql;\n";
        if (command.args.includes("--data-only") || command.args.includes("--complete-insert")) return "-- MIGRATION HISTORY WITH BATCH\n";
        if (command.args.includes("--section=post-data") || command.args.includes("--no-create-info")) return "-- POST-DATA TRIGGERS\n";
        return "-- LIVE SCHEMA\n";
      },
    };
    return { ...setup, orm, connection, native, commands, queries, setTables: (value: typeof tables) => { tables = value; } };
  }

  test("reports absent clients actionably before touching a database and never leaks passwords", async () => {
    for (const connection of ["postgresql", "mariadb"] as const) {
      const setup = await server(connection);
      setup.native.which = () => null;
      await expect(dumpSchema(setup.orm, setup)).rejects.toThrow("Install the native database client tools");
      expect(setup.commands).toEqual([]);
      expect(setup.queries).toEqual([]);
    }
  });

  test("builds PostgreSQL pre-data/history/post-data commands with credentials only in env and verified TLS", async () => {
    const setup = await server("postgresql");
    const result = await dumpSchema(setup.orm, setup);
    expect(setup.commands).toHaveLength(3);
    expect(setup.commands[0]!.args).toContain("--schema-only");
    expect(setup.commands[0]!.args).toContain("--section=pre-data");
    expect(setup.commands[0]!.args).toContain('--exclude-table="public"."bundle_migration_lock"');
    expect(setup.commands[1]!.args).toContain("--data-only");
    expect(setup.commands[1]!.args).toContain("--column-inserts");
    expect(setup.commands[1]!.args).toContain('--table="public"."mikro_orm_migrations"');
    expect(setup.commands[2]!.args).toContain("--section=post-data");
    for (const command of setup.commands) {
      expect(command.executable).toBe("/native/pg_dump");
      expect(command.args.join(" ")).not.toContain("private-password");
      expect(command.env.PGPASSWORD).toBe("private-password");
      expect(command.env.PGSSLMODE).toBe("verify-full");
      expect(command.env.PGSSLROOTCERT).toBe("system");
    }
    const output = await readFile(result.file, "utf8");
    expect(output).toStartWith("-- Bundle schema dump v1: postgresql\n");
    expect(output).toContain("CREATE SCHEMA IF NOT EXISTS public;");
    expect(output).toContain("$$\nCREATE SCHEMA literal_inside_function;\n$$");
    expect(output.indexOf("MIGRATION HISTORY")).toBeLessThan(output.indexOf("POST-DATA TRIGGERS"));
    expect(output).toContain("pg_get_serial_sequence");
    setup.commands.length = 0;
    expect((await restoreSchema(setup.orm, { ...setup, file: result.file })).loaded).toBe(true);
    expect(setup.commands[0]!.executable).toBe("/native/psql");
    expect(setup.commands[0]!.args).toContain("--single-transaction");
    expect(setup.commands[0]!.args).toContain("--set=ON_ERROR_STOP=1");
    expect(setup.commands[0]!.args).toContain("--file=-");
    expect(setup.commands[0]!.input).toContain('lock table "public"."mikro_orm_migrations" in access exclusive mode;');
    expect(setup.commands[0]!.input).toContain('drop table "public"."mikro_orm_migrations"');
    expect(setup.commands[0]!.input).not.toContain('drop table "public"."bundle_migration_lock"');
  });

  test("builds MariaDB no-data/history/trigger commands and falls back to verified MySQL clients", async () => {
    const setup = await server("mariadb");
    let result = await dumpSchema(setup.orm, setup);
    expect(setup.commands).toHaveLength(3);
    expect(setup.commands[0]!.args[0]).toBe("--no-defaults");
    expect(setup.commands[0]!.args).toContain("--no-data");
    expect(setup.commands[0]!.args).toContain("--ignore-table=unused.bundle_migration_lock");
    expect(setup.commands[0]!.args).toContain("--skip-triggers");
    expect(setup.commands[1]!.args).toContain("--complete-insert");
    expect(setup.commands[1]!.args.slice(-2)).toEqual(["unused", "mikro_orm_migrations"]);
    expect(setup.commands[2]!.args).toContain("--no-create-info");
    expect(setup.commands[2]!.args).toContain("--triggers");
    for (const command of setup.commands) {
      expect(command.args).toContain("--ssl-verify-server-cert");
      expect(command.args.join(" ")).not.toContain("private-password");
      expect(command.env.MYSQL_PWD).toBe("private-password");
    }
    setup.commands.length = 0;
    await restoreSchema(setup.orm, { ...setup, file: result.file });
    expect(setup.commands[0]!.executable).toBe("/native/mariadb");
    expect(setup.commands[0]!.args).toContain("--binary-mode=1");
    expect(setup.commands[0]!.args).toContain("--local-infile=0");
    expect(setup.commands[0]!.input).toContain("prepare bundle_schema_guard");
    setup.native.which = name => name.startsWith("mariadb") ? null : `/native/${name}`;
    setup.commands.length = 0;
    result = await dumpSchema(setup.orm, { ...setup, force: true });
    expect(setup.commands[0]!.executable).toBe("/native/mysqldump");
    expect(setup.commands[0]!.args).toContain("--ssl-mode=VERIFY_IDENTITY");
    setup.commands.length = 0;
    await restoreSchema(setup.orm, { ...setup, file: result.file });
    expect(setup.commands[0]!.executable).toBe("/native/mysql");
    expect(setup.commands[0]!.args).toContain("--ssl-mode=VERIFY_IDENTITY");
  });

  test("disables native TLS only when ORM explicitly disables it and rejects unrepresentable TLS", async () => {
    const setup = await server("postgresql", "disable");
    await dumpSchema(setup.orm, setup);
    expect(setup.commands[0]!.env.PGSSLMODE).toBe("disable");
    setup.orm.config.set("driverOptions", { ssl: { rejectUnauthorized: false } });
    await expect(dumpSchema(setup.orm, { ...setup, force: true })).rejects.toThrow("verification will not be weakened");
    setup.orm.config.set("driverOptions", { ssl: { rejectUnauthorized: true, ca: "custom trust" } });
    await expect(dumpSchema(setup.orm, { ...setup, force: true })).rejects.toThrow("cannot represent this TLS configuration");
  });

  test("fails closed for inherited PostgreSQL TLS, username, or password configuration", async () => {
    const setup = await server("postgresql");
    const oldSsl = process.env.PGSSLMODE;
    const oldUser = process.env.PGUSER;
    const oldPass = process.env.PGPASSFILE;
    const connection = setup.orm.driver.getConnection();
    const explicit = connection.getConnectionOptions();
    try {
      setup.orm.config.set("driverOptions", {});
      process.env.PGSSLMODE = "require";
      await expect(dumpSchema(setup.orm, setup)).rejects.toThrow("TLS will not be silently downgraded");
      setup.orm.config.set("driverOptions", { ssl: { rejectUnauthorized: true } });
      const resolved = spyOn(connection, "getConnectionOptions");
      resolved.mockReturnValue({ ...explicit, user: undefined });
      process.env.PGUSER = "inherited-user";
      await expect(dumpSchema(setup.orm, setup)).rejects.toThrow("explicit database username");
      resolved.mockReturnValue({ ...explicit, password: "" });
      process.env.PGPASSFILE = "/private/inherited.pgpass";
      await expect(dumpSchema(setup.orm, setup)).rejects.toThrow("inherited PostgreSQL password sources");
      expect(setup.commands).toEqual([]);
    } finally {
      for (const [key, value] of [["PGSSLMODE", oldSsl], ["PGUSER", oldUser], ["PGPASSFILE", oldPass]]) {
        if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
      }
    }
  });

  test("honors separate PostgreSQL migration and application lock namespaces", async () => {
    const setup = await server("postgresql");
    setup.orm.config.set("schema", "application");
    setup.orm.config.get("migrations").schema = "history";
    setup.setTables([{ name: "mikro_orm_migrations", schema: "history", isView: false }, { name: "bundle_migration_lock", schema: "application", isView: false }]);
    const dump = await dumpSchema(setup.orm, setup);
    expect(setup.commands[0]!.args).toContain('--exclude-table="application"."bundle_migration_lock"');
    expect(setup.commands[1]!.args).toContain('--table="history"."mikro_orm_migrations"');
    setup.commands.length = 0;
    await restoreSchema(setup.orm, { ...setup, file: dump.file });
    expect(setup.commands[0]!.input).toContain('drop table "history"."mikro_orm_migrations"');
  });

  test("refuses a native restore over existing application objects and preserves locks", async () => {
    const setup = await server("postgresql");
    const dump = await dumpSchema(setup.orm, setup);
    setup.commands.length = 0;
    setup.setTables([{ name: "live_app", schema: "public", isView: false }]);
    await expect(restoreSchema(setup.orm, { ...setup, file: dump.file })).rejects.toThrow("empty application database");
    expect(setup.commands).toEqual([]);
    setup.setTables([{ name: "bundle_migration_lock", schema: "public", isView: false }]);
    await restoreSchema(setup.orm, { ...setup, file: dump.file });
    expect(setup.commands[0]!.input).not.toContain("drop table");
  });
});
