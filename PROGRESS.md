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

## Bundle CLI feature ledger

The autonomous implementation loop began on 2026-11-07. This ledger records verified Bun/TypeScript equivalents separately from the unchanged Laravel reference checkboxes. A generated scaffold does not imply its consuming runtime subsystem exists. See [the loop contract](docs/cli-implementation-loop.md) for iteration and completion rules.

### Discovery and command help — implemented

- `bun run bundle list [namespace]` lists registered commands and filters by exact namespace, such as `make` or `migrate`, without requiring valid database configuration. `--raw` gives sorted names/descriptions; `--format json` exposes registered names, aliases, arguments, and command-local options. Supported formats are `txt` and `json`, not every Artisan/Symfony output format or option.
- `bun run bundle help [command...]` resolves command names, aliases, and nested command help without running the target action. Built-in `--help` and `--version` preserve successful exit status, and help/version output uses the injected CLI output handler.
- Evidence: `src/cli/discovery.test.ts` exercises namespace boundaries, sorted/raw and structured output, nested aliases, invalid formats, unknown help targets, and help/version exit semantics. Existing database CLI behavior remains covered separately. This is discovery functionality, not a claim that every referenced command is implemented.

### Custom command runtime — integrated foundations

- The actual `index.ts` entry point now calls `runCli`; `createApplicationCli` constructs built-ins and loads trusted top-level `src/commands/*.ts` definitions before parsing. Callback definitions and class instances preserve injected context, instance/private state, parser failures and exact handler exit statuses without the runner mutating process exit state.
- Required/optional/defaulted/variadic arguments and boolean/valued/short/variadic options have parsing tests. Definitions and built-in/name/option collisions are validated before registration; module imports remain trusted executable code, not a sandbox.
- `ServiceContainer` supplies synchronous singleton/scoped/transient factories, missing/cyclic dependency checks and identity-owned reverse disposal. Runner invocations and nested `context.call` each get a fresh scope/parser; recursion defaults to a maximum depth of 16. Caller-supplied containers remain caller-owned. Async factories are unsupported; unexpected thenables are observed and eventual resources cleaned, but never-settling work can block completion.
- `LifecycleRegistry` provides ordered snapshot subscriptions/unsubscribe with aggregated errors. Start failures prevent parsing but finish still runs. SIGINT/SIGTERM choose final 130/143 status, propagate an AbortSignal and clean up listeners; active handlers must cooperate and are awaited, not forcibly stopped. External abort signals propagate without automatically overriding handler exit codes. Custom definitions can opt into always-on atomic `isolation: {key?, contentionExitCode?}` using local owned lock files, explicit skip status and finally-release; there is no unsafe stale expiry or Laravel `--isolated` flag parity. Real-process stress tests cover acquire/release races and SIGKILL stale ownership.
- `createPrompts` supplies text/password/confirmation/selection/search with async validation, cancellation and fail-closed non-TTY defaults. Shared-input serialization, bounded UTF-8/typeahead, split CRLF and terminal restoration are tested; password transitions intentionally discard buffered input. Required scalar argument metadata `prompt` requests omitted values automatically, preserves required help/discovery metadata and prints missing-unprompted diagnostics before asking. Optional/variadic prompts are unsupported.
- Evidence: `src/console/command.test.ts`, `src/console/loader.test.ts`, `src/console/services.test.ts`, `src/console/prompts.test.ts`, `src/console/argument-prompts.test.ts`, `src/console/isolation.test.ts`, `src/cli/runner.test.ts`, and real generated-command/nested execution/exit/help/TTY prompting in `src/cli/compatibility.test.ts`. Real PTY tests verify password non-echo and complete terminal-flag restoration; these require Python 3/Unix PTY support in the test environment.

### Code-only generators — integrated bounded equivalents

- Public `make:class`, `make:interface`, `make:enum`, `make:exception`, `make:test`, `make:config`, and `make:command` generate usable TypeScript. Declaration/exception/test names allow slash-separated directories; config and custom commands are top-level because their loaders are nonrecursive. `make:command --command <name>` selects a validated command identity; `make:test --unit` targets `tests/Unit`. `make:trait` is explicitly a TypeScript mixin alternative, not PHP trait compatibility.
- Generators validate names/reserved types, refuse symlinked destination parents and exclusively create files without overwrite. Custom command generation preflights built-ins, aliases and existing exported command identities. Concurrent distinct-filename generation can still race on one command identity; trusted project directories must not be concurrently renamed by hostile code.
- `stub:publish` exclusively publishes twenty-five code-only `stubs/<kind>.ts.stub` templates, consumed by subsequent generators with required-token and TypeScript syntax checks. The non-source suffix keeps ordinary strict typechecking valid after publication. Existing experimental `.stub.ts` templates must be renamed, not silently migrated. Generator `--force`, arbitrary Laravel flags and unrelated domain runtimes remain unsupported.
- Evidence: `src/cli/scaffolding.test.ts` checks strict generated-code compilation/runtime behavior and unsafe paths; `src/cli/generators.test.ts` checks ordinary project typechecking after publication and actual configuration-loader consumption; `src/cli/compatibility.test.ts` runs publication/customization, config loading, custom names and generated unit tests through separate real CLI processes.

### Configuration and environment — integrated, explicitly non-Laravel formats

- `config:show [name]` loads trusted TypeScript plain-object configuration and supports dot-path selection with recursive sensitive-field, known-environment-secret and credential-URL redaction. Redaction is heuristic, not a guarantee for arbitrary unknown secrets. `config:cache` atomically publishes mode-0600 JSON, requires `--force` for replacement including creation races, and `config:clear` restores source loading. A valid disk cache wins until explicitly rebuilt/cleared; the cache is gitignored because it may contain secrets.
- `config:publish` exclusively creates only built-in `config/app.ts`, not vendor/provider manifests. Configuration is a separate API from database environment selection and explicit service registrations; no automatic long-running-process reload is implied.
- `env` reports APP_ENV/NODE_ENV precedence. `key:generate` safely updates root `.env`, with explicit `--show` as the only intentional key-printing path. `env:encrypt`/`env:decrypt` consume an explicit canonical 32-byte key from `--key` or `BUNDLE_ENV_ENCRYPTION_KEY`, retain inputs, require force to replace outputs, and authenticate before atomic plaintext publication at mode 0600.
- Encryption uses Bundle's versioned AES-256-GCM envelope, not Laravel-compatible ciphertext. Alternate ciphers/named env files, automatic bootstrap decryption, key rotation and an application auth/encryption subsystem remain unsupported. Evidence: `src/configuration/configuration.test.ts`, `src/environment/environment.test.ts`, `src/cli/operations.test.ts`, plus separate-process config/cache and encrypted-environment round trips in `src/cli/compatibility.test.ts`, all using disposable roots.

### Native testing — integrated bounded Bun adapter

- `bundle test [files...]` invokes the current Bun executable directly, streams stdout/stderr without inserting chunk-boundary newlines, preserves failure status and forwards SIGINT/SIGTERM. `--filter` maps to native regular-expression test-name filtering; `--coverage` uses native text coverage.
- `--parallel --processes <count>` uses isolated native worker processes, two by default. Tests prove overlapping execution in two distinct PIDs and isolated globals. The explicit `--parallel --isolated-databases` mode provisions a new SQLite database per worker and runs the existing SQLite migrations without changing the configured application database or migration snapshots. This opt-in setup is Linux-only; PostgreSQL/MariaDB fixtures are not provisioned, tests still own external ports/files/services, and test code is trusted rather than sandboxed. This is not PHPUnit/Pest compatibility. Additional report formats and Laravel coverage thresholds are unsupported.
- Evidence: `src/cli/testing.test.ts` runs real filtered/failing/coverage/worker fixtures; `src/cli/compatibility.test.ts` verifies real CLI execution, raw Unicode output, exact failure status and termination of a running test child. `src/testing/test-databases.test.ts` and `docs/isolated-test-databases.md` cover isolated SQLite setup, distinct worker databases, application DB/migration-source preservation, failure/cancellation and cleanup limits. The full repository suite is also exercised through `bundle test`; opt-in PostgreSQL/MariaDB live tests remain separately gated.

### Local cache and owned storage — integrated bounded backends

