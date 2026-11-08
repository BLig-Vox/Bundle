# Explicit HTTP methods: test-first evidence

Before changing implementation, this focused run recorded **27 pass, 1 socket-dependent skip, 6 fail**, with 990 assertions:

```sh
bun test src/web/route-methods.test.ts src/web/router.test.ts src/cli/route-registration.test.ts src/cli/routes.test.ts src/cli/serve.test.ts
```

RED output was captured in `/tmp/bundle-route-methods-red.log`. The method-subset test and HEAD/body test failed with `Route methods must be a nonempty array of unique GET or POST declarations.` The real generated CLI successfully registered handlers, but loading their manually edited DELETE/PATCH registrations failed with `Unable to load route manifest.` Generated manifest assertions failed because the structural type still declared only GET/POST; serve help also omitted the new verbs. `bun run typecheck` separately failed on the missing public `RouteMethod` export and the expanded declarations, captured in `/tmp/bundle-route-methods-type-red.log`.

The implementation adds PUT, PATCH, DELETE and OPTIONS to the public declaration type and startup validator. Allowed methods are snapshotted in canonical GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS order, independently of declaration order. HEAD remains exclusively an implicit GET alias: it receives the original HEAD request, executes middleware/handler, preserves status/headers, and cancels the final response body. HEAD requests to routes without GET receive 405 without running application code. Error responses to HEAD still have no body. OPTIONS requires an explicit declaration and receives normal handler response bodies; no automatic OPTIONS or CORS behavior is added.

Omitted declarations retain GET/HEAD. Unknown paths retain 404 for GET/HEAD and 405 with exactly `Allow: GET, HEAD` for other methods. The new tests confirm those expectations without requiring any changes. The first full suite did find a separate stale assertion that PUT was an invalid declaration in `routes-runtime.test.ts`; it now uses unsupported TRACE. The earlier router validation assertion was updated the same way before the RED run.

Runtime coverage checks every one of the 63 nonempty method subsets, with reversed declaration order and subsequent array mutation. Each subset receives every supported method, HEAD and unsupported TRACE. Tests assert exact Allow values, status/body handling, security headers, Unicode params shared between middleware and handler, and zero middleware/handler calls on wrong verbs. Additional tests cover default/unknown paths, explicit-only OPTIONS, actual stream cancellation for HEAD, and startup rejection of duplicates for every verb, explicit HEAD, unknown/lowercase/nonstring methods, holes, empty arrays and non-arrays. Compile-time assertions reject explicit HEAD and unknown declarations.

The exact generated manifest header now includes all six explicit methods. The parser still compares whole source text without executing it, recognizes current and historical GET/POST or omitted-method headers with each earlier context/middleware shape, and upgrades headers when adding a route. Tests exercise all nine combinations and still refuse edited headers. Registration continues to generate GET/HEAD defaults, with custom method entries requiring manual manifest edits. The generated local router adapter and server re-export expose `RouteMethod` alongside `Route`.

A real subprocess executes the generated app CLI wrapper twice to register routes, then the test manually declares DELETE/PATCH and edits the handlers. Loading the fixed manifest serves both verbs with decoded params. Every other verb returns exact single-method Allow, and each correct request reports handler call count 1 after all wrong-method requests, proving no handler side effects occurred. An unregistered throwing module remains undiscovered. The existing real listening-server CLI test remains socket-dependent and skipped in this environment; this subprocess registration and in-process serving test runs without sockets.

Validation:

- Focused suite: **33 pass, 1 socket-dependent skip, 0 fail**, 4479 assertions.
- `bun test`: **218 pass, 5 skips, 0 fail**, 9149 assertions across 223 tests. Three skips require listening sockets; two require opt-in live PostgreSQL/MariaDB servers. Output: `/tmp/bundle-route-methods-full.log`.
- `bun run typecheck` and `bun run node_modules/.bin/tsc --noEmit`: passed, including negative public method type assertions.
- `bun run graph:check` and `git diff --check`: passed.
- `BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-app-cached-An1sL4/demo/node_modules bun run scripts/verify-app.ts`: passed frontend/tooling/server typechecks, **31 generated-app tests**, production build, generated request inference, SQLite CLI migrations/seeds, model persistence and auth/Notes acceptance. The script copies the method contract through the generated local router adapter alongside context/params contracts. Dependencies were linked from an installed cache pointing to the current framework; this run does not verify fresh dependency installation. Output: `/tmp/bundle-route-methods-app.log`.

No commit or push was made. Existing workspace changes were preserved.
