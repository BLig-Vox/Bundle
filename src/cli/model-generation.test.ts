import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { databaseFixture } from "../database/testing.ts";
import { withDatabase } from "../database/connection.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() {
  const value = await databaseFixture(); cleanups.push(value.cleanup);
  return { ...value, run: async (...args: string[]) => {
    let output = "";
    await createCli({ root: value.root, env: value.env, output: text => { output = text; } })
      .parseAsync(args, { from: "user" });
    return output.startsWith("{") || output.startsWith("[") ? JSON.parse(output) : output;
  } };
}
const paths = ["src/models/Widget.ts", "database/seeders/WidgetSeeder.ts", "database/factories/WidgetFactory.ts"];

test("paired model/factory/seeder outputs are consumed by native SQLite Factory without generation-time DB creation", async () => {
  const { root, env, run } = await fixture();
  const result = await run("make:model", "Widget", "-fs");
  expect(result.created).toBe(join(root, paths[0]!));
  expect(result.seeder).toBe(join(root, paths[1]!));
  expect(result.factory).toBe(join(root, paths[2]!));
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
  expect(await readFile(result.factory, "utf8")).toContain('../../src/models/Widget.ts');
  await withDatabase(async orm => {
    await orm.schema.create();
    const { WidgetFactory } = await import(result.factory);
    const manager = orm.em.fork();
    const entity = await new WidgetFactory(manager).createOne({});
    expect(entity.id).toBeGreaterThan(0);
    expect(await manager.count(orm.getMetadata().getByClassName("Widget").class!)).toBe(1);
  }, { root, env });
});

test.each(paths)("paired generation preflights existing %s before writing any other selected output", async collision => {
  const { root, run } = await fixture();
  const filename = join(root, collision);
  await mkdir(join(filename, ".."), { recursive: true });
  await writeFile(filename, "existing source\n");
  await expect(run("--force", "make:model", "Widget", "--factory", "--seed")).rejects.toThrow();
  expect(await readFile(filename, "utf8")).toBe("existing source\n");
  for (const path of paths.filter(path => path !== collision)) expect(await Bun.file(join(root, path)).exists()).toBe(false);
});

test("paired generation validates names and consumed factory stub before creating model/seeder", async () => {
  const { root, run } = await fixture();
  for (const name of ["../Escape", "Date", "lowercase", "Bad/Name"]) {
    await expect(run("make:model", name, "--factory", "--seed")).rejects.toThrow();
  }
  await run("stub:publish");
  await writeFile(join(root, "stubs/factory.ts.stub"), "export class {{name}} {}\n");
  await expect(run("make:model", "Widget", "--factory", "--seed")).rejects.toThrow("Invalid tokens");
  for (const path of paths) expect(await Bun.file(join(root, path)).exists()).toBe(false);
});

test("paired generation refuses linked parents and dangling destinations before other writes", async () => {
  for (const dangling of [false, true]) {
    const { root, run } = await fixture(); const outside = await fixture();
    if (dangling) {
      await mkdir(join(root, "database/factories"), { recursive: true });
      await symlink(join(outside.root, "missing.ts"), join(root, paths[2]!));
    } else await symlink(outside.root, join(root, "database/factories"));
    await expect(run("make:model", "Widget", "--factory", "--seed")).rejects.toThrow();
    expect(await Bun.file(join(root, paths[0]!)).exists()).toBe(false);
    expect(await Bun.file(join(root, paths[1]!)).exists()).toBe(false);
    expect(await Bun.file(join(outside.root, "WidgetFactory.ts")).exists()).toBe(false);
  }
});

test("paired model creation consumes customized factory stub", async () => {
  const { root, run } = await fixture();
  await run("stub:publish");
  await writeFile(join(root, "stubs/factory.ts.stub"), 'import { {{modelName}} } from "{{modelImport}}"; export class {{name}} { readonly model = {{modelName}}; readonly custom = true; }\n');
  const result = await run("make:model", "Widget", "--factory");
  const { WidgetFactory } = await import(result.factory);
  expect(new WidgetFactory().custom).toBe(true);
  expect(new WidgetFactory().model.name).toBe("Widget");
});

test("overlong selected factory filename refuses before creating the otherwise valid model", async () => {
  const { root, run } = await fixture();
  const name = "A".repeat(247);
  await expect(run("make:model", name, "--factory")).rejects.toThrow();
  expect(await Bun.file(join(root, "src/models", `${name}.ts`)).exists()).toBe(false);
});

test.each([["--factory", 245], ["--seed", 246]] as const)("selected %s filenames accept exactly 255 bytes and reject the next byte", async (flag, limit) => {
  const { root, run } = await fixture();
  const accepted = "A".repeat(limit);
  const result = await run("make:model", accepted, flag);
  expect(await Bun.file(result.created).exists()).toBe(true);
  expect(await Bun.file(flag === "--factory" ? result.factory : result.seeder).exists()).toBe(true);
  const rejected = "A".repeat(limit + 1);
  await expect(run("make:model", rejected, flag)).rejects.toThrow("255 bytes");
  expect(await Bun.file(join(root, "src/models", `${rejected}.ts`)).exists()).toBe(false);
});

test.each(["Promise", "Error"])("paired planner preserves existing model name %s", async name => {
  for (const flags of [[], ["--factory", "--seed"]]) {
    const { root, run } = await fixture();
    const result = await run("make:model", name, ...flags);
    expect(result.created).toBe(join(root, "src/models", `${name}.ts`));
    expect(await readFile(result.created, "utf8")).toContain(`export class ${name}`);
    if (flags.length) expect(await Bun.file(result.factory).exists()).toBe(true);
  }
});

test("real entrypoint composes model migration factory seeder in a disposable migration root", async () => {
  const { root } = await fixture();
  for (const path of ["src", "index.ts", "package.json"]) await cp(new URL(`../../${path}`, import.meta.url), join(root, path), { recursive: true });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(root, "index.ts"), ...args], {
      cwd: root, env: { ...process.env, BUN_OPTIONS: "", DB_CONNECTION: "sqlite", DB_DATABASE: "entry.sqlite", DATABASE_URL: "", NODE_ENV: "test", APP_ENV: "test" }, stdout: "pipe", stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(""); expect(code).toBe(0); return JSON.parse(output);
  };
  await run("migrate");
  const generated = await run("make:model", "Widget", "-mfs");
  expect(generated.migration).toContain("create_widget");
  expect(generated.factory).toBe(join(root, paths[2]!));
  expect(generated.seeder).toBe(join(root, paths[1]!));
  expect((await run("migrate")).migrated).toHaveLength(1);
  expect((await run("db:table", "widget")).name).toBe("widget");
  expect((await run("db:seed", "WidgetSeeder")).seeded).toBe("WidgetSeeder");
}, 30000);
