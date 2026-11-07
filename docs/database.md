# Database ORM and CLI

Bundle uses **MikroORM 7** with Bun and TypeScript. Models and mapping configuration are written in code with `EntitySchema`, without decorators or a separate schema language. This is MikroORM's Data Mapper API, not an Eloquent/Active Record implementation.

## Quick start: SQLite

No account, database server, or npm login is required for the default SQLite setup:

```bash
bun install
bun run bundle list
bun run bundle migrate
bun run bundle db:seed
bun run bundle db:check
bun run bundle db:show
bun run bundle db:table users
```

The database is created at `.data/bundle.sqlite`; local database files are gitignored. The initial migration creates the example `users` and `posts` tables with a relationship, unique constraints, and timestamps. `User` is a persistence example, not an authentication system.

Seeding is **explicit**, not automatic. `DatabaseSeeder` upserts one demo author and post using stable unique keys, so rerunning it does not duplicate rows. It may update the demo rows; it is not production application data.

`bundle db` is an explicit interactive launch, not a migration or provisioning command. It requires an existing regular single-link SQLite file and a discoverable `sqlite3` executable. The client receives a fixed argv (URI `mode=rw` and `nofollow=1`) and a minimal shell environment that omits Bundle database credentials. Terminal Ctrl+C is left to the interactive client so it can interrupt a query without necessarily closing the shell; embedding abort and SIGTERM remain cancellation paths. Database files must not be concurrently replaced while the client is starting or running; an external executable cannot bind its path lookup atomically to Bundle's preflight. No client is installed automatically. PostgreSQL and MariaDB shells remain unsupported until separate credential-safe adapters are implemented.

## Database selection

Bun automatically loads `.env`. Copy `.env.example` to `.env` if you want local overrides. Paths are resolved against the repository root, not the shell's working directory.

### SQLite

```dotenv
DB_CONNECTION=sqlite
DB_DATABASE=.data/bundle.sqlite
```

### PostgreSQL

```dotenv
DB_CONNECTION=postgresql
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=bundle
DB_USERNAME=bundle
DB_PASSWORD=your-local-password
```

### MariaDB

```dotenv
DB_CONNECTION=mariadb
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=bundle
DB_USERNAME=bundle
DB_PASSWORD=your-local-password
```

Provision the server database and account first. Bundle does not provision server instances or database users. Use an account with the permissions required for the requested operation, including DDL for migrations.

For server databases, `DATABASE_URL` replaces individual connection fields, including the port (the dialect default applies when the URL omits it). Set `DB_CONNECTION` explicitly to match the URL protocol, include the database name, and URL-encode credentials. PostgreSQL accepts `postgres:` or `postgresql:`; MariaDB accepts `mariadb:` or `mysql:`.

Supported URL query options:

- `sslmode=require` or `sslmode=verify-full`: enable TLS with certificate verification (`rejectUnauthorized: true`). Bundle deliberately gives `require` the same stricter verification behavior as `verify-full`; configure a trusted CA through native driver options if your provider requires one.
- `sslmode=disable`: explicitly disable TLS.
- `schema=<name>`: PostgreSQL only.

Omitting `sslmode` leaves the native driver's default behavior unchanged. Unknown, repeated, empty TLS, or unsupported TLS-mode options are rejected rather than silently ignored. Configure other provider-specific connection/TLS options in `src/database/config.ts` using MikroORM's driver options.

## Available commands

Prefix each command with `bun run bundle`. `bun run start` invokes the same CLI; no arguments prints the command list.

