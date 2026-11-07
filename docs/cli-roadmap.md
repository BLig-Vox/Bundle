# Bundle CLI compatibility roadmap

## Scope and honest completion

Bundle is building its own **Bun/TypeScript Artisan-style CLI**, not installing Laravel or providing PHP API compatibility. The original 15 numbered categories and 180 unchecked reference items in `PROGRESS.md` define the scope inventory. The exhaustive item-by-item plan is [`cli-compatibility.json`](cli-compatibility.json); this document explains its ordering and evidence gates. Duplicate examples remain separate source records, not extra implementations.

The base revision is `6f1ac1e` on `version/A000`; the JSON source fingerprint and locations are refreshed after integrated ledger updates. The current assessment includes the verified 2026-11-07 foundation integration, not merely concurrent worker intentions. Source lines may shift when the Bundle feature ledger is updated; IDs, not line numbers, are the join key.

Current inventory: **25 pending, 29 partial, 117 implemented, 9 excluded = 180** (initial assessment: 137/31/3/9; foundation checkpoint: 113/34/24/9; console/local checkpoint: 97/28/46/9; HTTP checkpoint: 84/28/59/9). These are bounded compatibility classifications, not a code-coverage percentage or full command/flag parity. That is 65.0% of all references, or 68.4% of the 171 applicable references, with partial items not counted as complete. Explicit native HTTP feature-test generation now executes generated Bun tests through a real owned loopback worker, with reviewed native Request and shutdown-cancellation semantics; no parallel database or browser-test claim. Trusted native JavaScript tinker now has real service/SQLite/PTY consumers and repaired await/error/output ownership; it is not PHP/PsySH or a sandbox. Reviewed service scopes/lifecycle/cancellation/nested calls, prompts/automatic scalar arguments, generic atomic isolation, rendering, customized code-only stubs/unit/config generation, persistent local cache/owned storage, local docs/about and structured log inspection now have evidence. Environment ciphertext compatibility, application key consumers, native test-database provisioning, API/broadcast installers and many flags remain partial or pending. Offline new-directory application creation and native interactive setup now have real generated-project consumers, without dependency installation or service provisioning. Broader database inspection, seeder/model generation and migration contracts still include **partial** items because semantic/option differences and/or live-server verification remain. The `bundle db` shell now has a bounded existing-file SQLite launcher; real native-client interaction and PostgreSQL/MariaDB credential-safe clients remain unverified or unsupported. `make:cache-table` now generates SQLite/PostgreSQL/MariaDB entry/lock schema and has a real SQLite migration consumer, but no database-backed cache runtime exists, so it stays partial. `make:session-table` similarly generates a SQLite-consumed dialect-specific schema with later-diff safety, but no HTTP session/auth runtime consumes it, so that reference is partial. The specifically combined model/migration/factory/seeder example now has bounded native composition evidence; this does not complete all model flags. Neither a command in help nor an ORM dependency establishes a complete backend.