- `LocalCache` is a persistent namespaced JSON-value SQLite cache with millisecond TTL, any-tag invalidation and stale-tag pruning. CLI `cache:clear`, `cache:forget` and `cache:prune-stale-tags` consume `.bundle-cache/cache.sqlite` and optional trusted `config/cache.ts`; unsupported drivers/settings are rejected. Cache state is separate from ORM databases and migration/scheduler locks.
- `storage:link` and `storage:unlink` consume root-relative mappings in trusted `config/storage.ts`, preserve unrelated files/links, and record device/inode/target ownership. Creation requires real existing parents/targets; unlink handles owned dangling or changed targets, rejects substitutions and reconciles missing owned destinations. Stale lock removal requires manual inspection; no unsafe automatic expiry or hostile concurrent tree-renaming guarantee is claimed.
- Evidence: `src/cache/cache.test.ts`, `src/storage/links.test.ts`, `src/cli/local-operations.test.ts` and separate-process namespace/tag/key/link operations in `src/cli/compatibility.test.ts`. No Redis/Memcached or unrestricted filesystem parity is claimed.

### Information and console rendering — integrated bounded APIs

- `about --only environment,database,cache` selects safe application/runtime/environment/cache/database-setting sections without connecting; unselected database configuration is not evaluated. `docs [page] --list --json` inspects safe local Bundle Markdown pages; only explicit `--open` launches the platform opener without a shell. It does not fetch or execute documentation.
- `createConsoleOutput` provides semantic/color messages, sanitized bounded tables, newline progress snapshots and explicit caller-driven spinner frames. Redirected output is plain; `NO_COLOR` suppresses color. Completion and close are idempotent. Unicode width covers common wide ranges, not full terminal/grapheme shaping; no automatic background animation is promised.
- Evidence: `src/cli/information.test.ts`, `src/console/output.test.ts` and actual entry-point docs/about/rendering consumers in `src/cli/compatibility.test.ts`. These APIs do not imply an HTTP/UI framework, queue or scheduler.

### Structured logs and Pail-style inspection — integrated local backend

- `Logger` appends mode-0600 bounded JSONL records with UUID/time/severity and validated plain context under `storage/logs`; known secrets/sensitive fields/credential URLs are heuristically redacted, never guaranteed for arbitrary unknown secrets. Unsafe parents/files/hard links are refused.
- `pail` supports bounded snapshots, `--lines`, severity/regex filters, JSON and incremental follow with explicit timeout/signal cleanup. Initial lines do not cap later bursts. Watchers plus 100 ms idle rescans track offsets/inodes and complete records; rotation/truncation and intrinsically undetectable rewrite gaps are warned on stderr, separately from JSONL. No lossless audit transport, automatic retention manager, remote backend or installed Laravel Pail package is claimed.
- Evidence: `src/logging/logger.test.ts`, `src/cli/logging.test.ts`, injected-diagnostic integration in `src/cli/program.test.ts` and actual CLI snapshot/follow in `src/cli/compatibility.test.ts`. Review regressions cover burst loss, exact byte boundaries, invalid context, rotation and missed-notification recovery; repeated focused runs precede whole-suite verification.

### Code-first HTTP and executable route caches — integrated bounded runtime

- Bun-native Request/Response routing supplies literal/colon parameters, independent URL decoding, per-request state, ordered next-once middleware, HEAD/OPTIONS, sorted Allow and safe unexpected-error responses. Code-only validation bounds JSON bodies and supplies typed safe errors; explicit JSON resources/collections never automatically hide arbitrary model secrets.
- Trusted root routes are inspected with `route:list` path/method/name filters, JSON and verbose middleware metadata. `serve` defaults to loopback:8000, validates binding, reports ephemeral readiness, refuses occupied ports and owns its Bun worker. Startup cancellation handles never-settling imports; shutdown closes connections and terminates only an unresponsive owned worker after 250 ms. Signals select 130/143; unexpected worker closure fails. This is not managed reload, a production process manager or a security sandbox.
- Cacheable `defineRoutes` descriptors refer to separate safe root-relative TypeScript handler/middleware modules and optional own class methods with fresh per-request instances. `route:cache` validates/hydrates before atomic bounded mode-0600 publication; replacement requires force. Listing and serving consume the cache before directly loading the entrypoint; corruption fails without fallback. Root entrypoint references are rejected, but trusted module dependencies can import it transitively. `route:clear` preserves unrelated config/locks; running workers require restart to load changes. Closure Routers are usable but explicitly uncacheable.
- Runtime-backed controller/middleware/request/resource/rule generators emit executable code with nested relative imports and consumed custom stubs. Middleware is pass-through; schema/fields/predicates are examples, not automatic auth/model policies. Model-aware controller flags, authentication and reload remain unfinished; live maintenance is implemented separately below. Evidence: `src/http/*.test.ts`, `src/cli/http.test.ts`, scaffold/generator tests and separate actual CLI/server/cache/generated-code consumption in `src/cli/compatibility.test.ts`; see [the HTTP guide](docs/http.md).

### Live maintenance and bootstrap optimization — integrated local operations

- `down`/`up` control persistent bounded versioned mode-0600 state that the HTTP worker reads before every request. The same live listener blocks with no-store JSON503 and optional bounded retry/refresh headers, then resumes without restart. Canonical root aliases work; unsafe permissions, corrupt/unowned state, symlinked parents/files and foreign/stale mutation locks are preserved for manual inspection. No secret bypass, rendered markup, alternate status or redirect options are implied.
- `optimize`/`optimize:clear` invoke the real configuration, executable route and executable event caches, reporting every completed/failed/explicitly unconfigured target. All targets are attempted after ordinary errors, any failure chooses a nonzero status, trusted exception text is not echoed and partial writes/removals remain visible. Force is required for cache replacement. Clear preserves application cache data, maintenance state and unrelated locks/files; it is not a transaction or a no-op alias for excluded PHP artifacts.
- Evidence: `src/maintenance/*.test.ts`, `src/cli/maintenance.test.ts`, canonical-root HTTP integration, and actual CLI down/up and aggregate cache consumption/clear/partial failure in `src/cli/compatibility.test.ts`. See the HTTP and console guides. Fixed trusted imports retain Bun ESM caching; changed-source cache rebuilds use a fresh CLI process, not in-process hot reload.

### Local events and executable registration cache — integrated bounded runtime

- `EventBus` provides sequential snapshot dispatch, payload/signal delivery, registration-owned idempotent unsubscribe, named listener introspection and ordered aggregate failures. Cancellation awaits active work and skips later listeners without itself throwing. Explicit branded `events.ts` descriptors resolve safe trusted TypeScript exports and own class methods with fresh instances. No automatic payload validation, durable delivery, queued dispatch or listener dependency injection is implied.
- `event:list` reports both events and listener identities without invoking listeners. `event:cache` atomically publishes bounded mode-0600 executable references, and valid cache precedence is consumed by real next-process dispatch. `event:clear` validates format before scoped idempotent removal, preserving corrupt/unrelated content and other caches/locks. Direct entrypoint references are rejected; trusted transitive imports and normal ESM caching remain explicit. Existing buses/running services are not hot-reloaded.
- `make:event` and `make:listener` exclusively emit nested code consumed by the bus. Stable event identities include every namespace segment, preventing basename cross-delivery. Twenty published stubs include required event/runtime tokens and customized listeners; actual next-process cached dispatch proves payload delivery and namespace separation. Registration is explicit; event:generate and queued listeners remain unfinished.
- Evidence: `src/events/*.test.ts`, `src/cli/events.test.ts`, generator/scaffold tests and separate CLI inspection/cache/generated dispatch/clear in `src/cli/compatibility.test.ts`; see [the event guide](docs/events.md). Local callbacks do not imply durable delivery; the separate queue backend is described below.

### Durable local jobs and owned consumption — integrated bounded runtime

