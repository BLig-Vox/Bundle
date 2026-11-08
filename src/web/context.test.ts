import { expect, test } from "bun:test";
import { createContextKey, RouteContext, createRouter, type Middleware, type Route, type ContextKey } from "./router.ts";

test("context keys infer values, preserve symbol identity and support deletion", () => {
  const key = createContextKey<number>(Symbol("userId"));
  const other = createContextKey<number>(Symbol("userId"));
  const context = new RouteContext();
  expect(context.get(key)).toBeUndefined();
  context.set(key, 7);
  const value: number | undefined = context.get(key);
  expect(value).toBe(7);
  expect(context.get(other)).toBeUndefined();
  expect(context.delete(key)).toBe(true);
  expect(context.delete(key)).toBe(false);
  if (false) {
    // @ts-expect-error Values must match the branded key.
    context.set(key, "secret");
    // @ts-expect-error Plain symbols do not carry a value type.
    context.get(Symbol());
    // @ts-expect-error Keys of different value types are incompatible.
    const wrong: ContextKey<string> = key;
    // @ts-expect-error The inferred read includes absence.
    const required: number = context.get(key);
  }
});

test("each dispatch shares context through middleware and handler but isolates concurrent and repeated requests", async () => {
  const key = createContextKey<string>(Symbol("auth"));
  const contexts = new Set<RouteContext>();
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const auth: Middleware = async (request, next, context) => {
    expect(context).toBeInstanceOf(RouteContext);
    expect(context!.get(key)).toBeUndefined();
    contexts.add(context!);
    context!.set(key, request.headers.get("user")!);
    if (++arrived === 2) release();
    await ready;
    return next();
  };
  const route: Route = { path: "/", middleware: [auth], handler: (_request, context) => new Response(context!.get(key)) };
  const router = createRouter([route]);
  for (let i = 0; i < 2; i++) {
    const responses = await Promise.all(["alice", "bob"].map(user => router(new Request("http://localhost/", { headers: { user } }))));
    expect(await Promise.all(responses.map(response => response.text()))).toEqual(["alice", "bob"]);
  }
  expect(contexts.size).toBe(4);
});

test("context composition snapshots handler and middleware, denies early, and sanitizes next errors", async () => {
  const key = createContextKey<number>(Symbol());
  let calls = 0;
  const middleware: Middleware[] = [(_request, next, context) => { context!.set(key, 42); return next(); }];
  const route: Route = { path: "/", middleware, handler: (_request, context) => { calls++; return new Response(String(context!.get(key))); } };
  const router = createRouter([route]);
  route.handler = () => new Response("changed");
  middleware[0] = () => new Response("changed");
  expect(await (await router(new Request("http://localhost/"))).text()).toBe("42");
  const deny = createRouter([{ ...route, middleware: [() => new Response("Denied", { status: 401 })] }]);
  expect((await deny(new Request("http://localhost/"))).status).toBe(401);
  expect(calls).toBe(1);
  for (const fail of [false, true]) {
    const broken = createRouter([{ path: "/", middleware: [async (_request, next, context) => {
      context!.set(key, 1);
      await next();
      if (fail) throw new Error("secret");
      return next();
    }], handler: (_request, context) => { expect(context!.get(key)).toBe(1); calls++; return new Response(); } }]);
    const response = await broken(new Request("http://localhost/"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  }
  expect(calls).toBe(3);
});

test("routes without middleware receive a fresh context even when dispatching the same Request", async () => {
  const key = createContextKey<number>(Symbol("count"));
  const contexts = new Set<RouteContext>();
  const router = createRouter([{ path: "/", async handler(_request, context) {
    expect(context).toBeInstanceOf(RouteContext);
    expect(context!.get(key)).toBeUndefined();
    contexts.add(context!);
    context!.set(key, 1);
    await Promise.resolve();
    expect(context!.delete(key)).toBe(true);
    return new Response("ok");
  } }]);
  const request = new Request("http://localhost/");
  await Promise.all([router(request), router(request)]);
  await router(request);
  expect(contexts.size).toBe(3);
});
