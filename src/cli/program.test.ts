import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCli, safeError } from "./program.ts";
import { databaseFixture } from "../database/testing.ts";
import { withDatabase } from "../database/connection.ts";
import { Logger } from "../logging/logger.ts";

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
  test("routes log-follow diagnostics to the injected error handler", async () => {
    const { root, env } = await fixture();
    await new Logger({ root, env }).log("info", "fixture record");
    const errors: string[] = [];
    await createCli({ root, env, output: () => {}, error: text => errors.push(text) })
      .parseAsync(["pail", "--follow", "--timeout", "30", "--json"], { from: "user" });
    expect(errors.some(text => text.includes("In-place rewrites"))).toBe(true);
  });
  test("lists commands without connecting to a database", async () => {
    const output: string[] = [];
    await createCli({ env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) }).parseAsync(["list"], { from: "user" });
    expect(output[0]).toContain("make:model");
    expect(output[0]).toContain("migrate:rollback");
    expect(output[0]).toContain("db:seed");
  });
  test.skipIf(process.platform === "win32")("db launches the explicit existing SQLite file through an argv-only native client", async () => {
    const { root, env } = await fixture();
    const bin = join(root, "native-bin");
    const database = join(root, "existing.sqlite");
    const capture = join(root, "client-args.txt");
    await mkdir(bin);
    await writeFile(database, "fixture database bytes");
    await writeFile(join(bin, "sqlite3"), `#!/bin/sh\nprintf '%s\\n' "$@" > client-args.txt\nprintf '%s\\n' "$PWD" >> client-args.txt\nprintf '%s' "\${DB_PASSWORD-unset}" > child-secret.txt\nexit 7\n`);
    await chmod(join(bin, "sqlite3"), 0o700);
    env.PATH = bin;
    env.DB_DATABASE = database;
    env.DB_PASSWORD = "must-not-leak";
    const program = createCli({ root, env, output: () => {} });
    await expect(program.parseAsync(["db"], { from: "user" })).rejects.toMatchObject({ exitCode: 7 });
    expect(await readFile(capture, "utf8")).toBe(`-uri\n${pathToFileURL(database).href}?mode=rw&nofollow=1\n${root}\n`);
    expect(await readFile(join(root, "child-secret.txt"), "utf8")).toBe("unset");
    expect(await readFile(database, "utf8")).toBe("fixture database bytes");
  });
  test("db refuses missing client and database without creating files", async () => {
    const { root, env, run } = await fixture();
    const database = join(root, "not-created.sqlite");
    env.DB_DATABASE = database;
    env.PATH = join(root, "empty-path");
    await mkdir(env.PATH);
    await expect(run("db")).rejects.toThrow(/existing.*sqlite|sqlite.*file/i);
    expect(await Bun.file(database).exists()).toBe(false);
  });
  test("db refuses an unavailable sqlite3 binary without invoking another program", async () => {
    const { root, env, run } = await fixture();
    const bin = join(root, "empty-path");
    env.DB_DATABASE = join(root, "existing.sqlite");
    await writeFile(env.DB_DATABASE, "fixture");
    await mkdir(bin);
    env.PATH = bin;
    await expect(run("db")).rejects.toThrow(/requires sqlite3 on PATH/i);
  });
  test.skipIf(process.platform === "win32")("db forwards cancellation to the owned sqlite3 child and reports SIGTERM status", async () => {
    const { root, env } = await fixture();
    const bin = join(root, "native-bin");
    const marker = join(root, "client-started");
    const database = join(root, "existing.sqlite");
    await mkdir(bin);
    env.DB_DATABASE = database;
    await writeFile(database, "fixture");
    await writeFile(join(bin, "sqlite3"), `#!/bin/sh\ntrap 'exit 0' TERM\nprintf started > client-started\nwhile :; do sleep 0.05; done\n`);
    await chmod(join(bin, "sqlite3"), 0o700);
    env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
    const controller = new AbortController();
    const program = createCli({ root, env, signal: controller.signal, output: () => {} });
    const running = program.parseAsync(["db"], { from: "user" });
    for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(5);
    expect(await Bun.file(marker).exists()).toBe(true);
    controller.abort(new Error("SIGTERM"));
    await expect(running).rejects.toMatchObject({ exitCode: 143 });
  });
  test.skipIf(process.platform === "win32")("db does not fall back to the host PATH when an injected environment omits PATH", async () => {
    const { root, env, run } = await fixture();
    const bin = join(root, "host-only-bin");
    await mkdir(bin);
    await writeFile(join(root, "existing.sqlite"), "fixture");
    await writeFile(join(bin, "sqlite3"), `#!/bin/sh\nprintf launched > launched\n`);
    await chmod(join(bin, "sqlite3"), 0o700);
    env.DB_DATABASE = join(root, "existing.sqlite");
    env.PATH = undefined;
    const inheritedPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      await expect(run("db")).rejects.toThrow(/requires sqlite3 on PATH/i);
      expect(await Bun.file(join(root, "launched")).exists()).toBe(false);
    } finally { process.env.PATH = inheritedPath; }
  });
  test.skipIf(process.platform === "win32")("db refuses a database path replaced after identity preflight", async () => {
    const { root, env, run } = await fixture();
    const bin = join(root, "native-bin");
    const database = join(root, "existing.sqlite");
    const replacement = join(root, "replacement.sqlite");
    const launched = join(root, "launched");
    await mkdir(bin);
    await writeFile(database, "selected");
    await writeFile(replacement, "replacement");
    await writeFile(join(bin, "sqlite3"), `#!/bin/sh\nprintf launched > launched\n`);
    await chmod(join(bin, "sqlite3"), 0o700);
    env.PATH = bin;
    env.DB_DATABASE = database;
    const originalWhich = Bun.which;
    let replaced = false;
    Bun.which = (command, options) => {
      if (command === "sqlite3" && !replaced) { replaced = true; renameSync(replacement, database); }
      return originalWhich.call(Bun, command, options);
    };
    try {
      await expect(run("db")).rejects.toThrow(/changed|identity|database/i);
      expect(replaced).toBe(true);
      expect(await Bun.file(launched).exists()).toBe(false);
    } finally { Bun.which = originalWhich; }
  });
  test.skipIf(process.platform === "win32")("runCli leaves terminal Ctrl+C with the interactive SQLite child", async () => {
    const { root } = await fixture();
    const bin = join(root, "native-bin");
    const database = join(root, "existing.sqlite");
    const started = join(root, "client-started");
    const signals = join(root, "client-signals");
    await mkdir(bin);
    await writeFile(database, "fixture");
    await writeFile(join(bin, "sqlite3"), `#!/bin/sh\ntrap 'printf handled >> client-signals' INT\ntrap 'exit 0' TERM\n: > client-started\nkill -INT "$PPID"\nkill -INT "$$"\nwhile :; do sleep 0.05; done\n`);
    await chmod(join(bin, "sqlite3"), 0o700);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, DB_DATABASE: database, DB_CONNECTION: "sqlite", BUN_OPTIONS: "" };
    const runner = new URL("./runner.ts", import.meta.url).href;
    const script = `const {runCli}=await import(${JSON.stringify(runner)});process.exitCode=await runCli(["db"],{root:${JSON.stringify(root)},env:process.env});`;
    const host = Bun.spawn([process.execPath, "-e", script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    let ended = false;
    const exit = host.exited.then(status => { ended = true; return status; });
    const stdout = new Response(host.stdout).text();
    const stderr = new Response(host.stderr).text();
    try {
      for (let attempt = 0; attempt < 200 && !(await Bun.file(started).exists()); attempt++) await Bun.sleep(5);
      expect(await Bun.file(started).exists()).toBe(true);
      for (let attempt = 0; attempt < 200 && !(await Bun.file(signals).exists()); attempt++) await Bun.sleep(5);
      expect(await Bun.file(signals).text()).toContain("handled");
      await Bun.sleep(1200);
      expect(ended).toBe(false);
      host.kill("SIGTERM");
      expect(await exit).toBe(143);
    } finally {
      if (!ended) { host.kill("SIGTERM"); await exit; }
      await stdout;
      await stderr;
    }
  });
  test("db clearly refuses server drivers until a credential-safe native adapter exists", async () => {
    const { root, env, run } = await fixture();
    env.DB_CONNECTION = "postgresql";
    env.DB_DATABASE = "fixture";
    env.DB_USERNAME = "fixture_user";
    env.DB_HOST = "127.0.0.1";
    env.PATH = root;
    await expect(run("db")).rejects.toThrow(/not supported|sqlite/i);
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
    for (const command of ["migrate", "db:seed", "make:migration", "make:cache-table", "make:session-table", "migrate:status", "migrate:check"]) {
      const program = createCli({ env: { NODE_ENV: "production", DB_CONNECTION: "invalid" } });
      await expect(program.parseAsync([command], { from: "user" })).rejects.toThrow("Production database write refused");
    }
    const { root, env } = await fixture();
    await createCli({ env: { ...env, NODE_ENV: "production" }, root, output: () => {} }).parseAsync(["migrate", "--force"], { from: "user" });
    await withDatabase(async orm => expect(await orm.migrator.getExecuted()).toHaveLength(1), { env, root });
  });
  test("cache tables survive later model-diff migrations and rollback", async () => {
    const { run, root, env } = await fixture();
    expect(await Bun.file(join(root, env.DB_DATABASE!)).exists()).toBe(false);
    const generated = JSON.parse(await run("make:cache-table"));
    expect(generated.tables).toEqual(["bundle_cache_entries", "bundle_cache_locks"]);
    expect(generated.file).toContain("create_cache_tables");
    expect(await Bun.file(join(root, env.DB_DATABASE!)).exists()).toBe(false);
    const source = await readFile(join(root, "database/migrations/sqlite", generated.file), "utf8");
    expect(source).toContain("expires_at");
    expect(source).toContain("bundle_cache_locks");
    expect(JSON.parse(await run("migrate")).migrated).toContain(generated.file.replace(/\.ts$/, ""));
    await withDatabase(async orm => {
      const tables = await orm.em.fork().getKysely().introspection.getTables();
      expect(tables.find(table => table.name === "bundle_cache_entries")?.columns.map(column => column.name)).toEqual(["namespace", "cache_key", "value", "expires_at"]);
      expect(tables.find(table => table.name === "bundle_cache_locks")?.columns.map(column => column.name)).toEqual(["namespace", "cache_key", "owner", "expires_at"]);
      await orm.em.fork().getConnection().execute('INSERT INTO `bundle_cache_entries` (`namespace`,`cache_key`,`value`,`expires_at`) VALUES (?,?,?,?)', ["default", "greeting", "hello", Date.now() + 60_000]);
      const rows = await orm.em.fork().getConnection().execute('SELECT `value` FROM `bundle_cache_entries` WHERE `namespace`=? AND `cache_key`=?', ["default", "greeting"]);
      expect(rows).toEqual([{ value: "hello" }]);
      await expect(orm.em.fork().getConnection().execute('INSERT INTO `bundle_cache_entries` (`namespace`,`cache_key`,`value`) VALUES (?,?,?)', ["default", "greeting", "duplicate"])).rejects.toThrow();
    }, { env, root });
    await run("make:model", "Product");
    const followup = JSON.parse(await run("make:migration", "add_products_after_cache"));
    expect(followup.file).toContain("add_products_after_cache");
    const followupSource = await readFile(join(root, "database/migrations/sqlite", followup.file), "utf8");
    const upSource = followupSource.split("override down()")[0];
    expect(upSource).not.toContain("bundle_cache_entries");
    expect(upSource).not.toContain("bundle_cache_locks");
    await run("migrate");
    await run("migrate:rollback", "--force");
    await expect(run("migrate:fresh", "--force")).rejects.toThrow("unmapped tables or views");
    await withDatabase(async orm => {
      const rows = await orm.em.fork().getConnection().execute('SELECT `value` FROM `bundle_cache_entries` WHERE `namespace`=? AND `cache_key`=?', ["default", "greeting"]);
      expect(rows).toEqual([{ value: "hello" }]);
    }, { env, root });
  }, 30000);
  test("session tables survive later model-diff migrations and rollback", async () => {
    const { run, root, env } = await fixture();
    expect(await Bun.file(join(root, env.DB_DATABASE!)).exists()).toBe(false);
    const generated = JSON.parse(await run("make:session-table"));
    expect(generated.tables).toEqual(["sessions"]);
    expect(generated.file).toContain("create_sessions_table");
    expect(await Bun.file(join(root, env.DB_DATABASE!)).exists()).toBe(false);
    const source = await readFile(join(root, "database/migrations/sqlite", generated.file), "utf8");
    for (const column of ["id", "user_id", "ip_address", "user_agent", "payload", "last_activity"]) expect(source).toContain(column);
    expect(JSON.parse(await run("migrate")).migrated).toContain(generated.file.replace(/\.ts$/, ""));
    await withDatabase(async orm => {
      const tables = await orm.em.fork().getKysely().introspection.getTables();
      expect(tables.find(table => table.name === "sessions")?.columns.map(column => column.name)).toEqual(["id", "user_id", "ip_address", "user_agent", "payload", "last_activity"]);
      await orm.em.fork().getConnection().execute('INSERT INTO `sessions` (`id`,`user_id`,`ip_address`,`user_agent`,`payload`,`last_activity`) VALUES (?,?,?,?,?,?)', ["session-a", "user-a", "127.0.0.1", "fixture", "payload", Date.now()]);
    }, { env, root });
    await run("make:model", "Product");
    const followup = JSON.parse(await run("make:migration", "add_products_after_sessions"));
    expect(followup.file).toContain("add_products_after_sessions");
    const followupSource = await readFile(join(root, "database/migrations/sqlite", followup.file), "utf8");
    expect(followupSource.split("override down()")[0]).not.toMatch(/drop table[^;]*sessions/i);
    await run("migrate");
    await run("migrate:rollback", "--force");
    await expect(run("migrate:fresh", "--force")).rejects.toThrow("unmapped tables or views");
    await withDatabase(async orm => {
      const rows = await orm.em.fork().getConnection().execute('SELECT `payload` FROM `sessions` WHERE `id`=?', ["session-a"]);
      expect(rows).toEqual([{ payload: "payload" }]);
    }, { env, root });
  }, 30000);
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
