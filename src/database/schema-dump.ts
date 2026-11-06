import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { MikroORM } from "@mikro-orm/core";
import { SqliteDriver } from "@mikro-orm/sqlite";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { MariaDbDriver } from "@mikro-orm/mariadb";
import { glob } from "tinyglobby";
import type { DatabaseConnection, DatabaseDriver } from "./config.ts";

export interface NativeSchemaCommand {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
  input?: string;
}
/** Injection seam for testing argv and environment without installing clients or connecting to servers. */
export interface NativeSchemaTools {
  which(name: string): string | null;
  execute(command: NativeSchemaCommand): Promise<string>;
}
interface SchemaOptions {
  root: string;
  connection: DatabaseConnection;
  file?: string;
  native?: NativeSchemaTools;
}
export interface DumpSchemaOptions extends SchemaOptions {
  migrationsPath: string;
  force?: boolean;
  prune?: boolean;
}
export interface DumpSchemaResult { file: string; pruned: string[] }
export interface RestoreSchemaResult { loaded: boolean; file: string }

const lockTable = "bundle_migration_lock";
const marker = (connection: DatabaseConnection) => `-- Bundle schema dump v1: ${connection}\n`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const dumpFile = (options: SchemaOptions) => resolve(options.root, options.file ?? `database/schema/${options.connection}-schema.sql`);
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };

function assertDriver(orm: MikroORM<DatabaseDriver>, connection: DatabaseConnection) {
  const Driver = { sqlite: SqliteDriver, postgresql: PostgreSqlDriver, mariadb: MariaDbDriver }[connection];
  if (!(orm.driver instanceof Driver)) throw new Error("Schema dump connection does not match the ORM driver.");
}
function sqliteConnection(orm: MikroORM<DatabaseDriver>) {
  if (!(orm.driver instanceof SqliteDriver)) throw new Error("Expected a SQLite ORM driver.");
  return orm.driver.getConnection();
}

function historyTable(orm: MikroORM<DatabaseDriver>) {
  const name = orm.config.get("migrations").tableName;
  if (!name || name.includes(".") || name === lockTable || name.startsWith("sqlite_")) {
    throw new Error("SQLite schema dumps require an unqualified migration-history table name.");
  }
  return name;
}

/** Dump the live database, not the mapped entities. Application rows and locks are never exported. */
export async function dumpSchema(orm: MikroORM<DatabaseDriver>, options: DumpSchemaOptions): Promise<DumpSchemaResult> {
  assertDriver(orm, options.connection);
  if (options.prune && !options.force) throw new Error("Schema pruning requires --force.");
  const candidates = options.prune ? await pruneCandidates(orm, options) : [];
  if (options.prune && (await orm.migrator.getPending()).length) {
    throw new Error("Cannot prune while migrations are pending. Run migrate before schema:dump --prune.");
  }
  const sql = options.connection === "sqlite" ? await dumpSqlite(orm) : await dumpNative(orm, options);
  const file = dumpFile(options);
  const migrationRelative = relative(resolve(options.root, options.migrationsPath), file);
  if (options.prune && !isAbsolute(migrationRelative) && migrationRelative !== ".." && !migrationRelative.startsWith(`..${sep}`)) {
    throw new Error("A pruned schema dump must be outside the migration directory to preserve sources and snapshots.");
  }
  await persistDump(file, sql, options.force === true);
  // Revalidate every file before deleting any. Never unlink a replaced file or a symlink.
  for (const candidate of candidates) await validateCandidate(candidate);
  for (const candidate of candidates) await unlink(candidate.file);
  return { file, pruned: candidates.map(candidate => candidate.file) };
}

