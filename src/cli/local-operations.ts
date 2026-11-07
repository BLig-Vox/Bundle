import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { LocalCache } from "../cache/cache.ts";
import { loadConfiguration } from "../configuration/configuration.ts";
import { linkStorage, unlinkStorage } from "../storage/links.ts";

/**
 * Trusted code-only config/cache.ts may default-export { driver: "sqlite", namespace: "name" }.
 * Both fields are optional (defaults: sqlite, default); other drivers/fields are rejected.
 * The dedicated database is always .bundle-cache/cache.sqlite, never an ORM database.
 * Trusted config/storage.ts must export { links: { "public/name": "storage/target" } }.
 * Paths are root-relative and targets and destination parents must already be real directories.
 * Ownership lives in .bundle-storage-links.json; a stale .bundle-storage-links.lock requires manual inspection.
 * Filesystem checks assume the application tree is not concurrently renamed by an attacker.
 */
export function registerLocalOperations(program: Command, context: { root: string; env: Record<string, string | undefined>; output: (text: string) => void }): void {
  async function withCache<T>(fn: (cache: LocalCache) => T): Promise<T> {
    const config = (await loadConfiguration(context.root)).cache ?? {};
    if (Object.keys(config).some(key => key !== "driver" && key !== "namespace") || (config.driver !== undefined && config.driver !== "sqlite") || (config.namespace !== undefined && (typeof config.namespace !== "string" || !config.namespace))) throw new Error("Invalid or unsupported cache configuration.");
    const root = await realpath(context.root);
    const dir = join(root, ".bundle-cache");
    try { await mkdir(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Cache directory must be a real directory.");
    const path = join(dir, "cache.sqlite");
    try {
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("Cache database must be a regular unlinked file.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const cache = new LocalCache(path, (config.namespace as string | undefined) ?? "default");
    try { return fn(cache); } finally { cache.close(); }
  }
  async function storageLinks(): Promise<Record<string, string>> {
    const config = (await loadConfiguration(context.root)).storage;
    if (!config || Object.keys(config).some(key => key !== "links") || !config.links || typeof config.links !== "object" || Array.isArray(config.links) || Object.values(config.links).some(value => typeof value !== "string")) throw new Error("Storage configuration requires a links object of root-relative paths.");
    return config.links as Record<string, string>;
  }
  program.command("storage:link").description("Create configured owned storage links").action(async () => context.output(`Created ${await linkStorage(context.root, await storageLinks())} storage links.`));
  program.command("storage:unlink").description("Remove configured owned storage links").action(async () => context.output(`Removed ${await unlinkStorage(context.root, await storageLinks())} storage links.`));
  program.command("cache:forget <key>").description("Forget a key in the local cache").action(async (key: string) => context.output(await withCache(cache => cache.forget(key)) ? "Cache key removed." : "Cache key not found."));
  program.command("cache:clear").description("Clear the local cache namespace").option("--tag <tag...>", "Clear entries matching any tag").action(async (options: { tag?: string[] }) => context.output(`Removed ${await withCache(cache => cache.clear(options.tag))} cache entries.`));
  program.command("cache:prune-stale-tags").description("Remove expired entries and unused local cache tags").action(async () => context.output(`Pruned ${await withCache(cache => cache.pruneStaleTags())} stale tags.`));
}
