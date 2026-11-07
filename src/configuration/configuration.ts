import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type ConfigurationValue = null | boolean | number | string | ConfigurationValue[] | ConfigurationObject;
export interface ConfigurationObject {
  [key: string]: ConfigurationValue;
}
export type ApplicationConfiguration = Record<string, ConfigurationObject>;
export interface LoadConfigurationOptions {
  /** Defaults to true. False bypasses the disk cache, not Bun's process-local ESM module cache. */
  useCache?: boolean;
}

const cacheParts = ["bootstrap", "cache"] as const;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertKey(key: string, location: string, filename = false): void {
  if (forbiddenKeys.has(key) || (filename && !identifier.test(key))) {
    throw new Error(`Invalid configuration key ${JSON.stringify(key)} at ${location}; filenames must be ASCII identifiers and prototype-pollution keys are forbidden.`);
  }
}

function invalid(location: string, reason: string): never {
  throw new Error(`Invalid configuration at ${location}: ${reason}. Configuration must be losslessly JSON-compatible data.`);
}

/** Validate and copy data without invoking getters or toJSON hooks. Shared references are OK; cycles are not. */
function copyValue(value: unknown, location: string, ancestors = new Set<object>()): ConfigurationValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalid(location, "non-finite numbers and negative zero are not supported");
    return value;
  }
  if (typeof value !== "object") invalid(location, `${typeof value} values are not supported`);
  if (ancestors.has(value)) invalid(location, "cyclic references are not supported");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    invalid(location, "only plain objects and ordinary arrays are supported");
  }
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === "symbol")) invalid(location, "symbol keys are not supported");
    if (array) {
      if (keys.length !== value.length + 1) invalid(location, "sparse arrays and extra array properties are not supported");
      const result: ConfigurationValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          invalid(`${location}[${index}]`, "array holes, accessors, and non-enumerable elements are not supported");
        }
        result.push(copyValue(descriptor.value, `${location}[${index}]`, ancestors));
      }
      return result;
    }
    const result: ConfigurationObject = {};
    for (const key of (keys as string[]).sort()) {
      assertKey(key, location);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) invalid(`${location}.${key}`, "accessors and non-enumerable properties are not supported");
      result[key] = copyValue(descriptor.value, `${location}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function copyObject(value: unknown, location: string): ConfigurationObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(location, "expected a plain object");
  return copyValue(value, location) as ConfigurationObject;
}

function validateRecord(value: unknown): ApplicationConfiguration {
  const record = copyObject(value, "configuration record");
  for (const key of Object.keys(record)) {
    assertKey(key, "configuration record", true);
    const object = record[key];
    if (object === null || typeof object !== "object" || Array.isArray(object)) invalid(key, "each file must export a plain object");
  }
  return record as ApplicationConfiguration;
}

function assertWithin(root: string, target: string): void {
  const path = relative(root, target);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) throw new Error("Configuration path escapes the canonical project root.");
}

async function assertDirectory(root: string, directory: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Configuration parent must be a directory, not a symlink or file: ${directory}`);
  assertWithin(root, await realpath(directory));
}

async function canonicalRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  await assertDirectory(canonical, canonical);
  return canonical;
}

