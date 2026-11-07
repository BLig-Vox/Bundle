import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";

/** A dedicated SQLite file, independent of application databases. Values must be JSON serializable. */
export class LocalCache {
  private db: Database;
  constructor(path: string, private namespace: string, private clock: () => number = Date.now) {
    if (!namespace) throw new Error("Cache namespace must not be empty.");
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("Cache database must be a regular unlinked file.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    try {
      this.db.transaction(() => {
        const id = this.db.query("PRAGMA application_id").get() as { application_id: number };
        const objects = this.db.query("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all();
        if (id.application_id !== 0x424c4348 && (id.application_id !== 0 || objects.length !== 0)) throw new Error("Not a Bundle cache database.");
        this.db.exec("PRAGMA application_id=1112294216");
        this.db.exec(`CREATE TABLE IF NOT EXISTS entries (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires REAL, PRIMARY KEY(namespace,key));
      CREATE TABLE IF NOT EXISTS tags (namespace TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(namespace,tag));
      CREATE TABLE IF NOT EXISTS entry_tags (namespace TEXT NOT NULL, key TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(namespace,key,tag), FOREIGN KEY(namespace,key) REFERENCES entries(namespace,key) ON DELETE CASCADE, FOREIGN KEY(namespace,tag) REFERENCES tags(namespace,tag));`);
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }
  put(key: string, value: unknown, options: { ttlMs?: number; tags?: string[] } = {}): void {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Cache value must be JSON serializable.");
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs < 0)) throw new Error("Invalid cache TTL.");
    if (options.tags?.some(tag => typeof tag !== "string" || !tag)) throw new Error("Invalid cache tag.");
    const expiry = options.ttlMs === undefined ? null : this.clock() + options.ttlMs;
    this.db.transaction(() => {
      this.db.query("DELETE FROM entries WHERE namespace=? AND key=?").run(this.namespace, key);
      this.db.query("INSERT INTO entries VALUES(?,?,?,?)").run(this.namespace, key, json, expiry);
      for (const tag of new Set(options.tags ?? [])) {
        this.db.query("INSERT OR IGNORE INTO tags VALUES(?,?)").run(this.namespace, tag);
        this.db.query("INSERT INTO entry_tags VALUES(?,?,?)").run(this.namespace, key, tag);
      }
    })();
  }
  get(key: string): unknown {
    const row = this.db.query("SELECT value, expires FROM entries WHERE namespace=? AND key=?").get(this.namespace, key) as { value: string; expires: number | null } | null;
    if (!row || (row.expires !== null && row.expires <= this.clock())) return undefined;
    return JSON.parse(row.value);
  }
  forget(key: string): boolean { return this.db.query("DELETE FROM entries WHERE namespace=? AND key=?").run(this.namespace, key).changes > 0; }
  clear(tags?: string[]): number {
    if (tags !== undefined && (!tags.length || tags.some(tag => !tag))) throw new Error("At least one nonempty tag is required.");
    if (!tags) return this.db.query("DELETE FROM entries WHERE namespace=?").run(this.namespace).changes;
    const placeholders = tags.map(() => "?").join(",");
    return this.db.query(`DELETE FROM entries WHERE namespace=? AND key IN (SELECT key FROM entry_tags WHERE namespace=? AND tag IN (${placeholders}))`).run(this.namespace, this.namespace, ...tags).changes;
  }
  pruneStaleTags(): number {
    return this.db.transaction(() => {
      this.db.query("DELETE FROM entries WHERE namespace=? AND expires IS NOT NULL AND expires<=?").run(this.namespace, this.clock());
      return this.db.query("DELETE FROM tags WHERE namespace=? AND NOT EXISTS (SELECT 1 FROM entry_tags e WHERE e.namespace=tags.namespace AND e.tag=tags.tag)").run(this.namespace).changes;
    })();
  }
  close(): void { this.db.close(); }
}