- Dedicated private owned SQLite at `.bundle-queue/queue.sqlite` persists lossless bounded JSON job references, priority/FIFO/delayed availability, atomic random owner receipts, lease heartbeat/expiry recovery, stored attempt policy and failed-job retry/deletion. It is independent of ORM databases/DB_CONNECTION; unsafe/unrelated files/schema/sidecars are refused. Lease-sensitive clocks are sampled after acquiring immediate write locks, verified with real contention barriers. Delivery is at least once, not exactly-once effects or multi-host evidence.
- `queue:work` executes trusted function/own class-method jobs in fresh owned Bun workers, delivering payload/AbortSignal with bounded timeout/cancellation and sanitized outcomes. Only current unexpired receipts acknowledge/settle; lost heartbeat stops owned execution without inventing success. Cancellation refunds/requeues even at the last attempt; failed settlement distinguishes retry from permanent failure. Priority, once/stop-when-empty/max-jobs, idle sleep and backoff are supported. Timing flags use milliseconds; producer maxAttempts supplies the default, and optional --tries1–100 atomically persists a chosen budget on newly considered eligible work.
- `queue:failed --limit 1..1000 --after <id>` pages through ascending failure IDs with generic metadata and explicit continuation, never raw payloads/exception messages. Deleted cursors do not cause offset skips; pages are live queries, not frozen snapshots. Bad queue/cursor/size options refuse before storage creation. `queue:retry <id>` resets one failed job; force-required `queue:forget <id>` removes only a failed row, with explicit missing-ID results. Signals select 130/143 and release/refund active cancellation. System-service self-respawn, batches, server/Redis adapters and queued events remain unfinished; persisted pause/resume/graceful restart and owned listen child cycles are described below.
- Evidence: `src/queue/*.test.ts`, `src/cli/queue.test.ts` and actual CLI execution/acknowledgment, priority limits, failure/retry/forced deletion and SIGINT/SIGTERM reclaim in `src/cli/compatibility.test.ts`; see [the queue guide](docs/queues.md). Tests use disposable local state; worker isolation is not a sandbox or cleanup of application-spawned processes.

### Generated jobs, queue snapshots and explicit cleanup — integrated local operations

- `make:job` exclusively emits nested own-method examples under `src/jobs`, consumed through persisted real CLI execution. Sixteen published stubs include customizable job output. The generator shares the queue's descriptor validation before writing, refusing exports above 128 characters or final module paths above 512; exact accepted boundaries enqueue/reserve/execute/ack. Job middleware and automatic registration/dispatch are not implied.
- `queue:monitor --queue <name>` reports disjoint ready/delayed/reserved/expired/failed counts. An optional maximum compares nonfailed counts; equality succeeds, exceeding emits real local cached `queue.busy` metadata and exits nonzero. No payloads/reasons are exposed; listener failures are sanitized. This is a snapshot command, not a monitoring daemon, durable notification or Redis/Horizon evidence.
- Force-required `queue:clear <queue>` deletes only unreserved ready/delayed jobs, preserving live and expired receipts, failed history and other queues. `queue:flush` and `queue:prune-failed` require exactly one explicit queue/all scope; pruning uses a strict before-epoch-ms cutoff. Invalid inputs/selections and absent force refuse before opening storage. Existing schema/ownership/lease APIs remain unchanged; no automatic retention or all-job reset is implied.
- Evidence: `src/queue/operations.test.ts`, `src/cli/queue-operations.test.ts`, generator tests and actual CLI pages/cursor deletion, threshold event cache consumption, scoped clear/strict prune/flush/refusals in `src/cli/compatibility.test.ts`. Independent review reproduced the generator-length mismatch and regression-first repair/re-review passed; queue operations had no verified scoped findings. See [the queue guide](docs/queues.md) for limits and programmatic contracts.

### Atomic retry overrides and live worker controls — integrated local contracts

- Optional `queue:work --tries1–100` chooses an atomic persisted budget for newly considered eligible candidates. Lower limits classify exhausted work without extra execution; higher limits can recover expired candidates before applying old exhaustion. Omitted overrides retain the stored producer/previous policy. Live/unselected/future work is protected, cancellation refunds its attempt but retains policy, and retry resets attempts. Exhaustion is lazy/selected, not a global sweep; timeout/backoff/sleep remain milliseconds.
- Persisted root-scoped `queue:pause`/`queue:resume` affect named queues at claim boundaries. `queue:restart` changes a generation, letting active work settle before successful exit without another claim; a new consumer baselines the latest token. Paused work is currently ineligible for once/stop-when-empty. Poll delay and read-to-claim races are explicit; this is not atomic global freeze, active-job cancellation, self-respawn or queue:listen supervision.
- Private bounded version1 control state uses owned nonexpiring mutation locks and atomic publication, canonical roots, strict keys/queue limits/permissions and corrupt/unsafe preservation. Normal atomic replacement/first-publication reader races use bounded retries; persistent unsafe state or exhausted retries fail closed rather than defaulting clean. Independent concurrency repair re-review observed zero errors across28k reads/3k pause-resume replacements, versus2336 before; actual idle CLI subsequently consumes and acknowledges real work.
- Independent review also reproduced an already-expired claim after a long exhaustion scan. Regression-first repair uses ID-keyset progress, a fresh publication clock after scanning/receipt generation and SQL due/expiry rechecks, including backward-clock ownership protection. Reviewer10k-candidate reproduction improved from1682ms/expired ack to14ms/valid ack; post-publication stalls can still consume lease time. Evidence: `src/queue/retry-policy.test.ts`, `src/queue/control.test.ts`, CLI tests and actual priority/tries/timeout/cancellation/live-control/concurrent-publication processes in `src/cli/compatibility.test.ts`. These are bounded local tests, not exhaustive scheduling or multi-host proof.

### Durable command dispatch, job middleware and fresh worker children — integrated local contracts

- `dispatchCommand({root,argv,queue?,availableAt?,maxAttempts?,middleware?})` snapshots bounded explicit arguments/references before opening private queue storage. A disjoint version1 command envelope preserves the jobs schema and legacy module jobs; owned execution invokes the real rooted runner with fresh scopes, noninteractive prompts, discarded injected I/O and optional finished commandExitCode. Actual CLI cases cover deferred discovery, exact argv/no shell, built-in generation, nonzero retry/exhaustion/source-change recovery, timeout and cooperative cancellation/refund. Returned130/143 alone is failure, not cancellation. No environment/services/closures are serialized; argv is stored unredacted and trusted direct output/subprocesses remain possible. Upgrade consumers before producing new envelopes.
- Invalid stored JSON/descriptors now decode to nullable reservation/failed job values, fail generically under normal receipt/attempt accounting and retain raw SQLite text for inspection. Independent review reproduced the old first-row parse failure rolling back claims and starving later work; regression-first repair and independent re-review verify later consumption, history, cancellation refund and raw retention without an invented executable or database reset.
- `make:job-middleware` emits safe nested pass-through functions with computed imports and a consumed seventeenth custom stub; descriptor export/module bounds are checked before output. Up to16 strict executable references persist with module or command jobs and run inside the owned worker, with fresh own-method instances, ordered next-once nesting, awaited downstream and shared timeout/cancellation. No-next intentionally acknowledges without invoking the target. Native-Promise next always propagates downstream failure even when locally caught; explicit next.recover(handler) permits only successful module recovery and is itself awaited. This deliberate Bun contract avoids ambiguous Promise-observation heuristics; nonzero command status cannot be recovered into success. Actual generated/customized persisted middleware, failure/duplicate/short-circuit/timeout and explicit recovery cases execute; independent recovery re-review passed.
- `queue:listen` starts one fresh owned rooted queue:work --once Bun child per cycle, validates before starting and forwards raw bounded-decoded streams without accumulating output. max-cycles counts invocations (including empty/paused cycles), and sleep applies every cycle. Nonzero child exits fail closed. Restart generation is observed between children after active settlement; cancellation/output failure terminates/reaps only the owned child with1000ms escalation. Regression-first repairs cover root aliases, throwing writers and inherited grandchild pipes;250ms post-exit drain then reader cancellation prevents hangs but can lose late output. No process-group cleanup/service self-respawn, forced restart of hung active imports, Redis or multi-host guarantee is claimed. Independent lifecycle review and actual fresh-PID/restart/SIGTERM entry-point cases passed.
- Leader verification before ledger credit:581 passing tests,2 opt-in live-database skips,0 failures; strict types133 and79 registered built-ins. Documentation and evidence are in `docs/queues.md`, dispatch/middleware/listener tests and `src/cli/compatibility.test.ts`. Broader scheduling/auth/providers/batches/adapters and live-service verification remain unfinished; these local contracts are not full Artisan parity.

### Deny-default policies and explicit HTTP authorization — integrated local contracts

