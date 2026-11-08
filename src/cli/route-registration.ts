import { link, lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDirectory, validateSourceName } from "./scaffold.ts";
import { routeRegistration, routeSource, validateRoutePath } from "./routes.ts";

import { compileRoutePattern, assertCompatiblePatterns, type RoutePattern } from "../web/route-pattern.ts";

type Entry = { name: string; path: string };
const header = `// Bundle static route manifest v1. Automatic edits require this exact format.
// For custom code, edit freely and use make:route without --register.
import type { RouteContext } from "bundle/src/web/router.ts";
type Route = { path: string; methods?: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS")[]; middleware?: readonly ((request: Request, next: () => Promise<Response>, context?: RouteContext) => Response | Promise<Response>)[]; handler: (request: Request, context?: RouteContext) => Response | Promise<Response> };
`;

function manifestSource(entries: Entry[]): string {
  return header + entries.map(({ name }) => routeRegistration(name).import + "\n").join("")
    + "\nexport const routes: readonly Route[] = [\n"
    + entries.map(({ name, path }) => "  " + routeRegistration(name, path).entry + "\n").join("") + "];\n";
}

/** Recognize a tiny, exact source grammar; never import or evaluate the manifest. */
function parseManifest(source: string, name: string, path: string): Entry[] {
  const entries = [...source.matchAll(/^  \{ path: "([^"\n]*)", handler: ([A-Z][A-Za-z0-9]*)Handler \},$/gm)]
    .map(match => ({ name: match[2]!, path: match[1]! }));
  try {
    const names = new Set<string>();
    const paths = new Set<string>();
    const patterns: RoutePattern[] = [];
    for (const entry of entries) {
      validateSourceName(entry.name);
      validateRoutePath(entry.path);
      const pattern = compileRoutePattern(entry.path);
      for (const previous of patterns) assertCompatiblePatterns(previous, pattern);
      patterns.push(pattern);
      if (names.has(entry.name) || paths.has(entry.path)) throw new Error("Duplicate registration");
      names.add(entry.name);
      paths.add(entry.path);
    }
    const generated = manifestSource(entries);
    // Recognize exact earlier v1 type headers, without accepting custom code.
    const beforeContext = generated.replace('import type { RouteContext } from "bundle/src/web/router.ts";\n', "").replaceAll(', context?: RouteContext', "");
    const beforeMiddleware = beforeContext.replace(' middleware?: readonly ((request: Request, next: () => Promise<Response>) => Response | Promise<Response>)[];', "");
    const methodProperty = ' methods?: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS")[];';
    const recognized = [generated, beforeContext, beforeMiddleware].flatMap(text => [
      text,
      text.replace(methodProperty, ' methods?: readonly ("GET" | "POST")[];'),
      text.replace(methodProperty, ""),
    ]);
    if (recognized.includes(source)) return entries;
  } catch { /* Any unrecognized source fails closed. */ }
  const snippet = routeRegistration(name, path);
  throw new Error(`Cannot safely edit src/web/routes.ts: it is not an unchanged Bundle-generated manifest. No handler or manifest was written. Run make:route ${name} without --register, then preserve your code and add:\n${snippet.import}\n// Add to the exported routes array:\n${snippet.entry}`);
}

/** Read-only recognition shares the registration grammar and fails closed. */
export function staticManifestEntries(source: string): Entry[] | null {
  try { return parseManifest(source, "Example", "/example"); }
  catch { return null; }
}

async function snapshot(file: string) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error(`Expected a regular file without symlinks: ${file}`);
    return { text: await readFile(file, "utf8"), ino: stat.ino, dev: stat.dev };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
type Snapshot = NonNullable<Awaited<ReturnType<typeof snapshot>>>;
async function unchanged(file: string, expected: Snapshot) {
  try {
    const current = await snapshot(file);
    return current?.ino === expected.ino && current.dev === expected.dev && current.text === expected.text;
  } catch { return false; }
}
async function removeOwned(file: string, expected: Snapshot) {
  if (!await unchanged(file, expected)) throw new Error(`File changed; rollback refused to remove user content: ${file}`);
  await unlink(file);
}

/** Staged exclusive publication with rollback on caught failures, not a crash-safe two-file transaction.
 * Requires hard links and trusted directories/writers. The lock serializes Bundle registrations only.
 * publish is injectable so failure of the second publication can be exercised deterministically.
 */
export async function registerRoute(root: string, name: string, path: string, publish: typeof link = link) {
  validateSourceName(name);
  validateRoutePath(path);
  const src = resolve(root, "src");
  const web = join(src, "web");
  const directory = join(src, "routes");
  await ensureDirectory(src);
  await ensureDirectory(web);
  const lock = join(web, ".bundle-register.lock");
  try { await writeFile(lock, "Bundle route registration in progress\n", { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Route registration busy. Retry after the other generator finishes. After an interrupted process, inspect files before removing ${lock}.`);
    throw error;
  }
  let temporary: string | undefined;
  try {
    const manifest = join(web, "routes.ts");
    const previous = await snapshot(manifest);
    const entries = previous ? parseManifest(previous.text, name, path) : [];
    const same = entries.find(entry => entry.path === path || entry.name === name);
    const destination = join(directory, `${name}.ts`);
    if (same) {
      if (same.name !== name || same.path !== path) throw new Error(`Route path or handler already registered: ${same.path} (${same.name}). Choose another name/path.`);
      await ensureDirectory(directory);
      if (!await snapshot(destination)) throw new Error("Registered handler is missing. Restore it before retrying.");
      return { registered: { manifest: "src/web/routes.ts", path } };
    }
    const nextPattern = compileRoutePattern(path);
    for (const entry of entries) {
      try { assertCompatiblePatterns(compileRoutePattern(entry.path), nextPattern); }
      catch { throw new Error("Route pattern already registered or conflicts with an existing route. Choose another path."); }
    }
    await ensureDirectory(directory);
    // Includes directories and dangling symlinks, unlike exists()/readFile().
    try {
      await lstat(destination);
      throw new Error(`Route already exists: src/routes/${name}.ts. Choose another name.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    temporary = await mkdtemp(join(web, ".bundle-register-"));
    const stagedHandler = join(temporary, "handler.ts");
    const stagedManifest = join(temporary, "routes.ts");
    const backup = join(temporary, "previous.ts");
    await writeFile(stagedHandler, routeSource(name), { flag: "wx", mode: 0o644 });
    await writeFile(stagedManifest, manifestSource([...entries, { name, path }]), { flag: "wx", mode: 0o644 });
    if (previous) await writeFile(backup, previous.text, { flag: "wx", mode: 0o644 });
    const ownedHandler = (await snapshot(stagedHandler))!;
    let handlerPublished = false;
    let manifestRemoved = false;
    try {
      await publish(stagedHandler, destination);
      handlerPublished = true;
      if (previous) {
        // Compare exact bytes and identity before removal. No rename-overwrite of user code.
        await removeOwned(manifest, previous);
        manifestRemoved = true;
      }
      await publish(stagedManifest, manifest);
    } catch (error) {
      const failures: string[] = [];
      if (manifestRemoved) {
        try { await link(backup, manifest); }
        catch { failures.push(`Manifest restore refused/failed; original retained at ${backup}`); }
      }
      if (handlerPublished) {
        try { await removeOwned(destination, ownedHandler); }
        catch (rollback) { failures.push(String(rollback)); }
      }
      if (failures.length) {
        // Keep recovery material if another writer or an I/O failure prevents rollback.
        const recovery = temporary;
        temporary = undefined;
        throw new Error(`${String(error)}; rollback incomplete: ${failures.join("; ")}. Inspect recovery files at ${recovery}.`);
      }
      throw error;
    }
    return { created: `src/routes/${name}.ts`, registered: { manifest: "src/web/routes.ts", path } };
  } finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    finally { await unlink(lock); }
  }
}
