import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "./store";

test("competing processes cannot simultaneously claim and a crashed claim expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-queue-process-")); const path = join(dir, "q.sqlite");
  const store = new QueueStore(path, () => 1000);
  try {
    store.enqueue("q", { module: "jobs/Run.ts", export: "Run", payload: null }, { maxAttempts: 2 });
    const modulePath = join(import.meta.dir, "store.ts");
    const code = `import { QueueStore } from ${JSON.stringify(modulePath)}; const s = new QueueStore(process.argv[1], () => 1000); const r=s.reserve(['q'], {leaseMs: 50}); console.log(JSON.stringify(r)); process.exit(0);`;
    const args = [process.execPath, "-e", code, path];
    const a = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
    const b = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
    const [ac, bc, outA, outB, errA, errB] = await Promise.all([a.exited, b.exited, new Response(a.stdout).text(), new Response(b.stdout).text(), new Response(a.stderr).text(), new Response(b.stderr).text()]);
    expect([ac, bc], `${errA} ${errB}`).toEqual([0, 0]);
    const results = [JSON.parse(outA), JSON.parse(outB)];
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.reserve(["q"])).toBeNull();
    store.close();
    const recovered = new QueueStore(path, () => 1050);
    try { const claim = recovered.reserve(["q"]); expect(claim?.attempt).toBe(2); expect(claim?.id).toBe(results.find(Boolean).id); }
    finally { recovered.close(); }
  } finally { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});