- `make:policy` emits nested own-can classes with computed aliased runtime imports and an eighteenth consumed stub. Default policies deny; custom async policies consume explicitly resolved principal/resource/ability/signal. `evaluatePolicy` requires strict boolean decisions, `authorizePolicy` throws generic denial, and explicit `policyMiddleware` returns no-store JSON403 before handlers. Invalid/throwing decisions become Router-sanitized500 without private data; unrelated downstream failures are not disguised as denial.
- Independent review reproduced cancellation between evaluation completion and caller continuation, allowing an already-aborted handler to run. Both nested-microtask regressions were observed red before immediate post-await signal checks repaired the callers. Independent re-review reproduced aborted/rejected authorization and no handler invocation; no remaining verified scoped defect. Cancellation remains cooperative, not forced termination of trusted application work.
- Actual CLI/live HTTP tests consume default/customized generated policies, verify owner/guest/other decisions, strict imports/stub customization/no overwrite and fail-closed errors. Fresh leader full verification:593 pass,2 opt-in live-database skips,0 fail,15211 assertions across64 files; strict types135,80 registered built-ins, graph freshness and whitespace pass before ledger update. This is authorization only: no authentication/session/token verification, trusted header identity inference, automatic route protection or model-aware installer flags. See `src/http/authorization.test.ts`, generator tests, `src/cli/compatibility.test.ts` and `docs/http.md`.

### Explicit local text-mail and notification adaptation — integrated bounded delivery

- `make:mail` and `make:notification` emit nested classes with computed aliased imports, consumed custom stubs and no implicit sending; twenty published templates compile under ordinary strict checking. Explicit sendMail/sendMailable and notifyMail consume copied/frozen closed text-message data and injected transports. LocalOutboxMailTransport persists version1 JSON privately under gitignored `.bundle-mail/outbox`, separately from ORM databases/logs/queues. Acceptance is local persistence only, not SMTP/inbox delivery, authentication, notification-table history, extra channels, attachments or markup.
- Bounds include1–32 conservative ASCII mailboxes,320-byte addresses,998-byte control-free subject,64KiB body and128KiB whole message/record. Unsafe/private filesystem state refuses without reset or body/recipient diagnostics. Complete file plus relevant directories sync before receipt, conditional on OS/filesystem fsync guarantees; no power-loss simulation or atomic hostile tree-replacement claim. Explicit read exposes content only to its caller; list returns bounded filesystem-order metadata and iterate streams caller-controlled traversal. Neither is a stable snapshot/cursor. Matching incomplete two-link publications are omitted, unrelated hardlinks refuse; stale crash remnants require inspection.
- Regression-first repairs cover temporary inode substitution, abort-after-link, unbounded/ordinary1001-message listing failure, normal concurrent publication listing, record-limit mismatch and missing directory sync. Independent repair re-review reproduced all four later findings resolved, including1001-message traversal and paused real publication; no remaining verified scoped important defect. Actual separate CLI processes consume generated/default/custom mail and notifications, lossless content, no overwrite/private modes and invalid-header refusal. Evidence: delivery runtime/tests, generator tests, `src/cli/compatibility.test.ts`, `docs/mail.md`. Final leader pre-ledger verification641pass/2 opt-in live-database skips/0fail,15487 assertions across71 files/types149; graph freshness/whitespace pass,85 registered built-ins.

### Bounded UTC command scheduling — integrated local execution

- Trusted root schedule.ts exports bounded copied/frozen explicit id/argv/expression/UTC/overlap definitions. Deterministic five-field numeric UTC cron supports wildcard/range/list/positive wildcard-range steps and explicit restricted day/weekday OR; no IANA/DST, seconds/macros or next-date search. schedule:list exposes safe due metadata without argv/handler execution. schedule:run executes exact due argv via real rooted runCli with fresh scopes, noninteractive prompts/discarded injected I/O and conditional status; no shell or queue. Nonzero remains failure, later due work continues; actual cancellation skips later handlers.
- Default skip overlap uses versioned per-task lock records with PID-namespace/PID/Linux process-start/token identity; creation and cleanup serialize through a private non-expiring mutation gate. Explicit `schedule:clear-cache --force` removes only verified stale new-format locks in the current PID namespace on Linux, retains active owners, refuses different-namespace/corrupt/unsafe state, and preserves/skips generic and legacy token-only locks whose owner/type cannot be verified. A busy or crashed mutation gate remains for inspection. Explicit allow bypasses overlap locking. Foreground schedule:work evaluates newly observed minute slots with in-process high-water deduplication, finite polling controls and bounded result counts. Backward clocks do not replay; missed minutes are not backfilled. SIGINT/SIGTERM cooperate and return130/143; uncooperative trusted imports/commands are not forcibly terminated. No persistent once-only/restart history, background finish, service supervisor or multi-host guarantee. Persisted controls and selected task execution were integrated later as recorded below.
- Independent review reproduced import side effects after cancellation during root resolution and scheduler overriding embedding handleSignals:false. Both regressions observed red before post-await cancellation and option propagation repairs. Independent re-review confirmed absent import marker and host-owned signal/status0, focused17 tests96 assertions; leader actual list/run/work/SIGTERM tests3pass21 assertions. The new lock suite verifies live-owner preservation, stale identity removal, malformed/legacy state preservation and busy-gate refusal; CLI tests cover explicit force and JSON outcome. Evidence: `src/schedule`, `src/cli/schedule.test.ts`, actual CLI compatibility tests and `docs/scheduling.md`. Ordinary fixed imports/CLI discovery retain trusted ESM/cooperative limitations.

### Persisted scheduler pause, resume and graceful interruption — integrated local controls

- `schedule:pause`, `schedule:resume` and `schedule:interrupt` mutate separate private version1 `.bundle-schedule/control.json`, consumed by actual observing run/work before source import and between handlers/polls. Paused due tasks report skipped-paused without handler/overlap lock; resume allows future observed slots or a new explicit run, not backfill. Interrupt changes generation, waits for active trusted work to settle, skips later tasks and lets a new consumer baseline the latest token. Existing command failures remain failures. It is not force-cancellation, a service supervisor, atomic global freeze/claim or multi-host guarantee.
- Strict owned0700/0600 bounded closed JSON and nonexpiring identity-owned mutation locks preserve unsafe/corrupt/foreign state for inspection. Atomic publication readers retry unstable snapshots rather than killing healthy consumers. Native errors are generic. First-publication pause initially masqueraded as interrupt; leader regression observed cycles1/interrupted versus expected continued skipped-paused work before a stable absent UUID sentinel repaired it. Only explicit interrupt changes that token. No power-loss transactional durability, hostile concurrent tree-replacement defense or automatic stale unlock is implied.
- Actual separate CLI processes prove persisted pause/resume affects due markers, active interruption waits for settlement and skips later work, new consumers baseline it, private modes and no ORM coupling. Independent read-only review found no verified scoped defect; focused18 tests and actual2 process cases passed. Fresh leader pre-ledger full verification654pass/2 opt-in live-database skips/0fail,17196 assertions across73files/types153; graph freshness/whitespace pass and88 measured built-ins. Evidence: `src/schedule/control.test.ts`, `runner.test.ts`, `src/cli/schedule-control.test.ts`, actual compatibility tests and `docs/scheduling.md`. Selected schedule:test was integrated later below; background finish/safe stale-cache clearing, timezone/DST and broader backlogs remain unfinished.

### Consumed native factory, custom type, query helper and observer — integrated database generators

- `make:factory --model` emits a native MikroORM Factory with computed model import, readonly model and explicit copied attributes; no inferred defaults/Faker. `make:cast` emits an explicitly mapped native string Type with example trim/preserve conversion; `make:scope` emits a real bounded em.find helper, not an automatic Eloquent global scope; `make:observer` emits an explicitly registered native EventSubscriber with an example afterCreate counter. Generation does not import model source, connect to a database or edit mappings.
- Bounded top-level model preflight validates syntax/exports and distinguishes real local class declarations/aliased exports from lexical decoys. Independent review reproduced separate-export false rejection, string-decoy false acceptance and postfix ++/-- division false rejection. Each was regression-first repaired, and final independent re-review accepted valid real User sources/separate exports while rejecting decoys, with no further verified scoped defect. This is not runtime metadata/schema validation or a complete JavaScript parser guarantee.
- Actual separate CLI processes generate all four and consume them through disposable SQLite persistence: factory persist/flush, mapped custom type roundtrip, explicit query filtering and registered observer delivery. Default/custom templates, strict compilation, collisions, bounded references and no-overwrite/symlink refusal have evidence. See `src/cli/model-preflight.ts`, generator tests, actual compatibility tests and `docs/native-orm-generators.md`. No live-server/Eloquent command/flag parity implied.

