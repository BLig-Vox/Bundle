# Laravel CLI Features Checklist

Laravel’s main command-line interface is **Artisan**, invoked with:

```bash
php artisan <command>
```

Laravel also provides a project installer and optional CLI tools through its ecosystem.

**The exact command list depends on your Laravel version, installed packages, and custom commands.** This checklist covers modern Laravel, including Laravel 13.x features. It is a capability reference, not a claim that Laravel is installed or these features are implemented in this repository. All items start unchecked.

## Bundle ORM and migration status

**Status as of 2026-11-06: implemented and locally tested, but not complete Artisan parity or full cross-database simulation.** The numbered checklist below remains a Laravel capability reference; its checkboxes are unchanged and do not measure Bundle implementation progress. Bundle uses Bun, TypeScript, and MikroORM's Data Mapper API, not PHP, Eloquent, or Laravel's Schema Builder.

### Implemented with real SQLite test evidence

- Model discovery from `src/models/*.ts`, code-first classes with `EntitySchema`, CRUD, relationships, constraints, timestamps, transactions, and explicit repeatable demo seeding run against disposable SQLite databases.
- Migration installation/status/check, application, latest-batch rollback, reset, refresh, and conservative fresh rebuilds are implemented. Tests cover batch tracking, application steps, rollback count/batch selection, partial refresh, and legacy history upgrades.
- Model and seeder generators, schema-diff generation, and blank/create/table migration stubs are implemented with overwrite protection. A real Bun CLI-process test edits an existing model, generates and applies a column migration, then rolls it back while preserving existing rows. The CLI does not edit model source automatically.
- Named connections, custom migration directories, explicit external-path authorization, destructive/production force guards, and failure reporting have automated tests. Database-backed isolation is tested for contention across local connections and cleanup after ordinary failures; stale-lock removal is explicit.
- SQLite live-schema dumping, migration-history preservation, safe pruning, empty-target restoration/bootstrap, and subsequent migration application are tested against real SQLite fixtures. Dumps exclude application rows and are not data backups.

### PostgreSQL and MariaDB: implemented paths, incomplete live verification

- Official MikroORM drivers, connection/TLS validation, and initial dialect-specific migrations are present. Offline tests compare generated CREATE SQL with those migrations; this does not demonstrate successful execution on a server.
- The latest implementation-validation run had **86 passing tests, 2 skipped tests, and 0 failures**. The skipped tests are the opt-in PostgreSQL and MariaDB live persistence contracts. This is a dated test-run snapshot, not a code-coverage percentage or a promise that every scenario is tested.
- PostgreSQL and MariaDB native dump/restore adapters have injected/mock-tool tests for command arguments, environment handling, fallback behavior, and safety guards. Real `pg_dump`/`psql` and MariaDB/MySQL dump/client round trips were not verified against live servers in that run.
- Live tests require explicitly supplied `BUNDLE_TEST_POSTGRESQL_URL` / `BUNDLE_TEST_MARIADB_URL`, `BUNDLE_TEST_ALLOW_RESET=1`, and empty disposable databases. Never use application or production databases. Skipped tests and passing SQLite/mock tests do not establish live server support.

### SQL preview is not full simulation

- `--pretend` prints supported migrations' queued string SQL without executing it, running seeders, or installing/upgrading migration history. Tests cover preview in both directions, missing SQLite targets, and schema-bootstrap previews.
- Preview does not run SQL against a disposable database, validate SQL execution, simulate arbitrary data migrations, or establish rollback correctness. Imperative driver/entity-manager access is rejected. Migration modules remain trusted project code; their top-level side effects are not sandboxed.
- `migrate:check` compares model metadata with the migration snapshot when available; it is not a comprehensive live-schema drift audit. `schema:sql` prints mapped CREATE SQL, distinct from a live schema dump.

### Remaining verification and compatibility gaps

- Run the live PostgreSQL and MariaDB persistence contracts, then separately exercise the expanded batch/rollback/refresh/fresh, lock, and schema dump/prune/bootstrap workflows on each engine. The opt-in persistence tests alone are not a complete migration-feature matrix.
- Verify real native-client round trips, supported server/client versions, TLS/authentication configurations, restricted permissions, and engine-specific schema/data behavior. MariaDB DDL and restoration are not guaranteed atomic.
- Validate concurrent deployment behavior across actual processes/hosts, abrupt termination and stale-lock recovery, and operational performance. Current local lock tests are not proof of multi-host deployment safety; non-isolated and native ORM commands can ignore the cooperative lock.
- No claim of every Artisan command/flag or vendor-specific operation: migration-history uninstall, unrestricted database wiping, PHP Schema Builder compatibility, automatic model editing, interactive production confirmation, and automatic server provisioning are not implemented. Fresh rebuilds deliberately refuse unmapped tables/views rather than automatically dropping every object or type.
- Passing scenario tests do not prove exhaustive coverage, production readiness, or universal database portability. Review generated SQL and rollback behavior, maintain dialect-specific migrations/snapshots, and back up real data before destructive operations. Native ORM commands bypass Bundle's force guards and optional isolation/bootstrap orchestration.

