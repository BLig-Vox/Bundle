import { lstat, readdir, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createRouter } from "./router.ts";
import { securityHeaders as headers } from "./response.ts";

// Preserve the earlier public import while keeping routing independent of startup.
export { createRouter, createContextKey, RouteContext, type ContextKey, type Middleware, type RouteMethod, type Route } from "./router.ts";

/** Deliberately public startup guidance from trusted application configuration.
 * Never include credentials, paths, request data or private provider diagnostics.
 */
export class RouteConfigurationError extends Error {}

/** No DNS resolution or implicit environment overrides. Port zero requests an ephemeral port. */
export function validateAddress(hostname: string = "127.0.0.1", value: string | number = 3000) {
  if (typeof hostname !== "string" || !isIP(hostname)) {
    throw new Error("Invalid host: use a numeric IPv4 or IPv6 address (default 127.0.0.1).");
  }
  if ((typeof value === "string" && value.match(/^[0-9]+/)?.[0] !== value)
    || (typeof value !== "string" && typeof value !== "number")) {
    throw new Error("Invalid port: use an integer from 0 through 65535.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid port: use an integer from 0 through 65535.");
  }
  return { hostname, port };
}

/** Fixed trusted entry point only; never derive an import or file path from a request. */
async function entryFile(root: string, segments: readonly string[], label: string): Promise<string | undefined> {
  let current = await realpath(root);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let entry;
    try { entry = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Unable to inspect ${label}.`);
    }
    if (entry.isSymbolicLink() || (index < segments.length - 1 ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error(`${label} requires real directories and a regular file; symlinks are refused.`);
    }
  }
  return current;
}

/** Render once at startup; application modules are trusted code, not sandboxed. */
export async function createPageHandler(root: string) {
  const file = await entryFile(root, ["src", "pages", "Home.ts"], "Home page");
  let status = 404;
  let body = "Not Found";
  if (file) {
    try {
      const page = await import(pathToFileURL(file).href);
      if (typeof page.render !== "function") throw new Error("Invalid page contract");
      const html: unknown = await page.render();
      if (typeof html !== "string") throw new Error("Invalid page output");
      status = 200;
      body = html;
    } catch {
      status = 500;
      body = "Internal Server Error";
    }
  }
  return (request: Request): Response => {
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) {
      return new Response("Method Not Allowed", { status: 405, headers: {
        ...headers, "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD",
      } });
    }
    const home = new URL(request.url).pathname === "/";
    const code = home ? status : 404;
    return new Response(head ? null : home ? body : "Not Found", { status: code, headers: {
      ...headers, "Content-Type": code === 200 ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    } });
  };
}

/** Route mode imports only this root's fixed manifest, once at startup. */
export async function createRouteHandler(root: string) {
  const file = await entryFile(root, ["src", "web", "routes.ts"], "Routes manifest");
  if (!file) return createRouter([]);
  try {
    const manifest = await import(pathToFileURL(file).href);
    return createRouter(manifest.routes);
  } catch (error) {
    if (error instanceof RouteConfigurationError) throw error;
    throw new Error("Unable to load route manifest.");
  }
}

export async function createStaticAssetHandler(distRoot: string) {
  const root = resolve(distRoot);
  let rootStat;
  try { rootStat = await lstat(root); }
  catch { throw new Error("Production static assets require an existing dist directory."); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Production static assets require a real dist directory; symlinks are refused.");
  }
  const realRoot = await realpath(root);
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    ".otf": "font/otf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  };
  const files = new Map<string, { file: string; type: string; immutable: boolean }>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error("Production static assets contain a symlink; symlinks are refused.");
      if (stat.isDirectory()) { await visit(file); continue; }
      if (!stat.isFile()) throw new Error("Production static assets contain a non-regular file.");
      const extension = extname(entry.name).toLowerCase();
      const type = types[extension];
      if (!type) throw new Error("Production build contains an unsupported static asset type.");
      if (files.size >= 10_000) throw new Error("Production build contains too many static assets.");
      const path = relative(realRoot, file).split(sep).join("/");
      if (!path || path === ".." || path.startsWith("../")) throw new Error("Production static asset escaped its build directory.");
      const fingerprinted = path.startsWith("assets/") && /(?:^|[-.])[A-Za-z0-9_-]{8,}(?:[.-]|$)/.test(entry.name);
      files.set(`/${path}`, { file, type, immutable: fingerprinted });
    }
  };
  await visit(realRoot);
  const index = files.get("/index.html");
  if (!index) throw new Error("Production static assets require dist/index.html.");
  const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  const response = (request: Request, status: number, body: string | ReturnType<typeof Bun.file> | null, type = "text/plain; charset=utf-8", cache = "no-store") =>
    new Response(request.method === "HEAD" ? null : body, { status, headers: {
      ...headers, "Content-Security-Policy": csp, "Content-Type": type, "Cache-Control": cache,
      ...(status === 405 ? { Allow: "GET, HEAD" } : {}),
    } });
  return (request: Request): Response => {
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) return response(request, 405, "Method Not Allowed", undefined, "no-store");
    let pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/") || pathname.includes("\\")) return response(request, 404, "Not Found");
    if (pathname !== "/") {
      const segments = pathname.slice(1).split("/");
      if (segments.some((segment, i) => segment === "" && i !== segments.length - 1)) return response(request, 404, "Not Found");
      const decoded: string[] = [];
      try {
        for (const segment of segments) {
          if (!segment) continue;
          const value = decodeURIComponent(segment);
          if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) return response(request, 404, "Not Found");
          decoded.push(value);
        }
      } catch { return response(request, 404, "Not Found"); }
      pathname = `/${decoded.join("/")}`;
    }
    if (pathname === "/") pathname = "/index.html";
    const tail = pathname.slice(pathname.lastIndexOf("/") + 1);
    const inAssets = pathname === "/assets" || pathname.startsWith("/assets/");
    const asset = files.get(pathname) ?? (!inAssets && !tail.startsWith(".") && !extname(pathname) ? index : undefined);
    if (!asset) return response(request, 404, "Not Found");
    return response(request, 200, Bun.file(asset.file), asset.type,
      asset.immutable ? "public, max-age=31536000, immutable" : "no-store");
  };
}

/** Combine the fixed API manifest with the generated Vite build; unknown API paths never SPA-fallback. */
export async function createAppHandler(root: string) {
  const api = await createRouteHandler(root);
  const assets = await createStaticAssetHandler(join(root, "dist"));
  return (request: Request): Response | Promise<Response> => {
    const path = new URL(request.url).pathname;
    return path === "/api" || path.startsWith("/api/") ? api(request) : assets(request);
  };
}

/** Load only the fixed code-owned manifest at startup, never from request data.
 * Absent manifest retains legacy Home previews; present manifests are authoritative.
 */
export async function createServerHandler(root: string, mode?: "pages" | "routes" | "app") {
  if (mode === "pages") return createPageHandler(root);
  if (mode === "routes") return createRouteHandler(root);
  if (mode === "app") return createAppHandler(root);
  if (mode !== undefined) throw new Error("Invalid server mode: use pages, routes, or app.");
  const file = await entryFile(root, ["src", "web", "routes.ts"], "Routes manifest");
  if (!file) return createPageHandler(root);
  try {
    const manifest = await import(pathToFileURL(file).href);
    return createRouter(manifest.routes);
  } catch (error) {
    if (error instanceof RouteConfigurationError) throw error;
    // Do not expose application import errors, private paths, or contract details.
    throw new Error("Unable to load routes manifest.");
  }
}

export async function startServer(options: { root: string; hostname?: string; port?: string | number; mode?: "pages" | "routes" | "app" }) {
  const address = validateAddress(options.hostname, options.port);
  const fetch = await createServerHandler(options.root, options.mode);
  return Bun.serve({
    ...address,
    development: false,
    fetch,
    error() {
      return new Response("Internal Server Error", { status: 500, headers: {
        ...headers, "Content-Type": "text/plain; charset=utf-8",
      } });
    },
  });
}
