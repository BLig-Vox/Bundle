import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCache } from "./cache.ts";

test("cache persists, isolates namespaces, expires at the boundary and prunes tags", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-cache-"));
  try {
    const path = join(root, "cache.sqlite");
    let now = 1000;
    const a = new LocalCache(path, "a", () => now);
    a.put("key", { n: 1 }, { ttlMs: 10, tags: ["blue"] });
    const b = new LocalCache(path, "b", () => now);
    b.put("key", "other");
    a.close();
    const reopened = new LocalCache(path, "a", () => now);
    expect(reopened.get("key")).toEqual({ n: 1 });
    now = 1010;
    expect(reopened.get("key")).toBeUndefined();
    expect(reopened.pruneStaleTags()).toBe(1);
    reopened.put("one", 1, { tags: ["blue"] });
    reopened.put("two", 2, { tags: ["red"] });
    expect(reopened.clear(["blue"])).toBe(1);
    expect(reopened.get("two")).toBe(2);
    expect(b.get("key")).toBe("other");
    expect(reopened.forget("two")).toBe(true);
    reopened.close(); b.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