See [the migration guide](docs/migrations.md) for the command/option contract and [the database guide](docs/database.md) for configuration and opt-in live-test instructions. These Bundle status notes do not check off the Laravel reference items below.

## 1. Command discovery and help

- [ ] `php artisan list` — List every registered command.
- [ ] `php artisan list make` — List code-generation commands.
- [ ] `php artisan help migrate` — Show arguments and options.
- [ ] `php artisan --version` — Show the framework version.
- [ ] `php artisan about` — Show application/environment information.
- [ ] `php artisan docs` — Open Laravel documentation.

For an exhaustive list for a particular application, **`php artisan list` is the authoritative source**.

## 2. Project creation

- [ ] Create and configure an application using the separate Laravel installer:

  ```bash
  laravel new my-app
  ```

- [ ] Use the installer’s interactive setup to choose options such as starter kits, database, and testing framework. Available choices and flags depend on the installer version.

## 3. Local development

The commands below are invoked with `php artisan`.

- [ ] `serve` — Start the PHP development server.
- [ ] `dev` — Run the development server, queue listener, logs, and Vite together in supported versions.
- [ ] `dev:list` — Display the processes configured for `dev`.
- [ ] `tinker` — Open an interactive PHP shell with the application bootstrapped.
- [ ] `pail` — Tail application logs when Laravel Pail is installed.
- [ ] Configure the development server host and port:

  ```bash
  php artisan serve --host=127.0.0.1 --port=8000
  ```

## 4. Code generation

Artisan generates application classes and supporting files. Commands below are invoked with `php artisan`.

### Application structure

- [ ] `make:class` — Generate a class.
- [ ] `make:interface` — Generate an interface.
- [ ] `make:trait` — Generate a trait.
- [ ] `make:enum` — Generate an enum.
- [ ] `make:provider` — Generate a service provider.
- [ ] `make:config` — Generate a configuration file.
- [ ] `make:command` — Generate an Artisan command.

### HTTP and presentation

- [ ] `make:controller` — Generate a controller.
- [ ] `make:middleware` — Generate middleware.
- [ ] `make:request` — Generate a form request.
- [ ] `make:resource` — Generate an API resource.
- [ ] `make:component` — Generate a Blade component.
- [ ] `make:view` — Generate a view.

### Database and Eloquent

- [ ] `make:model` — Generate an Eloquent model.
- [ ] `make:migration` — Generate a database migration.
- [ ] `make:factory` — Generate a model factory.
- [ ] `make:seeder` — Generate a database seeder.
- [ ] `make:cast` — Generate a custom cast.
- [ ] `make:scope` — Generate an Eloquent scope.
- [ ] `make:observer` — Generate a model observer.

### Application behavior

- [ ] `make:event` — Generate an event.
- [ ] `make:listener` — Generate an event listener.
- [ ] `make:job` — Generate a job.
- [ ] `make:job-middleware` — Generate job middleware.
- [ ] `make:mail` — Generate a mailable.
- [ ] `make:notification` — Generate a notification.
- [ ] `make:channel` — Generate a broadcast channel class.
- [ ] `make:policy` — Generate an authorization policy.
- [ ] `make:rule` — Generate a validation rule.
- [ ] `make:exception` — Generate an exception.

### Infrastructure and testing

- [ ] `make:cache-table` — Generate a cache table migration.
- [ ] `make:session-table` — Generate a session table migration.
- [ ] `make:notifications-table` — Generate a notifications table migration.
- [ ] `make:queue-table` — Generate a queue jobs table migration.
- [ ] `make:queue-failed-table` — Generate a failed jobs table migration.
- [ ] `make:queue-batches-table` — Generate a job batches table migration.
- [ ] `make:test` — Generate a test.

### Generator examples and customization

- [ ] Generate a model with a migration, factory, and seeder:

  ```bash
  php artisan make:model Post -mfs
  ```

- [ ] Generate a resource controller associated with a model:

  ```bash
  php artisan make:controller PostController --resource --model=Post
  ```

- [ ] Generate a form request:

  ```bash
  php artisan make:request StorePostRequest
  ```

- [ ] Generate a feature test:

  ```bash
  php artisan make:test PostTest
  ```

