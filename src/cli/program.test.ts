import { afterEach, describe, expect, test } from "bun:test";
import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createCli, safeError } from "./program.ts";
import { databaseFixture } from "../database/testing.ts";
import { withDatabase } from "../database/connection.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() {
  const value = await databaseFixture();
  cleanups.push(value.cleanup);
  const output: string[] = [];
  return { ...value, output, run: async (...args: string[]) => {
    const program = createCli({ env: value.env, root: value.root, output: text => output.push(text) });
    await program.parseAsync(args, { from: "user" });
    return output.at(-1)!;
  } };
}

describe("Bundle database CLI", () => {
  test("lists commands without connecting to a database", async () => {
    const output: string[] = [];
    await createCli({ env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) }).parseAsync(["list"], { from: "user" });
    expect(output[0]).toContain("make:model");
    expect(output[0]).toContain("make:job");
    expect(output[0]).toContain("migrate:rollback");
    expect(output[0]).toContain("db:seed");
  });
  test("reports configuration without exposing credentials", async () => {
    const output: string[] = [];
    await createCli({
      env: { DB_CONNECTION: "postgresql", DATABASE_URL: "postgres://user:secret@localhost/bundle" },
      output: text => output.push(text),
    }).parseAsync(["about"], { from: "user" });
    expect(output[0]).toContain("postgresql");
    expect(output[0]).not.toContain("secret");
    expect(output[0]).not.toContain("postgres://");
  });
  test("offline model and SQL inspection never creates the application database", async () => {
    const { env, root, run } = await fixture();
    env.DB_DATABASE = join(root, "missing-directory/application.sqlite");
    expect(JSON.parse(await run("model:show", "User"))[0].table).toBe("users");
    expect(await run("schema:sql")).toContain("create table");
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });
  test("migrates, seeds, inspects, rolls back, refreshes, and rebuilds SQLite", async () => {
    const { run } = await fixture();
    expect(JSON.parse(await run("db:check")).connected).toBe(true);
    expect(JSON.parse(await run("migrate:status")).pending).toHaveLength(1);
    expect(JSON.parse(await run("migrate", "--seed")).migrated).toHaveLength(1);
    expect(JSON.parse(await run("migrate")).migrated).toHaveLength(0);
    expect(JSON.parse(await run("migrate:status")).executed).toHaveLength(1);
    expect(JSON.parse(await run("migrate:check")).schemaCurrent).toBe(true);
    expect(JSON.parse(await run("db:seed")).seeded).toBe("DatabaseSeeder");
    expect(JSON.parse(await run("db:show")).some((table: { name: string }) => table.name === "posts")).toBe(true);
    expect(JSON.parse(await run("db:table", "users")).columns.some((column: { name: string }) => column.name === "email")).toBe(true);
    expect(JSON.parse(await run("model:show", "User"))[0].table).toBe("users");
    expect(await run("schema:sql")).toContain("create table");
    await expect(run("db:table", "missing")).rejects.toThrow("Table not found");
    await expect(run("model:show", "Missing")).rejects.toThrow();
    expect(JSON.parse(await run("migrate:rollback", "--force")).rolledBack).toHaveLength(1);
    await run("migrate");
    expect(JSON.parse(await run("migrate:refresh", "--seed", "--force")).seeded).toBe(true);
    expect(JSON.parse(await run("migrate:fresh", "--seed", "--force")).seeded).toBe(true);
    expect(JSON.parse(await run("migrate:reset", "--force")).rolledBack).toHaveLength(1);
  }, 30000);
  test("fresh refuses unmapped historical tables without deleting data or history", async () => {
    const { run, env, root } = await fixture();
    await run("migrate", "--seed");
    await withDatabase(async orm => {
      await orm.em.fork().getKysely().schema.createTable("legacy_users").addColumn("id", "integer").execute();
    }, { env, root });
    await expect(run("migrate:fresh", "--force")).rejects.toThrow("unmapped tables or views");
    await withDatabase(async orm => {
      expect(await orm.migrator.getExecuted()).toHaveLength(1);
      expect(await orm.em.fork().count(orm.getMetadata().getByClassName("User").class!)).toBe(1);
    }, { env, root });
  });
  test("fresh refuses unapplied model changes and pending migrations before dropping data", async () => {
    const { run, env, root } = await fixture();
    await run("migrate", "--seed");
    await run("make:model", "Product");
    await expect(run("migrate:fresh", "--force")).rejects.toThrow("reconcile entity changes");
    await run("make:migration", "add_products");
    await expect(run("migrate:fresh", "--force")).rejects.toThrow("apply pending migrations");
    await withDatabase(async orm => {
      expect(await orm.migrator.getExecuted()).toHaveLength(1);
      expect(await orm.migrator.getPending()).toHaveLength(1);
      expect(await orm.em.fork().count(orm.getMetadata().getByClassName("User").class!)).toBe(1);
    }, { env, root });
    await run("migrate");
    expect(JSON.parse(await run("migrate:fresh", "--force")).migrated).toHaveLength(2);
  });
  test("refuses destructive commands before opening a database unless --force is explicit", async () => {
    const output: string[] = [];
    for (const command of ["migrate:rollback", "migrate:reset", "migrate:refresh", "migrate:fresh"]) {
      const program = createCli({ env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) });
      await expect(program.parseAsync([command], { from: "user" })).rejects.toThrow("--force");
    }
    expect(output).toHaveLength(0);
  });
  test("requires explicit approval for production migrations and seeds", async () => {
    for (const command of ["migrate", "db:seed", "make:migration", "migrate:status", "migrate:check"]) {
      const program = createCli({ env: { NODE_ENV: "production", DB_CONNECTION: "invalid" } });
      await expect(program.parseAsync([command], { from: "user" })).rejects.toThrow("Production database write refused");
    }
    const { root, env } = await fixture();
    await createCli({ env: { ...env, NODE_ENV: "production" }, root, output: () => {} }).parseAsync(["migrate", "--force"], { from: "user" });
    await withDatabase(async orm => expect(await orm.migrator.getExecuted()).toHaveLength(1), { env, root });
  });
  test("generates models, seeders, and blank or diff migrations through the CLI", async () => {
    const { run, root } = await fixture();
    await run("migrate");
    expect(JSON.parse(await run("make:migration", "no_changes")).file).toBeNull();
    expect(JSON.parse(await run("make:model", "Product")).created).toEndWith("Product.ts");
    expect(JSON.parse(await run("make:seeder", "ProductSeeder")).created).toEndWith("ProductSeeder.ts");
    expect(JSON.parse(await run("make:migration", "add_products")).file).toContain("add_products");
    expect(JSON.parse(await run("migrate")).migrated).toHaveLength(1);
    expect(JSON.parse(await run("db:seed", "ProductSeeder")).seeded).toBe("ProductSeeder");
    expect(JSON.parse(await run("make:migration", "manual_change", "--blank")).file).toContain("manual_change");
    await expect(run("make:migration", "../../escape")).rejects.toThrow("Migration names");
    expect((await readdir(join(root, "database/migrations/sqlite"))).some(file => file.includes("manual_change"))).toBe(true);
  }, 30000);
  test("Bun entry point migrates, seeds, and inspects a disposable SQLite database", async () => {
    const { root } = await fixture();
    // Run the real entry point from an isolated project copy: migration snapshots
    // are generated alongside source migrations, not alongside the database file.
    for (const path of ["src", "index.ts", "package.json"]) {
      await cp(new URL(`../../${path}`, import.meta.url), join(root, path), { recursive: true });
    }
    const env = { ...process.env, DB_CONNECTION: "sqlite", DB_DATABASE: join(root, "entry.sqlite"), DATABASE_URL: "", NODE_ENV: "test", APP_ENV: "test" };
    for (const args of [["migrate", "--seed"], ["db:table", "users"], ["migrate:status"]]) {
      const child = Bun.spawn(["bun", "run", "index.ts", ...args], {
        cwd: root, env, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      if (args[0] === "migrate") expect(result.seeded).toBe(true);
      if (args[0] === "db:table") expect(result.name).toBe("users");
      if (args[0] === "migrate:status") expect(result.executed).toHaveLength(1);
    }
  }, 30000);
  test("entry point returns a nonzero status for invalid commands and guards", async () => {
    const cwd = new URL("../../", import.meta.url).pathname;
    for (const args of [["not-a-command"], ["migrate:fresh"]]) {
      const process = Bun.spawn(["bun", "run", "index.ts", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const error = await new Response(process.stderr).text();
      expect(await process.exited).toBe(1);
      expect(error.length).toBeGreaterThan(0);
    }
  });
  test("redacts known credentials and database URLs from errors", () => {
    expect(safeError(new Error("failed postgres://user:secret@host/db password secret"), { DB_PASSWORD: "secret" })).not.toContain("secret");
    expect(safeError(new Error("failed mysql://user:password@host/db"))).toContain("[redacted database URL]");
    expect(safeError(new Error("password p@ss rejected"), { DATABASE_URL: "postgres://user:p%40ss@host/db" })).not.toContain("p@ss");
    expect(safeError(new Error("invalid config"), { DATABASE_URL: "invalid" })).toBe("[redacted] config");
  });
});
