import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadApplicationCommands } from "../console/loader.ts";
import { loadConfiguration } from "../configuration/configuration.ts";
import type { HttpContext } from "../http/router.ts";
import { runQueuedJob } from "../queue/execution.ts";
import { QueueStore } from "../queue/store.ts";
import { runJobMiddleware } from "../queue/middleware.ts";
import { registerScaffolding } from "./generators.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const dir = resolve(import.meta.dir, "../../.data");
  await mkdir(dir, { recursive: true });
  const root = await mkdtemp(join(dir, "generators-test-"));
  roots.push(root);
  return root;
}
function host(root: string, output: string[] = []) {
  const program = new Command().exitOverride();
  registerScaffolding(program, { root, output: text => output.push(text) });
  return program;
}
async function run(root: string, ...args: string[]) {
  await host(root).parseAsync(args, { from: "user" });
}

test("resource controller uses the paired model without executing its source", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  const source = 'export class Post {} export default {}; throw new Error("must not import");';
  await writeFile(join(root, "src/models/Post.ts"), source);
  await run(root, "make:controller", "Admin/PostController", "--resource", "--model", "Post");
  const content = await readFile(join(root, "src/http/controllers/Admin/PostController.ts"), "utf8");
  expect(content).toContain('from "../../model-resource.ts"');
  expect(content).toContain('from "../../router.ts"');
  expect(content).toContain('Post as _Model } from "../../../models/Post.ts"');
  for (const method of ["index", "show", "store", "update", "destroy"]) expect(content).toContain(`modelResourceFor(context, _Model).${method}(context)`);
  expect(content).not.toContain("handle(");
  expect(await readFile(join(root, "src/models/Post.ts"), "utf8")).toBe(source);
});

test("resource controller validates paired flags before writing", async () => {
  const root = await fixture();
  for (const args of [["--resource"], ["--model", "Post"], ["--resource", "--model", "Missing"]]) {
    await expect(run(root, "make:controller", "Deep/Example", ...args)).rejects.toThrow();
  }
  expect(await Bun.file(join(root, "src/http/controllers/Deep/Example.ts")).exists()).toBe(false);
});

test("resource controller consumes its custom stub and preserves existing output", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  await writeFile(join(root, "src/models/Post.ts"), 'export class Post {} export default {};');
  await run(root, "stub:publish");
  const stub = join(root, "stubs/controller-resource.ts.stub");
  await writeFile(stub, 'import { modelResourceFor as _adapter } from "{{runtimeImport}}"; import type { HttpContext as _Context } from "{{contextImport}}"; import { {{modelName}} as _Model } from "{{modelImport}}"; export class {{name}} { custom = _adapter; model = _Model; context?: _Context; }');
  const args = ["make:controller", "Admin/Custom", "--resource", "--model", "Post"];
  await run(root, ...args);
  const target = join(root, "src/http/controllers/Admin/Custom.ts");
  const content = await readFile(target, "utf8");
  expect(content).toContain("custom = _adapter");
  await expect(run(root, ...args)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe(content);
  await writeFile(stub, 'export class {{name}} {}');
  await expect(run(root, "make:controller", "Invalid", "--resource", "--model", "Post")).rejects.toThrow("Invalid tokens");
});

test("resource controller refuses unsafe models and parent directories", async () => {
  const root = await fixture();
  const outside = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  await writeFile(join(root, "src/models/Post.ts"), 'export const Post = 1; export default {};');
  await expect(run(root, "make:controller", "Invalid", "--resource", "--model", "Post")).rejects.toThrow();
  await rm(join(root, "src/models/Post.ts"));
  await symlink(join(outside, "Post.ts"), join(root, "src/models/Post.ts"));
  await writeFile(join(outside, "Post.ts"), 'export class Post {} export default {};');
  await expect(run(root, "make:controller", "Invalid", "--resource", "--model", "Post")).rejects.toThrow();
  await rm(join(root, "src/models/Post.ts"));
  await writeFile(join(root, "src/models/Post.ts"), 'export class Post {} export default {};');
  await mkdir(join(root, "src/http/controllers"), { recursive: true });
  await symlink(outside, join(root, "src/http/controllers/Linked"));
  await expect(run(root, "make:controller", "Linked/Escape", "--resource", "--model", "Post")).rejects.toThrow();
  await expect(run(root, "make:middleware", "Invalid", "--resource", "--model", "Post")).rejects.toThrow();
  expect(await Bun.file(join(outside, "Escape.ts")).exists()).toBe(false);
});

test.each(["factory", "cast", "scope", "observer"] as const)("make:%s produces a native ORM scaffold", async kind => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  await writeFile(join(root, "src/models/User.ts"), 'export class User {}\nexport default {};\n');
  await run(root, `make:${kind}`, "Billing/Example", ...(kind === "factory" ? ["--model", "User"] : []));
  const base = kind === "factory" ? "database/factories" : `src/database/${kind === "cast" ? "types" : kind === "scope" ? "scopes" : "observers"}`;
  expect(await readFile(join(root, base, "Billing/Example.ts"), "utf8")).toContain("Example");
});

