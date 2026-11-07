import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptEnvironment, encryptEnvironment, generateApplicationKey, updateApplicationKey } from "./environment.ts";

test("keys are random and key updates preserve other dotenv text without returning secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-env-"));
  try {
    const first = generateApplicationKey();
    expect(first).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
    expect(first).not.toBe(generateApplicationKey());
    await writeFile(join(root, ".env"), "OTHER=value\r\nAPP_KEY=old # keep\r\n");
    await expect(updateApplicationKey(root, first)).rejects.toThrow();
    expect(await readFile(join(root, ".env"), "utf8")).toContain("APP_KEY=old");
    expect(JSON.stringify(await updateApplicationKey(root, first, { force: true }))).not.toContain(first);
    expect(await readFile(join(root, ".env"), "utf8")).toBe(`OTHER=value\r\nAPP_KEY=${first} # keep\r\n`);
    expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("authenticated encryption refuses wrong keys, tampering, collisions and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-env-"));
  try {
    const path = join(root, ".env"), encrypted = join(root, ".env.encrypted");
    const key = generateApplicationKey();
    await writeFile(path, "SECRET=hello\n");
    await encryptEnvironment(root, key);
    expect((await stat(encrypted)).mode & 0o777).toBe(0o600);
    await expect(encryptEnvironment(root, key)).rejects.toThrow();
    await unlink(path);
    await expect(decryptEnvironment(root, generateApplicationKey())).rejects.toThrow();
    const envelope = JSON.parse(await readFile(encrypted, "utf8"));
    envelope.tag = Buffer.alloc(16).toString("base64");
    const original = await readFile(encrypted);
    await writeFile(encrypted, JSON.stringify(envelope));
    await expect(decryptEnvironment(root, key)).rejects.toThrow();
    await writeFile(encrypted, original);
    await decryptEnvironment(root, key);
    expect(await readFile(path, "utf8")).toBe("SECRET=hello\n");
    await unlink(path);
    await symlink(encrypted, path);
    await expect(decryptEnvironment(root, key, { force: true })).rejects.toThrow();
    expect(await readFile(encrypted)).toEqual(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
