import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "../database/config.ts";
import { createCli } from "./program.ts";
import { generateRequest } from "./requests.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(projectRoot, ".data/request-test-"));
  roots.push(root);
  const output: string[] = [];
  const run = (...args: string[]) => createCli({ root, env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) }).parseAsync(args, { from: "user" });
  return { root, output, run };
}

test("request CLI generates a real strict schema with bounded primitives and optional fields", async () => {
  const { root, output, run } = await fixture();
  await run("make:request", "CreatePost", "--field", "title:string", "--field", "body:text", "--field", "count:integer", "--field", "published:boolean", "--field", "subtitle:string?", "--field", "notes:text?", "--field", "rank:integer?", "--field", "draft:boolean?");
  expect(JSON.parse(output[0]!)).toEqual({ created: "src/requests/CreatePost.ts" });
  const source = await readFile(join(root, "src/requests/CreatePost.ts"), "utf8");
  expect(source).toContain('import { schema, type Infer } from "bundle/src/validation/schema.ts"');
  expect(source).toContain("export type CreatePost = Infer<typeof createPost>");
  await mkdir(join(root, "node_modules"));
  await symlink(projectRoot, join(root, "node_modules/bundle"));
  const { createPost } = await import(join(root, "src/requests/CreatePost.ts"));
  const valid = { title: " hello ", body: " body ", count: 2, published: false };
  expect(createPost.safeParse(valid)).toEqual({ success: true, data: { ...valid, title: "hello", body: "body" } });
  expect(createPost.safeParse({ ...valid, subtitle: " sub ", notes: " note ", rank: 0, draft: true }).data).toEqual({ ...valid, title: "hello", body: "body", subtitle: "sub", notes: "note", rank: 0, draft: true });
  for (const patch of [{ extra: true }, { title: " " }, { title: "a".repeat(256) }, { body: " " }, { body: "a".repeat(10001) }, { count: "2" }, { count: 1.5 }, { count: Infinity }, { count: NaN }, { published: "false" }, { published: 0 }, { rank: "1" }, { subtitle: null }, { notes: null }, { rank: null }, { draft: null }]) {
    expect(createPost.safeParse({ ...valid, ...patch }).success).toBe(false);
  }
  expect(createPost.safeParse({}).success).toBe(false);
});

test("validates all request and field specs and resource bounds before any writes", async () => {
  const { root, run } = await fixture();
  for (const name of ["../Escape", "Bad.ts", "lower", "CON", "Name\n", "A".repeat(65), "Class", "Schema", "Infer", "Import", "Null", "Await", "Enum", "Eval", "Arguments"]) await expect(run("make:request", name, "--field", "ok:string")).rejects.toThrow();
  for (const fields of [[], ["bad"], ["x:date"], ["x:string??"], ["x?:string"], ["x:string:other"], ["x:string\n"], ["../x:string"], ["x-y:string"], ["__proto__:string"], ["constructor:string"], ["prototype:string"], ["x:string", "x:text?"], ["ok:string", "bad:number"], [`${"x".repeat(65)}:string`], Array.from({ length: 65 }, (_, i) => `f${i}:boolean`), Array.from({ length: 64 }, (_, i) => `field${i}${"x".repeat(56)}:string?`)]) {
    await expect(run("make:request", "Valid", ...fields.flatMap(field => ["--field", field]))).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  }
});

test("field and byte limits are enforced independently and allow 64 small fields", async () => {
  const { root, run } = await fixture();
  const args = (fields: string[]) => fields.flatMap(field => ["--field", field]);
  await expect(run("make:request", "TooMany", ...args(Array.from({ length: 65 }, (_, i) => `f${i}:boolean`)))).rejects.toThrow("1–64");
  await expect(run("make:request", "TooLarge", ...args(Array.from({ length: 64 }, (_, i) => `field${i}${"x".repeat(56)}:string?`)))).rejects.toThrow("8192 bytes");
  expect(await readdir(root)).toEqual([]);
  await run("make:request", "Maximum", ...args(Array.from({ length: 64 }, (_, i) => `f${i}:boolean`)));
  expect(Buffer.byteLength(await readFile(join(root, "src/requests/Maximum.ts"), "utf8"))).toBeLessThanOrEqual(8192);
});

