# Generated auth limiter production gate

The generated process-local bucket resets on restart and does not coordinate workers or hosts. Production (`NODE_ENV=production` or `APP_ENV=production`) now rejects absent and process-scoped limiters during `createAuthHandlers(env, limiter?)` / `createRoutes(env, limiter?)`, before database or listener startup. The unchanged stock manifest intentionally fails in production. This gate does not establish production auth readiness.

The subsequent SQL adapter milestone now supplies an opt-in `createDatabaseAuthAttemptLimiter(env)` and singleton model in generated apps. App authors must migrate, review and explicitly inject it before deployment. See [SQL adapter evidence](auth-database-limiter-tdd.md). The gate milestone evidence below is historical. See the [generated app injection guide](../templates/app/README.md.tpl#limiter-injection-before-deployment). The interface's `scope: "shared"` is a reviewed application assertion, not proof of shared storage. A correct adapter must atomically account for register/login across workers and hosts, preserve active windows across app restarts, bound storage with expiration and fail closed on provider errors. The interface receives no credentials, request or untrusted client identity; additional per-client policy needs separate reviewed integration.

The narrow contract exposes readonly `scope: "process" | "shared"` and sync/async `consume()` returning `{ allowed: true }` or `{ allowed: false, retryAfterSeconds: number }`. Denials use finite positive seconds, rounded up for Retry-After, with 429/no-store. Origin is checked before consumption, then allowed attempts proceed to the existing credential parser and database logic. Exceptions/rejected promises stop processing and produce the router's generic 500. The frozen process implementation retains one bounded 20-attempt/minute bucket per handler set, shared by register/login; it uses no IP/header identity or maps. Development reset and bucket isolation behavior are tested.

The unused eager Auth handlers and auth middleware exports were removed so static imports can load factories/types before the reviewed adapter is injected in the manifest's final `routes` export. No environment-selected imports, adapter discovery, packages or provider code were added. Auth routes, Origin policy, sessions, password changes and Notes protections retain their behavior.

The framework manifest loader previously masked all thrown errors. A deliberately public `RouteConfigurationError` now carries the fixed limiter setup guidance through either route startup mode; other errors remain sanitized. Never put provider diagnostics, credentials or request data in this public error type.

## RED → GREEN

The first change added a generated-app test that calls production `createAuthHandlers` with a valid HTTPS Origin and invalid DB configuration, expecting the fixed actionable error. It ran before the implementation. `/tmp/limiter-red.log` records **0 pass, 1 fail**: the function did not throw and returned handlers. The fixture was generated from the modified templates with the current Bundle checkout linked for backend dependencies.

After implementation, the generated Auth suite passed **19 tests / 448 assertions** (`/tmp/limiter-green.log`). Additional cases cover absent/process limiter rejection for both production flags and both factories; missing Origin with a shared test double; invalid Origin configuration; async shared denial after Origin but before parsing/database work; provider failure; invalid retry delays; production Secure cookies with real CLI-migrated SQLite; and unchanged development fallback Origin, 20-attempt limit, reset and independent buckets. Shared objects in tests are explicitly test doubles, not deployable adapters.

A separate framework startup regression first failed because the public setup error was masked (`/tmp/limiter-startup-red.log`), then passed after preserving explicit configuration errors (`/tmp/limiter-startup-green.log`). Generated startup acceptance uses fresh child processes for both production flags. It statically imports a test double into the generated manifest only inside the test fixture, and spies on ORM initialization and listener creation. Missing/local limiters yield the exact fixed guidance with zero database/listener calls; explicit shared injection reaches listener creation with zero database initialization; missing production Origin still prevents startup (`/tmp/limiter-app-startup.log`).

## Verification

- `bun test`: **245 passed, 3 skipped, 0 failed** in 248 tests across 25 files. Skips are live PostgreSQL, live MariaDB, and the opt-in generated-dev socket integration.
- `bun run typecheck`, `bunx --no-install tsc --noEmit --strict`, `bun run graph:check`, and `git diff --check`: passed. The generated limiter startup tests also passed against real fresh child processes.
- Linked generated app: client/node/server strict TypeScript, **37 app tests**, Vite production builds, generated request inference, CLI-generated/applied SQLite migrations, seed/model persistence, migrated auth/password/session/Notes workflows and **2 resource tests / 78 assertions** passed.
- Rendered and real React DOM acceptance against migrated SQLite: **2 tests / 1,210 assertions** passed. React emitted `act(...)` warnings during async state checks.
- Real headless Firefox/HTTP acceptance passed. It exercised session listing/current-session refusal/per-session revocation, password validation and rotation, device revocation, login/register, Task create/list/PATCH-null/delete, owner isolation, Notes, refresh, HTTP-only cookies and logout. The app acceptance command exited successfully; its dev child exited with code 143 during expected cleanup.
- The DOM + Firefox run above reused linked dependencies and does not verify installation. A separate generated-app run performed a **fresh offline Bun install from the populated local package cache** (110 packages, no registry/network access), then passed typecheck, 37 tests, production builds, request inference, SQLite migrations/model persistence and resource API checks. Browser DOM and Firefox were not requested in that separate offline-install run. This verifies reproducibility from the existing cache, not an uncached registry/network install.

Reproduce linked acceptance (the dependency paths are host-specific):

```sh
BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-request-acceptance-s8UVwY/example/node_modules \
BUNDLE_ACCEPTANCE_DOM_MODULE=/root/.hermes/hermes-agent/node_modules/jsdom/lib/api.js \
BUNDLE_ACCEPTANCE_FIREFOX=1 \
bun run scripts/verify-app.ts
```

This reuses installed dependencies and does not verify fresh installation. Real Firefox requires an environment permitting loopback sockets. No new packages, commits or pushes were made; existing workspace changes were retained.