test.each(["factory", "cast", "scope", "observer"] as const)("%s ORM scaffold handles custom stubs and refuses unsafe outputs", async kind => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  await writeFile(join(root, "src/models/User.ts"), 'export class User {}\nexport default {};\nthrow new Error("must not import");');
  await run(root, "stub:publish");
  const stub = join(root, `stubs/${kind}.ts.stub`);
  await writeFile(stub, kind === "factory" ? 'import { {{modelName}} as _Model } from "{{modelImport}}"; export class {{name}} { model = _Model; }' : 'export class {{name}} { custom = true; }');
  const args = kind === "factory" ? ["--model", "User"] : [];
  await run(root, `make:${kind}`, "Deep/Custom", ...args);
  const base = kind === "factory" ? "database/factories" : `src/database/${kind === "cast" ? "types" : kind === "scope" ? "scopes" : "observers"}`;
  const target = join(root, base, "Deep/Custom.ts");
  const content = await readFile(target, "utf8");
  expect(content).toContain(kind === "factory" ? '../../../src/models/User.ts' : 'custom = true');
  await expect(run(root, `make:${kind}`, "Deep/Custom", ...args)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe(content);
  for (const name of ["../Escape", "Deep//Escape", "Date"]) await expect(run(root, `make:${kind}`, name, ...args)).rejects.toThrow();
  const outside = await fixture();
  await symlink(outside, join(root, base, "Linked"));
  await expect(run(root, `make:${kind}`, "Linked/Escape", ...args)).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
  await writeFile(stub, 'export class {{name}} { field = {{unknown}}; }');
  await expect(run(root, `make:${kind}`, "Invalid", ...args)).rejects.toThrow();
});

test("factory preflight recognizes locally declared class exports without executing source", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  const path = join(root, "src/models/User.ts");
  for (const [index, source] of [
    'class User {} export { User }; export default {}; throw new Error("not executed");',
    'class Actual {} export { Actual as User }; export default {};',
  ].entries()) {
    await writeFile(path, source);
    await run(root, "make:factory", `Valid${index}`, "--model", "User");
  }
});

test.each(["++", "--"])("factory preflight accepts division after postfix %s", async operator => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  await writeFile(join(root, "src/models/User.ts"), `let counter = 2; counter${operator} / 2; export class User {} export default {};`);
  await run(root, "make:factory", "Postfix", "--model", "User");
  expect(await Bun.file(join(root, "database/factories/Postfix.ts")).exists()).toBe(true);
});

test("factory preflight refuses non-class exports and lexical decoys", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  const path = join(root, "src/models/User.ts");
  for (const [index, source] of [
    'const decoy = `export class User`; export const User=1; export default {};',
    'const decoy = /export class User/; export const User=1; export default {};',
    'if (true) /export class User/.test(""); export const User=1; export default {};',
    'if (true) {} /export class User {}/.test(""); export const User=1; export default {};',
    'class Other {} /export class User {}/.test(""); export const User=1; export default {};',
    '/* export class User {} */ export const User=1; export default {};',
    'function outer(){ class User {} } export const User=1; export default {};',
    'class Hidden {} export const User=1; export default {};',
    'const User = class User {}; export { User }; export default {};',
    'const str = `nested ${`export class User`}`; export const User=1; export default {};',
  ].entries()) {
    await writeFile(path, source);
    await expect(run(root, "make:factory", `Invalid${index}`, "--model", "User")).rejects.toThrow();
    expect(await Bun.file(join(root, `database/factories/Invalid${index}.ts`)).exists()).toBe(false);
  }
});

test("factory model preflight rejects missing, invalid and symlinked sources before writes", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  await expect(run(root, "make:factory", "Missing", "--model", "User")).rejects.toThrow();
  await writeFile(join(root, "src/models/User.ts"), 'export const User = 1; export default {};');
  await expect(run(root, "make:factory", "Invalid", "--model", "User")).rejects.toThrow();
  await rm(join(root, "src/models/User.ts"));
  await symlink(resolve(import.meta.dir, "../models/User.ts"), join(root, "src/models/User.ts"));
  await expect(run(root, "make:factory", "Linked", "--model", "User")).rejects.toThrow();
  await expect(run(root, "make:factory", "Bad", "--model", "Nested/User")).rejects.toThrow();
  expect(await Bun.file(join(root, "database/factories/Missing.ts")).exists()).toBe(false);
  expect(await Bun.file(join(root, "database/factories/Invalid.ts")).exists()).toBe(false);
});

test("generated ORM scaffolds compile and operate with disposable SQLite", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/models"), { recursive: true });
  await cp(resolve(import.meta.dir, "../models/User.ts"), join(root, "src/models/User.ts"));
  await cp(resolve(import.meta.dir, "../models/Post.ts"), join(root, "src/models/Post.ts"));
  for (const [kind, name, extra] of [
    ["factory", "Factory", ["--model", "User"]], ["cast", "Type", []],
    ["scope", "EntityManager", []], ["observer", "EventSubscriber", []],
  ] as const) await run(root, `make:${kind}`, `Deep/${name}`, ...extra);
  expect(await readFile(join(root, "database/factories/Deep/Factory.ts"), "utf8")).toContain("readonly model = _Model");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: resolve(import.meta.dir, "../../tsconfig.json"), include: ["src/**/*.ts", "database/**/*.ts"] }));
  const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
  const { MikroORM, EntitySchema } = await import("@mikro-orm/core");
  const { SqliteDriver } = await import("@mikro-orm/sqlite");
  const { default: UserSchema, User } = await import(join(root, "src/models/User.ts"));
  const { default: PostSchema } = await import(join(root, "src/models/Post.ts"));
  const { Factory } = await import(join(root, "database/factories/Deep/Factory.ts"));
  const { Type } = await import(join(root, "src/database/types/Deep/Type.ts"));
  const { EntityManager } = await import(join(root, "src/database/scopes/Deep/EntityManager.ts"));
  const { EventSubscriber } = await import(join(root, "src/database/observers/Deep/EventSubscriber.ts"));
  class ValueRecord { id!: number; value!: string; }
  const schema = new EntitySchema<ValueRecord>({ class: ValueRecord, properties: { id: { type: "number", primary: true }, value: { type: new Type() } } });
  const orm = await MikroORM.init({ driver: SqliteDriver, dbName: join(root, "fixture.sqlite"), entities: [UserSchema, PostSchema, schema], logger: () => {} });
  try {
    await orm.schema.create();
    const em = orm.em.fork();
    const user = await new Factory(em).createOne({ name: "Example", email: "example@example.invalid" });
    const observer = new EventSubscriber();
    em.getEventManager().registerSubscriber(observer);
    const record = em.create(ValueRecord, { value: "  trimmed  " });
    await em.flush();
    expect(user.id).toBeGreaterThan(0);
    expect((await orm.em.fork().findOneOrFail(ValueRecord, { id: record.id })).value).toBe("trimmed");
    expect(await EntityManager(orm.em.fork(), User, { email: "example@example.invalid" })).toHaveLength(1);
    expect(observer.createdCount).toBe(1);
    expect(() => new Type().convertToDatabaseValue(4)).toThrow();
  } finally { await orm.close(true); }
}, 30000);

