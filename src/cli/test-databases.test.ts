import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { databaseFixture } from "../database/testing.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() { const value = await databaseFixture(); cleanups.push(value.cleanup); await mkdir(join(value.root, "tests")); return value; }

test("test --parallel --isolated-databases consumes real migrated native worker SQLite", async () => {
  const { root, env } = await fixture();
  await writeFile(join(root, "tests/Database.test.ts"), `import {expect,test} from "bun:test"; import {openDatabase} from ${JSON.stringify(new URL("../database/connection.ts", import.meta.url).href)};test("native migrated DB",async()=>{const orm=await openDatabase(process.env,${JSON.stringify(root)});try{expect(await orm.em.fork().count(orm.getMetadata().getByClassName("User").class)).toBe(0)}finally{await orm.close(true)}});`);
  let output = "";
  await createCli({ root, env, output: text => { output += text; }, error: text => { output += text; } }).parseAsync(["test", "--parallel", "--isolated-databases", "tests/Database.test.ts"], { from: "user" });
  expect(output).toContain("1 pass");
  expect(await readdir(join(root, ".bundle-test-databases"))).toEqual([]);
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
});

test("isolated test flag requires explicit parallel mode and refuses global alternate targets", async () => {
  const { root, env } = await fixture();
  for (const args of [["test", "--isolated-databases"], ["--database", "sqlite", "test", "--parallel", "--isolated-databases"], ["--path", "database/migrations/sqlite", "test", "--parallel", "--isolated-databases"]]) {
    await expect(createCli({ root, env, output() {} }).parseAsync(args, { from: "user" })).rejects.toThrow();
  }
  expect((await readdir(root)).includes(".bundle-test-databases")).toBe(false);
});

test("actual copied CLI entrypoint consumes isolated worker preload from a Unicode/space root", async () => {
  const { root: parent, env } = await fixture(); const root = join(parent, "space é"); await mkdir(root);
  for (const file of ["src", "index.ts", "package.json", "database"]) await cp(new URL(`../../${file}`, import.meta.url), join(root, file), { recursive: true });
  await mkdir(join(root, "tests")); await writeFile(join(root, "tests/Native.test.ts"), 'import {expect,test} from "bun:test";test("preload",()=>{expect(process.env.DB_DATABASE).toContain(".bundle-test-databases/");expect(process.env.APP_ENV).toBe("test")});');
  const child = Bun.spawn([process.execPath, join(root, "index.ts"), "test", "--parallel", "--isolated-databases", "tests/Native.test.ts"], { cwd: root, env: { ...process.env, ...env, APP_ENV: "test", NODE_ENV: "test", BUN_OPTIONS: "", DATABASE_URL: "", BUNDLE_CONNECTIONS: "{}" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status, out + err).toBe(0); expect(out + err).toContain("1 pass"); expect(await readdir(join(root, ".bundle-test-databases"))).toEqual([]);
}, 20000);
