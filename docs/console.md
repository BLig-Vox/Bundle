# Bundle console foundations

Bundle provides Bun/TypeScript equivalents for selected Artisan workflows. It does not execute PHP or reproduce Laravel's runtime APIs. `docs/cli-compatibility.json` tracks all 180 reference items, including partial support and explicit exclusions.

## Explicit development processes

`dev:list` lists trusted root `dev.ts` names/argv without invoking configured commands; importing the source itself remains executable application code. `dev` consumes the same registry in an owned foreground Bun group with streamed output, first-exit status and bounded signal cleanup. It does not use a shell, install packages, or manage process groups/descendants. Generated applications explicitly configure API and Vite children; their HMR/readiness integration is still under verification. Listing intentionally reveals argv, so do not place secrets there. See [development processes](development.md) for source validation, lifecycle and fixture evidence.

## Native console test harness

`testCommand(argv, {root, env?, prompts?, signal?, maxOutputBytes?})` executes the real rooted runner with bounded injected output/error and scripted native prompt steps. Frozen results provide status/output/error/prompt assertions; generated commands and generated native tests consume the API. Method/message mismatch, unexpected concurrent prompt and output overflow fail after owned cleanup. It never patches process globals or captures direct console/subprocess writes that bypass injected I/O. Use disposable fixtures and retain actual process tests for OS lifecycle. See [console testing](console-testing.md) for examples, native password/choice/search behavior, limits and verification status.

## Discovery and custom commands

```sh
bun run bundle list
bun run bundle list make --raw
bun run bundle list migrate --format json
bun run bundle help migrate
bun run bundle make:command ImportProducts
bun run bundle import-products
```

The real entry point uses `src/cli/runner.ts`. `createApplicationCli(context?)` constructs the built-in CLI and loads trusted top-level `src/commands/*.ts` modules. `runCli(args, context?)` returns a numeric exit status without mutating `process.exitCode`; `index.ts` translates that result into the process status. Both accept `root`, `env`, `output`, and `error` overrides. Command output callbacks receive text; test subprocess callbacks receive streaming decoded chunks. Default test subprocess output uses raw stream writes without adding chunk-boundary newlines.

Application command modules export command definitions, not arbitrary helper exports. Helpers belong outside this directory. Missing command directories are fine; test/spec/declaration files, file symlinks and nested directories are excluded. Imports execute trusted project code, are not sandboxed, and retain Bun's normal module caching. Loading occurs before parsing, so a malformed definition or collision refuses startup; repair the source rather than bypassing validation.

```ts
import { defineCommand } from "../console/command.ts";

export default defineCommand({
  name: "report:daily",
  description: "Generate a daily report",
  arguments: [{ name: "date", required: false, default: "today" }],
  options: [{ flags: "-t, --tag <values...>" }],
  async handle({ args, options }, { output }) {
    output(JSON.stringify({ date: args.date, tags: options.tag }));
    return 0;
  },
});
```

For class-based commands, export an instance with the same metadata and a `handle` method. Normalization binds the method to its original instance, preserving private fields and state. Handlers return `undefined`/0 for success or integers 1–255 for failure. Invalid results and thrown exceptions fail the invocation. Required/optional/defaulted/variadic arguments, boolean/valued/short/variadic options are supported. Values remain strings unless the handler parses them. The runner also supplies optional `services`, `signal`, and `call` context fields; direct `executeCommand` hosts may omit them. General atomic command isolation is an opt-in definition contract, separate from migration isolation.

### Services, lifecycle and nested invocation

`ServiceContainer` in `src/console/services.ts` accepts `register(key, lifetime, factory)` with `singleton`, `scoped` and `transient` lifetimes. Factories resolve synchronously through `scope.resolve(key)`; async factories are rejected. Missing/cyclic dependencies and singleton dependencies on shorter-lived registrations fail. Aliases share object ownership, so the same resource is not disposed twice. Each runner invocation, including nested calls, owns a fresh scope. Disposal runs in reverse creation order using `Symbol.asyncDispose`, `Symbol.dispose`, or `dispose`; failures are aggregated. A caller-supplied container remains caller-owned and must be disposed by that caller.