test("exclusive publication refuses collisions, force, symlinks and path ancestors", async () => {
  const { root, run } = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => run("make:request", "Safe", "--field", "ok:boolean")));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const directory = join(root, "src/requests");
  const file = join(directory, "Safe.ts");
  await writeFile(file, "// owned");
  await expect(run("make:request", "Safe", "--field", "ok:boolean", "--force")).rejects.toThrow("already exists");
  expect(await readFile(file, "utf8")).toBe("// owned");
  await mkdir(join(directory, "Directory.ts"));
  await symlink(join(root, "missing"), join(directory, "Linked.ts"));
  await writeFile(join(root, "owned.ts"), "// untouched");
  await symlink(join(root, "owned.ts"), join(directory, "Existing.ts"));
  for (const name of ["Directory", "Linked", "Existing"]) await expect(run("make:request", name, "--field", "ok:boolean")).rejects.toThrow("already exists");
  expect((await readdir(directory)).sort()).toEqual(["Directory.ts", "Existing.ts", "Linked.ts", "Safe.ts"]);
  expect(await readFile(join(root, "owned.ts"), "utf8")).toBe("// untouched");
  for (const segment of ["src", "src/requests", "root"]) {
    const f = await fixture();
    await mkdir(join(f.root, "outside"));
    if (segment.includes("/")) await mkdir(join(f.root, "src"));
    await symlink(join(f.root, "outside"), join(f.root, segment));
    if (segment === "root") await expect(generateRequest(join(f.root, "root"), "Safe", ["ok:boolean"])).rejects.toThrow("real director");
    else await expect(f.run("make:request", "Safe", "--field", "ok:boolean")).rejects.toThrow("real director");
    expect(await readdir(join(f.root, "outside"))).toEqual([]);
  }
});

test("cleans staging when writing fails", async () => {
  const { root } = await fixture();
  await expect(generateRequest(root, "Safe", ["ok:string"], { writeFile: async (...args) => { await writeFile(...args); throw new Error("disk failure"); } })).rejects.toThrow("disk failure");
  expect(await readdir(join(root, "src/requests"))).toEqual([]);
});

test("real app CLI emits JSON, errors without writes, and documents the command", async () => {
  const { root, run } = await fixture();
  await run("make:app", "example");
  const app = join(root, "example");
  expect(JSON.parse(await readFile(join(app, "tsconfig.server.json"), "utf8")).include).toContain("src/requests/**/*.ts");
  await mkdir(join(app, "node_modules"));
  await symlink(projectRoot, join(app, "node_modules/bundle"));
  for (const args of [["make:request", "HTTPInput", "--field", "name:string?"], ["make:request", "Bad", "--field", "bad:date"], ["list"], ["make:request", "--help"]]) {
    const child = Bun.spawn(["bun", "run", "scripts/bundle.ts", ...args], { cwd: app, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ args, stderr, code }).toEqual({ args, stderr: args[1] === "Bad" ? stderr : "", code: args[1] === "Bad" ? 1 : 0 });
    if (args[1] === "HTTPInput") expect(JSON.parse(stdout)).toEqual({ created: "src/requests/HTTPInput.ts" });
    if (args[1] === "Bad") expect(stderr).toContain("field");
    if (args[0] === "list") expect(stdout).toContain("make:request");
    if (args[1] === "--help") { expect(stdout).toContain("--field"); expect(stdout).toContain("?"); }
  }
  expect(await readFile(join(app, "src/requests/HTTPInput.ts"), "utf8")).toContain("export const httpInput =");
  expect(await readdir(join(app, "src/requests"))).toEqual(["HTTPInput.ts"]);
});


test("generated app handler consumes a real make:request schema through readValidatedJson", async () => {
  const { root, run } = await fixture();
  await run("make:app", "typed");
  const app = join(root, "typed");
  await mkdir(join(app, "node_modules"));
  await symlink(projectRoot, join(app, "node_modules/bundle"));
  const child = Bun.spawn(["bun", "run", "scripts/bundle.ts", "make:request", "CreatePost", "--field", "title:string", "--field", "count:integer", "--field", "published:boolean?"], { cwd: app, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ stderr, code }).toEqual({ stderr: "", code: 0 });
  expect(JSON.parse(stdout).created).toBe("src/requests/CreatePost.ts");
  await writeFile(join(app, "src/web/routes.ts"), `
import { readValidatedJson } from "bundle/src/web/request.ts";
import { createPost, type CreatePost } from "../requests/CreatePost.ts";
export const routes = [{ path: "/api/posts", methods: ["POST"], async handler(request: Request) {
  const data = await readValidatedJson(request, createPost, { maxBytes: 1024 });
  const typed: CreatePost = data;
  const count: number = data.count;
  // @ts-expect-error Schema output must infer numbers, never any.
  const wrong: string = data.count;
  return Response.json(typed);
} }];
`);
  const { createRouteHandler } = await import("../web/server.ts");
  const handler = await createRouteHandler(app);
  for (const [body, status, expected] of [
    [{ title: " hello ", count: 2 }, 200, { title: "hello", count: 2 }],
    [{ title: "ok", count: "2" }, 400, "Invalid request body"],
    [{ title: "ok", count: 2, secret: "private" }, 400, "Invalid request body"],
  ] as const) {
    const response = await handler(new Request("http://localhost/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(response.status).toBe(status);
    expect(status === 200 ? await response.json() : await response.text()).toEqual(expected);
  }
});