test.each(["mail", "notification"] as const)("make:%s generates a nested executable example", async kind => {
  const root = await fixture();
  await run(root, `make:${kind}`, "Billing/Deep/Example");
  const directory = kind === "mail" ? "mail" : "notifications";
  const { Example } = await import(join(root, `src/${directory}/Billing/Deep/Example.ts`));
  const example = new Example();
  const message = kind === "mail" ? await example.build() : await example.toMail("chosen@example.invalid");
  expect(message.to).toEqual([kind === "mail" ? "recipient@example.invalid" : "chosen@example.invalid"]);
  expect(typeof message.subject).toBe("string");
  expect(typeof message.text).toBe("string");
});

test("delivery scaffolds compile with colliding names and deliver only when explicitly invoked", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/mail"), { recursive: true });
  await mkdir(join(root, "src/notifications"), { recursive: true });
  await cp(resolve(import.meta.dir, "../mail/mail.ts"), join(root, "src/mail/mail.ts"));
  await cp(resolve(import.meta.dir, "../notifications/notification.ts"), join(root, "src/notifications/notification.ts"));
  await run(root, "stub:publish");
  for (const name of ["Mailable", "MailMessage", "Notification"]) {
    await run(root, "make:mail", `Nested/Deep/${name}`);
    await run(root, "make:notification", `Nested/Deep/${name}`);
  }
  for (const name of ["Mailable", "MailMessage", "Notification"]) {
    const MailClass = (await import(join(root, `src/mail/Nested/Deep/${name}.ts`)))[name];
    const NoticeClass = (await import(join(root, `src/notifications/Nested/Deep/${name}.ts`)))[name];
    expect(new MailClass().build().to).toEqual(["recipient@example.invalid"]);
    expect(new NoticeClass().toMail("chosen@example.invalid").to).toEqual(["chosen@example.invalid"]);
  }
  const { sendMailable } = await import("../mail/mail.ts");
  const { notifyMail } = await import("../notifications/notification.ts");
  const { LocalOutboxMailTransport } = await import("../mail/outbox.ts");
  const transport = new LocalOutboxMailTransport(root);
  const Mail = (await import(join(root, "src/mail/Nested/Deep/Mailable.ts"))).Mailable;
  const Notice = (await import(join(root, "src/notifications/Nested/Deep/Notification.ts"))).Notification;
  const mail = new Mail();
  const notice = new Notice();
  expect(await transport.list()).toEqual([]);
  const first = await sendMailable(transport, mail);
  const second = await notifyMail(transport, notice, "chosen@example.invalid");
  expect((await transport.read(first.id)).message.to).toEqual(["recipient@example.invalid"]);
  expect((await transport.read(second.id)).message.to).toEqual(["chosen@example.invalid"]);
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: resolve(import.meta.dir, "../../tsconfig.json"), include: ["src/**/*.ts"] }));
  const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
}, 30000);

test.each(["mail", "notification"] as const)("%s generator consumes custom stubs and refuses unsafe output", async kind => {
  const root = await fixture();
  await run(root, "stub:publish");
  const stub = join(root, `stubs/${kind}.ts.stub`);
  const body = kind === "mail"
    ? 'import type { Mailable as _Contract } from "{{runtimeImport}}"; export class {{name}} implements _Contract { build() { return {to:["custom@example.invalid"],subject:"Custom",text:"body"}; } }'
    : 'import type { Notification as _Contract } from "{{runtimeImport}}"; export class {{name}} implements _Contract { toMail(recipient: string) { return {to:[recipient],subject:"Custom",text:"body"}; } }';
  await writeFile(stub, body);
  await run(root, `make:${kind}`, "Nested/Custom");
  const base = kind === "mail" ? "src/mail" : "src/notifications";
  const path = join(root, base, "Nested/Custom.ts");
  const { Custom } = await import(path);
  const message = kind === "mail" ? new Custom().build() : new Custom().toMail("chosen@example.invalid");
  expect(message.subject).toBe("Custom");
  expect(message.to).toEqual([kind === "mail" ? "custom@example.invalid" : "chosen@example.invalid"]);
  await mkdir(join(root, "src/mail"), { recursive: true });
  await mkdir(join(root, "src/notifications"), { recursive: true });
  await cp(resolve(import.meta.dir, "../mail/mail.ts"), join(root, "src/mail/mail.ts"));
  await cp(resolve(import.meta.dir, "../notifications/notification.ts"), join(root, "src/notifications/notification.ts"));
  const { LocalOutboxMailTransport } = await import("../mail/outbox.ts");
  const transport = new LocalOutboxMailTransport(root);
  const receipt = kind === "mail"
    ? await (await import("../mail/mail.ts")).sendMailable(transport, new Custom())
    : await (await import("../notifications/notification.ts")).notifyMail(transport, new Custom(), "chosen@example.invalid");
  expect((await transport.read(receipt.id)).message.subject).toBe("Custom");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: resolve(import.meta.dir, "../../tsconfig.json"), include: ["src/**/*.ts"] }));
  const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
  const original = await readFile(path, "utf8");
  await expect(run(root, `make:${kind}`, "Nested/Custom")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
  for (const name of ["../Escape", "Nested//Escape", "Date"]) await expect(run(root, `make:${kind}`, name)).rejects.toThrow();
  const outside = await fixture();
  await symlink(outside, join(root, base, "Linked"));
  await expect(run(root, `make:${kind}`, "Linked/Escape")).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
  for (const invalid of ['export class {{name}} {}', 'import "{{runtimeImport}}"; export class {{name}} { x = {{other}}; }']) {
    await writeFile(stub, invalid);
    await expect(run(root, `make:${kind}`, "Invalid")).rejects.toThrow();
  }
  await rm(stub);
  await symlink(join(outside, "missing"), stub);
  await expect(run(root, `make:${kind}`, "Invalid")).rejects.toThrow("symlink");
});