```ts
import { ServiceContainer } from "../console/services.ts";
import { LifecycleRegistry } from "../console/command.ts";
import { runCli } from "../cli/runner.ts";

const container = new ServiceContainer();
container.register("reportSettings", "scoped", () => ({ format: "json" }));
const lifecycle = new LifecycleRegistry();
const unsubscribe = lifecycle.subscribe(event => {
  // Observe start/finish without printing secrets from command arguments.
});
try {
  await runCli(["report:daily"], { container, lifecycle });
} finally {
  unsubscribe();
  await container.dispose();
}
```

Subscriptions run sequentially in subscription order from a snapshot; an idempotent unsubscribe affects subsequent emissions. Failures do not skip the other listeners and are aggregated. The optional single `onLifecycle` callback runs before registry listeners. A failed start prevents parsing but still emits finish. Finish status describes the invocation before finish-listener failures; those failures make the final result nonzero.

`await context.call?.(["other:command", "value"])` invokes fresh command parsing and a new scope, preserving output and child status. Recursion is bounded by `maxCallDepth` (default 16). SIGINT/SIGTERM abort the shared signal and choose final statuses 130/143, including signals during loading/lifecycle/cleanup; listeners are removed afterward. Active handlers are cooperative and awaited, not forcibly killed. An external `AbortSignal` propagates cancellation but does not automatically override a handler's return status. Uncooperative handlers or never-settling thenables can prevent completion; embedding hosts must not treat cancellation as forced termination. Programmatic concurrent runners share process signals by default. Embedding/owned-worker callers may set `handleSignals:false` to omit process SIGINT/SIGTERM subscriptions and rely exclusively on their supplied AbortSignal; normal CLI defaults are unchanged.

### Prompts and missing arguments

`createPrompts({ input, output })` from `src/console/prompts.ts` exposes asynchronous `text`, `password`, `confirm`, `select`, `multiselect`, and `search`. Common options are `{ message, default?, validate?, signal? }`; validators return an error string to retry or `undefined` to accept. Choice arrays contain `{ label, value }`; `search(query)` returns a choice array or its promise. Selection is line-oriented numeric input, not arrow-key navigation.

Without a TTY, prompts never consume input: they require a valid explicit default or fail. Noninteractive selection defaults must match choices; search defaults rely on the caller's validator because no query has been made. Abort rejects promptly and restores input listeners/raw mode. Async provider/validator work cannot itself be forcibly stopped. Adapters sharing an input stream serialize through a shared lock and reject concurrency before changing terminal state. Do not attach independent echoing consumers to password input.

Password entry never renders secret characters, discards retained/buffered input at entry/exit, and restores the prior terminal flags. Sequential non-secret prompts preserve bounded UTF-8 typeahead, including split CRLF. Decoded queued input and each accumulated line are limited to 65,536 UTF-16 units; the stream's own buffer and one arriving chunk are outside that bound. Password transition deliberately discards typeahead; input arriving after completion cannot reliably be classified as secret. Do not put secrets into prompt messages or validation errors.

Runner command context exposes `prompts`; its default adapter uses actual `stdin`/`stderr`, independently of text output callbacks. Embedded/test hosts should inject an adapter explicitly. For automatic required **scalar** arguments, declare a nonempty `prompt` message:

```ts
arguments: [{ name: "project", prompt: "Project name" }]
```

An omitted value is requested before the handler, blank answers retry, and supplied values bypass prompting. Unprompted missing arguments are diagnosed before asking; logical required usage/discovery metadata is preserved. Optional/variadic prompt metadata is rejected. Cancellation propagates through the handler context signal. This is explicit TypeScript metadata, not Laravel signature/reflection prompting. Direct `executeCommand` accepts already-parsed input and does not perform argument prompting.

### Atomic command isolation

Declare `isolation: { key?: string, contentionExitCode?: number }` on a custom command. Isolation is always enabled for that definition; it does not add Laravel's `--isolated` flag. The key defaults to the command name. A contender emits an explicit skip notice and returns the configured code (default 0) without running the handler.

Locks use exclusive creation under canonical-root `.bundle-command-locks` with hashed key filenames. Normal release verifies directory/file identity and a random owner token; exceptions and cooperative cancellation release in `finally`, and release failures are reported. Regular-file stale locks remain contention; symlinks/nonregular/multi-link artifacts fail closed. No automatic expiry, waiting or unsafe force unlock is provided. SIGKILL can leave a lock: inspect the owner/state before manual removal. Filesystem checks assume a trusted tree, not protection against hostile concurrent parent renaming. Locks on one local filesystem do not establish multi-host distributed isolation.

