import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCli } from "./program.ts";
import { registerRoute } from "./route-registration.ts";
import { createRouteHandler } from "../web/server.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp("/tmp/bundle-registration-");
  roots.push(root);
  const output: string[] = [];
  const run = (...args: string[]) => createCli({ root, env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) })
    .parseAsync(["make:route", ...args], { from: "user" });
  const manifest = join(root, "src/web/routes.ts");
  const handler = (name: string) => join(root, `src/routes/${name}.ts`);
  return { root, run, output, manifest, handler };
}

test("registration creates a typed lexical manifest without needing runtime support files", async () => {
  const f = await fixture();
  await f.run("AccountSettings", "--register");
  const source = await readFile(f.manifest, "utf8");
  expect(source).toContain('import { handler as AccountSettingsHandler } from "../routes/AccountSettings.ts";');
  expect(source).toContain("export const routes: readonly Route[]");
  expect(source).not.toMatch(/import\(|glob|readdir/);
  expect(JSON.parse(f.output[0]!).registered).toEqual({ manifest: "src/web/routes.ts", path: "/account-settings" });
  const handle = await createRouteHandler(f.root);
  expect(await (await handle(new Request("http://localhost/account-settings"))).text()).toContain("<h1>AccountSettings</h1>");
});

test("registration adds distinct routes, supports root, and retries without rewriting edited handlers", async () => {
  const f = await fixture();
  await f.run("First", "--register");
  await writeFile(f.handler("First"), "// user edited handler\n");
  const before = await readFile(f.manifest, "utf8");
  await f.run("First", "--register");
  expect(await readFile(f.manifest, "utf8")).toBe(before);
  expect(await readFile(f.handler("First"), "utf8")).toBe("// user edited handler\n");
  await f.run("Second", "--register", "--path", "/nested/Second_2");
  await f.run("Home", "--register", "--path", "/");
  const source = await readFile(f.manifest, "utf8");
  for (const path of ["/first", "/nested/Second_2", "/"]) expect(source).toContain(`path: "${path}"`);
  expect(source.match(/FirstHandler } from/g)).toHaveLength(1);
});

test("collisions reject before touching either file, even with force", async () => {
  const f = await fixture();
  await f.run("First", "--register", "--path", "/same");
  const before = await readFile(f.manifest, "utf8");
  await expect(f.run("Second", "--register", "--path", "/same", "--force")).rejects.toThrow("already registered");
  expect(await Bun.file(f.handler("Second")).exists()).toBe(false);
  await expect(f.run("First", "--register", "--path", "/other")).rejects.toThrow("already registered");
  expect(await readFile(f.manifest, "utf8")).toBe(before);
  await writeFile(f.handler("Existing"), "// mine");
  await expect(f.run("Existing", "--register")).rejects.toThrow("already exists");
  expect(await readFile(f.handler("Existing"), "utf8")).toBe("// mine");
  expect(await readFile(f.manifest, "utf8")).toBe(before);
});

test("invalid paths and names fail before filesystem changes; path requires register", async () => {
  const f = await fixture();
  for (const path of ["", "relative", "//host", "/a/", "/a//b", "/a/../b", "/a/./b", "/%61", "/a?b", "/a#b", "/a\\b", "/a\n", "/a\r", "/a\u2028", "/a\u2029", "/é", "/a b", "/a\u0000"]) {
    await expect(f.run("Safe", "--register", "--path", path)).rejects.toThrow("canonical");
  }
  await expect(f.run("../Unsafe", "--register")).rejects.toThrow("PascalCase");
  await expect(f.run("Safe", "--path", "/safe")).rejects.toThrow("--register");
  expect(await readdir(f.root)).toEqual([]);
});

test("arbitrary manifests are never executed or edited and get an actionable snippet", async () => {
  for (const source of [
    '// owned comment\nexport const routes = [];\n',
    'throw new Error("do not execute"); export const routes = [];',
    'import { handler } from "../routes/Home.ts";\nexport const routes = [{ path: "/", handler }];\n',
  ]) {
    const f = await fixture();
    await mkdir(join(f.root, "src/web"), { recursive: true });
    await writeFile(f.manifest, source);
    await expect(f.run("Safe", "--register", "--path", "/safe")).rejects.toThrow('import { handler as SafeHandler } from "../routes/Safe.ts";');
    await expect(f.run("Safe", "--register")).rejects.toThrow('{ path: "/safe", handler: SafeHandler },');
    expect(await readFile(f.manifest, "utf8")).toBe(source);
    expect(await Bun.file(f.handler("Safe")).exists()).toBe(false);
  }
});