test("job middleware generator publishes consumed nested customizable pass-through", async () => {
  const root = await fixture();
  await run(root, "stub:publish");
  await run(root, "make:job-middleware", "Billing/Deep/First");
  const job: string[] = [];
  const context = {job, signal: new AbortController().signal};
  await runJobMiddleware({root, references:[{module:"src/queue/middleware/Billing/Deep/First.ts",export:"First"}],context,run:async()=>{job.push("run");}});
  expect(job).toEqual(["run"]);
  await writeFile(join(root,"stubs/job-middleware.ts.stub"), `import type { JobMiddleware as _JobMiddleware } from "{{runtimeImport}}";\nexport const {{name}}: _JobMiddleware = async (ctx, next) => { (ctx.job as string[]).push("custom"); await next(); };\n`);
  await run(root, "make:job-middleware", "Billing/Custom");
  await runJobMiddleware({root, references:[{module:"src/queue/middleware/Billing/Custom.ts",export:"Custom"}],context,run:async()=>{job.push("second");}});
  expect(job).toEqual(["run","custom","second"]);
  await expect(run(root, "make:job-middleware", "Billing/Custom")).rejects.toThrow();
  for (const name of ["../Bad", "Billing/Date", "A".repeat(129), Array(5).fill("A".repeat(100)).join("/")]) await expect(run(root,"make:job-middleware",name)).rejects.toThrow();
  const outside = await fixture();
  await symlink(outside, join(root,"src/queue/middleware/Linked"));
  await expect(run(root,"make:job-middleware","Linked/Escape")).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
  for (const stub of ['export const {{name}} = 1;', 'import "{{runtimeImport}}"; export const {{name}} = {{other}};']) {
    await writeFile(join(root,"stubs/job-middleware.ts.stub"),stub);
    await expect(run(root,"make:job-middleware","Invalid")).rejects.toThrow();
  }
});

test("job middleware generator honors exact descriptor bounds before writing", async () => {
  const root = await fixture();
  const prefix = "src/queue/middleware/";
  const pathName = ["A".repeat(100), "B".repeat(100), "C".repeat(100), "D".repeat(100), "E".repeat(512 - prefix.length - 3 - 404)].join("/");
  expect(`${prefix}${pathName}.ts`).toHaveLength(512);
  for (const name of ["F".repeat(128), pathName]) {
    await run(root, "make:job-middleware", name);
    expect(await Bun.file(join(root,prefix,`${name}.ts`)).exists()).toBe(true);
  }
  for (const name of ["G".repeat(129), `${pathName}E`]) {
    await expect(run(root,"make:job-middleware",name)).rejects.toThrow();
    expect(await Bun.file(join(root,prefix,`${name}.ts`)).exists()).toBe(false);
  }
  await writeFile(join(root, "src/queue/middleware.ts"), `export type { JobMiddleware } from ${JSON.stringify(resolve(import.meta.dir,"../queue/middleware.ts"))};`);
  await writeFile(join(root,"tsconfig.json"),JSON.stringify({extends:resolve(import.meta.dir,"../../tsconfig.json"),include:["src/queue/middleware/**/*.ts"]}));
  const compiler = Bun.spawn([process.execPath,"check","--project",join(root,"tsconfig.json")],{stdout:"pipe",stderr:"pipe",env:{...process.env,BUN_OPTIONS:""}});
  const [stdout,stderr,status] = await Promise.all([new Response(compiler.stdout).text(),new Response(compiler.stderr).text(),compiler.exited]);
  expect(status,stdout+stderr).toBe(0);
}, 30000);

test("job scaffolds execute default and customized own handlers through the queue executor", async () => {
  const root = await fixture();
  await run(root, "stub:publish");
  expect(await readdir(join(root, "stubs"))).toHaveLength(27);
  await run(root, "make:job", "Billing/Deep/ExampleJob");
  const job = { module: "src/jobs/Billing/Deep/ExampleJob.ts", export: "ExampleJob", method: "handle", payload: null };
  const { ExampleJob } = await import(join(root, job.module));
  expect(Object.hasOwn(ExampleJob.prototype, "handle")).toBe(true);
  expect(await runQueuedJob({ root, job })).toEqual({ status: "completed" });
  await writeFile(join(root, "stubs/job.ts.stub"), `import { writeFile } from "node:fs/promises";
export class {{name}} {
  async handle(payload: unknown, signal: AbortSignal): Promise<void> {
    if (signal.aborted || typeof payload !== "string") throw new Error("bad payload or signal");
    await writeFile(payload, "handled");
  }
}\n`);
  await run(root, "make:job", "Billing/Deep/CustomJob");
  const output = join(root, "result.txt");
  expect(await runQueuedJob({ root, job: { module: "src/jobs/Billing/Deep/CustomJob.ts", export: "CustomJob", method: "handle", payload: output } })).toEqual({ status: "completed" });
  expect(await readFile(output, "utf8")).toBe("handled");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: resolve(import.meta.dir, "../../tsconfig.json"), include: ["src/jobs/**/*.ts"] }));
  const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
}, 30000);

