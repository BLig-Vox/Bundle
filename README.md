# Bundle

Bundle's generated-application direction is full MVC: MikroORM models and Bun-native HTTP controllers/routes on the backend, with Vite + React TSX views, Fast Refresh/HMR and preconfigured shadcn/ui components on the frontend. Runtime tests verify generated-app Vite startup, React Fast Refresh/HMR, typecheck, production build, combined API+web startup, `/api` proxying, and serving the build through the production worker on Linux. Non-Linux static serving remains unavailable. The Laravel-inspired CLI coordinates the backend and development workflow. Backend mappings remain code-first TypeScript classes plus `EntitySchema`.

## Database quick start

SQLite works without a database server:

```bash
bun install
bun run bundle migrate
bun run bundle db:seed
bun run bundle db:show
bun run bundle db:table users
bun run bundle db  # open the existing SQLite file; requires sqlite3
```

The local database is `.data/bundle.sqlite`. Seeding adds explicit demo data; it is not an authentication setup. `bundle db` opens only an existing regular SQLite file with the native `sqlite3` client; it never creates a missing database. PostgreSQL/MariaDB client launching is not implemented yet.

`bun run bundle tinker` opens a **trusted local JavaScript** REPL with normal application bootstrap, rooted imports and the real service scope. Noninteractive use requires explicit `--execute '<program>'`; it evaluates one complete program and prints its final result. No database opens unless `--allow-database` is supplied **and** `bundle.database()` is used; production helper access also requires global `--force`. This is not a sandbox or PHP/TypeScript shell. Source is visible in argv and code can print secrets or access host resources. See [tinker](docs/tinker.md) for lifecycle limits and current verification status.

Create a separate **new** code-first application with `bun run bundle new my-app` (or `new --interactive`). Creation is offline: dependencies are declared but not installed, and no migration, seeder or service runs implicitly. Existing destinations always refuse. Defaults are SQLite, native Bun tests and a cacheable JSON health route; server database choices require separately provisioned services/credentials. See [project creation](docs/project-creation.md).

```bash
bun run bundle list
bun run bundle make:model Product
bun run bundle make:migration add_products
bun run bundle migrate
bun run bundle migrate:status
```

Edit generated model properties before generating its migration. MariaDB and PostgreSQL drivers and separate migration directories are also configured; choose the connection in `.env` using `.env.example`. Their live integration tests require external disposable databases and are skipped when no test URLs are supplied.

See [the database guide](docs/database.md) for model usage, connection options, migration safety, and the database support/verification matrix. The [Artisan-inspired migration guide](docs/migrations.md) documents batch rollback, step/batch selection, SQL previews, named connections, custom migration paths, deployment isolation, schema dumps/pruning, and deliberate differences from Laravel.

```bash
bun run bundle migrate --step --isolated
bun run bundle migrate:rollback --pretend
bun run bundle migrate:rollback --step 1 --force
bun run bundle migrate:install
bun run bundle schema:dump --isolated
```

`make:model Product -mfs` also scaffolds a migration, native `ProductFactory` and `ProductSeeder` after the initial migration baseline has been applied. Select `-f/--factory`, `-s/--seed` and `-m/--migration` independently. Selected code outputs and the consumed factory stub are preflighted before creating any code files; existing outputs and linked destination parents refuse even with force. Later I/O or native migration failure can leave earlier new files: this is not a multi-file transaction. Without `-m`, generation does not open the database. The CLI does not edit existing models; you maintain their TypeScript fields and mappings.

`make:factory Billing/UserFactory --model User`, `make:cast Billing/TrimmedText`, `make:scope Billing/NamedUsers` and `make:observer Billing/RecordCreates` produce examples consumed by native MikroORM APIs. Inputs/mappings/helper invocation/subscriber registration remain explicit; generation never opens a database. See [native ORM generators](docs/native-orm-generators.md) for real usage and deliberate differences from Eloquent.

