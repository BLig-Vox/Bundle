import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { databaseOptions, databaseSettings, type DatabaseConnection } from "./config.ts";
import { openDatabase, withDatabase } from "./connection.ts";
import { generateModel, generateSeeder } from "./generators.ts";
import { SafeMigrationGenerator } from "./migration-generator.ts";
import { databaseFixture } from "./testing.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture(connection: DatabaseConnection = "sqlite", url?: string) {
  const result = await databaseFixture(connection, url);
  cleanups.push(result.cleanup);
  return result;
}
async function models(root: string) {
  const user = await import(pathToFileURL(join(root, "src/models/User.ts")).href) as typeof import("../models/User.ts");
  const post = await import(pathToFileURL(join(root, "src/models/Post.ts")).href) as typeof import("../models/Post.ts");
  return { User: user.User, Post: post.Post };
}

async function exercisePersistence(env: Record<string, string | undefined>, root: string) {
  await withDatabase(async orm => {
    const { User, Post } = await models(root);
    expect((await orm.migrator.up()).length).toBe(1);
    expect(await orm.migrator.up()).toHaveLength(0);
    expect(await orm.migrator.getExecuted()).toHaveLength(1);
    expect(await orm.migrator.getPending()).toHaveLength(0);
    expect(await orm.migrator.checkSchema()).toBe(false);

    const em = orm.em.fork();
    const author = em.create(User, { name: "Test Author", email: "author@example.test" });
    const post = em.create(Post, { title: "First post", slug: "first-post", body: "Body", author });
    await em.flush();
    expect(author.id).toBeGreaterThan(0);
    expect(post.id).toBeGreaterThan(0);

    const reader = orm.em.fork();
    const loaded = await reader.findOneOrFail(User, { email: author.email }, { populate: ["posts"] });
    expect(loaded.posts.getItems()[0]?.title).toBe("First post");
    const previousUpdate = loaded.updatedAt.getTime();
    loaded.name = "Updated Author";
    await reader.flush();
    expect((await orm.em.fork().findOneOrFail(User, { id: author.id })).name).toBe("Updated Author");
    expect(loaded.updatedAt.getTime()).toBeGreaterThanOrEqual(previousUpdate);

    await expect(orm.em.fork().transactional(async tx => {
      tx.create(User, { name: "Rolled back", email: "rollback@example.test" });
      await tx.flush();
      throw new Error("rollback sentinel");
    })).rejects.toThrow("rollback sentinel");
    expect(await orm.em.fork().count(User, { email: "rollback@example.test" })).toBe(0);

    const duplicate = orm.em.fork();
    duplicate.create(User, { name: "Duplicate", email: author.email });
    await expect(duplicate.flush()).rejects.toThrow();

    const invalid = orm.em.fork();
    invalid.create(Post, { title: "Orphan", slug: "orphan", body: "Body", author: invalid.getReference(User, 999999) });
    await expect(invalid.flush()).rejects.toThrow();

    const deleter = orm.em.fork();
    deleter.remove(await deleter.findOneOrFail(User, { id: author.id }));
    await deleter.flush();
    expect(await orm.em.fork().count(Post, { id: post.id })).toBe(0);

    await orm.seeder.seedString("DatabaseSeeder");
    await orm.seeder.seedString("DatabaseSeeder");
    expect(await orm.em.fork().count(User)).toBe(1);
    expect(await orm.em.fork().count(Post)).toBe(1);
    expect((await orm.em.fork().getKysely().introspection.getTables()).some(table => table.name === "users")).toBe(true);

    expect(await orm.migrator.down()).toHaveLength(1);
    expect(await orm.migrator.getExecuted()).toHaveLength(0);
    expect(await orm.migrator.up()).toHaveLength(1);
    expect(await orm.em.fork().count(User)).toBe(0);
  }, { env, root });
}

