import { HttpError } from "./http-error.ts";
import { compileRoutePattern, assertCompatiblePatterns, type RoutePattern } from "./route-pattern.ts";
import { securityHeaders } from "./response.ts";

declare const contextValue: unique symbol;
/** Explicit symbols prevent accidental collisions; the brand carries the stored value type. */
export type ContextKey<T> = symbol & { readonly [contextValue]: (value: T) => T };
export function createContextKey<T>(key: symbol): ContextKey<T> {
  if (typeof key !== "symbol") throw new Error("Context keys must be symbols.");
  return key as ContextKey<T>;
}

export class RouteContext {
  #values = new Map<symbol, unknown>();
  #params: Readonly<Record<string, string>>;
  constructor(params: Readonly<Record<string, string>> = {}) {
    this.#params = Object.freeze(Object.assign(Object.create(null), params));
  }
  get params(): Readonly<Record<string, string>> { return this.#params; }
  get<T>(key: ContextKey<T>): T | undefined { return this.#values.get(key) as T | undefined; }
  set<T>(key: ContextKey<T>, value: NoInfer<T>): void { this.#values.set(key, value); }
  delete<T>(key: ContextKey<T>): boolean { return this.#values.delete(key); }
}

/** Trusted application code. Await/return next() to continue, or return an early response. */
export type Middleware = (request: Request, next: () => Promise<Response>, context?: RouteContext) => Response | Promise<Response>;
const routeMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
/** HEAD is an implicit alias for GET, never an explicit declaration. */
export type RouteMethod = typeof routeMethods[number];
export type Route = { path: string; methods?: readonly RouteMethod[]; middleware?: readonly Middleware[]; handler: (request: Request, context?: RouteContext) => Response | Promise<Response> };

function compose(handler: Route["handler"], middleware: readonly Middleware[]): Route["handler"] {
  return (request, context) => {
    const dispatch = async (index: number): Promise<Response> => {
      const current = middleware[index];
      let called = false;
      const response = await (current ? current(request, async () => {
        if (called) throw new Error("Middleware next() may only be called once.");
        called = true;
        return dispatch(index + 1);
      }, context) : handler(request, context));
      if (!(response instanceof Response)) throw new Error("Route contract violation");
      return response;
    };
    return dispatch(0);
  };
}

/** Snapshot explicit code-owned mappings; requests never select files or imports. */
export function createRouter(routes: readonly Route[]) {
  if (!Array.isArray(routes)) throw new Error("Routes must be an array.");
  type Entry = { handler: Route["handler"]; methods: readonly string[]; allow: string };
  const entries = new Map<string, Entry>();
  const patterns: { pattern: RoutePattern; entry: Entry }[] = [];
  const compiled: RoutePattern[] = [];
  for (const route of routes) {
    if (!route) throw new Error("Invalid route.");
    const pattern = compileRoutePattern(route.path);
    for (const previous of compiled) assertCompatiblePatterns(previous, pattern);
    compiled.push(pattern);
    if (typeof route.handler !== "function") throw new Error("Route handler must be a function.");
    const middleware = route.middleware === undefined ? [] : route.middleware;
    if (!Array.isArray(middleware) || Array.from(middleware).some(entry => typeof entry !== "function")) {
      throw new Error("Route middleware must be an array of functions.");
    }
    const declared: readonly string[] = route.methods === undefined ? ["GET"] : route.methods;
    if (!Array.isArray(declared) || declared.length === 0
      || Array.from(declared).some(method => !routeMethods.includes(method))
      || new Set(declared).size !== declared.length) {
      throw new Error("Route methods must be a nonempty array of unique GET, POST, PUT, PATCH, DELETE or OPTIONS declarations.");
    }
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].filter(method =>
      method === "HEAD" ? declared.includes("GET") : declared.includes(method));
    const entry: Entry = {
      handler: middleware.length ? compose(route.handler, [...middleware]) : route.handler,
      methods, allow: methods.join(", "),
    };
    if (pattern.segments.some(segment => segment.startsWith(":"))) patterns.push({ pattern, entry });
    else entries.set(route.path, entry);
  }
  // Compilation, conflict checks and ordering happen only at startup.
  patterns.sort((a, b) => b.pattern.specificity - a.pattern.specificity);
  return async (request: Request): Promise<Response> => {
    const head = request.method === "HEAD";
    const error = (status: number, body: string, extra: Record<string, string> = {}) => new Response(head ? null : body, {
      status, headers: { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8", ...extra },
    });
    const pathname = new URL(request.url).pathname;
    let entry = entries.get(pathname);
    const params: Record<string, string> = Object.create(null);
    if (!entry && patterns.length) {
      const segments = pathname.slice(1).split("/");
      const matched = patterns.find(({ pattern }) => pattern.segments.length === segments.length
        && pattern.segments.every((segment, index) => segment.startsWith(":") || segment === segments[index]));
      if (matched) {
        entry = matched.entry;
        try {
          for (let i = 0; i < matched.pattern.segments.length; i++) {
            const segment = matched.pattern.segments[i]!;
            if (!segment.startsWith(":")) continue;
            const raw = segments[i]!;
            // Bound work before decoding; a UTF-8 byte needs at most three encoded characters.
            if (!raw || raw.length > 3072) return error(400, "Bad Request");
            const value = decodeURIComponent(raw);
            if (!value || value === "." || value === ".." || /[/\\\x00-\x1f\x7f-\x9f]/.test(value)
              || new TextEncoder().encode(value).byteLength > 1024) return error(400, "Bad Request");
            params[segment.slice(1)] = value;
          }
        } catch { return error(400, "Bad Request"); }
      }
    }
    // Preserve the default method policy for unknown paths.
    if (!entry) return request.method === "GET" || head
      ? error(404, "Not Found") : error(405, "Method Not Allowed", { Allow: "GET, HEAD" });
    if (!entry.methods.includes(request.method)) {
      return error(405, "Method Not Allowed", { Allow: entry.allow });
    }
    const context = new RouteContext(params);
    const { handler } = entry;
    try {
      const response = await handler(request, context);
      if (!(response instanceof Response)) throw new Error("Route contract violation");
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
      // Dispose a HEAD handler's body without transmitting it.
      if (head && response.body) await response.body.cancel();
      return new Response(head ? null : response.body, {
        status: response.status, statusText: response.statusText, headers,
      });
    } catch (cause) {
      if (cause instanceof HttpError && [400, 413, 415].includes(cause.status)) {
        return error(cause.status, cause.message);
      }
      return error(500, "Internal Server Error");
    }
  };
}
