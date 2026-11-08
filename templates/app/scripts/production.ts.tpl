import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withDatabase } from "bundle/src/database/connection.ts";
import { databaseSettings, type Environment } from "bundle/src/database/config.ts";
import { RouteConfigurationError, startServer, validateAddress } from "bundle/src/web/server.ts";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
export class ProductionStartError extends Error {}
function hasStringName(value: unknown): value is { name: string } {
  return value !== null && typeof value === "object" && "name" in value
    && typeof (value as { name?: unknown }).name === "string";
}

export function productionOptions(env: Environment = process.env, root = appRoot) {
  const origin = env.APP_PUBLIC_ORIGIN;
  let parsed: URL;
  try { parsed = new URL(origin ?? ""); }
  catch { throw new ProductionStartError("Production requires APP_PUBLIC_ORIGIN to be one exact HTTPS origin."); }
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new ProductionStartError("Production requires APP_PUBLIC_ORIGIN to be one exact HTTPS origin.");
  }
  if ((env.DB_CONNECTION ?? "sqlite") !== "sqlite") {
    throw new ProductionStartError("The generated production starter requires SQLite for its bundled rolling auth limiter.");
  }
  let settings: ReturnType<typeof databaseSettings>;
  try { settings = databaseSettings(env, root); }
  catch { throw new ProductionStartError("Invalid production SQLite database configuration."); }
  if (settings.database === ":memory:") throw new ProductionStartError("Production requires a persistent SQLite database file.");
  let address: ReturnType<typeof validateAddress>;
  try { address = validateAddress(env.BUNDLE_HOST ?? "127.0.0.1", env.BUNDLE_PORT ?? "3000"); }
  catch { throw new ProductionStartError("Production BUNDLE_HOST must be a numeric IP and BUNDLE_PORT an integer from 1 through 65535."); }
  if (address.port === 0) throw new ProductionStartError("Production BUNDLE_HOST must be a numeric IP and BUNDLE_PORT an integer from 1 through 65535.");
  return { root, origin, hostname: address.hostname, port: address.port, mode: "app" as const, database: settings.database };
}

/** Read-only readiness check; it never creates a DB, migrates, or consumes a limiter slot. */
export async function assertProductionDatabase(env: Environment = process.env, root = appRoot) {
  const options = productionOptions(env, root);
  let file;
  try { file = await lstat(options.database); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProductionStartError("Production SQLite database file is missing. Review and apply migrations with bun run db:migrate.");
    throw new ProductionStartError("Unable to verify production database readiness.");
  }
  if (!file.isFile() || file.isSymbolicLink()) throw new ProductionStartError("Production SQLite database must be a regular, non-symlink file.");

  try {
    await withDatabase(async orm => {
      const connection = orm.em.getConnection();
      const tables = await connection.execute("select name from sqlite_master where type = 'table'");
      const tableNames = new Set<string>();
      for (const row of tables as unknown[]) if (hasStringName(row)) tableNames.add(row.name);
      const modelTables = [...orm.getMetadata().getAll().values()].map(meta => meta.tableName);
      if (modelTables.some(name => !tableNames.has(name)) || !tableNames.has("mikro_orm_migrations")) {
        throw new ProductionStartError("Production database is not fully migrated. Review and apply migrations with bun run db:migrate.");
      }
      const historyColumns = await connection.execute("pragma table_info(mikro_orm_migrations)");
      if (!(historyColumns as unknown[]).some(column => hasStringName(column) && column.name === "batch")) {
        throw new ProductionStartError("Production migration history is incomplete. Run bun run db:migrate before starting.");
      }
      const applied = await connection.execute("select name from mikro_orm_migrations limit 1");
      if (!applied.length) throw new ProductionStartError("Production database has no applied migration baseline. Review and apply migrations with bun run db:migrate.");
      // The Bundle table and batch column already exist; this only reads migration status.
      if ((await orm.migrator.getPending()).length) {
        throw new ProductionStartError("Pending database migrations exist. Review and apply them with bun run db:migrate before starting production.");
      }
      const bucketColumns = await connection.execute("pragma table_info(auth_attempt_bucket)");
      const actual = (bucketColumns as unknown[]).filter(hasStringName).map(column => column.name);
      const expected = ["id", ...Array.from({ length: 20 }, (_, i) => `slot_${i}`)];
      if (actual.length !== expected.length || expected.some((name, i) => actual[i] !== name)) {
        throw new ProductionStartError("Production auth limiter schema is incomplete. Review and apply migrations with bun run db:migrate.");
      }
    }, { root, env });
  } catch (error) {
    if (error instanceof ProductionStartError) throw error;
    throw new ProductionStartError("Unable to verify production database readiness.");
  }
}

export async function startProduction(env: Environment = process.env) {
  const options = productionOptions(env);
  await assertProductionDatabase(env, options.root);
  // Static manifest import sees production mode before the router gate, and before binding.
  process.env.NODE_ENV = "production";
  return startServer({ root: options.root, hostname: options.hostname, port: options.port, mode: options.mode });
}

if (import.meta.main) {
  try {
    const server = await startProduction();
    console.log(JSON.stringify({ listening: server.url.href }));
  } catch (error) {
    const message = error instanceof ProductionStartError || error instanceof RouteConfigurationError
      ? error.message : "Production server failed to start.";
    console.error(message);
    process.exitCode = 1;
  }
}
