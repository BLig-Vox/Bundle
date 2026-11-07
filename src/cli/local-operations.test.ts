import { expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerLocalOperations } from "./local-operations.ts";
import { LocalCache } from "../cache/cache.ts";

test("storage commands consume trusted code configuration", async () => {
 const root = mkdtempSync(join(tmpdir(), "bundle-storage-cli-"));
 try {
  mkdirSync(join(root, "config")); mkdirSync(join(root, "public")); mkdirSync(join(root, "data"));
  writeFileSync(join(root, "config", "storage.ts"), 'export default { links: { "public/assets": "data" } };');
  const create = new Command(); registerLocalOperations(create, {root, env: {}, output: () => {}});
  await create.parseAsync(["storage:link"], {from:"user"});
  expect(readlinkSync(join(root, "public", "assets"))).toBe("../data");
  const remove = new Command(); registerLocalOperations(remove, {root, env: {}, output: () => {}});
  await remove.parseAsync(["storage:unlink"], {from:"user"});
  expect(existsSync(join(root, "public", "assets"))).toBe(false);
 } finally { rmSync(root, {recursive:true, force:true}); }
});

test("cache commands operate on the configured local namespace", async () => {
 const root = mkdtempSync(join(tmpdir(), "bundle-local-"));
 try {
  mkdirSync(join(root, ".bundle-cache"));
  const cache = new LocalCache(join(root, ".bundle-cache", "cache.sqlite"), "default"); cache.put("x", 1); cache.close();
  const output: string[] = [];
  const program = new Command(); registerLocalOperations(program, { root, env: {}, output: text => output.push(text) });
  await program.parseAsync(["cache:forget", "x"], {from:"user"});
  const check = new LocalCache(join(root, ".bundle-cache", "cache.sqlite"), "default"); expect(check.get("x")).toBeUndefined(); check.close();
 } finally { rmSync(root, {recursive:true, force:true}); }
});

test("unsupported configured stores fail without creating a database", async () => {
 const root = mkdtempSync(join(tmpdir(), "bundle-local-config-"));
 try {
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "cache.ts"), 'export default { driver: "redis" };');
  const program = new Command(); registerLocalOperations(program, {root, env: {}, output: () => {}});
  await expect(program.parseAsync(["cache:clear"], {from:"user"})).rejects.toThrow("unsupported cache configuration");
  expect(existsSync(join(root, ".bundle-cache"))).toBe(false);
 } finally { rmSync(root, {recursive:true, force:true}); }
});

test("cache commands refuse a symlinked cache directory", async () => {
 const root = mkdtempSync(join(tmpdir(), "bundle-local-"));
 const other = mkdtempSync(join(tmpdir(), "bundle-other-"));
 try {
  symlinkSync(other, join(root, ".bundle-cache"));
  const program = new Command(); registerLocalOperations(program, { root, env: {}, output: () => {} });
  await expect(program.parseAsync(["cache:clear"], {from:"user"})).rejects.toThrow();
 } finally { rmSync(root, {recursive:true, force:true}); rmSync(other, {recursive:true, force:true}); }
});
