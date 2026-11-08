import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { createRouteHandler } from "../web/server.ts";
import { withDatabase } from "../database/connection.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(import.meta.dir, "../../.data/resource-test-")); roots.push(root);
  await createCli({ root, output: () => {} }).parseAsync(["make:app", "Demo"], { from: "user" });
  const app = join(root, "demo");
  await mkdir(join(app, "node_modules"));
  await symlink(join(import.meta.dir, "../.."), join(app, "node_modules/bundle"));
  const run = (...args: string[]) => createCli({ root: app, env: { DB_CONNECTION: "sqlite" }, output: () => {} }).parseAsync(args, { from: "user" });
  return { app, run };
}
const fields = ["title:string", "body:text?", "count:integer", "price:number", "done:boolean"];
const args = fields.flatMap(field => ["--field", field]);

test("generated resource runs real owner-scoped CRUD with app CLI migrations and auth", async () => {
  const { app, run } = await fixture();
  await run("make:migration", "initial"); await run("migrate");
  await run("make:resource", "Task", ...args, "--migration");
  await run("migrate");
  const handler = await createRouteHandler(app);
  const origin = "http://127.0.0.1:5173";
  const request = (path: string, method = "GET", body?: unknown, cookie = "", source: string | null = origin) => handler(new Request(`http://localhost${path}`, {
    method, headers: { cookie, "content-type": "application/json", ...(source === null ? {} : { origin: source }) }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const register = async (email: string) => {
    const response = await request("/api/auth/register", "POST", { email, password: "a long test password" });
    expect(response.status).toBe(201); return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const alice = await register("alice@example.com"), bob = await register("bob@example.com");
  const data = { title: "  hello  ", count: 2, price: 1.25, done: false };
  expect((await request("/api/tasks")).status).toBe(401);
  for (const method of ["GET", "PATCH", "DELETE"]) expect((await request("/api/tasks/1", method, method === "PATCH" ? { title: "unauthorized" } : undefined)).status).toBe(401);
  for (const method of ["POST", "PATCH", "DELETE"]) for (const source of [null, "http://evil.example"]) {
    expect((await request(method === "POST" ? "/api/tasks" : "/api/tasks/1", method, undefined, alice, source)).status).toBe(403);
  }
  let response = await request("/api/tasks", "POST", data, alice);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: 1, title: "hello", body: null, count: 2, price: 1.25, done: false });
  expect(await (await request("/api/tasks", "GET", undefined, bob)).json()).toEqual([]);
  for (const method of ["GET", "PATCH", "DELETE"]) {
    response = await request("/api/tasks/1", method, method === "PATCH" ? { title: "stolen" } : undefined, bob);
    expect(response.status).toBe(404); expect(await response.text()).toBe("Not Found");
  }
  for (const id of ["0", "-1", "1.0", "1e0", "01", "9007199254740992", "abc", "%31%2f2"]) {
    const response = await request(`/api/tasks/${id}`, "GET", undefined, alice);
    expect([400, 404]).toContain(response.status);
  }
  for (const invalid of [{}, { title: "" }, { count: 1.5 }, { done: "false" }, { price: null }, { owner: 2 }, { id: 2 }, { extra: true }]) {
    expect((await request("/api/tasks/1", "PATCH", invalid, alice)).status).toBe(400);
  }
  expect((await request("/api/tasks/1", "PATCH", undefined, alice)).status).toBe(400);
  expect((await request("/api/tasks/1", "PATCH", { body: "x".repeat(17000) }, alice)).status).toBe(413);
  for (const invalid of [null, [], {}, "text", { ...data, count: "2" }, { ...data, count: Number.MAX_SAFE_INTEGER + 1 }, { ...data, title: "" }, { ...data, title: "x".repeat(256) }, { ...data, body: "x".repeat(10001) }, { ...data, owner: 2 }, { ...data, title: null }]) {
    expect((await request("/api/tasks", "POST", invalid, alice)).status).toBe(400);
  }
  for (const [body, type, expected] of [["{private", "application/json", 400], ["{}", "text/plain", 415], ['{"title":"ok","__proto__":{}}', "application/json", 400]] as const) {
    const rejected = await handler(new Request("http://localhost/api/tasks/1", { method: "PATCH", headers: { origin, cookie: alice, "content-type": type }, body }));
    expect(rejected.status).toBe(expected); expect(await rejected.text()).not.toContain("private");
  }
  response = await request("/api/tasks/1", "PATCH", { title: "changed", body: " detail ", done: true }, alice);
  expect(response.status).toBe(200);
  const expected = { id: 1, title: "changed", body: "detail", count: 2, price: 1.25, done: true };
  expect(await response.json()).toEqual(expected);
  expect(await (await request("/api/tasks/1", "GET", undefined, alice)).json()).toEqual(expected);
  response = await request("/api/tasks/1", "PATCH", { done: false }, alice);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...expected, done: false });
  response = await request("/api/tasks/1", "PATCH", { body: null }, alice);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...expected, done: false, body: null });
  expect(await (await request("/api/tasks/1", "GET", undefined, alice)).json()).toEqual({ ...expected, done: false, body: null });
  expect((await request("/api/tasks/1", "PATCH", { body: null }, bob)).status).toBe(404);
  expect((await request("/api/tasks/1", "DELETE", undefined, alice)).status).toBe(204);
  expect((await request("/api/tasks/1", "GET", undefined, alice)).status).toBe(404);
  response = await request("/api/tasks", "POST", { ...data, body: null }, alice);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ ...data, id: 2, title: "hello", body: null });
  type SeedOwner = { id: number; email: string };
  type SeedTask = typeof data & { id: number; owner: SeedOwner };
  const { Task } = await import(join(app, "src/models/Task.ts")) as { Task: import("@mikro-orm/core").EntityClass<SeedTask> };
  const { User } = await import(join(app, "src/models/User.ts")) as { User: import("@mikro-orm/core").EntityClass<SeedOwner> };
  await withDatabase(async orm => {
    const em = orm.em.fork();
    const owner = await em.findOneOrFail(User, { email: "alice@example.com" });
    const other = await em.findOneOrFail(User, { email: "bob@example.com" });
    for (let i = 0; i < 205; i++) {
      em.persist(em.create(Task, { ...data, title: `page ${i}`, owner }));
      em.persist(em.create(Task, { ...data, title: "foreign", owner: other }));
    }
    await em.flush();
  }, { root: app, env: { DB_CONNECTION: "sqlite" } });
  const page = async (after?: number) => {
    const response = await request(`/api/tasks${after === undefined ? "" : `?after=${after}`}`, "GET", undefined, alice);
    expect(response.status).toBe(200);
    const rows = await response.json() as { id: number; title: string }[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.every((row, i) => row.title !== "foreign" && row.id > (i ? rows[i - 1]!.id : after ?? 0))).toBe(true);
    return { rows, more: response.headers.get("X-Has-More") };
  };
  const first = await page(); expect(first.rows).toHaveLength(100); expect(first.more).toBe("true");
  const cursor = first.rows.at(-1)!.id;
  const second = await page(cursor); expect(second.rows).toHaveLength(100); expect(second.more).toBe("true");
  const third = await page(second.rows.at(-1)!.id); expect(third.rows).toHaveLength(6); expect(third.more).toBe("false");
  expect(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.id)).size).toBe(206);
  expect(await page(cursor)).toEqual(second); // Previous reuses the stored exclusive boundary.
  expect(await page()).toEqual(first);
  expect((await page(third.rows.at(-1)!.id)).rows).toEqual([]);
  expect((await page(Number.MAX_SAFE_INTEGER)).more).toBe("false");
  for (const query of ["after=", "after=0", "after=-1", "after=01", "after=1.0", "after=1e2", "after=+1", "after=%201", "after=1%20", "after=NaN", "after=Infinity", "after=9007199254740992", "after=1&after=2", "after=1&after=1", "cursor=1", "after=1&limit=100", "after=%00", "after=%FF", "after=1%0A", "after=" + "9".repeat(300)]) {
    const response = await request(`/api/tasks?${query}`, "GET", undefined, alice);
    expect(response.status).toBe(400); expect(await response.text()).toBe("Invalid resource query");
  }
  // Removing the boundary does not shift the next page; new IDs only join the tail.
  expect((await request(`/api/tasks/${cursor}`, "DELETE", undefined, alice)).status).toBe(204);
  expect(await page(cursor)).toEqual(second);
  expect((await request("/api/tasks", "POST", data, alice)).status).toBe(201);
  expect(await page(cursor)).toEqual(second);
  expect((await page(second.rows.at(-1)!.id)).rows).toHaveLength(7);
  // Exactly 100 remaining rows has no extra page (101-row lookahead).
  const exact = await page(second.rows[6]!.id);
  expect(exact.rows).toHaveLength(100); expect(exact.more).toBe("false");
  await withDatabase(async orm => {
    await orm.em.fork().getConnection().execute("delete from users where email = ?", ["alice@example.com"]);
    expect(await orm.em.fork().getConnection().execute("select count(*) as n from task")).toEqual([{ n: 205 }]);
  }, { root: app, env: { DB_CONNECTION: "sqlite" } });
  expect((await request("/api/notes", "POST", { body: "starter survives" }, bob)).status).toBe(201);
}, 60_000);

