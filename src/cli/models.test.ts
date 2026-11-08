import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { databaseFixture } from "../database/testing.ts";
import { projectRoot, type Environment } from "../database/config.ts";
import { withDatabase } from "../database/connection.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function emptyFixture() {
  const root = await mkdtemp(join(projectRoot, ".data/model-fields-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const args = (fields: string[]) => fields.flatMap(field => ["--field", field]);
const run = async (root: string, command: string[], env: Environment = { DB_CONNECTION: "sqlite", DB_DATABASE: "test.sqlite" }) => {
  const output: string[] = [];
  await createCli({ root, env, output: text => output.push(text) }).parseAsync(command, { from: "user" });
  return output.at(-1)!;
};

test("model fields: validate the complete bounded grammar before any filesystem or database write", async () => {
  const root = await emptyFixture();
  const invalid = [
    ["x"], ["x:string\n"], ["x:string??"], ["x?:string"], ["x:uuid"], ["x:Date"], ["x:decimal"],
    ["x:string;process.exit()"], ["x:() => string"], ["bad-name:string"], ["1x:string"],
    ["__proto__:json"], ["constructor:string"], ["prototype:string"], ["id:integer"], ["ID:integer"],
    ["createdAt:date"], ["created_at:date"], ["updatedAt:date?"], ["updated_at:date"],
    ["toString:string"], ["hasOwnProperty:boolean"], ["class:string"], ["then:boolean"],
    ["x:string", "x:text?"], ["someName:string", "some_name:string"], ["x:string", "X:string"],
    [`${"x".repeat(65)}:string`], Array.from({ length: 65 }, (_, i) => `f${i}:boolean`),
  ];
  for (const fields of invalid) {
    let message = "";
    try { await run(root, ["make:model", "Valid", ...args(fields), "-m", "-s"]); }
    catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/field/i);
    expect(message).not.toContain("unknown option");
    if (fields[0]!.length > 10) expect(message).not.toContain(fields[0]!);
    expect(await readdir(root)).toEqual([]);
  }
  for (const name of ["Bad\n", "Date", "CON", "A".repeat(65)]) {
    await expect(run(root, ["make:model", name, "--field", "ok:string", "-m"])).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  }
});

test("model fields: deterministic order, count boundary, and no-field compatibility", async () => {
  const root = await emptyFixture();
  await run(root, ["make:model", "Empty"]);
  const empty = await readFile(join(root, "src/models/Empty.ts"), "utf8");
  expect(empty).toContain('[_BundleOptionalProps]?: "createdAt" | "updatedAt";');
  expect(empty).toContain('id: { type: "number", primary: true }');
  await run(root, ["make:model", "Maximum", ...args(Array.from({ length: 64 }, (_, i) => `f${i}:boolean`))]);
  await run(root, ["make:model", "Ordered", ...args(["z:string", "a:text?", "m:integer"])]);
  const source = await readFile(join(root, "src/models/Ordered.ts"), "utf8");
  expect(source.indexOf("z!:")).toBeLessThan(source.indexOf("a?:"));
  expect(source.indexOf("a?:")).toBeLessThan(source.indexOf("m!:"));
  expect(source).toContain("a?: string | null;");
  expect(source).toContain('a: { type: "text", nullable: true }');
  const output: string[] = [];
  await expect(createCli({ root, output: text => output.push(text) }).parseAsync(["make:model", "--help"], { from: "user" })).rejects.toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
  expect(output.join("\n")).toContain("--field");
});

test("model fields: CLI migration then persistence round trip for every type and nullable omission", async () => {
  const f = await databaseFixture(); cleanups.push(f.cleanup);
  await run(f.root, ["migrate"], f.env);
  const types = ["string", "text", "integer", "number", "boolean", "date", "json"];
  const result = JSON.parse(await run(f.root, ["make:model", "Measurement", ...args(types.flatMap(type => [`v${type}:${type}`, `n${type}:${type}?`])), "-m", "-s"], f.env));
  expect(result.created).toEndWith("Measurement.ts");
  expect(result.seeder).toEndWith("MeasurementSeeder.ts");
  expect(result.migration).toContain("create_measurement");
  await withDatabase(async orm => {
    // Generation must not apply the migration itself.
    expect((await orm.migrator.getPending()).length).toBe(1);
  }, { root: f.root, env: f.env });
  await run(f.root, ["migrate"], f.env);
  await run(f.root, ["db:seed", "MeasurementSeeder"], f.env);
  await withDatabase(async orm => {
    const model = orm.getMetadata().getByClassName("Measurement").class!;
    const values = { vstring: "hello", vtext: "long\ntext", vinteger: -42, vnumber: 1.25, vboolean: false, vdate: new Date("2026-01-02T03:04:05.000Z"), vjson: { a: [1, true, null, "ok"] } };
    const nullable = Object.fromEntries(Object.entries(values).map(([key, value]) => [`n${key.slice(1)}`, value]));
    const em = orm.em.fork();
    const omitted = em.create(model, values);
    const populated = em.create(model, { ...values, ...nullable });
    const explicit = em.create(model, { ...values, ...Object.fromEntries(types.map(type => [`n${type}`, null])) });
    await em.flush(); em.clear();
    for (const entity of [omitted, explicit, populated]) {
      const loaded = await em.findOneOrFail(model, { id: entity.id });
      for (const [key, value] of Object.entries(values)) expect(loaded[key]).toEqual(value);
      for (const type of types) expect(loaded[`n${type}`]).toEqual(entity === populated ? nullable[`n${type}`] : null);
    }
    expect(await em.count(model, { vstring: "hello", vinteger: -42, vboolean: false })).toBe(3);
  }, { root: f.root, env: f.env });
  await writeFile(join(f.root, "typecheck.ts"), `import { Measurement } from "./src/models/Measurement.ts";
import type { RequiredEntityData } from "@mikro-orm/core";
const valid: RequiredEntityData<Measurement> = { vstring: "s", vtext: "t", vinteger: 1, vnumber: 1.5, vboolean: false, vdate: new Date(), vjson: { nested: [null, true] } };
const nullable: RequiredEntityData<Measurement> = { ...valid, nstring: null, ndate: null, njson: null };
// @ts-expect-error Required fields cannot be omitted.
const missing: RequiredEntityData<Measurement> = {};
const { vjson, ...withoutJson } = valid;
// @ts-expect-error Non-nullable JSON is required in creation data.
const missingJson: RequiredEntityData<Measurement> = withoutJson;
// @ts-expect-error Required JSON does not accept top-level null.
const nullJson: Measurement["vjson"] = null;
// @ts-expect-error No implicit integer coercion.
const wrong: RequiredEntityData<Measurement> = { ...valid, vinteger: "1" };
// @ts-expect-error JSON does not accept functions.
const unsafe: Measurement["vjson"] = () => 1;
`);
  const child = Bun.spawn(["bun", "x", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ESNext", "--module", "preserve", "--moduleResolution", "bundler", "--types", "bun", "--allowImportingTsExtensions", "typecheck.ts"], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ stdout, stderr, code }).toEqual({ stdout: "", stderr: "", code: 0 });
}, 30000);

test("model fields: migration failure preserves and clearly reports the editable model", async () => {
  const f = await databaseFixture(); cleanups.push(f.cleanup);
  await run(f.root, ["migrate"], f.env);
  await writeFile(join(f.root, "database/migrations/sqlite/.snapshot.json"), "invalid snapshot");
  await expect(run(f.root, ["make:model", "Preserved", "--field", "label:string", "-m", "-s"], f.env)).rejects.toThrow(/Migration generation failed.*model.*preserved/i);
  expect(await readFile(join(f.root, "src/models/Preserved.ts"), "utf8")).toContain("label!: string");
  expect(await readFile(join(f.root, "database/seeders/PreservedSeeder.ts"), "utf8")).toContain("PreservedSeeder");
  expect((await readdir(join(f.root, "database/migrations/sqlite"))).filter(name => name.includes("create_preserved"))).toEqual([]);
});

test("model fields: exclusive collisions and symlink destinations and ancestors stay safe", async () => {
  const root = await emptyFixture();
  const command = ["make:model", "Owned", "--field", "label:string"];
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => run(root, command)));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const file = join(root, "src/models/Owned.ts");
  await writeFile(file, "// owned");
  await expect(run(root, [...command, "--force"])).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("// owned");
  await symlink(file, join(root, "src/models/Linked.ts"));
  await symlink(join(root, "missing"), join(root, "src/models/Dangling.ts"));
  await mkdir(join(root, "src/models/Directory.ts"));
  for (const name of ["Linked", "Dangling", "Directory"]) await expect(run(root, ["make:model", name, "--field", "x:string"])).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("// owned");
  for (const segment of ["src", "src/models", "root"]) {
    const f = await emptyFixture();
    await mkdir(join(f, "outside"));
    if (segment.includes("/")) await mkdir(join(f, "src"));
    await symlink(join(f, "outside"), join(f, segment));
    await expect(run(segment === "root" ? join(f, "root") : f, ["make:model", "Safe", "--field", "x:string"])).rejects.toThrow(/director|symlink/i);
    expect(await readdir(join(f, "outside"))).toEqual([]);
  }
});

test("model fields: generated app entry point creates fields, generates and applies migration, and rejects without writes", async () => {
  const root = await emptyFixture();
  await run(root, ["make:app", "Example"]);
  const app = join(root, "example");
  await mkdir(join(app, "node_modules"));
  await symlink(projectRoot, join(app, "node_modules/bundle"));
  const env = { ...process.env, DB_CONNECTION: "sqlite", DB_DATABASE: join(app, "app.sqlite"), DATABASE_URL: "", NODE_ENV: "test", APP_ENV: "test" };
  const cli = async (...command: string[]) => {
    const child = Bun.spawn(["bun", "run", "scripts/bundle.ts", ...command], { cwd: app, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  const before = await readdir(join(app, "src/models"));
  const rejected = await cli("make:model", "Invalid", "--field", "password:secret-source()", "-m", "-s");
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain("field");
  expect(rejected.stderr).not.toContain("secret-source");
  expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  expect(await readdir(join(app, "src/models"))).toEqual(before);
  for (const command of [
    ["make:migration", "initial"], ["migrate"],
    ["make:model", "Product", "--field", "title:string", "--field", "price:number", "--field", "description:text?", "-m", "-s"],
    ["migrate"], ["db:seed", "ProductSeeder"], ["model:show", "Product"], ["list"], ["make:model", "--help"],
  ]) {
    const result = await cli(...command);
    expect({ stderr: result.stderr, code: result.code }).toEqual({ stderr: "", code: 0 });
    if (command[0] === "make:model" && command[1] === "Product") {
      const output = JSON.parse(result.stdout);
      expect(output.migration).toContain("create_product");
      expect(output.created).toEndWith("Product.ts");
    }
    if (command[0] === "model:show") expect(JSON.parse(result.stdout)[0].properties).toContainEqual({ name: "description", type: "text", kind: "scalar", nullable: true, primary: false });
    if (command[0] === "list") expect(result.stdout).toContain("typed fields");
    if (command[1] === "--help") expect(result.stdout).toContain("--field");
  }
}, 30000);

test("model fields: seeder collision preserves user files and reports the already-created model", async () => {
  const root = await emptyFixture();
  await mkdir(join(root, "database/seeders"), { recursive: true });
  await writeFile(join(root, "database/seeders/OwnedSeeder.ts"), "// user seeder");
  await expect(run(root, ["make:model", "Owned", "--field", "title:string", "-s"])).rejects.toThrow(/Seeder generation failed.*model file preserved/i);
  expect(await readFile(join(root, "database/seeders/OwnedSeeder.ts"), "utf8")).toBe("// user seeder");
  expect(await readFile(join(root, "src/models/Owned.ts"), "utf8")).toContain("title!: string;");
});
