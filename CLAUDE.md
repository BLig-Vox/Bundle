# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project direction

The intended product direction is a complete, secure-by-default, AI-friendly full-stack framework. The first proposed app workflow includes a Vite + TypeScript frontend with shadcn/ui configured, integrated with Bundle's Bun backend and CLI. The database tools, plain TypeScript `make:page` generator, and static manifest Bun web runtime are implemented; the integrated workflow remains proposed. See `FRAMEWORK_DIRECTION.md` for milestones and acceptance criteria.

Use a code-driven approach for framework internals: Bun, TypeScript, MikroORM classes and `EntitySchema`, without decorators or a separate schema DSL. **Generated frontend templates are explicitly authorized to use React JSX/TSX, HTML entry documents, CSS, Vite and shadcn/ui conventions**, as approved product scope. Their integration tests may compile/render those assets. This reconciles and replaces the prior blanket restriction on HTML-like syntax for this workflow. Do not introduce XML/AXAML/XAML or unrelated markup frameworks into framework internals. The legacy `make:page` server-rendered TypeScript contract remains independent of React.

## Development commands

- `bun install` — Install dependencies from `package.json` and `bun.lock`.
- `bun run start` — Run the Bundle CLI (`index.ts`); no arguments prints the command list.
- `bun run dev` — Run the CLI in watch mode, restarting on changes.
- `bun run bundle <command>` — Run database commands or page scaffolding; `list` shows available commands.
- `bun run bundle make:page Dashboard` — Exclusively generate `src/pages/Dashboard.ts`, with an escaped server-renderable `render` function; no route/server registration.
- `bun run bundle serve` — Load this root's fixed static route manifest, falling back to Home preview only if absent. `--mode routes` selects manifest only; `--mode pages` selects Home only. Default `127.0.0.1:3000`; numeric `--host` and decimal `--port` (including 0) only.
- `bun run bundle migrate` / `bun run bundle db:seed` — Apply migrations / explicitly seed the selected database.
- `bun run orm <command>` — Run the matching native MikroORM CLI (development dependency). Its advanced commands bypass Bundle's safety guards.
- `bun run typecheck` — Run `bun check` with the strict TypeScript configuration.

- `bun test` — Run the Bun test suite.
- `bun test ./src/graph/corpus.test.ts` — Run only the corpus tests; add `--test-name-pattern 'name'` to filter tests.
- `bun run graph:build` — Regenerate all JSON corpus artifacts from `PROGRESS.md`.
- `bun run graph:check` — Verify generated JSON matches the source and generator, without writing files.

No application build pipeline or linter is configured yet.

## Architecture and feature reference

The project uses Bun to execute TypeScript directly with ES modules. `index.ts` dispatches to the Commander-based CLI in `src/cli/program.ts`; migration command registration and orchestration live in `src/cli/migrations.ts`. `tsconfig.json` enables strict checking and does not emit compiled files.

### Page scaffolding

Page scaffolding lives in `src/cli/pages.ts`; its CLI/security tests are `src/cli/pages.test.ts`. It validates ASCII PascalCase names, refuses symlinked source/page directories, stages complete files, and publishes with an exclusive hard link (never overwrites, including with `--force`). Generated modules have no imports or JSX/TSX; dynamic title/heading text escapes all five HTML-sensitive characters. The generator does not register routes. The runtime below provides explicit static registration and a Home preview. Parent directories must be trusted against concurrent hostile replacement; the filesystem must support hard links.

### Minimal built-in web runtime

`src/web/server.ts` exports address validation, page/route/server handler factories, and `startServer`. `serve` lazily imports it and uses Bun.serve with development error pages disabled. Default startup loads only `<root>/src/web/routes.ts` when present, otherwise previews `<root>/src/pages/Home.ts`. Explicit `--mode routes` never loads Home or a framework manifest as fallback; absent manifest is an empty table. `--mode pages` loads only Home and snapshots its rendered string. Entry directories/files must be real, regular entries without symlinks. Parent directories remain trusted against races and hard links.