async function dumpSqlite(orm: MikroORM<DatabaseDriver>) {
  const history = historyTable(orm);
  const db = await sqliteConnection(orm).getNativeClient();
  if (db.inTransaction) throw new Error("Cannot dump a schema inside an active transaction.");
  return db.transaction(() => {
    const shadows = new Set((db.prepare("pragma table_list").all() as Array<{ name: string; type: string }>)
      .filter(table => table.type === "shadow").map(table => table.name));
    const objects = (db.prepare("select type, name, tbl_name, sql from sqlite_master where name not glob 'sqlite_*' and sql is not null order by rowid").all() as SchemaRow[])
      .filter(row => row.tbl_name !== lockTable && !shadows.has(row.tbl_name));
    const tables = objects.filter(row => row.type === "table");
    const statements = tables.map(row => `${row.sql};`);
    const names: string[] = [];
    if (tables.some(row => row.name === history)) {
      names.push(...(db.prepare(`select name from ${quote(history)} order by rowid`).all() as Array<{ name: string }>).map(row => row.name));
      // SQLite's quote() preserves strings, NULL, blobs, and integers without lossy JS conversion.
      // Generated columns are reconstructed by SQLite rather than explicitly inserted.
      const columns = (db.prepare(`pragma table_xinfo(${quote(history)})`).all() as Array<{ name: string; hidden: number }>)
        .filter(column => column.hidden === 0).map(column => column.name);
      const values = db.prepare(`select ${columns.map(name => `quote(${quote(name)}) as ${quote(name)}`).join(", ")} from ${quote(history)} order by rowid`).all() as Array<Record<string, string>>;
      for (const row of values) {
        statements.push(`insert into ${quote(history)} (${columns.map(quote).join(", ")}) values (${columns.map(name => row[name]).join(", ")});`);
      }
    }
    // In particular, history triggers must not run while history rows are restored.
    statements.push(...objects.filter(row => row.type !== "table").map(row => `${row.sql};`));
    return marker("sqlite") + `-- Bundle migration names: ${JSON.stringify(names)}\n` + "-- Live schema and migration history only; no application data.\n\n" + statements.join("\n\n") + "\n";
  })();
}

/** Load a dump only into an empty application database. Existing migration locks are preserved. */
export async function restoreSchema(orm: MikroORM<DatabaseDriver>, options: SchemaOptions): Promise<RestoreSchemaResult> {
  const file = dumpFile(options);
  let sql: string;
  try { sql = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: false, file };
    throw error;
  }
  if (!sql.startsWith(marker(options.connection))) throw new Error("Schema dump has an invalid or mismatched dialect marker.");
  assertDriver(orm, options.connection);
  if (options.connection !== "sqlite") {
    await restoreNative(orm, options, sql);
    return { loaded: true, file };
  }
  const connection = sqliteConnection(orm);
  const history = historyTable(orm);
  const db = await connection.getNativeClient();
  if (db.inTransaction) throw new Error("Cannot restore a schema inside an active transaction.");
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const objects = db.prepare("select type, name, tbl_name, sql from sqlite_master where name not glob 'sqlite_*'").all() as SchemaRow[];
      for (const object of objects) {
        if (object.tbl_name === lockTable) continue;
        if (object.tbl_name !== history || !["table", "index"].includes(object.type)) {
          throw new Error("Schema restore requires an empty application database; existing tables, views, or triggers were found.");
        }
      }
      if (objects.some(object => object.type === "table" && object.name === history)) {
        if (db.prepare(`select 1 from ${quote(history)} limit 1`).get()) {
          throw new Error("Schema restore requires empty migration history.");
        }
        db.exec(`drop table ${quote(history)}`);
      }
      db.exec(sql);
      if (db.pragma("foreign_key_check").length) throw new Error("Schema dump contains invalid foreign-key references.");
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
  return { loaded: true, file };
}

