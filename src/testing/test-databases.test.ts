import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseFixture } from "../database/testing.ts";
import { runIsolatedDatabaseTests, reserveDatabaseTestWorker } from "./test-databases.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() { const value = await databaseFixture(); cleanups.push(value.cleanup); return value; }
async function sources(root: string) { const directory = join(root, "database/migrations/sqlite"); return Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), "utf8")])); }

test("native parallel workers migrate distinct new SQLite databases and preserve application/source state", async () => {
  const { root, env } = await fixture();
  await writeFile(join(root, "test.sqlite"), "application sentinel");
  const before = await sources(root); await mkdir(join(root, "tests"));
  for (const name of ["First", "Second"]) await writeFile(join(root, `tests/${name}.test.ts`), `import {expect,test} from "bun:test"; import {writeFile} from "node:fs/promises"; import {openDatabase} from ${JSON.stringify(new URL("../database/connection.ts", import.meta.url).href)};
 test("isolated ${name}",async()=>{const orm=await openDatabase(process.env,${JSON.stringify(root)});try{const em=orm.em.fork();const User=orm.getMetadata().getByClassName("User").class;expect(await em.count(User)).toBe(0);em.create(User,{name:"same",email:"same@example.invalid"});await em.flush();expect(await em.count(User)).toBe(1);await writeFile(${JSON.stringify(join(root, name + ".json"))},JSON.stringify({pid:process.pid,database:process.env.DB_DATABASE}));await Bun.sleep(100)}finally{await orm.close(true)}});`);
  let output = "";
  const status = await runIsolatedDatabaseTests({ root, env, files: ["tests/First.test.ts", "tests/Second.test.ts"], processes: 2, output: text => { output += text; }, error: text => { output += text; } });
  expect(status, output).toBe(0); expect(output).toContain("2 pass");
  const first = await Bun.file(join(root, "First.json")).json(), second = await Bun.file(join(root, "Second.json")).json();
  expect(first.pid).not.toBe(second.pid); expect(first.database).not.toBe(second.database);
  expect(first.database).toContain(".bundle-test-databases/");
  expect(await Bun.file(first.database).exists()).toBe(false); expect(await Bun.file(second.database).exists()).toBe(false);
  expect(await readFile(join(root, "test.sqlite"), "utf8")).toBe("application sentinel");
  expect(await sources(root)).toEqual(before);
  expect(await readdir(join(root, ".bundle-test-databases"))).toEqual([]);
}, 20000);

test("reserved worker initialization uses native migrations without changing caller environment", async () => {
  const { root } = await fixture(); const run = join(root, "private-run"); await mkdir(run, { mode: 0o700 });
  await writeFile(join(run, "manifest.json"), JSON.stringify({ version: 1, root, token: crypto.randomUUID() }), { mode: 0o600 });
  const before = process.env.DB_DATABASE;
  const worker = await reserveDatabaseTestWorker(run); await worker.initialize();
  expect(process.env.DB_DATABASE).toBe(before);
  expect(await Bun.file(worker.environment.DB_DATABASE!).exists()).toBe(true);
});

test("isolated cancellation settles owned parallel workers and cleans only its new run", async () => {
  const { root, env } = await fixture(); const marker = join(root, "running.json");
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/Hang.test.ts"), `import {test} from "bun:test";import {writeFile} from "node:fs/promises";test("wait",async()=>{await writeFile(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));await Bun.sleep(30000)},40000);`);
  const controller = new AbortController(); let output = "";
  const running = runIsolatedDatabaseTests({ root, env, files: ["tests/Hang.test.ts"], processes: 2, signal: controller.signal, output: text => { output += text; }, error: text => { output += text; } });
  const deadline = Date.now() + 8000;
  while (!(await Bun.file(marker).exists())) { if (Date.now() > deadline) throw new Error(`worker test did not start: ${output}`); await Bun.sleep(5); }
  controller.abort();
  await expect(running).resolves.toBe(130);
  expect(await readdir(join(root, ".bundle-test-databases"))).toEqual([]);
}, 12000);

