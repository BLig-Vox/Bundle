import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateApp } from "../src/cli/apps.ts";

// Fresh generated app; optionally reuse installed dependencies without claiming install coverage.
const root = await mkdtemp(join(tmpdir(), "bundle-middleware-acceptance-"));
try {
  const app = join(root, await generateApp(root, "MiddlewareAcceptance"));
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, ...args], { cwd: app, stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => child.kill(), 45_000);
    try { if (await child.exited !== 0) throw new Error(`Generated middleware acceptance failed: bun ${args.join(" ")}`); }
    finally { clearTimeout(timer); }
  }
  if (process.env.BUNDLE_ACCEPTANCE_NODE_MODULES) {
    await symlink(resolve(process.env.BUNDLE_ACCEPTANCE_NODE_MODULES), join(app, "node_modules"));
    console.log("Using existing installed dependencies; this run does not verify fresh installation.");
  } else await run(["install"]);
  const contract = (await readFile(new URL("../src/web/middleware.test.ts", import.meta.url), "utf8"))
    .replace('from "./http-error.ts"', 'from "bundle/src/web/http-error.ts"')
    .replace('import { createRouter, type Middleware, type Route } from "./router.ts";',
      'import { createRouter } from "bundle/src/web/router.ts";\nimport type { Middleware, Route } from "./web/router.ts";');
  await writeFile(join(app, "src/middleware.test.ts"), contract);
  await writeFile(join(app, "src/web/middleware-types.ts"), `
import type { Middleware, Route } from "./router.ts";
const valid: Middleware = async (request, next) => {
  const method: string = request.method;
  const downstream: Promise<Response> = next();
  return downstream;
};
const route: Route = { path: "/", middleware: Object.freeze([valid]), handler: () => new Response() };
// @ts-expect-error Middleware must return a Response.
const invalid: Middleware = () => "secret";
// @ts-expect-error next accepts no replacement Request.
const replacement: Middleware = (request, next) => next(request);
// @ts-expect-error Route middleware must contain functions.
const invalidRoute: Route = { path: "/", middleware: [42], handler: () => new Response() };
`);
  await writeFile(join(app, "src/web/routes.ts"), `
import type { Middleware, Route } from "./router.ts";
const authorize: Middleware = (request, next) => request.headers.has("authorization") ? next() : new Response("Unauthorized", { status: 401 });
export const routes: readonly Route[] = [{ path: "/api/protected", methods: ["GET", "POST"], middleware: [authorize], handler: request => new Response(request.method) }];
`);
  await writeFile(join(app, "src/middleware-manifest.test.ts"), `
import { expect, test } from "bun:test";
import { createRouteHandler } from "bundle/src/web/server.ts";
test("generated manifest uses typed middleware through real direct handlers", async () => {
  const handler = await createRouteHandler(${JSON.stringify(app)});
  for (const method of ["GET", "HEAD", "POST"]) {
    const denied = await handler(new Request("http://localhost/api/protected", { method }));
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe(method === "HEAD" ? "" : "Unauthorized");
    const allowed = await handler(new Request("http://localhost/api/protected", { method, headers: { authorization: "test" } }));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe(method === "HEAD" ? "" : method);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
  }
});
`);
  await run(["run", "typecheck"]);
  await run(["test", "./src/middleware.test.ts", "./src/middleware-manifest.test.ts"]);
  console.log("Generated-app middleware types, contract suite and real direct manifest handler acceptance passed.");
} finally { await rm(root, { recursive: true, force: true }); }