async function persistDump(file: string, sql: string, force: boolean) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = resolve(dirname(file), `.bundle-schema-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(sql, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary);
    throw error;
  }
  await handle.close();
  try {
    if (force) {
      try {
        const existing = await lstat(file);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Refusing to overwrite a schema dump symlink or non-file.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(temporary, file);
    } else {
      // Linking a complete, synced temporary file provides exclusive creation without partial output.
      await link(temporary, file);
    }
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

const nativeTools: NativeSchemaTools = {
  which: name => Bun.which(name),
  async execute(command) {
    try {
      const process = Bun.spawn([command.executable, ...command.args], {
        env: command.env, stdin: command.input === undefined ? "ignore" : new Blob([command.input]),
        stdout: "pipe", stderr: "pipe",
      });
      const [output, , status] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).arrayBuffer(), process.exited,
      ]);
      if (status !== 0) throw new Error("native command failed");
      return output;
    } catch {
      // Native stderr can contain credentials, connection URLs, or sensitive SQL. Never relay it.
      throw new Error(`${basename(command.executable)} failed. Check native client/server compatibility, database permissions, and TLS configuration; no migrations were pruned.`);
    }
  },
};

function nativeContext(orm: MikroORM<DatabaseDriver>, options: SchemaOptions, operation: "dump" | "restore") {
  const postgres = options.connection === "postgresql";
  const tools = options.native ?? nativeTools;
  const preferred = postgres ? operation === "dump" ? "pg_dump" : "psql" : operation === "dump" ? "mariadb-dump" : "mariadb";
  let executable = tools.which(preferred);
  let mysql = false;
  if (!executable && !postgres) {
    executable = tools.which(operation === "dump" ? "mysqldump" : "mysql");
    mysql = true;
  }
  if (!executable) throw new Error(`Schema ${operation} requires ${preferred}${postgres ? "" : operation === "dump" ? " (or mysqldump)" : " (or mysql)"} on PATH. Install the native database client tools and retry; no migrations were pruned.`);
  const connection = orm.driver.getConnection().getConnectionOptions();
  if (!connection.user) throw new Error("Native schema tools require an explicit database username in connection fields or DATABASE_URL; inherited native-client users are unsupported.");
  if (connection.password !== undefined && typeof connection.password !== "string") throw new Error("Native schema tools require a static database password.");
  if (postgres && !connection.password && (process.env.PGPASSWORD || process.env.PGPASSFILE || existsSync(resolve(homedir(), ".pgpass")))) {
    throw new Error("Native schema tools cannot resolve inherited PostgreSQL password sources. Set an explicit database password in connection fields or DATABASE_URL.");
  }
  const driverOptions = orm.config.get("driverOptions") as Record<string, unknown> | undefined;
  if (driverOptions && Object.keys(driverOptions).some(key => key !== "ssl")) {
    throw new Error("Native schema tools cannot safely represent custom driver options; use plain connection fields and verified ssl configuration.");
  }
  const ssl = driverOptions?.ssl;
  if (postgres && ssl === undefined && Object.keys(process.env).some(key => key.startsWith("PGSSL") && process.env[key] !== undefined)) {
    throw new Error("Native schema tools cannot safely resolve inherited PostgreSQL TLS settings. Set an explicit verified ssl configuration or DATABASE_URL sslmode; TLS will not be silently downgraded.");
  }
  if (ssl !== undefined && ssl !== false && ssl !== true && (
    typeof ssl !== "object" || ssl === null || Array.isArray(ssl)
    || Object.keys(ssl).some(key => key !== "rejectUnauthorized")
    || (ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized === false
  )) throw new Error("Native schema tools cannot represent this TLS configuration. Use verified TLS with system trust or export manually; verification will not be weakened.");
  const verified = ssl !== undefined && ssl !== false;
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PG|MYSQL_|MARIADB_)/.test(key)) delete env[key];
  if (postgres) {
    env.PGPASSWORD = connection.password ?? "";
    env.PGPASSFILE = "/dev/null";
    env.PGSSLMODE = verified ? "verify-full" : "disable";
    // libpq 17+ supports system trust; older clients fail closed rather than disabling verification.
    if (verified) env.PGSSLROOTCERT = "system";
  } else env.MYSQL_PWD = connection.password ?? "";
  const database = connection.database ?? orm.config.get("dbName");
  if (!database) throw new Error("Native schema tools require a database name.");
  const args = [
    ...postgres ? [] : ["--no-defaults", "--protocol=TCP"],
    `--host=${connection.host ?? "127.0.0.1"}`, `--port=${connection.port ?? (postgres ? 5432 : 3306)}`,
    ...connection.user === undefined ? [] : [`--${postgres ? "username" : "user"}=${connection.user}`],
    ...postgres ? ["--no-password"] : verified
      ? mysql ? ["--ssl-mode=VERIFY_IDENTITY"] : ["--ssl", "--ssl-verify-server-cert"]
      : mysql ? ["--ssl-mode=DISABLED"] : ["--skip-ssl"],
  ];
  const migrationOptions = orm.config.get("migrations");
  const historyParts = (migrationOptions.tableName ?? "mikro_orm_migrations").split(".");
  const history = historyParts.pop()!;
  const explicitSchema = historyParts.pop();
  const lockSchema = orm.config.get("schema") ?? (postgres ? "public" : database);
  const schema = migrationOptions.schema ?? explicitSchema ?? lockSchema;
  if (historyParts.length || history === lockTable) throw new Error("Unsupported migration-history table configuration for native schema tools.");
  if (!postgres && schema !== database) throw new Error("MariaDB schema dumps require migration history in the selected database.");
  const quoteIdentifier = (name: string) => orm.driver.getPlatform().quoteIdentifier(name);
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(history)}`;
  return { tools, executable, args, env, postgres, database, history, schema, lockSchema, qualified, quoteIdentifier };
}

