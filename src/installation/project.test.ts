import { afterEach, expect, test } from "bun:test";
import { watch } from "node:fs";
import { link, lstat, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProject, type CreateProjectOptions } from "./project.ts";
import { databaseFixture } from "../database/testing.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() { const result = await databaseFixture(); cleanups.push(result.cleanup); return result; }

test("project options snapshot before awaits and return immutable bounded metadata", async () => {
  const { root } = await fixture();
  const options: CreateProjectOptions & { name: string; driver: "sqlite" | "mariadb"; http: boolean } = { parent: root, name: "snapshot", driver: "sqlite", http: false };
  const pending = createProject(options);
  options.name = "changed"; options.driver = "mariadb"; options.http = true;
  const result = await pending;
  expect(result.directory).toBe(join(root, "snapshot")); expect(result.driver).toBe("sqlite"); expect(result.http).toBe(false);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.files)).toBe(true); expect(new Set(result.files).size).toBe(result.files.length);
  expect(result.dependenciesInstalled).toBe(false);
  expect(await readFile(join(result.directory, ".gitignore"), "utf8")).toContain(".bundle-test-databases/");
  expect(JSON.parse(await readFile(join(result.directory, "package.json"), "utf8")).scripts["test:isolated"]).toContain("--isolated-databases");
  expect(await Bun.file(join(root, "changed/package.json")).exists()).toBe(false);
});

test("without-http projects do not register an unavailable API child", async () => {
  const { root } = await fixture();
  const project = await createProject({ parent: root, name: "frontend-only", http: false });
  const development = await readFile(join(project.directory, "dev.ts"), "utf8");
  const view = await readFile(join(project.directory, "resources/js/views/App.tsx"), "utf8");
  expect(development).not.toContain('name: "api"');
  expect(development).toContain('name: "web"');
  expect(view).toContain("This application was created without the HTTP backend.");
  expect(await Bun.file(join(project.directory, "routes.ts")).exists()).toBe(false);
});

test("project API rejects unsafe option records and paths before publication", async () => {
  const { root } = await fixture(); let accessed = false;
  const accessor = Object.defineProperty({ parent: root }, "name", { enumerable: true, get() { accessed = true; return "getter"; } });
  const inputs: unknown[] = [accessor, { parent: ".", name: "relative" }, { parent: root, name: "nested/name" }, { parent: root, name: "invalid", driver: "mysql" }, { parent: root, name: "invalid", http: "yes" }, { parent: root, name: "invalid", install: true }, { parent: root, name: "invalid", signal: {} }, Object.assign(Object.create({ inherited: true }), { parent: root, name: "inherited" })];
  for (const input of inputs) await expect(createProject(input as CreateProjectOptions)).rejects.toThrow();
  expect(accessed).toBe(false);
  for (const name of ["getter", "relative", "invalid", "inherited"]) expect(await Bun.file(join(root, name, "package.json")).exists()).toBe(false);
});

test("project cancellation during source preflight creates no destination", async () => {
  const { root } = await fixture(); const controller = new AbortController();
  const result = createProject({ parent: root, name: "cancelled", signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await expect(result).rejects.toThrow();
  await expect(lstat(join(root, "cancelled"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("project publication cancellation cannot report success or remove parent data", async () => {
  const { root } = await fixture(); const controller = new AbortController();
  await writeFile(join(root, "preserve.txt"), "parent data\n");
  const watcher = watch(root, (_event, filename) => { if (filename?.toString() === "partial") controller.abort(); });
  try {
    await expect(createProject({ parent: root, name: "partial", signal: controller.signal })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(await readFile(join(root, "preserve.txt"), "utf8")).toBe("parent data\n");
  } finally { watcher.close(); }
});

test.each(["mismatch", "url"] as const)("unsafe bundled dependency %s refuses before publication", async kind => {
  const { root } = await fixture();
  const app = await createProject({ parent: root, name: "template" });
  const filename = join(app.directory, "package.json"); const metadata = JSON.parse(await readFile(filename, "utf8"));
  metadata.dependencies["@mikro-orm/core"] = kind === "mismatch" ? "7.2.6" : "https://registry.invalid/unsupported-package";
  await writeFile(filename, JSON.stringify(metadata));
  const cloned: typeof import("./project.ts") = await import(pathToFileURL(join(app.directory, "src/installation/project.ts")).href);
  await expect(cloned.createProject({ parent: root, name: "refused" })).rejects.toThrow();
  await expect(lstat(join(root, "refused"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["symlink", "hardlink", "missing"] as const)("shipped template %s refusal precedes destination creation", async kind => {
  const { root } = await fixture();
  const app = await createProject({ parent: root, name: "template" });
  const document = join(app.directory, "docs/database.md");
  expect((await readFile(document, "utf8")).length).toBeGreaterThan(0);
  if (kind === "hardlink") await link(document, join(root, "document-link"));
  else {
    await rename(document, join(root, "preserved-document.md"));
    if (kind === "symlink") await symlink(join(root, "preserved-document.md"), document);
  }
  const cloned: typeof import("./project.ts") = await import(pathToFileURL(join(app.directory, "src/installation/project.ts")).href);
  await expect(cloned.createProject({ parent: root, name: "refused" })).rejects.toThrow();
  await expect(lstat(join(root, "refused"))).rejects.toMatchObject({ code: "ENOENT" });
});