test.each([
  ["export", "A".repeat(129)],
  ["module", Array.from({length:5},()=>"A".repeat(100)).join("/")],
] as const)("job generator refuses an overlong queue %s before creating files",async(_label,name)=>{
  const root=await fixture();
  await expect(run(root,"make:job",name)).rejects.toThrow();
  expect(await Bun.file(join(root,"src/jobs",`${name}.ts`)).exists()).toBe(false);
});

test("job descriptor length boundaries are generated and executed",async()=>{
  const root=await fixture();
  const names=["A".repeat(128),["A".repeat(100),"B".repeat(100),"C".repeat(100),"D".repeat(100),"E".repeat(96)].join("/")];
  const store=new QueueStore(join(root,"boundaries.sqlite"));
  try{
    for(const name of names){
      await run(root,"make:job",name);
      const job={module:`src/jobs/${name}.ts`,export:name.split("/").at(-1)!,method:"handle",payload:null};
      const id=store.enqueue("default",job);
      const claim=store.reserve(["default"]);
      expect(claim?.id).toBe(id);
      expect(await runQueuedJob({root,job:claim!.job})).toEqual({status:"completed"});
      expect(store.ack(claim!.receipt)).toBe(true);
    }
  }finally{store.close();}
});

test("job scaffolds reject unsafe paths, reserved names, overwrites and invalid stubs", async () => {
  const root = await fixture();
  await run(root, "stub:publish");
  await run(root, "make:job", "Billing/InvoiceJob");
  const path = join(root, "src/jobs/Billing/InvoiceJob.ts");
  const original = await readFile(path, "utf8");
  await expect(run(root, "make:job", "Billing/InvoiceJob")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
  for (const name of ["../Escape", "Billing//Escape", "Billing/AbortSignal", "Billing/Date"]) await expect(run(root, "make:job", name)).rejects.toThrow();
  const stub = join(root, "stubs/job.ts.stub");
  for (const invalid of ["export class Missing {}", "export class {{name}} { {{other}} }", "export class {{name}} {"]) {
    await writeFile(stub, invalid);
    await expect(run(root, "make:job", "OtherJob")).rejects.toThrow();
  }
  await rm(stub);
  const outside = await fixture();
  await symlink(outside, join(root, "src/jobs/Linked"));
  await expect(run(root, "make:job", "Linked/Escape")).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
});

test("published event and listener scaffolds deliver nested payloads through the real bus", async () => {
  const root = await fixture();
  await mkdir(join(root, "src"), { recursive: true });
  await cp(resolve(import.meta.dir, "../events"), join(root, "src/events"), { recursive: true });
  await run(root, "stub:publish");
  await writeFile(join(root, "stubs/listener.ts.stub"), `export class {{name}} {
  static received: unknown[] = [];
  handle(payload: unknown, signal: AbortSignal) { if (!signal.aborted) {{name}}.received.push(payload); }
}\n`);
  await run(root, "make:event", "Billing/Deep/HTTPInvoiceCreated");
  await run(root, "make:listener", "Billing/Deep/RecordInvoice");
  const { HTTPInvoiceCreated } = await import(join(root, "src/events/Billing/Deep/HTTPInvoiceCreated.ts"));
  const { RecordInvoice } = await import(join(root, "src/listeners/Billing/Deep/RecordInvoice.ts"));
  const { EventBus, validEventName } = await import(join(root, "src/events/bus.ts"));
  const bus = new EventBus();
  expect(HTTPInvoiceCreated.eventName).toBe("billing.deep.http-invoice-created");
  expect(validEventName(HTTPInvoiceCreated.eventName)).toBe(true);
  expect(bus.describe()).toEqual([]);
  const listener = new RecordInvoice();
  bus.on(HTTPInvoiceCreated.eventName, listener.handle.bind(listener));
  const payload = { invoice: 42 };
  await HTTPInvoiceCreated.dispatch(bus, payload, new AbortController().signal);
  expect(RecordInvoice.received).toEqual([payload]);
  const cancelled = new AbortController();
  cancelled.abort();
  await HTTPInvoiceCreated.dispatch(bus, { ignored: true }, cancelled.signal);
  expect(RecordInvoice.received).toEqual([payload]);
  expect(bus.describe()[0].listeners).toBe(1);
  await rm(join(root, "stubs/listener.ts.stub"));
  await run(root, "make:listener", "Billing/Deep/ExampleListener");
  const { ExampleListener } = await import(join(root, "src/listeners/Billing/Deep/ExampleListener.ts"));
  expect(Object.hasOwn(ExampleListener.prototype, "handle")).toBe(true);
  expect(new ExampleListener().handle(payload, new AbortController().signal)).toBeUndefined();
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: resolve(import.meta.dir, "../../tsconfig.json"), include: ["src/events/Billing/**/*.ts", "src/listeners/**/*.ts"] }));
  const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
}, 30000);

test("namespaced events with the same basename deliver only to their own subscribers", async () => {
  const root = await fixture();
  await mkdir(join(root, "src"), { recursive: true });
  await cp(resolve(import.meta.dir, "../events"), join(root, "src/events"), { recursive: true });
  await run(root, "make:event", "Billing/Created");
  await run(root, "make:event", "Shipping/Created");
  const billing = (await import(join(root, "src/events/Billing/Created.ts"))).Created;
  const shipping = (await import(join(root, "src/events/Shipping/Created.ts"))).Created;
  const { EventBus, validEventName } = await import(join(root, "src/events/bus.ts"));
  expect(billing.eventName).toBe("billing.created");
  expect(shipping.eventName).toBe("shipping.created");
  expect(validEventName(billing.eventName)).toBe(true);
  expect(validEventName(shipping.eventName)).toBe(true);
  const bus = new EventBus();
  const received: string[] = [];
  bus.on(billing.eventName, () => { received.push("billing"); });
  bus.on(shipping.eventName, () => { received.push("shipping"); });
  await billing.dispatch(bus, null);
  expect(received).toEqual(["billing"]);
  await shipping.dispatch(bus, null);
  expect(received).toEqual(["billing", "shipping"]);
});