There are **117 registered built-in commands**. The reviewed and repaired native HTTP feature-test pre-ledger checkpoint passed1018 tests, skipped2 opt-in live-database contracts and had no failures across108files; strict typechecking in215files passed.27published stubs include the consumed HTTP feature-test template; actual copied entrypoint/generated Bun tests, cache/maintenance, manual redirects and cancellation are consumed. See [HTTP feature tests](http-testing.md). Native whole-program execute and serialized interactive await/multiline/error handling consume real scoped services, explicit lazy SQLite, copied entrypoint and PTY signals. Idle-output ownership review repair was reproduced red; caller streams/scopes remain owned by callers, and uncooperative/unawaited effects are not forcefully cleaned up. See [tinker](tinker.md). Actual generated CLI/routes/cache/HTTP/SQLite migration/seeding/native-test/typecheck and native interactive choices are consumed. Outer new skips unrelated application registries after a red-first bootstrap repair; ordinary app startup remains unchanged. Shared selected code-output planning now composes make:model -mfs and consumes native Factory/custom-stub/migration/seeder outputs; filename-length and prior-name regressions were repaired red-first. Later I/O/native migration failure is nontransactional. Final post-source/provenance assertion counts and graph are recorded in the implementation-loop checkpoint. The refreshed source/evidence audit covers all 180 IDs; regenerated graph freshness, whitespace and runtime-state ignores passed. HTTP adds worker-backed serving, route inspection/executable caching, validation/resources and five consuming generators; live maintenance, local event dispatch/cache and real bootstrap optimization are now separately consumed. Generated namespace-aware events/listeners and durable local SQLite jobs are now consumed through actual processes, with receipt-safe execution, retry, timeout and signal cleanup. Generated jobs, paginated failed history, snapshot metrics/consumed threshold events and force-guarded scoped clear/flush/prune now have actual-process evidence. Job descriptor limits are shared with enqueue before output creation; both exact accepted boundaries and rejected oversized names are tested. The worker retry example and persisted pause/resume/graceful restart now have bounded implementation credit. Independent review reproduced stale claims after exhaustion scanning and legitimate atomic control replacement terminating workers; regression-first repairs and independent re-reviews preceded the final full suite. Durable command dispatch, consumed job middleware and fresh owned listen cycles now have evidence. Review repairs preserve corrupt raw job records without starvation, make middleware recovery explicit via native-Promise next.recover, and reap listener children/readers on writer errors or inherited-pipe stalls. Deny-default make:policy classes now execute through explicit strict-boolean HTTP authorization guards. Independent cancellation-completion review findings were reproduced red, repaired and re-reviewed; authentication/session/token identity inference remains unfinished. Consumed text-mail/notification generators now use explicitly injected private local outbox delivery, not SMTP/inbox delivery or notification tables. Numeric UTC-only schedule:list/run/work consume real commands with local overlap locks, observed-minute deduplication and cooperative signals; Persisted global pause/resume and graceful generation interruption now affect live consumers, with active settlement and newconsumer baselining; schedule:test now consumes explicit/id-only real terminal selection with real effects and retained controls/overlap; `schedule:clear-cache --force` now removes only verified stale versioned locks on Linux in the current PID namespace, preserving live, generic/legacy token-only, cross-namespace and unsafe state. Background finish, service supervision and IANA/DST remain unfinished. Native make:factory/cast/scope/observer now execute through real MikroORM SQLite consumers with explicit inputs/mappings/calls/registration. make:provider now has ordered local registration/boot/disposal consumed before command imports, once-only nested initialization and explicit embedding ownership. Native model preflight and runner signal/error-sink cleanup findings were regression-first repaired and independently re-reviewed. Publication/listing/record/sync and scheduler cancellation/signal ownership findings were regression-first repaired and independently re-reviewed. event:generate now preflights source registrations and creates only missing conventional class listeners, preserving existing modules and consumed custom templates; native string event identities require no fabricated class. package:discover now builds private strict explicit local metadata consumed by cached provider bootstrap, with no installed-dependency scanning/downloads/source fallback. Cancellation/ordinary reader races were regression-first repaired and re-reviewed. lang:publish now exclusively creates a code-only English catalogue consumed by real bounded translation APIs; fresh CLI processes compile/consume default and customized Unicode text, with explicit locale/fallback and no-overwrite rules. vendor:publish now copies explicitly selected version1 local config/language/JSON/text resources through full selected preflight and exclusive private writes, with actual config/translation/JSON consumers. Predictable ancestor and ordinary data-extension regressions were repaired red-first and re-reviewed; later I/O/cancellation remains nontransactional. Paired model-associated resource controllers now forward five own CRUD methods through explicit per-request native manager forks, consumed by real SQLite HTTP and cached index/show routes while preserving caller pending state. No-store500/completion-abort regressions were reproduced red, repaired and independently re-reviewed; explicit auth/validation/serialization/routes and application-owned ORM lifecycle remain required. Durable mixed local batches now atomically persist membership consumed through actual workers, with explicit live-owner-preserving cancellation, retained-failure retry and terminal-history prune/detachment. Schema2 upgrades require explicit opt-in after old processes quiesce; inherited ownership-prefix filtering was reproduced red, repaired and independently re-reviewed. ORM batch-table adapters/callbacks and mixed-version safety are not implied. Explicit model:prune now consumes branded native rules, preview counts and force-guarded bounded deletion against existing targets, with caller-state preservation, native filters/cascades and per-chunk transaction semantics. Above-safe-integer SQLite bigint precision was repaired red-first and independently re-reviewed; earlier committed chunks remain after later failure/cancellation, and per-entity hooks/live-server parity are not implied. See [model pruning](model-pruning.md). Shared trusted dev.ts listing now has a real foreground owned-Bun consumer with first-exit/signal/stream cleanup; broader dev/Vite/service-manager integration stays partial. Verified existing SQLite tracking-only migrate:uninstall preserves app/source/lock state, with metadata Map and qualified-lock review repairs, fixture-only deletion consent and isolated snapshot tests. See [development](development.md) and [tracking uninstall](history-uninstall.md). Reusable native testCommand now consumes generated commands/native tests with scripted real prompts, bounded capture and cleanup-aware assertions; caught concurrent-prompt false success was repaired red-first and re-reviewed. Configuration-only config:publish now consumes explicit shared package/tag/all manifests and native writer, with real config/cache consumers and preserved vendor behavior. See [console testing](console-testing.md) and [publication](publication.md). System-service self-respawn/Horizon/Redis evidence remains incomplete. See [`console.md`](console.md), [`http.md`](http.md), [`events.md`](events.md), [`queues.md`](queues.md), [`mail.md`](mail.md), [`scheduling.md`](scheduling.md), [`native-orm-generators.md`](native-orm-generators.md) and [`providers.md`](providers.md) and [`packages.md`](packages.md) and [`localization.md`](localization.md) and [`publication.md`](publication.md) and [`model-resources.md`](model-resources.md) and [`queue-batches.md`](queue-batches.md) for exact APIs/options, deliberate differences, safety rules and evidence. The active implementation plan is [`superpowers/plans/2026-11-07-artisan-continuous-parity.md`](superpowers/plans/2026-11-07-artisan-continuous-parity.md). Full applicable Artisan compatibility remains the ongoing goal; these milestones do not complete M1–M8 or D1.