### Cache table migration schema — partial foundation

- `make:cache-table` exclusively generates dialect-specific SQL for `bundle_cache_entries` and `bundle_cache_locks`, with namespace/key composite primary keys and expiry indexes. Generation uses the selected migration target with ORM connection disabled. SQLite migration application and duplicate-key rejection are exercised; subsequent model-diff generation skips these infrastructure tables to avoid destructive drops, and `migrate:fresh` refuses them as unmapped. PostgreSQL and MariaDB have renderer-only tests, not live database verification.
- This does not implement a database-backed cache runtime. Existing `LocalCache` remains a separate `.bundle-cache/cache.sqlite` store and does not consume these tables; keep the Artisan reference item partial until an actual adapter/runtime consumes the schema and its semantics are tested. See `src/database/cache-table.ts`, `src/database/cache-table.test.ts`, `src/cli/program.test.ts` and `docs/database.md`.

### Session table migration schema — partial foundation

- `make:session-table` generates dialect-specific `sessions` table SQL with primary-key id, optional user id, IP address, user-agent, payload and last-activity fields plus lookup indexes. It uses the selected migration target without connecting during generation; SQLite migration/application, key fields, model-diff exclusion, rollback preservation and fail-closed fresh-reset behavior are tested. PostgreSQL and MariaDB have renderer-only tests.
- This is schema only, not an HTTP session store, cookie/session-id lifecycle, expiration policy or authentication system. Keep the reference partial until a secure consuming session runtime and its expiry/rotation/concurrency behavior are implemented and tested. See `src/database/session-table.ts`, `src/database/session-table.test.ts`, `src/cli/program.test.ts` and `docs/database.md`.

### Explicit and interactive scheduled-task testing — integrated selected execution

- `schedule:test --task <id>` or existing injected/real terminal selection invokes exactly one configured task even when not due, with real effects rather than a dry run. Choices expose ids only; missing non-TTY input, empty registry, unknown/invalid/non-member selections and cancellation after prompting refuse without a handler. The selected runtime reuses local overlap ownership, persisted pause/interrupt, exact command status and cooperative signals, while nested commands retain noninteractive prompts/discarded injected output.
- No source edits, automatic unpause, high-water advancement, durable once-only record or shell evaluation. Direct scheduler-test recursion refuses before locks. Actual explicit and Linux PTY selection cases pass alongside adapter/failure/cancellation/lock/control coverage. Independent review found no verified defect and independently passed19 focused tests70 assertions plus2 actual cases9 assertions. See `src/schedule/runner.ts`, schedule CLI/tests and `docs/scheduling.md`; timezone/DST/background finish/stale mutex clearing remain unfinished.

### Explicit local providers and consumed provider generation — integrated application lifecycle

- Strict copied/frozen bounded root providers.ts references select trusted own-hook classes. Outer runCli registers all then boots all before command scopes/imports; nested calls share initialized services without repeated bootstrap. Command scopes settle before reverse provider disposal and owned singleton disposal. Failure cleans instantiated providers generically; caller containers stay caller-owned. Nonempty automatic registries with caller-supplied containers refuse rather than leaving live registrations bound to disposed providers; explicit backend/build-only composition is documented.
- `make:provider` emits a consumed class with computed aliased imports and a namespaced singleton example changed by boot. Root registration is explicit; no import-time registration, package discovery or manifest edits. Twenty-five total code-only stubs are consumed, including provider required name/runtimeImport/serviceKey tokens. Actual default/custom generated providers strictly compile and resolve booted services through real CLI commands without ORM coupling.
- Independent review reproduced signals removed before cleanup and throwing diagnostic sinks skipping command scopes. Leader observed those regressions and a container-cleanup sink regression red, then retained signal ownership through cleanup and moved scope/finish/owned cleanup ahead of diagnostics. Final independent re-review reproduced scope/finish/provider order and SIGTERM143; no remaining verified scoped defect. Actual SIGINT/SIGTERM during asynchronous provider cleanup allow all owned disposal before130/143. Hooks/imports remain trusted/cooperative, fixed Bun ESM caching and ordinary filesystem limits apply.
- Fresh leader pre-ledger verification705pass/2 opt-in PostgreSQL/MariaDB skips/0fail,17763assertions across75files; strict types157. Final source/graph/provenance verification and measured command counts are recorded in the loop checkpoint. Evidence: `src/console/providers.ts`, provider/runner/generator tests, `src/cli/compatibility.test.ts` and `docs/providers.md`. No downloads, service provisioning, real application database resets or broader100% claim.

### Source-driven registered event generation — integrated consumed listeners

- `event:generate` reads trusted source defineEvents registrations rather than stale cache, fully preflights128events/256references, deduplicates paths and exclusively creates missing conventional src/listeners PascalCase own-handle classes from consumed default/custom stubs. Existing checked regular single-link files stay byte-identical, even with force; missing unsupported function/path/export/method shapes, unsafe parents/files and invalid templates refuse before outputs. Named string events need no fabricated event class; make:event remains optional producer scaffolding.
- Actual separate CLI processes strictly compile generated default/custom classes, build a real event cache and dispatch without changed-source fallback; a custom listener writes only when dispatched. Source/cache/existing output are preserved. Independent review found no verified defect; boundary256/257 and dangling/hardlink refusal coverage passed. Publication is not a multi-file transaction: later filesystem I/O failures may leave earlier new files while reporting failure, without overwrite/rollback/hostile-path guarantees. See `src/cli/event-generation.ts`, generator/event tests, actual compatibility tests and `docs/events.md`.

### Explicit discovered package metadata — integrated cached provider consumption

- `package:discover` reads trusted root packages.ts, validates32unique named packages/64total provider references and preflights referenced module paths without importing their code in the builder. It publishes owned private0600 bounded strict version1 bootstrap/cache/packages.json with duplicate-key/fatal-UTF8/path/mode/link checks; force is required to replace valid metadata. package:clear removes only valid owned package metadata, preserving unrelated/unsafe state. No arbitrary installed-dependency scan, downloads, vendor assets or installer is implied.
- Cached provider references append to direct root providers through shared duplicate/bound validation and actual outer lifecycle, even without providers.ts. Ordinary startup never imports packages.ts or falls back from invalid metadata. Caller-container and pre-abort ownership boundaries remain; unsafe bootstrap can prevent all public commands until inspection/recovery, not a secret repair bypass. Existing root/cached providers may normally boot before discover/clear actions; the builder's no-provider-execution guarantee does not bypass earlier ordinary startup.
- Independent review reproduced dropped CLI cancellation; leader deterministic import-abort regression red then signal propagation repaired. Worker final-prepublication abort regression and legitimate replacement's now-unlinked inode false refusal were also observed red before immediate commit-boundary check/bounded reader retry repairs. Final independent re-review reproduced status1/no publication for aborted embedding and found no further verified defect; first-link/replacement stress is coverage, not proof all interleavings. Atomic publication is a commit point, not cancellation rollback.
- Actual CLI processes prove discovery/cache-provider boot without package-source fallback, duplicate/unsafe metadata fail-closed behavior, explicit clear/no DB, and SIGINT/SIGTERM cancellation preserving prior metadata or absence. Fresh leader pre-ledger full737pass/2opt-in live-database skips/0fail,17993assertions across79files/types165. Final source/graph/provenance results are in the loop checkpoint. See `src/packages`, package/provider/runner tests, `src/cli/compatibility.test.ts` and `docs/packages.md`. Broader authentication/session, vendor publication/installers, queue batches, language resources, remaining scheduling and live-service work remain unfinished.

### Local language resources — integrated code-only text consumption