test("isolated run does not delete its database while an unregistered descendant can remain alive", async () => {
  const { root, env } = await fixture(); const pidFile = join(root, "descendant.pid"); await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/Descendant.test.ts"), `import {test} from "bun:test";import {writeFile} from "node:fs/promises";test("leave an unregistered child",async()=>{const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});child.unref();await writeFile(${JSON.stringify(pidFile)},String(child.pid))});`);
  let pid: number | undefined;
  const alive = async (target: number) => { try { const stat = await readFile(`/proc/${target}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/)[0] !== "Z"; } catch { return false; } };
  try {
    expect(await runIsolatedDatabaseTests({ root, env, files: ["tests/Descendant.test.ts"], output() {}, error() {} })).toBe(0);
    pid = Number(await readFile(pidFile, "utf8"));
    const deadline = Date.now() + 500;
    while (await alive(pid) && Date.now() < deadline) await Bun.sleep(10);
    expect(await alive(pid)).toBe(false);
  } finally { if (pid && await alive(pid)) process.kill(pid, "SIGKILL"); }
}, 20000);

test("unsupported driver, preabort and invalid worker choices fail before creating state", async () => {
  const { root } = await fixture(); const controller = new AbortController(); controller.abort();
  for (const options of [{ env: { DB_CONNECTION: "postgresql" } }, { signal: controller.signal }, { processes: 17 }]) {
    await expect(runIsolatedDatabaseTests({ root, files: [], ...options })).rejects.toThrow();
  }
  expect(await Bun.file(join(root, ".bundle-test-databases/manifest.json")).exists()).toBe(false);
  expect((await readdir(root)).includes(".bundle-test-databases")).toBe(false);
});

test("unregistered worker-shaped directories preserve the owned fixture for inspection", async () => {
  const { root, env } = await fixture(); await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/Unknown.test.ts"), 'import {test} from "bun:test";import {mkdir,writeFile} from "node:fs/promises";import {join} from "node:path";test("unknown worker residue",async()=>{const run=process.env.BUNDLE_TEST_DATABASE_RUN!;await mkdir(join(run,"db-99999999"));await writeFile(join(run,"db-99999999","unknown"),"preserve")});');
  await expect(runIsolatedDatabaseTests({ root, env, files: ["tests/Unknown.test.ts"], output() {}, error() {} })).rejects.toThrow("fixture preserved");
  const runs = await readdir(join(root, ".bundle-test-databases")); expect(runs).toHaveLength(1);
  expect(await readFile(join(root, ".bundle-test-databases", runs[0]!, "db-99999999", "unknown"), "utf8")).toBe("preserve");
});

test("isolated test refuses symlinked migration sources before creating fixture state", async () => {
  const { root, env } = await fixture(); const directory = join(root, "database/migrations/sqlite");
  const name = (await readdir(directory)).find(file => file.endsWith(".ts"))!; const source = join(directory, name); const preserved = join(root, "preserved-migration.ts");
  await Bun.write(preserved, await readFile(source)); await (await import("node:fs/promises")).unlink(source); await (await import("node:fs/promises")).symlink(preserved, source);
  await expect(runIsolatedDatabaseTests({ root, env, files: [], output() {}, error() {} })).rejects.toThrow("migration");
  expect((await readdir(root)).includes(".bundle-test-databases")).toBe(false);
});

test("isolated test preserves worker count, filtering and native Bun output", async () => {
  const { root, env } = await fixture(); await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/Filter.test.ts"), 'import {expect,test} from "bun:test";test("selected",()=>expect(1).toBe(1));test("filtered",()=>expect(2).toBe(2));');
  let output = "";
  expect(await runIsolatedDatabaseTests({ root, env, files: ["tests/Filter.test.ts"], processes: 1, filter: "selected", output: text => { output += text; }, error: text => { output += text; } })).toBe(0);
  expect(output).toContain("1 pass"); expect(output).toContain("1 filtered out");
});

test("setup failure reports nonzero without source writes or application database access", async () => {
  const { root, env } = await fixture(); const before = await sources(root);
  await writeFile(join(root, "test.sqlite"), "sentinel");
  await mkdir(join(root, "tests")); await writeFile(join(root, "tests/Failure.test.ts"), 'import {test} from "bun:test"; test("must not run",()=>{throw new Error("test executed")});');
  await writeFile(join(root, "database/migrations/sqlite/Migration20990101000000.ts"), 'import {Migration} from "@mikro-orm/migrations";export class Migration20990101000000 extends Migration {async up(){throw new Error("setup fixture failure")}}');
  let output = "";
  const status = await runIsolatedDatabaseTests({ root, env, files: ["tests/Failure.test.ts"], output: text => { output += text; }, error: text => { output += text; } });
  expect(status).not.toBe(0); expect(output).not.toContain("test executed");
  expect(await readFile(join(root, "test.sqlite"), "utf8")).toBe("sentinel");
  expect((await sources(root)).slice(0, before.length)).toEqual(before);
  expect(await readdir(join(root, ".bundle-test-databases"))).toEqual([]);
}, 20000);