test("resource generation fails closed on untrusted prerequisites and never executes manifests", async () => {
  for (const file of ["src/models/User.ts", "src/auth.ts", "src/web/routes.ts", "src/web/resources.ts", "src/web/router.ts", "scripts/bundle.ts"]) {
    const { app, run } = await fixture();
    await writeFile(join(app, file), 'throw new Error("MUST NOT EXECUTE");\n');
    await expect(run("make:resource", "Task", ...args)).rejects.toThrow("prerequisite");
    expect(await readdir(join(app, "src/models"))).toEqual(expect.not.arrayContaining(["Task.ts"]));
    expect(await readdir(join(app, "src/routes"))).toEqual(expect.not.arrayContaining(["Task.ts"]));
  }
});

test("offline scaffolding, exact manifest collision checks and no overwrites", async () => {
  const { app } = await fixture();
  const run = (...args: string[]) => createCli({ root: app, env: { DB_CONNECTION: "invalid" }, output: () => {} }).parseAsync(args, { from: "user" });
  await run("make:resource", "Task", ...args);
  const manifest = await readFile(join(app, "src/web/resources.ts"), "utf8");
  await expect(run("make:resource", "Task", ...args)).rejects.toThrow();
  await expect(run("make:resource", "Note", ...args)).rejects.toThrow();
  expect(await readFile(join(app, "src/web/resources.ts"), "utf8")).toBe(manifest);
  expect(await readdir(app)).not.toContain(".data");
});

