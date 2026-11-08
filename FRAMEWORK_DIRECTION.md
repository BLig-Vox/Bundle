# Bundle: End-to-End Framework Direction

## Product intent

Bundle is intended to grow from its current Bun + TypeScript backend/database CLI into a complete, end-to-end framework: a cohesive way to create, build, secure, test, deploy, and operate applications. Laravel is a breadth and polish benchmark—not a claim of compatibility or feature parity. Reach it through tested milestones; never imply unchecked checklist items are implemented.

The first full-stack path should scaffold a Bun + TypeScript application with a Vite-powered frontend and shadcn/ui preconfigured, plus Bundle's backend, routing, validation, data access, and CLI. Developers should be able to create dedicated pages and common app features with predictable generated files and idiomatic editable code.

## Current implementation status

Bundle now has a working `make:app` scaffold with Vite + React + TypeScript, Tailwind v4 and shadcn-style conventions (the shadcn CLI itself is not installed), Bundle's API/database CLI, local development supervisor, owner-scoped resource scaffolding, and a separate production entrypoint that serves built assets and fixed API routes together. The generated app has HTTP-only session auth, password/session management, typed validation, SQLite migrations, bounded authentication limiting, liveness/readiness endpoints, an editable React resource UI, and initial SQLite queue storage with statically registered schema validation and a one-shot `work:once` command (not a persistent worker or complete queue). `make:page`, `make:route`, `make:request`, `make:job`, `make:model`, `make:resource`, `inspect`, migration and database commands are implemented to varying scope. A fresh generated app has been installed, typechecked, tested, migrated and built; the integrated production server has been exercised over HTTP.

This is a substantial but incomplete foundation, not Laravel parity or production-auth certification. Production auth currently relies on SQLite for its shared limiter, and recovery, email verification, MFA, queue/scheduler, mail, storage, cache, broader deployment and operations features remain gaps or require separate verification. Treat later sections as historical milestone notes where they conflict with this current status; maintain the shipped-vs-roadmap distinction.

## Progress estimate

**Directional estimate: approximately 12% toward Laravel-level breadth and completeness.** This is a rough planning judgment, not a measured feature-parity score or a production-readiness rating; Bundle does not yet have a weighted, source-linked parity matrix. The estimate reflects a working end-to-end foundation across app scaffolding, backend routing and validation, ORM/migrations, generated auth/resources, production static-plus-API serving, and basic SQLite queue dispatch. Most framework breadth remains absent or partial, including mature authorization, mail, file storage, cache, events/broadcasting, supervised queue and scheduler operations, deployment/observability/backups/upgrades, multi-driver runtime verification, package/versioning maturity, and additional auth flows. Revisit only when verified capability materially changes; replace this estimate with a weighted feature matrix before treating it as a metric.

## Design principles

- Secure defaults: explicit trust boundaries, safe-by-default configuration, validated inputs, least privilege, safe secrets handling, and security tests. Document tradeoffs and escape hatches; do not promise absolute security.
- AI/vibe-coding friendly: discoverable commands, concise structured output (human and machine-readable), stable schemas, actionable errors, generated project context, and commands that reduce repetitive tool calls and token-heavy exploration.
- Human-readable generated code: generators produce normal TypeScript files that developers own and can edit; avoid opaque runtime magic and hidden mutation.
- End-to-end coherence: scaffold, local development, frontend/backend integration, database, tests, build, deployment, diagnostics, and upgrades should work together.
- Incremental and verified: distinguish shipped capability from roadmap, build vertical slices, and add acceptance tests for every capability.

## Implemented narrow slice

`bun run bundle make:page Dashboard` now generates only `src/pages/Dashboard.ts`: a standalone, editable TypeScript module exporting `PageProps` and `render({ title?, heading? } = {})`. It returns a complete server-renderable HTML document and escapes ampersands, angle brackets, quotes, and apostrophes in dynamic text. There is no JSX/TSX, UI framework, Vite, shadcn, or integrated frontend in this slice; explicit static route registration is supported separately. A minimal built-in Bun server now serves the fixed Home page as described below.

The command validates ASCII PascalCase names, rejects paths and reserved device names, refuses symlinked source/page directories, and atomically publishes complete files exclusively without overwriting any existing entry, including under concurrent generation. It uses a same-filesystem temporary file and hard link; hard-link support and trusted parent directories are required. JSON success output and concise nonzero errors follow the existing CLI conventions. `src/cli/pages.test.ts` tests generation/rendering, escaping, invalid/traversal names, duplicate/force protection, concurrency, symlinks, and the actual CLI entry point. See README for usage and limits. This does not complete the full-stack acceptance bar below.

