import { lstat, mkdir, open, readFile, readlink, realpath, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

type Entry = { target: string; dev: number; ino: number };
type Manifest = Record<string, Entry>;
const manifestName = ".bundle-storage-links.json";
const lockName = ".bundle-storage-links.lock";
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function validatePath(path: string): void {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/).some(p => !p || p === "." || p === "..") || path.includes("\\") || [manifestName, lockName].includes(path.split("/")[0]!)) throw new Error("Invalid storage path.");
}
async function directory(root: string, path: string): Promise<void> {
  if (!path) return;
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Storage paths require real directories.");
  }
}
async function readManifest(root: string): Promise<Manifest> {
  const path = join(root, manifestName);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe storage manifest.");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid storage manifest.");
    const result: Manifest = Object.create(null);
    for (const [name, value] of Object.entries(parsed)) {
      validatePath(name);
      if (!value || typeof value !== "object" || typeof value.target !== "string" || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino)) throw new Error("Invalid storage manifest entry.");
      result[name] = { target: value.target, dev: value.dev, ino: value.ino };
    }
    return result;
  } catch (error) { if (missing(error)) return Object.create(null) as Manifest; throw error; }
}
async function saveManifest(root: string, manifest: Manifest): Promise<void> {
  const temp = join(root, `.bundle-storage-${crypto.randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(manifest)); } finally { await file.close(); }
  try { await rename(temp, join(root, manifestName)); } catch (error) { await unlink(temp); throw error; }
}
async function withLock<T>(rootPath: string, fn: (root: string, manifest: Manifest) => Promise<T>): Promise<T> {
  const root = await realpath(rootPath);
  const lock = join(root, lockName);
  await mkdir(lock, { mode: 0o700 });
  try { return await fn(root, await readManifest(root)); } finally { await rmdir(lock); }
}
function validateLinks(links: Record<string, string>): void {
  if (!links || typeof links !== "object" || Array.isArray(links)) throw new Error("Storage links must be an object.");
  for (const [path, target] of Object.entries(links)) { validatePath(path); validatePath(target); }
}
async function inspect(root: string, path: string, target: string): Promise<string> {
  await directory(root, dirname(path) === "." ? "" : dirname(path));
  await directory(root, target);
  return relative(dirname(join(root, path)), join(root, target)) || ".";
}
async function owned(path: string, entry: Entry): Promise<boolean> {
  try { const info = await lstat(path); return info.isSymbolicLink() && info.dev === entry.dev && info.ino === entry.ino && await readlink(path) === entry.target; }
  catch (error) { if (missing(error)) return false; throw error; }
}
/** Create only absent links to existing real directories. Config paths are root-relative. */
export async function linkStorage(rootPath: string, links: Record<string, string>): Promise<number> {
  validateLinks(links);
  return withLock(rootPath, async (root, manifest) => {
    let count = 0;
    for (const [name, target] of Object.entries(links)) {
      const expected = await inspect(root, name, target);
      const path = join(root, name);
      const previous = manifest[name];
      if (previous && previous.target === expected && await owned(path, previous)) continue;
      try { await lstat(path); throw new Error(`Storage destination exists: ${name}`); } catch (error) { if (!missing(error)) throw error; }
      await symlink(expected, path, "dir");
      const stat = await lstat(path);
      manifest[name] = { target: expected, dev: stat.dev, ino: stat.ino };
      try { await saveManifest(root, manifest); } catch (error) { if (await owned(path, manifest[name]!)) await unlink(path); throw error; }
      count++;
    }
    return count;
  });
}
/** Remove configured destinations only when their recorded link identity still matches. */
export async function unlinkStorage(rootPath: string, links: Record<string, string>): Promise<number> {
  validateLinks(links);
  return withLock(rootPath, async (root, manifest) => {
    let count = 0;
    for (const name of Object.keys(links)) {
      const entry = manifest[name];
      if (!entry) continue;
      await directory(root, dirname(name) === "." ? "" : dirname(name));
      const path = join(root, name);
      let exists = true;
      try { await lstat(path); } catch (error) { if (!missing(error)) throw error; exists = false; }
      if (exists) {
        if (!await owned(path, entry)) throw new Error(`Storage link ownership mismatch: ${name}`);
        await unlink(path);
        count++;
      }
      delete manifest[name];
      await saveManifest(root, manifest);
    }
    return count;
  });
}