`model:prune --pretend` counts explicit trusted `pruning.ts` rules. Actual bounded native bulk deletion requires global `--force`, an existing selected database and explicit application eligibility. It preserves caller manager state, but per-entity hooks do not run and earlier chunks can remain committed after later failure/cancellation. See [model pruning](docs/model-pruning.md) for registration, limits and current verification status.

`migrate:uninstall --pretend` inspects verified existing SQLite tracking; actual removal requires global `--force` and preserves application tables, migration files and lock state. It loses applied-history knowledge, so later migration application needs care. See [tracking uninstall](docs/history-uninstall.md) for conservative refusal and fresh-process reinstall rules.

`dev:list` inspects an explicit trusted `dev.ts` registry, and `dev` consumes it as a foreground owned Bun command group. Generated applications configure the API and Vite frontend as separate children; run `bun install` explicitly in the generated app before using them. Runtime tests verify generated-app Vite readiness/HMR, build, combined API+web startup, `/api` proxy and coordinated listener shutdown. The group stops owned peers on first exit and on signals, but does not manage arbitrary descendants or background services. See [development processes](docs/development.md).

## Artisan-style console foundations

The real CLI also supports trusted custom TypeScript commands with scoped services, lifecycle/cancellation, optional atomic isolation and prompts; safe code-only generators with published stubs; configuration/environment operations; persistent local cache/owned storage links; structured log inspection; and native Bun test execution:

```bash
bun run bundle list make --raw
bun run bundle make:command ImportProducts
bun run bundle import-products
bun run bundle make:class Billing/Invoice
bun run bundle make:test ImportProductsTest --unit
bun run bundle test ./tests/Unit/ImportProductsTest.test.ts
# Select an existing application endpoint; customize the generated status assertion:
bun run bundle make:test HealthTest --http /health
bun run bundle test ./tests/Feature/HealthTest.test.ts
bun run bundle make:config Billing
bun run bundle stub:publish
bun run bundle config:show
bun run bundle about --only environment,cache
bun run bundle docs --list
bun run bundle pail --json
bun run bundle env
```

See [the console guide](docs/console.md) for supported options, command APIs, safety rules, encrypted-environment format and session-specific Bun dispatch troubleshooting. These are bounded Bun equivalents, not complete Laravel/PHP compatibility. The [compatibility roadmap](docs/cli-roadmap.md) and [180-item inventory](docs/cli-compatibility.json) keep implemented, partial, pending and excluded capabilities distinct.

`testCommand(argv, {root, prompts, ...})` tests real rooted commands with scripted native prompts and bounded injected I/O/status assertions. Generated commands and generated Bun tests consume the helper; passwords are not echoed by native prompt capture, and mismatches/overflow fail after ownership cleanup. Direct process-global output and uncooperative code remain outside its capture/cancellation boundary. See [console testing](docs/console-testing.md).

`make:provider Billing/LoggingProvider` emits a class consumed by explicit root `providers.ts` registration. The outer runner registers/boots providers before command imports, nested calls share initialized services, and owned scopes/providers/singletons are disposed in order. Root manifests are not edited automatically; see [providers](docs/providers.md) for embedding ownership, signals and trusted-code limits. Separately, `package:discover` caches explicit trusted root `packages.ts` provider groups, consumed by later CLI bootstrap without source fallback; `package:clear` removes only valid owned metadata. This is not dependency scanning, downloads or vendor publication. See [package metadata](docs/packages.md), including fail-closed recovery limits.

`lang:publish` exclusively creates a code-only English catalogue consumed by `translate(root, key, {values})`. Explicit local catalogues support bounded Unicode text and named replacements; existing translations are never overwritten, including with force. See [local language resources](docs/localization.md) for locale/fallback rules and trusted-import limits.

`config:publish` without selectors exclusively creates built-in app.ts. With `--package`, `--tag` or `--all`, it consumes the shared explicit publication manifest but copies only configuration destinations, never language/data; cached configuration retains precedence until explicitly cleared/rebuilt.

