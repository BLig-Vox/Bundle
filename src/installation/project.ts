import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseConnection } from "../database/config.ts";
import { projectSources, renderProjectFiles, type ProjectPackageDependencies } from "./templates.ts";

export interface CreateProjectOptions {
  readonly parent: string;
  readonly name: string;
  readonly driver?: DatabaseConnection;
  readonly http?: boolean;
  readonly signal?: AbortSignal;
}
export interface CreatedProject {
  readonly directory: string;
  readonly driver: DatabaseConnection;
  readonly testing: "bun";
  readonly http: boolean;
  readonly files: readonly string[];
  readonly dependenciesInstalled: false;
}
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const maximumFileBytes = 1024 * 1024;
const maximumTotalBytes = 16 * 1024 * 1024;
const dependencyNames = {
  dependencies: ["@mikro-orm/core", "@mikro-orm/mariadb", "@mikro-orm/migrations", "@mikro-orm/postgresql", "@mikro-orm/seeder", "@mikro-orm/sqlite", "commander", "tinyglobby"],
  devDependencies: ["@mikro-orm/cli", "@tailwindcss/vite", "@types/bun", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "class-variance-authority", "clsx", "lucide-react", "react", "react-dom", "tailwindcss", "tailwind-merge", "vite"],
  peerDependencies: ["typescript"],
} as const;

export function validateProjectName(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error("Use a lowercase application name containing 1–64 ASCII letters, numbers or hyphens, starting with a letter.");
  return value;
}
function check(signal?: AbortSignal) { if (signal?.aborted) throw new Error("Application creation cancelled; earlier new files may remain."); }
async function directory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Application/template ancestors must be real directories.");
}
function safePath(path: string) {
  if (!path || path.length > 256 || path.split("/").some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) throw new Error("Invalid bundled application path.");
}
async function source(path: string, root: string, signal?: AbortSignal): Promise<Uint8Array> {
  safePath(path); check(signal);
  let parent = root;
  for (const part of path.split("/").slice(0, -1)) { parent = join(parent, part); await directory(parent); check(signal); }
  const filename = join(root, path);
  const before = await lstat(filename); check(signal);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumFileBytes) throw new Error("Application template must be a bounded regular single-link file.");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); check(signal);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximumFileBytes || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("Application template identity changed.");
    // Bounded reads also handle a source that grows after the initial stat.
    const buffer = new Uint8Array(maximumFileBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null); check(signal);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    const after = await handle.stat(); check(signal);
    if (size > maximumFileBytes || !after.isFile() || after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Application template changed or exceeded its size bound.");
    return buffer.slice(0, size);
  } finally { await handle.close(); }
}
function dependencies(bytes: Uint8Array): ProjectPackageDependencies {
  const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!input || typeof input !== "object") throw new Error("Invalid bundled package metadata.");
  const result: ProjectPackageDependencies = { dependencies: {}, devDependencies: {}, peerDependencies: {} };
  for (const group of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const entries = (input as Record<string, unknown>)[group];
    if (!entries || typeof entries !== "object") throw new Error("Missing bundled dependency metadata.");
    for (const name of dependencyNames[group]) {
      const version: unknown = (entries as Record<string, unknown>)[name];
      // Never copy registry URLs, arbitrary scripts or credential-bearing dependency specs.
      if (typeof version !== "string" || !/^(?:latest|[~^]?\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?)$/.test(version)) throw new Error("Unsupported bundled dependency version.");
      result[group][name] = version;
    }
  }
  const ormVersions = new Set([...Object.entries(result.dependencies), ...Object.entries(result.devDependencies)]
    .filter(([name]) => name.startsWith("@mikro-orm/")).map(([, version]) => version));
  if (ormVersions.size !== 1) throw new Error("Bundled ORM dependency versions must match.");
  return result;
}

/** Offline new-directory publication; never imports assets or runs a subprocess. */
export async function createProject(input: CreateProjectOptions): Promise<CreatedProject> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("Invalid application creation options.");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !["parent", "name", "driver", "http", "signal"].includes(key) || !("value" in descriptors[key]!))) throw new Error("Invalid application creation options.");
  const { parent, name, driver = "sqlite", http = true, signal } = input;
  validateProjectName(name);
  if (typeof parent !== "string" || !isAbsolute(parent) || !["sqlite", "postgresql", "mariadb"].includes(driver) || typeof http !== "boolean" || (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error("Invalid application creation options.");
  check(signal);
  const canonicalParent = await realpath(parent); check(signal); await directory(canonicalParent); check(signal);
  const destination = join(canonicalParent, name);
  try { await lstat(destination); throw new Error("Application destination already exists; no overwrite is supported."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  check(signal);
  const canonicalSource = await realpath(sourceRoot); check(signal); await directory(canonicalSource);
  const packageDependencies = dependencies(await source("package.json", canonicalSource, signal));
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const path of projectSources) {
    if (files.has(path)) throw new Error("Duplicate bundled application source.");
    const bytes = await source(path, canonicalSource, signal); total += bytes.length;
    if (total > maximumTotalBytes) throw new Error("Application template exceeds its size bound.");
    files.set(path, bytes);
  }
  for (const [path, content] of renderProjectFiles(name, driver, http, packageDependencies)) {
    safePath(path);
    if (files.has(path)) throw new Error("Duplicate generated application destination.");
    const bytes = new TextEncoder().encode(content); total += bytes.length;
    if (bytes.length > maximumFileBytes || total > maximumTotalBytes) throw new Error("Application template exceeds its size bound.");
    files.set(path, bytes);
  }
  check(signal);
  // Atomic exclusive destination claim; a race never permits merging into a directory.
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const [path, bytes] of files) {
      check(signal); await directory(destination); check(signal);
      const parts = path.split("/"); let current = destination;
      for (const part of parts.slice(0, -1)) {
        current = join(current, part); check(signal);
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await directory(current); check(signal);
      }
      const handle = await open(join(destination, path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { check(signal); await handle.writeFile(bytes); check(signal); }
      finally { await handle.close(); }
    }
    check(signal);
    return Object.freeze({ directory: destination, driver, testing: "bun", http, dependenciesInstalled: false, files: Object.freeze([...files.keys()]) });
  } catch (cause) { throw new Error("Application creation did not complete; earlier new files may remain. No rollback deletion was performed.", { cause }); }
}
