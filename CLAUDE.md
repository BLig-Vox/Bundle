# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project direction

Use a code-driven approach. Do not introduce XML, AXAML/XAML, HTML-like UI syntax (including JSX/TSX), or markup-based UI frameworks. The project uses Bun and TypeScript with MikroORM for database persistence; no web or UI framework has been selected. Entity mappings use TypeScript classes and `EntitySchema`, not decorators or a separate schema DSL.

## Development commands

- `bun install` — Install dependencies from `package.json` and `bun.lock`.
- `bun run start` — Run the Bundle CLI (`index.ts`); no arguments prints the command list.
- `bun run dev` — Run the CLI in watch mode, restarting on changes.
- `bun run bundle <command>` — Run Laravel-inspired database commands; `list` shows available commands.
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
