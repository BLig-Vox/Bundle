import { expect, test } from "bun:test";
import { createRouteHandler } from "bundle/src/web/server.ts";
import { fileURLToPath } from "node:url";
import { createTask, updateTask, type CreateTask, type UpdateTask } from "../src/requests/Task.ts";
import type { RequiredEntityData } from "@mikro-orm/core";
import type { Task } from "../src/models/Task.ts";

// Compile-time checks run in the linked app's real TypeScript configuration.
const typed: CreateTask = { title: "typed", count: 2, price: 1.25, done: false };
const partial: UpdateTask = { done: true };
const nulls = { label: null, body: null, rank: null, ratio: null, active: null };
const nullableCreate: CreateTask = { ...typed, ...nulls };
const nullableUpdate: UpdateTask = nulls;
// @ts-expect-error Optional nullable string fields retain their child type.
const wrongNullable: UpdateTask = { body: 1 };
// @ts-expect-error Nonnullable fields reject null on create.
const nullCreate: CreateTask = { ...typed, title: null };
// @ts-expect-error Nonnullable fields reject null on PATCH.
const nullUpdate: UpdateTask = { count: null };
// @ts-expect-error Required create fields cannot be omitted.
const missing: CreateTask = {};
// @ts-expect-error Integer fields must infer number, never any.
const wrong: CreateTask = { ...typed, count: "2" };
// @ts-expect-error Updates cannot set the owner.
const owner: UpdateTask = { owner: 1 };
// @ts-expect-error A generated model requires an owner.
const noOwner: RequiredEntityData<Task> = typed;

test("linked generated resource uses migrated SQLite, strict schemas and owner context", async () => {
  expect(createTask.safeParse(typed).success).toBe(true);
  expect(updateTask.safeParse(partial).success).toBe(true);
  expect(createTask.safeParse(nullableCreate).success).toBe(true);
  expect(updateTask.safeParse(nullableUpdate).success).toBe(true);
  expect(updateTask.safeParse({}).success).toBe(false);
  const handler = await createRouteHandler(fileURLToPath(new URL("../", import.meta.url)));
  const call = (path: string, method = "GET", body?: unknown, cookie = "", origin: string | null = "http://localhost") => handler(new Request(`http://localhost${path}`, {
    method, headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const register = async (email: string) => {
    const response = await call("/api/auth/register", "POST", { email, password: "long acceptance password" });
    expect(response.status).toBe(201); return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const alice = await register("resource-alice@example.com"), bob = await register("resource-bob@example.com");
  expect((await call("/api/tasks")).status).toBe(401);
  const response = await call("/api/tasks", "POST", { ...typed, title: " trimmed ", label: "label", body: "text", rank: 3, ratio: 1.5, active: true }, alice);
  expect(response.status).toBe(201);
  const created = await response.json() as { id: number } & CreateTask;
  expect(created).toEqual({ id: created.id, title: "trimmed", label: "label", body: "text", count: 2, price: 1.25, done: false, rank: 3, ratio: 1.5, active: true });
  const path = `/api/tasks/${created.id}`;
  for (const method of ["GET", "PATCH", "DELETE"]) expect((await call(path, method, method === "PATCH" ? partial : undefined, bob)).status).toBe(404);
  expect(await (await call("/api/tasks", "GET", undefined, bob)).json()).toEqual([]);
  for (const method of ["POST", "PATCH", "DELETE"]) for (const origin of [null, "https://evil.example"]) expect((await call(method === "POST" ? "/api/tasks" : path, method, undefined, alice, origin)).status).toBe(403);
  expect((await call(path, "PATCH", {}, alice)).status).toBe(400);
  expect((await call(path, "PATCH", { count: "2" }, alice)).status).toBe(400);
  for (const key of ["title", "count", "price", "done"]) {
    expect((await call("/api/tasks", "POST", { ...typed, [key]: null }, alice)).status).toBe(400);
    expect((await call(path, "PATCH", { [key]: null }, alice)).status).toBe(400);
  }
  const updated = await call(path, "PATCH", partial, alice);
  expect(updated.status).toBe(200); expect(await updated.json()).toEqual({ ...created, done: true });
  expect(await (await call(path, "GET", undefined, alice)).json()).toEqual({ ...created, done: true });
  const cleared = await call(path, "PATCH", nullableUpdate, alice);
  expect(cleared.status).toBe(200);
  const expected = { ...created, done: true, ...nulls };
  expect(await cleared.json()).toEqual(expected);
  expect(await (await call(path, "GET", undefined, alice)).json()).toEqual(expected);
  const explicit = await call("/api/tasks", "POST", nullableCreate, bob);
  expect(explicit.status).toBe(201);
  const bobCreated = await explicit.json() as { id: number } & CreateTask;
  expect(bobCreated).toEqual({ ...nullableCreate, id: bobCreated.id });
  expect((await call(`/api/tasks/${bobCreated.id}`, "PATCH", nullableUpdate, alice)).status).toBe(404);
  expect((await call(path, "DELETE", undefined, alice)).status).toBe(204);
  expect((await call(path, "GET", undefined, alice)).status).toBe(404);
});

test("generated collection keeps arrays and traverses exclusive owner-scoped SQLite pages", async () => {
  const { withDatabase } = await import("bundle/src/database/connection.ts");
  const { Task } = await import("../src/models/Task.ts");
  const { User } = await import("../src/models/User.ts");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const handler = await createRouteHandler(root);
  const email = `pages-${Date.now()}@example.com`;
  const registered = await handler(new Request("http://localhost/api/auth/register", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ email, password: "long pagination password" }) }));
  expect(registered.status).toBe(201);
  const cookie = registered.headers.get("set-cookie")!.split(";")[0]!;
  let ids: number[] = [];
  await withDatabase(async orm => {
    const em = orm.em.fork();
    const owner = await em.findOneOrFail(User, { email });
    const other = await em.findOneOrFail(User, { email: "resource-bob@example.com" });
    const rows = Array.from({ length: 201 }, (_, i) => {
      const row = em.create(Task, { ...typed, title: `page ${i}`, owner });
      em.persist(em.create(Task, { ...typed, owner: other }));
      return row;
    });
    em.persist(rows); await em.flush(); ids = rows.map(row => row.id);
  }, { root });
  const page = async (after?: number) => {
    const response = await handler(new Request(`http://localhost/api/tasks${after === undefined ? "" : `?after=${after}`}`, { headers: { cookie } }));
    expect(response.status).toBe(200);
    const rows = await response.json() as { id: number }[];
    expect(Array.isArray(rows)).toBe(true);
    return { ids: rows.map(row => row.id), more: response.headers.get("X-Has-More") };
  };
  expect(await page()).toEqual({ ids: ids.slice(0, 100), more: "true" });
  expect(await page(ids[99])).toEqual({ ids: ids.slice(100, 200), more: "true" });
  expect(await page(ids[199])).toEqual({ ids: ids.slice(200), more: "false" });
  expect(await page(ids[99])).toEqual({ ids: ids.slice(100, 200), more: "true" });
  expect(await page(ids[200])).toEqual({ ids: [], more: "false" });
  expect(await page(ids[100])).toEqual({ ids: ids.slice(101), more: "false" });
  for (const query of ["after=0", "after=01", "after=1e2", "after=-1", "after=9007199254740992", "after=", "after=1&after=1", "offset=100", "after=1&limit=1"]) {
    const response = await handler(new Request(`http://localhost/api/tasks?${query}`, { headers: { cookie } }));
    expect(response.status).toBe(400); expect(await response.text()).toBe("Invalid resource query");
  }
});
