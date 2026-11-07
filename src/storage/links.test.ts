import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readlink, rm, symlink, writeFile, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkStorage, unlinkStorage } from "./links.ts";

test("only owned links are removed; unrelated files and links survive", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "public")); await mkdir(join(root, "data"));
  await writeFile(join(root, "public", "file"), "keep");
  await symlink("../data", join(root, "public", "other"));
  await linkStorage(root, { "public/assets": "data" });
  expect(await readlink(join(root, "public", "assets"))).toBe("../data");
  await unlinkStorage(root, { "public/assets": "data" });
  expect(await readFile(join(root, "public", "file"), "utf8")).toBe("keep");
  expect(await readlink(join(root, "public", "other"))).toBe("../data");
 } finally { await rm(root, {recursive:true, force:true}); }
});

test("refuses to unlink an owned path replaced with a regular file", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "public")); await mkdir(join(root, "data"));
  await linkStorage(root, {"public/assets":"data"});
  await rm(join(root, "public", "assets")); await writeFile(join(root, "public", "assets"), "keep");
  await expect(unlinkStorage(root, {"public/assets":"data"})).rejects.toThrow("ownership mismatch");
  expect(await readFile(join(root, "public", "assets"), "utf8")).toBe("keep");
 } finally { await rm(root, {recursive:true, force:true}); }
});

test("unlinks an owned dangling link without requiring its target", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "public")); await mkdir(join(root, "data"));
  await linkStorage(root, {"public/assets":"data"});
  await rm(join(root, "data"), {recursive:true});
  expect(await unlinkStorage(root, {"public/assets":"data"})).toBe(1);
  await expect(lstat(join(root, "public", "assets"))).rejects.toMatchObject({code:"ENOENT"});
 } finally { await rm(root, {recursive:true, force:true}); }
});

test("unlinks the recorded link after configuration changes", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "public")); await mkdir(join(root, "old")); await mkdir(join(root, "new"));
  await linkStorage(root, {"public/assets":"old"});
  expect(await unlinkStorage(root, {"public/assets":"new"})).toBe(1);
  expect(await linkStorage(root, {"public/assets":"new"})).toBe(1);
  expect(await readlink(join(root, "public", "assets"))).toBe("../new");
 } finally { await rm(root, {recursive:true, force:true}); }
});

test("recreates a manually removed owned destination", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "public")); await mkdir(join(root, "data"));
  await linkStorage(root, {"public/assets":"data"});
  await rm(join(root, "public", "assets"));
  expect(await linkStorage(root, {"public/assets":"data"})).toBe(1);
  expect(await unlinkStorage(root, {"public/assets":"data"})).toBe(1);
 } finally { await rm(root, {recursive:true, force:true}); }
});

test("reconciles an absent owned destination on unlink", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "public")); await mkdir(join(root, "data"));
  await linkStorage(root, {"public/assets":"data"});
  await rm(join(root, "public", "assets"));
  expect(await unlinkStorage(root, {"public/assets":"data"})).toBe(0);
  expect(await unlinkStorage(root, {"public/assets":"data"})).toBe(0);
  expect(await linkStorage(root, {"public/assets":"data"})).toBe(1);
 } finally { await rm(root, {recursive:true, force:true}); }
});

test("refuses a substituted symlink even when configuration changes", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "public")); await mkdir(join(root, "old")); await mkdir(join(root, "new"));
  await linkStorage(root, {"public/assets":"old"});
  await rm(join(root, "public", "assets"));
  await symlink("../new", join(root, "public", "assets"));
  await expect(unlinkStorage(root, {"public/assets":"new"})).rejects.toThrow("ownership mismatch");
  expect(await readlink(join(root, "public", "assets"))).toBe("../new");
 } finally { await rm(root, {recursive:true, force:true}); }
});

test("refuses an owned destination under a substituted symlink parent", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "public")); await mkdir(join(root, "data")); await mkdir(join(root, "other"));
  await linkStorage(root, {"public/assets":"data"});
  await rm(join(root, "public"), {recursive:true});
  await writeFile(join(root, "other", "assets"), "keep");
  await symlink("other", join(root, "public"));
  await expect(unlinkStorage(root, {"public/assets":"data"})).rejects.toThrow("real directories");
  expect(await readFile(join(root, "other", "assets"), "utf8")).toBe("keep");
 } finally { await rm(root, {recursive:true, force:true}); }
});

test("refuses path escapes and symlinked parents", async () => {
 const root = await mkdtemp(join(tmpdir(), "bundle-storage-"));
 try {
  await mkdir(join(root, "data")); await symlink("data", join(root, "alias"));
  await expect(linkStorage(root, { "../outside": "data" })).rejects.toThrow();
  await expect(linkStorage(root, { "alias/link": "data" })).rejects.toThrow();
 } finally { await rm(root, {recursive:true, force:true}); }
});