## Application information and local documentation

`about` prints JSON application/runtime, environment, cache-presence and selected database settings. It does not connect to the database or dump the full environment. `--only environment,database,cache` selects sections; an unselected database section is not evaluated, so `about --only environment` works without valid database configuration. `--json` explicitly selects the default representation.

`docs [page]` locates root `README.md` (`readme`) or top-level `docs/<page>.md`; `--list` enumerates safe available pages, and `--json` returns structured paths. It reads local metadata only, never fetches or executes documentation contents. Safe ASCII page names, regular files and real parent directories are required. `--open` explicitly launches the platform file opener without a shell; ordinary inspection never launches a browser or network connection. This is local Bundle documentation, not Laravel website integration.

## Console rendering

`createConsoleOutput({ write, isTTY?, color?, columns?, env? })` from `src/console/output.ts` provides `line`, `info`, `warn`, `error`, `success`, `table`, `progress`, `spinner` and idempotent `close`. `write` receives newline-terminated rendered chunks, so use a raw writer rather than `console.log` if extra blank lines are undesirable. Color requires TTY output and is disabled by `NO_COLOR`, including an empty value. Controls in messages/cells are sanitized; explicitly trusted ANSI styling is not accepted as cell data.

Tables bound their total width to configured columns (clamped 20–240), clip cells with an ellipsis and fold excessive columns into the final displayed cell. Common East Asian/emoji code-point widths are handled; full grapheme-cluster/terminal-specific shaping is not. Progress `update(current)` clamps to the total, and `complete(message?)` renders the final total exactly once. Invalid/nonpositive totals render 0/0. These are newline snapshots, not in-place cursor bars.

A spinner's `tick()` renders the next frame; `stop(message?)` and `fail(message?)` finish once. It starts no timers/listeners or background animation. Callers own animation cadence and should close output in `finally`; writes after close are suppressed. A throwing writer propagates to its caller.

## Code-only generators

| Command | Destination |
| --- | --- |
| `make:class Billing/Invoice` | `src/classes/Billing/Invoice.ts` |
| `make:interface Billing/InvoiceContract` | `src/contracts/Billing/InvoiceContract.ts` |
| `make:enum InvoiceState` | `src/enums/InvoiceState.ts` |
| `make:exception ImportFailed` | `src/exceptions/ImportFailed.ts` |
| `make:test ImportProductsTest` | `tests/ImportProductsTest.test.ts` |
| `make:test InvoiceTest --unit` | `tests/Unit/InvoiceTest.test.ts` |
| `make:test HealthTest --http /health` | `tests/Feature/HealthTest.test.ts`, real owned HTTP worker when run |
| `make:config Billing` | `config/Billing.ts` (top-level, selected with `config:show Billing`) |
| `make:command ImportProducts` | `src/commands/ImportProducts.ts`, command `import-products` |
| `make:command DailyReport --command report:daily` | `src/commands/DailyReport.ts`, command `report:daily` |
| `make:trait TracksInvoices` | `src/traits/TracksInvoices.ts`, an explicitly labelled TypeScript mixin |
| `make:controller Billing/InvoiceController` | `src/http/controllers/Billing/InvoiceController.ts` |
| `make:controller Api/UserResourceController --resource --model User` | Same controller tree, five methods consumed by explicit ORM resource middleware |
| `make:middleware Billing/TraceMiddleware` | `src/http/middleware/Billing/TraceMiddleware.ts` |
| `make:request Billing/InvoiceRequest` | `src/http/requests/Billing/InvoiceRequest.ts` |
| `make:resource Billing/InvoiceResource` | `src/http/resources/Billing/InvoiceResource.ts` |
| `make:rule Billing/InvoiceRule` | `src/http/rules/Billing/InvoiceRule.ts` |
| `make:event Billing/InvoiceCreated` | `src/events/Billing/InvoiceCreated.ts` |
| `make:listener Billing/RecordInvoice` | `src/listeners/Billing/RecordInvoice.ts` |
| `make:job Billing/IssueInvoice` | `src/jobs/Billing/IssueInvoice.ts` |
| `make:job-middleware Billing/Trace` | `src/queue/middleware/Billing/Trace.ts` |
| `make:policy Billing/InvoicePolicy` | `src/http/policies/Billing/InvoicePolicy.ts` |
| `make:mail Billing/InvoiceMail` | `src/mail/Billing/InvoiceMail.ts` |
| `make:notification Billing/InvoiceNotice` | `src/notifications/Billing/InvoiceNotice.ts` |
| `make:factory Billing/UserFactory --model User` | `database/factories/Billing/UserFactory.ts` |
| `make:cast Billing/TrimmedText` | `src/database/types/Billing/TrimmedText.ts` |
| `make:scope Billing/NamedUsers` | `src/database/scopes/Billing/NamedUsers.ts` |
| `make:observer Billing/RecordCreates` | `src/database/observers/Billing/RecordCreates.ts` |
| `make:provider Billing/LoggingProvider` | `src/providers/Billing/LoggingProvider.ts` |

