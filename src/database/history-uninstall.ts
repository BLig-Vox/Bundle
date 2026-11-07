import { SqlitePlatform } from "@mikro-orm/sqlite";
import type { openDatabase } from "./connection.ts";
import { historyLocation, lockTable } from "./migration-tools.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>;
export interface HistoryUninstallOptions { force?: boolean; pretend?: boolean; signal?: AbortSignal }
export interface HistoryUninstallResult { pretend: boolean; installed: boolean; removed: boolean }

/** Refuse anything except the known native SQLite history layout. Never initialize it. */
export async function uninstallMigrationHistory(orm: Database, options: HistoryUninstallOptions = {}): Promise<HistoryUninstallResult> {
  let owned: ReturnType<Database["em"]["fork"]> | undefined;
  try {
    if (!options || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new Error();
    const values: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(options)) {
      if (typeof key !== "string" || !["force", "pretend", "signal"].includes(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(options, key)!;
      if (!("value" in descriptor)) throw new Error();
      values[key] = descriptor.value;
    }
    if ((values.force !== undefined && typeof values.force !== "boolean") || (values.pretend !== undefined && typeof values.pretend !== "boolean")) throw new Error();
    if (values.signal !== undefined && !(values.signal instanceof AbortSignal)) throw new Error();
    const signal = values.signal as AbortSignal | undefined;
    const check = () => { if (signal?.aborted) throw new Error(); };
    const pretend = values.pretend === true;
    if (!pretend && values.force !== true) throw new Error();
    check();
    if (!(orm.driver.getPlatform() instanceof SqlitePlatform)) throw new Error();
    const { table, schema } = historyLocation(orm);
    const safe = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
    if (!safe(table) || (schema !== undefined && (!safe(schema) || schema.toLowerCase() !== "main")) || table.toLowerCase() === lockTable.toLowerCase()) throw new Error();
    if ([...orm.getMetadata().getAll().values()].some(meta => meta.tableName?.toLowerCase() === table.toLowerCase())) throw new Error();
    const quote = (name: string) => orm.driver.getPlatform().quoteIdentifier(name);
    const quoted = quote(table);
    owned = orm.em.fork({ clear: true });
    const result = await owned.transactional(async tx => {
      const query = async (sql: string, params: unknown[] = []) => {
        check();
        const rows = await tx.getConnection().execute(sql, params, "all", tx.getTransactionContext()) as Record<string, unknown>[];
        check(); return rows;
      };
      const objects = await query("select type, name, tbl_name, sql from main.sqlite_schema where type in ('table','view','index','trigger')");
      const matching = objects.filter(row => typeof row.name === "string" && row.name.toLowerCase() === table.toLowerCase());
      const lock = objects.filter(row => typeof row.name === "string" && row.name.toLowerCase() === lockTable.toLowerCase());
      if (lock.length) {
        if (lock.length !== 1 || lock[0]!.type !== "table") throw new Error();
        if ((await query(`select 1 from main.${quote(lockTable)} limit 1`)).length) throw new Error();
      }
      if (!matching.length) return { pretend, installed: false, removed: false };
      if (matching.length !== 1 || matching[0]!.type !== "table" || typeof matching[0]!.sql !== "string") throw new Error();
      // Restrict defaults and constraints to the actual MikroORM/Bundle SQLite DDL.
      const ddl = (matching[0]!.sql as string).replace(/[`"\[\]]/g, "").replace(/\s+/g, " ").trim();
      const expected = /^create table [A-Za-z_][A-Za-z0-9_]* \(id integer not null primary key autoincrement, name text not null, executed_at datetime not null default \(strftime\('%s', 'now'\) \* 1000\)(, batch integer not null default 1)?\)$/i;
      if (!expected.test(ddl)) throw new Error();
      if (objects.some(row => (row.type === "trigger" || row.type === "index") && typeof row.tbl_name === "string" && row.tbl_name.toLowerCase() === table.toLowerCase())) throw new Error();
      for (const object of objects) {
        if ((object.type === "view" || object.type === "trigger") && typeof object.sql === "string" && new RegExp(`\\b${table}\\b`, "i").test(object.sql)) throw new Error();
        if (object.type !== "table" || typeof object.name !== "string" || object.name.toLowerCase() === table.toLowerCase()) continue;
        const foreignKeys = await query(`pragma main.foreign_key_list(${quote(object.name)})`);
        if (foreignKeys.some(row => typeof row.table === "string" && row.table.toLowerCase() === table.toLowerCase())) throw new Error();
      }
      if (!pretend) await query(`drop table main.${quoted}`);
      check();
      return { pretend, installed: true, removed: !pretend };
    });
    check();
    return result;
  } catch { throw new Error("Unable to uninstall migration history"); }
  finally { owned?.clear(); }
}