test("event and listener generators refuse the runtime AbortSignal type name", async () => {
  const root = await fixture();
  for (const kind of ["event", "listener"]) {
    await expect(run(root, `make:${kind}`, "Billing/AbortSignal")).rejects.toThrow("Reserved");
  }
});

test("event name length limit includes namespaces and inserted kebab separators", async () => {
  const root = await fixture();
  const namespace = "A".repeat(127);
  const identifier = "B".repeat(128);
  await run(root, "make:event", `${namespace}/${identifier}`);
  const source = await readFile(join(root, "src/events", namespace, `${identifier}.ts`), "utf8");
  expect(source).toContain(`eventName = "${namespace.toLowerCase()}.${identifier.toLowerCase()}"`);
  await expect(run(root, "make:event", `${namespace}/${"Ba".repeat(64)}C`)).rejects.toThrow("256");
});

test("event scaffolds reject unsafe names, existing targets and invalid stubs", async () => {
  const root = await fixture();
  await run(root, "stub:publish");
  await run(root, "make:event", "Billing/InvoiceCreated");
  await expect(run(root, "make:event", "Billing/InvoiceCreated")).rejects.toThrow();
  for (const name of ["../Escape", "Billing//Escape", "A".repeat(257), `${"A".repeat(128)}/${"B".repeat(128)}`]) await expect(run(root, "make:event", name)).rejects.toThrow();
  const stub = join(root, "stubs/event.ts.stub");
  for (const source of ["export class {{name}} {}", 'import "{{runtimeImport}}"; export class {{name}} { x = "{{eventName}}"; y = {{other}}; }']) {
    await writeFile(stub, source);
    await expect(run(root, "make:event", "OtherEvent")).rejects.toThrow();
  }
  const outside = await fixture();
  await mkdir(join(root, "src/listeners"), { recursive: true });
  await symlink(outside, join(root, "src/listeners/Linked"));
  await expect(run(root, "make:listener", "Linked/Escape")).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
});

test("HTTP scaffolds execute against the real runtime with nested imports", async () => {
  const root = await fixture();
  await mkdir(join(root, "src"), { recursive: true });
  await cp(resolve(import.meta.dir, "../http"), join(root, "src/http"), { recursive: true });
  for (const [kind, name] of [["controller", "InvoiceController"], ["middleware", "TraceMiddleware"], ["request", "InvoiceRequest"], ["resource", "InvoiceResource"], ["rule", "InvoiceRule"]]) {
    await run(root, `make:${kind}`, `Billing/Deep/${name}`);
  }
  const middlewarePath = join(root, "src/http/middleware/Billing/Deep/TraceMiddleware.ts");
  const middlewareSource = await readFile(middlewarePath, "utf8");
  await writeFile(middlewarePath, middlewareSource.replace("return next();", 'context.state.set("trace", "seen");\n  return next();'));
  const controllerPath = join(root, "src/http/controllers/Billing/Deep/InvoiceController.ts");
  await writeFile(controllerPath, (await readFile(controllerPath, "utf8")).replace('new Response("OK")', 'new Response(String(context.state.get("trace")))'));
  const { InvoiceController } = await import(controllerPath);
  const { TraceMiddleware } = await import(middlewarePath);
  const { InvoiceRequest } = await import(join(root, "src/http/requests/Billing/Deep/InvoiceRequest.ts"));
  const { InvoiceResource } = await import(join(root, "src/http/resources/Billing/Deep/InvoiceResource.ts"));
  const { InvoiceRule } = await import(join(root, "src/http/rules/Billing/Deep/InvoiceRule.ts"));
  const { createRouter } = await import(join(root, "src/http/router.ts"));
  const { validate } = await import(join(root, "src/http/validation.ts"));
  const router = createRouter().add("GET", "/", (context: HttpContext) => new InvoiceController().handle(context), { middleware: [TraceMiddleware] });
  expect(await (await router.fetch(new Request("http://localhost/"))).text()).toBe("seen");
  const request = (body: string) => new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body });
  expect((await InvoiceRequest(request('{"name":"Ada"}'))).ok).toBe(true);
  expect((await InvoiceRequest(request('{"name":""}'))).ok).toBe(false);
  expect((await InvoiceRequest(request(' '.repeat(20000)))).ok).toBe(false);
  expect(await InvoiceResource({ name: "Ada", secret: "hidden" }).json()).toEqual({ data: { name: "Ada" } });
  expect((await validate(InvoiceRule, "abc")).ok).toBe(true);
  expect((await validate(InvoiceRule, "")).ok).toBe(false);
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: resolve(import.meta.dir, "../../tsconfig.json"), include: ["src/http/controllers/**/*.ts", "src/http/middleware/**/*.ts", "src/http/requests/**/*.ts", "src/http/resources/**/*.ts", "src/http/rules/**/*.ts"] }));
  const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
}, 30000);