Names are PascalCase ASCII identifiers; declaration, exception and test generators permit slash-separated directories. Generated commands are top-level because discovery is not recursive. Traversal, built-in/reserved type names and symlinked destination parents are rejected. Existing files are never overwritten, even with global `--force`. Command generation preflights built-ins, aliases and existing exported command identities before writing. Concurrent generators with distinct filenames can still race on an identical command identity; generation is a local trusted-project operation, not a filesystem sandbox.

`stub:publish` exclusively creates twenty-seven trusted code-only templates: `stubs/{class,interface,enum,trait,command,exception,test,http-test,config,controller,controller-resource,middleware,request,resource,rule,event,listener,job,job-middleware,policy,mail,notification,factory,cast,scope,observer,provider}.ts.stub`. Subsequent generators consume these overrides. Every template requires `{{name}}`; HTTP feature-test templates also require `{{runtimeImport}}`, `{{rootUrl}}` and the JSON-expression `{{requestPath}}` token; command templates also require `{{commandName}}`, HTTP, job-middleware, mail and notification templates require `{{runtimeImport}}`, event templates require `{{runtimeImport}}` and `{{eventName}}`, factory templates require `{{modelName}}` and `{{modelImport}}`, provider templates require `{{runtimeImport}}` and `{{serviceKey}}`, and resource-controller templates require `{{runtimeImport}}`, `{{contextImport}}`, `{{modelName}}` and `{{modelImport}}`. Required tokens, unknown balanced tokens, TypeScript syntax, prohibited markup, symlinks and collisions are checked without rejecting ordinary adjacent TypeScript closing braces. Templates use `.ts.stub` so unresolved placeholders are not parsed by ordinary project typechecking. Earlier experimental `.stub.ts` overrides are not automatically migrated: rename them and remove obsolete source files. Custom templates are trusted project code, not a sandbox or arbitrary runtime contract validator.

HTTP generators support nested names with computed relative imports into the actual [HTTP runtime](http.md). The controller class exposes `handle(context)`; middleware is an explicitly pass-through scaffold; request generation wraps a bounded example name schema; resources select an explicit name field; and rules start with an example custom predicate. Replace examples with application behavior. `make:policy` emits a deny-default class consumed by explicit policyMiddleware guards with application-supplied principal/resource resolution. Strict boolean decisions, generic no-store403 denial and sanitized invalid/throwing500 cases run through live requests; this does not supply authentication/session/token verification or automatic route protection. Generated outputs are exercised against consuming runtimes, not sold as authentication. Paired --resource/--model now selects five own model-resource methods consumed by explicit manager/validation/serializer middleware; no request fields or routes are inferred. See [model resources](model-resources.md) for native CRUD, cleanup/cancellation, cache methods and the explicit26th stub. `Request` and `Response` are reserved names for these scaffolds.

Generated config and command files are top-level because their consumers are nonrecursive. `--unit` selects a directory; it does not install a different test framework. Explicit `--http /health` instead creates a native [HTTP feature test](http-testing.md) in tests/Feature using a real owned loopback worker; select a real endpoint and customize the example status200 assertion. It cannot be combined with --unit and generation never imports/routes/starts the application. No generator `--force` or unrestricted Laravel generator-option compatibility is claimed. Generated enums/contracts start empty; users supply their domain behavior. The mixin is not a PHP trait. Generating a class does not automatically configure a router, queue, provider registry or delivery transport. `make:provider` emits an explicitly registered class consumed by the real outer runner lifecycle; services register before all boots, and nested calls do not repeat bootstrap. Caller-owned containers require explicit lifecycle composition for nonempty registries. See [providers](providers.md) for ownership, failure/cancellation and trusted-module limitations.

