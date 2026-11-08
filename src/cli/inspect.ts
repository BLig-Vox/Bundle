import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resourceManifestNames, resourcePath } from "./resource-manifest.ts";
import { staticManifestEntries } from "./route-registration.ts";

type FileStatus = "ok" | "missing" | "unreadable";
type Route = { path: string; methods: string[] };
const sourceRoots = ["src", "templates/app/src"];
const homeManifest = 'import { handler } from "../routes/Home.ts";\nimport type { Route } from "./router.ts";\n\n// Static, code-owned GET/HEAD registrations. No filesystem discovery or dynamic imports.\nexport const routes: readonly Route[] = [{ path: "/", handler }];\n';
const authRoutes: Route[] = [
  { path: "/api/auth/register", methods: ["POST"] },
  { path: "/api/auth/login", methods: ["POST"] },
  { path: "/api/auth/logout", methods: ["POST"] },
  { path: "/api/auth/password", methods: ["POST"] },
  { path: "/api/auth/me", methods: ["GET", "HEAD"] },
  { path: "/api/health", methods: ["GET", "HEAD"] },
  { path: "/api/notes", methods: ["GET", "HEAD", "POST"] },
];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Fixed relative paths only. Refuse symlink components and special files.
 * As with scaffolding, directories must be trusted against concurrent replacement.
 */
async function safePath(root: string, relative: string, directory = false) {
  let path = root;
  const rootStat = await lstat(path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe root");
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    const stat = await lstat(path);
    const needsDirectory = i < parts.length - 1 || directory;
    if (stat.isSymbolicLink() || (needsDirectory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error("Unsafe path");
    }
  }
  return path;
}

async function readProjectFile(root: string, relative: string): Promise<{ status: FileStatus; text: string | null }> {
  try {
    const file = await open(await safePath(root, relative), "r");
    try {
      // Bound reads even if a file grows after stat. Never include errors/source in output.
      if ((await file.stat()).size > 262144) return { status: "unreadable", text: null };
      const buffer = Buffer.alloc(262145);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 262144) return { status: "unreadable", text: null };
      return { status: "ok", text: buffer.subarray(0, bytesRead).toString("utf8") };
    } finally { await file.close(); }
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", text: null };
  }
}

function packageIdentity(file: Awaited<ReturnType<typeof readProjectFile>>) {
  const empty = { name: null, version: null };
  if (file.text === null) return { status: file.status, ...empty };
  try {
    const data: unknown = JSON.parse(file.text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { status: "invalid", ...empty };
    const { name, version } = data as Record<string, unknown>;
    // Identity fields only: no dependency URLs, script bodies or arbitrary metadata.
    return {
      status: "ok",
      name: typeof name === "string" && name.length <= 214 && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ? name : null,
      version: typeof version === "string" && version.length <= 80 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : null,
    };
  } catch { return { status: "invalid", ...empty }; }
}

export async function inspectProject(root: string, version: string) {
  root = resolve(root);
  const roots: string[] = [];
  const models: string[] = [];
  for (const source of sourceRoots) {
    try { await safePath(root, source, true); roots.push(source); } catch { continue; }
    try {
      const directory = await safePath(root, `${source}/models`, true);
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (file.isFile() && /^[A-Za-z][A-Za-z0-9_-]*\.ts(?:\.tpl)?$/.test(file.name)) models.push(`${source}/models/${file.name}`);
      }
    } catch { /* Missing/unreadable conventional model directories yield an empty list. */ }
  }
  const manifest = await readProjectFile(root, "src/web/routes.ts");
  let status: string = manifest.status;
  let entries: Route[] = [];
  let generatedAuth = false;
  if (manifest.text !== null) {
    const registered = staticManifestEntries(manifest.text);
    // Compare complete text with framework-owned literals; never extract partial matches.
    const appManifest = await readFile(new URL("../../templates/app/src/web/routes.ts.tpl", import.meta.url), "utf8").catch(() => null);
    generatedAuth = manifest.text === appManifest;
    if (registered !== null) entries = registered.map(entry => ({ path: entry.path, methods: ["GET", "HEAD"] }));
    else if (manifest.text === homeManifest) entries = [{ path: "/", methods: ["GET", "HEAD"] }];
    else if (generatedAuth) {
      const resources = await readProjectFile(root, "src/web/resources.ts");
      const names = resources.text === null ? null : resourceManifestNames(resources.text);
      if (names === null) { status = "untrusted"; generatedAuth = false; }
      else entries = [
        ...authRoutes.map(entry => ({ ...entry, methods: [...entry.methods] })),
        ...names.flatMap(name => [
          { path: resourcePath(name), methods: ["GET", "HEAD", "POST"] },
          { path: resourcePath(name) + "/:id", methods: ["GET", "HEAD", "PATCH", "DELETE"] },
        ]),
      ];
    }
    else status = "untrusted";
    if (status !== "untrusted") status = "trusted";
  }
  const authFile = await readProjectFile(root, "src/auth.ts");
  const authPresent = generatedAuth || authFile.status === "ok";
  return {
    schemaVersion: 1,
    framework: { name: "bundle", version },
    package: packageIdentity(await readProjectFile(root, "package.json")),
    sourceRoots: roots.sort(compare), models: models.sort(compare),
    routes: { status, entries: entries.sort((a, b) => compare(a.path, b.path)) },
    migrations: "unknown",
    auth: {
      status: generatedAuth ? "generated-template" : authPresent ? "present-unverified" : "unknown",
      caveat: authPresent ? "Development-only auth; not production-ready. Review shared throttling, recovery and deployment security." : null,
    },
    next: {
      scaffold: roots.length ? "bun run bundle make:model Product" : "bun run bundle make:app my-app",
      dev: generatedAuth ? "bun run dev" : "bun run bundle serve",
      verify: "bun test && bun run typecheck",
    },
  };
}

export function formatInspection(data: Awaited<ReturnType<typeof inspectProject>>) {
  return [
    `package: ${data.package.name ?? "null"}@${data.package.version ?? "null"} (${data.package.status}); framework: ${data.framework.name}@${data.framework.version}`,
    `sources: ${data.sourceRoots.join(", ") || "[]"}`,
    `models: ${data.models.join(", ") || "[]"}`,
    `routes: ${data.routes.status}${data.routes.entries.length ? " " + data.routes.entries.map(entry => entry.methods.join("|") + " " + entry.path).join(", ") : " []"}`,
    "migrations: unknown (offline)",
    `auth: ${data.auth.status}${data.auth.caveat ? "; " + data.auth.caveat : ""}`,
    `scaffold: ${data.next.scaffold}`,
    `dev: ${data.next.dev}`,
    `verify: ${data.next.verify}`,
  ].join("\n");
}
