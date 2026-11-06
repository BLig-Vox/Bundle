import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { Options } from "@mikro-orm/core";
import { SqliteDriver } from "@mikro-orm/sqlite";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { MariaDbDriver } from "@mikro-orm/mariadb";
import { Migrator } from "@mikro-orm/migrations";
import { BundleMigrator } from "./migrator.ts";
import { SeedManager } from "@mikro-orm/seeder";
import { SafeMigrationGenerator } from "./migration-generator.ts";

export type DatabaseDriver = SqliteDriver | PostgreSqlDriver | MariaDbDriver;
export type DatabaseConnection = "sqlite" | "postgresql" | "mariadb";
export type Environment = Record<string, string | undefined>;
export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

export function databaseSettings(env: Environment = process.env, root = projectRoot) {
  const connection = env.DB_CONNECTION ?? "sqlite";
  if (connection !== "sqlite" && connection !== "postgresql" && connection !== "mariadb") {
    throw new Error("DB_CONNECTION must be sqlite, postgresql, or mariadb.");
  }
  const urlText = env.DATABASE_URL;
  if (connection === "sqlite" && urlText) {
    throw new Error("DATABASE_URL requires DB_CONNECTION=postgresql or mariadb. Use DB_DATABASE for SQLite.");
  }
  let url: URL | undefined;
  if (urlText) {
    try { url = new URL(urlText); } catch { throw new Error("DATABASE_URL is not a valid database URL."); }
    const protocols = connection === "postgresql" ? ["postgres:", "postgresql:"] : ["mariadb:", "mysql:"];
    if (!protocols.includes(url.protocol)) throw new Error("DATABASE_URL protocol does not match DB_CONNECTION.");
    // MikroORM parses connection fields but does not forward arbitrary URL options
    // to native drivers. Reject unsupported options rather than silently dropping TLS.
    const supported = connection === "postgresql" ? ["schema", "sslmode"] : ["sslmode"];
    for (const key of url.searchParams.keys()) {
      if (!supported.includes(key) || url.searchParams.getAll(key).length !== 1) {
        throw new Error(`Unsupported or repeated DATABASE_URL option: ${key}. Configure native driver options in code.`);
      }
    }
    const mode = url.searchParams.get("sslmode");
    if (mode !== null && !["disable", "require", "verify-full"].includes(mode)) {
      throw new Error("Supported DATABASE_URL sslmode values are disable, require, and verify-full.");
    }
  }
  const configuredDatabase = url ? decodeURIComponent(url.pathname.slice(1)) : env.DB_DATABASE;
  if (connection !== "sqlite" && !configuredDatabase) {
    throw new Error("Set DB_DATABASE or a database name in DATABASE_URL before connecting.");
  }
  const filename = configuredDatabase ?? ".data/bundle.sqlite";
  const database = connection === "sqlite" && filename !== ":memory:" && !isAbsolute(filename)
    ? resolve(root, filename) : filename;
  const defaultPort = connection === "postgresql" ? "5432" : "3306";
  const portText = url ? url.port || defaultPort : env.DB_PORT || defaultPort;
  const port = Number(portText);
  if (connection !== "sqlite" && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("DB_PORT must be an integer between 1 and 65535.");
  }
  return {
    connection: connection as DatabaseConnection, database,
    host: url?.hostname ?? env.DB_HOST ?? "127.0.0.1",
    port,
    user: url ? decodeURIComponent(url.username) : env.DB_USERNAME,
    password: url ? decodeURIComponent(url.password) : env.DB_PASSWORD,
    clientUrl: urlText,
    ssl: url?.searchParams.has("sslmode")
      ? url.searchParams.get("sslmode") === "disable" ? false : { rejectUnauthorized: true }
      : undefined,
    migrationsPath: resolve(root, "database/migrations", connection),
    modelsPath: resolve(root, "src/models"),
    seedersPath: resolve(root, "database/seeders"),
  };
}

export function databaseOptions(env: Environment = process.env, root = projectRoot): Partial<Options<DatabaseDriver>> {
  const settings = databaseSettings(env, root);
  const drivers = { sqlite: SqliteDriver, postgresql: PostgreSqlDriver, mariadb: MariaDbDriver };
  return {
    baseDir: root,
    driver: drivers[settings.connection],
    dbName: settings.database,
    ...(settings.connection === "sqlite" ? {} : {
      host: settings.host, port: settings.port, user: settings.user,
      password: settings.password, clientUrl: settings.clientUrl,
      ...(settings.ssl === undefined ? {} : { driverOptions: { ssl: settings.ssl } }),
    }),
    entities: [`${settings.modelsPath}/*.ts`],
    // Keep the native name present to prevent v7's auto-loader appending it
    // after our subclass and silently replacing the custom registration.
    extensions: [Migrator, BundleMigrator, SeedManager],
    ensureDatabase: false,
    debug: false,
    logger: () => {},
    schemaGenerator: { skipTables: ["bundle_migration_lock"] },
    migrations: {
      path: settings.migrationsPath,
      pathTs: settings.migrationsPath,
      emit: "ts",
      generator: SafeMigrationGenerator,
      transactional: true,
      // MariaDB DDL implicitly commits; do not promise an atomic migration batch.
      allOrNothing: settings.connection !== "mariadb",
      snapshot: true,
      snapshotName: ".snapshot",
    },
    seeder: { path: settings.seedersPath, pathTs: settings.seedersPath, emit: "ts", defaultSeeder: "DatabaseSeeder" },
  };
}