- **pending:** no complete verified public equivalent yet; each row proposes a concrete Bun direction and next work.
- **partial:** some behavior exists, but named options, public APIs, backend integration, or verification still have gaps.
- **implemented:** the specifically described bounded Bun equivalent has evidence, not unrestricted Laravel parity.
- **excluded:** a literal capability conflicts with this architecture or has no applicable artifact; its reason and any separately proposed alternative remain visible.

No reference checkbox changes are made by this inventory. Record each completed Bundle feature in the separate Bundle status ledger in `PROGRESS.md`, including supported flags, evidence and deliberate differences. Regenerate the corpus afterward. Preserve the distinction between reference completion state and implementation status.

## Architectural boundaries

- Runtime and code generation remain Bun/TypeScript, using classes and MikroORM `EntitySchema` for persistence. MikroORM is a Data Mapper, not Eloquent or PHP Schema Builder.
- Generated applications now target Vite + React TSX views with Fast Refresh/HMR and configured shadcn/ui primitives, alongside the existing Bun/MikroORM backend. Runtime tests verify generated-app typechecking, Vite readiness/HMR, `ui:build`, combined API+web startup, `/api` proxying and production serving of generated output on Linux. Non-Linux static serving remains unavailable. Do not grant compatibility credit from this frontend work. JSX/TSX and HTML entry documents are limited to that frontend; they do not permit markup-driven backend configuration, XML, XAML/AXAML or Blade/PHP.
- The nine literal exclusions are PHP traits; Blade component/view generation; Blade view cache/clear; PHP compiled-framework cleanup; PHPUnit/Pest integration; Pint and its PHP example. TypeScript mixins, Bun testing, and a future TypeScript formatter are separately named alternatives, not counterfeit PHP features.
- Optional ecosystem intent is retained as **pending** where an honest Bun alternative exists: containers, logs, queue operations, managed servers, WebSockets, browser automation, search, debugging and monitoring. Laravel product names are reference provenance, not installed adapters or interoperability promises.
- Generating an event/job/controller/provider/mail class is a **scaffold**, not proof of an event bus, worker, HTTP runtime, service container or delivery transport. The consuming backend must execute generated code before a functional subsystem is claimed.
- No commits, pushes, provisioning, network downloads or destructive access to existing databases are needed for this roadmap. Tests use disposable fixtures. A future destructive command needs safeguards and tests; documenting it does not authorize executing it against real data.

