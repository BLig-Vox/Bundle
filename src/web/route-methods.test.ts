import { expect, test } from "bun:test";
import { createRouter, type Route, type RouteMethod } from "./router.ts";

const declarations = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const canonical = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const request = (method: string, path = "/items/雪") => new Request(`http://localhost${path}`, { method });

test("every explicit method subset dispatches only declared verbs and produces exact canonical Allow", async () => {
  for (let mask = 1; mask < 1 << declarations.length; mask++) {
    const methods: RouteMethod[] = declarations.filter((_, index) => mask & (1 << index)).reverse();
    const allowed = canonical.filter(method => method === "HEAD" ? methods.includes("GET") : methods.includes(method));
    const events: string[] = [];
    const route: Route = { path: "/items/:id", methods, middleware: [async (req, next, ctx) => {
      events.push(`middleware:${req.method}:${ctx!.params.id}`);
      const response = await next();
      response.headers.set("x-param", ctx!.params.id === "雪" ? "snow" : "other");
      return response;
    }], handler(req, ctx) {
      events.push(`handler:${req.method}:${ctx!.params.id}`);
      return new Response(`body:${req.method}`, { status: 202, headers: { "x-handler": "yes" } });
    } };
    const router = createRouter([route]);
    methods.length = 0; // Startup snapshots methods independently of later registration edits.
    for (const method of [...canonical, "TRACE"]) {
      events.length = 0;
      const response = await router(request(method));
      const supported = allowed.includes(method as typeof canonical[number]);
      expect(response.status).toBe(supported ? 202 : 405);
      expect(response.headers.get("allow")).toBe(supported ? null : allowed.join(", "));
      expect(await response.text()).toBe(method === "HEAD" ? "" : supported ? `body:${method}` : "Method Not Allowed");
      expect(events).toEqual(supported ? [`middleware:${method}:雪`, `handler:${method}:雪`] : []);
      expect(response.headers.get("x-handler")).toBe(supported ? "yes" : null);
      expect(response.headers.get("x-param")).toBe(supported ? "snow" : null);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  }
});

test("defaults and unknown paths retain GET/HEAD policy; OPTIONS is never automatic", async () => {
  const router = createRouter([{ path: "/default", handler: () => new Response("default") }]);
  for (const path of ["/default", "/unknown"]) {
    for (const method of [...canonical, "TRACE"]) {
      const response = await router(request(method, path));
      const read = method === "GET" || method === "HEAD";
      expect(response.status).toBe(read ? path === "/default" ? 200 : 404 : 405);
      expect(response.headers.get("allow")).toBe(read ? null : "GET, HEAD");
      expect(await response.text()).toBe(method === "HEAD" ? "" : read ? path === "/default" ? "default" : "Not Found" : "Method Not Allowed");
    }
  }
});

test("only the GET HEAD alias cancels a successful handler body, preserving status and headers", async () => {
  for (const method of canonical) {
    let canceled = false;
    let called = "";
    const router = createRouter([{ path: "/", methods: [...declarations], handler(req) {
      called = req.method;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("payload"));
      }, cancel() { canceled = true; } }), { status: 201, headers: { "x-test": "retained" } });
    } }]);
    const response = await router(request(method, "/"));
    expect(called).toBe(method);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("retained");
    expect(canceled).toBe(method === "HEAD");
    if (method === "HEAD") expect(await response.text()).toBe("");
    else {
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("payload");
      await reader.cancel();
    }
  }
});

test("method validation rejects aliases, invalid declarations and duplicates of every verb at startup", () => {
  for (const methods of [[], ["HEAD"], ["TRACE"], ["CONNECT"], ["patch"], ["DELETE", "HEAD"], ["OPTIONS", undefined], [42], new Array(1), "PUT", null,
    ...declarations.map(method => [method, method])]) {
    expect(() => createRouter([{ path: "/", methods, handler: () => new Response() } as any])).toThrow("methods");
  }
  // @ts-expect-error HEAD is exclusively the implicit GET alias.
  const head: RouteMethod = "HEAD";
  // @ts-expect-error Unknown methods must be rejected by the public type too.
  const trace: Route["methods"] = ["TRACE"];
});
