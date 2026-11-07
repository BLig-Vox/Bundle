import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Non-waiting process-wide lock. The project tree must not be concurrently manipulated by an adversary. */
export async function acquireCommandLock(root: string, key: string): Promise<null | (() => Promise<void>)> {
  const canonicalRoot = await realpath(root);
  const parent = join(canonicalRoot, ".bundle-command-locks");
  try { await mkdir(parent, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Unsafe command lock directory.");
  const path = join(parent, createHash("sha256").update(key).digest("hex") + ".lock");
  const token = randomBytes(32).toString("hex");
  let file;
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing;
    try { existing = await lstat(path); } catch (inspectionError) {
      // The exclusive create already observed contention; its owner may have
      // released before inspection. Treat that completed race as a skip.
      if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw inspectionError;
    }
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) throw new Error("Unsafe command lock artifact.");
    // An unlinked inode can be returned by lstat when release races inspection.
    return null;
  }
  const identity = await file.stat();
  try {
    await file.writeFile(token);
  } catch (error) {
    await file.close();
    const current = await lstat(path);
    if (current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
    throw error;
  }
  return async () => {
    try {
      const currentParent = await lstat(parent);
      const current = await lstat(path);
      if (!currentParent.isDirectory() || currentParent.isSymbolicLink() || currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino ||
          !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error("Command lock owner artifact was replaced; refusing release.");
      }
      const contents = Buffer.alloc(65);
      const read = await file.read(contents, 0, contents.length, 0);
      if (contents.subarray(0, read.bytesRead).toString() !== token) throw new Error("Command lock owner token changed; refusing release.");
      await unlink(path);
    } finally { await file.close(); }
  };
}
