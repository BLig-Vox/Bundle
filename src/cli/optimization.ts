import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { cacheConfiguration, clearConfiguration } from "../configuration/configuration.ts";
import { cacheRoutes, clearRouteCache } from "../http/route-cache.ts";
import { cacheEvents, clearEventCache } from "../events/cache.ts";

interface Target {
  name: string;
  source?: string;
  cache: string;
  build(overwrite: boolean): Promise<unknown>;
  clear(): Promise<unknown>;
}
interface Operation {
  target: string;
  status: "completed" | "failed" | "skipped";
  reason?: "not-configured";
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Aggregate real bootstrap caches. Partial writes are reported, not rolled back or hidden. */
export function registerOptimization(program: Command, context: { root: string; output: (text: string) => void }): void {
  const { root, output } = context;
  const targets: Target[] = [
    { name: "configuration", cache: "config.json", build: overwrite => cacheConfiguration(root, { overwrite }), clear: () => clearConfiguration(root) },
    { name: "routes", source: "routes.ts", cache: "routes.json", build: overwrite => cacheRoutes(root, { overwrite }), clear: () => clearRouteCache(root) },
    { name: "events", source: "events.ts", cache: "events.json", build: overwrite => cacheEvents(root, { overwrite }), clear: () => clearEventCache(root) },
  ];
  for (const clear of [false, true]) {
    program.command(clear ? "optimize:clear" : "optimize")
      .description(clear ? "Clear supported bootstrap caches, preserving application data and locks" : "Build configured bootstrap caches; replacement requires --force")
      .action(async () => {
        const operations: Operation[] = [];
        for (const target of targets) {
          try {
            if (!clear && target.source && !await exists(join(root, target.source)) && !await exists(join(root, "bootstrap", "cache", target.cache))) {
              operations.push({ target: target.name, status: "skipped", reason: "not-configured" });
              continue;
            }
            if (clear) await target.clear();
            else await target.build(program.opts().force === true);
            operations.push({ target: target.name, status: "completed" });
          } catch {
            // Trusted modules may throw credentials or arbitrary secret-bearing text.
            operations.push({ target: target.name, status: "failed" });
          }
        }
        output(JSON.stringify({ action: clear ? "clear" : "cache", operations }));
        if (operations.some(operation => operation.status === "failed")) throw new Error("One or more optimization operations failed; inspect the reported targets and trusted source paths.");
      });
  }
}