/** Never recurse through unchecked parents. Missing parents are only created for write operations. */
async function directoryPath(root: string, parts: readonly string[], create: boolean): Promise<string | undefined> {
  let directory = root;
  for (const part of parts) {
    await assertDirectory(root, directory);
    directory = join(directory, part);
    if (create) {
      try {
        await mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    try {
      await assertDirectory(root, directory);
    } catch (error) {
      if (!create && isMissing(error)) return undefined;
      throw error;
    }
  }
  return directory;
}

async function assertFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Configuration file must be a regular file, not a symlink or directory: ${path}`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readCache(root: string): Promise<ApplicationConfiguration | undefined> {
  const directory = await directoryPath(root, cacheParts, false);
  if (!directory) return undefined;
  const path = join(directory, "config.json");
  if (!await assertFile(path)) return undefined;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Cache is not a regular file.");
      return validateRecord(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new Error(`Cannot load configuration cache ${path}. Clear it with config:clear (clearConfiguration) or rebuild with config:cache (cacheConfiguration). ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function loadModules(root: string): Promise<ApplicationConfiguration> {
  const directory = await directoryPath(root, ["config"], false);
  if (!directory) return {};
  const result: ApplicationConfiguration = {};
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  // Check all candidate names before executing any of the trusted modules.
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith(".ts")
    && !/\.(?:d|test|spec)\.ts$/.test(entry.name));
  for (const file of files) assertKey(file.name.slice(0, -3), file.name, true);
  for (const file of files) {
    const path = join(directory, file.name);
    await assertDirectory(root, directory);
    if (!await assertFile(path)) throw new Error(`Configuration module disappeared: ${path}`);
    try {
      const module = await import(pathToFileURL(path).href);
      result[file.name.slice(0, -3)] = copyObject(module.default, path);
    } catch (error) {
      throw new Error(`Cannot load trusted configuration module ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return result;
}

/**
 * Load trusted top-level config/*.ts default-exported plain objects (ASCII identifier filenames).
 * These modules EXECUTE arbitrary application code in Bun; this is not a sandbox. Put helpers
 * outside config/, since every eligible top-level module is loaded. Tests (*.test.ts, *.spec.ts),
 * declarations (*.d.ts), subdirectories and symlink entries are ignored. The config directory
 * itself must not be a symlink. Nested imports belong to the trusted application, not this loader.
 *
 * A valid disk cache wins even if source files/env changed. Malformed caches fail, not fall back.
 * useCache:false bypasses disk only: long-running processes retain Bun's ordinary ESM module
 * cache, including dependencies. CLI invocations start fresh processes. No DB selection changes,
 * dotenv loading, secret redaction, or global environment mutation are performed here.
 *
 * The root is canonicalized (a root alias is allowed); below it, directory symlinks are refused.
 * Like other filesystem generators, this assumes no hostile concurrent renaming of the project
 * tree. Standard Node path APIs do not provide an openat-based race-proof filesystem sandbox.
 */
export async function loadConfiguration(root: string, options: LoadConfigurationOptions = {}): Promise<ApplicationConfiguration> {
  if (!options || typeof options !== "object" || Object.keys(options).some(key => key !== "useCache")
    || (options.useCache !== undefined && typeof options.useCache !== "boolean")) {
    throw new Error("Only the optional boolean useCache option is supported.");
  }
  const canonical = await canonicalRoot(root);
  if (options.useCache ?? true) {
    const cached = await readCache(canonical);
    if (cached !== undefined) return cached;
  }
  return loadModules(canonical);
}

/** Rebuild from trusted source modules at mode 0600. Existing caches are replaced unless overwrite is false. */
export async function cacheConfiguration(root: string, options: { overwrite?: boolean } = {}): Promise<string> {
  const canonical = await canonicalRoot(root);
  // Refuse unsafe existing destinations before executing source or creating anything.
  const existingDirectory = await directoryPath(canonical, cacheParts, false);
  if (existingDirectory) await assertFile(join(existingDirectory, "config.json"));
  const data = await loadModules(canonical);
  const content = `${JSON.stringify(validateRecord(data), null, 2)}\n`;
  const directory = (await directoryPath(canonical, cacheParts, true))!;
  const path = join(directory, "config.json");
  await assertFile(path);
  const temporary = join(directory, `.config-${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    // chmod makes the promised mode exact even under a restrictive caller umask.
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await assertDirectory(canonical, directory);
    await assertFile(path);
    if (options.overwrite === false) {
      // Hard-link publication is atomic and fails if any destination entry already exists.
      await link(temporary, path);
      await unlink(temporary);
    } else {
      await rename(temporary, path);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return path;
}

/** Return true if a regular cache file was removed, false if absent. Never creates directories. */
export async function clearConfiguration(root: string): Promise<boolean> {
  const canonical = await canonicalRoot(root);
  const directory = await directoryPath(canonical, cacheParts, false);
  if (!directory) return false;
  const path = join(directory, "config.json");
  if (!await assertFile(path)) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Publish one built-in app config, not vendor/package assets. Never overwrite any existing entry. */
export async function publishConfiguration(root: string): Promise<string> {
  const canonical = await canonicalRoot(root);
  const directory = (await directoryPath(canonical, ["config"], true))!;
  const path = join(directory, "app.ts");
  const content = `// Trusted configuration modules execute application code. Keep helpers outside config/.
// Values are captured by config:cache; rebuild the cache after changing environment variables.
export default {
  name: process.env.APP_NAME ?? "Bundle",
  environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? "development",
};
`;
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return path;
}