describe("database configuration", () => {
  test("uses SQLite by default and resolves paths against the project root", () => {
    expect(databaseSettings({}, "/project").database).toBe("/project/.data/bundle.sqlite");
    expect(databaseSettings({ DB_DATABASE: ":memory:" }).database).toBe(":memory:");
    expect(databaseSettings({ DB_DATABASE: "/tmp/example.sqlite" }).database).toBe("/tmp/example.sqlite");
  });
  test("validates drivers, database names, URL protocols, and ports", () => {
    expect(() => databaseSettings({ DB_CONNECTION: "unknown" })).toThrow("DB_CONNECTION");
    expect(() => databaseSettings({ DB_CONNECTION: "postgresql" })).toThrow("DB_DATABASE");
    expect(() => databaseSettings({ DATABASE_URL: "postgres://localhost/db" })).toThrow("DB_CONNECTION");
    expect(() => databaseSettings({ DB_CONNECTION: "mariadb", DATABASE_URL: "postgres://localhost/db" })).toThrow("protocol");
    expect(() => databaseSettings({ DB_CONNECTION: "postgresql", DB_DATABASE: "db", DB_PORT: "0" })).toThrow("DB_PORT");
    expect(() => databaseSettings({ DB_CONNECTION: "postgresql", DATABASE_URL: "not a url" })).toThrow("valid database URL");
  });
  test("selects the right driver and isolates each dialect's migration directory", () => {
    for (const connection of ["sqlite", "postgresql", "mariadb"] as const) {
      const options = databaseOptions({ DB_CONNECTION: connection, DB_DATABASE: "bundle" }, "/project");
      expect(options.migrations?.path).toBe(`/project/database/migrations/${connection}`);
      expect(options.driver?.name).toBe({ sqlite: "SqliteDriver", postgresql: "PostgreSqlDriver", mariadb: "MariaDbDriver" }[connection]);
      expect(options.migrations?.allOrNothing).toBe(connection !== "mariadb");
    }
  });
  test("forwards explicit TLS requirements and rejects silently ignored URL options", async () => {
    for (const connection of ["postgresql", "mariadb"] as const) {
      for (const mode of ["disable", "require", "verify-full"] as const) {
        const env = { DB_CONNECTION: connection, DATABASE_URL: `${connection}://user:password@localhost/bundle?sslmode=${mode}` };
        const expected = mode === "disable" ? false : { rejectUnauthorized: true };
        expect(databaseOptions(env).driverOptions).toEqual({ ssl: expected });
        const orm = await openDatabase(env, undefined, false);
        try {
          // Check the actual native connection options, not only Bundle's config.
          const native = orm.driver.getConnection();
          if (!("mapOptions" in native)) throw new Error("Expected a server database connection");
          expect(native.mapOptions(orm.config.get("driverOptions")).ssl).toEqual(expected);
        } finally { await orm.close(true); }
      }
      for (const query of ["ssl=true", "sslmode=", "sslmode=prefer", "sslmode=require&sslmode=disable", "sslcert=path"]) {
        expect(() => databaseSettings({ DB_CONNECTION: connection, DATABASE_URL: `${connection}://localhost/bundle?${query}` })).toThrow();
      }
    }
  });
  test("decodes URL credentials without exposing them in public configuration", () => {
    const settings = databaseSettings({ DB_CONNECTION: "postgresql", DATABASE_URL: "postgres://user:p%40ss@localhost:5433/bundle_test" });
    expect(settings.password).toBe("p@ss");
    expect(settings.database).toBe("bundle_test");
    expect(settings.port).toBe(5433);
  });
});

describe("dialect schema generation", () => {
  test("initial migrations match mapped CREATE SQL for SQLite, PostgreSQL, and MariaDB without connecting", async () => {
    for (const connection of ["sqlite", "postgresql", "mariadb"] as const) {
      const orm = await openDatabase({ DB_CONNECTION: connection, DB_DATABASE: connection === "sqlite" ? ":memory:" : "bundle" }, undefined, false);
      try {
        const module = await import(new URL(`../../database/migrations/${connection}/Migration20261106000000.ts`, import.meta.url).href) as typeof import("../../database/migrations/sqlite/Migration20261106000000.ts");
        const migration = new module.Migration20261106000000(orm.driver, orm.config);
        await migration.up();
        const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
        expect(normalize(migration.getQueries().join("\n"))).toBe(normalize(await orm.schema.getCreateSchemaSQL({ wrap: false })));
      } finally { await orm.close(true); }
    }
  });
});

describe("SQLite ORM integration", () => {
  test("supports migrations, CRUD, relationships, constraints, transactions, and idempotent seeding", async () => {
    const { env, root } = await fixture();
    await exercisePersistence(env, root);
  }, 30000);
  test("closes connections when application work throws", async () => {
    const { env, root } = await fixture();
    let instance: Awaited<ReturnType<typeof openDatabase>> | undefined;
    await expect(withDatabase(async orm => { instance = orm; throw new Error("failure"); }, { env, root })).rejects.toThrow("failure");
    expect(await instance!.isConnected()).toBe(false);
  });
  test("generated models are discovered and produce real executable migrations", async () => {
    const { env, root } = await fixture();
    await withDatabase(async orm => { await orm.migrator.up(); }, { env, root });
    const file = await generateModel(join(root, "src/models"), "Product");
    expect(await readFile(file, "utf8")).toContain("EntitySchema<Product>");
    await withDatabase(async orm => {
      expect(orm.getMetadata().getByClassName("Product").tableName).toBe("product");
      expect(await orm.migrator.checkSchema()).toBe(true);
      const migration = await orm.migrator.create(undefined, false, false, "add_products");
      expect(migration.fileName).toContain("add_products");
      expect(await orm.migrator.up()).toHaveLength(1);
      expect((await orm.em.fork().getKysely().introspection.getTables()).some(table => table.name === "product")).toBe(true);
      expect(await orm.migrator.down()).toHaveLength(1);
      expect((await orm.em.fork().getKysely().introspection.getTables()).some(table => table.name === "product")).toBe(false);
    }, { env, root });
  }, 30000);
});

