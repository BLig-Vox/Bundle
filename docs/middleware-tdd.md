# Route middleware: test-first evidence

Tests were written and executed before implementation. Actual RED results:

```text
$ bun test src/web/middleware.test.ts
Expected: "a(b(ok))"
Received: "ok"
Expected: 401
Received: 200
Expected: 500
Received: 200
Expected substring: "middleware"
Received function did not throw
0 pass
6 fail

$ bun test src/cli/apps.test.ts -t 'generated app typed middleware'
Expected: 401
Received: 200
0 pass
1 fail

$ bun test src/cli/route-registration.test.ts -t 'generated structural Route'
Expected to contain: " middleware?: readonly ((request: Request, next: () => Promise<Response>) => Response | Promise<Response>)[];"
0 pass
1 fail
```

The core contract tests cover async composition and unwind order, original Request identity, authorization short-circuits, sequential/concurrent repeated next calls and per-request isolation, synchronous/asynchronous/post-next errors, safe HttpErrors versus forged/unsupported errors, invalid responses, redaction, security headers, exact path and method policy, HEAD cancellation, malformed/sparse arrays, and immutable registration snapshots. Existing no-middleware router tests remain unchanged.

Generated apps already delegate routing to Bundle core. Their adapter now re-exports Middleware alongside Route, avoiding a second implementation. The generated-app acceptance test generates a real app, writes a typed middleware manifest, and exercises createRouteHandler directly with GET/HEAD/POST, authorization, order, snapshot mutations, errors, repeated next, 405 Allow and static paths. It uses a linked local Bundle dependency; no live socket is needed. Structural make:route manifests also gain the optional middleware type while preserving recognition of earlier unchanged generated headers.

Middleware is trusted application code, not a sandbox. The snapshot freezes registration choices, not closures or shared application state. Middleware can catch downstream errors or start detached work; await/return next() and finish request work before returning. Router security finalization applies to the final response, and unknown errors escaping the chain are redacted.

Verification results:

- `bun test`: 197 passed, 5 skipped, 0 failed (three live socket checks and two opt-in external database checks skipped).
- `bun run typecheck` and `bunx --no-install tsc --noEmit`: passed.
- `bun run graph:check` and `git diff --check`: passed.
- `BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-app-cached-An1sL4/demo/node_modules bun run scripts/verify-middleware.ts`: a fresh generated app passed frontend, tooling and server TypeScript checks, including positive/negative Middleware type assertions, plus seven middleware contract/direct-handler tests. Installed dependencies were reused; this run does not establish fresh-install success. Without the environment override the script attempts a real install.

No commit or push was performed.
