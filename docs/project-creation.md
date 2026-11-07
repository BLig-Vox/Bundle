# Offline code-first application creation

```sh
bun run bundle new my-app
# Or select an existing destination parent explicitly:
bun run bundle new my-app --parent /absolute/path/to/existing-parent
bun run bundle new my-api --driver sqlite
bun run bundle new --interactive
```

`new` creates only a **new child directory**, defaulting to the current Bundle project root as parent, not an arbitrary implicit shell directory. The parent must already exist; `--parent` may be absolute or resolved relative to that project root. Names are lowercase ASCII letters/numbers/hyphens, start with a letter and contain 1–64 characters. Nested/absolute names and traversal are refused.

Existing files, empty/nonempty directories and dangling links refuse even with global `--force`. There is no overwrite, merge, update, automatic Git initialization or deletion of an existing project.

## Defaults and interactive choices

Defaults are SQLite, native Bun tests, a code-first `/health` route and a Vite + React frontend with shadcn/ui-compatible primitives. `--driver` selects `sqlite`, `postgresql` or `mariadb`. `--without-http` omits the example route/controller but keeps the independently useful frontend. `--interactive` uses the existing native text, database-selection and confirmation prompts for unspecified choices. Explicit name/driver/without-http options win. The generated frontend is not Laravel Blade/PHP and does not add authentication. Missing noninteractive names refuse; native valid-default behavior applies to optional choices.

A private mode0600 `.env` and matching `.env.example` contain only newly generated nonsecret application/database configuration, never a copy of the caller's `.env`. SQLite's default database is `.data/application.sqlite`, **not created during generation**. Server-driver selections do not provision a server/database, create credentials or verify a connection. Supply server credentials securely before explicit database operations.

## What is created

The source template contains an explicit immutable allowlist of shipped framework TypeScript modules, example User/Post mappings, initial per-driver migrations and explicit demo seeder. User/Post are **not authentication**. Private application commands/config/providers, existing stubs/routes, databases, caches, queues, mail, logs, graph artifacts, node_modules, repository metadata and tests from the caller's tree are not recursively copied.

The installer emits package scripts/dependency declarations, strict TypeScript configuration, CLI entrypoint, native ORM configuration, `.gitignore`, README and a real native Bun test. Generated apps also include Vite/React TSX entry/view files, a configured shadcn/ui-style button, Tailwind CSS, Vite proxy/build configuration and a `dev.ts` group for API plus frontend. The health route uses an executable module descriptor, so source routing and route caching consume the same generated controller. The actual HTTP worker serves GET/HEAD files from `dist/` on Linux through opened directory/file descriptors; the fallback is unavailable on non-Linux systems. Generated Vite HMR/readiness, combined API proxy and the `ui:build`→production-serving flow are still under verification.

Dependencies are declared, not installed or vendored; no dependency lockfile is fabricated. All declared MikroORM dependency versions must match. Only allowlisted package names and bounded ordinary version specifications are copied; registry/git URLs, arbitrary package scripts and credential-bearing specs are not copied. Existing generated projects are not automatically updated when Bundle changes.

## Explicit next operations

Creation is offline and **never starts a subprocess**: no package installation/download, migration, seeding, server, shell or application-source import occurs during publication. Outer `new` dispatch is independent of the current application's provider/package/command registries, so invalid unrelated app registries cannot execute or block creation. Other application commands retain their ordinary bootstrap. Standard Bun startup/preloads and explicitly supplied embedding callbacks remain trusted host behavior outside this guarantee; this is not a sandbox. After reviewing the new project, these are separate user-authorized operations:

```sh
cd my-app
bun install                 # Explicit dependency installation, not performed by new.
bun run typecheck
bun test
bun run bundle route:list --json
bun run bundle route:cache
bun run bundle migrate      # Review the selected database/migrations first.
bun run bundle db:seed      # Optional explicit demo data.
bun run bundle serve        # Loopback development listener; GET /health returns JSON.
```

Without the health route, define trusted code-first `routes.ts` before serving. This is not authentication/session setup, a production deployment/service manager, Laravel installer/PHP interoperability or a claim of live PostgreSQL/MariaDB support.

## Publication, bounds and cancellation

Before claiming the new destination, all selected source assets are snapshotted from the installer's own module root, without importing them. Source parents/final links are checked; sources must be regular single-link files, at most1MiB each and16MiB total including generated output. Descriptor identity/size/timestamp checks and bounded reads refuse changed or oversized assets. Missing/unsafe sources refuse before destination creation.

The destination is atomically claimed using exclusive directory creation, mode0700. Checked child directories request0700 and files use exclusive no-follow mode0600 creation. Parent aliases resolve canonically; existing destination contents are never merged. Cooperative cancellation is checked around awaits, before publication and before reporting success. Later I/O/cancellation can leave an incomplete new directory and earlier files; no automatic rollback deletion, transaction, power-loss persistence or hostile concurrent tree-replacement guarantee is supplied. Inspect partial outputs before deciding how to recover.

## Verification

Focused actual consumers execute the generated CLI, route listing/cache and an owned live HTTP health request; explicitly migrate/seed disposable SQLite; run the generated native Bun test and strict generated-project typecheck using dependencies already installed in this development workspace. No dependency installer or external database was run. Native scripted prompts exercise real text/select/confirmation behavior. Existing/dangling destinations, private-state exclusion, immutable snapshots, source missing/symlink/hardlink refusals and cancellation are tested. Generated-test path encoding and mismatched ORM dependency versions were reproduced red and repaired. Final independent review/full-suite/provenance results are recorded in the implementation plan and loop checkpoint.