test("staging and each publication failure roll back only owned artifacts", async () => {
  const { generateResource } = await import("./resources.ts");
  const { link } = await import("node:fs/promises");
  for (const phase of [0, 1, 2, 3, 4, 5, 6]) {
    const { app } = await fixture(); let publications = 0;
    const original = await readFile(join(app, "src/web/resources.ts"), "utf8");
    const pages = await readFile(join(app, "src/resource-pages.tsx"), "utf8");
    await expect(generateResource(app, "Task", fields, {
      writeFile: async (...args: Parameters<typeof writeFile>) => { if (phase === 0) throw new Error("injected"); return writeFile(...args); },
      publish: async (...args: Parameters<typeof link>) => { if (++publications === phase) throw new Error("injected"); await link(...args); },
    })).rejects.toThrow("injected");
    expect(await readFile(join(app, "src/web/resources.ts"), "utf8")).toBe(original);
    expect(await readFile(join(app, "src/resource-pages.tsx"), "utf8")).toBe(pages);
    expect(await Bun.file(join(app, "src/resource-pages/Task.tsx")).exists()).toBe(false);
    for (const dir of ["models", "requests", "routes"]) expect(await Bun.file(join(app, `src/${dir}/Task.ts`)).exists()).toBe(false);
    expect((await readdir(join(app, "src/web"))).some(file => file.startsWith(".bundle-resource"))).toBe(false);
  }
});

