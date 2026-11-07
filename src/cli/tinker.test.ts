import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { testCommand } from "../console/testing.ts";
import { databaseFixture } from "../database/testing.ts";
import { withDatabase } from "../database/connection.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() { const value = await databaseFixture(); cleanups.push(value.cleanup); return value; }

test("tinker executes explicit native JavaScript without opening a database", async () => {
  const { root, env } = await fixture(); let output = "";
  await createCli({ root, env, output: text => { output += text; } }).parseAsync(["tinker", "--execute", "21 * 2"], { from: "user" });
  expect(output).toContain("42");
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
});

test("tinker consumes bootstrapped scoped services and rooted require/import before owned provider cleanup", async () => {
  const { root, env } = await fixture(); const marker = join(root, "disposed.txt");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tinker-fixture", type: "module" }));
  await writeFile(join(root, "helper.ts"), "export default 42;\n");
  await mkdir(join(root, "src/providers"));
  await writeFile(join(root, "providers.ts"), `import {defineProviders} from ${JSON.stringify(new URL("../console/providers.ts", import.meta.url).href)}; export default defineProviders([{module:"src/providers/Answer.ts",export:"Answer"}]);\n`);
  await writeFile(join(root, "src/providers/Answer.ts"), `import {appendFileSync} from "node:fs"; export class Answer { register({container}) { container.register("answer", "scoped", () => ({value:42,dispose(){appendFileSync(${JSON.stringify(marker)},"scope\\n")}})); } dispose(){appendFileSync(${JSON.stringify(marker)},"provider\\n")} }\n`);
  const code = 'const answer = bundle.services.resolve("answer"); [answer.value, require("./package.json").name, (await bundle.import("./helper.ts")).default]';
  const result = await testCommand(["tinker", "--execute", code], { root, env });
  result.assertExitCode(0).assertNoError().assertOutputIncludes("42").assertOutputIncludes("tinker-fixture");
  expect(await readFile(marker, "utf8")).toBe("scope\nprovider\n");
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
});

test("tinker database access is explicitly enabled, lazy and consumed by owned SQLite work", async () => {
  const { root, env } = await fixture();
  const unused = await testCommand(["tinker", "--allow-database", "--execute", '"not-opened"'], { root, env }); unused.assertExitCode(0);
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
  const denied = await testCommand(["tinker", "--execute", "await bundle.database()"], { root, env }); denied.assertExitCode(1);
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
  const code = 'const orm = await bundle.database();\nawait orm.schema.create();\nconst em = orm.em.fork();\nconst User = orm.getMetadata().getByClassName("User").class;\nem.create(User,{name:"Tinker",email:"tinker@example.invalid"});\nawait em.flush();\nawait em.count(User)';
  const result = await testCommand(["tinker", "--allow-database", "--execute", code], { root, env }); result.assertExitCode(0).assertNoError();
  await withDatabase(async orm => { expect(await orm.em.fork().count(orm.getMetadata().getByClassName("User").class!)).toBe(1); }, { root, env });
});

test("tinker retains production force guard before explicitly enabling a database connection", async () => {
  const { root, env } = await fixture(); const production = { ...env, APP_ENV: "production", NODE_ENV: "production" };
  const code = 'const orm = await bundle.database(); "opened"';
  const denied = await testCommand(["tinker", "--allow-database", "--execute", code], { root, env: production }); denied.assertExitCode(1);
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
  const allowed = await testCommand(["--force", "tinker", "--allow-database", "--execute", code], { root, env: production }); allowed.assertExitCode(0).assertOutputIncludes("opened");
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(true);
});

test("tinker refuses implicit non-TTY input and returns failure for explicit evaluation errors", async () => {
  const { root, env } = await fixture();
  if (!process.stdin.isTTY) { const refused = await testCommand(["tinker"], { root, env }); refused.assertExitCode(1); }
  const failed = await testCommand(["tinker", "--execute", 'throw new Error("fixture evaluation failure")'], { root, env }); failed.assertExitCode(1).assertOutputIncludes("fixture evaluation failure");
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
});

const ptyScript = `import errno,json,os,select,signal,sys,time
pid,master=os.forkpty()
if pid==0:
 os.chdir(sys.argv[2])
 os.execv(sys.argv[1],[sys.argv[1],"run","index.ts","tinker"])
output=b"";sent=False;reaped=False;status=None;deadline=time.monotonic()+12
try:
 while time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.05)
  if ready:
   try:
    chunk=os.read(master,65536)
    if chunk: output+=chunk
   except OSError as error:
    if error.errno!=errno.EIO: raise
  if not sent and b"bundle> " in output:
   sent=True
   if sys.argv[3]=="exit": os.write(master,b"21*2\\n.exit\\n")
   elif sys.argv[3]=="CTRL_C": os.write(master,b"\\x03")
   else: os.kill(pid,getattr(signal,sys.argv[3]))
  ended,value=os.waitpid(pid,os.WNOHANG)
  if ended:
   reaped=True;status=os.waitstatus_to_exitcode(value);break
 if not reaped: raise RuntimeError("owned PTY child did not exit")
 print(json.dumps({"status":status,"sent":sent,"output":output.decode("utf-8","replace")}))
finally:
 if not reaped:
  try: os.kill(pid,signal.SIGKILL)
  except ProcessLookupError: pass
  os.waitpid(pid,0)
 os.close(master)
`;

test.each(["exit", "CTRL_C", "SIGINT", "SIGTERM"])("actual tinker PTY handles %s with owned cleanup", async mode => {
  const { root, env } = await fixture();
  for (const path of ["src", "index.ts", "package.json"]) await cp(new URL(`../../${path}`, import.meta.url), join(root, path), { recursive: true });
  const python = Bun.which("python3"); expect(python).not.toBeNull();
  const child = Bun.spawn([python!, "-I", "-c", ptyScript, process.execPath, root, mode], { env: { ...process.env, ...env, BUN_OPTIONS: "", APP_ENV: "test", NODE_ENV: "test", DATABASE_URL: "", BUNDLE_CONNECTIONS: "{}" }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe(""); expect(code).toBe(0);
  const result = JSON.parse(output); expect(result.sent).toBe(true); expect(result.status).toBe(mode === "exit" ? 0 : mode === "SIGTERM" ? 143 : 130);
  if (mode === "exit") expect(result.output).toContain("42");
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
}, 20000);

test("actual tinker entrypoint executes trusted code and preserves app database without explicit access", async () => {
  const { root, env } = await fixture();
  for (const path of ["src", "index.ts", "package.json"]) await cp(new URL(`../../${path}`, import.meta.url), join(root, path), { recursive: true });
  const child = Bun.spawn([process.execPath, join(root, "index.ts"), "tinker", "--execute", 'await Promise.resolve("native-entrypoint")'], { cwd: root, env: { ...process.env, ...env, BUN_OPTIONS: "", APP_ENV: "test", NODE_ENV: "test", DATABASE_URL: "", BUNDLE_CONNECTIONS: "{}" }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe(""); expect(code).toBe(0); expect(output).toContain("native-entrypoint");
  expect(await Bun.file(join(root, "test.sqlite")).exists()).toBe(false);
}, 30000);