test("symlinked web directories and manifest entries are refused", async () => {
  for (const entry of ["web", "routes.ts"]) {
    const f = await fixture();
    await mkdir(join(f.root, "src/web"), { recursive: true });
    if (entry === "web") await rm(join(f.root, "src/web"), { recursive: true });
    await symlink(join(f.root, "missing"), entry === "web" ? join(f.root, "src/web") : f.manifest);
    await expect(f.run("Safe", "--register")).rejects.toThrow(/real|regular/);
    expect(await Bun.file(f.handler("Safe")).exists()).toBe(false);
  }
});

test("second publication failure rolls back both new and existing manifests", async () => {
  for (const existing of [false, true]) {
    const f = await fixture();
    if (existing) await f.run("First", "--register");
    const before = existing ? await readFile(f.manifest, "utf8") : undefined;
    let count = 0;
    await expect(registerRoute(f.root, "Second", "/second", async (from, to) => {
      if (++count === 2) throw new Error("injected second publish failure");
      await link(from, to);
    })).rejects.toThrow("injected second publish failure");
    expect(await Bun.file(f.handler("Second")).exists()).toBe(false);
    if (existing) expect(await readFile(f.manifest, "utf8")).toBe(before!);
    else expect(await Bun.file(f.manifest).exists()).toBe(false);
    expect(await readdir(join(f.root, "src/web"))).toEqual(existing ? ["routes.ts"] : []);
  }
});

test("rollback preserves files changed by another writer", async () => {
  const f = await fixture();
  await expect(registerRoute(f.root, "Safe", "/safe", async (from, to) => {
    if (to === f.manifest) {
      await writeFile(f.handler("Safe"), "// concurrent user edit\n");
      await writeFile(f.manifest, "// concurrent manifest\n");
      throw new Error("publish failed");
    }
    await link(from, to);
  })).rejects.toThrow(/rollback|changed/);
  expect(await readFile(f.handler("Safe"), "utf8")).toBe("// concurrent user edit\n");
  expect(await readFile(f.manifest, "utf8")).toBe("// concurrent manifest\n");
});

test("concurrent registration never loses a successful route", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.run("First", "--register"), f.run("Second", "--register")]);
  for (const [i, name] of ["First", "Second"].entries()) {
    if (results[i]!.status === "rejected") await f.run(name, "--register");
  }
  const source = await readFile(f.manifest, "utf8");
  expect(source).toContain("FirstHandler");
  expect(source).toContain("SecondHandler");
});

test("edited generated manifests fail closed, including injected source and duplicate entries", async () => {
  const f = await fixture();
  await f.run("First", "--register");
  const original = await readFile(f.manifest, "utf8");
  for (const source of [original + "// my notes\n", original.replace('"/first"', '"/first" + computePath()'), original.replace('  { path:', '  { path: "/first", handler: FirstHandler },\n  { path:')]) {
    await writeFile(f.manifest, source);
    await expect(f.run("Second", "--register")).rejects.toThrow("Cannot safely edit");
    expect(await readFile(f.manifest, "utf8")).toBe(source);
    expect(await Bun.file(f.handler("Second")).exists()).toBe(false);
  }
});

test("first publish failure and unsupported hard links leave both files unchanged", async () => {
  const f = await fixture();
  await f.run("First", "--register");
  const before = await readFile(f.manifest, "utf8");
  await expect(registerRoute(f.root, "Second", "/second", async () => {
    throw new Error("hard links unsupported");
  })).rejects.toThrow("hard links unsupported");
  expect(await readFile(f.manifest, "utf8")).toBe(before);
  expect(await Bun.file(f.handler("Second")).exists()).toBe(false);
  expect(await readdir(join(f.root, "src/web"))).toEqual(["routes.ts"]);
});

test("manifest changed during publication is preserved and the handler is rolled back", async () => {
  const f = await fixture();
  await f.run("First", "--register");
  await expect(registerRoute(f.root, "Second", "/second", async (from, to) => {
    await link(from, to);
    await writeFile(f.manifest, "// changed by user\n");
  })).rejects.toThrow("changed");
  expect(await readFile(f.manifest, "utf8")).toBe("// changed by user\n");
  expect(await Bun.file(f.handler("Second")).exists()).toBe(false);
});

test("unchanged legacy v1 manifests remain registrable after adding optional method types", async () => {
  const f = await fixture();
  await f.run("First", "--register");
  const legacy = (await readFile(f.manifest, "utf8")).replace(' methods?: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS")[];', "");
  await writeFile(f.manifest, legacy);
  await f.run("Second", "--register");
  const source = await readFile(f.manifest, "utf8");
  expect(source).toContain('methods?: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS")[]');
  expect(source).toContain('path: "/first"');
  expect(source).toContain('path: "/second"');
});