describe("safe generators", () => {
  test("generated classes work when names match imports; built-in scalar names are rejected", async () => {
    const { env, root } = await fixture();
    for (const name of ["EntitySchema", "OptionalProps"]) {
      await generateModel(join(root, "src/models"), name);
      const module = await import(pathToFileURL(join(root, `src/models/${name}.ts`)).href);
      expect(new module[name]().createdAt).toBeInstanceOf(globalThis.Date);
    }
    for (const name of ["Date", "String", "Number", "Boolean", "BigInt", "Buffer", "Object", "Array"]) {
      expect(() => generateModel(join(root, "src/models"), name)).toThrow("built-in scalar");
    }
    await generateSeeder(join(root, "database/seeders"), "Seeder");
    await withDatabase(async orm => {
      await orm.schema.create();
      for (const name of ["EntitySchema", "OptionalProps"]) {
        const em = orm.em.fork();
        const model = orm.getMetadata().getByClassName(name).class!;
        const entity = em.create(model, {});
        await em.flush();
        expect(await em.count(model)).toBe(1);
        expect(entity.createdAt).toBeInstanceOf(globalThis.Date);
      }
      await orm.seeder.seedString("Seeder");
    }, { env, root });
  });
  test("migration filename collisions preserve the existing file and snapshot", async () => {
    const { env, root } = await fixture();
    const snapshot = join(root, "database/migrations/sqlite/.snapshot.json");
    const filename = join(root, "database/migrations/sqlite/MigrationCollision.ts");
    await withDatabase(async orm => {
      expect(orm.config.get("migrations").generator).toBe(SafeMigrationGenerator);
      // Force a deterministic collision without relying on timing or global clocks.
      orm.config.get("migrations").fileName = () => "MigrationCollision";
      await orm.migrator.up();
      await orm.migrator.create(undefined, true, false, "original");
    }, { env, root });
    const originalSnapshot = await readFile(snapshot, "utf8");
    const original = await readFile(filename, "utf8");
    await generateModel(join(root, "src/models"), "CollisionProduct");
    await withDatabase(async orm => {
      orm.config.get("migrations").fileName = () => "MigrationCollision";
      expect(await orm.migrator.checkSchema()).toBe(true);
      await expect(orm.migrator.create(undefined, false, false, "collision")).rejects.toThrow();
      expect(await readFile(filename, "utf8")).toBe(original);
      expect(await readFile(snapshot, "utf8")).toBe(originalSnapshot);
      expect(await orm.migrator.checkSchema()).toBe(true);
    }, { env, root });
  });
  test("rejects invalid names and never overwrites model or seeder files", async () => {
    const { root } = await fixture();
    const directory = join(root, "src/models");
    expect(() => generateModel(directory, "../../Escape")).toThrow("PascalCase");
    expect(() => generateSeeder(directory, "Product")).toThrow("Seeder");
    const filename = await generateModel(directory, "Product");
    const original = await readFile(filename, "utf8");
    await expect(generateModel(directory, "Product")).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe(original);
    const seeder = await generateSeeder(join(root, "database/seeders"), "ProductSeeder");
    expect(await readFile(seeder, "utf8")).toContain("extends _BundleSeeder");
    await expect(generateSeeder(join(root, "database/seeders"), "ProductSeeder")).rejects.toThrow();
  });
});

for (const [connection, variable] of [["postgresql", "BUNDLE_TEST_POSTGRESQL_URL"], ["mariadb", "BUNDLE_TEST_MARIADB_URL"]] as const) {
  test.skipIf(!process.env[variable])(`${connection}: live database persistence contract (explicit opt-in)`, async () => {
    if (process.env.BUNDLE_TEST_ALLOW_RESET !== "1") throw new Error("Live tests require BUNDLE_TEST_ALLOW_RESET=1 and an empty disposable database.");
    const { env, root } = await fixture(connection, process.env[variable]);
    const orm = await openDatabase(env, root);
    let ownsDatabase = false;
    try {
      const tables = await orm.em.fork().getKysely().introspection.getTables();
      if (tables.length) throw new Error("Refusing live tests: the supplied database must be empty.");
      ownsDatabase = true;
      await exercisePersistence(env, root);
    } finally {
      if (ownsDatabase) await orm.schema.drop({ dropMigrationsTable: true });
      await orm.close(true);
    }
  }, 60000);
}
