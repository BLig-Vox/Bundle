import { test, expect } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableMaintenance, disableMaintenance, readMaintenance, maintenanceResponse } from "./maintenance.ts";

test("maintenance persists and supplies a real 503 response until removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-down-"));
  try {
    expect(await maintenanceResponse(root, new Request("http://localhost/"))).toBeUndefined();
    await enableMaintenance(root, { retrySeconds: 0, refreshSeconds: 30 });
    const path = join(root, "storage/framework/down.json");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readMaintenance(root)).toEqual({ version: 1, retrySeconds: 0, refreshSeconds: 30 });
    const response = (await maintenanceResponse(root, new Request("http://localhost/")))!;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("0");
    expect(response.headers.get("refresh")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Service Unavailable" });
    await enableMaintenance(root);
    expect(await readMaintenance(root)).toEqual({ version: 1 });
    expect(await disableMaintenance(root)).toBe(true);
    expect(await disableMaintenance(root)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing maintenance state with unsafe permissions is refused and preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-down-mode-"));
  try {
    await enableMaintenance(root);
    const path = join(root,"storage/framework/down.json");
    await chmod(path,0o644);
    await expect(readMaintenance(root)).rejects.toThrow();
    await expect(disableMaintenance(root)).rejects.toThrow();
    await expect(enableMaintenance(root,{retrySeconds:1})).rejects.toThrow();
    expect(await readFile(path,"utf8")).toContain('"version":1');
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test("invalid options and corrupted or unsafe state are refused and preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-down-"));
  try {
    for (const options of [{ retrySeconds: -1 }, { retrySeconds: 86401 }, { refreshSeconds: 0 }, { refreshSeconds: 1.1 }, { secret: "x" }]) {
      await expect(enableMaintenance(root, options)).rejects.toThrow();
    }
    await mkdir(join(root, "storage/framework"), { recursive: true });
    const path = join(root, "storage/framework/down.json");
    await writeFile(path, '{"version":1,"unknown":true}');
    await expect(enableMaintenance(root)).rejects.toThrow();
    await expect(disableMaintenance(root)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toContain("unknown");
    await rm(path);
    await writeFile(join(root, "other"), "x");
    await symlink(join(root, "other"), path);
    await expect(readMaintenance(root)).rejects.toThrow();
    await rm(path);
    await link(join(root, "other"), path);
    await expect(disableMaintenance(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
