import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("a fresh process can unlink a link created by another process", () => {
 const root = mkdtempSync(join(tmpdir(), "bundle-storage-process-"));
 try {
  mkdirSync(join(root, "public")); mkdirSync(join(root, "data"));
  const module = new URL("./links.ts", import.meta.url).href;
  const prefix = `import {linkStorage,unlinkStorage} from ${JSON.stringify(module)}; const root=${JSON.stringify(root)}; const links={"public/assets":"data"}; `;
  const run = (code: string) => Bun.spawnSync([process.execPath, "-e", prefix + code], {env: {...process.env, BUN_OPTIONS:""}});
  const create = run("await linkStorage(root,links)");
  expect(create.exitCode).toBe(0);
  expect(readlinkSync(join(root, "public", "assets"))).toBe("../data");
  const remove = run("await unlinkStorage(root,links)");
  expect(remove.exitCode).toBe(0);
  expect(existsSync(join(root, "public", "assets"))).toBe(false);
 } finally { rmSync(root, {recursive:true, force:true}); }
});