async function dumpNative(orm: MikroORM<DatabaseDriver>, options: SchemaOptions) {
  const context = nativeContext(orm, options, "dump");
  const { tools, executable, args, env, postgres, database, history, schema, lockSchema, qualified, quoteIdentifier } = context;
  const tables = await orm.em.fork().getKysely().introspection.getTables();
  const hasHistory = tables.some(table => table.name === history && (!table.schema || table.schema === schema));
  const names = hasHistory ? (await orm.driver.getConnection().execute<Array<{ name: string }>>(`select name from ${qualified} order by id`)).map(row => row.name) : [];
  const execute = (extra: string[]) => tools.execute({ executable, args: [...args, ...extra], env });
  let pre: string, rows = "", post: string;
  if (postgres) {
    const common = ["--no-owner", "--no-privileges", "--no-comments", `--dbname=${database}`, `--exclude-table=${quoteIdentifier(lockSchema)}.${quoteIdentifier(lockTable)}`];
    pre = await execute([...common, "--schema-only", "--section=pre-data"]);
    if (hasHistory) {
      rows = await execute([...common, "--data-only", "--column-inserts", `--table=${qualified}`]);
      // History IDs must not collide with the first post-squash migration.
      rows += `\nselect setval(pg_get_serial_sequence('${qualified.replaceAll("'", "''")}', 'id'), coalesce(max(id), 1), count(*) > 0) from ${qualified};\n`;
    }
    post = await execute([...common, "--schema-only", "--section=post-data"]);
    // Dumped non-default namespaces need creation, while public can already exist on a virgin DB.
    pre = idempotentPostgresNamespaces(pre);
  } else {
    const common = ["--skip-comments", "--skip-lock-tables", "--skip-add-locks", "--skip-add-drop-table", `--ignore-table=${database}.${lockTable}`];
    pre = await execute([...common, "--no-data", "--skip-triggers", "--routines", "--events", "--", database]);
    if (hasHistory) rows = await execute([...common, "--no-create-info", "--skip-triggers", "--complete-insert", "--skip-extended-insert", "--skip-disable-keys", "--", database, history]);
    post = await execute([...common, "--no-data", "--no-create-info", "--triggers", "--skip-routines", "--skip-events", "--", database]);
  }
  // Constraints and triggers follow history inserts so restoring history cannot fire application triggers.
  return marker(options.connection) + `-- Bundle migration names: ${JSON.stringify(names)}\n` + pre + "\n" + rows + "\n" + post + "\n";
}

// Only change top-level pg_dump namespace statements, never SQL inside functions or literals.
function idempotentPostgresNamespaces(sql: string) {
  const insertions: number[] = [];
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith("--", i)) { i = sql.indexOf("\n", i); if (i < 0) break; continue; }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      for (i += 2; i < sql.length && depth; i++) {
        if (sql.startsWith("/*", i)) { depth++; i++; }
        else if (sql.startsWith("*/", i)) { depth--; i++; }
      }
      i--; continue;
    }
    if (sql[i] === '"' || sql[i] === "'") {
      const delimiter = sql[i];
      const escapes = delimiter === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? "");
      for (i++; i < sql.length; i++) {
        if (escapes && sql[i] === "\\") { i++; continue; }
        if (sql[i] === delimiter) { if (sql[i + 1] === delimiter) i++; else break; }
      }
      continue;
    }
    if (sql[i] === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) { const end = sql.indexOf(tag, i + tag.length); if (end < 0) break; i = end + tag.length - 1; continue; }
    }
    if ((i === 0 || sql[i - 1] === "\n") && sql.startsWith("CREATE SCHEMA ", i)) insertions.push(i + "CREATE SCHEMA ".length);
  }
  for (const index of insertions.reverse()) sql = sql.slice(0, index) + "IF NOT EXISTS " + sql.slice(index);
  return sql;
}

