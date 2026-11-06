import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MikroORM } from "@mikro-orm/core";
import { databaseOptions, databaseSettings, projectRoot, type DatabaseDriver, type Environment } from "./config.ts";

export async function openDatabase(env: Environment = process.env, root = projectRoot, connect = true, migrationsPath?: string): Promise<MikroORM<DatabaseDriver>> {
  const settings = databaseSettings(env, root);
  if (connect && settings.connection === "sqlite" && settings.database !== ":memory:") {
    await mkdir(dirname(settings.database), { recursive: true });
  }
  const options = databaseOptions(env, root);
  if (migrationsPath) options.migrations = { ...options.migrations, path: migrationsPath, pathTs: migrationsPath };
  const orm = await MikroORM.init<DatabaseDriver>(options);
  try {
    if (connect) await orm.connect();
    return orm;
  } catch (error) {
    await orm.close(true);
    throw error;
  }
}

/** Always use a fork per operation/request. Close pools, including after failed work. */
export async function withDatabase<T>(
  work: (orm: Awaited<ReturnType<typeof openDatabase>>) => Promise<T>,
  options: { env?: Environment; root?: string; connect?: boolean; migrationsPath?: string } = {},
): Promise<T> {
  const orm = await openDatabase(options.env, options.root, options.connect, options.migrationsPath);
  try { return await work(orm); } finally { await orm.close(true); }
}
