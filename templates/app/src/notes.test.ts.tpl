import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDatabase } from "bundle/src/database/connection.ts";
import { createRouter } from "bundle/src/web/router.ts";
import { createNotesHandler, appRoot } from "./routes/Notes.ts";
import { authenticatedUserId } from "./auth.ts";
import { createRoutes } from "./web/routes.ts";
import { createAuthHandlers } from "./routes/Auth.ts";
import { User } from "./models/User.ts";
import { Note } from "./models/Note.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(schema = true, direct = false) {
  const directory = await mkdtemp(join(tmpdir(), "bundle-notes-")); roots.push(directory);
  const env = { DB_CONNECTION: "sqlite", APP_PUBLIC_ORIGIN: "http://localhost", DB_DATABASE: join(directory, "notes.sqlite") };
  if (schema) await withDatabase(orm => orm.schema.create(), { root: appRoot, env });
  const notes = createNotesHandler(env);
  // Keep body-validation coverage independent of authentication and SQLite availability.
  const router = createRouter(direct ? [{ path: "/api/notes", methods: ["GET", "POST"], handler(request, context) {
    context!.set(authenticatedUserId, 1);
    return notes(request, context);
  } }] : createRoutes(env));
  let cookie = "";
  if (schema) {
    const response = await createAuthHandlers(env).register(new Request("http://localhost/api/auth/register", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ email: "notes@example.com", password: "long notes password" }),
    }));
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  }
  if (!schema) cookie = "bundle_session=" + "a".repeat(43);
  const request = (method = "GET", body?: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
    router(new Request("http://localhost/api/notes", { method, body, headers: { ...headers, origin: "http://localhost", cookie } }));
  return { request, env };
}
function secure(response: Response) {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

test("notes reject malformed, wrong media type, oversized JSON and invalid schemas before opening the DB", async () => {
  const { request } = await fixture(false, true);
  for (const [body, status, message, headers] of [
    ["{private", 400, "Invalid JSON"],
    ["", 400, "Empty JSON body"],
    ['{"body":"hi"}', 415, "Unsupported Media Type", { "content-type": "text/plain" }],
    [JSON.stringify({ body: "a".repeat(16384) }), 413, "Payload Too Large"],
    [JSON.stringify({ body: "é".repeat(9000) }), 413, "Payload Too Large", { "content-type": "application/json", "content-length": "2" }],
    ['{"body":"ok","__proto__":{}}', 400, "Invalid request body"],
    ...[null, [], "hello", 1, true, {}, { body: 4 }, { body: null }, { body: "" }, { body: " \n\t " }, { body: "a".repeat(1001) }, { body: "ok", extra: true }, { body: "ok", __proto__: null, constructor: "bad" }]
      .map(value => [JSON.stringify(value), 400, "Invalid request body"]),
  ] as [string, number, string, Record<string, string>?][]) {
    const response = await request("POST", body, headers);
    secure(response);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(message);
  }
  const declared = await request("POST", "{}", { "content-type": "application/json", "content-length": "16385" });
  expect(declared.status).toBe(413);
});

test("notes create trimmed data, list ordered bounded IDs and preserve method/security defaults", async () => {
  const { request, env } = await fixture();
  let response = await request(); secure(response);
  expect(await response.json()).toEqual([]);
  for (const body of ["  hello <script> & \n", "a".repeat(1000)]) {
    response = await request("POST", JSON.stringify({ body })); secure(response);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ id: body.startsWith(" ") ? 1 : 2, body: body.trim() });
  }
  response = await request(); secure(response);
  expect(await response.json()).toEqual([{ id: 1, body: "hello <script> &" }, { id: 2, body: "a".repeat(1000) }]);
  // Insertion order differs from ID order; the response stays capped even as data grows.
  await withDatabase(async orm => {
    const em = orm.em.fork();
    const owner = await em.findOneOrFail(User, { email: "notes@example.com" });
    for (let id = 110; id >= 3; id--) em.persist(em.create(Note, { id, body: "note", owner }));
    await em.flush();
  }, { root: appRoot, env });
  response = await request();
  const notes = await response.json() as { id: number; body: string }[];
  expect(notes).toHaveLength(100);
  expect(notes.map(note => note.id)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  const head = await request("HEAD"); secure(head);
  expect(head.status).toBe(200); expect(await head.text()).toBe("");
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    response = await request(method); secure(response);
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
  }
});

test("notes sanitize real SQLite failures on reads and writes", async () => {
  const { request } = await fixture(false);
  for (const method of ["GET", "HEAD", "POST"]) {
    const response = await request(method, method === "POST" ? '{"body":"private-note"}' : undefined);
    secure(response);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(method === "HEAD" ? "" : "Internal Server Error");
  }
});