| Command | Behavior |
| --- | --- |
| `list` | Show commands and help |
| `about` | Show selected configuration without connecting or printing credentials |
| `db` | Open an existing SQLite file with `sqlite3`; does not create missing files, and PostgreSQL/MariaDB clients are unsupported |
| `db:check` | Check the selected database connection |
| `db:show` | Inspect tables and their columns |
| `db:table <name>` | Inspect a table; use `schema.name` when ambiguous |
| `migrate [--seed]` | Apply pending migrations, optionally followed by the default seeder |
| `migrate:install` | Install/upgrade migration history without applying model migrations |
| `migrate:uninstall [--pretend]` | Inspect or force-remove verified existing SQLite tracking only; preserve app tables and refuse dependencies/active locks. See [tracking uninstall](history-uninstall.md) |
| `migrate:status [--pending]` | List executed/pending migrations and batch numbers |
| `migrate:unlock --force` | Remove a stale isolation lock after verifying no migration is active |
| `migrate:check` | Check whether mapped entity changes need a migration; nonzero exit if changes are found |
| `migrate:rollback --force` | Roll back the latest **batch**; `--step N` selects individual migrations and `--batch N` selects a batch |
| `migrate:reset --force` | Roll back all migrations |
| `migrate:refresh [--seed] --force` | Roll back all migrations and apply them again |
| `migrate:fresh [--seed] --force` | Rebuild mapped tables and migration history; refuses unmapped tables/views or unreconciled migration/entity changes |
| `make:migration [name] [--blank]` | Generate a schema-diff migration or an empty migration |
| `make:cache-table` | Generate migration SQL for cache entries and locks; this is schema only, not a database-backed cache runtime |
| `make:session-table` | Generate a session schema migration; no HTTP session or authentication runtime is included |
| `db:seed [class]` | Run a named seeder, defaulting to `DatabaseSeeder` |
| `make:seeder <name>` | Generate a seeder class; the name must end with `Seeder` |
| `make:model <name> [-mfs]` | Generate a model/schema; optionally compose native migration, factory and seeder with selected code-output preflight |
| `model:show [name]` | Inspect entity mappings without connecting |
| `model:prune [--pretend]` | Count explicit `pruning.ts` rules or require `--force` for bounded native bulk deletion against an existing target; see [model pruning](model-pruning.md) |
| `schema:sql` | Print CREATE SQL for mapped entities; **not** a live schema/data backup |
| `schema:dump [--prune]` | Save the live schema plus migration history, without application rows; pruning requires `--force` |

`make:cache-table` generates a reviewable migration for `bundle_cache_entries` and `bundle_cache_locks`, including composite namespace/key primary keys and expiration indexes. It renders SQLite, PostgreSQL, or MariaDB SQL and uses the selected migration target without connecting to or creating the database during generation. SQLite migration application and key uniqueness are tested; the other dialects have renderer tests only. This is a schema foundation, not a runtime: the existing `LocalCache` still stores data in its separate `.bundle-cache/cache.sqlite` file and does not read or write these tables. Bundle model-diff generation skips these explicitly generated infrastructure tables so later `make:migration` runs cannot drop them; `migrate:fresh` continues to refuse them as unmapped tables rather than risk deleting their data.

`make:session-table` generates a `sessions` table with a primary-key id, optional user id, IP address/user-agent fields, payload and last-activity timestamp plus lookup indexes. It renders SQLite, PostgreSQL, or MariaDB SQL, uses the selected migration target, and does not connect or create a database during generation. SQLite application, model-diff exclusion, rollback preservation and conservative fresh refusal are tested; other dialects have renderer-only coverage. This is schema only: no session cookie, expiration, authentication or HTTP session-store behavior is implemented.

See [native ORM generators](native-orm-generators.md) for consumed `make:factory --model`, `make:cast`, `make:scope` and `make:observer` examples with explicit attributes/mappings/helper calls/subscriber registration; generation never connects to a database. See [the migration guide](migrations.md) for the full option matrix, batch semantics, SQL previews, isolation, named connections, path selection, and schema-dump requirements. `make:model Product -mfs` composes model, migration, `ProductFactory` and `ProductSeeder`; `-f/--factory` and `-s/--seed` also work independently without opening the DB. All selected code sources, custom factory tokens/syntax, destinations and existing ancestor types are preflighted before creating code outputs; predictable conflicts or unsafe parents preserve the other outputs. Native migration baseline/production guards still apply with `-m`. Later I/O or migration failure may leave earlier new code files; this is not a whole-operation transaction. It never edits an existing model.

Use `--help` on any command. Structured command results are printed as JSON; help and `schema:sql` are text. Failures return a nonzero exit status. Bundle suppresses ORM query logging and redacts known database credentials from its error messages.

### Safety and migration differences

- Rollback, reset, refresh, and fresh operations require `--force` in every environment because they can remove data. The flag is explicit authorization, not a guarantee that an operation is safe.
- With `NODE_ENV=production` or `APP_ENV=production`, migration application, migration generation, seeding, `migrate:status`, and `migrate:check` also require `--force`.
- Migration status/check operations can initialize migration storage; do not assume they are strictly read-only.
- `migrate:fresh` is for a dedicated database. It refuses unmapped tables or views, including historical tables left by entity renames/removals. If migrations have been executed, it also refuses pending migrations or entity changes needing a migration. Reconcile/apply those changes first; no data/history is dropped when these preflight checks refuse the reset.
- `migrate:check` checks the entity schema against MikroORM's migration snapshot when one exists. Use `migrate:status` separately to see unapplied migrations; this is not a general live-database drift audit.
- MariaDB DDL can implicitly commit. A failed schema migration is not guaranteed to roll back atomically; its migration batch is configured without an all-or-nothing transaction.
- Review generated SQL, implement/review rollback behavior, and back up real data before destructive operations.
- No connection pools are left open by a completed Bundle database command.

