export type SessionTableDialect = "sqlite" | "postgresql" | "mariadb";

export interface SessionTableMigration {
  readonly up: readonly string[];
  readonly down: readonly string[];
}

const IDENTIFIERS = [
  "sessions", "sessions_user_id_index", "sessions_last_activity_index",
  "id", "user_id", "ip_address", "user_agent", "payload", "last_activity",
] as const;

/** Render a bounded database session table schema; this does not implement a session runtime. */
export function renderSessionTableMigration(dialect: SessionTableDialect, quoteIdentifier: (identifier: string) => string): SessionTableMigration {
  if (dialect !== "sqlite" && dialect !== "postgresql" && dialect !== "mariadb") throw new Error("Unsupported session-table migration dialect.");
  const quote = (identifier: typeof IDENTIFIERS[number]) => {
    const result = quoteIdentifier(identifier);
    if (result !== `"${identifier}"` && result !== `\`${identifier}\``) throw new Error("Invalid quoted session-table identifier.");
    return result;
  };
  const idType = dialect === "sqlite" ? "text" : "varchar(255)";
  const payloadType = dialect === "mariadb" ? "longtext" : "text";
  const activityType = dialect === "mariadb" ? "int" : "integer";
  const table = quote("sessions");
  const up = [
    `CREATE TABLE ${table} (${quote("id")} ${idType} NOT NULL PRIMARY KEY, ${quote("user_id")} ${idType} NULL, ${quote("ip_address")} varchar(45) NULL, ${quote("user_agent")} text NULL, ${quote("payload")} ${payloadType} NOT NULL, ${quote("last_activity")} ${activityType} NOT NULL);`,
    `CREATE INDEX ${quote("sessions_user_id_index")} ON ${table} (${quote("user_id")});`,
    `CREATE INDEX ${quote("sessions_last_activity_index")} ON ${table} (${quote("last_activity")});`,
  ];
  const down = [`DROP TABLE IF EXISTS ${table};`];
  return Object.freeze({ up: Object.freeze(up), down: Object.freeze(down) });
}