- `lang:publish` exclusively creates mode0600 lang/en.ts from the bundled English catalogue without importing existing content or overwriting translations, including with force. Explicit translate/loadMessages APIs validate copied/frozen flat catalogues and bounded Unicode replacements; missing English source uses bundled text, English overrides merge, and other locales require explicit local source without cross-locale fallback. Missing keys, missing/unused placeholders and invalid shapes refuse generically. No markup, pluralization, locale detection, downloads or extra stub is implied.
- Key/options/replacement validation and snapshots precede trusted fixed-URL imports. Sources/parents reject unsafe links and bounded data controls/bytes; canonical root aliases retain ordinary Bun ESM lifetime. Actual separate CLI processes publish and strictly compile a catalogue, consume default and customized Unicode overrides, preserve existing translations with force, refuse unsafe locale before source import and leave database storage absent. Later exact boundary/snapshot/lifetime coverage is not individually red-proven. Independent backend/integration review found no verified defect;13focused67assertions and2actual15assertions passed.
- Fresh pre-ledger full752pass/2opt-in live-database skips/0fail,18302assertions across82files/types171; graph/whitespace passed before this source update. Final source/provenance results are in the loop checkpoint. See `src/localization`, `src/cli/language.ts`, actual compatibility tests and `docs/localization.md`. Authentication/session, vendor publication/installers, queue batches, remaining scheduling and authorized live-service evidence remain unfinished.

### Code-only vendor publication — integrated resource consumers

- `vendor:publish` explicitly reads trusted version1 publish.ts manifests with bounded immutable128asset/32package definitions; package/tag selection intersects, all is explicit, no selection refuses before import. Safe selected config/language/JSON/text sources are copied as bytes without asset import; real existing consumers validate and execute published files later. Full source/destination/ancestor/conflict preflight precedes exclusive mode0600 output; existing targets are preserved even with force. No dependency scan/download, PHP/Blade/UI assets, installer or new stub is introduced.
- Worker destination-ancestor collision regression observed an earlier file creation before failure, then repaired complete selected-pair preflight in both orders before directory creation. Independent review reproduced valid .d.json/.d.txt wrongly rejected by an overbroad declaration-extension check; leader actual CLI regressions failed red, then declaration-only .d.ts refusal was repaired and independently re-reviewed. Later exact byte/path/count, snapshot, fixed-import lifetime and fixture cleanup coverage is not individually red-proven. Final independent review found no remaining verified finding.
- Actual CLI processes strictly compile published TypeScript, consume config:show/explicit locale translation/JSON, prove asset source is never imported by copying, preserve conflicts/targets despite force and sanitize trusted manifest errors. Event-driven SIGINT/SIGTERM manifest-import cases return130/143 without output or database storage. Leader22focused75assertions/8actual46assertions/types176 passed. Fresh pre-ledger full782pass/2opt-in live-database skips/0fail,18284assertions across84files; graph/whitespace pass and99measured built-ins. Later I/O/cancellation may leave earlier new outputs while reporting failure; no multi-file transaction, hostile tree replacement, power-loss or sandbox guarantee. Final provenance gates are recorded in the loop checkpoint. See `src/publication`, CLI/publication tests, actual compatibility tests and `docs/publication.md`.

### Model-associated resource controllers — integrated native HTTP persistence

- Paired make:controller --resource/--model preflights a safe existing top-level model source without executing/importing it, connecting DB or editing mappings. Default/custom controller-resource.ts.stub emits five own index/show/store/update/destroy methods with aliased computed imports; ordinary handle controllers stay unchanged, paired/unrelated flags and unsafe sources/targets refuse. Twenty-six total code-only stubs are consumed. Explicit model-resource middleware requires model/manager/id/validation/serializer callbacks; it isolates a fresh native ORM fork per request and clears only its owned fork, preserving caller pending state/ORM ownership.
- Native bounded index100/JSON1MiB and scalar-key CRUD persist through explicit field validation and selected serialization; missing keys404, invalid IDs400, primary updates refuse, validation responses400..499 remain no-store. No inferred routes/auth/fields, composite keys, transaction, committed-write rollback, soft deletion or external/live-driver equivalence. Actual default/custom generated code strictly compiles and serves live local SQLite HTTP CRUD, then cached own index/show hydrate without source fallback; caller state, model bytes and no generation DB/import side effects are checked.
- Independent review reproduced missing no-store on sanitized500 and double-microtask completion-abort returning200/entity JSON after abort. Leader4native regressions red before shared Router500 header and caller-side post-await checks; independent exact original probes now500/no-store/generic without entity data and no further verified scoped finding. Leader90combinedfocused582assertions/3actualresource-and-shared-inventory37assertions/types178 passed. Full initially803pass/2skip/1failure from a stale provider-stub25 expectation; corrected to26, focused provider3pass21assertions, then fresh full804pass/2opt-in live-server skips/0fail,18379assertions across85files/types178 and graph/whitespace passed before this ledger. Expected unrelated-option refusal prints an unknown --resource diagnostic, not a failing test. Final source/provenance gates in loop checkpoint. See `src/http/model-resource.ts`, native/Router/generator tests, actual compatibility tests and `docs/model-resources.md`.

### Durable batch accounting — integrated local worker controls

- `dispatchBatch` validates/snapshots1–128 closed mixed module/command entries with1MiB total encoded jobs before filesystem awaits; private schema2 atomically publishes jobs and durable membership. Ack/settle/fail/exhaustion/clear/retry/history mutations retain truthful counts after job deletion. Existing exact schema1 refuses ordinary opens until explicit opt-in or force-guarded queue:upgrade after ALL old processes stop; ready/delayed/live/failed/corrupt raw fields remain intact. Foreign/altered schema is preserved, not reset; mixed-version operation is unsafe. Existing job envelopes and individual producer return values stay unchanged.
- `queue:batch` exposes generic persisted counts; explicit cancel prevents new claims but preserves live owners, allows active success and settles later failures as terminal cancelled. Ordinary worker-signal cancellation still refunds/releases. queue:retry-batch atomically reopens only retained noncancelled failures; forced queue:prune-batches uses strict epoch-ms terminal cutoffs, detaches retained failures and preserves pending/live/unrelated jobs. Eight actual entrypoint tests consume generated default-filled/custom jobs and real commands, failure/retry, live success/failure cancellation, SIGTERM refunds, explicit upgrade and pruning without application DB side effects. No callback/chains, ORM batch-table adapter, forced side-effect rollback, Redis/Horizon, exactly-once or multi-host claim.
- Independent review found inherited SQL LIKE underscore wildcard ownership filtering accepted lookalike foreign objects. Leader9benign queue/cache rejection regressions failed red, then literal GLOB-prefix repair and independent re-review preserved foreign state while accepting legitimate SQLite internals; no remaining confirmed scoped issue. Later full legacy-field/refusal, transaction-failure, clock rollback and reopen coverage is not individually red-first. Leader120queue/cache/CLI8708assertions +8actual118assertions/types183 pass; fresh repaired pre-ledger full849pass/2opt-in live-server skips/0fail,18862assertions across89files, graph/whitespace pass. Final source/provenance gates are in the loop checkpoint. See `src/queue`, `src/cli/queue-batches.ts`, backend/schema/transaction/actual CLI tests and `docs/queue-batches.md`. The separate make:queue-batches-table reference stays pending without a consuming ORM adapter; broader auth/session, installers, scheduler/adapters/database/live-service work remains unfinished.

### Explicit native model pruning — integrated bounded SQL deletion

- `model:prune` consumes a bounded copied/frozen branded root pruning.ts registry with explicit model/where rules, no model scanning or traits. Preview counts without framework deletion; every real invocation requires global force before source import/target resolution. ONE selected target resolves per invocation; SQLite must already be a regular single-link nonsymlink file, never implicitly created. Native SQL manager forks preserve caller pending state/ORM ownership; all selected metadata/predicates preflight before deletion, then finite ascending mapped keys are consumed in bounded per-rule/chunk limits with original eligibility and native filters rechecked.
- Native bulk deletion skips per-entity hooks; database cascades/triggers retain effects and counts describe direct targets. Active-chunk rollback cannot undo earlier commits; after-commit cancellation refuses success but preserves committed rows. Actual default/named disposable SQLite entrypoints verify preview, force, scope, multi-chunk limits and reopen preservation; refusal/lifecycle/source/metadata/filter/mapping/cascade/hook/cancellation tests complement consuming behavior. No Eloquent hooks/traits, whole-run transaction, hostile-code sandbox, automatic rules or expanded live PostgreSQL/MariaDB evidence is implied.
- Missing command was observed red before registration. Native BigIntType refusal and independently verified above-safe-integer SQLite precision findings were reproduced before repairs; exact quoted mapped-column text projection now preserves bigint keys, with neighboring-key regression and accepted independent re-review. Later coverage is not all individually red-first. Initial full diagnostic865pass/2skip/2fail also exposed a host-NO_COLOR-sensitive console test; explicit test-env injection repaired it without weakening production NO_COLOR semantics. Fresh repaired pre-ledger full879pass/2opt-in live-server skips/0fail,18932assertions across93files/types190, graph/whitespace pass and105measured built-ins. Final source/provenance gates are recorded in the loop checkpoint. See `src/database/pruning*.ts`, CLI/model-prune tests, actual compatibility consumers and `docs/model-pruning.md`.