`bun run bundle serve` is the next implemented vertical slice: Bun.serve, loopback by default, validated numeric address/port options, one trusted `src/pages/Home.ts` imported and rendered once at startup, and GET/HEAD `/`. Missing Home/unknown paths return 404; unsupported methods return 405; page failures return generic 500. Security headers apply to success and errors. Requests never select filesystem code. Symlinked entry paths are refused; trusted workspace code, imports, and parent directories remain the explicit trust boundary. There is no additional dependency, framework, TSX, asset serving, general routing, or production deployment support. Static route scaffolding now integrates through the project-owned `src/web/routes.ts` manifest and `serve --mode routes`; default serve uses the manifest when present, otherwise the legacy Home preview. `--mode pages` explicitly selects that preview. Registration snippets are printed for manual edits; no manifest mutation or route discovery occurs. Paths remain exact and GET/HEAD only. Manifest code and its imports are trusted executable application code. See README for root isolation, startup failure behavior, and current limits.

The framework-local bounded JSON parsing slice adds `readJson` (`src/web/request.ts`) and typed public `HttpError` (`src/web/http-error.ts`). Parsing requires application/json with optional UTF-8 charset, defaults to 64 KiB, checks declared length and actual streamed bytes, cancels oversized bodies, and returns unknown JSON for application shape validation. Safe errors distinguish empty/malformed JSON (400), oversize (413), and unsupported media type (415); the router preserves only these typed statuses and keeps unexpected failures generic. GET/HEAD restrictions and security headers remain in place. This does not ship into generated app templates or add methods, schema validation, or database behavior. Tests were written and demonstrated failing before implementation; see `src/web/request.test.ts` and `src/web/router.test.ts`.

Tests were added first and demonstrated red (missing runtime and unknown `serve`), then implemented. Direct-handler tests cover page generation/rendering, missing/unknown paths, methods, errors, headers, address validation, and symlink rejection. Real listener tests use port zero where permitted; EPERM-only skips must be reported separately from passing HTTP behavior. See README for usage and limitations.

## Initial integrated user journey (partially implemented)

1. `bun run bundle make:app my-app` creates the Vite + React + TypeScript app, shadcn-style UI conventions, Bundle backend/database CLI and local dev workflow. The package is linked to the generating Bundle checkout; it is not yet a published package.
2. `make:page` creates an independent server-rendered TypeScript page. `make:resource` generates an owner-scoped REST resource and editable React CRUD page. These are complementary workflows, not a unified page/route system.
3. Typed routes, middleware, bounded validation, models/migrations, sessions/auth and generated tests are available in the current scaffold. Search, live database portability checks and additional application features remain incomplete.
4. `bun run dev`, generated-app tests/build, and `bun run start:production` provide development, verification and production-start paths. The production entrypoint is fail-closed and serves built assets plus API routes, but deployment, TLS termination, observability and recovery remain operator responsibilities.

Do not treat this journey as a complete framework contract. Keep every feature's supported behavior and limitations explicit.

## Phased roadmap proposal

1. **Product contract and architecture** — define target users, supported app shape, runtime support, package strategy, security model, CLI UX/output schemas, and first acceptance journey. Reconcile current repository instructions that prohibit web/UI frameworks/TSX with the requested Vite + shadcn direction before implementation.
2. **First full-stack vertical slice** — app creation, Vite + TypeScript + shadcn setup, Bundle server, one generated page, typed API route, local dev, production build, and end-to-end tests.
3. **Core framework** — routing, middleware, request/response, validation, configuration, logging, errors, environment/secrets handling, service/container patterns where justified, and test utilities.
4. **Data and application foundations** — mature existing ORM/migrations/CLI; add safe auth/session/authorization and file handling with explicit threat models and tests.
5. **Developer and AI workflow** — stable machine output, compact status/inspect/context commands, dry-run/plans for risky operations, project instructions/context generation, safe code generators and upgrade checks.
6. **Production operations** — build/deploy adapters, health/readiness, observability, backups, migrations/rollback guidance, security policy, dependency and supply-chain checks, versioning and support policy.
7. **Breadth and parity tracking** — maintain a source-linked feature matrix against Laravel and other relevant frameworks; implement based on user value, not checkbox count. Mark each item implemented, partial, planned, deferred, or intentionally different, with tests/evidence.

## Acceptance bar

No framework milestone is complete based on scaffolding alone. Verify a fresh generated application can install, run locally, render its generated page, call its backend, persist data, run tests, and build for production. Verify generated files are editable, re-running commands does not silently overwrite, CLI output is concise and machine-readable where requested, and security-sensitive behavior has negative tests. Report exact commands and results; record unsupported platforms and known gaps.

## Immediate next step

The queue has bounded SQLite persistence, static registry snapshots, schema-validated dispatch, one-shot processing and a `make:job` skeleton generator. `make:job` prints explicit import/entry snippets instead of mutating a user registry; it must be implemented and registered before dispatch. The next high-value steps are safe, opt-in registry updates from the CLI and a continuously polling worker with graceful shutdown/heartbeat, then failed-job inspection/replay/pruning. This remains incomplete and SQLite-only; do not call it production-ready or Laravel parity.