Event/listener scaffolds integrate with the [event runtime](events.md), including namespace-derived identities and explicit registration. The generated listener is an example, not automatic validation or authorization. `AbortSignal` is reserved to preserve emitted type references.

Mail/notification classes are consumed by explicit local text-delivery adapters, never generation/import-time dispatch. See [the mail guide](mail.md) for strict message bounds, private outbox/inspection and no SMTP/notification-table implications.

Native ORM generators emit explicitly consumed MikroORM Factory/Type/query-helper/EventSubscriber examples. Factory `--model` selects an existing top-level model source without executing it; attributes, type mappings, helper invocation and observer registration remain explicit. Generation never connects to a database or edits a model. See [native ORM generators](native-orm-generators.md) for usage, syntactic preflight limits and actual SQLite evidence.

## Explicit package metadata

`package:discover` validates trusted root packages.ts and publishes private bounded version1 provider metadata without importing new referenced provider code in the builder. Replacement of valid owned metadata requires global --force; `package:clear` removes only that valid cache. Later ordinary CLI bootstrap combines cached/direct provider refs and executes the real lifecycle, with no implicit package-source import, dependency scanning or downloads. Invalid bootstrap metadata fails closed before actions (including public discover/clear), so inspection may be required. Earlier ordinary cached/root provider boot can run before metadata command actions; it is not bypassed. See [packages](packages.md) for bounds, commit/cancellation, ownership and recovery limits. Vendor assets/installers remain unfinished.

## Local language resources

`lang:publish` exclusively creates mode-0600 `lang/en.ts`; even force preserves existing translations and unsafe targets. `translate(root,key,{locale?,values?})` consumes strict bounded Unicode text catalogues with required named replacements, English overrides/bundled fallback and explicit source-only other locales. Validation and replacement snapshotting precede trusted import; normal fixed-URL module caching applies. No markup, pluralization, downloads or new stub is introduced. See [localization](localization.md) for exact limits and consuming examples.

## Explicit vendor resources

`vendor:publish --package <name>`, `--tag <name>` (intersection together), or `--all` explicitly copies versioned trusted publish.ts assets into bounded config/language/JSON/text destinations. No selection refuses. Sources are never imported by copying; normal consumers validate and execute published resources later. All predictable source/target/ancestor conflicts preflight before directories/files; exclusive private writes preserve existing output even with force. Later I/O or cancellation can leave earlier outputs while reporting failure. No dependency scan/download/UI assets/new stub. See [publication](publication.md) for exact manifest/path bounds and trusted import/cancellation limitations.

## UTC command scheduling

`bundle schedule:list --json`, `schedule:run --at <UTC ISO>` and `schedule:work --sleep <milliseconds> --max-cycles <count>` consume trusted root schedule.ts definitions and the real runner, not shell or queue aliases. Default local overlap locks and in-process minute high-water deduplication are bounded contracts; signals are cooperative and embedding handleSignals:false is preserved. Persisted `schedule:pause/resume/interrupt` now affect observing run/work consumers at command/poll boundaries; interrupt waits for active settlement, and a replacement baselines the latest token. `schedule:test --task <id>` or interactive id-only selection executes one configured task even when not due, retaining controls/overlap/status and noninteractive nested commands; it is not a dry run. Omitted selection refuses non-TTY input. Non-UTC/DST, background finish, service supervision and safe stale-lock removal are not implemented. See [the scheduling guide](scheduling.md) for exact grammar/options/status/trusted-import limits.

## Durable command dispatch

`dispatchCommand({root,argv,queue?,availableAt?,maxAttempts?,middleware?})` from `src/queue/dispatch.ts` returns a queued ID, not a command result. It snapshots bounded explicit argv into a versioned envelope, validates before storage and resolves/discovers the command only when consumed by an owned worker running the real rooted runner. No environment/service/closure snapshot or shell is used. Context output/parser errors are discarded and prompts are explicitly noninteractive; direct trusted output/subprocess streams are not comprehensively intercepted. Nonzero status fails/retries (conditional `commandExitCode` metadata); actual cancellation refunds the attempt and timeout fails it. Argv persists unredacted in private SQLite: do not enqueue secrets. Upgrade consumers before producing new envelopes. See [the queue guide](queues.md) for full bounds, rollout, root/cwd and at-least-once limitations.

