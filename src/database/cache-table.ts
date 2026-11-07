export type CacheTableDialect = "sqlite" | "postgresql" | "mariadb";

export interface CacheTableMigration {
  readonly up: readonly string[];
  readonly down: readonly string[];
}

const IDENTIFIERS = [
  "bundle_cache_entries", "bundle_cache_entries_expiration_index", "bundle_cache_locks", "bundle_cache_locks_expiration_index",
  "namespace", "cache_key", "value", "expires_at", "owner",
] as const;

/** Render the persistent entry and lease schema; this is not a cache runtime. */
export function renderCacheTableMigration(dialect: CacheTableDialect, quoteIdentifier: (identifier: string) => string): CacheTableMigration {
  if (dialect !== "sqlite" && dialect !== "postgresql" && dialect !== "mariadb") throw new Error("Unsupported cache-table migration dialect.");
  const quote = (identifier: typeof IDENTIFIERS[number]) => {
    const result = quoteIdentifier(identifier);
    if (result !== `"${identifier}"` && result !== `\`${identifier}\``) throw new Error("Invalid quoted cache-table identifier.");
    return result;
  };
  const namespaceType = dialect === "sqlite" ? "text" : "varchar(32)";
  const keyType = dialect === "sqlite" ? "text" : "varchar(128)";
  const valueType = dialect === "mariadb" ? "longtext" : "text";
  const expiryType = dialect === "sqlite" ? "integer" : "bigint";
  const entries = quote("bundle_cache_entries");
  const locks = quote("bundle_cache_locks");
  const namespace = quote("namespace");
  const key = quote("cache_key");
  const expiry = quote("expires_at");
  const up = [
    `CREATE TABLE ${entries} (${namespace} ${namespaceType} NOT NULL, ${key} ${keyType} NOT NULL, ${quote("value")} ${valueType} NOT NULL, ${expiry} ${expiryType} NULL, PRIMARY KEY (${namespace}, ${key}));`,
    `CREATE INDEX ${quote("bundle_cache_entries_expiration_index")} ON ${entries} (${expiry});`,
    `CREATE TABLE ${locks} (${namespace} ${namespaceType} NOT NULL, ${key} ${keyType} NOT NULL, ${quote("owner")} varchar(32) NOT NULL, ${expiry} ${expiryType} NOT NULL, PRIMARY KEY (${namespace}, ${key}));`,
    `CREATE INDEX ${quote("bundle_cache_locks_expiration_index")} ON ${locks} (${expiry});`,
  ];
  const down = [`DROP TABLE IF EXISTS ${locks};`, `DROP TABLE IF EXISTS ${entries};`];
  return Object.freeze({ up: Object.freeze(up), down: Object.freeze(down) });
}