test("HTTP scaffolds protect paths and validate published runtime import tokens", async () => {
  const root = await fixture();
  await run(root, "stub:publish");
  const stub = join(root, "stubs/rule.ts.stub");
  await writeFile(stub, 'import { rules as _rules } from "{{runtimeImport}}";\nexport const {{name}} = _rules.string({ min: 2 });\n');
  await run(root, "make:rule", "Billing/CodeRule");
  const generated = join(root, "src/http/rules/Billing/CodeRule.ts");
  expect(await readFile(generated, "utf8")).toContain('from "../../validation.ts"');
  await expect(run(root, "make:rule", "Billing/CodeRule")).rejects.toThrow();
  for (const name of ["../Escape", "Billing//Escape", "Request", "Response"]) await expect(run(root, "make:rule", name)).rejects.toThrow();
  for (const invalid of ['export const {{name}} = 1;', 'import "{{runtimeImport}}"; export const {{name}} = {{other}};', 'import "{{runtimeImport}}"; export const {{name}} = ;']) {
    await writeFile(stub, invalid);
    await expect(run(root, "make:rule", "AnotherRule")).rejects.toThrow();
  }
  await writeFile(stub, 'import { rules as _rules } from "{{runtimeImport}}"; export const {{name}} = _rules.string();');
  const outside = await fixture();
  await symlink(outside, join(root, "src/http/rules/Linked"));
  await expect(run(root, "make:rule", "Linked/Escape")).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
});

test("registers only supported generator commands", async () => {
  const program = host(await fixture());
  expect(program.commands.map(c => c.name()).sort()).toEqual(["make:cast", "make:class", "make:command", "make:config", "make:controller", "make:enum", "make:event", "make:exception", "make:factory", "make:interface", "make:job", "make:job-middleware", "make:listener", "make:mail", "make:middleware", "make:notification", "make:observer", "make:policy", "make:provider", "make:request", "make:resource", "make:rule", "make:scope", "make:test", "make:trait", "stub:publish"]);
  expect(program.commands.find(c => c.name() === "make:trait")!.description()).toContain("mixin");
});

test("generated command is loaded and executed by the application loader", async () => {
  const root = await fixture();
  await run(root, "make:command", "SendReport");
  const output: string[] = [];
  const program = new Command().exitOverride();
  await loadApplicationCommands(program, { root, output: text => output.push(text) });
  await program.parseAsync(["send-report"], { from: "user" });
  expect(output.length).toBeGreaterThan(0);
});

test("rejects host names and aliases before creating files", async () => {
  const root = await fixture();
  const program = host(root);
  program.command("list");
  program.command("status").alias("report-daily");
  program.addHelpCommand("guide [command]");
  await expect(program.parseAsync(["make:command", "List"], { from: "user" })).rejects.toThrow("list");
  await expect(program.parseAsync(["make:command", "ReportDaily"], { from: "user" })).rejects.toThrow("report-daily");
  await expect(program.parseAsync(["make:command", "Guide"], { from: "user" })).rejects.toThrow("guide");
  expect(await readdir(root)).toEqual([]);
});

test("rejects existing command identities regardless of filenames without executing handlers", async () => {
  const root = await fixture();
  const directory = join(root, "src/commands");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "Unrelated.ts"), `export default { name: "reportdaily", description: "existing", handle() { throw new Error("executed"); } };`);
  await expect(run(root, "make:command", "Reportdaily")).rejects.toThrow("reportdaily");
  expect(await readdir(directory)).toEqual(["Unrelated.ts"]);
  await run(root, "make:command", "ReportDaily");
  await expect(run(root, "make:command", "ReportDAILY")).rejects.toThrow("report-daily");
  expect((await readdir(directory)).sort()).toEqual(["ReportDaily.ts", "Unrelated.ts"]);
});

test("loader still rejects real collisions with built-ins", async () => {
  const root = await fixture();
  await run(root, "make:command", "List");
  const program = new Command();
  program.command("list");
  await expect(loadApplicationCommands(program, { root })).rejects.toThrow("list");
});

test("command preflight rejects symlinked command directories before importing", async () => {
  const root = await fixture();
  const outside = await fixture();
  await mkdir(join(root, "src"));
  await symlink(outside, join(root, "src/commands"));
  await expect(run(root, "make:command", "Report")).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
});

test("generates executable exception and Bun test files", async () => {
  const root = await fixture();
  await run(root, "make:exception", "Billing/InvoiceFailure");
  await run(root, "make:test", "InvoiceTest");
  const exception = await import(join(root, "src/exceptions/Billing/InvoiceFailure.ts"));
  expect(new exception.InvoiceFailure("bad")).toBeInstanceOf(Error);
  expect(await readFile(join(root, "tests/InvoiceTest.test.ts"), "utf8")).toContain('from "bun:test"');
});

