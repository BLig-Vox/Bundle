import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { registerModelPrune } from "./model-prune.ts";
import { registerDatabaseClient } from "./database-client.ts";
import { registerProject } from "./project.ts";
import { registerTinker } from "./tinker.ts";
import { registerUi } from "./ui.ts";
import type { ServiceScope } from "../console/services.ts";
import { registerDevelopment } from "./development.ts";
import { Command } from "commander";
import { databaseSettings, projectRoot, type Environment } from "../database/config.ts";
import { withDatabase, openDatabase } from "../database/connection.ts";
import { className, generateSeeder } from "../database/generators.ts";
import { generateModelScaffolds } from "./scaffolding.ts";
import { resolveTarget } from "../database/targets.ts";
import { assertDiffBaseline } from "../database/migration-tools.ts";
import { registerMigrations } from "./migrations.ts";
import { registerDiscovery } from "./discovery.ts";
import { registerScaffolding } from "./generators.ts";
import { registerOperations } from "./operations.ts";
import { registerTesting } from "./testing.ts";
import { registerInformation } from "./information.ts";
import { registerLocalOperations } from "./local-operations.ts";
import { registerLogging } from "./logging.ts";
import { registerHttp } from "./http.ts";
import { registerOptimization } from "./optimization.ts";
import { registerMaintenance } from "./maintenance.ts";
import { registerEvents } from "./events.ts";
import { registerChannels } from "./channels.ts";
import { registerQueue } from "./queue.ts";
import { registerQueueOperations } from "./queue-operations.ts";
import { registerQueueBatches } from "./queue-batches.ts";
import { registerQueueControl } from "./queue-control.ts";
import { registerQueueListen } from "./queue-listen.ts";
import { registerSchedule } from "./schedule.ts";
import { registerScheduleControl } from "./schedule-control.ts";
import { registerPackages } from "./packages.ts";
import { registerLanguage } from "./language.ts";
import { registerPublication } from "./publication.ts";
import type { createPrompts } from "../console/prompts.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>;
type CliContext = { env?: Environment; root?: string; output?: (text: string) => void; error?: (text: string) => void; signal?: AbortSignal; handleSignals?: boolean; prompts?: ReturnType<typeof createPrompts>; services?: ServiceScope };
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export function createCli(context: CliContext = {}) {
  const env = context.env ?? process.env;
  const root = context.root ?? projectRoot;
  const output = context.output ?? console.log;
  const print = (data: unknown) => output(JSON.stringify(data, null, 2));
  const program = new Command()
    .name("bundle")
    .description("Code-first developer tools for Bun and TypeScript")
    .configureOutput({ writeOut: text => output(text) })
    .version(version)
    .option("--force", "Explicitly permit destructive operations or production writes")
    .option("--database <connection>", "Select a configured connection name or database driver")
    .option("--path <directory>", "Use one migration directory relative to the project root")
    .option("--realpath", "Explicitly allow an absolute or external migration directory")
    .exitOverride();
  const target = () => resolveTarget(env, root, program.opts());
  const db = async <T>(work: (orm: Database) => Promise<T>, connect = true) =>
    withDatabase(work, { ...await target(), root, connect });
  const guard = () => {
    if ((env.NODE_ENV === "production" || env.APP_ENV === "production") && !program.opts().force) {
      throw new Error("Production database write refused. Review the target database and pass --force to proceed.");
    }
  };

  registerModelPrune(program, { root, output, signal: context.signal, database: async work => {
    const selected = await target();
    if (context.signal?.aborted) throw new Error("Model pruning cancelled.");
    const settings = databaseSettings(selected.env, root);
    if (settings.connection === "sqlite") {
      if (settings.database === ":memory:") throw new Error("Model pruning requires an existing database file.");
      const stat = await lstat(settings.database);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Model pruning requires a regular single-link database file.");
    }
    if (context.signal?.aborted) throw new Error("Model pruning cancelled.");
    return withDatabase(work, { ...selected, root });
  } });
  registerTinker(program, { root, services: context.services, output: context.output, signal: context.signal, openDatabase: async () => {
    guard();
    const selected = await target();
    if (context.signal?.aborted) throw new Error("Tinker database opening cancelled.");
    return openDatabase(selected.env, root, true, selected.migrationsPath);
  } });
  registerProject(program, { root, output, signal: context.signal, prompts: context.prompts });
  registerDevelopment(program, { root, env, output: context.output, error: context.error, signal: context.signal });
  registerDiscovery(program, output);
  registerScaffolding(program, { root, output });
  registerOperations(program, { root, env, output, signal: context.signal });
  registerLocalOperations(program, { root, env, output });
  registerLogging(program, { root, env, output, error: context.error });
  registerHttp(program, { root, output, signal: context.signal });
  registerUi(program, { root, output, signal: context.signal });
  registerOptimization(program, { root, output });
  registerMaintenance(program, { root, output });
  registerEvents(program, { root, output });
  registerChannels(program, { root, output });
  registerPackages(program, { root, output, signal: context.signal });
  registerLanguage(program, { root, output });
  registerPublication(program, { root, output, signal: context.signal });
  registerSchedule(program, { root, env, output, signal: context.signal, handleSignals: context.handleSignals, prompts: context.prompts, force: () => Boolean(program.opts().force) });
  registerScheduleControl(program, { root, output });
  registerQueue(program, { root, output, signal: context.signal });
  registerQueueOperations(program, { root, output, signal: context.signal });
  registerQueueBatches(program, { root, output, signal: context.signal });
  registerQueueControl(program, { root, output });
  registerQueueListen(program, { root, env, output: context.output, error: context.error, signal: context.signal });
  registerTesting(program, { root, env, output: context.output, error: context.error, signal: context.signal, globalOptions: () => program.opts() });
  registerDatabaseClient(program, { root, env, signal: context.signal });
  registerInformation(program, { root, env, output, version, database: async () => {
    const selected = await target();
    const settings = databaseSettings(selected.env, root);
    return {
      connection: settings.connection, database: settings.database,
      ...(settings.connection === "sqlite" ? {} : { host: settings.host, port: settings.port }),
      migrationsPath: selected.migrationsPath ?? settings.migrationsPath,
    };
  } });
  program.command("db:check").description("Connect and verify the selected database").action(async () => {
    await db(async orm => {
      const result = await orm.checkConnection();
      if (!result.ok) throw new Error(result.reason);
      print({ connected: true, connection: databaseSettings((await target()).env, root).connection });
    });
  });
  program.command("db:show").description("Inspect database tables and columns").action(async () => {
    await db(async orm => print(await orm.em.fork().getKysely().introspection.getTables()));
  });
  program.command("db:table <name>").description("Inspect a table by name or schema.name").action(async (name: string) => {
    await db(async orm => {
      const tables = await orm.em.fork().getKysely().introspection.getTables();
      const matches = tables.filter(table => table.name === name || `${table.schema}.${table.name}` === name);
      if (!matches.length) throw new Error(`Table not found: ${name}`);
      if (matches.length > 1) throw new Error(`Ambiguous table name: ${name}. Use schema.name.`);
      print(matches[0]);
    });
  });

  registerMigrations(program, { env, root, output, errorText: safeError, signal: context.signal });

  program.command("db:seed [class]").description("Run a seeder (defaults to DatabaseSeeder)")
    .option("--class <name>", "Select a seeder class (alternative to positional name)")
    .action(async (name: string | undefined, options: { class?: string }) => {
      guard();
      if (name && options.class) throw new Error("Provide either a positional seeder or --class, not both.");
      const seeder = name ?? options.class ?? "DatabaseSeeder";
      className(seeder);
      await db(async orm => { await orm.seeder.seedString(seeder); print({ seeded: seeder }); });
    });
  program.command("make:seeder <name>").description("Generate a seeder without overwriting files").action(async (name: string) => {
    print({ created: await generateSeeder(databaseSettings((await target()).env, root).seedersPath, name) });
  });
  program.command("make:model <name>").description("Generate a code-first model, automatically discovered by MikroORM")
    .option("-m, --migration", "Also generate a model-diff migration")
    .option("-s, --seed", "Also generate a named seeder")
    .option("-f, --factory", "Also generate a native model factory")
    .action(async (name: string, options: { migration?: boolean; seed?: boolean; factory?: boolean }) => {
      if (options.migration) { guard(); await db(assertDiffBaseline); }
      databaseSettings((await target()).env, root);
      const generated = await generateModelScaffolds(root, name, { seed: options.seed, factory: options.factory });
      let migration: string | undefined;
      if (options.migration) await db(async orm => { migration = (await orm.migrator.create(undefined, false, false, `create_${name.toLowerCase()}`)).fileName; });
      print({ ...generated, migration, next: "Edit model properties, then generate/review and apply a migration. Existing models are never modified by the generator." });
    });
  program.command("model:show [name]").description("Inspect mapped models without a database connection").action(async (name?: string) => {
    await db(async orm => {
      const metadata = name ? [orm.getMetadata().getByClassName(name)] : [...orm.getMetadata().getAll().values()];
      print(metadata.map(meta => ({
        name: meta.className, table: meta.tableName,
        properties: meta.props.map(property => ({ name: property.name, type: property.type, kind: property.kind, nullable: !!property.nullable, primary: !!property.primary })),
      })));
    }, false);
  });
  program.command("schema:sql").description("Print CREATE SQL for mapped entities, not a live database backup").action(async () => {
    const selected = await target();
    const schemaEnv = databaseSettings(selected.env, root).connection === "sqlite" ? { ...selected.env, DB_DATABASE: ":memory:" } : selected.env;
    await withDatabase(async orm => output(await orm.schema.getCreateSchemaSQL()), { ...selected, env: schemaEnv, root, connect: false });
  });
  return program;
}

/** Avoid printing connection URLs or known passwords in CLI errors. */
export function safeError(error: unknown, env: Environment = process.env) {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [env.DATABASE_URL, env.DB_PASSWORD];
  // Named connection credentials may occur in driver errors as individual values.
  try {
    const entries = JSON.parse(env.BUNDLE_CONNECTIONS ?? "{}");
    for (const entry of Object.values(entries) as Environment[]) {
      if (entry && typeof entry === "object") secrets.push(entry.DB_PASSWORD, entry.DATABASE_URL);
    }
  } catch { /* Invalid configuration must still produce a safe error message. */ }
  for (const value of [...secrets]) {
    try { if (value?.includes("://")) secrets.push(decodeURIComponent(new URL(value).password)); } catch { /* Invalid URL. */ }
  }
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.replace(/\b(?:postgres(?:ql)?|mariadb|mysql):\/\/[^\s]+/gi, "[redacted database URL]");
}