- [ ] Generate a unit test:

  ```bash
  php artisan make:test PostTest --unit
  ```

- [ ] Use generator options to create related files together.
- [ ] Use `stub:publish` to customize the templates used by generators.

## 5. Database migrations and schema management

- [ ] `migrate` — Apply pending migrations.
- [ ] `migrate:status` — Show migration status.
- [ ] `migrate:rollback` — Roll back the latest migration batch.
- [ ] `migrate:reset` — Roll back all migrations.
- [ ] `migrate:refresh` — Roll back and rerun migrations.
- [ ] `migrate:fresh` — Drop all tables and rerun migrations.
- [ ] `migrate:install` — Create the migration tracking table.
- [ ] `migrate:uninstall` — Remove the migration tracking table.
- [ ] `schema:dump` — Export the database schema.
- [ ] `db:seed` — Run database seeders.
- [ ] `db:wipe` — Drop database tables, with options for other objects.

**Destructive:** `migrate:fresh`, `migrate:refresh`, `migrate:reset`, and `db:wipe` can remove data.

## 6. Database inspection and model maintenance

- [ ] `db` — Open the database CLI.
- [ ] `db:show` — Inspect database information.
- [ ] `db:table` — Inspect a database table.
- [ ] `db:monitor` — Monitor database connection counts.
- [ ] `model:show` — Inspect an Eloquent model.
- [ ] `model:prune` — Remove records matching model pruning rules.
- [ ] Inspect database information, a table, and a model:

  ```bash
  php artisan db:show
  php artisan db:table users
  php artisan model:show User
  ```

## 7. Routing

- [ ] `route:list` — Display registered routes.
- [ ] `route:cache` — Cache route definitions.
- [ ] `route:clear` — Remove the route cache.
- [ ] Filter routes by path:

  ```bash
  php artisan route:list --path=api
  ```

- [ ] Display routes with verbose information:

  ```bash
  php artisan route:list -v
  ```

## 8. Configuration, caching, and optimization

### Configuration

- [ ] `config:show` — Display configuration values.
- [ ] `config:cache` — Cache application configuration.
- [ ] `config:clear` — Remove the configuration cache.
- [ ] `config:publish` — Publish configuration files.

### Application cache

- [ ] `cache:clear` — Clear the application cache.
- [ ] `cache:forget` — Remove a cache item.
- [ ] `cache:prune-stale-tags` — Prune stale cache tags.

### Blade views

- [ ] `view:cache` — Compile and cache Blade views.
- [ ] `view:clear` — Clear compiled views.

### Events

- [ ] `event:list` — List events and listeners.
- [ ] `event:cache` — Cache discovered events and listeners.
- [ ] `event:clear` — Clear the event cache.
- [ ] `event:generate` — Generate missing events and listeners from registrations.

### Combined optimization and compiled files

- [ ] `optimize` — Cache application bootstrap information.
- [ ] `optimize:clear` — Remove optimization caches.
- [ ] `clear-compiled` — Remove compiled framework files.

## 9. Queue and background-job management

- [ ] `queue:work` — Process queued jobs.
- [ ] `queue:listen` — Listen for and process jobs.
- [ ] `queue:restart` — Request graceful worker restarts.
- [ ] `queue:pause` — Pause processing on a supported queue.
- [ ] `queue:resume` — Resume processing.
- [ ] `queue:monitor` — Monitor queue sizes.
- [ ] `queue:clear` — Delete queued jobs.
- [ ] `queue:failed` — List failed jobs.
- [ ] `queue:retry` — Retry failed jobs.
- [ ] `queue:retry-batch` — Retry failed jobs in a batch.
- [ ] `queue:forget` — Delete a failed-job record.
- [ ] `queue:flush` — Delete all failed-job records.
- [ ] `queue:prune-failed` — Prune old failed-job records.
- [ ] `queue:prune-batches` — Prune old batch records.
- [ ] Configure queue priority, retry attempts, and worker timeout:

  ```bash
  php artisan queue:work --queue=high,default --tries=3 --timeout=90
  ```

Pause/resume commands are version-dependent.

## 10. Task scheduling

- [ ] `schedule:list` — List scheduled tasks.
- [ ] `schedule:run` — Execute tasks that are due.
- [ ] `schedule:work` — Run the scheduler in the foreground.
- [ ] `schedule:test` — Interactively select a scheduled task to run.
- [ ] `schedule:interrupt` — Interrupt an in-progress scheduler run.
- [ ] `schedule:clear-cache` — Clear scheduler mutexes.
- [ ] `schedule:pause` — Pause scheduling in supported versions.
- [ ] `schedule:resume` — Resume scheduling in supported versions.
- [ ] `schedule:finish` — Internal helper for background scheduled tasks.

