# Artisan-inspired migrations

Bundle implements a Bun/TypeScript migration lifecycle inspired by Laravel Artisan, backed by MikroORM. It does not install Laravel, execute PHP, or reproduce Laravel's Schema Builder API. Models remain TypeScript classes with `EntitySchema` mappings.

## Everyday workflow

```bash
bun run bundle migrate
bun run bundle make:model Product
# Edit src/models/Product.ts (class fields and EntitySchema mappings).
bun run bundle make:migration add_products
# Review the generated up/down SQL.
bun run bundle migrate
bun run bundle migrate:status
```

Apply the checked-in initial migrations before generating the first model diff. When no snapshot exists, Bundle refuses to generate a diff over pending migrations: diffing an empty database could duplicate tables already covered by those migrations. Once snapshots exist, successive model-diff migrations can be generated before applying them.

`make:model Product -m -s` creates the model, a model-diff migration, and `ProductSeeder`. This convenience command uses the same initialized-baseline requirement. Existing models are never edited or overwritten. Repeated `--field name:type` options can populate the model before its diff is generated; see [the database guide](database.md) for types and nullable syntax. After editing a generated model, generate another diff for those changes.

Fields are validated before baseline checks or writes. `--migration` checks the initialized baseline, writes the model, then opens a fresh ORM to generate its diff, so discovery includes the new fields. It does not apply the migration. Model/seeder writes are outside database transactions. If migration generation fails, the command returns a failure identifying the preserved model and any generated seeder; review migration files, fix the cause and retry `make:migration`. No rollback or atomicity across files and database is promised.

## Commands and options

Prefix commands with `bun run bundle`. `--help` documents each command.

| Command | Options / semantics |
| --- | --- |
| `migrate:install` | Install or upgrade history storage, without applying model migrations |
| `migrate` | Apply all pending migrations as one batch |
| `migrate --step` | Give each applied migration a separate batch number |
| `migrate --seed` | Run `DatabaseSeeder` after migration application |
| `migrate --seeder ProductSeeder` | Run a custom seeder, even without `--seed` |
| `migrate --pretend` | Print pending migrations' queued SQL, without executing it |
| `migrate --isolated` | Acquire a database-backed lock; report a successful skip when already locked |
| `migrate --graceful` | Report runtime failure as `{ "failed": true, "graceful": true, ... }`, but exit successfully; opt-in deployment behavior, not proof of success |
| `migrate --schema-path file.sql` | Select the schema dump used to bootstrap an empty database |
| `migrate:status [--pending]` | List history with batch numbers and pending files; optionally omit executed rows |
| `migrate:check` | Fail if model changes require a migration; snapshot comparison when available, not a full live-drift audit |
| `migrate:rollback` | Roll back all migrations in the latest batch, newest first |
| `migrate:rollback --step 3` | Roll back the last three individual migrations, regardless of batch |
| `migrate:rollback --batch 2` | Roll back batch 2; cannot combine with `--step` |
| `migrate:reset` | Roll back every executed migration |
| `migrate:refresh` | Roll back everything, then apply all pending migrations |
| `migrate:refresh --step 2` | Roll back and reapply only the latest two individual migrations; leave unrelated pending migrations alone |
| `migrate:fresh` | Drop mapped tables/history after preflight checks, optionally load a dump, then apply pending migrations |
| `migrate:unlock` | Remove a stale isolation lock; verify no migration is actually running first |
| `make:migration name` | Generate a model/schema diff and update the dialect snapshot |
| `make:migration name --blank` | Generate empty up/down methods without changing the snapshot |
| `make:migration name --create widgets` | Generate a starter create/drop-table migration with an ID primary key; edit it and maintain model mappings yourself |
| `make:migration name --table users` | Generate empty up/down methods for handwritten changes to an existing table; the CLI does not infer an ALTER from the table name |
| `schema:dump` | Dump the actual live schema and migration history, not application rows |
| `schema:dump --output file.sql` | Choose the output file; replacing an existing dump requires `--force` |
| `schema:dump --prune` | After writing the dump, remove eligible applied migration source files; requires `--force` |

