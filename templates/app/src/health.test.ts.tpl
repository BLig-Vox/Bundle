import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "./web/routes.ts";
import { createRouter } from "./web/router.ts";

const environment = (database: string) => ({ ...process.env, DB_CONNECTION: "sqlite", DB_DATABASE: database });

test("liveness stays independent while readiness checks the configured database safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-readiness-"));
  try {
    const database = join(root, "application.sqlite");
    const router = createRouter(createRoutes(environment(database)));
    const ready = await router(new Request("http://localhost/api/ready"));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
    expect(ready.headers.get("cache-control")).toBe("no-store");

    const head = await router(new Request("http://localhost/api/ready", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const wrongMethod = await router(new Request("http://localhost/api/ready", { method: "POST" }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD");

    const unavailableDatabase = join(root, "unavailable.sqlite");
    await mkdir(unavailableDatabase);
    const unavailableRouter = createRouter(createRoutes(environment(unavailableDatabase)));
    const liveness = await unavailableRouter(new Request("http://localhost/api/health"));
    expect(liveness.status).toBe(200);
    expect(await liveness.json()).toEqual({ status: "ok" });

    const unavailable = await unavailableRouter(new Request("http://localhost/api/ready"));
    expect(unavailable.status).toBe(503);
    const unavailableBody = await unavailable.text();
    expect(unavailableBody).toBe('{"status":"unavailable"}');
    expect(unavailableBody).not.toContain(root);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
