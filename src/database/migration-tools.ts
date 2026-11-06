import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { EntitySchema, UniqueConstraintViolationException } from "@mikro-orm/core";
import { Migration } from "@mikro-orm/migrations";
import type { openDatabase } from "./connection.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>;
export type HistoryRecord = { id: number; name: string; executed_at: string | Date; batch: number };
export const lockTable = "bundle_migration_lock";

export function positiveInteger(value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Expected a positive integer.");
  return Number(value);
}

export function historyLocation(orm: Database) {
  const options = orm.config.get("migrations");
  const parts = options.tableName!.split(".");
  const table = parts.at(-1)!;
  const schema = options.schema ?? (parts.length > 1 ? parts[0] : orm.config.get("schema"));
  const quote = (name: string) => orm.driver.getPlatform().quoteIdentifier(name);
  return { table, schema, quoted: schema ? `${quote(schema)}.${quote(table)}` : quote(table) };
}

/** Read-only history: unlike migrator.getExecuted(), never installs tracking tables. */
export async function readHistory(orm: Database): Promise<HistoryRecord[]> {
  const location = historyLocation(orm);
  const tables = await orm.em.fork().getKysely().introspection.getTables();
  const table = tables.find(table => table.name === location.table && (!location.schema || table.schema === location.schema));
  if (!table) return [];
  const batch = table.columns.some(column => column.name === "batch") ? "batch" : "1 as batch";
  return orm.driver.execute(`select id, name, executed_at, ${batch} from ${location.quoted} order by id`, [], "all");
}

export async function migrationFiles(orm: Database) {
  const options = orm.config.get("migrations");
  const directory = options.pathTs ?? options.path!;
  const paths = await Array.fromAsync(new Bun.Glob(options.glob!).scan({ cwd: directory, absolute: true, onlyFiles: true, followSymlinks: false }));
  return paths.sort().map(path => ({ name: path.split(/[\\/]/).at(-1)!.replace(/\.[cm]?[jt]s$/, ""), path }));
}

export function selectRollback(history: HistoryRecord[], options: { step?: number; batch?: number; all?: boolean }) {
  if (options.step && options.batch) throw new Error("Use either --step or --batch, not both.");
  const reversed = [...history].reverse();
  if (options.all) return reversed;
  if (options.step) return reversed.slice(0, options.step);
  const batch = options.batch ?? Math.max(0, ...history.map(row => row.batch));
  return reversed.filter(row => row.batch === batch);
}

export async function migrationPlan(orm: Database, direction: "up" | "down", options: { step?: number; batch?: number; all?: boolean } = {}) {
  const history = await readHistory(orm);
  const files = await migrationFiles(orm);
  if (direction === "up") {
    const executed = new Set(history.map(row => row.name.replace(/\.[jt]s$/, "")));
    return files.filter(file => !executed.has(file.name));
  }
  const byName = new Map(files.map(file => [file.name, file]));
  return selectRollback(history, options).map(row => {
    const file = byName.get(row.name.replace(/\.[jt]s$/, ""));
    if (!file) throw new Error(`Cannot roll back missing migration ${row.name}. Restore its source or rebuild a disposable database from its schema dump.`);
    return file;
  });
}

/** A diff from an empty DB must not duplicate older, still-pending migrations. */
export async function assertDiffBaseline(orm: Database) {
  const options = orm.config.get("migrations");
  const snapshot = join(options.pathTs ?? options.path!, `${options.snapshotName ?? ".snapshot"}.json`);
  if (!await Bun.file(snapshot).exists() && (await migrationPlan(orm, "up")).length) {
    throw new Error("Apply pending migrations before generating a model diff: no migration snapshot exists yet. Use --blank for a handwritten migration.");
  }
}

/** Preview declarative addSql migrations without installing history or executing SQL. */
export async function previewMigrations(orm: Database, files: Awaited<ReturnType<typeof migrationFiles>>, direction: "up" | "down") {
  const blocked = () => { throw new Error("--pretend supports queued addSql statements only; imperative database access cannot be previewed safely."); };
  const driver = new Proxy(orm.driver, { get: blocked });
  const config = new Proxy(orm.config, { get: blocked });
  const result: Array<{ name: string; direction: string; sql: string[] }> = [];
  for (const file of files) {
    const exports = await import(pathToFileURL(file.path).href);
    const Constructor = Object.values(exports).find(value => typeof value === "function" && value.prototype instanceof Migration) as (new (...args: ConstructorParameters<typeof Migration>) => Migration) | undefined;
    if (!Constructor) throw new Error(`No Migration subclass exported by ${file.name}.`);
    const migration = new Constructor(driver, config);
    await migration[direction]();
    const queries = migration.getQueries();
    if (queries.some(query => typeof query !== "string")) throw new Error("--pretend requires string SQL statements.");
    result.push({ name: file.name, direction, sql: queries as string[] });
  }
  return result;
}

class MigrationLock { id!: string; owner!: string; }
function lockEntity(orm: Database) {
  const entity = new EntitySchema({ class: MigrationLock, tableName: lockTable, schema: orm.config.get("schema"), properties: {
    id: { type: "string", fieldName: "id", primary: true }, owner: { type: "string", fieldName: "owner" },
  } }).init();
  entity.meta.sync();
  return entity;
}
function quotedLock(orm: Database) {
  const quote = (name: string) => orm.driver.getPlatform().quoteIdentifier(name);
  const schema = orm.config.get("schema");
  return schema ? `${quote(schema)}.${quote(lockTable)}` : quote(lockTable);
}
export async function acquireMigrationLock(orm: Database): Promise<(() => Promise<void>) | undefined> {
  const quote = (name: string) => orm.driver.getPlatform().quoteIdentifier(name);
  await orm.driver.execute(`create table if not exists ${quotedLock(orm)} (${quote("id")} varchar(64) primary key, ${quote("owner")} varchar(64) not null)`);
  const owner = randomUUID();
  const entity = lockEntity(orm);
  try { await orm.driver.nativeInsert(entity, { id: "migrations", owner }); }
  catch (error) { if (error instanceof UniqueConstraintViolationException) return undefined; throw error; }
  return async () => { await orm.driver.nativeDelete(entity, { id: "migrations", owner }); };
}
export async function unlockMigrations(orm: Database) {
  const tables = await orm.em.fork().getKysely().introspection.getTables();
  if (!tables.some(table => table.name === lockTable && (!orm.config.get("schema") || table.schema === orm.config.get("schema")))) return 0;
  return (await orm.driver.nativeDelete(lockEntity(orm), { id: "migrations" })).affectedRows;
}
