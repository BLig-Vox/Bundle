import { link, lstat, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { modelSource } from "../database/generators.ts";
import { ensureDirectory } from "./scaffold.ts";
import { resourceManifest, resourceManifestNames, resourcePath, resourceTable, validateResourceName } from "./resource-manifest.ts";

import { resourcePageManifest, resourcePageManifestNames, resourcePageSource } from "./resource-pages.ts";

const manifestFiles = ["src/web/resources.ts", "src/resource-pages.tsx"];
const templateRoot = new URL("../../templates/app/", import.meta.url);
const scalar = {
  string: ['string', 'string', 'schema.string({ trim: true, min: 1, max: 255 })'],
  text: ['string', 'text', 'schema.string({ trim: true, min: 1, max: 10000 })'],
  integer: ['number', 'integer', 'schema.number({ finite: true, integer: true, min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })'],
  number: ['number', 'double', 'schema.number({ finite: true })'],
  boolean: ['boolean', 'boolean', 'schema.boolean()'],
} as const;

export function resourceSources(name: string, specs: string[]) {
  validateResourceName(name);
  modelSource(name, specs); // Shared reserved identifiers and DB column collision rules.
  if (!specs.length || specs.length > 32) throw new Error("Provide 1–32 resource fields.");
  const fields = specs.map(spec => {
    const match = /^([A-Za-z][A-Za-z0-9_]{0,63}):(string|text|integer|number|boolean)(\?)?$/.exec(spec);
    if (!match || match[0] !== spec) throw new Error("Invalid resource field; use string, text, integer, number, boolean and optional ?.");
    const key = match[1]!;
    if (["owner", "ownerid"].includes(key.replaceAll("_", "").toLowerCase())) throw new Error("Reserved owner field.");
    const type = match[2]! as keyof typeof scalar;
    const optional = !!match[3];
    const validation = optional ? `schema.nullable(${scalar[type][2]})` : scalar[type][2];
    return { key, type, optional, validation };
  });
  const model = `import { EntitySchema as _EntitySchema, ReferenceKind as _ReferenceKind } from "@mikro-orm/core";
import { User as _User } from "./User.ts";

export class ${name} {
  id!: number;
  owner!: _User;
${fields.map(f => `  ${f.key}${f.optional ? "?" : "!"}: ${scalar[f.type][0]}${f.optional ? " | null" : ""};`).join("\n")}
}
export default new _EntitySchema<${name}>({ class: ${name}, properties: {
  id: { type: "number", primary: true },
  owner: { kind: _ReferenceKind.MANY_TO_ONE, entity: () => _User, deleteRule: "cascade" },
${fields.map(f => `  ${f.key}: { type: "${scalar[f.type][1]}"${f.optional ? ", nullable: true" : ""} },`).join("\n")}
} });
`;
  const request = `import { schema, type Infer, type Schema } from "bundle/src/validation/schema.ts";

export const create${name} = schema.object({
${fields.map(f => `  ${f.key}: ${f.optional ? `schema.optional(${f.validation})` : f.validation},`).join("\n")}
});
const partial = schema.object({
${fields.map(f => `  ${f.key}: schema.optional(${f.validation}),`).join("\n")}
});
export type Create${name} = Infer<typeof create${name}>;
export type Update${name} = Infer<typeof partial>;
export const update${name}: Schema<Update${name}> = {
  safeParse(input) {
    const result = partial.safeParse(input);
    if (result.success && Object.keys(result.data).length === 0) return { success: false, issues: [{ path: [], code: "too_small" }] };
    return result;
  },
};
`;
  const handler = `import { appRoot, authenticatedUserId, failure } from "../auth.ts";
import { withDatabase } from "bundle/src/database/connection.ts";
import type { Environment } from "bundle/src/database/config.ts";
import { readValidatedJson } from "bundle/src/web/request.ts";
import type { RouteContext } from "../web/router.ts";
import { User as _User } from "../models/User.ts";
import { ${name} as _Model } from "../models/${name}.ts";
import { create${name}, update${name} } from "../requests/${name}.ts";

const output = (row: _Model) => ({ id: row.id, ${fields.map(f => `${f.key}: row.${f.key}${f.optional ? " ?? null" : ""}`).join(", ")} });
export function create${name}Handler(env: Environment = process.env) {
  return async (request: Request, context?: RouteContext): Promise<Response> => {
    const ownerId = context?.get(authenticatedUserId);
    if (ownerId === undefined) return failure(401, "Unauthorized");
    const param = context?.params.id;
    let id: number | undefined;
    if (param !== undefined) {
      if (!/^[1-9][0-9]*$/.test(param) || !Number.isSafeInteger(Number(param))) return failure(400, "Invalid resource ID");
      id = Number(param);
    }
    let after: number | undefined;
    if (id === undefined && (request.method === "GET" || request.method === "HEAD")) {
      const query = new URL(request.url).searchParams;
      const values = query.getAll("after");
      if ([...query.keys()].some(key => key !== "after") || values.length > 1
        || (values.length === 1 && (!/^[1-9][0-9]*$/.test(values[0]!) || !Number.isSafeInteger(Number(values[0])) || String(Number(values[0])) !== values[0]))) {
        return failure(400, "Invalid resource query");
      }
      if (values.length) after = Number(values[0]);
    }
    const create = request.method === "POST" ? await readValidatedJson(request, create${name}, { maxBytes: 16384 }) : undefined;
    const update = request.method === "PATCH" ? await readValidatedJson(request, update${name}, { maxBytes: 16384 }) : undefined;
    return withDatabase(async orm => {
      const em = orm.em.fork();
      const owner = em.getReference(_User, ownerId);
      if (create) {
        const row = em.create(_Model, { ...create, owner });
        em.persist(row); await em.flush();
        return Response.json(output(row), { status: 201 });
      }
      if (id === undefined) {
        const rows = await em.find(_Model, { owner, ...(after === undefined ? {} : { id: { $gt: after } }) }, { orderBy: { id: "asc" }, limit: 101 });
        return Response.json(rows.slice(0, 100).map(output), { headers: { "X-Has-More": String(rows.length > 100) } });
      }
      const row = await em.findOne(_Model, { id, owner });
      if (!row) return failure(404, "Not Found");
      if (request.method === "DELETE") {
        em.remove(row); await em.flush();
        return new Response(null, { status: 204 });
      }
      if (update) { em.assign(row, update); await em.flush(); }
      return Response.json(output(row));
    }, { root: appRoot, env });
  };
}
`;
  return new Map([[`src/models/${name}.ts`, model], [`src/requests/${name}.ts`, request], [`src/routes/${name}.ts`, handler], [`src/resource-pages/${name}.tsx`, resourcePageSource(name, fields)]]);
}

async function snapshot(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 262144) throw new Error("Expected a bounded regular file.");
  return { ino: stat.ino, dev: stat.dev, text: await readFile(path, "utf8") };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
async function unchanged(path: string, expected: Snapshot) {
  try { const current = await snapshot(path); return current.ino === expected.ino && current.dev === expected.dev && current.text === expected.text; }
  catch { return false; }
}
async function removeOwned(path: string, expected: Snapshot) {
  if (!await unchanged(path, expected)) throw new Error(`Concurrent edit preserved at ${path}`);
  await unlink(path);
}

/** Read-only, fixed-path trust checks. No project imports, even on rejection. */
async function prerequisites(root: string) {
  const tracked = new Map<string, Snapshot>();
  try {
    for (let path = root;; path = dirname(path)) {
      if (!(await lstat(path)).isDirectory()) throw new Error("Unsafe ancestor");
      if (dirname(path) === path) break;
    }
    for (const file of ["src/models/User.ts", "src/models/Session.ts", "src/auth.ts", "src/web/router.ts", "src/web/routes.ts", "scripts/bundle.ts", "src/web/resources.ts", "src/resource-pages.tsx", "src/ResourcePage.tsx", "src/ResourceNavigation.tsx"]) {
      let directory = root;
      for (const part of file.split("/").slice(0, -1)) {
        directory = join(directory, part);
        if (!(await lstat(directory)).isDirectory()) throw new Error("Unsafe directory");
      }
      const current = await snapshot(join(root, file));
      if (!manifestFiles.includes(file) && current.text !== await readFile(new URL(`${file}.tpl`, templateRoot), "utf8")) throw new Error("Modified source");
      tracked.set(file, current);
    }
    const names = resourceManifestNames(tracked.get("src/web/resources.ts")!.text);
    const pageNames = resourcePageManifestNames(tracked.get("src/resource-pages.tsx")!.text);
    if (!names || !pageNames || JSON.stringify(names) !== JSON.stringify(pageNames)) throw new Error("Untrusted manifest");
    // Existing pages remain editable, but registry targets must be real, valid TSX files.
    for (const name of names) {
      const directory = join(root, "src/resource-pages");
      if (!(await lstat(directory)).isDirectory()) throw new Error("Unsafe page directory");
      const file = `src/resource-pages/${name}.tsx`;
      const page = await snapshot(join(root, file));
      new Bun.Transpiler({ loader: "tsx" }).transformSync(page.text);
      tracked.set(file, page);
    }
    const module = Bun.resolveSync("bundle/src/validation/schema.ts", join(root, "scripts"));
    if (await realpath(module) !== await realpath(new URL("../validation/schema.ts", import.meta.url))) throw new Error("Untrusted validation module");
    return { tracked, names };
  } catch { throw new Error("Resource prerequisite absent or untrusted: requires the unchanged generated User, Session, auth middleware, router, app CLI, routes, exact paired resource/API page manifests, frontend runtime and linked Bundle typed validation module. No artifacts written."); }
}

/** Staged, no-clobber publication; trusted directories required against hostile races. */
export async function generateResource(root: string, name: string, fields: string[], io: { publish?: typeof link; writeFile?: typeof writeFile; beforePublish?: () => Promise<void> } = {}) {
  root = resolve(root);
  const sources = resourceSources(name, fields);
  const { tracked, names } = await prerequisites(root);
  if (names.includes(name) || names.some(previous => resourcePath(previous) === resourcePath(name))) throw new Error("Resource already registered.");
  if (names.some(previous => resourceTable(previous) === resourceTable(name))) throw new Error("Resource table collision with an existing resource.");
  const page = sources.get(`src/resource-pages/${name}.tsx`)!;
  sources.delete(`src/resource-pages/${name}.tsx`);
  sources.set("src/web/resources.ts", resourceManifest([...names, name]));
  if (!resourceManifestNames(sources.get("src/web/resources.ts")!)) throw new Error("Invalid staged manifest");
  sources.set(`src/resource-pages/${name}.tsx`, page);
  sources.set("src/resource-pages.tsx", resourcePageManifest([...names, name]));
  if (!resourcePageManifestNames(sources.get("src/resource-pages.tsx")!)) throw new Error("Invalid staged page manifest");
  // Validate every artifact before the first publication. The generator emits fixed imports only.
  for (const source of sources.values()) new Bun.Transpiler({ loader: "tsx" }).transformSync(source);
  for (const file of sources.keys()) {
    if (manifestFiles.includes(file)) continue;
    const directory = dirname(join(root, file));
    try { if (!(await lstat(directory)).isDirectory()) throw new Error("Unsafe destination directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await lstat(join(root, file)); throw new Error(`Resource artifact already exists: ${file}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await io.beforePublish?.();
  const lock = join(root, "src/web/.bundle-resource.lock");
  try { await writeFile(lock, "Bundle resource publication in progress. Inspect staging before recovery.\n", { flag: "wx" }); }
  catch { throw new Error("Resource registration busy; after a crash inspect .bundle-resource-* staging and files before removing .bundle-resource.lock."); }
  const lockSnapshot = await snapshot(lock);
  let staging: string | undefined;
  let retain = false;
  const owned: [string, Snapshot][] = [];
  const removed: string[] = [];
  const backups = new Map<string, string>();
  try {
    // Recheck after lock acquisition so another completed generator cannot be lost.
    for (const [file, expected] of tracked) if (!await unchanged(join(root, file), expected)) throw new Error("Resource prerequisite changed concurrently.");
    staging = await mkdtemp(join(root, "src/web/.bundle-resource-"));
    for (const file of manifestFiles) {
      const backup = join(staging, file === "src/web/resources.ts" ? "previous-manifest.ts" : "previous-pages.tsx");
      await writeFile(backup, tracked.get(file)!.text, { flag: "wx" });
      backups.set(file, backup);
    }
    const staged: [string, string, Snapshot][] = [];
    for (const [file, source] of sources) {
      const path = join(staging, `${staged.length}.ts`);
      await (io.writeFile ?? writeFile)(path, source, { flag: "wx", mode: 0o644 });
      const current = await snapshot(path);
      if (current.text !== source) throw new Error("Staged artifact validation failed");
      staged.push([file, path, current]);
    }
    await writeFile(join(staging, "recovery.json"), JSON.stringify({ files: staged.map(([file, path, identity]) => ({ file, staged: path, ino: identity.ino, dev: identity.dev })), manifests: [...backups].map(([file, backup]) => ({ file, backup })) }, null, 2), { flag: "wx" });
    for (const [file, expected] of tracked) if (!await unchanged(join(root, file), expected)) throw new Error("Resource prerequisite changed concurrently.");
    try {
      for (const [file, path, identity] of staged) {
        await ensureDirectory(dirname(join(root, file)));
        if (manifestFiles.includes(file)) { await removeOwned(join(root, file), tracked.get(file)!); removed.push(file); }
        await (io.publish ?? link)(path, join(root, file));
        owned.push([join(root, file), identity]);
      }
    } catch (error) {
      const failures: string[] = [];
      for (const [path, identity] of owned.reverse()) {
        try { await removeOwned(path, identity); } catch { failures.push(path); }
      }
      for (const file of removed) { try { await link(backups.get(file)!, join(root, file)); } catch { failures.push(join(root, file)); } }
      if (failures.length) { retain = true; throw new Error(`Publication failed; concurrent edits preserved. Rollback incomplete at ${failures.join(", ")}. Recovery: ${staging}`); }
      throw error;
    }
    return { created: [...sources.keys()].filter(file => !manifestFiles.includes(file)), registered: { manifest: "src/web/resources.ts", path: resourcePath(name) } };
  } finally {
    if (staging && !retain) await rm(staging, { recursive: true, force: true });
    await removeOwned(lock, lockSnapshot);
  }
}