### Explicit development processes — integrated foreground command group

- Root dev.ts exports a bounded copied/frozen branded registry of explicit names/argv shared by dev:list and dev. Listing never invokes configured commands; trusted source import still executes and argv are intentionally visible, so secrets must not be placed there. Native rooted Bun children use a fixed package runner, no shell/executable override, automatic registry scan, package installation or background service defaults. Up to8 children stream output and settle as one foreground group; first child exit0/nonzero stops peers and determines normal status, real SIGINT/SIGTERM yield130/143. Generated applications configure explicit API and Vite frontend children; their readiness/HMR integration remains unverified.
- Owned shutdown escalates after1000ms and drains inherited pipes at most250ms; startup/output failure reaps started owned children, never claims process-group/descendant cleanup, background service management, readiness, self-respawn or managed reload. Child marker refuses accidental nested dev before source import. Actual entrypoint missing-command red preceded registration;5actual consumers22assertions cover listing without execution, shared registry side effects, first-exit0/7 and real signal reaping. Backend14tests40assertions include later bounded pipe/spawnfailure/snapshot coverage; CLI5guards15assertions. Independent review found no verified issue.
- Fresh combined repaired pre-ledger923pass/2opt-in live-server skips/0fail,18869assertions across98files/types198 and graph/whitespace passed; final source/provenance gates recorded in loop checkpoint. Only dev:list receives original reference credit; broader dev multi-tool/Vite environment stays partial. See `src/development/processes.ts`, CLI/development tests and `docs/development.md`.

### Verified SQLite tracking uninstall — integrated force-guarded history-only removal

- migrate:uninstall preview inspects without history initialization; real removal requires global force before one existing SQLite target resolves/opens. Conservative exact native history DDL, mapped-name, view/index/trigger/inbound-FK/dependency and active main-lock refusals precede quoted non-CASCADE drop in owned transaction/fork; application tables/rows, migration source/snapshots and lock table remain intact. Missing history reports installed:false/removed:false; nonSQLite/missing/memory/link targets refuse. User explicitly approved mikro_orm_migrations deletion tests only in NEW disposable fixtures, never existing app DBs; initial delegation denial preceded that consent and one permitted retry.
- Actual default/named migrated/seeded disposable SQLite consumers verify preview/force/removal/reopen and fresh-process tracking reinstall without applying migrations, preserving app/unrelated/view/lock/source bytes. Native/CLI ownership/cancellation/refusal tests complement consumption. Leader mapped-entity collision regression failed before native metadata Map.values iteration repair. Independent lock-read qualification finding repaired with main-schema lookup; non-deleting active-lock querytrace failed before fix and passes after, verifying no DROP while held. Reviewer's denied end-to-end shadow/drop probe was NOT rerun by leader/another worker. Narrow re-reviews accepted both fixes.
- First combined full922pass/2skip/1fail exposed a new in-memory migration test using project migration paths and generating an untracked source snapshot; preserved the generated file outside project, moved tests to unique disposable migration roots and added unchanged-project-snapshot guard. Repaired full923pass/2opt-in live-server skips/0fail,18869assertions across98files/types198 and graph/whitespace pass; no existing application DB accessed for deletion. Exact known SQLite layout only, no server-destructive support/global concurrent-DDL coordination, lost-history recovery, same-ORM cached reinstallation or undo of committed cancellation. Final provenance gates in loop checkpoint. See `src/database/history-uninstall.ts`, native/contracts/CLI tests and `docs/history-uninstall.md`.

### Native console testing — integrated real-runner prompt and assertion harness

- testCommand validates/snapshots argv/env/native prompt steps, executes actual rooted runCli with injected bounded output/error and private in-memory TTY prompt streams, and returns frozen status/output/error/prompt fields with chainable assertions. Per-step EOF makes finite validation input deterministic; no process-global stdin/stdout/exitCode patch. Native text/password/confirm/select/multiselect/search semantics and automatic required-argument retries are consumed; no submitted password echo from native transcript. Trusted direct process/subprocess output and uncooperative code remain outside capture/forced-cancellation guarantees.
- Real generated make:command and make:test --unit/Bun consumers verify API use, explicit errors/status, prompt methods, input/argv/env snapshots, native async-search cancellation and scoped-before-provider cleanup after mismatch/overflow, without app DB state. Missing API consumer red preceded implementation. Independent review reproduced a caught unexpected concurrent prompt returning success; leader exact regression failed before active guard records mismatch, then final harness failure waits command settlement/cleanup. Narrow re-review accepted; later coverage is not all individually red-first.13combined harness/consumer tests35assertions/types202 pass.
- Fresh repaired pre-ledger full944pass/2opt-in live-server skips/0fail,19122assertions across101files/types202, graph/whitespace and no unexpected project snapshot passed. Final source/provenance gates in loop checkpoint. Only original console input/output assertions reference upgraded; no automatic per-worker DB/service provisioning, OS/PTY lifecycle substitute or feature-specific HTTP generator credit. See `src/console/testing.ts`, backend/generated consumer tests and `docs/console-testing.md`.

### Configuration-only publication — integrated explicit package/tag consumers

