import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, type Environment } from "./config.ts";
import { resolveTarget } from "./targets.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const data = join(projectRoot, ".data");
  await mkdir(data, { recursive: true });
  const base = await mkdtemp(join(data, "targets-test-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const migrations = join(root, "database/migrations/custom");
  const outside = join(base, "project-neighbor");
  await mkdir(migrations, { recursive: true });
  await mkdir(outside);
  return { base, root, migrations, outside };
}

const original: Environment = {
  NODE_ENV: "production",
  DB_CONNECTION: "postgresql",
  DB_DATABASE: "old_database",
  DB_HOST: "old_host",
  DB_PORT: "5433",
  DB_USERNAME: "old_user",
  DB_PASSWORD: "old_password",
  DATABASE_URL: "postgresql://old_user:old_password@old_host/old_database",
};

function withConnections(mapping: unknown): Environment {
  return { ...original, BUNDLE_CONNECTIONS: JSON.stringify(mapping) };
}

describe("named database targets", () => {
  test("preserves the default environment without mutating or aliasing it", async () => {
    const result = await resolveTarget(original, projectRoot, {});
    expect(result).toEqual({ env: original });
    expect(result.env).not.toBe(original);
    expect(original.DB_CONNECTION).toBe("postgresql");
  });

  test("named connections replace all connection fields and preserve unrelated environment", async () => {
    const env = withConnections({ reporting: { DB_CONNECTION: "sqlite", DB_DATABASE: "reporting.sqlite" } });
    const before = { ...env };
    const result = await resolveTarget(env, projectRoot, { database: "reporting" });
    expect(result.env).toEqual({
      NODE_ENV: "production", BUNDLE_CONNECTIONS: env.BUNDLE_CONNECTIONS,
      DB_CONNECTION: "sqlite", DB_DATABASE: "reporting.sqlite",
    });
    expect(env).toEqual(before);
  });

  test("named URL targets do not inherit a database, port, or credentials", async () => {
    const target = { DB_CONNECTION: "mariadb", DATABASE_URL: "mariadb://new_user:new_password@new_host/new_database" };
    const result = await resolveTarget(withConnections({ archive: target }), projectRoot, { database: "archive" });
    expect(result.env).toEqual({
      NODE_ENV: "production", BUNDLE_CONNECTIONS: JSON.stringify({ archive: target }), ...target,
    });
  });

  test("allows every supported field, including an explicitly empty password", async () => {
    const target = {
      DB_CONNECTION: "postgresql", DB_DATABASE: "reporting", DB_HOST: "localhost",
      DB_PORT: "5432", DB_USERNAME: "reporter", DB_PASSWORD: "", DATABASE_URL: "",
    };
    const result = await resolveTarget(withConnections({ reporting: target }), projectRoot, { database: "reporting" });
    for (const [key, value] of Object.entries(target)) expect(result.env[key]).toBe(value);
  });

  test("built-in driver names use the current environment when not named", async () => {
    for (const database of ["sqlite", "postgresql", "mariadb"]) {
      expect((await resolveTarget(original, projectRoot, { database })).env).toEqual({ ...original, DB_CONNECTION: database });
    }
  });

  test("named entries take precedence over built-in names and support prototype-like names", async () => {
    const env = withConnections(JSON.parse('{"sqlite":{"DB_CONNECTION":"mariadb","DB_DATABASE":"named"},"__proto__":{"DB_CONNECTION":"sqlite"}}'));
    expect((await resolveTarget(env, projectRoot, { database: "sqlite" })).env.DB_CONNECTION).toBe("mariadb");
    expect((await resolveTarget(env, projectRoot, { database: "__proto__" })).env.DB_CONNECTION).toBe("sqlite");
    await expect(resolveTarget({}, projectRoot, { database: "toString" })).rejects.toThrow("Unknown database connection");
  });

  test("rejects unknown and empty target names without printing them", async () => {
    for (const database of ["missing", "", "secret_target_password"]) {
      try {
        await resolveTarget({}, projectRoot, { database });
        throw new Error("Expected target rejection");
      } catch (error) {
        expect(String(error)).toContain("Unknown database connection");
        if (database) expect(String(error)).not.toContain(database);
      }
    }
  });

  test("validates the complete mapping even without an explicit target", async () => {
    for (const text of ["", "{", "null", "[]", "42", '"text"']) {
      await expect(resolveTarget({ BUNDLE_CONNECTIONS: text }, projectRoot, {})).rejects.toThrow("BUNDLE_CONNECTIONS");
    }
    const invalidEntries = [null, [], "sqlite", 42, {}, { DB_DATABASE: "db" }, { DB_CONNECTION: "mysql" },
      { DB_CONNECTION: 1 }, { DB_CONNECTION: "sqlite", DB_PORT: 5432 },
      { DB_CONNECTION: "sqlite", DB_PASSWORD: null }, { DB_CONNECTION: "sqlite", NODE_ENV: "production" }];
    for (const entry of invalidEntries) {
      const env = withConnections({ good: { DB_CONNECTION: "sqlite" }, invalid: entry });
      await expect(resolveTarget(env, projectRoot, { database: "good" })).rejects.toThrow("BUNDLE_CONNECTIONS");
    }
    await expect(resolveTarget(withConnections({ " ": { DB_CONNECTION: "sqlite" } }), projectRoot, {})).rejects.toThrow("BUNDLE_CONNECTIONS");
  });

  test("validation errors do not include JSON contents, credentials, names, or unknown keys", async () => {
    const secret = "do_not_expose_password";
    for (const text of [
      `{"broken":"${secret}",`,
      JSON.stringify({ [secret]: { DB_CONNECTION: "sqlite", [secret]: secret } }),
      JSON.stringify({ [secret]: { DB_CONNECTION: secret, DB_PASSWORD: secret } }),
    ]) {
      try {
        await resolveTarget({ BUNDLE_CONNECTIONS: text }, projectRoot, {});
        throw new Error("Expected invalid mapping rejection");
      } catch (error) {
        expect(String(error)).toContain("BUNDLE_CONNECTIONS");
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});

describe("explicit migration directories", () => {
  test("resolves one existing directory relative to root, independently of cwd", async () => {
    const { root, migrations } = await fixture();
    expect(await resolveTarget({}, root, { path: "database/migrations/custom" })).toEqual({
      env: {}, migrationsPath: await realpath(migrations),
    });
    expect((await resolveTarget({}, root, { path: "." })).migrationsPath).toBe(await realpath(root));
  });

  test("combines named connection selection and migration path selection", async () => {
    const { root, migrations } = await fixture();
    const target = await resolveTarget(withConnections({ local: { DB_CONNECTION: "sqlite" } }), root, {
      database: "local", path: "database/migrations/custom",
    });
    expect(target.env.DB_CONNECTION).toBe("sqlite");
    expect(target.env.DATABASE_URL).toBeUndefined();
    expect(target.migrationsPath).toBe(await realpath(migrations));
  });

  test("rejects missing directories, files, empty input, and multiple paths", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "migration.ts"), "// fixture\n");
    for (const path of ["does-not-exist", "migration.ts", "", " ", "one,two", "bad\0path"]) {
      await expect(resolveTarget({}, root, { path })).rejects.toThrow();
    }
    await expect(resolveTarget({}, root, { path: ["one", "two"] as unknown as string })).rejects.toThrow("single migration directory");
  });

  test("absolute paths require --realpath even inside root", async () => {
    const { root, migrations } = await fixture();
    await expect(resolveTarget({}, root, { path: migrations })).rejects.toThrow("--realpath");
    expect((await resolveTarget({}, root, { path: migrations, realpath: true })).migrationsPath).toBe(await realpath(migrations));
  });

  test("rejects traversal into a sibling with a common root prefix unless explicitly allowed", async () => {
    const { root, outside } = await fixture();
    await expect(resolveTarget({}, root, { path: "../project-neighbor" })).rejects.toThrow("--realpath");
    expect((await resolveTarget({}, root, { path: "../project-neighbor", realpath: true })).migrationsPath).toBe(await realpath(outside));
    expect((await resolveTarget({}, root, { path: outside, realpath: true })).migrationsPath).toBe(await realpath(outside));
  });

  test("rejects symlinks escaping root unless explicitly allowed", async () => {
    const { root, outside } = await fixture();
    await symlink(outside, join(root, "external"));
    await expect(resolveTarget({}, root, { path: "external" })).rejects.toThrow("--realpath");
    expect((await resolveTarget({}, root, { path: "external", realpath: true })).migrationsPath).toBe(await realpath(outside));
  });

  test("allows internal symlinks and a symlinked project root", async () => {
    const { base, root, migrations } = await fixture();
    await symlink(migrations, join(root, "internal"));
    expect((await resolveTarget({}, root, { path: "internal" })).migrationsPath).toBe(await realpath(migrations));
    const linkedRoot = join(base, "linked-root");
    await symlink(root, linkedRoot);
    expect((await resolveTarget({}, linkedRoot, { path: "database/migrations/custom" })).migrationsPath).toBe(await realpath(migrations));
  });

  test("--realpath does not allow missing directories or files", async () => {
    const { root } = await fixture();
    const file = join(root, "migration.ts");
    await writeFile(file, "// fixture\n");
    for (const path of [file, join(root, "missing")]) {
      await expect(resolveTarget({}, root, { path, realpath: true })).rejects.toThrow("existing, accessible migration directory");
    }
  });
});
