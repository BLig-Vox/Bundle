import { CommanderError, type Command } from "commander";
import { lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { databaseSettings, type Environment } from "../database/config.ts";

export interface DatabaseClientContext {
  root: string;
  env: Environment;
  signal?: AbortSignal;
}

function cancellationCode(signal?: AbortSignal): number {
  const reason = String(signal?.reason ?? "");
  if (reason.includes("SIGINT")) return 130;
  if (reason.includes("SIGTERM")) return 143;
  return 1;
}

function sqliteClientEnvironment(source: Environment): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.create(null);
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP", "LANG", "SQLITE_HISTORY"]);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (allowed.has(key) || /^LC_[A-Z0-9_]+$/.test(key))) environment[key] = value;
  }
  return environment;
}

export async function launchSqliteClient(context: DatabaseClientContext): Promise<number> {
  if (context.signal?.aborted) throw new CommanderError(cancellationCode(context.signal), "bundle.dbCancelled", "Database client cancelled.");
  const settings = databaseSettings(context.env, context.root);
  if (settings.connection !== "sqlite") {
    throw new Error("The native `db` shell currently supports SQLite only; PostgreSQL and MariaDB clients require separate credential-safe adapters.");
  }
  let databaseIdentity: { dev: number; ino: number } | undefined;
  let databaseArgument = settings.database;
  if (settings.database !== ":memory:") {
    let stat;
    try { stat = await lstat(settings.database); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("The SQLite database file must already exist; run an explicit database operation first.");
      throw new Error("Unable to inspect the selected SQLite database file.");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("The SQLite database must be a regular single-link file.");
    databaseIdentity = { dev: stat.dev, ino: stat.ino };
    databaseArgument = `${pathToFileURL(settings.database).href}?mode=rw&nofollow=1`;
  }
  if (context.signal?.aborted) throw new CommanderError(cancellationCode(context.signal), "bundle.dbCancelled", "Database client cancelled.");
  const searchPath = context.env.PATH ?? "";
  const executable = Bun.which("sqlite3", { PATH: searchPath, cwd: context.root });
  if (!executable) throw new Error("The `db` shell requires sqlite3 on PATH; no native client was installed or launched.");
  if (databaseIdentity) {
    let current;
    try { current = await lstat(settings.database); }
    catch { throw new Error("The SQLite database changed during client preflight; refusing to launch."); }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== databaseIdentity.dev || current.ino !== databaseIdentity.ino) {
      throw new Error("The SQLite database changed during client preflight; refusing to launch.");
    }
  }
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executable, ...(settings.database === ":memory:" ? [] : ["-uri"]), databaseArgument], {
      cwd: context.root,
      env: sqliteClientEnvironment(context.env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    throw new Error("Unable to start the sqlite3 client.");
  }
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    try { child.kill(cancellationCode(context.signal) === 130 ? "SIGINT" : "SIGTERM"); } catch { /* already exited */ }
    escalation = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 1000);
  };
  context.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (context.signal?.aborted) onAbort();
    const status = await child.exited;
    if (context.signal?.aborted) throw new CommanderError(cancellationCode(context.signal), "bundle.dbCancelled", "Database client cancelled.");
    return status;
  } finally {
    context.signal?.removeEventListener("abort", onAbort);
    if (escalation) clearTimeout(escalation);
  }
}

export function registerDatabaseClient(program: Command, context: DatabaseClientContext): void {
  program.command("db").description("Open the selected existing SQLite database with sqlite3").action(async () => {
    const status = await launchSqliteClient(context);
    if (status !== 0) throw new CommanderError(status, "bundle.dbClientExit", `sqlite3 exited with status ${status}.`);
  });
}
