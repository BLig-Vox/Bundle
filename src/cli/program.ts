import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { databaseSettings, projectRoot, type Environment } from "../database/config.ts";
import { withDatabase, type openDatabase } from "../database/connection.ts";
import { className, generateModel, generateSeeder, modelSource } from "../database/generators.ts";
import { resolveTarget } from "../database/targets.ts";
import { assertDiffBaseline } from "../database/migration-tools.ts";
import { registerMigrations } from "./migrations.ts";
import { generateApp } from "./apps.ts";
import { generateResource, resourceSources } from "./resources.ts";
import { generateRequest } from "./requests.ts";
import { generatePage } from "./pages.ts";
import { generateJob } from "./jobs.ts";
import { defaultRoutePath, generateRoute, routeRegistration } from "./routes.ts";
import { registerRoute } from "./route-registration.ts";
import { inspectProject, formatInspection } from "./inspect.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>;
type CliContext = { env?: Environment; root?: string; output?: (text: string) => void };
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export function createCli(context: CliContext = {}) {
  const env = context.env ?? process.env;
  const root = context.root ?? projectRoot;
  const output = context.output ?? console.log;
  const print = (data: unknown) => output(JSON.stringify(data, null, 2));
  const program = new Command()
    .name("bundle")
    .configureOutput({ writeOut: text => output(text.trimEnd()) })
    .description("Code-first Bun tools: database commands, TypeScript scaffolding and minimal web runtime")
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

  program.command("list").description("List available Bundle commands").action(() => output(program.helpInformation()));
  program.command("inspect").description("Summarize project files offline without executing project code")
    .option("--json", "Emit compact, versioned JSON")
    .action(async (options: { json?: boolean }) => {
      const inventory = await inspectProject(context.root ?? process.cwd(), version);
      output(options.json ? JSON.stringify(inventory) : formatInspection(inventory));
    });
  program.command("about").description("Show configuration without connecting or exposing credentials").action(async () => {
    const settings = databaseSettings((await target()).env, root);
    print({ name: "Bundle", version, runtime: `Bun ${Bun.version}`, database: {
      connection: settings.connection, database: settings.database,
      ...(settings.connection === "sqlite" ? {} : { host: settings.host, port: settings.port }),
      migrationsPath: (await target()).migrationsPath ?? settings.migrationsPath,
    } });
  });
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

  registerMigrations(program, { env, root, output, errorText: safeError });

  program.command("serve").description("Serve API routes or a built frontend + API; GET/HEAD default; explicit methods: POST, PUT, PATCH, DELETE, OPTIONS; absent manifest previews Home")
    .addOption(new Option("--mode <mode>", "Select pages, routes, or app (routes + dist); default detects manifest or Home").choices(["pages", "routes", "app"]))
    .option("--host <address>", "Numeric IP address to bind; non-loopback explicitly exposes the server", "127.0.0.1")
    .option("--port <port>", "TCP port (0 selects an available port)", "3000")
    .action(async (options: { host: string; port: string; mode?: "pages" | "routes" | "app" }) => {
      const { startServer } = await import("../web/server.ts");
      const server = await startServer({ root, hostname: options.host, port: options.port, mode: options.mode });
      try { print({ listening: server.url.href }); }
      catch (error) { await server.stop(true); throw error; }
    });

  program.command("make:app <name>").description("Create a Vite + React + Tailwind v4 app in ./name with local Bundle server/database CLI")
    .action(async (name: string) => {
      const created = await generateApp(root, name);
      print({ created, next: `cd ${created} && bun install; then run bun run dev to start Vite and Bundle together.` });
    });

  program.command("make:page <name>").description("Generate an escaped, server-renderable TypeScript page in src/pages (no overwrite)")
    .action(async (name: string) => { print({ created: await generatePage(root, name) }); });

  program.command("make:job <name>").description("Generate a schema-validated queue handler in src/jobs and print its static registration")
    .requiredOption("--type <type>", "Stable queue type name, e.g. mail.welcome")
    .option("--field <name:type>", "Repeat: string, text, integer, number, boolean; trailing ? makes a field optional", (field: string, fields: string[]) => [...fields, field], [] as string[])
    .action(async (name: string, options: { type: string; field: string[] }) => {
      print(await generateJob(root, name, options.type, options.field));
    });

  program.command("make:request <name>").description("Generate a strict typed request schema in src/requests (no overwrite)")
    .option("--field <name:type>", "Repeat for each field: string, text, integer, boolean; trailing ? makes it optional", (field: string, fields: string[]) => [...fields, field], [] as string[])
    .action(async (name: string, options: { field: string[] }) => {
      print({ created: await generateRequest(root, name, options.field) });
    });

  program.command("make:resource <name>").description("Generate authenticated owner-scoped REST and React CRUD in a generated app")
    .option("--field <name:type>", "Repeat: string, text, integer, number, boolean; optional ?", (field: string, fields: string[]) => [...fields, field], [] as string[])
    .option("-m, --migration", "Also generate a guarded model-diff migration for review (never apply)")
    .action(async (name: string, options: { field: string[]; migration?: boolean }) => {
      resourceSources(name, options.field);
      // Validate prerequisites before any database connection or filesystem writes.
      const result = await generateResource(root, name, options.field, { beforePublish: async () => {
        if (options.migration) { guard(); await db(assertDiffBaseline); }
      } });
      let migration: string | undefined;
      if (options.migration) {
        try {
          await db(async orm => { migration = (await orm.migrator.create(undefined, false, false, `create_${name.toLowerCase()}`)).fileName; });
        } catch {
          throw new Error("Resource scaffold preserved. Migration generation failed; review the database target and migration baseline, then retry make:migration. No migration applied.");
        }
      }
      print({ ...result, migration, next: "Review source and migration; apply with the app CLI migrate command." });
    });

  program.command("make:route <name>").description("Generate a static typed handler; optionally register it in the project manifest")
    .option("--register", "Register in a generated static manifest; refuse arbitrary source edits")
    .option("--path <route>", "Canonical route URL with optional :name segments and --register (default: lower-kebab name)")
    .action(async (name: string, options: { register?: boolean; path?: string }) => {
      // Commander consumes the inherited --path before parsing command options.
      const path = options.path ?? (program.opts().path as string | undefined);
      if (path !== undefined && !options.register) throw new Error("--path requires --register for make:route.");
      if (options.register) print(await registerRoute(root, name, path ?? defaultRoutePath(name)));
      else print({ created: await generateRoute(root, name), registration: routeRegistration(name) });
    });

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
  program.command("make:model <name>").description("Generate a code-first model with optional typed fields, automatically discovered by MikroORM")
    .option("--field <name:type>", "Repeat for each field: string, text, integer, number, boolean, date, json; trailing ? makes it nullable", (field: string, fields: string[]) => [...fields, field], [] as string[])
    .option("-m, --migration", "Also generate a model-diff migration")
    .option("-s, --seed", "Also generate a named seeder")
    .action(async (name: string, options: { field: string[]; migration?: boolean; seed?: boolean }) => {
      modelSource(name, options.field);
      if (options.migration) { guard(); await db(assertDiffBaseline); }
      const settings = databaseSettings((await target()).env, root);
      const created = await generateModel(settings.modelsPath, name, options.field);
      let seeder: string | undefined;
      if (options.seed) {
        try { seeder = await generateSeeder(settings.seedersPath, `${name}Seeder`); }
        catch {
          throw new Error(`Seeder generation failed; model file preserved at ${created}. Existing seeder files were not overwritten. Review the seeder destination before retrying make:seeder. No migration was generated or applied by this command.`);
        }
      }
      let migration: string | undefined;
      if (options.migration) {
        try {
          await db(async orm => { migration = (await orm.migrator.create(undefined, false, false, `create_${name.toLowerCase()}`)).fileName; });
        } catch {
          // Filesystem publication is outside any database transaction. Keep the
          // user-editable model and avoid leaking driver errors or source data.
          throw new Error(`Migration generation failed; model file preserved at ${created}.${seeder ? ` Seeder file preserved at ${seeder}.` : ""} Review migration files and retry make:migration after fixing the cause. No migration was applied by this command.`);
        }
      }
      print({ created, seeder, migration, next: "Edit model properties, then generate/review and apply a migration. Existing models are never modified by the generator." });
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