test("publication failure preserves concurrent edits and recovery material", async () => {
  const { generateResource } = await import("./resources.ts");
  const { link, unlink } = await import("node:fs/promises");
  const { app } = await fixture(); let publications = 0;
  await expect(generateResource(app, "Task", fields, { publish: async (from, to) => {
    if (++publications === 2) {
      await unlink(join(app, "src/models/Task.ts"));
      await writeFile(join(app, "src/models/Task.ts"), "// user content\n");
      throw new Error("injected");
    }
    await link(from, to);
  } })).rejects.toThrow("Rollback incomplete");
  expect(await readFile(join(app, "src/models/Task.ts"), "utf8")).toBe("// user content\n");
  expect((await readdir(join(app, "src/web"))).filter(file => file.startsWith(".bundle-resource-"))).toHaveLength(1);
});

test("concurrent generators serialize and preserve existing resource registrations", async () => {
  const { app, run } = await fixture();
  const results = await Promise.allSettled([run("make:resource", "Task", ...args), run("make:resource", "Project", "--field", "name:string")]);
  expect(results.some(result => result.status === "fulfilled")).toBe(true);
  if (results[0]!.status === "rejected") await run("make:resource", "Task", ...args);
  if (results[1]!.status === "rejected") await run("make:resource", "Project", "--field", "name:string");
  const manifest = await readFile(join(app, "src/web/resources.ts"), "utf8");
  expect(manifest).toContain('path: "/api/tasks"'); expect(manifest).toContain('path: "/api/projects"');
  const pages = await readFile(join(app, "src/resource-pages.tsx"), "utf8");
  expect(pages).toContain('hash: "#/tasks"'); expect(pages).toContain('hash: "#/projects"');
});

test("invalid fields, preexisting artifacts and missing prerequisites leave no scaffold", async () => {
  const { app, run } = await fixture();
  for (const field of ["owner:string", "owner_id:integer", "id:integer", "constructor:text", "createdAt:string", "data:json", "field:string\n"]) {
    await expect(run("make:resource", "Task", "--field", field)).rejects.toThrow();
  }
  await writeFile(join(app, "src/models/Task.ts"), "// existing\n");
  await expect(run("make:resource", "Task", ...args)).rejects.toThrow("already exists");
  expect(await readFile(join(app, "src/models/Task.ts"), "utf8")).toBe("// existing\n");
  await rm(join(app, "src/web/resources.ts"));
  await expect(run("make:resource", "Project", ...args)).rejects.toThrow("prerequisite");
  expect(await Bun.file(join(app, "src/models/Project.ts")).exists()).toBe(false);
});

test("inspect recognizes exact resource grammar offline and rejects appended executable code", async () => {
  const { app, run } = await fixture();
  await run("make:resource", "Task", ...args);
  const { inspectProject } = await import("./inspect.ts");
  let result = await inspectProject(app, "0.1.0");
  expect(result.routes.status).toBe("trusted");
  expect(result.routes.entries).toContainEqual({ path: "/api/tasks/:id", methods: ["GET", "HEAD", "PATCH", "DELETE"] });
  const manifest = join(app, "src/web/resources.ts");
  await writeFile(manifest, await readFile(manifest, "utf8") + '\nthrow new Error("NO EXECUTION");\n');
  result = await inspectProject(app, "0.1.0");
  expect(result.routes).toEqual({ status: "untrusted", entries: [] });
  await expect(run("make:resource", "Project", "--field", "name:string")).rejects.toThrow("prerequisite");
});

