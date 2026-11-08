import { link, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

export async function ensureDirectory(directory: string) {
  try { await mkdir(directory); } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  // Do not follow preexisting symlinks out of the project's generated location.
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("Generation requires each of src and the destination to be a real directory (no symlinks).");
  }
}

/** Publish editable source exclusively; trusted parent directories are required. */
export async function generateSource(root: string, name: string, kind: "page" | "route" | "request" | "job", sourceText: (name: string) => string, io: { writeFile?: typeof writeFile } = {}): Promise<string> {
  validateSourceName(name);
  // Existing ancestors, including root itself, must not redirect publication.
  for (let path = resolve(root);; path = dirname(path)) {
    if (!(await lstat(path)).isDirectory()) throw new Error("Generation requires real directories without symlinks.");
    if (dirname(path) === path) break;
  }
  const text = sourceText(name);
  const source = resolve(root, "src");
  const directory = join(source, `${kind}s`);
  await ensureDirectory(source);
  await ensureDirectory(directory);
  const relative = `src/${kind}s/${name}.ts`;
  const destination = join(directory, `${name}.ts`);
  const temporary = await mkdtemp(join(directory, `.bundle-${kind}-`));
  try {
    const staged = join(temporary, `${kind}.ts`);
    await (io.writeFile ?? writeFile)(staged, text, { flag: "wx", mode: 0o644 });
    // Publish the complete file atomically, failing for ANY existing directory
    // entry (including dangling symlinks). Rename would overwrite on POSIX.
    try { await link(staged, destination); } catch (error) {
      if (errorCode(error) === "EEXIST") throw new Error(`${kind[0]!.toUpperCase() + kind.slice(1)} already exists: ${relative}. Choose another name.`);
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return relative;
}

export function validateSourceName(name: string): void {
  if (name.match(/^[A-Z][A-Za-z0-9]*/)?.[0] !== name || !name || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(name)) {
    throw new Error("Use a PascalCase name containing only ASCII letters and numbers, e.g. Dashboard; reserved device names are not allowed.");
  }
}