## Fresh queue-worker child cycles

`queue:listen` runs one real fresh owned `queue:work --once` process per cycle, with raw streaming output, explicit root, ignored stdin and no shell/helper files. `--max-cycles` bounds invocations, not jobs; the listener sleeps every cycle and exits on nonzero child status or changed restart generation. SIGINT/SIGTERM forwards to its child, then bounded escalation/reap; callbacks/readers are cleaned on failure. Owned-child exit allows a250ms stream drain before cancellation, so inherited pipes cannot pin the parent (late output may be lost). It never kills application-spawned process groups or self-respawns after exit. See [the queue guide](queues.md) for options, API and limits.

## Local queue commands

`queue:work` consumes dedicated local SQLite jobs in owned workers; cursor-paginated `queue:failed`, `queue:retry <id>` and forced `queue:forget <id>` manage failed-job metadata. `queue:monitor --queue <name> [--max <count>]` snapshots disjoint states and consumes local `queue.busy` events on exceeded thresholds. Force-required `queue:clear <queue>` preserves all receipts, while `queue:flush`/`queue:prune-failed` require an explicit queue-or-all failed-history scope and an epoch-ms cutoff for pruning. Delivery is at least once, timing flags use milliseconds, and producer attempts supply the default, while optional `--tries 1..100` persists a per-claim override without changing live reservations or unrelated/future work. `queue:pause`/`queue:resume` filter work at claim boundaries, and root-scoped `queue:restart` requests graceful exit after active settlement, not self-respawn; state is private, bounded and fails closed. Ordinary worker cancellation requeues/refunds the attempt; final failures are reported truthfully. `queue:batch <id>` inspects durable batch counts; `queue:cancel-batch` prevents new claims while live owners settle; `queue:retry-batch` reopens only retained noncancelled failures. Force-required `queue:prune-batches --before <epoch-ms>` removes only terminal metadata and detaches retained failures without deleting jobs. New schema2 state requires explicit force-guarded `queue:upgrade` for verified schema1 queues after ALL old processes stop; no mixed-version safety or automatic migration. These commands do not use ORM databases. See [the queue guide](queues.md) and [local batches](queue-batches.md) for exact API, cancellation/commit/rollout, ownership/lease, generic metadata and remaining service/generator limitations.

## Configuration

```sh
bun run bundle config:publish
bun run bundle config:show app
bun run bundle config:show app.name
bun run bundle config:cache
bun run bundle config:cache --force
bun run bundle config:clear
```

Configuration comes from default-exported, JSON-compatible plain objects in trusted top-level `config/*.ts` modules. Functions, dates, getters, cycles and other lossy serialization inputs are rejected. Test/spec/declaration files, file symlinks and nested directories are excluded; directory symlinks are refused. Source modules execute project code. They may explicitly use `process.env`; injected command environments do not rewrite globals or re-evaluate imported modules.

A valid `bootstrap/cache/config.json` wins until explicitly cleared or rebuilt, even when sources/environment change. A malformed cache fails rather than silently falling back. CLI cache replacement requires `--force`, including when a destination appears during source loading. Exclusive publication uses hard links and fails safely on filesystems that do not support them. Cache files use mode 0600 and the cache directory is gitignored because serialized configuration can contain secrets. Cached values are not encrypted.

`config:show` recursively masks sensitive field names, credential-bearing URL strings and strings containing known sensitive environment values. This is heuristic, not a guarantee against an unknown secret placed under an innocuous name. Avoid displaying untrusted configuration. Configuration module exceptions are sanitized at CLI boundaries. `config:publish` publishes only Bundle's built-in `config/app.ts`; vendor/package manifests, named publication and overwrite are not supported. Application configuration is separate from the existing database environment configuration and is not a service container.

## Bootstrap optimization

```sh
bun run bundle optimize
bun run bundle --force optimize
bun run bundle optimize:clear
```

These commands aggregate the real configuration, executable route and executable event caches. Build reports `completed`, `failed` or explicit `skipped`/`not-configured` for each target; absent route/event sources **and** absent caches are skipped, while configuration still performs a real build. Existing caches require force to replace. Clear attempts every declared cache idempotently; unsafe/unowned state can fail a target rather than be deleted. Structured output names every result, failures return a nonzero status and trusted module exception text is not echoed.

