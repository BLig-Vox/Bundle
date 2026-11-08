import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createCli } from "bundle/src/cli/program.ts";
import type { Environment } from "bundle/src/database/config.ts";
import { appRoot } from "./auth.ts";
import { assertProductionDatabase, productionOptions, startProduction } from "../scripts/production.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const baseEnv = (root: string): Environment => ({
  DB_CONNECTION: "sqlite", DB_DATABASE: join(root, ".data/production.sqlite"),
  APP_PUBLIC_ORIGIN: "https://app.example",
});

async function fixture(extra: Environment = {}, migrate = true) {
  await mkdir(join(appRoot, ".data"), { recursive: true });
  const root = await mkdtemp(join(appRoot, ".data/production-test-")); roots.push(root);
  const env = { ...baseEnv(root), ...extra };
  await mkdir(join(root, "src"));
  await mkdir(join(root, "database/migrations/sqlite"), { recursive: true });
  await symlink(join(appRoot, "src/models"), join(root, "src/models"));
  const cli = (...args: string[]) => createCli({ root, env, output: () => {} }).parseAsync(args, { from: "user" });
  if (migrate) {
    await cli("--force", "make:migration", "production_baseline");
    await cli("--force", "migrate");
  }
  return { root, env, cli };
}

test("production config requires exact HTTPS Origin, persistent SQLite and a numeric address", async () => {
  const root = join(appRoot, ".data/config-only.sqlite");
  const base = { DB_CONNECTION: "sqlite", DB_DATABASE: root, APP_PUBLIC_ORIGIN: "https://app.example" };
  expect(productionOptions(base).hostname).toBe("127.0.0.1");
  expect(productionOptions(base).port).toBe(3000);
  expect(productionOptions(base).mode).toBe("app");
  expect(productionOptions({ ...base, BUNDLE_HOST: "0.0.0.0" }).hostname).toBe("0.0.0.0");
  expect(productionOptions({ ...base, BUNDLE_HOST: "2001:db8::1" }).hostname).toBe("2001:db8::1");
  for (const env of [
    { ...base, APP_PUBLIC_ORIGIN: undefined },
    { ...base, APP_PUBLIC_ORIGIN: "http://app.example" },
    { ...base, APP_PUBLIC_ORIGIN: "https://app.example/" },
    { ...base, APP_PUBLIC_ORIGIN: "https://app.example/path" },
    { ...base, BUNDLE_HOST: "localhost" },
    { ...base, BUNDLE_HOST: "0.0.0.0/24" },
    { ...base, BUNDLE_PORT: "0" },
    { ...base, BUNDLE_PORT: "70000" },
    { ...base, DB_CONNECTION: "postgresql", DATABASE_URL: "postgres://user:secret@localhost/app" },
    { ...base, DB_DATABASE: ":memory:" },
  ]) expect(() => productionOptions(env)).toThrow();
});

test("production entrypoint refuses an absent database before attempting to bind", async () => {
  const { env } = await fixture({}, false);
  const runtime = Bun as unknown as { serve: typeof Bun.serve };
  const original = runtime.serve;
  let listeners = 0;
  runtime.serve = (() => { listeners++; throw new Error("unexpected listener"); }) as typeof Bun.serve;
  try {
    await expect(startProduction(env)).rejects.toThrow("database file");
    expect(listeners).toBe(0);
    expect(await lstat(env.DB_DATABASE!).catch(() => undefined)).toBeUndefined();
  } finally { runtime.serve = original; }
});

test("production preflight refuses absent, symlinked, missing-table and pending-migration databases without starting a listener", async () => {
  const { root, env, cli } = await fixture({}, false);
  const dbPath = env.DB_DATABASE!;
  await expect(assertProductionDatabase(env, root)).rejects.toThrow("database file");
  expect(await lstat(dbPath).catch(() => undefined)).toBeUndefined();

  await mkdir(join(root, ".data"), { recursive: true });
  await symlink(join(root, "missing.sqlite"), dbPath);
  await expect(assertProductionDatabase(env, root)).rejects.toThrow("regular");
  await rm(dbPath);

  await cli("--force", "make:migration", "production_baseline");
  await cli("--force", "migrate");
  await assertProductionDatabase(env, root);

  await cli("--force", "make:migration", "pending_change", "--blank");
  await expect(assertProductionDatabase(env, root)).rejects.toThrow("Pending database migrations");
}, 30000);

test("production preflight rejects an existing but unmigrated SQLite schema without creating history", async () => {
  const { root, env, cli } = await fixture({}, false);
  await mkdir(join(root, ".data"), { recursive: true });
  const raw = new Database(env.DB_DATABASE!);
  raw.exec("create table keep_me (id integer primary key)");
  raw.close();
  await expect(assertProductionDatabase(env, root)).rejects.toThrow("not fully migrated");
  const check = new Database(env.DB_DATABASE!);
  expect(check.query("select name from sqlite_master where type = 'table' order by name").all()).toEqual([{ name: "keep_me" }]);
  check.close();
  await cli("--force", "make:migration", "production_baseline");
  await cli("--force", "migrate");
  await assertProductionDatabase(env, root);
}, 30000);
