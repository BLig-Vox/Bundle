import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cacheConfiguration,
  clearConfiguration,
  loadConfiguration,
  publishConfiguration,
  type LoadConfigurationOptions,
} from "./configuration.ts";

const projectRoot = resolve(import.meta.dir, "../..");
const libraryUrl = pathToFileURL(join(import.meta.dir, "configuration.ts")).href;
const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const parent = join(projectRoot, ".data");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "configuration-test-"));
  cleanups.push(directory);
  return realpath(directory);
}

async function source(root: string, content: string, name = "app.ts"): Promise<string> {
  await mkdir(join(root, "config"), { recursive: true });
  const path = join(root, "config", name);
  await writeFile(path, content);
  return path;
}

async function diskCache(root: string, content: string): Promise<string> {
  await mkdir(join(root, "bootstrap/cache"), { recursive: true });
  const path = join(root, "bootstrap/cache/config.json");
  await writeFile(path, content);
  return path;
}

async function entries(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const name of await readdir(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, name);
      result.push(relative);
      if ((await lstat(path)).isDirectory()) await visit(path, relative);
    }
  }
  await visit(root);
  return result.sort();
}

async function freshProcess(root: string, code: string, env: Record<string, string> = {}): Promise<unknown> {
  const child = Bun.spawn([process.execPath, "--eval", `import { loadConfiguration, cacheConfiguration } from ${JSON.stringify(libraryUrl)};
const root = ${JSON.stringify(root)};
${code}`], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(status, stderr + stdout).toBe(0);
  return JSON.parse(stdout);
}

describe("trusted application configuration", () => {
  test("missing configuration and cache mean an empty record without creating anything", async () => {
    const root = await fixture();
    expect(await loadConfiguration(root)).toEqual({});
    expect(await loadConfiguration(root, { useCache: false })).toEqual({});
    expect(await clearConfiguration(root)).toBe(false);
    expect(await entries(root)).toEqual([]);
  });

  test("executes real trusted TypeScript with helpers outside config and deterministic file keys", async () => {
    const root = await fixture();
    await writeFile(join(root, "helpers.ts"), 'export const label: string = "loaded helper";');
    const marker = join(root, "executed.txt");
    await source(root, `import { writeFile } from "node:fs/promises";
import { label } from "../helpers.ts";
await writeFile(${JSON.stringify(marker)}, "executed");
const count: number = 42;
export default { label, count, nested: { enabled: true }, items: [null, false, "é", 1.5] };`, "zeta.ts");
    await source(root, "export default Object.assign(Object.create(null), { value: 'alpha' });", "alpha.ts");
    const config = await loadConfiguration(root);
    expect(Object.keys(config)).toEqual(["alpha", "zeta"]);
    expect(config).toEqual({
      alpha: { value: "alpha" },
      zeta: { label: "loaded helper", count: 42, nested: { enabled: true }, items: [null, false, "é", 1.5] },
    });
    expect(await readFile(marker, "utf8")).toBe("executed");
    // Caller mutation must not mutate the ESM module's default-export object.
    config.zeta!.count = 0;
    expect((await loadConfiguration(root)).zeta!.count).toBe(42);
  });

  test("ignores tests, declarations, non-TS, directories, and file symlinks without executing them", async () => {
    const root = await fixture();
    const outside = await fixture();
    for (const name of ["app.test.ts", "app.spec.ts", "types.d.ts", "ignored.js", "app.ts.bak"]) {
      await source(root, 'throw new Error("must not execute");', name);
    }
    await mkdir(join(root, "config/nested"));
    await writeFile(join(root, "config/nested/app.ts"), 'throw new Error("nested must not execute");');
    const target = join(outside, "linked.ts");
    await writeFile(target, 'throw new Error("symlink must not execute");');
    await symlink(target, join(root, "config/linked.ts"));
    await symlink(join(outside, "missing.ts"), join(root, "config/dangling.ts"));
    await symlink(outside, join(root, "config/linked-directory"));
    await source(root, 'export default { ready: true };');
    expect(await loadConfiguration(root)).toEqual({ app: { ready: true } });
  });

  test.each(["bad-name.ts", "space name.ts", "1name.ts", "__proto__.ts", "constructor.ts", "prototype.ts", "námé.ts"])("refuses unsafe eligible filename %s before executing any module", async name => {
    const root = await fixture();
    const marker = join(root, "executed");
    await source(root, `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(marker)}, "oops"); export default {};`, "aaa.ts");
    await source(root, "export default {};", name);
    await expect(loadConfiguration(root)).rejects.toThrow("Invalid configuration key");
    expect(await entries(root)).not.toContain("executed");
  });

  test.each([
    ["missing default", "export const app = {};"],
    ["null", "export default null;"],
    ["array root", "export default [];"],
    ["function root", "export default () => ({});"],
    ["undefined", "export default { invalid: undefined };"],
    ["function", "export default { invalid() {} };"],
    ["symbol value", "export default { invalid: Symbol('x') };"],
    ["symbol key", "export default { [Symbol('x')]: 1 };"],
    ["bigint", "export default { invalid: 1n };"],
    ["NaN", "export default { invalid: NaN };"],
    ["infinity", "export default { invalid: Infinity };"],
    ["negative zero", "export default { invalid: -0 };"],
    ["date", "export default { invalid: new Date() };"],
    ["map", "export default { invalid: new Map() };"],
    ["class", "class Options { enabled = true }; export default new Options();"],
    ["cycle", "const value: any = {}; value.self = value; export default value;"],
    ["nested undefined", "export default { nested: [undefined] };"],
    ["array hole", "export default { nested: Array(1) };"],
    ["extra array property", "export default { nested: Object.assign([1], { extra: true }) };"],
    ["array subclass", "class Values extends Array {} export default { nested: new Values() };"],
    ["accessor", "export default { get secret() { throw new Error('getter was invoked'); } };"],
    ["non-enumerable", "export default Object.defineProperty({}, 'secret', { value: true });"],
    ["toJSON", "export default { toJSON() { throw new Error('toJSON was invoked'); } };"],
    ["pollution key", 'export default JSON.parse(\'{"nested":{"__proto__":{"polluted":true}}}\');'],
    ["constructor key", "export default { nested: { constructor: true } };"],
    ["prototype key", "export default { nested: { prototype: true } };"],
  ])("rejects lossy/nonplain configuration: %s", async (_label, module) => {
    const root = await fixture();
    await source(root, module);
    await expect(loadConfiguration(root)).rejects.toThrow("Invalid configuration");
    await expect(cacheConfiguration(root)).rejects.toThrow("Invalid configuration");
    expect(await entries(root)).toEqual(["config", "config/app.ts"]);
  });

  test("allows shared noncyclic references and data properties named toJSON", async () => {
    const root = await fixture();
    await source(root, "const shared = { value: 1 }; export default { a: shared, b: shared, toJSON: 'data' };");
    await cacheConfiguration(root);
    expect(await loadConfiguration(root)).toEqual({ app: { a: { value: 1 }, b: { value: 1 }, toJSON: "data" } });
  });

  test("reports module errors with the source path, without creating a cache", async () => {
    const root = await fixture();
    const path = await source(root, 'throw new Error("source failure");');
    await expect(loadConfiguration(root)).rejects.toThrow(path);
    await expect(cacheConfiguration(root)).rejects.toThrow("source failure");
    expect(await entries(root)).toEqual(["config", "config/app.ts"]);
  });

  test("rejects unsupported load options", async () => {
    const root = await fixture();
    for (const options of [null, { useCache: "true" }, { cache: true }, { force: true }]) {
      await expect(loadConfiguration(root, options as LoadConfigurationOptions)).rejects.toThrow("useCache");
    }
  });
});

describe("data-only configuration cache", () => {
  test("creates parents, replaces atomically at 0600, and clears only its cache file", async () => {
    const root = await fixture();
    await source(root, 'export default { name: "current", nested: [1, true, null] };');
    const path = await cacheConfiguration(root);
    expect(path).toBe(join(root, "bootstrap/cache/config.json"));
    const bytes = await readFile(path, "utf8");
    expect(JSON.parse(bytes)).toEqual({ app: { name: "current", nested: [1, true, null] } });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    // A linked old inode must not be modified by a subsequent cache write.
    const old = join(root, "old-cache.json");
    await writeFile(path, '{"app":{"name":"stale"}}');
    await chmod(path, 0o644);
    await link(path, old);
    expect(await cacheConfiguration(root)).toBe(path);
    expect(await readFile(old, "utf8")).toBe('{"app":{"name":"stale"}}');
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, "bootstrap/cache"))).toEqual(["config.json"]);
    await writeFile(join(root, "bootstrap/cache/other.json"), "keep");
    expect(await clearConfiguration(root)).toBe(true);
    expect(await clearConfiguration(root)).toBe(false);
    expect(await readFile(join(root, "bootstrap/cache/other.json"), "utf8")).toBe("keep");
    expect(await loadConfiguration(root)).toEqual(JSON.parse(bytes));
  });

  test("can cache and restore an empty record", async () => {
    const root = await fixture();
    const path = await cacheConfiguration(root);
    expect(await readFile(path, "utf8")).toBe("{}\n");
    expect(await loadConfiguration(root)).toEqual({});
    expect(await clearConfiguration(root)).toBe(true);
  });

  test("default cache wins over changed source and env; fresh generation bypasses even malformed cache", async () => {
    const root = await fixture();
    const module = await source(root, 'export default { name: process.env.APP_NAME, version: 1 };');
    const globalsBefore = { APP_NAME: process.env.APP_NAME, APP_ENV: process.env.APP_ENV, DB_CONNECTION: process.env.DB_CONNECTION };
    expect(await freshProcess(root, "await cacheConfiguration(root); console.log(JSON.stringify(await loadConfiguration(root)));", { APP_NAME: "old" }))
      .toEqual({ app: { name: "old", version: 1 } });
    await writeFile(module, 'export default { name: process.env.APP_NAME, version: 2 };');
    expect(await freshProcess(root, "console.log(JSON.stringify(await loadConfiguration(root)));", { APP_NAME: "new" }))
      .toEqual({ app: { name: "old", version: 1 } });
    expect(await freshProcess(root, "console.log(JSON.stringify(await loadConfiguration(root, { useCache: false })));", { APP_NAME: "new" }))
      .toEqual({ app: { name: "new", version: 2 } });
    await writeFile(join(root, "bootstrap/cache/config.json"), "malformed");
    expect(await freshProcess(root, "await cacheConfiguration(root); console.log(JSON.stringify(await loadConfiguration(root)));", { APP_NAME: "new" }))
      .toEqual({ app: { name: "new", version: 2 } });
    expect({ APP_NAME: process.env.APP_NAME, APP_ENV: process.env.APP_ENV, DB_CONNECTION: process.env.DB_CONNECTION }).toEqual(globalsBefore);
  });

  test("documents and demonstrates ordinary ESM caching within a long-running process", async () => {
    const root = await fixture();
    const module = await source(root, 'export default { version: 1 };');
    expect(await loadConfiguration(root, { useCache: false })).toEqual({ app: { version: 1 } });
    await writeFile(module, 'export default { version: 2 };');
    expect(await loadConfiguration(root, { useCache: false })).toEqual({ app: { version: 1 } });
    expect(await freshProcess(root, "console.log(JSON.stringify(await loadConfiguration(root, { useCache: false })));"))
      .toEqual({ app: { version: 2 } });
  });

  test("cache restore never imports trusted modules or evaluates strings", async () => {
    const root = await fixture();
    await source(root, 'throw new Error("must not execute");');
    const content = { app: { code: "throw new Error('data only')", nested: [true] } };
    await diskCache(root, JSON.stringify(content));
    expect(await loadConfiguration(root)).toEqual(content);
  });

  test.each([
    "not JSON", "", "null", "[]", '{"app":null}', '{"app":1}', '{"app":[]}',
    '{"bad-name":{}}', '{"__proto__":{}}', '{"constructor":{}}', '{"prototype":{}}',
    '{"app":{"nested":{"__proto__":1}}}', '{"app":{"prototype":1}}',
    '{"app":{"constructor":1}}', '{"app":{"value":1e400}}', '{"app":{"value":-0}}',
  ])("fails actionably on corrupt cache %j instead of falling back", async content => {
    const root = await fixture();
    await source(root, 'export default { fallback: true };');
    const path = await diskCache(root, content);
    await expect(loadConfiguration(root)).rejects.toThrow("config:clear");
    expect(await readFile(path, "utf8")).toBe(content);
    expect(await loadConfiguration(root, { useCache: false })).toEqual({ app: { fallback: true } });
    await cacheConfiguration(root);
    expect(await loadConfiguration(root)).toEqual({ app: { fallback: true } });
  });

  test("invalid fresh source preserves a previously valid cache byte for byte", async () => {
    const root = await fixture();
    const path = await diskCache(root, '{"app":{"keep":"user bytes"}}\n');
    await source(root, "export default { bad: undefined };");
    await expect(cacheConfiguration(root)).rejects.toThrow("undefined");
    expect(await readFile(path, "utf8")).toBe('{"app":{"keep":"user bytes"}}\n');
    expect(await readdir(join(root, "bootstrap/cache"))).toEqual(["config.json"]);
  });
});