## 11. Testing

- [ ] Run the full test suite:

  ```bash
  php artisan test
  ```

- [ ] Run a single test file:

  ```bash
  php artisan test tests/Feature/ExampleTest.php
  ```

- [ ] Run matching tests:

  ```bash
  php artisan test --filter=ExampleTest
  ```

- [ ] Run tests in parallel:

  ```bash
  php artisan test --parallel
  ```

- [ ] Generate coverage reports:

  ```bash
  php artisan test --coverage
  ```

- [ ] Use parallel test execution with the required dependencies.
- [ ] Use coverage reporting with a supported coverage driver.
- [ ] Integrate with PHPUnit or Pest, depending on project setup.

## 12. Application operations and environment management

- [ ] `key:generate` — Generate the application encryption key.
- [ ] `env` — Display the current environment.
- [ ] `env:encrypt` — Encrypt an environment file.
- [ ] `env:decrypt` — Decrypt an environment file.
- [ ] `down` — Enable maintenance mode.
- [ ] `up` — Disable maintenance mode.
- [ ] `reload` — Reload supported long-running services in supported versions.
- [ ] `auth:clear-resets` — Delete expired password-reset tokens.
- [ ] `storage:link` — Create configured storage symbolic links.
- [ ] `storage:unlink` — Remove configured storage symbolic links.

## 13. Feature installation and package integration

- [ ] `install:api` — Set up API routing and authentication support.
- [ ] `install:broadcasting` — Set up event broadcasting.
- [ ] `channel:list` — List registered broadcast channels.
- [ ] `vendor:publish` — Publish package configuration, views, and other assets.
- [ ] `package:discover` — Rebuild discovered package metadata.
- [ ] `lang:publish` — Publish language files.
- [ ] `stub:publish` — Publish customizable generator templates.

## 14. Building your own CLI commands

Artisan is also a framework for creating application-specific command-line tools.

- [ ] Create class-based commands.
- [ ] Create closure-based commands.
- [ ] Define required, optional, defaulted, and array arguments.
- [ ] Define boolean flags, valued options, shortcuts, and repeatable options.
- [ ] Use dependency injection.
- [ ] Add interactive text and password prompts.
- [ ] Add confirmations, selection lists, search, and input validation.
- [ ] Automatically prompt for missing required arguments.
- [ ] Display colored output, tables, progress bars, and spinners.
- [ ] Handle exit codes and exceptions.
- [ ] Use isolated execution with atomic locks.
- [ ] Handle signals for graceful shutdown.
- [ ] Call commands from other commands or application code.
- [ ] Dispatch commands to queues.
- [ ] Respond to command lifecycle events.
- [ ] Test console commands with input/output assertions.
- [ ] Generate a custom command:

  ```bash
  php artisan make:command ImportProducts
  ```

## 15. Optional ecosystem CLI tools

These require the corresponding packages or services; they are **not all built into a default Laravel installation**.

- [ ] **Sail** — Docker-based development; run Artisan, Composer, Node, and tests in containers.
- [ ] **Pint** — PHP code formatting and style checks.
- [ ] **Pail** — Live application-log inspection.
- [ ] **Horizon** — Redis queue workers, monitoring, and management.
- [ ] **Octane** — Start and manage long-running application servers.
- [ ] **Reverb** — Run a WebSocket server.
- [ ] **Dusk** — Browser automation and browser tests.
- [ ] **Scout** — Import, flush, and manage searchable model indexes.
- [ ] **Telescope** — Install and maintain application debugging tools.
- [ ] **Pulse** — Install and manage application monitoring components.

### Ecosystem command examples

- [ ] Run migrations through Sail:

  ```bash
  ./vendor/bin/sail artisan migrate
  ```

- [ ] Format PHP code with Pint:

  ```bash
  ./vendor/bin/pint
  ```

- [ ] Start Horizon:

  ```bash
  php artisan horizon
  ```

- [ ] Start Octane:

  ```bash
  php artisan octane:start
  ```

- [ ] Start Reverb:

  ```bash
  php artisan reverb:start
  ```

- [ ] Run Dusk browser tests:

  ```bash
  php artisan dusk
  ```

- [ ] Import models into a Scout search index:

  ```bash
  php artisan scout:import "App\Models\Post"
  ```

## Sources

- [Laravel Artisan documentation](https://laravel.com/framework/docs/artisan/commands)
- [Laravel 13.x framework command registrations](https://github.com/laravel/framework/blob/13.x/src/Illuminate/Foundation/Providers/ArtisanServiceProvider.php)
- [Laravel task scheduling](https://laravel.com/framework/docs/scheduling)