## Milestones and dependencies

Milestone IDs are shared with the JSON. Dependencies below are **proposed Bundle implementation prerequisites**, not relationships extracted from the Laravel reference corpus. Implement small independently testable slices within each milestone; do not wait for every console enhancement before working on a safe independent scaffold.

### M0 — Inventory and evidence discipline

**Depends on:** nothing. **Deliverable:** the complete 180-ID inventory, explicit exclusions, honest evidence pointers, and the iteration protocol in [`cli-implementation-loop.md`](cli-implementation-loop.md).

Keep one coordinator responsible for shared CLI registration, `PROGRESS.md` and generated artifacts. Assign nonoverlapping implementation/test files to workers. Reconcile partial work after review rather than declaring the whole checklist done. Maintain the source/ID audit when ledger prose moves line locations; new Bundle ledger checkboxes must not silently expand the original 180-item denominator.

### M1 — Reusable command runtime and console

**Depends on:** M0. **First slices:** a stable public class/callback command API; typed argument/option definitions; custom command discovery; a programmatic runner; an executable `make:command` output; real process entry-point tests. Discovery/help/about improvements belong here as well.

Then add injectable console I/O, validated prompts, non-TTY policy, lifecycle events, scoped dependency resolution, cancellation/signals, reusable test assertions and general isolation. Existing `createCli({ env, root, output })`, Commander callbacks and migration locks are useful building blocks, not all of these public APIs.

**Exit evidence:** generated and callback commands execute through the real CLI; defaults/arrays/shortcuts/repeated options have parsing tests; invalid definitions and command collisions fail clearly; output, errors and exit status are asserted. Password prompts must not echo or leak secrets. Cancellation and nested invocation require process/lifecycle tests. General isolation must not be inferred from migration-only locks.

### M2 — Safe code-only scaffolds and native testing

**Depends on:** the M1 registration/runner contract, not every optional presentation helper.

Start with class, interface, enum, Error subclass and `bun:test` generation. Define code-only stub publishing/overrides and generate valid imports, not placeholders requiring nonexistent subsystems. Validate names, destinations, symlink/path escape, reserved identifiers, exclusive writes and related-file failure handling. Generator output must typecheck and execute in disposable projects.

Add a native test subprocess wrapper with file/name filtering, correct exit/signal/output propagation and explicit supported coverage behavior. Existing `bun test` and name filtering do not constitute a `bundle test` wrapper. Parallel execution needs per-worker fixture/database/port isolation and deterministic failure aggregation; Bun's scheduling defaults are not proof of Artisan's process-parallel contract.

Domain scaffolds are sequenced with their real backend: config/cache in M3; HTTP/request/resource/policy/session in M4; event/job/queue/mail/notification/channel in M5; providers/packages in M7; factories/types/query helpers/subscribers in D1. Missing backends are blockers, not reasons to advertise stub-only functional support.

### D1 — Database compatibility and verification, parallel track

**Depends on:** M0; preserve current SQLite behavior while other milestones proceed.

Current code supports safe model/seeder generation, migrations and batches, guarded rollback/reset/refresh/fresh, explicit targets/paths, limited SQL previews, cooperative locks, and SQLite schema dump/prune/bootstrap. Inspect [`database.md`](database.md), [`migrations.md`](migrations.md), `src/cli/program.ts`, `src/cli/migrations.ts`, and their tests for the exact contract.

1. Keep regression coverage and document unsupported flags/Data Mapper differences. `migrate:fresh` remains conservative: mapped tables/history only, refusal of unmapped objects and unreconciled state. It is not `db:wipe`.
2. Native factory/custom-type/query-helper/subscriber generators now have strict default/custom code and real disposable SQLite persistence evidence; explicit attributes/mappings/invocation/registration remain required. Continue pruning and richer inspection only with real persistence tests. Native dependency APIs alone are not a Bundle generator or command.
3. Design history uninstall, native shell launch and any explicitly scoped wipe with destructive guards, credential safety, active-lock semantics and refusal tests before implementation. Do not relax existing guards merely to resemble Laravel.
4. Run authorized PostgreSQL/MariaDB live persistence tests, then the separate expanded migration/batch/rollback/refresh/fresh/lock/dump/prune/bootstrap matrix per engine. Verify actual native clients, supported versions, TLS/authentication and permissions. MariaDB DDL/restoration is not guaranteed atomic.
5. Add real-process contention, termination/stale-lock recovery and deployment behavior evidence. Local connections and mock tool invocations do not establish multi-host behavior.