`vendor:publish --package acme` or `--tag defaults` copies explicitly registered local code/config/data assets from trusted versioned `publish.ts` manifests. Published configuration and locale files are consumed by the existing runtimes; source assets are never imported by copying. Selection and full preflight precede exclusive private writes, and force never overwrites application files. See [code-only vendor publication](docs/publication.md) for supported paths and partial-I/O/cancellation limits.

`make:controller Api/UserResourceController --resource --model User` emits five own resource methods consumed by explicit per-request MikroORM middleware. Applications supply manager, validation/id parsing, selected serialization and authorization; no routes or request fields are inferred. Generation never imports a model or connects to a database. See [model resource controllers](docs/model-resources.md) for native CRUD, ownership and cache contracts.

## Code-first HTTP

The backend HTTP runtime is a Bun-native Request/Response router with ordered middleware and executable TypeScript controllers/routes. Generated applications use a separate Vite + React view frontend; React does not replace the backend router or make backend route definitions markup-driven. A trusted root `routes.ts` exports either `createRouter()` registrations or cacheable `defineRoutes([...])` module references.

```bash
bun run bundle make:controller ShowCustomer
bun run bundle make:request StoreCustomer
bun run bundle route:list --json
bun run bundle serve --host 127.0.0.1 --port 8000
bun run bundle route:cache  # requires defineRoutes; closure routers are uncacheable
bun run bundle route:clear
```

Define routes before inspection/serving; generated controllers are not automatically registered. [The HTTP guide](docs/http.md) covers worker-backed shutdown, route cache precedence, validation, JSON resources, generators and limitations. `down`/`up` enforce persistent live maintenance mode. `make:policy` emits deny-default classes consumed by explicit policyMiddleware guards with application-supplied identities/resources; no authentication or automatic route protection is inferred. Authentication/session management and managed reload remain unfinished. [Local events](docs/events.md) provide ordered dispatch and executable cached registrations, while `optimize`/`optimize:clear` aggregate real bootstrap caches with visible partial failures.

## Local events and durable jobs

`make:event Billing/InvoiceCreated` and `make:listener Billing/RecordInvoice` emit code consumed by the event runtime; registration remains explicit. Generated event identities include their namespaces. `event:generate` reads source registrations and exclusively creates missing conventional class listeners using consumed stubs; existing checked modules are preserved, and string event identities require no fabricated event class. All target/template checks precede publication, which is not a multi-file transaction. The dedicated SQLite queue persists JSON-safe job references, executes them in owned Bun workers, and supports bounded priority, retry, timeout and cancellation:

```sh
bun run bundle queue:work --queue high,default --stop-when-empty
bun run bundle queue:failed --limit 100
bun run bundle queue:monitor --queue default
bun run bundle queue:retry 7
bun run bundle --force queue:forget 7
```

Produce module jobs through `openLocalQueue(root).enqueue(...)` and close the store, or persist command argv using `dispatchCommand({root,argv:["report:daily"],maxAttempts:3})` from `src/queue/dispatch.ts`; see [the queue guide](docs/queues.md) for complete examples, version-rollout rules and output/secret limitations. Delivery is **at least once**, timing flags use **milliseconds**, and producer `maxAttempts` supplies the default; optional worker `--tries 1..100` atomically persists a chosen override for newly claimed eligible work. `make:job Billing/IssueInvoice` produces an explicit example own handler; replace it with application work and enqueue its module/class/method reference. `queue:pause`/`queue:resume` affect selected work at claim boundaries; `queue:restart` requests graceful consumer exit after active settlement, not self-respawn. `make:job-middleware` creates a pass-through function consumed by explicitly supplied job `middleware` references; deliberate short-circuiting acknowledges without running the handler. `queue:listen` runs fresh owned worker children with bounded cancellation and explicit per-cycle polling; it is not a self-respawning system service. `dispatchBatch({root,jobs})` atomically persists mixed jobs with durable status, explicit cancellation and retry/prune controls; see [local batches](docs/queue-batches.md). New queues use schema2; verified version1 queues refuse ordinary opens until all old processes are stopped and an explicit `--force queue:upgrade` succeeds. This is not mixed-version safety, Redis/Horizon, exactly-once side effects, a batch-table ORM adapter or application ORM database storage. `channel:list` lists names from an explicit trusted root `channels.ts` registry without opening a database or contacting a service; it is metadata only, not channel authorization or broadcast delivery. See [broadcasting](docs/broadcasting.md).

