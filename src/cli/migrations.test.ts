import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { databaseFixture } from "../database/testing.ts";
import { withDatabase } from "../database/connection.ts";
import { acquireMigrationLock, readHistory } from "../database/migration-tools.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() {
  const fixture = await databaseFixture();
  cleanups.push(fixture.cleanup);
  const output: string[] = [];
  return { ...fixture, output, run: async (...args: string[]) => {
    await createCli({ env: fixture.env, root: fixture.root, output: text => output.push(text) }).parseAsync(args, { from: "user" });
    return JSON.parse(output.at(-1)!);
  } };
}
async function addMigration(root: string, number: number, up?: string) {
  const name = `Migration2026110700000${number}`;
  await writeFile(join(root, `database/migrations/sqlite/${name}.ts`), `import { Migration } from "@mikro-orm/migrations";
export class ${name} extends Migration {
  override up() { this.addSql(${JSON.stringify(up ?? `create table extra_${number} (id integer primary key, value text)`)}); }
  override down() { this.addSql("drop table extra_${number}"); }
}
`, { flag: "wx" });
  return name;
}

describe("Artisan-inspired migration commands", () => {
  test("install upgrades legacy history with a batch column without applying model migrations", async () => {
    const { root, env, run } = await fixture();
    await withDatabase(async orm => {
      await orm.driver.execute("create table mikro_orm_migrations (id integer primary key, name text, executed_at datetime default current_timestamp)");
    }, { env, root });
    expect((await run("migrate:install")).installed).toBe(true);
    await withDatabase(async orm => {
      const tables = await orm.em.fork().getKysely().introspection.getTables();
      expect(tables.map(table => table.name)).not.toContain("users");
      expect(tables.find(table => table.name === "mikro_orm_migrations")?.columns.some(column => column.name === "batch")).toBe(true);
    }, { env, root });
  });
  test("records batches and rolls back the entire latest batch in reverse order", async () => {
    const { root, run } = await fixture();
    await run("migrate");
    const first = await addMigration(root, 1);
    const second = await addMigration(root, 2);
    expect((await run("migrate")).migrated).toEqual([first, second]);
    expect((await run("migrate:status")).executed.map((row: { batch: number }) => row.batch)).toEqual([1, 2, 2]);
    expect((await run("migrate:rollback", "--force")).rolledBack).toEqual([second, first]);
    expect((await run("migrate:status")).executed).toHaveLength(1);
    expect((await run("migrate:status", "--pending")).pending).toHaveLength(2);
  });
  test("step migrations, count rollbacks, explicit batches, and reset select correctly", async () => {
    const { root, run } = await fixture();
    const first = await addMigration(root, 1);
    const second = await addMigration(root, 2);
    await run("migrate", "--step");
    expect((await run("migrate:status")).executed.map((row: { batch: number }) => row.batch)).toEqual([1, 2, 3]);
    expect((await run("migrate:rollback", "--batch", "2", "--force")).rolledBack).toEqual([first]);
    expect((await run("migrate:rollback", "--step", "1", "--force")).rolledBack).toEqual([second]);
    await run("migrate", "--step");
    expect((await run("migrate:rollback", "--step", "2", "--force")).rolledBack).toEqual([second, first]);
    expect((await run("migrate:reset", "--force")).rolledBack).toHaveLength(1);
    expect((await run("migrate:reset", "--force")).rolledBack).toEqual([]);
    await expect(run("migrate:rollback", "--step", "0", "--force")).rejects.toThrow("positive integer");
    await expect(run("migrate:rollback", "--step", "1", "--batch", "2", "--force")).rejects.toThrow("either");
  });
  test("partial refresh reapplies only selected migrations and preserves unrelated rows", async () => {
    const { root, env, run } = await fixture();
    await run("migrate");
    await addMigration(root, 1);
    const second = await addMigration(root, 2);
    await run("migrate");
    await withDatabase(async orm => { await orm.driver.execute("insert into extra_1 (id, value) values (1, 'keep me')"); }, { env, root });
    expect((await run("migrate:refresh", "--step", "1", "--force")).migrated).toEqual([second]);
    await withDatabase(async orm => {
      expect(await orm.driver.execute("select value from extra_1", [], "all")).toEqual([{ value: "keep me" }]);
    }, { env, root });
  });
  test("pretend previews both directions without database/history/file writes", async () => {
    const { root, env, run } = await fixture();
    const before = await readdir(join(root, "database/migrations/sqlite"));
    await expect(run("migrate", "--schema-path", "missing.sql")).rejects.toThrow("does not exist");
    const preview = await run("migrate", "--pretend");
    expect(preview.pretend).toBe(true);
    expect(preview.migrations[0].sql.join("\n")).toContain("create table");
    expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
    expect(await readdir(join(root, "database/migrations/sqlite"))).toEqual(before);
    await run("migrate");
    const rollback = await run("migrate:rollback", "--pretend");
    expect(rollback.migrations[0].sql.join("\n")).toContain("drop table");
    expect((await run("migrate:status")).executed).toHaveLength(1);
    expect((await run("migrate:refresh", "--pretend")).migrations.map((row: { direction: string }) => row.direction)).toEqual(["down", "up"]);
    expect((await run("migrate:reset", "--pretend")).migrations).toHaveLength(1);
    env.NODE_ENV = "production";
    expect((await run("migrate", "--pretend")).migrations).toEqual([]);
    await expect(run("migrate", "--pretend", "--isolated")).rejects.toThrow("cannot be combined");
  });
  test("pretend refuses imperative migration database access before executing it", async () => {
    const { root, run } = await fixture();
    const name = "Migration20261107000001";
    await writeFile(join(root, `database/migrations/sqlite/${name}.ts`), `import { Migration } from "@mikro-orm/migrations";
export class ${name} extends Migration { override async up() { await this.execute("create table forbidden (id integer)"); } }
`);
    await expect(run("migrate", "--pretend")).rejects.toThrow("imperative database access");
    expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
  });
  test("isolation locks contend across connections, survive no schema drift, and release on failure", async () => {
    const { root, env, run } = await fixture();
    await withDatabase(async owner => {
      const release = await acquireMigrationLock(owner);
      expect(release).toBeFunction();
      try {
        expect((await run("migrate", "--isolated")).skipped).toBe(true);
        expect(await readHistory(owner)).toEqual([]);
      } finally { await release!(); }
    }, { env, root });
    expect((await run("migrate", "--isolated")).migrated).toHaveLength(1);
    expect((await run("migrate:check")).schemaCurrent).toBe(true);
    expect((await run("make:migration", "no_lock_drift")).file).toBeNull();
    await addMigration(root, 1, "create table users (id integer)");
    await expect(run("migrate", "--isolated")).rejects.toThrow();
    await withDatabase(async orm => {
      const release = await acquireMigrationLock(orm);
      expect(release).toBeFunction();
      await release!();
    }, { env, root });
    await expect(run("migrate:unlock")).rejects.toThrow("--force");
    expect((await run("migrate:unlock", "--force")).unlocked).toBe(0);
  });
  test("graceful explicitly reports runtime failures without pretending they succeeded", async () => {
    const { root, run } = await fixture();
    await addMigration(root, 1, "not valid SQL");
    const result = await run("migrate", "--graceful", "--isolated");
    expect(result.failed).toBe(true);
    expect(result.graceful).toBe(true);
    expect((await run("migrate:status")).executed).toHaveLength(0);
  });
  test("named connections and custom migration paths select one target without leaking defaults", async () => {
    const { root, env, run } = await fixture();
    env.BUNDLE_CONNECTIONS = JSON.stringify({ testing: { DB_CONNECTION: "sqlite", DB_DATABASE: "selected.sqlite" } });
    const directory = join(root, "custom-migrations");
    await mkdir(directory);
    await cp(join(root, "database/migrations/sqlite/Migration20261106000000.ts"), join(directory, "Migration20261106000000.ts"));
    expect((await run("migrate", "--database", "testing", "--path", "custom-migrations")).migrated).toHaveLength(1);
    expect(await Bun.file(join(root, "selected.sqlite")).exists()).toBe(true);
    expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
    expect((await run("migrate:status", "--database", "testing", "--path", directory, "--realpath")).executed[0].batch).toBe(1);
  });
  test("diff generation refuses an uninitialized pending baseline before creating duplicate table SQL", async () => {
    const { run, root } = await fixture();
    await expect(run("make:migration", "unsafe_diff")).rejects.toThrow("Apply pending migrations");
    await expect(run("make:model", "Product", "--migration")).rejects.toThrow("Apply pending migrations");
    expect(await Bun.file(join(root, "src/models/Product.ts")).exists()).toBe(false);
    expect((await readdir(join(root, "database/migrations/sqlite"))).filter(name => name.endsWith(".ts"))).toHaveLength(1);
  });
  test("preview does not upgrade legacy history or advance snapshots", async () => {
    const { root, env, run } = await fixture();
    await withDatabase(async orm => {
      await orm.driver.execute("create table mikro_orm_migrations (id integer primary key, name text, executed_at datetime default current_timestamp)");
    }, { env, root });
    await run("migrate", "--pretend");
    await withDatabase(async orm => {
      const tables = await orm.em.fork().getKysely().introspection.getTables();
      expect(tables).toHaveLength(1);
      expect(tables[0]?.columns.some(column => column.name === "batch")).toBe(false);
    }, { env, root });
  });
  test("blank/table/create stubs do not advance model snapshots", async () => {
    const { root, run } = await fixture();
    await run("migrate");
    const snapshot = join(root, "database/migrations/sqlite/.snapshot.json");
    const before = await readFile(snapshot, "utf8");
    await run("make:model", "Product");
    await run("make:migration", "manual", "--blank");
    await run("make:migration", "edit_users", "--table", "users");
    expect(await readFile(snapshot, "utf8")).toBe(before);
    const created = await run("make:migration", "create_widgets", "--create", "widgets");
    expect(await readFile(join(root, "database/migrations/sqlite", created.file), "utf8")).toContain("create table");
    expect(await readFile(snapshot, "utf8")).toBe(before);
    await expect(run("make:migration", "bad", "--create", "users; drop table users")).rejects.toThrow("SQL identifiers");
    await expect(run("make:migration", "bad", "--blank", "--create", "widgets")).rejects.toThrow("Choose only one");
  });
  test("editing an existing model generates reversible column changes and preserves rows", async () => {
    const { root, env, run } = await fixture();
    await run("migrate");
    await run("make:model", "Product", "--migration");
    await run("migrate");
    await withDatabase(async orm => {
      const em = orm.em.fork();
      em.create(orm.getMetadata().getByClassName("Product").class!, {});
      await em.flush();
    }, { env, root });
    const model = join(root, "src/models/Product.ts");
    const source = (await readFile(model, "utf8"))
      .replace('"createdAt" | "updatedAt"', '"createdAt" | "updatedAt" | "sku"')
      .replace("  id!: number;", '  id!: number;\n  sku = "unknown";')
      .replace('    id: { type: "number", primary: true },', '    id: { type: "number", primary: true },\n    sku: { type: "string", default: "unknown" },');
    await writeFile(model, source);
    // Real CLI invocations start fresh modules; an in-process test would reuse
    // Bun's cached ESM class from before the model edit.
    for (const path of ["src/cli", "src/database", "src/web", "index.ts", "package.json"]) {
      await cp(new URL(`../../${path}`, import.meta.url), join(root, path), { recursive: true });
    }
    const runFresh = async (...args: string[]) => {
      const child = Bun.spawn(["bun", "run", "index.ts", ...args], { cwd: root,
        env: { ...process.env, ...env, DATABASE_URL: "", NODE_ENV: "test", APP_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout);
    };
    const migration = await runFresh("make:migration", "add_product_sku");
    expect(await readFile(join(root, "database/migrations/sqlite", migration.file), "utf8")).toContain("sku");
    await runFresh("migrate");
    await withDatabase(async orm => {
      expect(await orm.driver.execute("select sku from product", [], "all")).toEqual([{ sku: "unknown" }]);
    }, { env, root });
    await runFresh("migrate:rollback", "--force");
    expect((await run("db:table", "product")).columns.some((column: { name: string }) => column.name === "sku")).toBe(false);
    await withDatabase(async orm => { expect(await orm.driver.execute("select count(*) as count from product", [], "all")).toEqual([{ count: 1 }]); }, { env, root });
  });
  test("model convenience flags and named seeder flags work", async () => {
    const { run } = await fixture();
    await run("migrate");
    const generated = await run("make:model", "Product", "-ms");
    expect(generated.created).toEndWith("Product.ts");
    expect(generated.seeder).toEndWith("ProductSeeder.ts");
    expect(generated.migration).toContain("create_product");
    expect((await run("migrate", "--seeder", "ProductSeeder")).seeded).toBe(true);
    expect((await run("db:seed", "--class", "ProductSeeder")).seeded).toBe("ProductSeeder");
    await expect(run("db:seed", "DatabaseSeeder", "--class", "ProductSeeder")).rejects.toThrow("either");
  });
  test("pretend includes schema bootstrap SQL and excludes already-dumped migrations", async () => {
    const { run, env, root } = await fixture();
    await run("migrate");
    await run("schema:dump");
    const next = await addMigration(root, 1);
    env.DB_DATABASE = "preview.sqlite";
    const preview = await run("migrate", "--pretend");
    expect(preview.schema.sql.toLowerCase()).toContain("create table");
    expect(preview.migrations.map((row: { name: string }) => row.name)).toEqual([next]);
    expect(await Bun.file(join(root, "preview.sqlite")).exists()).toBe(false);
  });
  test("schema dump pruning bootstraps a new database then applies subsequent migrations", async () => {
    const { root, env, run } = await fixture();
    await run("migrate", "--seed");
    await expect(run("schema:dump", "--prune")).rejects.toThrow("--force");
    const dump = await run("schema:dump", "--prune", "--force");
    expect(dump.pruned).toHaveLength(1);
    expect(await readFile(dump.file, "utf8")).not.toContain("demo@example.test");
    await expect(run("migrate:rollback", "--force")).rejects.toThrow("missing migration");
    await run("make:model", "Product");
    const next = (await run("make:migration", "add_products")).file.replace(/\.ts$/, "");
    env.DB_DATABASE = "rebuilt.sqlite";
    expect((await run("migrate", "--isolated")).migrated).toEqual([next]);
    const status = await run("migrate:status");
    expect(status.executed.map((row: { batch: number }) => row.batch)).toEqual([1, 2]);
    await withDatabase(async orm => {
      expect(await orm.driver.execute("select * from users", [], "all")).toEqual([]);
    }, { env, root });
    expect((await run("migrate:fresh", "--force", "--isolated")).migrated).toEqual([next]);
  });
});
