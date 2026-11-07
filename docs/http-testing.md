# Native HTTP feature tests

> Reviewed native Bun feature-test equivalent, not Laravel/browser/authentication interoperability. Repaired pre-provenance full suite: 1,018 passed, 2 opt-in live-database skips, 0 failures; strict types passed in 215 files. Final source/provenance results are recorded in the durable plan.

```sh
bun run bundle make:test HealthTest --http /health
bun run bundle test tests/Feature/HealthTest.test.ts
```

Select an endpoint that really exists in your application, and customize the generated example status200 assertion. Generation does **not** create that endpoint, import routes, start a server, install dependencies, migrate or seed. `--http` and `--unit` are mutually exclusive. Ordinary generic `make:test` and unit generation retain their previous paths/behavior.

The generated code uses Bun `test`/`expect` and `withHttpApplication` from `src/http/testing.ts`. Tests live at `tests/Feature/<Name>.test.ts`; slash namespaces are allowed and imports/root URLs are computed for their depth. `fileURLToPath` preserves roots containing spaces/Unicode. Existing files and linked destination parents refuse even with global force. `stub:publish` includes the consumed `http-test.ts.stub`; retain its required name/runtimeImport/rootUrl/requestPath tokens. The requestPath token is a complete JSON string expression, not text to surround with extra quotes. The selected filename, including suffix, is limited to255bytes.

## Programmatic harness

```ts
import { expect, test } from "bun:test";
import { withHttpApplication } from "./src/http/testing.ts";

test("health", async () => {
  await withHttpApplication({ root: import.meta.dir }, async client => {
    const response = await client.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
```

Use an absolute existing application root. The helper starts the **actual** application HTTP worker on127.0.0.1 with an ephemeral port; it is not an in-process router/mock. Existing route-cache precedence and live maintenance checks apply. Trusted route/module imports retain ordinary side effects/Bun caching and the existing server's application-loading behavior; this does not invent a separate provider/auth bootstrap, copy CLI services into workers or sandbox application code.

`client.request(path, init?)` returns a native Response. The target is an at-most8192byte root-relative single-slash path without authority, backslashes, fragments or control characters. Normal native methods/headers/body are explicit. Redirects are always manual, so a fixture redirect is returned for assertions rather than automatically followed to another origin. Read or cancel response bodies yourself. Native fetch/Response semantics apply; no Laravel assertion API, cookie jar, fake authentication/session or implicit JSON transformation is supplied.

The callback's result is returned only after owned worker cleanup. Callback failure, startup failure and an optional AbortSignal all settle owned shutdown; cancellation after readiness also aborts helper requests/stops the worker and prevents a successful receipt. Retained clients refuse new requests after the callback settles. Caller databases, service scopes, other listeners and processes remain caller-owned. No test database is provisioned/reset, and simultaneous tests must isolate their own state.

Cancellation cannot forcibly terminate uncooperative callback JavaScript. The underlying server stops/terminates only its owned worker with its bounded shutdown contract; application-spawned descendants and external side effects are not comprehensively reaped or rolled back. This is a local native testing helper, not a browser driver, production service manager, security sandbox or proof of external database/service compatibility.

See the durable implementation plan for real worker/cache/maintenance/cancellation and generated native-Bun-test consumers and current final gate evidence.
