# Single-segment route parameters: test-first evidence

Before implementation, the following focused run recorded **16 pass, 1 socket-dependent skip, 5 fail**:

```sh
bun test src/web/route-params.test.ts src/cli/route-registration.test.ts src/cli/routes.test.ts
```

The new runtime tests failed with `Route paths must be static absolute paths without parameters or traversal.` The CLI parameter-registration test failed with the old canonical-static-path validator. The structural-duplicate assertion expected a duplicate/conflict error but received the old parameter prohibition. Evidence was captured in `/tmp/bundle-route-params-red.log` before changing implementation.

The implementation shares one path grammar between the router and CLI. It accepts static segments and `:name` identifiers matching `[A-Za-z_][A-Za-z0-9_]*`, rejects repeated names and structural duplicates regardless of method declarations, and refuses overlapping patterns with incomparable static specificity. Compilation, conflict checks, handler/middleware snapshots, and specificity ordering occur at startup. Exact static lookup takes priority, including its method policy. The request matcher uses the compiled in-memory table and never constructs filesystem paths or imports.

Each dispatch creates a context with a frozen null-prototype params map. Middleware and handler share the context and map; concurrent and repeated dispatches have distinct maps. Captures decode once, reject malformed escapes/UTF-8, slash/backslash, NUL/C0/C1 controls, empty captures, and more than 1024 decoded UTF-8 bytes. A raw bound of 3072 characters limits predecode work. Invalid captures return generic secure 400 before middleware or method dispatch; HEAD suppresses the error body. Dot segments are rejected if they reach captures; the URL parser can normalize dot segments before routing, so already-normalized requests follow ordinary routing policy. Double-encoded values remain literal data after the one decode.

Coverage includes GET/POST/HEAD, encoded Unicode and byte boundaries, malformed inputs and traversal attempts, static and partial-static precedence in both registration orders, method-specific Allow without fallback, 404/405 and static exactness, context sharing/immutability/isolation, prototype-sensitive identifiers, malformed patterns, structural duplicates and ambiguous overlaps. CLI tests prove structural conflicts cause no handler/manifest publication and that edited/expression-bearing manifests still fail closed. Existing exact legacy v1 header variants remain registrable; generated manifest formatting and static behavior are unchanged.

A real subprocess runs the generated app CLI wrapper to generate/register a parameter route, then loads its unchanged lexical manifest through `createRouteHandler` and serves Unicode params, one-decode values, safe errors and unknown routes without discovering an unregistered module. The existing socket CLI test now also registers and requests a parameter route; it remains skipped here because listening sockets are denied. The migration test's copied CLI fixture now includes `src/web` for the new shared grammar dependency. Its first full-suite run exposed that omitted dependency; the old invalid-manifest test also needed to reject `/:id?` instead of the newly valid `/:id`.

Validation:

- `bun test`: **212 pass, 5 skips, 0 fail**, 5421 assertions across 217 tests. Skips: three listening-socket checks and two opt-in live database checks.
- `bun run typecheck` and `bun run node_modules/.bin/tsc --noEmit`: passed, including params immutability type assertions.
- `bun run graph:check` and `git diff --check`: passed.
- `BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-app-cached-An1sL4/demo/node_modules bun run scripts/verify-app.ts`: passed frontend/tooling/server typechecks, **27 generated-app tests**, production build, generated-request inference, SQLite migrations/model persistence and unchanged-manifest auth/Notes acceptance. The script now copies parameter compile/runtime tests through the generated local router adapter alongside context tests. Dependencies were linked from an installed cache; this run does not claim a fresh dependency installation.

No commit or push was made. Pre-existing workspace changes were retained.
