import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Environment } from "./config.ts";

const connectionFields = [
  "DB_CONNECTION", "DB_DATABASE", "DB_HOST", "DB_PORT", "DB_USERNAME", "DB_PASSWORD", "DATABASE_URL",
] as const;
const drivers = new Set(["sqlite", "postgresql", "mariadb"]);

function namedConnections(text: string | undefined): Map<string, Environment> {
  if (text === undefined) return new Map();
  let mapping: unknown;
  try { mapping = JSON.parse(text); } catch {
    // JSON parser errors can include the input, including passwords and URLs.
    throw new Error("BUNDLE_CONNECTIONS must be a JSON object of named connection records.");
  }
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new Error("BUNDLE_CONNECTIONS must be a JSON object of named connection records.");
  }
  const connections = new Map<string, Environment>();
  for (const [name, entry] of Object.entries(mapping)) {
    if (!name.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("BUNDLE_CONNECTIONS entries must be named connection records.");
    }
    for (const [key, value] of Object.entries(entry)) {
      if (!connectionFields.includes(key as typeof connectionFields[number]) || typeof value !== "string") {
        throw new Error("BUNDLE_CONNECTIONS entries may contain only string-valued DB_CONNECTION, DB_DATABASE, DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, and DATABASE_URL fields.");
      }
    }
    const record = entry as Environment;
    if (!record.DB_CONNECTION || !drivers.has(record.DB_CONNECTION)) {
      throw new Error("Each BUNDLE_CONNECTIONS entry must set DB_CONNECTION to sqlite, postgresql, or mariadb.");
    }
    connections.set(name, record);
  }
  return connections;
}

function escapesRoot(root: string, directory: string): boolean {
  const path = relative(root, directory);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/** Resolve an explicit connection and one existing migration directory, without connecting. */
export async function resolveTarget(
  env: Environment,
  root: string,
  options: { database?: string; path?: string; realpath?: boolean },
): Promise<{ env: Environment; migrationsPath?: string }> {
  const connections = namedConnections(env.BUNDLE_CONNECTIONS);
  const targetEnv = { ...env };
  if (options.database !== undefined) {
    const entry = connections.get(options.database);
    if (entry) {
      // A named connection is a complete target, never a partial credential overlay.
      for (const key of connectionFields) delete targetEnv[key];
      Object.assign(targetEnv, entry);
    } else if (drivers.has(options.database)) {
      targetEnv.DB_CONNECTION = options.database;
    } else {
      throw new Error("Unknown database connection. Define it in BUNDLE_CONNECTIONS or select sqlite, postgresql, or mariadb.");
    }
  }

  if (options.path === undefined) return { env: targetEnv };
  if (typeof options.path !== "string" || !options.path.trim() || options.path.includes(",") || options.path.includes("\0")) {
    throw new Error("--path must select a single migration directory.");
  }
  if (isAbsolute(options.path) && !options.realpath) {
    throw new Error("Absolute migration paths require --realpath.");
  }
  const absoluteRoot = resolve(root);
  const directory = resolve(absoluteRoot, options.path);
  if (!options.realpath && escapesRoot(absoluteRoot, directory)) {
    throw new Error("Migration paths outside the project root require --realpath.");
  }
  let migrationsPath: string;
  let canonicalRoot: string;
  try {
    migrationsPath = await realpath(directory);
    canonicalRoot = options.realpath ? absoluteRoot : await realpath(absoluteRoot);
    if (!(await stat(migrationsPath)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error("--path must select an existing, accessible migration directory, not a file.");
  }
  if (!options.realpath && escapesRoot(canonicalRoot, migrationsPath)) {
    throw new Error("Migration paths resolving outside the project root require --realpath.");
  }
  return { env: targetEnv, migrationsPath };
}