describe("configuration publication and safe paths", () => {
  test("publishes usable env-derived code without overwriting or changing the environment", async () => {
    const root = await fixture();
    const before = { APP_NAME: process.env.APP_NAME, APP_ENV: process.env.APP_ENV, DB_CONNECTION: process.env.DB_CONNECTION };
    const path = await publishConfiguration(root);
    expect(path).toBe(join(root, "config/app.ts"));
    const content = await readFile(path, "utf8");
    expect(content).toContain("Trusted configuration modules execute");
    expect(await freshProcess(root, "console.log(JSON.stringify(await loadConfiguration(root)));", { APP_NAME: "Fixture app", APP_ENV: "staging", DB_CONNECTION: "invalid-must-not-be-used" }))
      .toEqual({ app: { name: "Fixture app", environment: "staging" } });
    await expect(publishConfiguration(root)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(content);
    expect({ APP_NAME: process.env.APP_NAME, APP_ENV: process.env.APP_ENV, DB_CONNECTION: process.env.DB_CONNECTION }).toEqual(before);
  });

  test("published defaults and NODE_ENV fallback are useful in a fresh process", async () => {
    const root = await fixture();
    await publishConfiguration(root);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "APP_NAME" && key !== "APP_ENV"));
    const child = Bun.spawn([process.execPath, "--eval", `import { loadConfiguration } from ${JSON.stringify(libraryUrl)};
console.log(JSON.stringify(await loadConfiguration(${JSON.stringify(root)})));`], {
      cwd: root, env: { ...inherited, NODE_ENV: "testing" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ app: { name: "Bundle", environment: "testing" } });
  });

  test.each(["bootstrap", "bootstrap/cache"])("cache operations refuse directory symlink %s and preserve targets", async parent => {
    const root = await fixture();
    const outside = await fixture();
    const target = join(outside, "target");
    await mkdir(target);
    await writeFile(join(target, "config.json"), '{"app":{"keep":true}}');
    if (parent.includes("/")) await mkdir(join(root, "bootstrap"));
    await symlink(target, join(root, parent));
    const before = await entries(root);
    for (const operation of [loadConfiguration, cacheConfiguration, clearConfiguration]) {
      await expect(operation(root)).rejects.toThrow("symlink");
    }
    expect(await entries(root)).toEqual(before);
    expect(await readFile(join(target, "config.json"), "utf8")).toBe('{"app":{"keep":true}}');
    expect((await lstat(join(root, parent))).isSymbolicLink()).toBe(true);
  });

  test("refuses config directory links for loading and publication, even within the root", async () => {
    const root = await fixture();
    const actual = join(root, "actual");
    await mkdir(actual);
    await writeFile(join(actual, "app.ts"), "export default { keep: true };");
    await symlink(actual, join(root, "config"));
    for (const operation of [loadConfiguration, cacheConfiguration, publishConfiguration]) {
      await expect(operation(root)).rejects.toThrow("symlink");
    }
    expect(await readFile(join(actual, "app.ts"), "utf8")).toBe("export default { keep: true };");
    expect(await entries(root)).toEqual(["actual", "actual/app.ts", "config"]);
  });

  test.each([false, true])("refuses cache file symlinks, including dangling=%s", async dangling => {
    const root = await fixture();
    const outside = await fixture();
    await mkdir(join(root, "bootstrap/cache"), { recursive: true });
    const target = join(outside, "config.json");
    if (!dangling) await writeFile(target, '{"app":{"keep":true}}');
    const path = join(root, "bootstrap/cache/config.json");
    await symlink(target, path);
    for (const operation of [loadConfiguration, cacheConfiguration, clearConfiguration]) {
      await expect(operation(root)).rejects.toThrow("symlink");
    }
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readdir(outside)).toEqual(dangling ? [] : ["config.json"]);
    if (!dangling) expect(await readFile(target, "utf8")).toBe('{"app":{"keep":true}}');
  });

  test.each(["regular", "directory", "symlink", "dangling"])("publication never overwrites an existing %s app.ts", async kind => {
    const root = await fixture();
    const outside = await fixture();
    await mkdir(join(root, "config"));
    const path = join(root, "config/app.ts");
    const target = join(outside, "target.ts");
    await writeFile(target, "outside content");
    if (kind === "regular") await writeFile(path, "user content");
    else if (kind === "directory") await mkdir(path);
    else await symlink(kind === "dangling" ? join(outside, "missing") : target, path);
    const before = await entries(root);
    await expect(publishConfiguration(root)).rejects.toThrow();
    expect(await entries(root)).toEqual(before);
    expect(await readFile(target, "utf8")).toBe("outside content");
    if (kind === "regular") expect(await readFile(path, "utf8")).toBe("user content");
    if (kind === "symlink" || kind === "dangling") expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  test.each(["bootstrap", "bootstrap/cache"])("cache refuses non-directory parent %s without changing it", async parent => {
    const root = await fixture();
    if (parent.includes("/")) await mkdir(join(root, "bootstrap"));
    await writeFile(join(root, parent), "user content");
    for (const operation of [loadConfiguration, cacheConfiguration, clearConfiguration]) {
      await expect(operation(root)).rejects.toThrow("directory");
    }
    expect(await readFile(join(root, parent), "utf8")).toBe("user content");
  });

  test("cache operations refuse directories at config.json; publication refuses non-directory config", async () => {
    const root = await fixture();
    await mkdir(join(root, "bootstrap/cache/config.json"), { recursive: true });
    await writeFile(join(root, "bootstrap/cache/config.json/user"), "keep");
    for (const operation of [loadConfiguration, cacheConfiguration, clearConfiguration]) {
      await expect(operation(root)).rejects.toThrow("regular file");
    }
    await writeFile(join(root, "config"), "keep config");
    await expect(publishConfiguration(root)).rejects.toThrow("directory");
    expect(await readFile(join(root, "config"), "utf8")).toBe("keep config");
    expect(await readFile(join(root, "bootstrap/cache/config.json/user"), "utf8")).toBe("keep");
  });

  test("uses the canonical root when the caller supplies a root alias", async () => {
    const root = await fixture();
    const holder = await fixture();
    const alias = join(holder, "project");
    await symlink(root, alias);
    expect(await publishConfiguration(alias)).toBe(join(root, "config/app.ts"));
    expect(await cacheConfiguration(alias)).toBe(join(root, "bootstrap/cache/config.json"));
    expect(await loadConfiguration(alias)).toEqual(await loadConfiguration(root));
    expect(await clearConfiguration(alias)).toBe(true);
  });
});