Rollback, reset, and refresh accept `--pretend` and `--isolated`. Fresh accepts `--isolated`, `--schema-path`, `--seed`, and `--seeder`. Refresh also accepts seeding options. Schema dumping accepts `--isolated`. Seeder class names are validated before migration execution. `db:seed --class ProductSeeder` is an alternative to `db:seed ProductSeeder`.

### Target selection

Global options can appear before or after the command:

- `--database <name>` selects a named connection or a built-in driver name (`sqlite`, `postgresql`, `mariadb`). It does **not** mean an arbitrary database name.
- `--path <directory>` selects one existing migration directory relative to the project root. Generation writes there; status/application/rollback discover files there; its snapshot is separate.
- `--realpath` explicitly allows absolute/external migration directories. Without it, lexical traversal and symlink escapes are rejected. Files and comma-separated/multiple paths are not supported.

Define complete named connections through `BUNDLE_CONNECTIONS`, for example in `.env`:

```dotenv
BUNDLE_CONNECTIONS='{"testing":{"DB_CONNECTION":"sqlite","DB_DATABASE":".data/testing.sqlite"},"reporting":{"DB_CONNECTION":"postgresql","DATABASE_URL":"postgresql://bundle:password@localhost/reporting?sslmode=verify-full"}}'
```

```bash
bun run bundle migrate --database testing
bun run bundle migrate:status --database reporting
bun run bundle make:migration custom_change --blank --path database/custom
```

Create a custom directory before selecting it. Named entries replace all default connection fields, preventing default passwords, URLs, or database names from leaking into another target. Entries permit only string-valued `DB_CONNECTION`, `DB_DATABASE`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, and `DATABASE_URL`. Built-in driver names without named entries retain the current connection fields; when switching engines, explicitly supply a matching database configuration.

## Batches and compatibility

Bundle adds a `batch` column to MikroORM's existing migration-history table. Each migration application invocation receives the next batch number; `--step` invokes each migration separately. Recording is in the same transaction as its migration when the engine/operation supports it.

Existing history without batch metadata is upgraded in place; all historical rows become batch 1 because their original grouping cannot be reconstructed. Review status before rolling that legacy batch back. Empty/no-op runs do not add history rows.

The native MikroORM CLI shares this storage and records batches on `up`, but its own `down` selection remains MikroORM's native behavior, not Bundle's latest-batch selection. Native commands bypass Bundle's force guards, schema-bootstrap logic, and optional isolation lock.

Selected rollback sources must all exist before any rollback begins. Missing sources are reported rather than silently skipped. Restoring a pruned schema baseline does not recreate its original migration source files, so rolling back into that baseline is unavailable until those files are restored from version control.

## Safety

- Actual rollback/reset/refresh/fresh/unlock operations always require `--force`.
- Production application, generation, seeding, installation, status/check, and schema-dump operations require `--force` when `NODE_ENV` or `APP_ENV` is `production`.
- Preview-only rollback/reset/refresh does not need `--force`, including in production. It cannot be combined with `--isolated` because acquiring a lock writes to the database.
- Previews never install/upgrade migration storage. A nonexistent SQLite target is previewed against memory instead of creating the application database file.
- Preview supports declarative migrations using string `this.addSql(...)` statements. Imperative driver/entity-manager access is rejected, rather than running a data migration as a fake preview. Migration modules are still trusted executable project code, not sandboxed input; top-level side effects are the author's responsibility. Seeders are not previewed or run.
- When an empty target would bootstrap from a dump, preview includes that dump's SQL and uses its migration-name manifest to exclude already-squashed source migrations. Older dumps without a preview manifest must be regenerated for this preview mode.
- Fresh is deliberately conservative: it refuses unmapped tables/views and, when history exists, pending migrations or unreconciled model changes. It is not an unrestricted database wipe. Do not use a shared/production database for rebuild tests.
- MariaDB DDL may commit implicitly. Failures are not guaranteed to roll back atomically, including refresh/fresh and dump restoration.
- Generated files use exclusive creation. Migration filename collisions fail without overwriting a file or advancing a snapshot; retry later or use a distinct name.
- Blank/create/table stubs never advance the model snapshot. Handwritten migrations and model definitions must be kept consistent by their author.

