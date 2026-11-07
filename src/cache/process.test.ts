import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCache } from "./cache.ts";

test("a fresh Bun process reads committed entries", () => {
 const dir = mkdtempSync(join(tmpdir(), "bundle-cache-process-"));
 try {
  const path = join(dir, "cache.sqlite");
  const cache = new LocalCache(path, "jobs"); cache.put("message", "persisted"); cache.close();
  const module = new URL("./cache.ts", import.meta.url).href;
  const result = Bun.spawnSync([process.execPath, "-e", `import { LocalCache } from ${JSON.stringify(module)}; const c = new LocalCache(${JSON.stringify(path)}, 'jobs'); console.log(c.get('message')); c.close();`], { env: { ...process.env, BUN_OPTIONS: "" } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("persisted");
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