**Blocker:** empty disposable server databases, explicit reset authorization and required native clients are not supplied by this plan. Do not provision or use an existing application database. Work on independent local features can continue while the live-server portion stays partial.

### M3 — Configuration, cache and local operational primitives

**Depends on:** M1's command/context contract.

Define typed configuration/environment precedence, secret-safe display and atomic cache invalidation. Build a real namespaced cache abstraction before cache clear/forget/tag-prune; preserve migration and scheduler locks. Introduce structured log storage before tail/follow/rotation commands. Storage links must be confined, owned and distinguish symlinks from files/directories.

Cryptographic key/env commands require an explicit consumer/key format, authenticated encryption, overwrite/rotation policy, permissions and tamper/wrong-key tests. Do not generate a decorative key no subsystem can consume. Combined optimize/clear must aggregate actual supported caches, report failures and never succeed merely because nothing was implemented.

**Exit evidence:** round trips and secret-redaction tests, safe atomic writes, non-TTY/refusal behavior, scoped idempotent removal and error recovery. General config/schema-table generators must be tied to supported contracts, not database configuration alone.

### M4 — Code-first HTTP, validation/auth and development lifecycle

**Depends on:** M1 plus the configuration/storage primitives needed from M3. The backend contract is a code-first Bun-native Request/Response router/server with explicit TypeScript controllers/routes. Generated applications separately use Vite + React views; runtime tests verify generated-app HMR/build, combined API+web proxy/lifecycle, and production serving on Linux. Non-Linux static serving remains unavailable. Worker-backed serve, route inspection/executable cache, validation/resources, consuming generators and live persistent maintenance are reviewed; authentication and managed reload remain subsequent work.

Build the route registry/dispatcher/middleware pipeline, typed request validation, JSON resources and authorization contracts. Then add route listing/filtering/verbose metadata and real route cache/clear behavior. Controllers, requests, resources, policies, validation rules and session tables must integrate with the running backend. The example User model does not supply authentication or password reset tokens.

Generated applications configure `dev.ts` to run the Bun API and Vite frontend as explicit children; dependency installation is separate and explicit. Verify Vite readiness/HMR, API proxying, coordinated shutdown and production static assets before crediting this integration. The generic development group provides foreground owned-child management, not process-group cleanup, background services, self-restart or service readiness; Bundle's own `bun run dev` script still watches the CLI.

**Exit evidence:** real local HTTP requests, rejected validation/auth flows, route cache invalidation, maintenance down/up actually affecting requests, host/port conflicts, signals and graceful service shutdown. React views belong to the generated frontend; no Blade/PHP or markup-driven backend configuration is introduced.

### M5 — Events, durable jobs and code-only delivery/broadcast contracts

**Depends on:** M1 and relevant M3 config/cache/storage primitives; broadcast authorization additionally needs M4 authentication.

Implemented slices include local events/executable cached registrations, consumed event/listener/job generators, durable local SQLite claims/renewal/retry/failure persistence, owned-worker execution/cancellation, keyset failed history, state/threshold monitoring and explicit scoped cleanup. Atomic persisted retry overrides and claim-boundary pause/resume/graceful restart are also implemented. Durable command dispatch, consumed code-only job middleware and fresh owned queue:listen cycles are implemented too. Durable native batches now have atomic mixed dispatch, member history and receipt-safe cancellation/retry/prune consumed by real processes; explicit schema2 upgrade requires old-process quiescence. Continue callback/chains, separately consuming ORM adapters and system-service integration before advertising those further capabilities. Preserve actual process, crash/retry, priority/ownership and destructive refusal evidence. ORM queue/failed/batch migrations need a separately consuming adapter, not the dedicated queue file renamed as a migration.

