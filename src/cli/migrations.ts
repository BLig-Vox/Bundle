import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import type { Command } from "commander";
import { databaseSettings, type Environment } from "../database/config.ts";
import { withDatabase, type openDatabase } from "../database/connection.ts";
import { className } from "../database/generators.ts";
import { SafeMigrationGenerator } from "../database/migration-generator.ts";
import { acquireMigrationLock, assertDiffBaseline, historyLocation, lockTable, migrationPlan, positiveInteger, previewMigrations, readHistory, unlockMigrations } from "../database/migration-tools.ts";
import { resolveTarget } from "../database/targets.ts";
import { dumpSchema, restoreSchema } from "../database/schema-dump.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>;
type Options = { pretend?: boolean; step?: number | boolean; batch?: number; seed?: boolean; seeder?: string; isolated?: boolean; graceful?: boolean; schemaPath?: string };
type Target = Awaited<ReturnType<typeof resolveTarget>>;

export function registerMigrations(program: Command, context: { env: Environment; root: string; output: (text: string) => void; errorText: (error: unknown, env: Environment) => string; signal?: AbortSignal }) {
  const { env, root, output } = context;
  const print = (value: unknown) => output(JSON.stringify(value, null, 2));
  const guard = (destructive: boolean, pretend = false) => {
    if (pretend) return;
    const production = env.NODE_ENV === "production" || env.APP_ENV === "production";
    if ((destructive || production) && !program.opts().force) throw new Error(`${destructive ? "Destructive operation" : "Production database write"} refused. Review the target database and pass --force to proceed.`);
  };
  const schemaFile = (options: Options) => options.schemaPath ?? (program.opts().database ? join("database/schema", `${encodeURIComponent(program.opts().database)}-schema.sql`) : undefined);
  const run = async (options: Options, destructive: boolean, work: (orm: Database, target: Target) => Promise<void>) => {
    guard(destructive, options.pretend);
    if (options.seeder) className(options.seeder);
    if (options.schemaPath !== undefined && !await Bun.file(resolve(root, options.schemaPath)).exists()) throw new Error("The explicitly selected schema dump does not exist.");
    if (options.pretend && options.isolated) throw new Error("--pretend and --isolated cannot be combined: acquiring a lock writes to the database.");
    const target = await resolveTarget(env, root, program.opts());
    const settings = databaseSettings(target.env, root);
    // Even opening a nonexistent SQLite database creates it. Preview against an
    // in-memory empty database instead; existing targets are only introspected.
    if (options.pretend && settings.connection === "sqlite" && settings.database !== ":memory:" && !await Bun.file(settings.database).exists()) {
      target.env = { ...target.env, DB_DATABASE: ":memory:" };
    }
    try {
      await withDatabase(async orm => {
        const release = options.isolated ? await acquireMigrationLock(orm) : undefined;
        if (options.isolated && !release) { print({ skipped: true, reason: "Another migration process holds the database lock." }); return; }
        try { await work(orm, target); } finally { await release?.(); }
      }, { ...target, root });
    } catch (error) {
      if (!options.graceful) throw error;
      print({ failed: true, graceful: true, error: context.errorText(error, target.env) });
    }
  };
  const seed = async (orm: Database, options: Options) => {
    if (options.seed || options.seeder) await orm.seeder.seedString(options.seeder ?? "DatabaseSeeder");
  };
  const apply = async (orm: Database, options: Options, schema?: { file: string; sql: string; migrations: string[] }) => {
    const files = (await migrationPlan(orm, "up")).filter(file => !schema?.migrations.includes(file.name));
    if (options.pretend) { print({ pretend: true, schema, migrations: await previewMigrations(orm, files, "up"), seeded: false }); return; }
    const migrations = options.step
      ? await applySteps(orm, files.map(file => file.name))
      : await orm.migrator.up({ migrations: files.map(file => file.name) });
    await seed(orm, options);
    print({ migrated: migrations.map(migration => migration.name), seeded: !!(options.seed || options.seeder) });
  };
  const standard = (command: Command) => command
    .option("--pretend", "Print queued SQL without executing it or installing migration history")
    .option("--isolated", "Acquire a database-backed cross-process migration lock");
  const seeding = (command: Command) => command.option("--seed", "Run DatabaseSeeder after migrating").option("--seeder <class>", "Run a specific seeder after migrating");

  seeding(standard(program.command("migrate").description("Apply pending migrations as one batch")))
    .option("--step", "Record each migration as its own batch")
    .option("--graceful", "Report runtime failure but return a successful exit status")
    .option("--schema-path <file>", "Use a specific schema dump to bootstrap an empty database")
    .action(async (options: Options) => run(options, false, async (orm, target) => {
      let schema: { file: string; sql: string; migrations: string[] } | undefined;
      if (!(await readHistory(orm)).length) {
        const connection = databaseSettings(target.env, root).connection;
        if (options.pretend) {
          const file = resolve(root, schemaFile(options) ?? `database/schema/${connection}-schema.sql`);
          if (await Bun.file(file).exists()) {
            const sql = await Bun.file(file).text();
            if (!sql.startsWith(`-- Bundle schema dump v1: ${connection}\n`)) throw new Error("Schema dump has an invalid or mismatched dialect marker.");
            const header = sql.split("\n").find(line => line.startsWith("-- Bundle migration names: "));
            if (!header) throw new Error("This schema dump has no preview manifest. Regenerate it with schema:dump before using --pretend on an empty database.");
            const names: unknown = JSON.parse(header.slice("-- Bundle migration names: ".length));
            if (!Array.isArray(names) || names.some(name => typeof name !== "string")) throw new Error("Invalid schema dump preview manifest.");
            schema = { file, sql, migrations: names.map(name => name.replace(/\.[jt]s$/, "")) };
          }
        } else {
          await restoreSchema(orm, { root, connection, file: schemaFile(options) });
        }
      }
      await apply(orm, options, schema);
    }));

  program.command("migrate:uninstall").description("Remove verified SQLite migration tracking only; preserve application tables (requires --force)")
    .option("--pretend", "Inspect tracking state without removal or initialization")
    .action(async (options: { pretend?: boolean }) => {
      const pretend = options.pretend === true;
      guard(true, pretend);
      const checkSignal = () => { if (context.signal?.aborted) throw new Error("Migration history uninstall cancelled."); };
      checkSignal();
      try {
        const selected = await resolveTarget(env, root, program.opts()); checkSignal();
        const settings = databaseSettings(selected.env, root);
        if (settings.connection !== "sqlite" || settings.database === ":memory:") throw new Error("An existing SQLite file is required.");
        const stat = await lstat(settings.database); checkSignal();
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Expected a regular single-link SQLite target.");
        const { uninstallMigrationHistory } = await import("../database/history-uninstall.ts"); checkSignal();
        const result = await withDatabase(async orm => {
          checkSignal();
          return uninstallMigrationHistory(orm, { pretend, force: program.opts().force === true, ...(context.signal ? { signal: context.signal } : {}) });
        }, { ...selected, root });
        checkSignal(); print(result);
      } catch {
        checkSignal();
        throw new Error("Migration history uninstall failed. Inspect tracking state and dependencies; a completed removal is not undone by cancellation.");
      }
    });

  program.command("migrate:install").description("Install or upgrade migration tracking storage without applying migrations")
    .action(async () => run({}, false, async orm => { await orm.migrator.getExecuted(); print({ installed: true }); }));
  program.command("migrate:status").description("List migration status and batch numbers")
    .option("--pending", "Show pending migrations only")
    .action(async (options: { pending?: boolean }) => run({}, false, async orm => {
      await orm.migrator.getExecuted();
      print({ executed: options.pending ? [] : await readHistory(orm), pending: await migrationPlan(orm, "up") });
    }));
  program.command("migrate:check").description("Fail when entity changes need a migration (snapshot comparison, not a drift audit)")
    .action(async () => run({}, false, async orm => {
      if (await orm.migrator.checkSchema()) throw new Error("Schema changes detected. Run make:migration to generate a migration.");
      print({ schemaCurrent: true });
    }));

  standard(program.command("migrate:rollback").description("Roll back the latest batch, or select a count/batch (requires --force)"))
    .option("--step <count>", "Roll back this many individual migrations", positiveInteger)
    .option("--batch <number>", "Roll back a particular batch", positiveInteger)
    .action(async (options: Options) => {
      if (options.step && options.batch) throw new Error("Use either --step or --batch, not both.");
      await run(options, true, async orm => {
        const files = await migrationPlan(orm, "down", { step: options.step as number | undefined, batch: options.batch });
        if (options.pretend) print({ pretend: true, migrations: await previewMigrations(orm, files, "down") });
        else print({ rolledBack: files.length ? (await orm.migrator.down({ migrations: files.map(file => file.name) })).map(row => row.name) : [] });
      });
    });
  standard(program.command("migrate:reset").description("Roll back every migration (requires --force)"))
    .action(async (options: Options) => run(options, true, async orm => {
      const files = await migrationPlan(orm, "down", { all: true });
      if (options.pretend) print({ pretend: true, migrations: await previewMigrations(orm, files, "down") });
      else print({ rolledBack: files.length ? (await orm.migrator.down({ migrations: files.map(file => file.name) })).map(row => row.name) : [] });
    }));
  seeding(standard(program.command("migrate:refresh").description("Roll back and reapply migrations (requires --force)")))
    .option("--step <count>", "Refresh only the most recent individual migrations", positiveInteger)
    .action(async (options: Options) => run(options, true, async orm => {
      const files = await migrationPlan(orm, "down", { step: options.step as number | undefined, all: !options.step });
      const upFiles = [...files].reverse();
      if (options.pretend) {
        print({ pretend: true, migrations: [...await previewMigrations(orm, files, "down"), ...await previewMigrations(orm, upFiles, "up")] });
      } else {
        if (files.length) await orm.migrator.down({ migrations: files.map(file => file.name) });
        // A partial refresh reapplies only what it rolled back; a full refresh also applies pending migrations.
        const migrated = await orm.migrator.up(options.step ? { migrations: upFiles.map(file => file.name) } : undefined);
        await seed(orm, options);
        print({ migrated: migrated.map(row => row.name), seeded: !!(options.seed || options.seeder) });
      }
    }));
  seeding(program.command("migrate:fresh").description("Rebuild mapped tables/history after safety checks (requires --force)"))
    .option("--isolated", "Acquire the database migration lock")
    .option("--schema-path <file>", "Use a schema dump for the rebuilt database")
    .action(async (options: Options) => run(options, true, async (orm, target) => {
      await freshPreflight(orm, databaseSettings(target.env, root).connection);
      await orm.schema.drop({ dropMigrationsTable: true });
      // New instance avoids native migration storage's cached table-existence state.
      await withDatabase(async fresh => {
        await restoreSchema(fresh, { root, connection: databaseSettings(target.env, root).connection, file: schemaFile(options) });
        await apply(fresh, options);
      }, { ...target, root });
    }));
  program.command("migrate:unlock").description("Remove a stale isolation lock; ensure no migration is running (requires --force)")
    .action(async () => run({}, true, async orm => print({ unlocked: await unlockMigrations(orm) })));

  program.command("make:migration [name]").description("Generate a model diff or handwritten migration stub")
    .option("--blank", "Generate empty up/down methods without changing the snapshot")
    .option("--create <table>", "Generate a create-table starter with a primary key")
    .option("--table <table>", "Generate an empty migration to edit an existing table")
    .action(async (name: string | undefined, options: { blank?: boolean; create?: string; table?: string }) => {
      if (name && !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error("Migration names may contain letters, numbers, and underscores only.");
      if ([options.blank, options.create, options.table].filter(Boolean).length > 1) throw new Error("Choose only one of --blank, --create, or --table.");
      const table = options.create ?? options.table;
      if (table && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("Table names must be simple SQL identifiers.");
      await run({}, false, async (orm, target) => {
        if (options.blank || table) {
          const quote = (value: string) => orm.driver.getPlatform().quoteIdentifier(value);
          const dialect = databaseSettings(target.env, root).connection;
          const pk = dialect === "sqlite" ? "integer primary key autoincrement" : dialect === "postgresql" ? "serial primary key" : "int unsigned not null auto_increment primary key";
          const diff = options.create ? { up: [`create table ${quote(options.create)} (${quote("id")} ${pk});`], down: [`drop table if exists ${quote(options.create)};`] } : { up: [""], down: [""] };
          const generator = new SafeMigrationGenerator(orm.driver, orm.config.getNamingStrategy(), orm.config.get("migrations"));
          const [, file] = await generator.generate(diff, undefined, name);
          print({ file, message: table ? `Review and edit the up/down SQL for ${table}; model mappings are not modified.` : "Blank migration generated; implement up/down as needed." });
        } else {
          await assertDiffBaseline(orm);
          const migration = await orm.migrator.create(undefined, false, false, name);
          print({ file: migration.fileName || null, message: migration.fileName ? "Migration generated; review its SQL before applying." : "No schema changes detected." });
        }
      });
    });
  program.command("schema:dump").description("Dump the live schema and migration history, excluding application rows")
    .option("--prune", "Delete applied migration source files after dumping (requires --force)")
    .option("--output <file>", "Write to a custom dump path")
    .option("--isolated", "Acquire the migration lock while dumping/pruning")
    .action(async (options: { prune?: boolean; output?: string; isolated?: boolean }) => run(options, !!options.prune, async (orm, target) => {
      const settings = databaseSettings(target.env, root);
      print(await dumpSchema(orm, { root, connection: settings.connection, migrationsPath: target.migrationsPath ?? settings.migrationsPath, file: options.output ?? schemaFile({}), force: !!program.opts().force, prune: options.prune }));
    }));
}

async function applySteps(orm: Database, names: string[]) {
  const result = [];
  for (const name of names) result.push(...await orm.migrator.up({ migrations: [name] }));
  return result;
}

async function freshPreflight(orm: Database, connection: string) {
  const defaultSchema = connection === "mariadb" ? orm.config.get("dbName") : orm.config.get("schema") ?? orm.driver.getPlatform().getDefaultSchemaName();
  const key = (schema: string | undefined, table: string) => `${schema ?? defaultSchema ?? ""}.${table}`;
  const known = new Set([...orm.getMetadata()].map(meta => key(meta.schema, meta.tableName)));
  const history = historyLocation(orm);
  known.add(key(history.schema, history.table));
  known.add(key(orm.config.get("schema"), lockTable));
  const tables = await orm.em.fork().getKysely().introspection.getTables();
  if (tables.some(table => table.isView || !known.has(key(table.schema, table.name)))) throw new Error("Fresh reset refused: unmapped tables or views exist. Use a dedicated database or reconcile migration history first.");
  const executed = await readHistory(orm);
  if (executed.length && ((await migrationPlan(orm, "up")).length || await orm.migrator.checkSchema())) throw new Error("Fresh reset refused: apply pending migrations and reconcile entity changes first, before dropping data or migration history.");
}
