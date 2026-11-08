import { withDatabase } from "bundle/src/database/connection.ts";
import { databaseSettings, type Environment } from "bundle/src/database/config.ts";
import type { AuthAttemptLimiter } from "./routes/Auth.ts";
import { appRoot } from "./auth.ts";

// Static, bounded columns: no request-derived SQL identifiers.
const slots = Array.from({ length: 20 }, (_, i) => `slot_${i}`);

/** Only SQLite has verified migrated constraints and cross-process atomicity. */
export function authAttemptSql(driver: string, _clientUrl?: string) {
  if (driver !== "sqlite") throw new Error("Unsupported auth limiter database driver: only SQLite is verified.");
  return {
    insert: `insert into auth_attempt_bucket (id, ${slots.join(", ")}) values (1, ${slots.map(() => "0").join(", ")}) on conflict (id) do nothing`,
    lock: `select ${slots.join(", ")} from auth_attempt_bucket where id = 1`,
    update: `update auth_attempt_bucket set ${slots.map(slot => `${slot} = ?`).join(", ")} where id = 1`,
    clock: "select cast(round((julianday('now') - 2440587.5) * 86400000) as integer) as now_ms",
  };
}

/** Opt-in persistent global 20-attempt/60-second strict rolling window.
 * Apply the SQLite model migration before explicitly injecting this factory.
 */
export function createDatabaseAuthAttemptLimiter(env: Environment = process.env): AuthAttemptLimiter {
  // Snapshot configuration so later process.env changes cannot switch the store.
  const configured = { ...env };
  const settings = databaseSettings(configured, appRoot);
  const sql = authAttemptSql(settings.connection, settings.clientUrl);
  if (settings.connection === "sqlite" && settings.database === ":memory:") {
    throw new Error("Auth limiter requires a persistent SQLite database file.");
  }
  return Object.freeze({
    scope: "shared" as const,
    async consume() {
      return withDatabase(async orm => {
        const connection = orm.em.getConnection();
        // The SQLite native driver is synchronous. A blocking busy wait can
        // prevent another local request from committing. Yield between bounded
        // retries instead; each failed transaction is rolled back first.
        if (settings.connection === "sqlite") await connection.execute("pragma busy_timeout = 0");
        for (let retry = 0; ; retry++) {
          try {
            return await connection.transactional(async tx => {
              // First statement reserves SQLite's writer lock, even on conflict.
              // Read the DB clock only after acquiring it; commit before returning.
              await connection.execute(sql.insert, [], "run", tx);
              const rows = await connection.execute(sql.lock, [], "all", tx);
              const times = await connection.execute(sql.clock, [], "all", tx);
              const timestamps = slots.map(slot => rows[0]?.[slot]);
              const dbNow = times[0]?.now_ms;
              if (rows.length !== 1 || !Number.isSafeInteger(dbNow) || dbNow <= 0
                || timestamps.some((t, i) => !Number.isSafeInteger(t) || t < 0 || (i > 0 && t < timestamps[i - 1]))) {
                throw new Error("Invalid auth limiter database state.");
              }
              // Preserve ordering across a backward DB-clock adjustment. A forward
              // clock jump still advances expiry; operators must maintain DB time.
              const now = Math.max(dbNow, timestamps[19]);
              const oldest = timestamps[0];
              // One millisecond conservative margin covers SQLite clock rounding.
              // Include the exact cutoff: admission requires strictly older state.
              if (oldest !== 0 && now - oldest <= 60001) {
                return { allowed: false as const, retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60002 - now) / 1000)) };
              }
              await connection.execute(sql.update, [...timestamps.slice(1), now], "run", tx);
              return { allowed: true as const };
            });
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (settings.connection !== "sqlite" || !code?.startsWith("SQLITE_BUSY") || retry >= 20) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(5 * 2 ** retry, 100) + Math.random() * 10));
          }
        }
      }, { root: appRoot, env: configured });
    },
  });
}