test("generated structural Route types support middleware while pre-middleware manifests remain registrable", async () => {
  const property = ' middleware?: readonly ((request: Request, next: () => Promise<Response>, context?: RouteContext) => Response | Promise<Response>)[];';
  for (const removeMethods of [false, true]) {
    const f = await fixture();
    await f.run("First", "--register");
    const source = await readFile(f.manifest, "utf8");
    expect(source).toContain(property);
    expect(source).toContain('handler: (request: Request, context?: RouteContext)');
    let legacy = source.replace(property, "").replace('import type { RouteContext } from "bundle/src/web/router.ts";\n', "").replaceAll(', context?: RouteContext', "");
    if (removeMethods) legacy = legacy.replace(' methods?: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS")[];', "");
    await writeFile(f.manifest, legacy);
    await f.run("Second", "--register");
    expect(await readFile(f.manifest, "utf8")).toContain(property);
  }
});

test("CLI registers parameter paths, rejects structural collisions and preserves exact manifest grammar", async () => {
  const { staticManifestEntries } = await import("./route-registration.ts");
  const f = await fixture();
  await f.run("UserNote", "--register", "--path", "/users/:userId/notes/:note_id");
  const before = await readFile(f.manifest, "utf8");
  expect(staticManifestEntries(before)).toEqual([{ name: "UserNote", path: "/users/:userId/notes/:note_id" }]);
  const router = await createRouteHandler(f.root);
  expect((await router(new Request("http://localhost/users/%E9%9B%AA/notes/1"))).status).toBe(200);
  await expect(f.run("Other", "--register", "--path", "/users/:name/notes/:id")).rejects.toThrow(/already registered|conflict/i);
  expect(await readFile(f.manifest, "utf8")).toBe(before);
  expect(await Bun.file(f.handler("Other")).exists()).toBe(false);
  for (const path of ["/:id/:id", "/:id?", "/:id*", "/:1id", "/:a-b", "/a:id", "/*", "/:"]) {
    await expect(f.run("Bad", "--register", "--path", path)).rejects.toThrow("canonical");
  }
  for (const source of [before + "// edit\n", before.replace('"/users/:userId/notes/:note_id"', '"/users/:userId/notes/:note_id" + unsafe()'), before.replace('/:userId', '/:note_id')]) {
    expect(staticManifestEntries(source)).toBeNull();
    await writeFile(f.manifest, source);
    await expect(f.run("Safe", "--register")).rejects.toThrow("Cannot safely edit");
    expect(await readFile(f.manifest, "utf8")).toBe(source);
  }
});

test("registration refuses ambiguous overlaps and manifests containing structural conflicts", async () => {
  const { staticManifestEntries } = await import("./route-registration.ts");
  const f = await fixture();
  await f.run("First", "--register", "--path", "/a/:id");
  const before = await readFile(f.manifest, "utf8");
  await expect(f.run("Second", "--register", "--path", "/:group/b")).rejects.toThrow(/conflict/i);
  expect(await Bun.file(f.handler("Second")).exists()).toBe(false);
  expect(await readFile(f.manifest, "utf8")).toBe(before);
  await f.run("Second", "--register", "--path", "/b/:name");
  const source = await readFile(f.manifest, "utf8");
  for (const path of ["/a/:other", "/:group/b"]) {
    const conflict = source.replace('"/b/:name"', `"${path}"`);
    expect(staticManifestEntries(conflict)).toBeNull();
    await writeFile(f.manifest, conflict);
    await expect(f.run("Third", "--register")).rejects.toThrow("Cannot safely edit");
    expect(await readFile(f.manifest, "utf8")).toBe(conflict);
  }
});


test("all exact historical manifest headers remain registrable and upgrade to the full method type", async () => {
  const current = ' methods?: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS")[];';
  const old = ' methods?: readonly ("GET" | "POST")[];';
  for (const methods of [current, old, ""]) {
    for (const stage of ["context", "middleware", "plain"]) {
      const f = await fixture();
      await f.run("First", "--register");
      let legacy = (await readFile(f.manifest, "utf8")).replace(current, methods);
      if (stage !== "context") legacy = legacy.replace('import type { RouteContext } from "bundle/src/web/router.ts";\n', "").replaceAll(', context?: RouteContext', "");
      if (stage === "plain") legacy = legacy.replace(' middleware?: readonly ((request: Request, next: () => Promise<Response>) => Response | Promise<Response>)[];', "");
      await writeFile(f.manifest, legacy);
      await f.run("Second", "--register");
      const upgraded = await readFile(f.manifest, "utf8");
      expect(upgraded).toContain(current);
      expect(upgraded).toContain('path: "/first"');
      expect(upgraded).toContain('path: "/second"');
      // Custom headers still fail closed, even if their entries look generated.
      await writeFile(f.manifest, upgraded.replace('"OPTIONS")[]', '"OPTIONS" | "HEAD")[]'));
      await expect(f.run("Third", "--register")).rejects.toThrow("Cannot safely edit");
      expect(await Bun.file(f.handler("Third")).exists()).toBe(false);
    }
  }
});