## Model and migration workflow

```bash
bun run bundle make:model Product
# Edit src/models/Product.ts: add class properties and EntitySchema mappings.
bun run bundle make:migration add_products
# Review the generated up/down SQL.
bun run bundle migrate
bun run bundle model:show Product
```

Model and seeder names must be PascalCase identifiers. Built-in scalar type names such as `Date`, `String`, and `Number` are rejected for models because they conflict with MikroORM metadata. Generators use exclusive file creation and refuse to overwrite existing files. This includes migrations: a same-second/name filename collision fails without replacing the migration or advancing the snapshot; retry later or use a distinct migration name. New models under `src/models/*.ts` are automatically discovered. MikroORM's default naming applies unless a schema declares `tableName`; this is not an Eloquent naming-compatibility layer.

Migrations live in separate directories:

```text
database/migrations/sqlite/
database/migrations/postgresql/
database/migrations/mariadb/
```

Each directory includes an initial migration for the example models. Subsequent schema-diff migrations and `.snapshot.json` files are generated for the selected dialect. Keep migrations and their snapshots under version control; do not copy SQL migrations between database engines. Run the generation/review process for each database your application targets. Database portability does not guarantee equivalent behavior for every vendor-specific type or feature.

Generate a custom seeder and fill in its data operations:

```bash
bun run bundle make:seeder ProductSeeder
bun run bundle db:seed ProductSeeder
```

## Application API

Use a forked entity manager per operation/request. `withDatabase` manages a short-lived ORM instance and always closes it, including when work fails:

```ts
import { withDatabase } from "./src/database/connection.ts";
import { User } from "./src/models/User.ts";
import { Post } from "./src/models/Post.ts";

await withDatabase(async orm => {
  const em = orm.em.fork();
  const author = em.create(User, { name: "Example Author", email: "author@example.test" });
  em.create(Post, { title: "First post", slug: "first-post", body: "Hello", author });
  await em.flush();

  const user = await em.findOneOrFail(User, { email: author.email }, { populate: ["posts"] });
  console.log(user.posts.getItems());
});
```

For a future long-running server, initialize once with `openDatabase`, fork per request (or use MikroORM's request context), and close the instance on shutdown. Do not share the global entity manager between requests. Transactions are available through `em.transactional(...)`; use the transaction callback's entity manager for all participating work.

MikroORM's full public API remains available directly, including repositories, relationship loading, query builders, custom types, hooks, and factories from `@mikro-orm/seeder`. Bundle does not claim custom CLI commands for every ORM capability yet. Upserts bypass constructor defaults; supply required timestamp values explicitly, as the example seeder does.

## Native MikroORM CLI

The matching native CLI is installed as a development dependency:

```bash
bun run orm --help
bun run orm debug
```

It uses `mikro-orm.config.ts`, which shares Bundle's database configuration. For the default SQLite path, run `bun run bundle migrate` first to create the parent directory. **Native CLI commands do not use Bundle's `--force` guards**, and their names/options differ. Treat advanced native schema/migration commands accordingly.

## Verification and support status

```bash
bun test
bun test ./src/database/database.test.ts
bun test ./src/cli/program.test.ts
bun run typecheck
```

SQLite integration tests exercise actual migrations, CRUD, relationship loading, constraints, cascade deletes, transactions, repeatable seeding, generated model discovery, generated migration application/rollback, batch/step selection, SQL previews, lock contention/cleanup, schema dump/pruning/bootstrap, and real Bun processes that edit a model then apply/revert its column change without losing existing rows. Fixtures use unique disposable directories under `.data/`, not the application database. Native PostgreSQL/MariaDB dump adapters have argument/environment/guard tests with injected tools; those do not establish live-server/client support.

MariaDB and PostgreSQL have installed official drivers, configuration, initial dialect-specific migrations, and an opt-in live persistence contract. **They are not considered live-verified merely because SQLite tests pass.** Without live test URLs, the two server integration tests are explicitly skipped.

To run those tests, provision **empty, disposable databases** and set:

```bash
BUNDLE_TEST_ALLOW_RESET=1 \
BUNDLE_TEST_POSTGRESQL_URL='postgresql://user:password@localhost:5432/bundle_test' \
BUNDLE_TEST_MARIADB_URL='mariadb://user:password@localhost:3306/bundle_test' \
bun test ./src/database/database.test.ts
```

These tests require explicit reset permission, refuse databases containing tables, and remove the mapped tables/migration history they create. Never supply an application or production database. The tests do not provision database servers or accounts. Test failure after MariaDB DDL may require inspecting/cleaning the disposable database before retrying.
