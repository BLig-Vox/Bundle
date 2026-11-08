import { expect, test } from "bun:test";
import { createRouter, RouteContext, type Route } from "./router.ts";

const handler = () => new Response("ok");
const request = (path: string, method = "GET") => new Request(`http://localhost${path}`, { method });

test("parameters decode once, support GET/POST/HEAD and share immutable isolated context", async () => {
  const contexts = new Set<RouteContext>();
  const params = new Set<object>();
  const route: Route = { path: "/users/:userId/notes/:note_id", methods: ["GET", "POST"],
    middleware: [async (_request, next, context) => {
      contexts.add(context!); params.add(context!.params);
      expect(Object.isFrozen(context!.params)).toBe(true);
      expect(Object.getPrototypeOf(context!.params)).toBeNull();
      expect(() => { (context!.params as any).userId = "changed"; }).toThrow();
      expect(() => { (context as any).params = {}; }).toThrow();
      await Promise.resolve();
      return next();
    }], handler: (req, context) => {
      expect(contexts.has(context!)).toBe(true);
      expect(params.has(context!.params)).toBe(true);
      return Response.json([req.method, context!.params]);
    } };
  const router = createRouter([route]);
  route.path = "/changed";
  for (const method of ["GET", "POST", "HEAD"]) {
    const response = await router(request("/users/%E9%9B%AA/notes/%252F", method));
    expect(response.status).toBe(200);
    if (method === "HEAD") expect(await response.text()).toBe("");
    else expect(await response.json()).toEqual([method, { userId: "雪", note_id: "%2F" }]);
  }
  const results = await Promise.all(["alice", "bob"].map(id => router(request(`/users/${id}/notes/1`))));
  expect(await Promise.all(results.map(r => r.json()))).toEqual([
    ["GET", { userId: "alice", note_id: "1" }], ["GET", { userId: "bob", note_id: "1" }],
  ]);
  expect(contexts.size).toBe(5); expect(params.size).toBe(5);
  if (false) {
    const context = new RouteContext();
    // @ts-expect-error Parameter values are immutable.
    context.params.id = "changed";
    // @ts-expect-error The parameter property cannot be replaced.
    context.params = {};
  }
});

test("unsafe captures fail with generic secure 400 before middleware and method dispatch", async () => {
  let calls = 0;
  const router = createRouter([{ path: "/p/:id/end", middleware: [(_req, next) => { calls++; return next(); }], handler }]);
  for (const value of ["", "%", "%2", "%GG", "%C0%AF", "%ED%A0%80", "%FF", "%E2%82", "%2f", "%2F", "%5c", "%5C", "a%2Fb", "%00", "%01", "%1F", "%7F", "%C2%85", "a".repeat(1025), "%61".repeat(1025)]) {
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      const response = await router(request(`/p/${value}/end`, method));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(method === "HEAD" ? "" : "Bad Request");
      expect(response.headers.get("allow")).toBeNull();
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
  }
  expect(calls).toBe(0);
  expect((await router(request(`/p/${"é".repeat(512)}/end`))).status).toBe(200);
  expect((await router(request(`/p/${"é".repeat(513)}/end`))).status).toBe(400);
  // URL parsing normalizes dot segments before routing; they never resolve a file.
  for (const value of ["..", "%2e%2e", ".", "%2e", "..%2fsecret", "..%5csecret"]) {
    expect([400, 404]).toContain((await router(request(`/p/${value}/end`))).status);
  }
});

test("static specificity wins independently of order and methods, preserving exact static matching", async () => {
  const routes: Route[] = [
    { path: "/p/:id", methods: ["POST"], handler: (_req, ctx) => new Response(ctx!.params.id) },
    { path: "/p/new", handler: (_req, ctx) => { expect(ctx!.params).toEqual({}); return new Response("static"); } },
    { path: "/:group/:id", handler },
  ];
  for (const entries of [routes, [...routes].reverse()]) {
    const router = createRouter(entries);
    expect(await (await router(request("/p/new"))).text()).toBe("static");
    for (const [path, method, status, allow] of [["/p/new", "POST", 405, "GET, HEAD"], ["/p/42", "GET", 405, "POST"], ["/p/42", "POST", 200, null], ["/p/42/", "GET", 404, null], ["/absent", "GET", 404, null], ["/absent", "POST", 405, "GET, HEAD"]] as const) {
      const response = await router(request(path, method));
      expect(response.status).toBe(status); expect(response.headers.get("allow")).toBe(allow);
    }
  }
  const staticOnly = createRouter([{ path: "/hello", handler }]);
  for (const path of ["/Hello", "/%68ello", "/hello/", "/hello//", "/%GG"]) expect((await staticOnly(request(path))).status).toBe(404);
});

test("startup rejects malformed, structurally duplicate and ambiguous patterns", () => {
  for (const path of ["/:", "/:1id", "/:id?", "/:id*", "/*", "/a:id", "/:a-b", "/:a.b", "/:é", "/:id/:id", "/:id/", "/:id//x", "/:id\n", "/:id?x", "/:id#x"]) {
    expect(() => createRouter([{ path, handler }])).toThrow();
  }
  for (const paths of [["/p/:id", "/p/:name"], ["/:id/x/:other", "/:a/x/:b"], ["/a/:id", "/:group/b"]]) {
    for (const order of [paths, [...paths].reverse()]) expect(() => createRouter(order.map(path => ({ path, handler })))).toThrow(/Duplicate|conflict/i);
  }
  // Parameter identifiers must not interact with object prototypes.
  const router = createRouter([{ path: "/:__proto__/:constructor", handler: (_req, ctx) => Response.json(ctx!.params) }]);
  return router(request("/safe/value")).then(async response => expect(await response.json()).toEqual(JSON.parse('{"__proto__":"safe","constructor":"value"}')));
});
