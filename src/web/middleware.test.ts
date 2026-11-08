import { expect, test } from "bun:test";
import { HttpError } from "./http-error.ts";
import { createRouter, type Middleware, type Route } from "./router.ts";

const request = (method = "GET", path = "/") => new Request(`http://localhost${path}`, { method });
function secure(response: Response) {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-type")).toBeTruthy();
}

test("middleware composes in listed order, awaits downstream and preserves the original Request", async () => {
  const events: string[] = [];
  const original = request();
  const wrap = (name: string): Middleware => async (req, next) => {
    expect(req).toBe(original);
    events.push(`${name}:before`);
    await Promise.resolve();
    const response = await next();
    events.push(`${name}:after`);
    return new Response(`${name}(${await response.text()})`, response);
  };
  const router = createRouter([{ path: "/", middleware: [wrap("a"), wrap("b")], async handler(req) {
    expect(req).toBe(original); await Promise.resolve(); events.push("handler"); return new Response("ok");
  } }]);
  const response = await router(original);
  expect(await response.text()).toBe("a(b(ok))");
  expect(events).toEqual(["a:before", "b:before", "handler", "b:after", "a:after"]);
  secure(response);
});

test("middleware short-circuits authorization with secure responses and bodyless HEAD", async () => {
  let calls = 0;
  const router = createRouter([{ path: "/", middleware: [() => new Response("Unauthorized", {
    status: 401, headers: { "Cache-Control": "public", "Content-Security-Policy": "default-src *", "X-Frame-Options": "SAMEORIGIN" },
  }), async (_req, next) => { calls++; return next(); }], handler() { calls++; return new Response("secret"); } }]);
  for (const method of ["GET", "HEAD"]) {
    const response = await router(request(method));
    expect(response.status).toBe(401); secure(response);
    expect(await response.text()).toBe(method === "HEAD" ? "" : "Unauthorized");
  }
  expect(calls).toBe(0);
});

test("each middleware next dispatches once for sequential and concurrent calls, independently per request", async () => {
  for (const concurrent of [false, true]) {
    let calls = 0;
    const router = createRouter([{ path: "/", middleware: [async (_req, next) => {
      if (concurrent) { await Promise.all([next(), next()]); }
      else { await next(); await next(); }
      return new Response("unreachable");
    }], async handler() { calls++; await Promise.resolve(); return new Response("ok"); } }]);
    for (let i = 1; i <= 2; i++) {
      const response = await router(request());
      expect(response.status).toBe(500); secure(response);
      expect(await response.text()).toBe("Internal Server Error");
      expect(calls).toBe(i);
    }
  }
});

test("middleware errors and invalid responses are redacted; only known HttpErrors remain public", async () => {
  const failures: unknown[] = [new Error("private-secret"), { status: 400, message: "private-secret" },
    new HttpError(401 as any, "private-secret"), ...([400, 413, 415] as const).map(status => new HttpError(status, "Safe error"))];
  for (const method of ["GET", "HEAD", "POST"]) {
    for (const failure of failures) {
      for (const mode of ["sync", "async", "after"] as const) {
        const middleware: Middleware = mode === "sync" ? () => { throw failure; } : async (_req, next) => {
          if (mode === "after") await next(); else await Promise.resolve();
          throw failure;
        };
        const router = createRouter([{ path: "/", methods: ["GET", "POST"], middleware: [middleware], handler: () => new Response("ok") }]);
        const response = await router(request(method));
        const known = failure instanceof HttpError && [400, 413, 415].includes(failure.status);
        expect(response.status).toBe(known ? (failure as HttpError).status : 500); secure(response);
        expect(await response.text()).toBe(method === "HEAD" ? "" : known ? "Safe error" : "Internal Server Error");
      }
    }
    const router = createRouter([{ path: "/", methods: ["GET", "POST"], middleware: [(() => "private-secret") as any], handler: () => new Response() }]);
    const response = await router(request(method));
    expect(response.status).toBe(500); secure(response);
    expect(await response.text()).toBe(method === "HEAD" ? "" : "Internal Server Error");
  }
});

test("middleware scope preserves method policy, exact paths, HEAD cancellation and security finalization", async () => {
  const seen: string[] = [];
  let cancelled = 0;
  const middleware: Middleware = (req, next) => { seen.push(req.method); return next(); };
  const router = createRouter([{ path: "/exact", methods: ["GET", "POST"], middleware: [middleware], handler: req => new Response(
    req.method === "HEAD" ? new ReadableStream({ cancel() { cancelled++; } }) : req.method,
  ) }]);
  for (const method of ["GET", "HEAD", "POST", "PUT", "OPTIONS", "DELETE"]) {
    for (const path of ["/exact", "/exact/", "/exact/child", "/EXACT", "/missing"]) {
      const response = await router(request(method, path)); secure(response);
      const allowed = ["GET", "HEAD", "POST"].includes(method);
      const status = path === "/exact" ? allowed ? 200 : 405 : ["GET", "HEAD"].includes(method) ? 404 : 405;
      expect(response.status).toBe(status);
      if (status === 405) expect(response.headers.get("allow")).toBe(path === "/exact" ? "GET, HEAD, POST" : "GET, HEAD");
      if (method === "HEAD") expect(await response.text()).toBe("");
    }
  }
  expect(seen).toEqual(["GET", "HEAD", "POST"]);
  expect(cancelled).toBe(1);
});

test("middleware registration validates arrays and snapshots their entries at creation", async () => {
  for (const middleware of [null, {}, "bad", () => {}, [null], [42], [undefined], new Array(1)]) {
    expect(() => createRouter([{ path: "/", middleware, handler: () => new Response() } as any])).toThrow("middleware");
  }
  const middleware: Middleware[] = [async (_req, next) => new Response(`original:${await (await next()).text()}`)];
  const entry: Route = { path: "/", middleware, handler: () => new Response("handler") };
  const routes = [entry];
  const router = createRouter(routes);
  middleware[0] = () => new Response("changed"); middleware.push(() => new Response("added"));
  entry.middleware = []; entry.handler = () => new Response("changed"); entry.path = "/changed"; routes.length = 0;
  expect(await (await router(request())).text()).toBe("original:handler");
  const empty = createRouter([{ path: "/", middleware: Object.freeze([]), handler: () => new Response("empty") }]);
  expect(await (await empty(request())).text()).toBe("empty");
});