Operations run sequentially and all targets are attempted after ordinary failures. This is **not a transaction**: successful earlier writes/removals remain when a later operation fails, and partial results are visible. Clearing touches only these bootstrap caches, not application SQLite cache data, maintenance state, locks or unrelated files. It does not unload Bun ESM modules, hot-reload running services or pretend to clear excluded PHP compiled/Blade artifacts. Changed source rebuilding uses a fresh CLI process; repeated programmatic imports retain normal ESM caching.

## Local cache and owned storage links

`LocalCache` in `src/cache/cache.ts` is a real persistent SQLite cache, independent of MikroORM/application databases. Construct it with `(path, namespace, clock?)`, then use `put(key, jsonValue, { ttlMs?, tags? })`, `get(key)`, `forget(key)`, `clear(tags?)`, `pruneStaleTags()` and `close()`. Expiry is measured in milliseconds; expired reads return `undefined`. Tagged clear matches **any** supplied tag and stays inside its namespace. Pruning removes expired entries and unreferenced tags, not migration or scheduler locks.

The CLI always uses `.bundle-cache/cache.sqlite`. Optional trusted `config/cache.ts` exports `{ driver: "sqlite", namespace: "default" }`; unsupported settings/drivers are rejected. Cache commands create local state when needed, refuse unsafe paths/unrelated populated SQLite databases, and never select the ORM database. This is a local SQLite backend, not Redis/Memcached compatibility. Values should not contain secrets without appropriate filesystem protection.

```sh
bun run bundle cache:forget reports:last
bun run bundle cache:clear --tag reports
bun run bundle cache:prune-stale-tags
bun run bundle storage:link
bun run bundle storage:unlink
```

Storage commands require trusted `config/storage.ts`, for example:

```ts
export default { links: { "public/assets": "storage/assets" } };
```

All paths are root-relative. Link creation requires existing real target directories and destination parents; it will not overwrite unrelated files or links. `.bundle-storage-links.json` records target/device/inode ownership. Unlink matches recorded link identity even when its target was deleted or configuration changed; missing owned destinations clear stale records and can be recreated by link. A substituted destination fails closed. Counts reflect actual links created/removed. Only configured destinations are considered; removing a mapping from config does not automatically delete its old link.

The exclusive `.bundle-storage-links.lock` coordinates Bundle operations without unsafe automatic expiry. After a crash, inspect stale locks before manually removing them. Parent checks are not atomic against hostile external path renaming; these operations assume a trusted project tree. Cache and machine-specific ownership state are gitignored.

## Structured local logs and Pail-style inspection

`new Logger({ root, env?, clock? }).log(level, message, context?)` in `src/logging/logger.ts` appends mode-0600 JSONL records to `storage/logs/bundle.jsonl`. Levels are `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`. Records have UUID IDs and ISO timestamps, are limited to 16 KiB, and reject nonobject/lossy/accessor/cyclic context. Parent symlinks, nonregular files and hard links are refused. Known environment secrets, sensitive context keys and credential URLs are heuristically redacted; unknown secrets can still leak, so do not log credentials.

```sh
bun run bundle pail --json --lines 20 --level warning
bun run bundle pail --filter 'invoice|payment'
bun run bundle pail --follow --json --timeout 10000
```

Snapshot mode reads a bounded tail (default 256 KiB, latest 50 matching records; `--lines` accepts 1–1000). JSON returns `{ entries, truncated }`; incomplete final records are ignored, and malformed complete records fail without echoing their contents. `--level` sets a minimum severity and `--filter` is a message regular expression. The API additionally permits a bounded `maxBytes` override.

Follow mode installs its directory watcher before the initial snapshot, then incrementally reads **all** subsequent complete matching records with bounded chunks; `--lines` limits only the initial snapshot. Periodic idle rescans (100 ms) cover missed/coalesced filesystem notifications. Observed rotation/truncation warns of possible gaps; entirely unseen in-place rewrites/regrowth cannot be guaranteed detectable, and a startup warning states this limit. Warnings use stderr/the injected error sink, separately from JSONL records. This is not a lossless audit transport or an automatic rotation/retention manager.

