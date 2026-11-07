# Offline code-first application creation

> **Superseding direction (2026-11-07):** A later explicit user request changes the generated frontend from no-markup/code-only to Vite + React TSX with Fast Refresh/HMR and preconfigured shadcn/ui-compatible components, while retaining the Bun/TypeScript/MikroORM backend and native HTTP controllers/routes. This supersedes only the frontend exclusions below. Project creation remains offline: dependencies are declared but never installed during `new`; generated-app HMR/build, combined API+web `/api` proxy, and production build serving are runtime-verified on Linux. Non-Linux production static serving remains unavailable.

## Binding scope

Add `bundle new [name] [--parent directory] [--driver sqlite|postgresql|mariadb] [--without-http] [--interactive]` and a reusable createProject API. Defaults are SQLite, native Bun tests and a code-first health route. Interactive mode uses existing native prompts for missing name, database choice and optional health route; explicit options win. Only Bun testing is offered. No starter-kit/markup/auth/session/vendor-service claim.

Creation is offline and never runs a subprocess, package installer, migration, seeder, server or application module. Dependency installation is a subsequent explicit user operation, not a fake successful --install option. PostgreSQL/MariaDB choices configure implemented driver paths but do not provision or prove live servers. SQLite creation itself must not create a database. No credentials are generated, read from an existing .env or printed.

## Template

Use an explicit immutable allowlist of framework TypeScript modules shipped beside the installer, not a recursive copy of the caller's project. Exclude tests, application commands/config/providers, existing .env files, caches, queues, logs, databases, graph artifacts, repository metadata and build output. Include code-only bundled example User/Post mappings and initial per-driver migrations, explicitly not authentication; seeding is opt-in. Generate minimal package scripts/dependency declarations, tsconfig, native ORM config, entrypoint, .env.example, .gitignore, README and a consumed native Bun smoke test. Optional health route uses explicit executable references, so route:list/cache and real HTTP can consume it. No XML/HTML/JSX/framework download.

## Publication and ownership

Name is a bounded lowercase ASCII package/directory component, no paths/traversal. Parent must exist, resolve canonically and be a directory. Refuse every existing destination (including empty dirs and dangling links) even with global force. Snapshot and validate the complete bounded template sources and planned outputs before creating the destination. Sources must be safe bounded regular single-link files, with symlink parents/final links rejected and descriptor identity checks. Never import a source asset.

Atomically claim the NEW destination with mkdir0700; create checked child directories0700 and files exclusively/no-follow0600. Check cancellation before work, around awaits and before each publication; report no success after cancellation. Later I/O/cancellation/races can leave earlier new files; do not remove user paths on failure or claim a directory transaction/power-loss/hostile-concurrent-tree guarantee. Never modify the existing parent project beyond the requested new child.

## Required consumers

Observe missing new command red first. Test default/explicit/interactive options, snapshots/validation, existing destination byte preservation, symlink/dangling conflicts, preabort, no .env/credentials/state copying and no database during generation. Run actual generated entrypoint list/route:list/route cache and actual health HTTP, explicit SQLite migrate/seed, generated native Bun test and strict generated-project typecheck using the already installed dependencies (no install/download). Verify interactive setup through the existing real native-prompt harness, not mocked answers. Broader server/installer tooling remains separately unverified.