async function restoreNative(orm: MikroORM<DatabaseDriver>, options: SchemaOptions, sql: string) {
  const context = nativeContext(orm, options, "restore");
  const { tools, executable, args, env, postgres, database, history, schema, lockSchema, qualified } = context;
  const tables = await orm.em.fork().getKysely().introspection.getTables();
  let hasHistory = false;
  for (const table of tables) {
    const sameSchema = !table.schema || table.schema === schema;
    if ((!table.schema || table.schema === lockSchema) && table.name === lockTable && !table.isView) continue;
    if (sameSchema && table.name === history && !table.isView) { hasHistory = true; continue; }
    throw new Error("Schema restore requires an empty application database; existing tables or views were found.");
  }
  const connection = orm.driver.getConnection();
  const extraObjects = postgres
    ? await connection.execute("select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') limit 1")
    : await connection.execute("select 1 from information_schema.routines where routine_schema = database() union all select 1 from information_schema.events where event_schema = database() union all select 1 from information_schema.triggers where trigger_schema = database() limit 1");
  if (extraObjects.length) throw new Error("Schema restore requires an empty application database; existing routines, events, or triggers were found.");
  if (hasHistory && (await connection.execute(`select 1 from ${qualified} limit 1`)).length) {
    throw new Error("Schema restore requires empty migration history.");
  }
  // Recheck empty history under a native write lock: a new history row between ORM preflight
  // and client startup must not be deleted. Any owned Bundle lock remains untouched.
  let replaceHistory = "";
  if (hasHistory) {
    replaceHistory = postgres
      ? `lock table ${qualified} in access exclusive mode;\nselect 1 / (case when exists (select 1 from ${qualified}) then 0 else 1 end);\ndrop table ${qualified};\n`
      : `lock tables ${qualified} write;\nset @bundle_schema_guard = if((select count(*) from ${qualified}) = 0, 'DO 0', 'Bundle schema restore requires empty migration history');\nprepare bundle_schema_guard from @bundle_schema_guard;\nexecute bundle_schema_guard;\ndeallocate prepare bundle_schema_guard;\ndrop table ${qualified};\nunlock tables;\n`;
  }
  const input = marker(options.connection) + replaceHistory + sql;
  await tools.execute({
    executable, env, input,
    args: [...args, ...postgres
      ? ["--no-psqlrc", "--single-transaction", "--set=ON_ERROR_STOP=1", "--file=-", `--dbname=${database}`]
      : ["--binary-mode=1", "--local-infile=0", "--", database]],
  });
}

interface PruneCandidate { file: string; source: string; device: number; inode: number }
async function validateCandidate(candidate: PruneCandidate) {
  const stat = await lstat(candidate.file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== candidate.device || stat.ino !== candidate.inode
    || await realpath(candidate.file) !== candidate.file || await readFile(candidate.file, "utf8") !== candidate.source) {
    throw new Error("A migration changed during schema dumping; refusing to prune.");
  }
}

async function pruneCandidates(orm: MikroORM<DatabaseDriver>, options: DumpSchemaOptions): Promise<PruneCandidate[]> {
  const config = orm.config.get("migrations");
  const directory = resolve(options.root, options.migrationsPath);
  const configured = resolve(orm.config.get("baseDir"), config.pathTs ?? config.path!);
  if (config.migrationsList || directory !== configured || await realpath(directory) !== directory) {
    throw new Error("Pruning requires the configured migration directory without symlinks or an inline migrations list.");
  }
  // Reject symlinks even if the glob library would silently skip them.
  async function checkDirectory(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Refusing to prune a migration directory containing symlinks.");
      if (entry.isDirectory()) await checkDirectory(resolve(path, entry.name));
    }
  }
  await checkDirectory(directory);
  const files = await glob(config.glob ?? "!(*.d).{js,ts,cjs}", { cwd: directory, absolute: true, followSymbolicLinks: false, expandDirectories: false });
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const candidates: PruneCandidate[] = [];
  for (const file of files.sort()) {
    const local = relative(directory, file);
    const name = basename(file, ".ts");
    if (local.startsWith(`..${sep}`) || isAbsolute(local) || !/^Migration[A-Za-z0-9_]+\.ts$/.test(basename(file))) {
      throw new Error("Refusing to prune an unrelated or non-TypeScript migration file.");
    }
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file) !== file) throw new Error("Refusing to prune migration symlinks or non-files.");
    const source = await readFile(file, "utf8");
    let code: string;
    try { code = transpiler.transformSync(source); }
    catch { throw new Error("Refusing to prune an invalid TypeScript migration file."); }
    if (!/^import\s*\{\s*Migration\s*\}\s*from\s*["']@mikro-orm\/migrations["'];?$/m.test(code)
      || !new RegExp(`^export class ${name} extends Migration \\{`, "m").test(code)) {
      throw new Error("Refusing to prune a file that is not a standard exported MikroORM Migration class.");
    }
    candidates.push({ file, source, device: stat.dev, inode: stat.ino });
  }
  return candidates;
}
