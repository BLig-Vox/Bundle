import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCache } from "./cache.ts";

test("refuses a database symlink", () => {
 const dir = mkdtempSync(join(tmpdir(), "bundle-cache-link-"));
 try {
  const real = join(dir, "real.sqlite"); const cache = new LocalCache(real, "a"); cache.close();
  const link = join(dir, "link.sqlite"); symlinkSync(real, link);
  expect(() => new LocalCache(link, "a")).toThrow();
 } finally { rmSync(dir, {recursive:true, force:true}); }
});
