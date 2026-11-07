import { expect, test } from "bun:test";
import { ServiceContainer } from "./services.ts";

test("service lifetimes, missing and cyclic dependencies, and reverse async disposal", async () => {
  const disposed: string[] = [];
  const container = new ServiceContainer();
  let id = 0;
  container.register("single", "singleton", () => ({ id: ++id, async dispose() { disposed.push("single"); } }));
  container.register("scope", "scoped", () => ({ id: ++id, async dispose() { disposed.push("scope"); } }));
  container.register("transient", "transient", () => ({ id: ++id, async dispose() { disposed.push("transient"); } }));
  container.register("cycle", "scoped", scope => scope.resolve("cycle"));
  const a = container.createScope(), b = container.createScope();
  expect(a.resolve("single")).toBe(b.resolve("single"));
  expect(a.resolve("scope")).toBe(a.resolve("scope"));
  expect(a.resolve("scope")).not.toBe(b.resolve("scope"));
  expect(a.resolve("transient")).not.toBe(a.resolve("transient"));
  expect(() => a.resolve("missing")).toThrow("missing");
  expect(() => a.resolve("cycle")).toThrow("cycle");
  await a.dispose();
  expect(disposed).toEqual(["transient", "transient", "scope"]);
  await b.dispose();
  await container.dispose();
  expect(disposed).toEqual(["transient", "transient", "scope", "scope", "single"]);
});

test("singleton factories cannot capture shorter-lived dependencies", async () => {
  const container = new ServiceContainer();
  container.register("short", "scoped", () => ({}));
  container.register("long", "singleton", scope => scope.resolve("short"));
  const scope = container.createScope();
  expect(() => scope.resolve("long")).toThrow("singleton");
  await scope.dispose(); await container.dispose();
});

test("disposal continues after failures and rejects with all errors", async () => {
  const container = new ServiceContainer();
  const disposed: string[] = [];
  container.register("a", "scoped", () => ({ dispose() { disposed.push("a"); throw new Error("a failed"); } }));
  container.register("b", "scoped", () => ({ async dispose() { disposed.push("b"); throw new Error("b failed"); } }));
  const scope = container.createScope();
  scope.resolve("a"); scope.resolve("b");
  await expect(scope.dispose()).rejects.toBeInstanceOf(AggregateError);
  expect(disposed).toEqual(["b", "a"]);
});

 test("aliases dispose shared singleton and scoped identities once", async () => {
  const c = new ServiceContainer(); const disposed: string[] = [];
  c.register("singleton", "singleton", () => ({dispose() { disposed.push("singleton"); }}));
  c.register("singletonAlias", "singleton", s => s.resolve("singleton"));
  c.register("scoped", "scoped", () => ({dispose() { disposed.push("scoped"); }}));
  c.register("scopedAlias", "scoped", s => s.resolve("scoped"));
  c.register("singletonScopedAlias", "scoped", s => s.resolve("singleton"));
  const s = c.createScope(); s.resolve("singletonAlias"); s.resolve("scopedAlias"); s.resolve("singletonScopedAlias");
  await s.dispose(); expect(disposed).toEqual(["scoped"]); await c.dispose(); expect(disposed).toEqual(["scoped", "singleton"]);
});

test("thenable factory results are rejected and eventually disposed", async () => {
  const c = new ServiceContainer(); let disposed = 0;
  c.register("async", "scoped", () => Promise.resolve({dispose() { disposed++; }}));
  const s = c.createScope(); expect(() => s.resolve("async")).toThrow("Asynchronous");
  await s.dispose(); expect(disposed).toBe(1); await c.dispose();
});

test("an async function factory is rejected before it executes", () => {
  const c = new ServiceContainer(); let called = false;
  expect(() => c.register("async", "scoped", async () => { called = true; return {}; })).toThrow("Asynchronous");
  expect(called).toBe(false);
});

test("rejected thenable failures are observed during scope disposal", async () => {
  const c = new ServiceContainer(); c.register("bad", "scoped", () => Promise.reject(Error("async failure")));
  const s = c.createScope(); expect(() => s.resolve("bad")).toThrow("Asynchronous");
  await expect(s.dispose()).rejects.toBeInstanceOf(AggregateError); await c.dispose();
});

test("a scoped object cannot be promoted to singleton or shared across scopes", async () => {
  const c = new ServiceContainer(); const object = {};
  c.register("scoped", "scoped", () => object); c.register("single", "singleton", () => object);
  const a = c.createScope(), b = c.createScope(); a.resolve("scoped");
  expect(() => a.resolve("single")).toThrow("ownership");
  expect(() => b.resolve("scoped")).toThrow("ownership");
  await a.dispose(); await b.dispose(); await c.dispose();
});
