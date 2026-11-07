import { afterEach, expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicAssetResponse } from "./static-assets.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

 test("static responses read the verified file descriptor after path replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-static-")); roots.push(root);
  const dist = join(root, "dist"); await mkdir(dist);
  const asset = join(dist, "index.html"); const outside = join(root, "private.html");
  await writeFile(asset, "safe static content"); await writeFile(outside, "outside secret");
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const response = await publicAssetResponse(rootHandle, new Request("http://app.invalid/", { headers: { accept: "text/html" } }));
    expect(response?.status).toBe(200);
    await rename(asset, join(dist, "old-index.html")); await symlink(outside, asset);
    expect(await response!.text()).toBe("safe static content");
  } finally { await rootHandle.close(); }
});

test("static responses reject symlinked path components", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-static-")); roots.push(root);
  const dist = join(root, "dist"), outside = join(root, "outside"); await mkdir(dist); await mkdir(outside);
  await writeFile(join(outside, "secret.js"), "private"); await symlink(outside, join(dist, "linked"));
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try { expect(await publicAssetResponse(rootHandle, new Request("http://app.invalid/linked/secret.js"))).toBeUndefined(); }
  finally { await rootHandle.close(); }
});