`src/web/routes.ts` is project-owned code with static imports and a `routes` array. `src/web/router.ts` snapshots exact static paths and dispatches handlers on GET/HEAD. Requests never select filesystem paths/imports; do not add filesystem discovery. `make:route` exclusively publishes a handler and prints exact import/entry registration snippets. Opt-in `--register [--path /canonical/path]` creates or extends only an exact Bundle-generated typed static manifest, with lower-kebab defaults and idempotent retries. Arbitrary source fails closed with snippets, leaving both files untouched. Registration stages both files, uses an exclusive cooperative lock and hard links, and rolls back caught publication failures with exact content/identity guards. It is not a crash-safe or reader-atomic two-file transaction; trusted writers and hard-link support are required. See `src/cli/route-registration.test.ts` for failure injection and preservation cases. Manifest/import/registration failures refuse startup. Manifest code and transitive imports execute with process privileges, are not sandboxed, and use normal Bun caching; restart after edits.

Other methods return 405 with Allow even on unknown paths; missing paths return 404; HEAD is bodyless. Known `HttpError` instances (`src/web/http-error.ts`) with status 400/413/415 preserve their deliberately public message; other handler/page failures become generic 500 responses. `src/web/request.ts` exports `readJson(request, { maxBytes })`, returning unknown JSON with a 64 KiB default, strict JSON/UTF-8 media type, declared-size preflight, actual streaming byte enforcement and cancellation on overflow. It emits safe 400/413/415 errors and does not validate value shapes. Generated app templates do not include this helper. All responses enforce nosniff, no-store, no-referrer, frame denial, and restrictive CSP. Preserve application headers/status otherwise. There are no parameterized routes, POST APIs, assets, hot reload, TLS, auth, sessions, request validation layer, or production deployment support. Route handlers receive the original Request; page preview receives no request props.

Use strict TDD for runtime changes: demonstrate failing tests before implementation. Run `bun test ./src/web/server.test.ts ./src/cli/serve.test.ts ./src/cli/pages.test.ts`, full `bun test`, typecheck, graph check, and CLI help. Keep real Bun.serve tests on loopback port 0; skip only proven EPERM socket restrictions and report them. Direct handler tests must still execute all behavior checks. This environment forbids listening, so a passing handler suite alone does not verify real HTTP sockets.

### Database layer

`src/database/config.ts` is the shared configuration source for Bundle and `mikro-orm.config.ts`. `DB_CONNECTION` selects `sqlite` (default), `postgresql`, or `mariadb`. SQLite paths resolve against the project root, defaulting to gitignored `.data/bundle.sqlite`. Server databases must be provisioned separately; see `.env.example` and `docs/database.md`.

`src/database/connection.ts` initializes MikroORM, creates local SQLite parent directories when needed, and closes connections after CLI operations. MikroORM 7 initializes metadata lazily without connecting; `openDatabase` explicitly connects by default. Use `orm.em.fork()` per operation/request or the transaction callback manager; do not share a global entity manager.

Models in `src/models/*.ts` are auto-discovered; each file exports a class and its default `EntitySchema`. The example User/Post relationship is not authentication. Model/seeder generators refuse overwrites. `database/seeders/DatabaseSeeder.ts` is explicit, repeatable demo seeding; upserts supply timestamps because they bypass constructor defaults.

Migrations and snapshots are isolated under `database/migrations/{sqlite,postgresql,mariadb}` because SQL is dialect-specific. Keep generated migrations and snapshots in version control. `SafeMigrationGenerator` exclusively creates files: filename collisions fail without overwriting code or advancing snapshots. All MikroORM packages must stay on the same version. Actual rollback/reset/refresh/fresh/unlock require `--force`; production migrations/generation/seeding/install/status/check/dumps also require it because migration inspection can initialize storage. SQL-only `--pretend` bypasses write guards and rejects `--isolated`. Native ORM commands bypass these guards. MariaDB DDL is not guaranteed transactional. `migrate:fresh` refuses unmapped tables/views and, when migrations have been executed, pending migrations or unreconciled entity changes; it drops only mapped tables/history and reopens the connection before replay. `migrate:check` compares entity metadata to the migration snapshot when available, not a full live drift audit.