test("rejects invalid names, existing files and symlinked directories", async () => {
  const root = await fixture();
  await expect(run(root, "make:command", "../Escape")).rejects.toThrow();
  await expect(run(root, "make:command", "Help")).rejects.toThrow();
  await run(root, "make:command", "SendReport");
  const file = join(root, "src/commands/SendReport.ts");
  const original = await readFile(file, "utf8");
  await expect(run(root, "make:command", "SendReport")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(original);
  const other = await fixture();
  await symlink(other, join(root, "tests"));
  await expect(run(root, "make:test", "EscapeTest")).rejects.toThrow();
});


test("all published stubs leave ordinary project typechecking valid", async () => {
  const projectRoot = resolve(import.meta.dir, "../..");
  const root = await mkdtemp(join(projectRoot, "stub-check-"));
  roots.push(root);
  await run(root, "stub:publish");
  expect(await readdir(join(root, "stubs"))).toHaveLength(27);
  const compiler = Bun.spawn([process.execPath, "check"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
}, 30000);

test("config scaffolds are discoverable and reject nested names even with custom stubs", async () => {
  const root = await fixture();
  await expect(run(root, "make:config", "Billing/Invoice")).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
  await run(root, "make:config", "Billing");
  expect(await loadConfiguration(root, { useCache: false })).toEqual({ Billing: {} });
  await mkdir(join(root, "stubs"));
  await writeFile(join(root, "stubs/config.ts.stub"), 'export default { label: "{{name}}" };\n');
  await expect(run(root, "make:config", "Other/Invoice")).rejects.toThrow();
  await run(root, "make:config", "Payments");
  expect(await loadConfiguration(root, { useCache: false })).toEqual({ Billing: {}, Payments: { label: "Payments" } });
});

test("publishes and consumes validated templates without overwriting", async () => {
  const root = await fixture();
  await run(root, "stub:publish");
  const stub = join(root, "stubs/class.ts.stub");
  await writeFile(stub, "export class {{name}} { readonly customized = true; }\n");
  await run(root, "make:class", "Invoice");
  expect((await import(join(root, "src/classes/Invoice.ts"))).Invoice).toBeDefined();
  expect(await readFile(join(root, "src/classes/Invoice.ts"), "utf8")).toContain("customized");
  await expect(run(root, "stub:publish")).rejects.toThrow();
  expect(await readFile(stub, "utf8")).toContain("customized");
});

test("rejects invalid stub tokens, syntax and symlinks", async () => {
  const root = await fixture();
  const outside = await fixture();
  await mkdir(join(root, "stubs"));
  const stub = join(root, "stubs/class.ts.stub");
  for (const content of ["export class Missing {}", "export class {{name}} { {{other}} }", "export class {{name}} {", "export const {{name}} = <div />;"]) {
    await writeFile(stub, content);
    await expect(run(root, "make:class", "Invoice")).rejects.toThrow();
  }
  await rm(stub);
  await symlink(join(outside, "outside"), stub);
  await expect(run(root, "make:class", "Invoice")).rejects.toThrow();
});

test("generates runnable unit tests and config, and honors custom command names", async () => {
  const root = await fixture();
  await run(root, "make:config", "Billing");
  expect((await import(join(root, "config/Billing.ts"))).default).toEqual({});
  await run(root, "make:test", "BillingTest", "--unit");
  const child = Bun.spawn([process.execPath, "test", join(root, "tests/Unit/BillingTest.test.ts")], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  expect(await child.exited).toBe(0);
  await run(root, "make:command", "SendReport", "--command", "reports:send");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: join(resolve(import.meta.dir, "../.."), "tsconfig.json"), include: ["src/**/*.ts", "config/**/*.ts", "tests/**/*.ts"] }));
  const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
  const program = new Command().exitOverride();
  await loadApplicationCommands(program, { root });
  await program.parseAsync(["reports:send"], { from: "user" });
  await expect(run(root, "make:command", "OtherReport", "--command", "reports:send")).rejects.toThrow("reports:send");
  await expect(run(root, "make:command", "Another", "--command", "make:class")).rejects.toThrow("make:class");
});


test("command stub must bind selected identity rather than hiding its token in a comment", async () => {
  const root = await fixture();
  await mkdir(join(root, "stubs"));
  await writeFile(join(root, "stubs/command.ts.stub"), `// {{commandName}} {{name}}
export default { name: "list", handle() {} };
`);
  await expect(run(root, "make:command", "Report", "--command", "reports:send")).rejects.toThrow();
});

test("publication rejects symlinked destination directories without touching targets", async () => {
  const root = await fixture();
  const outside = await fixture();
  await symlink(outside, join(root, "stubs"));
  await expect(run(root, "stub:publish")).rejects.toThrow("symlink");
  expect(await readdir(outside)).toEqual([]);
});


test("policy generator publishes customizable deny-by-default executable policies", async () => {
  const root = await fixture();
  await run(root, "stub:publish");
  await run(root, "make:policy", "Nested/InvoicePolicy");
  await run(root, "make:policy", "AuthorizationPolicy");
  await run(root, "make:policy", "PolicyContext");
  const { Router } = await import("../http/router.ts");
  const { policyMiddleware } = await import("../http/authorization.ts");
  const { InvoicePolicy } = await import(join(root, "src/http/policies/Nested/InvoicePolicy.ts"));
  const makeRouter = (policy: InstanceType<typeof InvoicePolicy>) => new Router().add("GET", "/", () => new Response("ok"), { middleware: [policyMiddleware({ policy, ability: "invoice.read", principal: context => context.request.headers.get("x-principal"), resource: () => ({ owner: "alice" }) })] });
  expect((await makeRouter(new InvoicePolicy()).fetch(new Request("http://localhost/"))).status).toBe(403);
  await writeFile(join(root, "stubs/policy.ts.stub"), `import type { AuthorizationPolicy as _Policy, PolicyContext as _Context } from "{{runtimeImport}}";
export class {{name}} implements _Policy { async can(context: _Context): Promise<boolean> { return context.ability === "invoice.read" && context.principal === (context.resource as {owner: string}).owner; } }
`);
  await run(root, "make:policy", "Nested/CustomPolicy");
  const { CustomPolicy } = await import(join(root, "src/http/policies/Nested/CustomPolicy.ts"));
  const router = makeRouter(new CustomPolicy());
  expect((await router.fetch(new Request("http://localhost/", { headers: { "x-principal": "alice" } }))).status).toBe(200);
  expect((await router.fetch(new Request("http://localhost/", { headers: { "x-principal": "bob" } }))).status).toBe(403);
  await expect(run(root, "make:policy", "Nested/CustomPolicy")).rejects.toThrow();
  await expect(run(root, "make:policy", "Nested/Date")).rejects.toThrow();
  const outside = await fixture();
  await symlink(outside, join(root, "src/http/policies/Linked"));
  await expect(run(root, "make:policy", "Linked/Escape")).rejects.toThrow();
  await writeFile(join(root, "src/http/authorization.ts"), `export type { AuthorizationPolicy, PolicyContext } from ${JSON.stringify(resolve(import.meta.dir, "../http/authorization.ts"))};`);
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: resolve(import.meta.dir, "../../tsconfig.json"), include: ["src/http/policies/**/*.ts"] }));
  const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  const [stdout, stderr, status] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect(status, stdout + stderr).toBe(0);
}, 30000);