test("manifest source is never executed, even when it resembles generated registrations", async () => {
  const { app, run } = await fixture();
  const marker = join(app, "executed");
  const manifest = join(app, "src/web/resources.ts");
  await writeFile(manifest, await readFile(manifest, "utf8") + `\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
  await expect(run("make:resource", "Task", ...args, "--migration")).rejects.toThrow("prerequisite");
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await Bun.file(join(app, ".data/bundle.sqlite")).exists()).toBe(false);
});

test("migration guard rejects production writes before scaffold publication", async () => {
  const { app } = await fixture();
  const run = () => createCli({ root: app, env: { NODE_ENV: "production", DB_CONNECTION: "invalid" }, output: () => {} }).parseAsync(["make:resource", "Task", ...args, "--migration"], { from: "user" });
  await expect(run()).rejects.toThrow("Production database write");
  expect(await Bun.file(join(app, "src/models/Task.ts")).exists()).toBe(false);
  expect((await readdir(join(app, "src/web"))).filter(name => name.startsWith(".bundle"))).toEqual([]);
});

test("a manifest appearing during publication is preserved, with the original backup retained", async () => {
  const { generateResource } = await import("./resources.ts");
  const { link } = await import("node:fs/promises");
  const { app } = await fixture(); let publications = 0;
  await expect(generateResource(app, "Task", fields, { publish: async (from, to) => {
    if (++publications === 4) await writeFile(to, "// concurrent manifest\n", { flag: "wx" });
    await link(from, to);
  } })).rejects.toThrow("Rollback incomplete");
  expect(await readFile(join(app, "src/web/resources.ts"), "utf8")).toBe("// concurrent manifest\n");
  for (const dir of ["models", "requests", "routes"]) expect(await Bun.file(join(app, `src/${dir}/Task.ts`)).exists()).toBe(false);
});

test("missing validation module and symlinked prerequisites fail before writes", async () => {
  for (const kind of ["validation", "symlink"]) {
    const { app, run } = await fixture();
    if (kind === "validation") await rm(join(app, "node_modules/bundle"));
    else {
      await rm(join(app, "src/models/User.ts"));
      await symlink(new URL("../../templates/app/src/models/User.ts.tpl", import.meta.url).pathname, join(app, "src/models/User.ts"));
    }
    await expect(run("make:resource", "Task", ...args)).rejects.toThrow("prerequisite");
    expect(await Bun.file(join(app, "src/models/Task.ts")).exists()).toBe(false);
    expect((await readdir(join(app, "src/web"))).some(file => file.startsWith(".bundle"))).toBe(false);
  }
});

test("resource table names cannot collide with starter tables or other resources", async () => {
  const { app, run } = await fixture();
  for (const name of ["Users", "Sessions", "Notes"]) await expect(run("make:resource", name, "--field", "title:string")).rejects.toThrow("collision");
  await run("make:resource", "Task1A", "--field", "title:string");
  const previous = await readFile(join(app, "src/web/resources.ts"), "utf8");
  await expect(run("make:resource", "Task1a", "--field", "title:string")).rejects.toThrow("collision");
  expect(await readFile(join(app, "src/web/resources.ts"), "utf8")).toBe(previous);
  expect(await Bun.file(join(app, "src/models/Task1a.ts")).exists()).toBe(false);
});

test("frontend registry is exact, static, paired and never overwrites edited App/pages", async () => {
  const { app, run } = await fixture();
  const appSource = await readFile(join(app, "src/App.tsx"), "utf8") + "\n// user edit\n";
  await writeFile(join(app, "src/App.tsx"), appSource);
  await run("make:resource", "Task", ...args);
  expect(await readFile(join(app, "src/App.tsx"), "utf8")).toBe(appSource);
  const registry = join(app, "src/resource-pages.tsx");
  const source = await readFile(registry, "utf8");
  expect(source).toContain('from "./resource-pages/Task.tsx"');
  expect(source).toContain('hash: "#/tasks"');
  const page = join(app, "src/resource-pages/Task.tsx");
  await writeFile(page, await readFile(page, "utf8") + "\n// editable\n");
  await run("make:resource", "Project", "--field", "name:string");
  expect(await readFile(page, "utf8")).toContain("// editable");
  await writeFile(registry, await readFile(registry, "utf8") + '\nthrow new Error("NEVER RUN");\n');
  await expect(run("make:resource", "Other", ...args)).rejects.toThrow("prerequisite");
  expect(await Bun.file(join(app, "src/models/Other.ts")).exists()).toBe(false);
});

test("frontend registry and page symlinks or collisions fail before publication", async () => {
  for (const file of ["src/resource-pages.tsx", "src/resource-pages/Task.tsx"]) {
    const { app, run } = await fixture();
    await mkdir(join(app, "src/resource-pages"), { recursive: true });
    await rm(join(app, file), { force: true });
    await symlink("/tmp/missing-bundle-page", join(app, file));
    await expect(run("make:resource", "Task", ...args)).rejects.toThrow();
    expect(await Bun.file(join(app, "src/models/Task.ts")).exists()).toBe(false);
  }
});

test("resource names cannot shadow frontend runtime imports", async () => {
  const { run } = await fixture();
  await run("make:resource", "Resource", "--field", "title:string");
});

test("page registry rejects every unrecognized grammar or backend mismatch before any writes", async () => {
  const { resourcePageManifest } = await import("./resource-pages.ts");
  for (const source of [resourcePageManifest(["Task"]), resourcePageManifest([]) + "\n// changed\n", resourcePageManifest([]).replace("[] = [", "[] = (() => [").replace("];", "])();"), 'export const resourcePages = [eval(location.hash)];\n', 'export const resourcePages = [import(location.hash)];\n']) {
    const { app, run } = await fixture();
    await writeFile(join(app, "src/resource-pages.tsx"), source);
    await expect(run("make:resource", "Project", ...args)).rejects.toThrow("prerequisite");
    expect(await readFile(join(app, "src/resource-pages.tsx"), "utf8")).toBe(source);
    expect(await Bun.file(join(app, "src/models/Project.ts")).exists()).toBe(false);
  }
});

test("concurrent page registry edits retain both backups without clobbering", async () => {
  const { generateResource } = await import("./resources.ts");
  const { link } = await import("node:fs/promises");
  const { app } = await fixture(); let publications = 0;
  const original = await readFile(join(app, "src/web/resources.ts"), "utf8");
  await expect(generateResource(app, "Task", fields, { publish: async (from, to) => {
    if (++publications === 6) await writeFile(to, "// concurrent pages\n", { flag: "wx" });
    await link(from, to);
  } })).rejects.toThrow("Rollback incomplete");
  expect(await readFile(join(app, "src/resource-pages.tsx"), "utf8")).toBe("// concurrent pages\n");
  expect(await readFile(join(app, "src/web/resources.ts"), "utf8")).toBe(original);
  expect(await Bun.file(join(app, "src/resource-pages/Task.tsx")).exists()).toBe(false);
  const staging = (await readdir(join(app, "src/web"))).find(f => f.startsWith(".bundle-resource-"))!;
  expect(await Bun.file(join(app, "src/web", staging, "previous-pages.tsx")).exists()).toBe(true);
});

test("existing registry targets must be valid regular pages before adding another resource", async () => {
  for (const kind of ["missing", "symlink", "invalid"]) {
    const { app, run } = await fixture();
    await run("make:resource", "Task", ...args);
    const page = join(app, "src/resource-pages/Task.tsx");
    await rm(page);
    if (kind === "symlink") await symlink("/tmp/missing-page", page);
    if (kind === "invalid") await writeFile(page, "export const = { invalid");
    await expect(run("make:resource", "Project", ...args)).rejects.toThrow("prerequisite");
    expect(await Bun.file(join(app, "src/models/Project.ts")).exists()).toBe(false);
  }
});
