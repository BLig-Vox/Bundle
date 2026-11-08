import { expect, test } from "bun:test";
import { createRouter } from "bundle/src/web/router.ts";
import { routes } from "./web/routes.ts";

test("app manifest serves health and enforces method, path and security defaults", async () => {
  const router = createRouter(routes);
  const response = await router(new Request("http://localhost/api/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect((await router(new Request("http://localhost/missing"))).status).toBe(404);
  expect((await router(new Request("http://localhost/api/health", { method: "POST" }))).status).toBe(405);
});


test("app manifest exposes explicit notes methods and rejects missing Origin", async () => {
  const router = createRouter(routes);
  const response = await router(new Request("http://localhost/api/notes", { method: "DELETE" }));
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
  const invalid = await router(new Request("http://localhost/api/notes", {
    method: "POST", body: "{}", headers: { "content-type": "application/json" },
  }));
  expect(invalid.status).toBe(403);
});