Consumed make:mail/make:notification now provide strict code-only plain-text contracts and explicit local outbox/mail adaptation; real generated/custom-stub delivery has evidence (the complete current generator set publishes26 templates). Local/injected adapters establish local behavior only, not inbox delivery, notification-table history, queues or other channels. `channel:list` now consumes a bounded root `channels.ts` registry and lists names without opening a service; this is metadata only, not authorization or a broadcast transport (see [broadcasting](broadcasting.md)). Continue broadcast and external transport work with code-only text/data payloads, not Blade templates. External SMTP/Redis/broadcast services remain separately gated and unverified until authorized tests run. Event list/cache/clear operate on real registries; event:generate now reads source registrations, fully preflights references/targets/templates and exclusively emits missing conventional listeners consumed by cached dispatch. Existing modules stay unchanged, and later I/O publication is explicitly nontransactional. Command dispatch consumes the M1 runner through a versioned durable envelope, not a callback in a stub; explicit argv persists unredacted and rollout to upgraded consumers is required.

**Exit evidence:** produced jobs are consumed, retries/timeout/failure/batch transitions are correct under real-process tests, controls reach running workers, and generated handlers/listeners/middleware actually execute. CLI/JSON monitoring must not be sold as a Horizon UI.

### M6 — Application scheduling

**Depends on:** M1 and M3 clock/state/locking contracts. Queued scheduled jobs additionally depend on M5; direct command tasks need not wait for a queue.

Typed strict task registration, deterministic numeric UTC minute matching, local overlap locks and real list/run/work consumption are now implemented. UTC-only rejects non-UTC zones rather than claiming DST support. Persisted global pause/resume and graceful generation interruption are also consumed at live command/poll boundaries, with a stable absent token and active settlement; read-to-invocation races remain explicit. Explicit or interactive id-only schedule:test executes one configured task irrespective of due time, with no dry-run claim. `schedule:clear-cache --force` removes only process-identity-verified stale versioned locks on Linux in the current PID namespace; active, cross-namespace and unsafe records are preserved; generic and legacy token-only records are skipped because their owner/type cannot be verified. Add timezone/DST semantics and owned background completion. The harness workflow/recurring wake mechanism is not an application scheduler implementation.

**Exit evidence:** deterministic-clock boundary/timezone tests, real task subprocesses, process interruption, persisted control state, overlap protection and ownership-validated completion. Version-dependent/internal Laravel commands need deliberate Bun contracts, not automatic aliases.

### M7 — Installers, providers and trusted package publication

**Depends on:** M2 scaffolding and M3 configuration. API installation additionally requires M4 routing/auth; broadcasting installation requires M5 transports and M4 channel authorization. These are separate slices, not prerequisites for creating a CLI-only project.

Explicit local providers.ts references, scoped service lifecycle and consumed make:provider now execute through the outer CLI runner with owned cleanup; explicit trusted local packages.ts metadata discovery/cache now feeds the same provider lifecycle. Explicit local code-only vendor publication and language catalogues are now consumed separately. Offline new-directory project creation/native interactive setup now emits a runnable Bun application from a fixed shipped-source allowlist; actual generated CLI/HTTP/routes/cache/SQLite/native-test/typecheck consumers pass. Outer new is a separate installer dispatch before current application registries; other commands keep normal provider bootstrap. Dependencies are declared but never silently installed, and server choices require separately supplied services/credentials. See [project creation](project-creation.md). API/broadcast installers remain unfinished. Define safe config/data/language/stub publishing, tags/ownership/collision behavior, and discovered metadata without treating arbitrary dependencies as application plugins.

**Exit evidence:** generated projects and providers execute; publication preserves existing files by default, rejects prohibited UI templates and path escapes, and uses versioned manifests. Any dependency fetching remains explicit opt-in and requires authorization; no silent downloads or provisioning.

### M8 — Optional ecosystem adapters

**Depends on:** M1/M3 foundations, then only the relevant backend: logs use M3; containers wrap the real CLI; managed servers/browser tests need M4; queue/search delivery integrations need M5 where asynchronous work is used. Package-based distribution may reuse M7, but is not necessary for a local adapter prototype.

