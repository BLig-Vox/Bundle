import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMaintenance, enableMaintenance, disableMaintenance } from "./maintenance.ts";

test("duplicate JSON keys are corrupt and cannot be replaced or removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-down-strict-"));
  try {
    await mkdir(join(root, "storage/framework"), { recursive: true });
    const path = join(root, "storage/framework/down.json");
    const data = '{"version":1,"retrySeconds":2,"retrySeconds":3}';
    await writeFile(path, data);
    await expect(readMaintenance(root)).rejects.toThrow();
    await expect(enableMaintenance(root)).rejects.toThrow();
    await expect(disableMaintenance(root)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(data);
    await writeFile(path, '{"version":1,"retrySeconds":2,"retry\\u0053econds":3}');
    await expect(readMaintenance(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsafe parents and existing locks are never modified", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-down-strict-"));
  try {
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, "storage"));
    await expect(enableMaintenance(root)).rejects.toThrow();
    await rm(join(root, "storage"));
    await mkdir(join(root, "storage/framework"), { recursive: true });
    const lock = join(root, "storage/framework/.down.lock");
    await writeFile(lock, "foreign");
    await expect(enableMaintenance(root)).rejects.toThrow();
    await expect(disableMaintenance(root)).rejects.toThrow();
    expect(await readFile(lock, "utf8")).toBe("foreign");
  } finally { await rm(root, { recursive: true, force: true }); }
});