`--timeout` is valid only with `--follow` and ends successfully. SIGINT/SIGTERM end with 130/143 and remove watchers/timers/listeners. Following requires an existing real log directory; snapshots on missing logs return empty. Human messages escape terminal controls. No Laravel Pail package or remote log backend is installed.

## Environment and keys

```sh
bun run bundle env
bun run bundle key:generate
bun run bundle key:generate --show
bun run bundle env:encrypt
bun run bundle env:decrypt --force
```

`env` reports `APP_ENV`, then `NODE_ENV`, then `development`. Bun's own process startup environment loading remains in effect; the backend does not mutate the process environment.

`key:generate` writes a canonical `base64:`-encoded random 32-byte key to root `.env`. An existing `APP_KEY`, including an empty assignment, requires `--force`; ambiguous/duplicate/multiline dotenv syntax is refused. Normal output never prints the generated key. `--show` explicitly prints a new key without writing a file. This does not install an application encryption/authentication or automatic key-rotation subsystem.

Environment encryption requires a canonical key through `BUNDLE_ENV_ENCRYPTION_KEY` or explicit `--key <key>`. Prefer the environment variable over command-line arguments to avoid shell-history/process-list exposure. Keys from `key:generate --show` have the supported format. Keys are not generated implicitly by encryption and are not printed by these commands. Keep the encryption key outside the plaintext file being encrypted and store it securely.

`.env` encrypts to `.env.encrypted`; decryption authenticates and writes `.env`. Inputs are retained, existing outputs require `--force`, and writes are atomic at mode 0600. Paths and parents must not be symlinks. The versioned **Bundle AES-256-GCM envelope is not Laravel-compatible ciphertext**. Alternate ciphers, named environment files, automatic bootstrap decryption and rotation are unsupported. Tests cover authenticated round trips, tampering/wrong keys, unsafe paths, permissions and overwrite refusal using disposable roots, never the repository's real `.env`.

## Native testing

```sh
bun run bundle test
bun run bundle test ./tests/ImportProductsTest.test.ts
bun run bundle test --filter 'ImportProducts'
bun run bundle test --coverage
bun run bundle test --parallel --processes 2
bun run bundle test --parallel --isolated-databases
```

The adapter invokes the current Bun executable directly, without a shell or package test script. `--filter` maps to Bun's regular-expression name filter. Coverage uses Bun's native text report. Parallel mode uses isolated Bun worker processes, two by default; `--processes` requires `--parallel`. Tests prove concurrent execution in distinct worker PIDs. Individual tests must isolate ports/files/external services. Explicit `--parallel --isolated-databases` additionally creates a private unique run under `.bundle-test-databases`, invokes native Bun workers with a fixed preload, and initializes one new migrated SQLite file per actual worker PID before tests import. Application database selectors/global migration paths refuse in this mode; parent rewrites test environment to SQLite and cannot open/reset the configured application database through that environment. Migrator snapshots are disabled, and tests compare bundled migration source bytes. After native test parent shutdown, Linux `/proc` process-start identities must prove every recorded worker stopped before owned fixture deletion; unknown/live state preserves the run path for inspection. SIGINT/SIGTERM cancel only owned runner/worker processes and return130/143. Tests remain trusted code, not sandboxed; explicit JavaScript may access host resources independently of the provided DB environment. Caller external services/ports/files are not isolated.

PHPUnit/Pest, Laravel coverage thresholds and other coverage report formats are not implemented. Isolated native test setup currently supports SQLite/Linux only; it is explicit, local and per-process, not PostgreSQL/MariaDB test database setup or Laravel API parity. Test files execute trusted code and can print arbitrary content; their raw output is deliberately relayed, not secret-sanitized across stream chunks.

### Session-specific Bun dispatch workaround

Bun 1.4.4 misdispatches `run`/`test` when this development session's cosmetic terminal preload is inherited through `BUN_OPTIONS`. No global settings are changed. For this session only, clear the inherited flag on the individual command and retain the same preload explicitly for the native test runner:

```sh
BUN_OPTIONS="" bun test --preload /home/recruas/.config/claudex/preload.cjs
BUN_OPTIONS="" bun run bundle test
BUN_OPTIONS="" bun run graph:check
```

That absolute preload path is a local session workaround, not a required dependency or portable project setup. Ordinary environments use the normal commands above.