Keep each choice independent and optional. Containers are a Bun alternative, not Sail. Worker monitoring/control is not Horizon. Bun server/WebSocket management is not Octane/Reverb protocol parity. Browser automation must use a TypeScript driver with explicit binary-install consent. Search needs document mapping, resumable import and index cleanup, not model discovery alone. Debugging/monitoring must have redaction, retention and bounded overhead with code-only CLI/JSON outputs.

**Blockers:** selected packages/tools, browser binaries and external Redis/search/mail/monitoring services are not supplied/authorized by this roadmap. Record local fixture and live-service evidence separately. Do not install PHP tools to make reference commands appear available. Pint stays explicitly excluded; choosing a TypeScript formatter is separate tooling work.

## JSON contract and maintenance

`docs/cli-compatibility.json` has `formatVersion: 1`, `items`, baseline/source metadata, status definitions/counts, milestone dependencies and blockers. Each item retains:

- `id`: exact corpus item ID; never an array index or invented command slug.
- `originalTitle`, `category` and `section`: original source wording and hierarchy, including duplicate examples.
- `sourceLocation`: one-based repository-relative Markdown location, plus the baseline fingerprint at document level.
- `referenceCompleted`: source checkbox state, never derived from compatibility status.
- `proposedEquivalent`, `status`, `reason`, `remainingWork`: honest Bun direction and explicit gaps/exclusion rationale.
- `evidence`: typed reference-only, implementation, automated-test or documentation pointers. A reference-only pointer is not implementation evidence.
- `milestone`, `dependsOn`: planned milestone assignment and its prerequisite milestones; item-specific runtime/service gates are named in remaining work and this document.

On each integrated feature:

1. Locate all affected IDs, including examples that refer to the same capability. Update only the statuses and claims supported by the integrated code, flags and tests; retain unrelated gaps.
2. Write the bounded implementation and actual verification result into the Bundle ledger in `PROGRESS.md`. Preserve original reference titles/categories; a rename/move can change corpus IDs and needs an explicit migration mapping.
3. Follow `/progress-graph` sync for approved source updates. Refresh source locations by ID and the fingerprint after regeneration. New ledger items do not belong to the frozen original scope unless the scope is explicitly revised.
4. Audit ID uniqueness, title/category/location matches, all 180 original references, valid statuses, nonempty reason/remaining-work/evidence and real evidence paths. Recompute counts rather than editing totals by intuition.
5. Run graph freshness, focused/full tests, typecheck and whitespace checks as required by the implementation loop. Record failures/skips; a stale source fingerprint or a skipped live test is not verification.

For a read-only ID/count audit from the repository root (after `bun run graph:check`), run:

```bash
bun run - <<'TS'
const corpus = await Bun.file("graph/corpus.json").json();
const backlog = await Bun.file("docs/cli-compatibility.json").json();
const sections = new Map(corpus.sections.map(section => [section.id, section]));
const originals = corpus.items.filter(item => {
  let section = sections.get(item.sectionId);
  while (section) {
    if (/^\d+\./.test(section.title)) return true;
    section = sections.get(section.parentId);
  }
  return false;
});
const rows = new Map(backlog.items.map(item => [item.id, item]));
if (originals.length !== 180 || backlog.items.length !== 180 || rows.size !== 180) {
  throw new Error("Original reference coverage changed; reconcile explicitly.");
}
for (const source of originals) {
  const row = rows.get(source.id);
  if (!row || row.originalTitle !== source.title || row.section.id !== source.sectionId ||
      row.referenceCompleted !== source.completed ||
      JSON.stringify(row.sourceLocation) !== JSON.stringify(source.location)) {
    throw new Error(`Missing or stale reference mapping: ${source.id}`);
  }
}
for (const [status, count] of Object.entries(backlog.counts)) {
  if (backlog.items.filter(item => item.status === status).length !== count) {
    throw new Error(`Stale count: ${status}`);
  }
}
console.log({ originalItems: originals.length, uniqueIds: rows.size, counts: backlog.counts });
TS
```

This small audit verifies provenance/counts, not runtime implementation claims. Review evidence paths, supported options, exclusions and validation results separately.

The inventory itself changes no feature code, dependencies, reference checkboxes or generated artifacts. It is not a promise of present or perpetual full parity. An iteration can be complete while most roadmap features remain pending; only the evidence ledger can justify broader completion claims.