## Deployment isolation

Use `--isolated` consistently across migration writers to serialize them against the selected database. Bundle uses an atomic insert into `bundle_migration_lock`, rather than a local filesystem/cache lock; separate processes/hosts targeting the same database contend on the same row. This infrastructure table is excluded from model schema diffs and schema dumps.

Locks are released in `finally`, including on ordinary failures. They deliberately have no automatic expiration that could permit overlapping long-running migrations. If a process is killed, confirm it is no longer running before using:

```bash
bun run bundle migrate:unlock --force
```

A non-isolated Bundle command or native ORM command can ignore the lock; this is cooperative deployment isolation, not a database-wide write barrier.

## Schema dumps and squashing

```bash
bun run bundle schema:dump --isolated
# Review and commit the dump before deleting migration history source files.
bun run bundle schema:dump --prune --force --isolated
```

The default is `database/schema/<driver>-schema.sql`; an explicitly selected named connection uses its encoded connection name instead of the driver. The dump contains the **live schema**, migration-history rows/batches, a dialect marker, and a migration-name preview manifest. It contains no application rows and is not a data backup. Dumps can contain schema-level executable SQL and must be reviewed as trusted source code.

`migrate` automatically loads an available dump only when migration history is empty. Restoration refuses an existing application schema or nonempty history, preserves the isolation lock, restores history, then applies newer migration files. `--schema-path` overrides the default dump. Schema dumps are dialect-specific.

SQLite uses the actual database schema, including indexes, views, and triggers, with transactional restoration and foreign-key validation. PostgreSQL uses `pg_dump` and `psql`; MariaDB uses `mariadb-dump` and `mariadb`, falling back to `mysqldump` and `mysql`. These must be installed separately. Native commands receive argument arrays, not shell strings; passwords are passed only in the child environment, never command-line arguments. PostgreSQL restoration uses a transaction and stop-on-error; MariaDB DDL is not atomic.

Native adapters require an explicit username/static credentials and faithfully representable TLS options. Verified PostgreSQL TLS uses libpq 17+ system trust; older clients fail closed. Custom CA/key/cert configurations, inherited PostgreSQL TLS/password sources that cannot be resolved safely, and other unsupported driver options are rejected rather than silently weakened. Configure a supported explicit connection or use reviewed provider-native tooling manually.

Keep schema changes quiescent while dumping, and use `--isolated` consistently for cooperating migration processes. Server dumps assemble schema/history sections using multiple native invocations; they are not a point-in-time application-data backup. Native adapter tests inspect arguments and guard behavior without servers; see [the database guide](database.md) for the live-server verification status.

Pruning requires no pending migrations and validates that files are standard exported TypeScript migration classes under the configured directory. Symlinks, changed files, and unrelated/non-TypeScript files are refused. Snapshot files are retained. Keep backups/version control: filesystem pruning cannot be rolled back by a database transaction.

## Coverage boundaries

The command lifecycle is Artisan-inspired, not a claim of PHP/Laravel compatibility. There is no PHP Schema Builder, automatic model editing, interactive production confirmation, automatic server provisioning, unrestricted `db:wipe`, or automatic view/type dropping in fresh resets. Use reviewed handwritten migrations for vendor-specific schema/data operations. `schema:sql` remains mapped CREATE SQL, distinct from the live `schema:dump`.

Run `bun test ./src/cli/migrations.test.ts`, `bun test ./src/database/schema-dump.test.ts`, and the full `bun test` suite. SQLite runs locally against disposable fixtures. PostgreSQL/MariaDB live tests remain explicit opt-in; offline/native argument tests do not establish live engine support.

Reference: [Laravel migration documentation](https://laravel.com/docs/13.x/migrations). This reference does not change the Laravel checklist in `PROGRESS.md` or mark it complete.