- No-argument config:publish preserves exclusive built-in app.ts publication with no manifest import. Explicit package/tag/all uses the existing bounded trusted publish.ts metadata and shared full-selected native preflight/writer, with a static config-destination filter. Package/tag intersection selects only config/*.ts; all never includes language/data, no match refuses. Valid irrelevant non-config sources are not read/copied; full manifest validation remains. Source bytes are never imported during copying, global force never overwrites, optional signal checked before/after work, no implicit cache invalidation.
- Actual unknown --package red preceded registration. Two real process consumers22assertions publish selected Unicode configuration, prove no early import, consume config:show, preserve missing irrelevant sources/language/data outputs, existing files despite force, built-in legacy publication and configuration-cache precedence until explicit clear.34focused publication/CLI tests preserve vendor selection/ancestor/refusal/cancellation behavior, types202 pass. Independent bounded review found no verified issue.
- Combined repaired pre-ledger full944pass/2opt-in live-server skips/0fail,19122assertions across101files/types202 and graph/whitespace pass. Final provenance gates in loop checkpoint. Only original config:publish reference upgraded; no PHP catalogues/dependency scanning/downloads, overwrite/merge, multi-file transaction, hostile-tree/power-loss guarantee or unrelated app/environment subsystem parity. See `src/publication/publish.ts`, CLI/operations and actual consumers, `docs/publication.md`.

### Paired model, factory and seeder generation — integrated native composition

- make:model now composes -f/--factory with existing -s/--seed and -m/--migration, including -mfs. Selected model/seeder source and the consumed factory.ts.stub are rendered and all selected filename/ancestor/conflict checks complete before any code output is created. Existing regular/directory/dangling-link destinations and symlink parents refuse even with force. No model import during planning, no DB open without -m; existing native migration baseline/production guards remain with -m. Later I/O/native migration failures may retain earlier new code; no multi-file transaction or rollback deletion is claimed.
- Actual builder/entrypoint missing-factory red preceded implementation.13focused tests73assertions consume generated Factory with persisted native SQLite rows, actual -mfs migration/application/explicit seeder in disposable roots, custom/malformed factory stubs, selected-output conflicts and unsafe parents. Independent review found predictable suffix-length partial publication and new rejection of previously allowed Promise/Error model names. Exact leader regressions observed red, then all selected filenames are checked before missing-parent handling and original model-name rules retained. Later exact255byte factory/seeder boundary coverage passes; no live-server or Eloquent-factory evidence is inferred.
- Repaired pre-ledger full957pass/2opt-in live-server skips/0fail,19217assertions across102files/types203; graph freshness/whitespace and no unexpected project migration snapshot pass. Final source/provenance gates are recorded in the loop checkpoint. Only original combined model/migration/factory/seeder example receives bounded implementation credit after gates; richer model flags/inspection and external service verification remain separate. See src/cli/scaffolding.ts, src/database/generators.ts, src/cli/model-generation.test.ts and docs/native-orm-generators.md.

### Offline application installer and native setup — integrated new-directory creation

- new [name] supports explicit parent/driver/without-http/interactive options with SQLite/Bun/JSON-health defaults. A fixed shipped-source allowlist plus generated nonsecret config/package/test/route files creates a separate code-first application, never a recursive copy of caller .env/config/commands/providers/cache/database/log state. Full bounded descriptor-checked source preflight precedes exclusive new-directory claim and checked0600/0700 file/directory publication. Existing destinations refuse even with force; no subprocess/install/download/migrate/seed/server or credential generation during creation. Server choices configure existing driver paths, not provision/live verification. Later I/O/cancellation can leave partial new output, without rollback deletion or a transaction/hostile-tree guarantee.
- Actual missing command red preceded backend/registration; pure template helper was written earlier, not every template line independently TDD-proven.25focused tests121assertions consume generated CLI/routes/cache, owned live HTTP health, explicit disposable SQLite migration/demo seed, generated Bun test and strict generated-project typecheck with already installed dependencies, native prompt setup, option snapshots and source/link/conflict/cancellation refusals. Generated-test percent encoding and ORM-version alignment defects were reproduced red and repaired. Independent review found application registries executed before new; four leader regressions observed red, then outer new uses snapshotted argv and built-in dispatch without application provider/package/command bootstrap. Ordinary application commands retain bootstrap, including new appearing only as a global-option value/list namespace; trusted runtime preloads/explicit host callbacks are outside the guarantee.
- Repaired pre-ledger full982pass/2opt-in live-server skips/0fail,19482assertions across104files/types208; graph/whitespace and no unexpected project migration snapshot pass.109registered built-ins/26stubs. Final source/provenance gates are recorded in the loop checkpoint. Only original application-creation and interactive-setup references receive bounded Bun equivalent credit after gates; no Laravel/PHP starter kits, automatic dependency install, authentication/session, production service or live-server claims. See src/installation/project.ts/templates.ts, cli/project.ts and consuming tests, docs/project-creation.md.

### Trusted native JavaScript tinker — integrated local developer session

- tinker bootstraps ordinary application providers/commands and receives the real runner service scope. Canonical rooted require/import and optional explicit lazy bundle.database helper execute trusted local JavaScript through Bun node:repl, not PHP/TypeScript parsing or a sandbox/remote endpoint. Interactive use requires TTY; explicit bounded --execute evaluates one complete program with one final result. No default database/history/transcript or environment printing; inline source is visible in argv and arbitrary developer code can expose secrets or access host resources. Production helper opening retains force/selected-target guards.
- Actual CLI SQLite failure reproduced before replacing racing readline execute cells with whole-program evaluation and serialized interactive input. Async-context-bound native error-hook settlement replaces unsafe lastError guesses; recoverable multiline continuations are not terminal failures. Owned awaited evaluations settle before once-only ORM close; caller streams/scopes survive, owned writes drain and input raw/flow/listeners are restored.23focused tests85assertions consume real provider cleanup, disposable SQLite writes/reopen, copied entrypoint, PTY exit/Ctrl+C/SIGINT/SIGTERM, async/multiline/error continuation, preabort/input reuse, opener rejection and delayed output. Independent review found idle output closure leaked ownership; exact leader regression hung RED before close-listener repair. No forced uncooperative-code termination, descendant cleanup, rollback or comprehensive secret redaction is promised.
- Repaired pre-ledger full1005pass/2opt-in live-server skips/0fail,19659assertions across106files/types212. Graph/whitespace and no unexpected project migration snapshot pass before source update; final provenance gates in the loop checkpoint. Only the original tinker reference receives bounded native-JavaScript credit after final gates. See src/console/tinker.ts, src/cli/tinker.ts, native/CLI tests and docs/tinker.md; broader auth/session/installers/adapters/live-server scope remains unfinished.

### Native HTTP feature tests — integrated generated live-worker consumers

- Explicit make:test NAME --http /health generates tests/Feature native Bun test/expect code with computed relative runtime/root URLs, a selected JSON-safe request path and example status200 assertion. Select a real application endpoint and customize assertions. Generation never imports routes, starts services, provisions databases or creates an endpoint. Unit and HTTP flags are mutually exclusive; default generic/unit paths stay unchanged. Published http-test.ts.stub is consumed, bringing code-only stubs to27; existing outputs/linked parents refuse even force and selected filenames are bounded255bytes.
- withHttpApplication starts the actual loopback:0 application worker, not a mock/router-only substitute. Native RequestInit/Response semantics, manual redirects, explicit bounded root-relative targets, route-cache precedence and live maintenance are consumed. Callback failures/cancellation await owned shutdown; cancellation is rechecked after cleanup and retained clients refuse. Caller DBs/scopes and other listeners remain caller-owned; no implicit auth/provider bootstrap, forced uncooperative callback/descendant cleanup or rollback is promised. Actual generated CLI/Bun tests pass in nested space/Unicode roots and custom stubs; source imports are absent during generation.
- Missing API/--http option RED preceded implementation. Selected dollar-path replacement corruption, then independent shutdown-cancellation and native inherited/non-enumerable RequestInit findings were reproduced RED before repairs.85focused tests441assertions/types215 pass; initial full exposed two more stale26stub count assertions plus both active RED regressions. Repaired pre-ledger full1018pass/2opt-in live-server skips/0fail,19724assertions across108files/types215, whitespace/migration-source hygiene pass. Final source/provenance gates in loop checkpoint; only original feature-test generation reference upgraded after final gates, not browser/parallel-database provisioning/Laravel assertion parity. See src/http/testing.ts, CLI/scaffolding and generated/native tests, docs/http-testing.md.

### Native SQLite client shell — integrated bounded local launch

- `bundle db` launches only an existing regular single-link SQLite file through a discovered native `sqlite3` executable. It uses fixed argv with SQLite URI `mode=rw`/`nofollow=1` to refuse missing-file creation and final symlink opens; PostgreSQL/MariaDB clients are explicitly unsupported. No packages are installed, and tests use only fixture files.
- The child environment is a small allowlist that omits Bundle/database credentials; nonzero client status is preserved. Terminal Ctrl+C is left to the foreground SQLite client so query interruption need not close the shell; embedding AbortSignal and SIGTERM retain bounded child cleanup. Path identity is checked before launch, but external concurrent file replacement after preflight remains unsupported.
- Fake-client tests cover argv, environment secrecy, missing client/database, server-driver refusal, replacement before spawn, cancellation and terminal-style SIGINT delivery. No real `sqlite3` executable was available for an interactive native-client run; this bounded launch remains partial pending real-client and PostgreSQL/MariaDB adapters. See `src/cli/database-client.ts`, `src/cli/program.test.ts` and `docs/database.md`.

### Native channel-name registry — metadata-only listing

- `channels.ts` may default-export a bounded `defineChannels([...])` registry of unique dot-separated channel patterns. `channel:list` and `channel:list --json` consume trusted root metadata and do not open a database or contact a service; absent registration is explicitly empty, while malformed registration fails closed.
- This implements listing only. No channel authorization/principal inference, broadcast transport/client, `make:channel`, or `install:broadcasting` behavior is implied. See `src/broadcasting/definitions.ts`, `src/cli/channels.ts`, `src/cli/channels.test.ts` and `docs/broadcasting.md`.

See [the console guide](docs/console.md) for exact supported APIs/options and the session-specific Bun preload dispatch workaround. These integrated foundations are not full Artisan parity. The compatibility inventory retains all original reference IDs and explicit PHP/markup exclusions; unchecked reference items below are unchanged. The 2026-11-07 wave-6 event-generator/queue checkpoint passed 467 tests with 2 opt-in live-server skips and no failures; strict typechecking passed in 115 files. Later complete verification and counts are recorded in the active implementation plan and loop checkpoints. This is scenario evidence, not exhaustive compatibility or live PostgreSQL/MariaDB verification.

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