## Local text delivery and UTC scheduling

`make:mail` and `make:notification` generate classes consumed by explicitly injected text-mail transports. The built-in private local outbox persists versioned JSON; it does **not** deliver SMTP/inbox mail or create notification tables. No dispatch occurs at generation/import/construction. See [the mail guide](docs/mail.md) for strict bounds, private inspection, sync/concurrency limitations and explicit usage.

A trusted code-first `schedule.ts` can register explicit command argv for bounded five-field **UTC-only** cron. `schedule:list`, `schedule:run` and `schedule:work` consume the real command runner, with local overlap locks, foreground observed-minute deduplication and cooperative signals. This is not timezone/DST support, durable once-only scheduling or a service manager; persisted pause/resume and graceful interrupt are consumed at live boundaries, while `schedule:test --task <id>` or id-only terminal selection executes one configured task with real effects even when not due, preserving controls and overlap. `schedule:clear-cache --force` removes only identity-verified stale new-format locks on Linux and in the current PID namespace; active locks remain, while cross-namespace, legacy, corrupt or unsafe state is preserved for inspection. Background finish and service supervision remain unfinished. See [the scheduling guide](docs/scheduling.md).

## Development

Install dependencies:

```bash
bun install
```

Run the entry point:

```bash
bun run start
```

Run with automatic restarts when files change:

```bash
bun run dev
```

Check TypeScript types:

```bash
bun run typecheck
```

The entry point is `index.ts`, which runs the Bundle CLI. `bun run start` shows its command list; pass a command to execute it. Backend HTTP uses the code-first Bun-native router/server. Its worker serves descriptor-opened `dist/` assets on Linux; non-Linux static serving is unavailable. Runtime tests verify generated Vite Fast Refresh/HMR, `ui:build`, combined API startup/proxy and serving a generated build through the production worker on Linux; non-Linux static serving is unavailable. No linter is configured.

Run the Bun tests:

```bash
bun test
```

Run just the corpus tests:

```bash
bun test ./src/graph/corpus.test.ts
```

## Feature reference and JSON graph

[PROGRESS.md](PROGRESS.md) contains the Laravel CLI feature checklist for reference. It does not indicate that Laravel is installed or that those features have been implemented.

[graph/](graph/README.md) contains a generated JSON corpus and knowledge graph of the entire checklist, including its sections, items, commands, notes, examples, and sources. It is local data, not a GraphQL server.

```bash
bun run graph:build   # Regenerate JSON from PROGRESS.md
bun run graph:check   # Verify JSON is current without rewriting it
```

The original Markdown is preserved verbatim in the corpus, and extracted records link back to source lines. Edit `PROGRESS.md` and regenerate; do not hand-edit the generated JSON.

### Project skill

The project-local [progress-graph skill](.claude/skills/progress-graph/SKILL.md) provides these Claude Code workflows:

```text
/progress-graph          Rebuild the corpus and run validation
/progress-graph sync     Rebuild the corpus and run validation
/progress-graph check    Validate without rewriting artifacts
/progress-graph inspect  Summarize the corpus without modifying files
```

Add task details to inspect particular records or request a source/generator update. The skill preserves the source-of-truth rules and does not treat documented features as implemented capabilities.