Server connection URLs reject unsupported/repeated query options instead of silently discarding them. `sslmode=require` and `verify-full` both enable certificate-verified TLS; `disable` disables it. PostgreSQL also accepts `schema`. Other native driver options belong in `src/database/config.ts`. Generated model names must not shadow built-in scalar types such as `Date`.

`src/database/migrator.ts` extends native history with batch tracking; preexisting rows are assigned batch 1. Configuration lists native `Migrator` before `BundleMigrator` to prevent MikroORM v7 auto-loading the native extension afterward and overriding the subclass. Bundle rollback defaults to the latest batch; native ORM `down` still defaults to one migration. `--step` application uses one batch per migration. `migration-tools.ts` provides read-only history/planning, restricted SQL previews, and a database-backed isolation lock. Lock table `bundle_migration_lock` is excluded from model diffs. Locks have no unsafe automatic expiry; stale removal requires `migrate:unlock --force`.

`targets.ts` resolves `--database` from complete `BUNDLE_CONNECTIONS` JSON environment records (or built-in driver names), and validates a single `--path` directory; external/absolute paths require `--realpath`. `schema-dump.ts` dumps live schema plus history (not application rows), restores only empty targets, preserves locks, and safely prunes eligible applied migration files with explicit force. SQLite is handled directly; server adapters require native client tools. `migrate` can bootstrap an empty database from its per-driver/per-named-connection SQL dump before applying newer migrations. See `docs/migrations.md` for the full option contract and limitations. Blank/create/table stubs do not advance model snapshots; initial model-diff generation refuses pending migrations without a snapshot.

Database tests: `bun test ./src/database/database.test.ts`; CLI tests: `bun test ./src/cli/program.test.ts` and `bun test ./src/cli/migrations.test.ts`; dump and target tests are alongside their modules. SQLite tests use disposable fixtures under `.data/`. MariaDB/PostgreSQL live tests are opt-in via `BUNDLE_TEST_MARIADB_URL` / `BUNDLE_TEST_POSTGRESQL_URL` plus `BUNDLE_TEST_ALLOW_RESET=1`; databases must be empty and disposable. Skipped server tests do not establish live support. Dialect SQL generation is tested separately without servers.

### Checklist corpus

`PROGRESS.md` is the source of truth for the Laravel CLI capability checklist. Laravel is not installed, and unchecked items are not implemented features. `src/graph/corpus.ts` is a pure checklist parser and knowledge-graph builder; `scripts/build-graph.ts` handles generation and freshness checks. It never executes example commands or downloads external documentation.

`graph/` holds five generated JSON artifacts: the lossless source corpus, command index, source links, nodes/edges, and manifest. Edit `PROGRESS.md` and regenerate rather than changing generated JSON. Outputs are deterministic, use repository-relative source locations, and retain checkbox state without claiming implementation. Tests check coverage, provenance, graph integrity, and artifact freshness. `graph/README.md` describes the record and relationship formats; `README.md` documents setup and runnable commands.

Use the project-local `/progress-graph` skill (`.claude/skills/progress-graph/SKILL.md`) for corpus synchronization, validation, inspection, or generator updates. Its `sync`, `check`, and `inspect` modes distinguish regeneration from read-only work.

No Cursor rules or GitHub Copilot instructions are present. Update this file as application architecture and tooling are introduced.

## GitHub destination

The configured `origin` is `https://github.com/BLig-Vox/Bundle.git`. This project belongs to the `BLig-Vox` organization, not the user's personal account. Unlike the initial state described in the parent directory's `CLAUDE.md`, this directory is now a Git repository with a configured remote.
