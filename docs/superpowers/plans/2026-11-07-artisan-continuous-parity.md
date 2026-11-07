# Continuous Artisan Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and test-driven-development for your owned task. The user has explicitly directed continuous implementation/debugging/testing without approval pauses.

**Goal:** Implement and verify every applicable reference capability, including executable consuming runtimes and supported option contracts; retain explicit architecture exclusions and genuine external verification blockers rather than manufacture 100%.

**Architecture:** Continue the existing Bun/TypeScript/MikroORM backend, native HTTP controllers/routes/models, and Artisan-style CLI. Generated applications now include a Vite + React TSX frontend with Fast Refresh/HMR and configured shadcn/ui primitives, connected to the backend by Vite's `/api` proxy in development and the Bundle worker's `dist/` static serving in production. JSX/TSX and HTML entry documents are permitted only for this frontend; do not introduce XML, AXAML/XAML, Blade/PHP, or markup-driven backend configuration. Preserve honest limits and evidence-ledger updates after each verified capability.

**Tech Stack:** Bun, TypeScript, Commander 15 and MikroORM 7.2.7 for Bundle/backend; generated frontend uses Vite 8, React 19, Tailwind CSS 4 and preconfigured shadcn/ui-compatible components.

**Spec:** `docs/cli-roadmap.md`, `docs/cli-compatibility.json`, `docs/cli-implementation-loop.md`, and the user's session goal of continuous implementation until complete.

## Global Constraints

- No more than three active workers; workers do not delegate or edit other lanes/shared registration, docs, graph or progress.
- Preserve all pre-existing dirty work. No commits, pushes, installs/downloads, service provisioning or existing application database resets by default. Later explicit consent is limited to NEW disposable PostgreSQL17/MariaDB11.4/Redis7.4 Docker fixtures, the official MariaDB11.4 image download, generated private test-only credentials and exact-owned cleanup; permission gates still apply and provisioning remains blocked as recorded below.
- Tests use unique disposable roots; do not touch the repository's real `.env` or application databases.
- Native verification in this session: `BUN_OPTIONS="" bun test --preload /home/recruas/.config/claudex/preload.cjs <paths>`; no global harness/settings changes. `BUN_OPTIONS="" bun run bundle test` exercises the public runner.
- Do not replace unimplemented behavior with successful no-ops. Do not silently redefine partial/excluded items as complete.

## Review Focus

- Filesystem operations must preserve user files, reject unsafe symlinks/paths and fail safely on collisions and unsupported formats.
- Native test output/exit/signal semantics and prior SQLite migration behavior must remain intact.
- Nested commands must have bounded recursion and predictable cancellation/disposal/event ordering, not shared mutable Commander state.
- Custom stubs must be consumed by real generators, and generated code must compile and execute.
- Cache/storage operations must not touch migration/scheduler locks or unrelated assets; cross-process/expiry/tag semantics need real evidence.

---

## Wave 2: Runtime, generator customization, local operations

### Task A — Scoped command runtime (worker A)

**Owned files:** `src/console/*`, `src/cli/runner.ts`, `src/cli/runner.test.ts`; no other files.

**Interfaces:** Preserve existing command/runner APIs and tests. Add an explicit typed service-container API with scoped/transient/singleton lifetimes and async disposal, command context access to services and AbortSignal, lifecycle subscriptions and a bounded `call(args)` path using fresh parser state. New context fields must be backwards-compatible with existing direct `executeCommand` callers. The exact new type names may be chosen locally but must be documented in the handoff.

- [x] Write failing tests for missing/cyclic dependencies, lifetime separation and disposal, nested status/output/collision handling, bounded recursion, event order and async listener/handler failure, parent cancellation and process signal cleanup.
- [x] Implement service scopes and general command lifecycle/cancellation/nested invocation through the actual runner, retaining class binding and raw test-subprocess output.
- [x] Verify focused console/runner tests and types; return supported contracts and limitations for independent review. Review repairs cover signal status, identity-based disposal, thenable cleanup and lifecycle subscriptions; integrated suite passed 297/2 skipped/0 failures before the additional process tests.

### Task B — Real stub customization and generator options (worker B)

**Owned files:** `src/cli/scaffolding*`, `src/cli/generators*`, new `src/scaffolding/*` as needed; no other files.

**Interfaces:** Preserve `registerScaffolding` and existing generation APIs. Add executable `make:config <name>`, `make:test --unit` with an explicit `tests/Unit` destination, command-name selection `make:command --command <name>`, and `stub:publish` for a fixed code-only template inventory consumed by subsequent generators. Source defaults may be exposed through new internal helpers, but no unresolved imports or nonexistent domain runtimes.

- [x] Write failing tests for published override consumption, missing/malformed tokens, unsupported templates/markup syntax, overwrite/path/symlink refusal, custom command names/collisions, and actual emitted config/unit-test execution.
- [x] Implement safe exclusive publication and code-driven custom stubs; preserve no-overwrite generators and documented literal PHP-trait exclusion.
- [x] Run focused generator/scaffold tests and strict generated-code checks; report exact flags and remaining differences. Published files use `.ts.stub` so unresolved tokens are not TypeScript sources; config generation is top-level and actually loader-consumable. Additional real-process publication/customization/config/unit/custom-name checks passed.

### Task C — Local cache and owned storage links (worker C)

**Owned files:** new `src/cache/*`, `src/storage/*`, `src/cli/local-operations.ts`, `src/cli/local-operations.test.ts`; no other files.

**Interfaces:** Export `registerLocalOperations(program: Command, context: {root: string; env: Record<string,string|undefined>; output:(text:string)=>void}): void`. Add a genuine persistent namespaced local cache API using built-in SQLite or an equally justified atomic local backend, with put/get/forget/clear, TTL, tags/prune and deterministic-clock tests. Register real `cache:clear`, `cache:forget`, `cache:prune-stale-tags` and storage link/unlink commands consuming a documented code-only configuration/owned-link manifest. Main wires registration.

- [x] Write failing tests for persistence across processes, TTL boundaries, namespacing, tag pruning, safe scoped clearing, malformed/unsupported stores, no interference with migration locks and symlink/path refusal.
- [x] Implement cache operations and owned storage links that preserve regular files/unrelated links; use trusted application configuration but do not execute untrusted uploads.
- [x] Run focused tests including real-process cache/storage behavior and type checking; report API/config/commands and limitations. Review repairs cover dangling/changed targets and absent owned destinations. Additional real-process namespace/tag/key operations and dangling-target unlink checks passed.

### Task D — Leader integration and continuing backlog

**Owned:** shared CLI registration/entrypoint integration, `src/cli/compatibility.test.ts`, required migration fixture copies, docs/progress/graph/backlog; other independent files only when no worker owns them.

- [x] Integrate reviewed APIs and fix verified findings, then run real entry-point tests for each new consuming contract.
- [x] Run full suite, typecheck, graph freshness and whitespace checks; reconcile progress/compatibility evidence and task state. Checkpoint: 347 pass / 2 live-server skips / 0 failures, strict types, fresh graph and 180-ID/evidence audit; 46 implemented / 28 partial / 97 pending / 9 excluded.
- [ ] Continue subsequent bounded waves for prompts/rendering, logs/dev/HTTP/routing/validation/auth, events/queues/mail/broadcast, scheduler, provider/package/installer and optional local ecosystem equivalents. Keep server/native-client/service verification blockers explicit until authorized services exist.

## Wave 3: Interactive console and general isolation

### Task E — Prompt APIs

**Owned:** new `src/console/prompts.ts` and tests. Produce typed text/password/confirmation/single-multiple selection/search prompts with defaults, async validation, cancellation, non-TTY fail-closed behavior and terminal-state restoration. No actual session stdin is consumed by tests.

- [x] Implement from failing tests, including actual PTY password non-echo evidence where available.
- [x] Review and integrate the public API; required-scalar argument prompting is separately integrated/tested through actual CLI PTYs with non-TTY refusal and preserved help/discovery/diagnostics.

### Task F — Rendering APIs

**Owned:** new `src/console/output.ts` and tests. Produce semantic/color output, tables, progress and explicit caller-driven spinner frames with plain redirected output, sanitized controls and bounded widths.

- [x] Implement from failing tests and verify cleanup/non-TTY behavior.
- [x] Independently review and integrate; document Unicode width and caller-driven animation limits. Leader review reproduced/repaired overall table-width, completion and NO_COLOR defects; real CLI consumers pass.

### Task G — Atomic custom command isolation

**Owned:** new `src/console/isolation.ts` and tests, command metadata/execution integration. Produce explicit opt-in definition metadata, canonical-root/key-scoped exclusive owned locks, real contention status and safe release; no unsafe stale expiry.

- [x] Implement from failing tests including overlapping handlers and actual process contention.
- [x] Review, integrate, document manual stale-lock inspection and flag differences; preserve migration locks separately. Independent review found ordinary acquire/release inspection races; regression-first repair and real subprocess stress pass.

## Wave 4: Code-first HTTP prerequisites

**Implementation choice:** use Bun's built-in Request/Response/server facilities with explicit TypeScript route/middleware functions, not a new third-party framework or markup. This is a builder choice under the continuing implementation directive, not a claim the user selected a framework.

### Task H — HTTP router and middleware runtime

**Owned:** new `src/http/router.ts` and `router.test.ts`. Export `createRouter(): Router`, `HttpContext` (`request`, readonly `params`, per-request `state: Map<string,unknown>`), `HttpHandler(context): Response | Promise<Response>`, and `HttpMiddleware(context,next): Response | Promise<Response>`. `Router.add(method: string | readonly string[], path: string, handler, {name?, middleware?}?)` returns the router; `fetch(request)` dispatches and `describe()` exposes safe route metadata without executing handlers. No CLI/shared registration edits.

- [x] TDD literal/colon parameter matching, validation/duplicate names and method-path collisions, URL decoding, per-request state, ordered middleware/next-once behavior, cancellation through Request.signal, 404/405 Allow, HEAD/OPTIONS and sanitized unexpected-error responses. Reject malformed/ambiguous/unsupported patterns explicitly.
- [x] Verify actual local HTTP requests through an ephemeral Bun server, cleanup on failure, and no external requests; return exact contracts for leader server/listing/cache integration. Independent review reproduced HEAD-discarded stream leakage; best-effort rejection-observed cancellation is repaired and actual HTTP regressions pass.

### Task I — Validation and JSON resources

**Owned:** new `src/http/validation.ts`, `validation.test.ts`, `resources.ts`, `resources.test.ts`. Export pure typed code-only validation rules/results with explicit required/optional/unknown-field behavior, safe structured errors without raw submitted values, and bounded Request JSON validation. Export typed JSON-resource transformation/collection response helpers. Do not import router yet or edit it; integration uses Request/Response interfaces.

- [x] TDD scalar/array/nested/plain-object/unsafe-key behavior, missing vs nullable values, custom async rules/cancellation, body-byte limits and malformed JSON/content types; no coercion or unsafe getters/prototypes by default. Independent review repairs cover inherited descriptor names, invalid unknown-field policy and oversized-array custom-work limits.
- [x] TDD resource field selection, pagination/meta/error behavior and JSON serializability; exercise real Request/Response objects and return exact API. Actual local HTTP routes consume bounded validation and explicit resources. No authentication claim is implied.

### Task K — Consuming integration and startup-cancellation repair

- [x] Add trusted code-first route source loading, route listing/filter/verbose controls and a real dev-server lifecycle using the router, validated host/port and signals. Actual inspection and serving consume the executable route cache.
- [x] Integrate reviewed validation/resource examples and associated controller/middleware/request/resource/rule generators, including actual generated-code execution, strict checking and safe nested relative imports.
- [x] Repair route import cancellation using an owned Bun worker rather than merely racing uncancellable in-host imports. Unexpected closure is observed, occupied ports refuse sharing, and stop terminates only an unresponsive owned worker after 250 ms. Real process tests cover pending imports and CPU-bound handlers without killing the embedding host.
- [x] Independently review/fix and run integrated verification before credit. HTTP checkpoint: 404 pass / 2 live-server skips / 0 failures, strict types in 89 files. Ledger/evidence/graph retain all original IDs; maintenance/auth/reload and remaining runtimes are not implied.

### Task L — Real cacheable route definitions

**Owned:** new `src/http/route-definitions.ts`, `route-cache.ts` and tests only. Define typed serializable routes referring to trusted root-relative TypeScript module exports, with optional class method descriptors and explicit middleware references. Root `routes.ts` may default-export `defineRoutes([...])`; arbitrary closure-based Router instances remain usable but must refuse route caching rather than serialize inert metadata.

- [x] TDD descriptor validation, safe module/parent/export resolution, executable hydration into Router, per-request class instances, malformed source/cache and import failure behavior. Independent review found direct entrypoint references; regression-first rejection covers both handlers and middleware. Trusted transitive imports are explicitly outside a no-source-execution guarantee.
- [x] TDD mode-0600 atomic exclusive/replacement cache at `bootstrap/cache/routes.json`, valid-cache precedence/clear, symlink/hardlink/parent refusal and cross-process evidence. Cache stores executable definitions, not function source or an unused list.
- [x] Integrate loader/server-worker/route:list and route:cache/clear; real processes and HTTP consume valid cache before directly loading routes.ts, with no silent fallback for corruption. Source closures remain intentionally uncacheable; normal trusted ESM behavior and running-worker restart limits are documented.

## Wave 5: Live maintenance and executable event registrations

### Task M — Persistent maintenance request gate

**Owned:** new `src/maintenance/*` and `src/cli/maintenance.ts`/test; leader alone integrates shared worker/registration/process fixtures. APIs: `enableMaintenance(root,{retrySeconds?,refreshSeconds?}?)`, `disableMaintenance(root): Promise<boolean>`, `readMaintenance(root)` and `maintenanceResponse(root,request): Promise<Response|undefined>`. State is a versioned bounded mode-0600 JSON file at `storage/framework/down.json`; absent state allows traffic, valid state returns JSON 503 with optional Retry-After/Refresh headers and no-store. Re-read per request so existing servers observe down/up. No secret bypass, redirects or rendered markup are implied. Refuse unsafe parents/files, corrupt/unowned state and unsupported options; never remove unrelated files/locks.

- [x] TDD atomic safe persistence, idempotent removal, input/format refusal and actual Request responses; down/up expose validated retry/refresh seconds. Review regressions enforce exact existing permissions and preserve corrupt/unowned state.
- [x] Independently review/fix and consume the gate in the running worker with sanitized fail-closed responses; actual CLI down/up reaches the same listener. Canonical root aliases work for both server and controls; unsafe beneath-root parents still refuse.
- [x] Whole-suite/types/evidence/graph reconciliation: 422 pass / 2 live-server skips / 0 failures, types in 102 files, all original IDs and runtime ignores verified.

### Task N — Real local event bus and executable registration cache

**Owned:** new `src/events/*` and `src/cli/events.ts`/test; no shared registration/generator/docs edits. `EventBus` supports validated named on/unsubscribe, sequential ordered snapshot dispatch with payload and AbortSignal, aggregated listener failures and stable describe metadata. `defineEvents` brands/copies/freezes `{event,listeners:[{module,export,method?}]}` registrations. `loadApplicationEvents(root)` consumes safe executable module references from a valid `bootstrap/cache/events.json` before directly importing trusted `events.ts`; absent both yields an empty bus. Root entrypoint references are rejected; transitive imports remain trusted. Class references require own prototype methods with fresh instances per dispatch.

- [x] TDD real dispatch ordering/failures/snapshots/cancellation, safe descriptor hydration and no-handler-execution introspection. Listener identities accompany counts; duplicate callback unsubscribe owns its specific registration.
- [x] TDD bounded mode-0600 atomic cache/exclusive replacement/clear, malformed/unsafe path refusal, cache precedence and separate-process dispatch. Clear preserves invalid/unrelated content. Fixed-URL ESM caching is an explicit architectural limitation; changed-source builds use fresh CLI processes, not hot reload.
- [x] Independently review/fix, wire actual event:list/cache/clear and cached dispatch/clear across processes, then reconcile evidence after full verification. No event:generate or durable/queued dispatch credit.

### Task O — Consumed optimization aggregate (leader)

**Owned:** new `src/cli/optimization.ts`/test plus shared CLI/process integration. `registerOptimization(program,{root,output})` provides optimize/optimize:clear for real supported configuration/route/event caches, not an inert alias. Report each operation's completed/failed state, attempt all operations and return failure on any error without leaking trusted source exception text. Existing caches require explicit force for replacement. Aggregate writes are not a transaction; partial completed operations must be visible. Clear only supported bootstrap caches and preserve application cache data, unrelated files and locks.

- [x] Real entry-point failing tests cover actual consumption/clear, no-force refusal, explicit replacement, partial failure reporting and lock preservation.
- [x] Implement/review aggregation over actual configuration, route and event backends. All three built caches are consumed by real next-process inspection; explicit partial results and sanitized nonzero failures are verified.
- [x] Full-suite/types/provenance reconciliation before ledger credit; unsupported PHP view/compiled caches remain excluded, not successful no-ops.

## Wave 6: Consumed event scaffolds and durable queue prerequisites

### Task P — Runtime-backed event and listener generators

**Owned:** `src/cli/scaffolding.ts`/test and `generators.ts`/test only. Add make:event/make:listener, nested PascalCase names, safe computed runtime imports and two consumed `.ts.stub` templates. Event class exposes a stable validated static event name and `dispatch(bus,payload,signal?)` helper consumed by EventBus; listener class exposes an own `handle(payload:unknown,signal:AbortSignal)` method with explicit example/no-policy behavior. No event:generate automatic registration claim. Preserve existing thirteen templates and no-overwrite/symlink/typecheck safety.

- [x] TDD emitted nested TypeScript compilation, runtime dispatch into generated listener, actual payload delivery through a customized consumed listener stub, publication token/refusal rules and ordinary typechecking.
- [x] Independent review/fix and actual next-process cached generated dispatch pass; namespace-derived identities, reserved AbortSignal and adjacent valid TypeScript braces repaired. Fifteen templates documented; integrated checkpoint 467 pass / 2 live-server skips / 0 failures, types in 115 files.

### Task Q — Durable local queue storage backend

**Owned:** new `src/queue/store.ts`/tests only. `QueueStore(path,clock?)` uses dedicated mode-0600 SQLite, never ORM databases. Export serializable `QueueJob` (`module`, `export`, optional `method`, JSON-safe `payload`) and `Reservation` including job/queue/id/attempt/owner receipt. APIs: `enqueue(queue,job,{availableAt?,maxAttempts?}?)`, `reserve(queues,{leaseMs?}?)`, `ack(receipt)`, `release(receipt,{delayMs?}?)`, `heartbeat(receipt,{leaseMs?}?)`, `fail(receipt,reason)`, bounded `listFailed(queue?)`, `retry(id)`, `forgetFailed(id)`, `close()`. Synchronous methods and injectable millisecond clock. Payloads/descriptors are strictly validated bounded lossless JSON; paths/exports are safe syntax but module import belongs to consumer.

- [x] TDD persistence, queue priority/FIFO/delays, atomic reservation receipts and owner/expiry refusal, lease heartbeat/recovery, max-attempt failure/retry/forget, malformed/unsafe/unrelated SQLite refusal, parent/file ownership and exact private creation mode.
- [x] Real subprocess concurrency proves no duplicate simultaneous unexpired claim; crash/expiry recovery remains at-least-once delivery, not exactly-once side effects or multi-host guarantees.
- [x] Independent review/fix; genuine worker/CLI consumes store. Contention regressions sample clocks after acquiring locks. Atomic settle reports real failure disposition and refunds cancelled attempts. No generated table/advanced adapter credit.

### Task R — Queue consumer integration (integrated and reviewed)

**Owned by leader/future bounded worker:** new `src/queue/execution.ts`, `execution-worker.ts` and tests; then default local queue opening, actual queue:work --once/stop-when-empty and failed/retry controls after Task Q. Executor `runQueuedJob({root,job:{module,export,method?,payload},timeoutMs?,signal?})` returns `{status:completed|failed|cancelled|timed-out}` without raw trusted exception/payload text. It resolves safe trusted modules in an owned Bun worker, supports own class methods/fresh instances, observes unexpected exits and terminates only that worker on bounded cancellation/timeout. Never terminate embedding host or claim undo of external side effects/spawned processes.

- [x] TDD owned execution through disposable real processes covers payload delivery, class methods, invalid exports/unsafe files, sanitized failure, never-settling imports/CPU-bound handlers, pre/active cancellation and unexpected exits. Independent review found no verified defects; 12 focused tests pass. Additional disposable probes covered async worker exceptions and uncloneable payloads. Storage/CLI integration is complete below.
- [x] Actual backend integration and actual-process claim/ack/retry/force-forget, priority/max-jobs and signal tests pass. Heartbeat ownership loss stops execution without acknowledgment; cancellation preserves the final attempt; permanent failure is reported truthfully. Independent re-review found no remaining verified scoped defects.
- [x] Public CLI, docs/evidence and full verification integrated. Generated event/listener consumers are verified; job generators are genuinely unfinished, not credited here. Pagination/--tries remain partial; advanced batches/monitoring/server backends remain separate tasks.

## Wave 7: Generated jobs and bounded queue operations

### Task S — Runtime-backed job generation

**Owned worker lane:** `src/cli/scaffolding.ts`/test and `generators.ts`/test only. Add make:job for nested PascalCase classes under src/jobs, an own handle(payload:unknown,signal:AbortSignal) example, safe no-overwrite output and one consumed customizable .ts.stub. Leader supplies real CLI enqueue/work integration; no job-middleware claim.

- [x] TDD strict generated-code compilation, own-method execution through the real executor, custom stub consumption and unsafe/reserved path/name refusal. Worker focused tests: 34 pass; leader observed actual generated-job failure before implementation, then actual CLI persisted generate/enqueue/consume passes.
- [x] Independent review reproduced oversized export/module paths accepted by the generator but rejected by enqueue. Regression-first shared encodeJob validation repairs both before writing; exact128/512 boundaries enqueue/reserve/execute/ack, and independent repair re-review passed. Actual CLI generated/custom job consumption and sixteen-template docs are integrated; full verification is recorded below.

### Task T — Paginated failures, metrics and scoped queue cleanup

**Owned worker lane:** `src/queue/store.ts`, new `src/queue/operations.test.ts`, new `src/cli/queue-operations.ts`/test. Preserve version-1 schema and all existing APIs/lease semantics. Add bounded cursor-based failed metadata pages (no raw payload/reason at CLI), state counts per named queue and strictly scoped force-required cleanup of only unreserved ready/delayed work or failed history. Never delete unexpired/expired reserved work through clear; no receipt invalidation or batch claim. Cutoffs use explicit epoch milliseconds and strict boundary semantics. Add queue:monitor, queue:clear, queue:flush, queue:prune-failed through separate registration; leader wires shared program/queue changes.

- [x] TDD cursor continuation beyond 1000 rows, filtering/validation/redaction, ready/delayed/reserved/expired/failed counts, exact cutoff and unrelated/active job preservation.
- [x] Real local process controls/force refusal and actual entrypoint registration/pages/clear/prune/flush pass. Leader added consumed cache-first queue.busy threshold events from a failing actual-process test. Independent review found no verified scoped defects; schema v1 and old lease APIs are preserved.
- [x] Full-suite/types/graph/provenance/doc reconciliation: 490 pass / 2 live-server skips / 0 failures, 6578 assertions across 55 files; strict types118, graph fresh and whitespace clean. All180 reference IDs/unchecked states preserved. Worker --tries override and pause/restart/batches remain pending unless separately implemented and verified.

## Wave 8: Explicit worker retry-attempt override

### Task U — Atomic per-claim retry policy and public --tries

**Owned worker lane:** `src/queue/store.ts`/tests, `src/queue/worker.ts`/tests and `src/cli/queue.ts`/tests. Add optional reserve/work maxAttempts and CLI --tries integer1–100, no default override. Explicit policy applies atomically when eligible work is newly claimed; persist it so heartbeat/expiry/settlement/recovery use the same budget. Exhausted due work under a lower override fails without one extra execution. Higher overrides can recover an eligible expired claim rather than prematurely applying its old policy. Never alter an unexpired owner's policy/receipt or override unrelated/not-yet-due work. No override preserves prior producer policy. Cancellation refunds the current attempt under the chosen policy; explicit retry resets attempts as before. Delivery stays at least once and timeout/backoff units stay milliseconds. Leader owns shared actual-process tests/docs/ledger/graph.

- [x] TDD lower/higher/absent policy, exhausted ready/expired claims, protected live/unselected/future work, delayed/retry/cancellation/ownership behavior and invalid values before opening storage. Worker policy/CLI focused27 pass; leader actual higher/lower/timeout/cancellation/invalid process tests8 pass.
- [x] API/CLI integration and independent repair re-review pass. High stale-clock defect after exhaustion scanning is fixed by ID-keyset progress, fresh publication timestamps and eligibility/expiry SQL rechecks (including rollback). Reviewer repeated10k-row reproduction:14ms and immediate ack true, versus1682ms/false before. Focused policy/lock tests20 pass; exhaustion remains deliberately lazy/selected, not globally swept.
- [x] Full-suite/types/provenance/docs reconciled: 527 pass / 2 live-server skips / 0 fail, 14862 assertions, types123; graph freshness/whitespace pass. Retry example credited only after repair re-review and final leader verification; no batch/service evidence implied.

### Task V — Persisted local worker controls

**Owned independent backend lane:** new `src/queue/control.ts`/tests and `src/cli/queue-control.ts`/tests only. Keep control state separate from the version1 jobs schema at private `.bundle-queue/control.json`; canonical root aliases work, unsafe/corrupt/unowned/symlink/hardlink state is preserved and refused. Version1 state exposes restartToken:string|null and pausedQueues:readonly string[], bounded128 named queues and64KiB. Atomic mutations use owned locks without unsafe expiry. APIs: readQueueControl(root), pauseQueue(root,queue), resumeQueue(root,queue), requestQueueRestart(root); mutations return actual changed/state metadata. CLI queue:pause <queue>, queue:resume <queue>, queue:restart manipulates real persisted state, no worker lifecycle claim until leader consumption. Restart changes an opaque generation; it requests graceful worker exit after in-flight settlement, not self-respawn. Leader subsequently filters paused queues and observes generation before the next claim, with real running-child tests; worker/CLI integration waits for Task U's overlapping worker files.

- [x] Backend state/CLI tests cover persistence/idempotence/tokens/limits/aliases/paths/permissions/corruption and stale locks; leader observed three actual worker controls fail before integration, then pass. Fixture roots/aliases are now cleaned.
- [x] Worker consumption and concurrency repair are independently re-reviewed. Bounded64x1ms retry handles demonstrably unstable snapshots without clean fallback; stable unsafe state still refuses. Reviewer reran28k reads/3k pause-resume replacements with zero errors (prior2336), actual idle CLI regression passes, stable hardlink/corrupt state preserved. Sustained instability fails closed. Active jobs settle before restart/pause, new workers baseline current generation and paused work is ineligible.
- [x] Actual running-child pause/resume/graceful restart, fail-closed unsafe state, concurrent idle CLI survival and full-suite/types/docs/graph/evidence verified before command credit: 527 pass / 2 live-server skips / 0 fail. No listen supervisor, middleware/batch or Redis evidence implied.

## Wave 9: Durable console-command dispatch

### Task W — Versioned command envelope and owned runner execution

**Owned worker lane:** `src/queue/store.ts`, new `dispatch.ts`/test, queue execution/worker modules/tests, `src/cli/runner.ts`/test and `src/console/command.ts`. Leader owns actual-process compatibility tests, docs, ledger/graph and evidence. Preserve existing module descriptors and version1 SQLite schema. Add disjoint `{kind:"command",version:1,argv:string[]}` envelope and `dispatchCommand({root,argv,queue?,availableAt?,maxAttempts?}):Promise<number>`; root is explicit absolute/canonical, argv is dense nonempty with a valid first command name, at most128 arguments/4096 characters each and total64KiB. Validate before storage; do not pre-import commands, create helper files, persist environment/services/hooks or execute a shell.

Owned execution invokes the real runner with root/signal, explicitly noninteractive prompts and discarded context output/errors. Trusted direct console/subprocess streams cannot be comprehensively intercepted. Exactly0 completes, every nonzero return fails/retries, including130/143 without actual cancellation. Conditional commandExitCode metadata carries only finished-command status; queue cancellation/timeout wins and no argv/output/raw exception is published. Worker runner disables its own process signal listeners through an opt-out while ordinary CLI retains its current behavior. Old consumers cannot execute the new envelope; coordinated consumer rollout is required. At-least-once and ordinary trusted-code limitations stay explicit.

- [x] Leader actual-process tests observed missing dispatch failure before implementation: exact argv/no shell/delayed discovery, status7 retry/exhaustion/source-change recovery, returned130/143 failure, noninteractive prompts and cooperative SIGTERM/refund.
- [x] Worker TDD bounded validation/no storage on refusal, argv snapshot/boundaries, legacy schema, rooted execution, statuses and signal-listener opt-out; initial reported full542 pass/2skip/0fail/types125. Leader8 actual process cases pass. Review subsequently found syntactically invalid stored JSON rolling back attempts/starving later jobs; preserving null-decode repair passed independent re-review, with final provenance/credit still pending.
- [x] Independent invalid-JSON starvation finding repaired with nullable decode/ordinary receipt-budget accounting/raw preservation. Repair re-review8 tests38 assertions and original reproduction pass. Leader actual8 process cases and final complete581 pass/2skip/0fail/types133 pass.
- [x] Documentation/provenance/inventory reconciled after integration/review/full verification. All180 reference IDs/titles/unchecked states preserved; final84 implemented/29 partial/58 pending/9 excluded includes the bounded command envelope contract.

## Wave 10: Consumed job middleware

### Task X — Ordered owned-worker middleware and code-only generator

**Independent worker lane:** new `src/queue/middleware-definitions.ts`, `middleware.ts`/tests and scaffolding/generators/tests only. Leader later wires optional bounded references into persisted jobs/owned execution, shared actual-process tests and documentation after Task W review. Public references identify safe trusted modules/functions or own class methods, at most16 per job; validation is strict, bounded and copying. `runJobMiddleware({root,references,context:{job,signal},run})` supplies ordered next-once nesting, awaits already-started downstream work even when a middleware omits awaiting next, fresh class instances and propagated failures. An intentional no-next middleware completes without running the job; it is not automatic release/retry. Runtime belongs inside the existing owned worker and shares its timeout/cancellation, not a new sandbox.

`make:job-middleware` generates a nested explicit pass-through function under `src/queue/middleware`, with computed runtime import and a seventeenth consumed customizable `.ts.stub`; safe paths/no-overwrite/typechecking remain. Production integration and actual consumed persisted jobs are required before item credit.

- [x] Worker TDD strict references, ordering/next-once/downstream waiting, short-circuit/failure/cancellation, checked modules/fresh classes, generated/customized stub execution and strict types. Focused43 tests/292 assertions pass; exact128/512 generated boundaries compile and oversize refuses output.
- [x] Leader observed5 actual and2 backend middleware regressions red, then integrated store/owned-worker pipeline. Command producer middleware validation/snapshot regression also observed red then fixed. Module/command references persist and execute; actual13 process cases and focused15 backend tests pass, types129. Shared stub assertion now17; earlier concurrent incomplete-integration full-suite failures are resolved in focused runs.
- [x] Recovery review exposed an ambiguous contract; rejected thenable observation and adopted explicit next.recover(handler), native Promises, tracked recovery and unchanged plain-next failure propagation. Missing recover observed red; independent re-review9 tests51 assertions plus7 actual tests42 assertions found no remaining scoped issue. Leader final581 pass/2skip/0fail/types133/source provenance and bounded middleware credit verified;17 stubs and explicit recovery differences documented.

## Wave 11: Owned queue listen supervision

### Task Y — Fresh owned command-worker process per cycle

**Independent worker lane:** new `src/queue/listener.ts`/test and `src/cli/queue-listen.ts`/test only. Leader later registers and supplies actual entry-point evidence. `listenQueue({root,env?,signal?,queues?,sleepMs?,timeoutMs?,maxAttempts?,retryDelayMs?,maxCycles?,output?,error?}):Promise<{cycles:number}>` validates before state/children, canonicalizes explicit absolute root and starts a fresh owned Bun process running the real rooted `queue:work --once` per cycle. No shell/helper file/default-cwd inference; child stdin ignored, concurrent streaming outputs are not accumulated. maxCycles counts child invocations, not job attempts. Sleep after every cycle is an explicit throughput limitation.

Nonzero child exits fail closed without a respawn storm. External cancellation forwards to only the owned child, then bounded1000ms grace/kill and awaited cleanup; preabort spawns none. Restart generation is baselined and observed between cycles, so active child settles before graceful exit, not active-work cancellation/system-service self-respawn. Pauses use the child worker; ordinary read/claim races remain. Parent trusted imports and app-spawned subprocesses are not magically bounded or cleaned up by job timeout.

- [x] Fresh children/root/env, finite cycles/real jobs/source changes, nonzero/generation controls and cooperative/uncooperative cancellation; invalid options before storage. Initial tests red before modules; additional regression coverage was added afterward. Leader identified callback child leak/canonical alias refusal and inherited-pipe hang: each reproduced red and repaired. Focused18 tests41 assertions/types133 pass; raw callback failures generic, only owned child terminated/reaped and250ms post-exit drain avoids grandchild pipe pinning (late output may be lost).
- [x] Leader registered CLI after actual3 process regressions red; all3 pass23 assertions (fresh PIDs, acknowledgments, restart active settlement/SIGTERM refund). Independent final lifecycle review18 tests41 assertions found no verified important defect; leader final581 pass/2skip/0fail/types133.
- [x] Docs/graph/inventory reconciled and queue:listen bounded credit verified. Final graph49 sections/479 nodes/541 edges,79 registered commands; no unrestricted Laravel/Redis/service-manager parity.

## Wave 12: Deny-default code-first authorization policies

### Task Z — Consumed policy classes and explicit request guards

**Independent worker lane:** new `src/http/authorization.ts`/tests plus scaffolding/generators/tests. Leader owns actual CLI/live HTTP tests, docs and inventory. `PolicyContext` carries ability/principal/resource/signal; `AuthorizationPolicy.can(context)` must return a strict boolean, preserving instance binding. `evaluatePolicy` and `authorizePolicy` validate bounded abilities and cooperative cancellation; explicit denial throws a generic AuthorizationDeniedError, invalid/throwing results never allow. `policyMiddleware({policy,ability,principal,resource?})` resolves data per request, checks before next, returns sanitized no-store403 on denial and leaves other errors to Router's sanitized500. This is authorization only, not authentication/session/token validation or trusted identity inference; null principal is an explicit policy input, and generated policies deny everything.

`make:policy Nested/InvoicePolicy` generates an own-can class under `src/http/policies` with computed type imports and an eighteenth consumed custom stub. Classes must not collide with imported type names; no overwrite/symlink parents, strict compilation and actual requests consume default/custom policies. No automatic registration/model-aware flags or auth installer implied.

- [x] Leader2 actual CLI/live HTTP tests observed missing-generator red: default deny before handler/private data, and custom async principal/resource allow versus guest/other denial, no overwrite, no authentication claim.
- [x] Worker initial runtime/scaffold tests red on absent module/unsupported kind, then implemented strict decisions/cancellation/binding and default/custom consumed policies. Extra edge tests added afterward, not individually red-proven. Type imports aliased so AuthorizationPolicy/PolicyContext class names compile. Reported full589pass/2skip/2fail solely stale17->18 assertions; leader fixed those and focused45 tests309 assertions/types135 pass. No hidden failures.
- [x] Leader4 live policy cases/namespace-event5 tests35 assertions and initial full591pass/2skip/0fail verified. Independent review reproduced cancellation after evaluation but before caller continuation. Two nested-microtask regressions observed red; immediate post-await checks repaired both callers. Focused policy/actual CLI81 tests544 assertions pass. Independent repair re-review confirmed aborted/rejected callers and no handler invocation, no further scoped defect. Fresh full593pass/2skip/0fail,15211 assertions/types135/80 built-ins/graph/whitespace verified.
- [x] Source/evidence/graph/docs reconciliation preserves180 original unchecked reference IDs. Final post-reconciliation593 pass/2skip/0fail,15229 assertions across64 files/types135, graph freshness/whitespace pass. Graph50 sections/483 nodes/546 edges,80 built-ins; inventory85 implemented/29 partial/57 pending/9 excluded (47.2% all,49.7% applicable). Auth/session/install features remain unfinished.

## Wave 13: Explicit local text delivery

**Spec:** `docs/superpowers/specs/2026-11-07-local-text-delivery-design.md`. Leader-selected local-only architecture under the standing continue-without-questions directive; no external service consent inferred.

### Task AA — Validated text mail, private outbox and explicit notification adapter

**Files:** create `src/mail/mail.ts`, `src/mail/outbox.ts`, `src/notifications/notification.ts` and focused tests. Exact APIs/bounds in spec. Runtime worker owns these files only. Preserve private create-only state and generic diagnostics; read is explicit raw inspection, list only metadata. No network, packages, ORM tables or automatic dispatch. Tests cover copied strict shapes/limits, missing transport, generator-compatible classes, cooperative signal completion checks, exact private modes, canonical root aliases, malformed/unsafe files preserved, concurrent writes and bounded reads.

- [x] Initial absent-module tests red, then runtime implemented. Later coverage not individually red-proven. Worker identified temporary-path substitution, unbounded listing and abort-after-link defects; all3 deterministic regressions observed red before repair. Identity checks/owned cleanup, incremental1000-entry scan/refusal and cancelled owned-publication cleanup added. Focused14 pass50 assertions/types149; actual generated delivery1pass19 assertions. Earlier concurrent incomplete-suite failures reported, not hidden.
- [x] Independent delivery review verified4 additional findings: ordinary1001-message listing failure, transient normal two-link listing failure,128KiB record mismatch and missing directory sync. Each defect regression observed red before repair. list early-stops, iterate provides streaming traversal, matching temporary publications omitted,128KiB enforced and directory fsync required before receipt. Focused19pass62assertions/types149. Independent re-review reproduced all4 resolved; no further scoped important defect. Final leader post-provenance641pass/2skip/0fail,15551assertions/types149/graph/whitespace passed; conditional fsync/path-based/live-iterator limits documented.

### Task AB — Consumed mail/notification generators and actual-process evidence

**Files:** modify `src/cli/scaffolding.ts`, `generators.ts` and corresponding tests; leader owns `compatibility.test.ts`, shared docs/PROGRESS/graph/inventory. Consume the exact runtime interfaces from Task AA via computed aliased imports. Destinations `src/mail/<name>.ts`, `src/notifications/<name>.ts`, two new consumed `.ts.stub` templates (20 total); no dispatch at module import/construction, no overwrite/force or model/table implication.

- [x] Leader observed2 actual CLI missing-generator regressions red plus invalid-mail integration missing-generator red. Generator worker observed both commands unknown red; implemented default/custom strict compiled consumed output, aliased collision names, no overwrite/symlink refusals and20 stubs. Focused47 pass325 assertions, earlier types141; latest shared full gate still required.
- [x] Leader actual separate-process generation/import/send, notification adapter/custom stubs/no overwrite/private lossless content and safe metadata pass in final641-test gate. Initial integrated list failure code1 generic outbox error was observed during active repair; no longer reproduced, root cause not established independently. Ordinary paused-publication listing race was subsequently independently reproduced and repaired.
- [x] Independent review and final full suite/types/graph/provenance gate passed. Mail/notification bounded credit reconciled; external delivery, notification tables and absent channels remain unfinished.

## Wave 14: Bounded UTC scheduling

**Spec:** `docs/superpowers/specs/2026-11-07-utc-command-scheduling-design.md`. Read-only scheduler scoping completed; leader chose dependency-free UTC-only first slice, no DST claims or fake controls.

### Task AC — Deterministic cron and immutable trusted definitions

**Files:** new `src/schedule/cron.ts`, `definitions.ts` and tests only. Exact field/shape/argv/source limits and matching semantics in spec. This lane is independent of delivery; do not touch shared CLI/docs/graph or runner. `defineSchedules`, `loadSchedules`, `compileCron` and `isCronDue` are the consumed future interfaces. Parser alone receives no feature credit.

- [x] Parser worker observed absent modules red, then implemented deterministic UTC/calendar/OR/range-step matching and bounded immutable definitions/source loading. Focused6 tests59 assertions pass; later coverage not individually red-proven. Concurrent suite/type failures in delivery/unfinished consumer reported, not clean-full claims.
- [x] Independent scheduler review covered parser plus consuming runtime/actual CLI; no parser defect verified. Consumer cancellation/signal findings repaired/re-reviewed under AD. Source/inventory claims still await final shared full gate. No interrupt/pause/resume/clear-cache/finish/test stubs.

### Task AD — Real schedule listing, one-slot execution and deduplicated local work

**Files:** new `src/schedule/runner.ts`/tests and `src/cli/schedule.ts`/tests; leader registers in `program.ts`, owns actual compatibility/docs/evidence. `listSchedules(definitions,at)` returns metadata only. `runDueSchedules({root,env?,signal?,at?})` loads validated definitions, evaluates one UTC slot and calls actual rooted runCli with noninteractive prompts/discarded injected I/O, handleSignals:false and fresh scopes. Results expose id/outcome/conditional exitCode only; nonzero fails aggregate. Direct schedule:run/work targets refuse before locks to prevent accidental recursive schedulers. Overlap default skip acquires/relinquishes identity-owned command lock keyed `schedule:<id>`; no automatic expiry or exactly-once claim.

`workSchedules({root,env?,signal?,sleepMs?,maxCycles?,now?,onResult?})` counts polling cycles and executes each observed absolute minute at most once in that process (monotonic high-water minute; backward clocks do not replay). No catch-up/backfill. Default1000ms polling, finite validated controls; cooperative signal-aware delay/active work and bounded metadata callback, no accumulated infinite results. Returns counts only. UTC-only and fixed-import source freshness explicit.

- [x] Actual CLI list/work unknown-command assertions and missing runner module observed red; CLI focused list/status red (other2 refusal tests initially passed missing commands, not independent red proof). Leader implemented validated exact-argv/noninteractive rooted execution/overlap/release/nonzero/cancel/high-water work and strict UTC CLI date/options/signals. Focused11 pass47 assertions; additional actual cooperative SIGTERM/lock-release/later-skip coverage passes3 actual cases21 assertions, added after implementation.
- [x] Independent review reproduced2 defects after initial full634pass/2skip/0fail: work imported trusted source after abort during root resolution, and scheduler overrode handleSignals:false. Both regression assertions observed red; post-root check and option propagation repaired. Independent re-review reproduced absent import marker and host-only signal/status0; focused17pass96 assertions and actual2pass14 assertions, no further defect. Leader actual3 cases including SIGTERM pass21 assertions. Final post-provenance641pass/2skip/0fail,15551assertions/types149/graph/whitespace pass; bounded list/run/work credit reconciled, no durable controls or extra no-op registrations.

## Wave15: Persisted scheduler controls

**Spec:** `docs/superpowers/specs/2026-11-07-scheduler-controls-design.md`.

### Task AE — Private scheduler pause/resume/generation backend

**Files:** new `src/schedule/control.ts`/test and `src/cli/schedule-control.ts`/test only (worker lane); leader owns program registration/runtime integration/actual compatibility/docs/graph/inventory. Exact APIs/defaults/version1 fields/private modes/atomic read-retry and nonexpiring owned mutation lock in spec. Separate `.bundle-schedule` state, no queue/ORM coupling or active-work force cancellation.

- [x] Worker both-module tests missing-module red; implemented strict private owned state/roundtrip/refusals/duplicate and byte-bound validation/concurrent atomic publication and consumed command module. First-pause sentinel and native-error redaction regressions observed red before repair; expanded safety/concurrency/process coverage added afterward, not independently red-proven. Focused18pass1762assertions (including runner),types153. Backend worker finished.
- [x] Leader2 actual missing-control-command regressions red, then registration/live runtime boundary reads integrated. Actual paused skip/resumed newrun and active-settlement interrupt/later-skip/newconsumer baseline pass2 tests19assertions. Leader first-pause publication regression exposed accidental interrupt (cycles1/interruptedtrue versuscycles3): repaired backend default stable UUID sentinel, only interrupt changesgeneration; focused14pass45assertions. Corrupt-state-before-import and future-slot resume coverage added after integration, not independently red-proven. Whole actual compatibility83pass579assertions/types153. Initial full654pass/2skip/0fail,17196assertions across73files/types153/graph/whitespace pass; independent review still active.
- [x] Independent read-only review found no verified scoped defect; focused18tests and actual2process cases independently pass. Final post-source/provenance leader654pass/2skip/0fail,17013assertions across73files/types153; graph freshness/whitespace pass. Graph53sections/495nodes/563edges;88 built-ins. Bounded3-item credit reconciled:93implemented/29partial/49pending/9excluded (51.7%all,54.4%applicable). All180 original unchecked IDs preserved. No clear-cache/finish stubs, unsafe stale unlock or broad100% claim. Worker/reviewer finished.

## Wave16: Native consumed database generators

**Spec:** `docs/superpowers/specs/2026-11-07-consumed-orm-generators-design.md`.

### Task AF — Real factory, type, query helper and subscriber scaffolds

**Worker files:** scaffolding.ts/generators.ts and corresponding tests only. Native installed MikroORM Factory/Type/find/EventSubscriber are the consuming backends; no new decorative wrappers or dependencies. Exact paths/signatures/tokens/required --model and explicit registration/input in spec. Leader owns actual SQLite CLI consumption/docs/graph/inventory;24 total stubs.

- [x] Leader four separate actual missing-command assertions plus combined native SQLite consumer test observed red5tests; worker implemented scaffold/generator lane with strict default/custom consumption/private path/model refusal and24-stub publication compilation gates. Focused57pass/types153; leader corrected actual consumer fixture to native schema.create() and id lookup after reproducing its errors.
- [x] Actual separate process generated factory persists/flushes, custom type roundtrips, named query filters and registered observer receives actual afterCreate; no DB config or connection during generation. Leader7 native/selection actual tests31assertions passed; initial full676pass/2skip/0fail,17535assertions across73files. Independent review reproduced separate-export false rejection and string-decoy false acceptance in model class preflight; original worker active repairing regression-first. No wave16 credit yet.
- [x] Independent review reproduced separate/aliased class export false rejection, lexical string decoy false acceptance and postfix ++/-- division false rejection. Worker regression-first repairs now use bounded token-aware helper and readonly model;61focused400assertions/types156. Final independent re-review original/alias/string/postfix probes correct, no further verified defects; nativeactual5pass22assertions. Final full/source/graph/provenance gate705pass/2skip/0fail,17485assertions/types157; four-item credit reconciled with waves17–18 below. Server dialect verification remains separately gated. Implementation/repair/review workers finished.

## Wave17: Interactive scheduled-task testing

**Spec:** `docs/superpowers/specs/2026-11-07-schedule-selection-design.md`.

### Task AG — Explicit and interactive selected execution

**Leader files:** schedule/runner.ts/tests, cli/schedule.ts/tests, cli/runner.ts/program.ts prompt propagation, compatibility tests/docs/graph/inventory. `runScheduledTask({root,id,env?,signal?})` reuses owned execution/control pipeline for exactly one validated selected task irrespective of due expression; retain pause/overlap/cancel/status. schedule:test --task or injected select with id-only labels, fail-closed non-TTY/no-default. Refuse direct scheduler-test recursion. No source edits/automatic unpause or dry-run claim.

- [x] Actual explicit/realPTY missing schedule:test command assertions red2tests and missing runScheduledTask export red; implemented selected owned pipeline reuse, whole-registry validation/direct-test recursion refusal and prompt propagation. Focused18pass68assertions/types153 plus2actual9assertions pass. Injected adapter/empty/cancel/failure coverage added afterward, not independently red-proven. Nativegenerator worker is separate; no shared production ownership overlap.
- [x] Independent review found no verified defect; documented command-local Bun workaround then independently passed19focused70assertions and2actualPTY/explicit cases9assertions. Non-member adapter coverage added after implementation, not independently red-proven. Final source/graph/provenance705pass/2skip/0fail/types157, one-item credit reconciled. Real PTY uses existing Python3 support, no installs. Reviewer finished.

## Wave18: Explicit local application providers

**Spec:** `docs/superpowers/specs/2026-11-07-provider-bootstrap-design.md`.

### Task AH — Ordered backend lifecycle and real runner consumption

**Worker files:** new console/providers.ts/providers.test.ts only. **Leader files:** cli/runner.ts/runner.test.ts, actual compatibility cases. Public interfaces and bounds in spec. Root providers.ts references64maximum; strict classes/own hooks; all register then all boot; reverse idempotent cleanup. Outer invocation only, before command imports, nested calls share initialized container. Nonempty automatic registry with caller-owned container refuses without mutating/disposal; explicit backend/build-only composition remains available.

- [x] Backend missing-module red (behavioral cases not individually red-proven), implemented strict copied definitions, checked loading, cooperative lifecycle/failure cleanup;8focused28assertions. Own instance-shadowed hook regression individually red then repaired; expanded loading/refusal coverage afterward. Backend worker finished.
- [x] Leader3 runner/1 actual provider-dependent nested command regressions observed red, then once-only outer runtime bootstrap integrated. Explicit caller-container refusal/owned lifecycle and no ORM coupling verified. Actual default/custom make:provider2 missing-command reds, then consumed strict generated classes/namespace keys/custom templates/25stubs integrated. Independent review found cleanup signal removal and throwing-sink scope leak; leader reproduced both red, plus error-sink skipping container cleanup red, then finally/deferred-diagnostics repairs. Leader35focused141assertions/types157 and5actualprovider26assertions pass. Extra safety/process coverage added after implementation, not independently red-proven.
- [x] Independent final re-review reproduced correct scope/finish/provider order despite throwing sinks and SIGTERM143 during disposal; no further verified defects. Independently35focused141assertions and5actualprovider26assertions pass. Leader final full705pass/2skip/0fail,17485assertions across75files/types157; graph56sections/507nodes/579edges,94measured built-ins, source/whitespace/provenance pass. Six total wave16–18 credits reconcile99implemented/29partial/43pending/9excluded (55.0%all,57.9%applicable). Backend/repair/review workers finished.

## Wave19: Registered missing event listener generation

**Spec:** `docs/superpowers/specs/2026-11-07-registered-event-generation-design.md`.

### Task AI — Source-driven event:generate with real dispatch consumption

**Worker files:** new cli/event-generation.ts/tests, scaffolding.ts shared validation/render/publication helper, cli/events.ts registration and focused events tests only. **Leader files:** actual compatibility/default/custom compile/cache-dispatch cases, docs/source/graph/inventory. Read root branded registrations, not cache. Native string event identities need no fabricated class; generate only missing explicit src/listeners nested own-handle classes, preserve existing checked modules. Bounds128events/256refs, dedup and complete preflight before exclusive writes; no transaction/rollback/overwrite claim.

- [x] Leader2 actual default/custom event:generate missing-command cases observed red before production; third refusal case passed against unknown command and is not individually red-proven. Worker observed2missingAPI/1realCommander-registration failures red, implemented default/custom listener generation and complete source/target/template preflight with128/256bounds. Worker20focused159assertions/types159; later safety/custom/source coverage not individually red-proven. Worker finished; no registration/cache/source rewrites.
- [x] Leader3actual CLI cases28assertions pass: default/custom generated listeners strictly compile, actual cached dispatcher invokes them without changed-source fallback, customized handler writes only on dispatch, source/cache/output preserved even with force. Unsupported missing descriptor refuses before conventional output.
- [x] Independent review found no verified defect;8focused23assertions and3actual28assertions independently passed. Later ENAMETOOLONG publication after an earlier output is within the explicitly nontransactional I/O-failure contract, reports failure and is not claimed all-or-nothing. Later boundary/link coverage10focused32assertions passed. Reviewer finished. Final full737pass/2skip/0fail,18142assertions/types165 plus source/graph/provenance/whitespace passed; one-item credit reconciled.

## Wave20: Explicit local package metadata discovery

**Spec:** `docs/superpowers/specs/2026-11-07-explicit-package-discovery-design.md`.

### Task AJ — Private discovered metadata and real cached provider consumption

**Worker files:** new packages definitions/cache/tests and cli/packages.ts/tests only. **Leader files:** program.ts registration, console/providers.ts combined metadata consumption, runner startup probe, actual compatibility tests/docs/source/graph/inventory. Explicit packages.ts,32packages/64provider total, trusted root-relative provider modules. Private strict version1 metadata cached without executing providers; cached providers later boot through actual lifecycle. No dependency scans/downloads or vendor publication.

- [x] Worker observed missing definitions/cache/CLI modules red, implemented strict copied definitions/private bounded cache/force replacement/safe clear/source preflight and generic commands. Initial8focused42assertions/types165; later safety coverage not individually red-proven. Worker final-prepublication cancellation regression red then repaired; concurrent replacement stress exposed now-unlinked old inode false refusal, red then bounded reader retry repaired. Expanded first-link/replacement stress and size/hardlink/alias source safety coverage;12focused449assertions/types165. Stress not all-interleaving proof, foreign-owner fixture not run. Worker finished.
- [x] Leader2actual missing-command and2focused cached-reference/duplicate regressions red, then registration/cache-first combined refs/startup probe integrated.43focused169assertions and2actual20assertions passed; earlier full730pass/2skip predates later repairs. Independent review reproduced dropped runner cancellation; leader deterministic source-import abort regression red then signal propagation repaired,1case6assertions pass. Expanded real SIGINT/SIGTERM cancellation/cache-preservation and caller-container/preabort coverage added afterward;4actualpackage28assertions/types165 pass. No source fallback/new-provider execution in discovery builder; earlier ordinary CLI bootstrap remains explicit.
- [x] Independent final re-review original abort repro nowstatus1/no publication, immediate commit check and bounded reader retries found no further verified defect;48focused582assertions and4actual28assertions pass. Leader58combinedfocused614assertions/7actual56assertions/types165 then final full737pass/2skip/0fail,18142assertions across79files and graph/provenance/whitespace pass. Two wave19–20 credits reconcile101implemented/29partial/41pending/9excluded (56.1%all,59.1%applicable),97built-ins, graph58sections/515nodes/589edges. All180 baseline reference states unchanged. package:clear is an extra native administrative command, not another reference item. Workers/reviewer finished.

## Wave21: Consumed local language publication

**Spec:** `docs/superpowers/specs/2026-11-07-local-language-resources-design.md`.

### Task AK — Code-only catalogue publication and bounded text translation

**Worker files:** new localization/messages.ts/publication.ts/tests and cli/language.ts/tests. **Leader files:** program.ts registration, actual compatibility/default/custom strict compilation/consumption, docs/source/graph/inventory. English bundled messages, explicit local catalogue overrides/locale policy, strict copied bounded text/replacements. lang:publish exclusive owned code-only English resource, no translation overwrite even force, no new stub/dependency/markup.

- [x] Missing backend/public command tests red before implementation, then strict runtime/catalogue/path/publication refusal coverage and focused types. Leader13focused/67assertions and types171 pass; later exact boundary/snapshot/import-lifetime coverage is not individually red-proven. Independent backend and2actual-test integration reviews found no verified defect.
- [x] Actual separate CLI publication/strict generated compilation and real translate consumer/custom Unicode override; no database and no unsafe-source imports on validation failure. Two entry-point tests observed red before registration, then2pass/15assertions after wiring.
- [x] Independent backend/integration reviews found no verified defect. Final post-source/provenance full752pass/2skip/0fail,17887assertions across82files/types171; graph/whitespace pass. Original180 IDs/titles/states match baseline; one language credit reconciled102implemented/29partial/40pending/9excluded (56.7%all,59.6%applicable),98built-ins; graph59sections/519nodes/594edges. Workers/reviewer finished.

## Wave22 — Explicit code-only vendor publication

**Spec:** `docs/superpowers/specs/2026-11-07-code-only-vendor-publication-design.md`.

### Task AL — Versioned local manifest and consumed resource publication

**Worker files:** new publication/definitions.ts/publish.ts and tests; cli/publication.ts/tests. **Leader files:** program.ts wiring, actual config/language/JSON consumers and strict compile, docs/source/graph/inventory. Explicit selection, version1 bounded immutable local manifest, full selected-source/destination preflight and exclusive private copies. No dependency scanning/downloads/markup/new stub or automatic bootstrap/metadata edits.

- [x] Missing APIs/command red, then complete bounded preflight/exclusive copying. Worker destination-ancestor regression red before pairwise preflight repair, both orders before directories. Later exact shape/path/byte/count/snapshot/lifetime and cleanup coverage added honestly as later coverage. Leader22focused75assertions/types176 pass.
- [x] Actual CLI config:show/locale/JSON consumers strictly compile, selectors/force/conflicts/no-DB/private-source/signal boundaries pass. Independent data-extension finding reproduced red in2actual cases, repaired .d.ts-only exclusion and re-reviewed. Leader8actual46assertions pass; source/targets .d.json/.d.txt accepted and .d.ts refused.
- [x] Independent final re-review found no remaining verified defect. Final post-source/provenance full782pass/2skip/0fail,18434assertions across84files/types176; graph/whitespace and180baseline ID/title/state audit pass. One vendor credit reconciled103implemented/29partial/39pending/9excluded (57.2%all,60.2%applicable),99built-ins; graph60sections/523nodes/599edges. Worker/reviewer finished.

## Wave23 — Model-associated resource-controller consumers

**Spec:** `docs/superpowers/specs/2026-11-07-model-resource-controller-design.md`.

### Task AM — Explicit per-request native ORM resource adapter

**Worker files:** new src/http/model-resource.ts/tests only. Required explicit native model/manager/id parser/create/update validation/serializer callbacks; own fresh fork per request, caller ORM ownership, bounded JSON/no-store CRUD, primary protection/404/cancellation/cleanup. No automatic identity/field inference or global managers.

- [x] Missing API red before implementation; real native SQLite CRUD/validation/isolation/100row/1MiB/id/composite/cleanup/abort and own-data snapshot tests. Later coverage is not independently red-proven. Caller-manager pending state preserved. Leader90combinedfocused582assertions/types178 pass after repairs.
- [x] Independent review reproduced no-store500 and completion-abort races; leader4native regressions red, Router generic500 no-store and caller-side post-await checks repaired. Exact original reviewer microtask repro now500/no-store/no entity data, no remaining verified finding;25backend/router159assertions independently pass. Leader2actual default/custom strict compile/live HTTP/cache consumers28assertions passed. Feature credit still awaits TaskAN full gates.

### Task AN — Consumed model-resource generator and reference example

**Worker files:** scaffolding.ts/generators.ts and tests only. **Leader files:** actual compatibility/default/custom strict compile/live CRUD/cache hydration, docs/source/graph/inventory and shared26-stub expectations. Supported --resource/--model pair uses existing non-executing top-level model preflight; consumed controller-resource.ts.stub has own five methods, computed aliases and explicit model selection. Ordinary controllers preserved.

- [x] Leader2actual and workerfocused unsupported --resource tests red; paired generator, shared model preflight and default/custom controller-resource stub implemented, ordinary handle controllers preserved.26-stub owned/shared expectations updated after expected25vs26 integration failure. No generation DB/model imports/edits.
- [x] Actual nested default/custom generated classes strictly compile, consume real live HTTP SQLite CRUD with explicit validation/serialization and caller-manager pending state, and cached own index/show hydrate without source fallback; no generation database storage. Leader2actual28assertions and3combined resource/event inventory37assertions passed.
- [x] Independent reviews/reproduced repairs and fresh complete gates before single original model-resource-controller example credit. Final post-source/provenance804pass/2 opt-in live-server skips/0fail,18480assertions across85files/types178; graph/whitespace and180baseline ID/title/state audit pass. Inventory104implemented/29partial/38pending/9excluded (57.8%all,60.8%applicable),99built-ins,26stubs; graph61sections/527nodes/603edges. All associated implementation/review workers finished.

## Wave24 — Durable local queue batches

**Spec:** `docs/superpowers/specs/2026-11-07-durable-queue-batches-design.md`. Read-only integration-map worker finished; source/provenance and model-resource checkpoint reconciled before implementation.

### Task AO — Atomic persisted batch lifecycle and queue settlement

**Worker files:** queue/store.ts, opening.ts, dispatch.ts, worker.ts; new batch validation/helper/tests and existing queue tests as needed. Own all queue mutations; leader does not edit these while active. **Interfaces:** exact BatchEntry/BatchDispatch/BatchStatus and enqueue/get/cancel/retry/prune APIs in spec; explicit opt-in version1 upgrade via third QueueStore argument/openLocalQueue options; terminal cancelled settlement. Preserve old jobs schema/envelopes/clock ownership, retain durable member history after ack/delete.

- [x] Worker observed enqueueBatch-not-a-function red before backend changes; atomic mixed dispatch/reopen/status and validation-before-write/open integrated. Later edge coverage was not individually red-first. Leader12CLI/actual170assertions/types181 pass; runtime focused90pass/8550assertions reported, independent backend review active.
- [x] Strict version2/explicit version1 upgrade and integrated receipt/attempt/cancel/retry/prune/clear/history accounting implemented with real two-connection persistence. Additional full ready/delayed/live/failed raw-field preservation and schema/version/internal-object refusal/control tests pass.
- [x] Independent review found SQL LIKE underscore wildcard ownership bypass. Leader9benign queue/cache rejection regressions failed red; minimal literal GLOB prefix repair passed and was independently re-reviewed with no remaining confirmed issue. Later8transaction/clock/reopen tests47assertions are coverage, not independently red-first. Leader120queue/cache/CLI8708assertions +8actual118assertions/types183 pass; worker/reviewers finished. Full feature credit still awaits TaskAP fresh complete/source gates.

### Task AP — Actual batch operations and CLI consumption

**Leader files:** cli/queue-batches.ts/tests, program.ts, compatibility.test.ts; docs/source/graph/inventory. Consumes TaskAO exact API contract. No disconnected table generator, fake callbacks or no-op commands.

- [x] Actual queue:upgrade entrypoint failed unknown-command red before registration. Metadata/cancel/retry/prune/force-upgrade CLI integrated;4unit preflight/abort/foreign-state/confidentiality/lifecycle tests pass. CLI reviewer found no verified scoped defect.
- [x] Leader8actual processes consume mixed generated default-filled/custom module jobs and built-in/custom commands, persisted failure/retry, live success/failure cancellation, worker SIGTERM refund, version1 explicit upgrade/raw-record preservation and strict-cutoff prune/detachment; combined12CLI/actual170assertions pass, types181. No application DB side effects; no batch-table adapter credit.
- [x] Independent backend/integration review and repairs complete. Final post-source849pass/2opt-in live-server skips/0fail,18483assertions across89files/types183; graph/whitespace and original180ID/title/state audit pass.106implemented/29partial/36pending/9excluded (58.9%all,62.0%of171applicable),104built-ins/26stubs; graph62sections/532nodes/608edges. Only retry-batch/prune-batches credited; ORM batch-table generator remains pending. All wave24 workers/reviewers finished.

## Wave25 — Explicit native model pruning

**Spec:** `docs/superpowers/specs/2026-11-07-native-model-pruning-design.md`. Original pending reference is item:2c9da268301e36c3; the read-only preparation worker finished. No existing application data is an execution target.

### Task AQ — Branded pruning rules and bounded native SQL consumer

**Worker files:** new database/pruning-definitions.ts/tests and database/pruning.ts/tests ONLY. **Interfaces:** definePrunable<T>({name,model,where(signal)}), definePruning([...]), loadPruning(root,signal), pruneModels(nativeSqlManager,definitions,options) returning metadata-only counts, as specified. SQL native manager/query builder are reexported by already installed @mikro-orm/sqlite; no dependencies/install. Callback/model snapshots, bounded manifest, full predictable rule/metadata preflight, force/preview, raw unique primary selection/native filters, finite chunks with predicate recheck, transaction/cancellation/ownership and partial-commit semantics.

- [x] Implement typed branded source contracts and real native consumer; no generated class/no-op substitute. Original entrypoint missing-command red was observed; stopped worker's original backend API red is not independently recovered. Native BigIntType refusal and high-key precision regressions were reproduced red before repairs.
- [x] Real disposable SQLite preview/eligibility/filter/mapped-primary/chunk/cap/selection/ownership/failure/cancellation tests plus source/bounds/snapshot/refusal/lifetime checks; focused tests/types and independent review/repairs. Core11tests35assertions, leader8later-contract-tests50assertions. Independent high-bigint precision finding repaired via exact SQLite text projection, neighboring-key preservation and accepted re-review; safe-number guard retained. Broader external-driver evidence remains unverified.

### Task AR — Guarded actual model:prune command consumption

**Leader files:** new cli/model-prune.ts/tests, program.ts, actual compatibility tests; docs/source/graph/inventory. Inject ONE resolved existing database target with existing SQLite regular-file preflight, withDatabase owned cleanup and force-before-source/DB action. No implicit installation/reset/migration or expanded live-server verification.

- [x] Actual missing model:prune entrypoint red, then validated --model/--pretend/--chunk/--limit and nonpreview global-force registration, signal and sanitized diagnostics. Default/named actual process consumers pass38assertions; six focused refusal tests pass25assertions. Further review and full gates remain below.
- [x] Actual disposable existing SQLite consumers preview/force/filter/chunk/cap/named-target/failure/reopen persistence; CLI lifecycle tests cover cleanup/completion-abort output and target refusals leave default/missing DB absent. Independent CLI review found no concrete issue. Native ownership/cancellation/cascade/hook contracts are covered separately; no actual external-driver evidence. Initial full diagnostic865pass/2skip/2fail exposed bigint core regression and host-NO_COLOR-sensitive pre-existing test; backend repaired and color test explicitly injects env:{} while retaining NO_COLOR production semantics. Fresh repaired full gates remain below.
- [x] Fresh full suite/types/graph/whitespace/historical180 provenance before single original model-prune credit: final879pass/2opt-in live-server skips/0fail,19109assertions across93files/types190;105built-ins/26stubs. Inventory107implemented/29partial/35pending/9excluded,62.6%applicable. Broader D1/server evidence/full100%scope remain unfinished.

## Wave26 — Explicit local development processes

**Spec:** `docs/superpowers/specs/2026-11-07-development-processes-design.md`. Original dev:list item:8b6457bf63c1137d remains pending until real consumed process registry/runtime and full gates. Separate history-uninstall backend delegation was initially permission-denied; user subsequently approved only mikro_orm_migrations deletion in NEW disposable test databases. The one approved retry is tracked in Wave27; no existing application table deletion is authorized.

### Task AS — Explicit process registry and owned foreground lifecycle

**Worker files:** new src/development/processes.ts/tests only. Non-destructive trusted source registry, validated copied/frozen argv, real rooted Bun commands without shell/executable override, concurrent owned lifecycle, stream/error/cancellation/exit cleanup and bounded drain/escalation. No services/install/DB changes.

- [x] API missing-module red, bounded definitions/source and real fixture command consumer; focused tests/types. Worker14tests40assertions including later inherited-pipe/spawnfailure/snapshot/source coverage.
- [x] Independent scoped review found no verified issue. Real fixture tests cover owned-child reaping; no descendant/process-group supervision claim. Worker/reviewer complete.

### Task AT — Consumed dev:list and development CLI

**Leader files:** cli/development.ts/tests, program.ts, actual compatibility consumers, docs/source/graph/inventory.

- [x] Actual unknown dev:list red observed before registration; CLI registered with preabort/nested guards and generic errors. Backend integration still pending.
- [x] Actual listing does not execute configured commands; dev consumes same registry, preserves exact status0/7, actualSIGINT/SIGTERM sibling/cleanup behavior:5actualtests22assertions pass. CLI guards5tests15assertions pass. Disposable fixture side effects only; stdout/stderr streamed with no app DB state.
- [x] Independent review/final full923pass/2opt-in live-server skips/0fail,19214assertions across98files/types198; graph/whitespace/historical180 audit passed. Original dev:list credited; broader dev remains partial, no Vite/framework/service-manager parity. History test authorization recorded separately.

## Wave27 — Verified SQLite migration-history uninstall

**Spec:** `docs/superpowers/specs/2026-11-07-migration-history-uninstall-design.md`. Initial backend delegation denied; precise user approval then supplied through AskUserQuestion for implementing force-guarded deletion of mikro_orm_migrations in NEW disposable test databases ONLY, never existing application databases. One approved retry launched; no permission bypass. Original item:f4915c707e8c7d11 remains pending until gates.

### Task AU — Conservative native tracking ownership and removal

**Worker files:** database/history-uninstall.ts/tests only. SQLite-only explicit support, force/preview/signal guards, configured table collision/schema/dependency/lock validation, no initialization, owned transaction/fork, no CASCADE or application-data operations.

- [x] Backend API missing-module red then verified native new temporary fixture consumption/refusal/preservation tests/types. Core9tests21assertions; leader4contracts include Map collision red/green, abort-after-drop rollback, unsupported platform without connect and qualified active-lock no-drop querytrace red/green.
- [x] Independent review/re-review accepted native metadata Map.values collision repair and explicit main-schema lock lookup. Reviewer's end-to-end shadowing deletion probe was denied and was NOT rerun by leader/another worker; non-deleting structural regression instead verifies qualified lock read and no DROP while active. No remaining verified scoped finding; all workers/reviewer complete.

### Task AV — Force-guarded tracking-uninstall CLI

**Leader files:** migrations.ts/program.ts, actual CLI tests, docs/source/graph/inventory.

- [x] Actual default/named entrypoint tests observed unknown migrate:uninstall red before registration. Command now registered with force-before-target, one existing SQLite target preflight, propagated signal, generic errors and output after owned cleanup; backend integration pending.
- [x] Approved actual new disposable SQLite migrate/seed/preview/refusal/removal/reopen/reinstall consumers preserve app rows/unmapped objects/locks/source/snapshot bytes and default/missing targets:2default/namedtests38assertions pass. CLI5guard tests19assertions; types198 pass. Temporary before:unknown strict test typing repaired; no existing app DB changes.
- [x] Final full923pass/2opt-in live-server skips/0fail,19214assertions across98files/types198; graph/whitespace/historical180 audit pass and no regenerated project snapshot. One original uninstall reference credited. Inventory109implemented/29partial/33pending/9excluded,63.7%applicable;108built-ins/26stubs. No existing application DB changes or server destructive-support claim.

## Wave28 — Real console testing harness

**Spec:** `docs/superpowers/specs/2026-11-07-console-testing-harness-design.md`. Original partial item:ed1be0bbfb566674, no credit until consumed native API/review/gates. No external service or app DB operations.

### Task AW — Bounded real-runner and native-prompt harness

**Worker files:** console/testing.ts/tests only. Real rooted runCli with private native createPrompts TTY test streams, snapshotted prompt script, late mismatch/overflow failure after ownership cleanup, bounded injected I/O and frozen result/chain assertions, no process-global patches.

- [x] Missing API red then real runner/private native prompt/capture API;13combined core/generated-consumer tests35assertions/types202 pass. Later explicit cancellation/snapshot/assertion/scoped-before-provider cleanup coverage is not all red-first.
- [x] Independent review reproduced a caught unexpected concurrent prompt returning success. Leader exact consumer red then active guard records mismatch before rejection; final mismatch waits command settlement/cleanup. Narrow re-review accepted repair; worker/reviewer complete.

### Task AX — Generated-command/test harness consumers and reconciliation

**Leader files:** cli/console-testing.test.ts, docs/source/graph/inventory.

- [x] Observed generated-command consumer missing-module red before implementation. Three initial consuming tests written for real generated command/native test and auto/explicit native prompts; subsequently integrated and passing below.
- [x] Real generated make:command output and make:test --unit/native Bun execution consumed through testCommand; auto-argument retry/error/status and all6native prompt methods, no secret echo/no app DB state. Public consumers also cover input/env/argv snapshot, async-search cancellation, immutable assertions and scope/provider cleanup. Independent narrow repair accepted.
- [x] Final post-provenance full suite944pass/2opt-in live-server skips/0fail,19350assertions across101files/types202; graph freshness/whitespace and historical180 IDs/titles/checkbox states pass. Original partial console-testing reference upgraded with bounded real consumers/review; no process-global output capture or automatic DB provisioning claim.

## Wave29 — Explicit consumed configuration publication

**Spec:** `docs/superpowers/specs/2026-11-07-configuration-publication-design.md`. Original partial item:652400405ed48a95, no credit until actual package/tag/all config consumers/review/gates. Reuse existing native publication writer; no unrelated language/data copy or implicit cache refresh.

### Task AY — Config-only native selection and CLI integration

**Worker files:** publication/publish.ts/tests and cli/operations.ts/tests only. Shared static configuration destination scope, package/tag/all validation/preflight/exclusive writer, legacy built-in app publication preserved, force never overwrite, cooperative signal. No source import by copying.

- [x] Focused missing API/CLI selection red then shared config-only package/tag/all/no-match/refusal/preservation writer and signal-aware CLI;34publication/CLI tests and types202 pass.
- [x] Independent bounded selection/filter/writer/cancellation review found no verified issue; worker/reviewer complete.

### Task AZ — Actual configuration consumers and reconciliation

**Leader files:** program signal wiring, compatibility tests/docs/source/graph/inventory.

- [x] Observed actual config:publish --package unknown-option red before registration. Program signal wired; actual package/tag source-import/Unicode/config consumer plus allselection/cacheprecedence tests written, subsequently integrated and passing below.
- [x] Actual package/tag and all publication/config:show Unicode/no-earlyimport/no-overwrite/legacy/cacheprecedence/noDB consumers:2tests22assertions pass. Independent review no verified issue.
- [x] Final post-provenance full suite944pass/2opt-in live-server skips/0fail,19350assertions across101files/types202; graph freshness/whitespace and historical180 provenance pass. Original partial config:publish reference upgraded after actual consumers/review; no language/data copy or implicit cache invalidation.

## Wave30 — Paired native model/factory/seeder generation

**Spec:** `docs/superpowers/specs/2026-11-07-paired-model-generation-design.md`. Original partial item:46dcd17ede260cf0; no credit until reviewed native consumers and full/source/provenance gates. Continue without unavailable external fixtures.

### Task BA — Shared complete code-output planning and real CLI consumption

- [x] Observed real builder/entrypoint unknown `--factory`/`-fs` red before implementation. Initial harness also parsed stub:publish plain output as JSON; fixed that test adapter and used actual v7 schema.create API, not production changes for test mistakes.
- [x] Add `-f, --factory`, renderModel/renderSeeder extraction preserving standalone generator APIs, and generateModelScaffolds complete selected code-output preflight. Shared exclusive writer rejects conflicts/unsafe ancestors and consumes existing custom factory stub without importing a model. Native migration baseline/production guards remain; later I/O/migration failure is nontransactional.
- [x] Focused8new tests and existing generator/program consumers:74pass/0fail/413assertions; types203. Real native Factory persists a new model; real entrypoint `-mfs` generates then applies the model migration and runs the explicit seeder in a disposable root. Selected model/seeder/factory collisions, invalid names, malformed stubs and linked parents/dangling targets preserve other selected outputs. Refusal tests initially passed on unknown options and are later coverage, not falsely claimed individual red-first proofs.
- [x] Independent bounded increment review complete/integrated. Reviewer reproduced overlong selected factory filename leaving a valid model and newly rejecting existing Promise/Error model names. Three leader regression cases observed red; now every selected component is bounded255bytes before publication and paired generation preserves the original model-name validation rather than generic reserved names. Focused77pass/0fail/425assertions/types203 before later exact255byte accepted/next-byte refused factory/seeder boundary tests. Reviewer finished; repairs verified by exact TDD cases, no repeat review dispatched. Repaired full regression and final provenance gates subsequently passed below; source/inventory changes were kept outside graph-sensitive execution.
- [x] Repaired pre-ledger957pass/2skip/0fail,19217assertions; final post-source/provenance957pass/2opt-in live-server skips/0fail,19473assertions across102files/types203. Graph freshness/whitespace and original180 ID/title/checkbox audit pass; no unexpected project migration snapshot. Graph68sections/556nodes/633edges;108built-ins/26stubs. Original paired model/migration/factory/seeder example credited:112implemented/26partial/33pending/9excluded (62.2%all,65.5%of171applicable). Broader related-output record stays partial and its factual reason is refreshed; no controller/whole-operation transaction/live-server claim. TaskBA and reviewer complete.

## Wave31 — Offline code-first application installer and native setup

**Spec:** `docs/superpowers/specs/2026-11-07-offline-project-installer-design.md`. Original pending references item:2d778bcb7b7ea836 and item:6b96be38c5be38bb. No installer credit before review, native consuming tests and full/source/provenance gates.

### Task BB — Explicit shipped template and exclusive project creation

- [x] Actual missing new-command red observed before backend/CLI registration. Pure template/allowlist file was written before that public consumer red; do not claim every template line was individually TDD-proven. New project API snapshots validated options, safely reads explicit bounded descriptor-checked library sources (not caller state), claims a NEW destination and exclusively creates checked code-only files. Existing/unsafe targets refuse even with force; no subprocess/import/download/migrate/seed during generation.
- [x] Register new with explicit parent/driver/without-http/interactive choices; native prompts offer implemented database paths, Bun tests and health route only. Dependencies declared but never installed; server choices do not provision services or generate credentials.
- [x] Initial7tests64assertions/types207 pass: generated real entrypoint list/routes/cache, actual owned HTTP health, explicit SQLite migrate/seed, generated native Bun test and strict generated-project typecheck, driver choices, native prompt harness, existing target/state preservation and preabort. Corrected test assumptions about route:list JSON shape and invalid empty BUNDLE_CONNECTIONS; no production changes for those fixture errors.
- [x] Expanded immutable snapshot/closed-record/source missing/link/cancellation checks. Leader generated native-test percent-encoded parent path and mismatched ORM dependency bugs reproduced red then fileURLToPath/alignment repairs.17installer tests105assertions/types208 passed before review repair.
- [x] Independent review complete/integrated: actual runner imported unrelated provider/command modules before new. Four leader actual-runner/entrypoint/bootstrap-cache regressions observed red. Outer new is now classified from snapshotted argv, routed through built-ins and skips application provider/package/command bootstrap; ordinary command startup stays unchanged, including new as a global-option value or list namespace.61focused installer/runner/provider tests254assertions/types208 pass. Reviewer finished; exact repair tests plus whole-suite gates replace repeat review.
- [x] Repaired pre-ledger982pass/2skip/0fail,19482assertions; final post-source/provenance982pass/2opt-in live-server skips/0fail,19756assertions across104files/types208. Graph freshness/whitespace/original180 IDs/titles/unchecked states pass; no unexpected project migration snapshot.109built-ins/26stubs; graph69sections/560nodes/637edges. Only original application-creation/native-interactive-setup references credited:114implemented/26partial/31pending/9excluded (63.3%all,66.7%of171applicable). TaskBB and reviewer complete; source/dependency install/server/auth/transaction limits remain explicit.

## Wave32 — Trusted native JavaScript tinker (in progress)

**Spec:** `docs/superpowers/specs/2026-11-07-native-tinker-design.md`. Original pending reference item:7e267621a023cdfc. No implementation credit before consuming tests, review and full/provenance gates.

### Task BC — Native evaluator integration and owned lifecycle

- [x] Initial backend worker stopped explicitly incomplete. Leader reproduced actual SQLite CLI exit1 before repair; multi-line native readline input raced across top-level awaits. Native error hook probe established Bun requires print/ignore/unhandled and terminal errors bypass eval callbacks. Replaced lastError guessing with async-context-bound native error settlement; execute evaluates one entire program, interactive bridge serializes cells while preserving recoverable multiline state.
- [x] Focused22pass/0fail/79assertions; strict types212 pass before final added regressions/review. Actual disposable SQLite, provider/scope cleanup, rooted import/require, PTY exit/Ctrl+C/SIGINT/SIGTERM and copied entrypoint pass. Added async terminal error/incomplete execute, pasted await/multiline/error continuation, caught opener rejection, delayed output drain and preabort/input reuse coverage. Input reuse initially timed out red; explicitly resume claimed source and restore prior flow on release. Late coverage is not falsely presented as individually red-first.
- [x] Independent review completed: idle caller output destruction left session/input/owned ORM held indefinitely. Leader exact idle-after-second-prompt regression observed hung RED; output-close listener now closes session, destroys owned forwarding sink and awaits owned evaluation/database cleanup.23focused tests85assertions/types212 pass. Reviewer finished, no pending review result. Initial pre-review full1004pass/2skip/0fail,19603assertions across106files/types212; repaired full and final source/provenance/inventory gates remain pending.
- [x] Repaired pre-ledger full1005pass/2skip/0fail,19659assertions. Final post-source/provenance full1005pass/2opt-in live-server skips/0fail,19597assertions across106files/types212; graph freshness/whitespace/historical180 ID/title/checkbox audit and migration-source hygiene pass.110measured built-ins/26stubs; graph70sections/564nodes/641edges. Only original tinker reference credited:115implemented/26partial/30pending/9excluded (63.9%all,67.3%of171applicable). TaskBC/reviewer/tests complete; no active worker/background gate remains. Native JavaScript equivalent only; full TaskD/100%goal remains unfinished.

Ruling: execute is one JavaScript program with one final expression result, not separate auto-printed readline cells — eliminates await races and preserves normal JavaScript ASI semantics — callers wanting several values must return an array or explicitly print them; previous service fixture was corrected accordingly rather than silently parsing a different language.

## Wave33 — Native HTTP feature tests (in progress)

**Spec:** `docs/superpowers/specs/2026-11-07-http-feature-tests-design.md`. Original partial item:6cdce95cb325b5c1. No feature-test reference credit before review and final consuming/full/provenance gates.

### Task BD — Consumed real-worker HTTP test harness and generator

- [x] Missing withHttpApplication module RED observed after final Wave32 gates. Four native live-worker contract tests written first.
- [x] Actual unknown --http option RED before registration. Real-worker withHttpApplication, strict local request targets/manual redirects, owned cancellation/shutdown and retained-client closure added. Explicit make:test --http consumes a new custom http-test.ts.stub with computed nested imports/root URL; existing generic/unit generation unchanged. Installer allowlist includes runtime. Actual generated native Bun tests pass in space/Unicode root; live cache/maintenance and pending-request abort consumed. Selected path dollar replacement corrupted source RED before functional replaceAll repair. Updated two expected published-stub counts26→27; production was correct there, not a behavior regression.
- [x] Focused79pass/0fail/411assertions across4files/types215; includes generated installer consumers. Later refusal/cache/maintenance/abort cases are coverage, not all individually red-first.
- [x] Independent review complete: cancellation during awaited worker shutdown could return success, and object-spread lost inherited/non-enumerable native RequestInit fields. Both leader regressions observed RED; now cancellation observation remains through awaited cleanup/check and native Request construction preserves dictionary semantics before manual-redirect/signal override.85focused tests441assertions across5files/types215 pass, including actual copied CLI entrypoint and generated native Bun test. Entrypoint fixture initially omitted required package.json; fixed test fixture, not production. Initial full1013pass/2skip/4fail included both new RED review regressions plus two stale26stub assertions; all four now repaired. Reviewer finished, no repeat review needed.
- [x] Repaired pre-ledger full1018pass/2opt-in live-server skips/0fail,19724assertions across108files/types215; whitespace and migration-source hygiene pass. Source/inventory regeneration preserves all180original IDs/titles/checkbox states; only original feature-test generation reference upgraded provisionally pending final gates:116implemented/25partial/30pending/9excluded (64.4%all,67.8%of171applicable). Graph71sections/568nodes/645edges;110built-ins/27stubs.
- [x] Final post-source/provenance full1018pass/2opt-in live-server skips/0fail,19532assertions across108files/types215; graph freshness/whitespace/historical180 audit and migration-source hygiene pass.110built-ins/27stubs; graph71sections/568nodes/645edges. Inventory116implemented/25partial/30pending/9excluded (64.4%all,67.8%of171applicable). TaskBD/reviewer/background tests complete. Only bounded native HTTP feature-test reference upgraded; full TaskD remains unfinished.

## Wave34 — Explicit native SQLite test database isolation

**Spec:** `docs/superpowers/specs/2026-11-07-isolated-sqlite-test-databases-design.md`. The original parallel-test references remain partial; their Laravel/PHP completion checkboxes are unchanged.

### Task BE — Native per-process setup and owned fixture isolation

- [x] Private marker-only Bun1.4.4 probe with --parallel=2/--parallel-delay=0/explicit --preload passed2tests/2assertions. Each actual native worker ran preload in its own PID; no invented worker-ID env or parent setup assumed. Repro source/markers preserved at /tmp/bundle-native-test-probe.IC1kdBzY (no DB/secrets).
- [x] Native cancellation precondition probe completed: two private waiting workers were verified as children of the owned Bun parent with Linux process-start identities; SIGTERM returned143 and both worker /proc identities were absent after parent exit. Probe fallback could kill only previously verified matching worker identities, but no leftover worker was observed. No database provisioned; marker-only source/repro preserved in the same private directory.
- [x] COMPLETE: API/CLI/worker implementation and explicit `--parallel --isolated-databases` mode are integrated. Real disposable-root tests cover distinct worker PIDs/databases, migration-source and configured-DB preservation, setup failure, cancellation, unknown state, and preservation while a detached descendant remains active. Cleanup signals only a still-verified owned process group; uncertain/live worker or descendant state preserves the private run. `snapshot:false` retains original migration modules and relative imports while source-byte regressions protect migration files. Independent safety-review findings were repaired. Final gates: full suite 1036 pass / 2 skipped / 0 failures, 19952 assertions across 112 files; typecheck clean across 223 files; graph freshness and `git diff --check` pass. The two original parallel-test references remain partial and their Laravel/PHP checkboxes are unchanged; this bounded Linux/SQLite implementation does not establish server-database, external-service, sandbox, or broad Laravel worker-lifecycle parity.

Ruling: initialize NEW per-worker SQLite databases with native migration snapshots disabled before ORM construction, retaining original migration modules — relocating arbitrary migration sources breaks their relative imports; native Migrator.storeCurrentSchema/up guards snapshot writes when snapshot:false — framework-owned setup must prove source bytes unchanged, while trusted migration code retains its ordinary side effects; if native behavior changes, the source-preservation regression must fail. The queued spec's private-copy mechanism is superseded by this source-read-only contract, not a silent relaxation to writable application snapshots.

## Wave35 — Generated full-MVC Vite/React frontend (in progress)

- [x] User direction applies to newly generated Bundle apps; retain Bun/MikroORM/native HTTP backend and add Vite + React TSX/Fast Refresh, configured shadcn/ui primitives, `/api` proxying, integrated `dev`/`dev:web` scripts, and production `dist/` serving. User explicitly authorized npm packages in the Bundle repo and disposable generated fixtures. Do not imply that the project installer installs dependencies automatically.
- [x] Generated templates, dependency declarations, native `ui:dev`/`ui:build` commands, development process group and production static `dist/` serving are present. The static helper uses opened directory/file descriptors, rejects symlink path components, and passes both deterministic path-replacement and actual HTTP GET/HEAD tests on Linux. It intentionally fails closed on non-Linux pending a portable descriptor-safe path.
- [x] Independent review Important findings reproduced and repaired: HMR readiness test no longer waits for open stderr before requests; test-run child uses its own POSIX process group and quiesces descendants before fixture deletion; static response reads from the checked open descriptor; `--without-http` omits an API child and explains the absent backend. Regression-first descendant and no-HTTP tests pass. The review's SPA fallback minor is fixed: native Router responses distinguish unmatched paths from handler-generated 404s, preserving the latter while serving SPA assets for the former; unclassified custom-router 404s retain legacy status-based fallback. Actual worker tests cover native GET/HEAD, cached route hydration and custom-router fallbacks.
- [x] Generated Vite integration passes runtime tests: offline dependency installation, generated-app typecheck, `ui:dev` readiness, transformed React Refresh module, HMR websocket connection/update after editing `App.tsx`, `ui:build`, and GET/HEAD production serving of built assets through the generated app's actual `serve` command. The combined `dev` group also starts API+Vite together, proxies `/api/health` to the generated controller, and stops both listeners on SIGTERM. The prior stream-reader race and stderr wait are fixed; readiness requires Vite's actual listening socket and derives its fallback URL from the bound address. Non-Linux production static serving remains unavailable.
- [x] Final validation after the expanded integration and route-fallback tests: full suite 1036 pass / 2 skipped / 0 failures, 19744 assertions across 112 files; typecheck clean across 223 files; graph freshness and whitespace checks pass. These frontend results do not add Artisan checklist credit or imply 100% compatibility.

## Wave37 — Native SQLite database shell

### Task BG — Existing-file SQLite client launch and evidence reconciliation

- [x] Implement `bundle db` as an explicit SQLite-only native-client launcher: existing regular single-link file, fixed argv with `mode=rw`/`nofollow=1`, credential-minimal child environment, preserved exit status, bounded cancellation, and terminal Ctrl+C ownership. PostgreSQL/MariaDB clients and package installation remain unsupported; actual `sqlite3` interaction was unavailable, so fake-client behavior does not establish native-client compatibility.
- [x] Add real CLI process coverage for argv/environment, absent file/client, unsupported server driver, post-resolution file replacement, SIGTERM, and terminal-style Ctrl+C. Generated application templates include the launcher module.
- [x] Regenerate graph and refresh all 180 compatibility source/category locations plus source fingerprint; fix duplicate category IDs by matching the corpus test’s first-source occurrence. Compatibility item `item:a68cd46199ec706a` remains partial. Current inventory: 116 implemented, 27 partial, 28 pending, 9 excluded; 114 registered commands.
- [x] Verification: targeted shell tests 8 pass; generated-project tests 10 pass; compatibility provenance tests 2 pass; strict typecheck 226 files; full suite 1053 pass / 3 skipped / 0 failures, 19918 assertions across 113 files; graph check and whitespace check pass. The first full-suite provenance run exposed a category-location refresh defect (1052 pass / 3 skipped / 1 fail); corrected and rerun green. No real SQLite client or server database was used.

## Wave38 — Bounded native channel registry listing

### Task BH — Consumed `channel:list` metadata registry

- [x] Add a strict copied/frozen root `channels.ts` registry with bounded unique channel names and whole-segment parameters, native text/JSON `channel:list`, generated-project source/docs allowlisting, an actual CLI subprocess consumer and documentation. No channel authorization, authenticated identity, transport/client or `make:channel` credit is implied.
- [x] RED evidence: missing registry module, generated template source omission, unsafe accessor-array acceptance and reviewed absent-root masking each failed their focused tests before their respective repairs. The CLI uses the real local runner and proves it does not open the ORM database.
- [x] Independent review verified two issues: a nonexistent project root had been mistaken for an absent channels.ts (fixed by canonicalizing the root before the optional-file check), and a loaded root registry remains in Bun's normal ESM cache if source changes within the same process. The latter is documented and ruled acceptable for this bounded CLI listing because ordinary CLI invocations run in fresh processes; source hot reload/transitive dependency invalidation are not claimed.
- [x] Regenerate graph and reconcile all 180 source/category locations and source fingerprint. Original checklist remains unchanged. `item:7b83ab52c716ff6f` is implemented for bounded name listing; `make:channel`/broadcast installers and auth/transport remain unfinished. Inventory:117 implemented/27 partial/27 pending/9 excluded (65.0% of all and 68.4% of 171 applicable);115 registered built-ins.
- [x] Final gates: full suite 1058 pass / 3 skipped / 0 failures, 20184 assertions across 114 files; strict typecheck 229 files; graph freshness, compatibility evidence/source-hash audit and whitespace checks pass. No service or database was provisioned.

## Wave39 — Cache entry and lock table migration schema (partial)

### Task BI — Generate and consume cache schema migration

- [x] Implement `make:cache-table` with SQLite/PostgreSQL/MariaDB SQL for entry and lock tables, composite namespace/key primary keys, expiry indexes, selected migration target, and ORM connection disabled while generating. SQLite application verifies tables, columns and duplicate-key rejection; generated projects include the renderer.
- [x] Keep compatibility item `item:8eed2b736d492f6c` partial: no database-backed cache runtime consumes these tables, and PostgreSQL/MariaDB have renderer-only tests. The existing `LocalCache` remains on its dedicated `.bundle-cache/cache.sqlite` runtime.
- [x] Regression test first reproduced the data-loss SQL and duplicate-primary-key rollback in a disposable SQLite fixture; after the fix, focused cache migration/apply/model-diff/rollback/fresh-refusal check: 1 pass / 0 fail / 16 assertions. Generated-project test: 10 pass / 0 fail / 51 assertions; cache renderer plus compatibility provenance: 6 pass / 0 fail / 2959 assertions. Full suite: 1063 pass / 3 opt-in live-database skips / 0 failures, 20197 assertions across 115 files. Graph freshness, strict `tsc --noEmit`, and whitespace checks pass. The full-suite output includes `error: unknown option '--resource'` while the runner still reports 0 failures.
- [x] Independent review reproduced an important data-loss defect: a later model-diff migration dropped both unmapped cache tables, while its SQLite rollback tried to recreate columns as multiple primary keys. The regression was observed red before `schemaGenerator.skipTables` excluded the two explicit cache table names; the real model migration now applies and rolls back while preserving cached data. `migrate:fresh` still refuses these unmapped tables before deletion. Inventory at Wave39: 117 implemented / 28 partial / 26 pending / 9 excluded; 116 registered built-ins. The 100% compatibility goal remains unfinished.

## Wave40 — Session table schema generation (partial)

### Task BJ — Generate a safe SQLite-consumed session schema migration

- [x] Add a dialect renderer and `make:session-table` for a `sessions` table with id, optional user id, IP address, user agent, payload, activity timestamp and lookup indexes. Generation uses the selected target without connecting; generated projects include the renderer; production-force guard is exercised.
- [x] Keep `item:b79681846a2a68c0` partial: this is schema only, not a session store, cookie lifecycle, expiry policy, authentication or authorization runtime. SQLite has a real migration/apply consumer; PostgreSQL/MariaDB have renderer-only tests.
- [x] Test-first evidence: missing renderer import and unknown command failed before implementation; generated-template allowlist omission failed before updating the allowlist; disabling the session-table `skipTables` entry reproduced follow-up migration table drops before restoring the exclusion. Focused command/template/renderer checks pass, including persisted-row preservation across a model migration and rollback; final complete-suite gates will be recorded below.
- [ ] Final full-suite, typecheck, graph/provenance and whitespace verification pending. Current planned inventory: 117 implemented / 29 partial / 25 pending / 9 excluded; 117 registered built-ins. The 100% compatibility goal remains unfinished.

## Execution rulings

- Ruling: treat outer new as an independent installer dispatch before application registries, using snapshotted argv with known root-option value handling — meets no-application-import creation while retaining ordinary command bootstrap — new intentionally ignores unrelated unsafe app caches/registries, not other app commands; trusted Bun startup/preloads and explicit embedding callbacks remain outside the installer guarantee.
- Ruling: paired model generation retains the original model validator rather than generic scaffold reserved types, and bounds every selected filename to255bytes before checking whether parents exist — preserves existing Promise/Error model creation while preventing predictable suffix-length partial publication — this is a bounded Linux filename contract, not cross-platform filesystem equivalence.
- Ruling: retain the existing dirty `version/A000` worktree and this durable plan as the continuity ledger rather than relocate or commit the uncommitted implementation — preserves pre-existing user work and the explicit no-commit instruction — review must include untracked files, not only committed diffs.
- Ruling: stop live fixture provisioning after the safer fixed-name/no-deletion script was denied on credential persistence despite recorded approval; do not repeat the same exposure via another tool or worker — respect the active permission boundary — PostgreSQL/MariaDB live verification and Redis-dependent work remain unverified until the restriction is resolved.
- Ruling: allow an already-imported `channels.ts` module to retain Bun's normal ESM cache for repeated in-process loads and require a new CLI process to observe edits — standard fresh CLI invocation sees current registry and avoids nonstandard/incomplete transitive invalidation; embedded callers trade immediate same-process source reload, which is documented — stale metadata may persist until process restart if an embedder edits source in-place.

## Remaining local work

- [x] Selected paired model/factory/seeder slice (original item:46dcd17ede260cf0) integrated/reviewed/repaired/verified/reconciled as Wave30 TaskBA. Read-only mapping worker and reviewer complete; no active delegated workers or background tests remain. External fixtures remain blocked; broader TaskD backlog remains pending, not complete.
- [x] Actual CLI compatibility recheck134pass/0fail/1034assertions (71.23s). Focused console/config check25pass/0fail/82assertions; types202, graph freshness, whitespace and historical180 count audit pass.

## Execution state

Historical Wave27 checkpoint (superseded by Wave29 below): Waves2–27 integrated/reviewed/repaired/reconciled. Post-provenance checkpoint923pass/2opt-in live-server skips/0fail,19214assertions across98files/types198; graph freshness/whitespace and all180 historical IDs/titles/unchecked states pass. Inventory109implemented/29partial/33pending/9excluded (60.6%all,63.7%of171applicable);108measured built-ins/26stubs; graph65sections/544nodes/621edges. TasksZ–AV and all associated implementation/review workers complete. Model-resource no-store/completion-abort, vendor ancestor/extension, queue/cache literal-prefix and pruning high-bigint findings reproduced red, repaired and independently accepted; later coverage remains distinguished from red-first proof. Original backend missing-API red was not recovered from stopped worker; actual pruning missing-command and bigint red/green were observed. Batch ORM table adapter/callbacks/system-service and mixed-version guarantees remain unfinished. TaskD/full100%goal remains genuinely unfinished: auth/session, installers, remaining scheduler/timezone, broadcast/ORM/service adapters, database helpers and authorized expanded live-server evidence. No perpetual execution promise or external-service equivalence is implied. Wave26/27 final gates and only dev:list/SQLite-uninstall reference credits are complete. User consent limits mikro_orm_migrations deletion tests to NEW disposable fixtures, never existing app DBs/tables. First combined full922pass/2skip/1fail exposed an in-memory test's project migration-path snapshot contamination; preserved the newly generated snapshot at /tmp/bundle-unintended-snapshot-JJsCr1yY/snapshot.json, isolated migration roots and added source-byte guard. Repaired and final whole suites pass, no unexpected project snapshot regeneration. Review metadata Map and main-lock qualification fixes were independently accepted; denied shadow/drop probe was not rerun. Waves28/29 and TasksAW–AZ are now integrated/reviewed/repaired/reconciled; all associated workers/reviewer finished. Latest final post-provenance checkpoint944pass/2opt-in live-server skips/0fail,19350assertions across101files/types202; graph freshness/whitespace and original180 IDs/titles/checkbox states pass. Inventory111implemented/27partial/33pending/9excluded (61.7%all,64.9%of171applicable);108built-ins/26stubs; graph67sections/552nodes/629edges. Only the original partial console-testing and config:publish references were upgraded, after generated-command/Bun-test/native-prompt and actual config/cache consumers; concurrent-prompt mismatch finding reproduced red, repaired and independently accepted. Full100%goal remains unfinished. User separately approved NEW disposable PostgreSQL17/MariaDB11.4/Redis7.4 Docker fixtures, the official MariaDB image download, fixture-only resets and exact-owned cleanup, and generated test-only credentials in private0600 state/Docker/test environments without credential output. Provisioning script writes were denied before execution (credential consent first, then unverifiable runtime-name cleanup scope). Read-only Docker inspection confirmed all three fixed candidate names absent; a safer fixed-name/no-deletion provisioning script was also denied on private credential persistence despite recorded approval. No script execution, image download or container creation has occurred. Live-service provisioning remains blocked; do not retry through another tool/agent or weaken authentication. No existing app databases/containers or host packages are authorized.

Latest fully reconciled checkpoint: Wave30/TaskBA complete;957pass/2opt-in live-server skips/0fail,19473assertions across102files/types203; graph freshness/whitespace/historical180 audit pass, graph68sections/556nodes/633edges. Inventory112implemented/26partial/33pending/9excluded (62.2%all,65.5%applicable);108built-ins/26stubs. All current workers/background tests finished. Full TaskD/100%goal remains unfinished: authentication/session, installers, scheduler/timezone/background/mutex work, broader model/HTTP-test/ORM/service adapters, database helpers and expanded live-service evidence are pending. Live fixture provisioning is permission-blocked despite recorded scoped consent; it was not executed or bypassed.

Latest fully reconciled checkpoint: Wave31/TaskBB complete;982pass/2opt-in live-server skips/0fail,19756assertions across104files/types208; graph freshness/whitespace/historical180 audit pass, graph69sections/560nodes/637edges. Inventory114implemented/26partial/31pending/9excluded (63.3%all,66.7%applicable);109built-ins/26stubs. New-directory app creation/interactive setup complete, not API/broadcast installation or auth/session. TaskD remains genuinely pending; this Wave31 checkpoint is superseded by Wave32 below.

Latest fully reconciled checkpoint: Wave32/TaskBC complete;1005pass/2opt-in live-server skips/0fail,19597assertions across106files/types212; graph freshness/whitespace/historical180 audit and migration-source hygiene pass. Inventory115implemented/26partial/30pending/9excluded (63.9%all,67.3%applicable);110measured built-ins/26stubs; graph70sections/564nodes/641edges. Wave33/TaskBD supersedes this checkpoint below; its reviewed repairs and final gates are complete.

Latest fully reconciled checkpoint: Wave34/TaskBE and Wave35 complete; full suite1036pass/2opt-in live-server skips/0fail,19952assertions across112files; typecheck clean across223files; graph freshness, compatibility provenance/evidence paths and whitespace checks pass. Inventory116implemented/25partial/30pending/9excluded (64.4%all,67.8%applicable);110built-ins/27stubs; graph71sections/568nodes/645edges. TaskBE delivers explicit Linux-only per-worker SQLite setup for parallel tests; the two parallel-test reference records remain partial and all original Laravel/PHP checkboxes, IDs, titles and completion states are unchanged. No PostgreSQL/MariaDB databases or external services were provisioned; live-service provisioning was not retried. Full TaskD and the 100% compatibility goal remain unfinished, with auth/session, service/database adapters, broader command/flag parity and authorized live-service evidence still pending.

## Wave36 — Verified stale scheduler lock cleanup

### Task BF — Force-guarded, fail-closed scheduler cleanup

- [x] Add identity-owned PID-namespace/PID/start/token scheduler records, private mutation serialization, Linux-only `schedule:clear-cache --force`, and regression tests for active/stale owners, malformed/legacy state, namespace mismatch, contention and CLI force semantics.
- [x] Independently review and repair: hidden procfs identities now use signal-0 probing and fail closed for inaccessible live PIDs; generic command token locks are preserved/skipped; zero-link release races are skipped/retried; platform-specific tests are guarded; generated-project allowlist includes the new scheduler lock module. The original reference checkbox remains unchecked; compatibility item `item:40193e8ea992b036` is partial because legacy/generic formats and non-Linux/multi-host semantics remain unsupported.
- [x] Verify focused scheduler and generated-project tests, strict types, full suite, graph freshness, compatibility provenance/counts and whitespace. Final:1045 pass/3 skips/0 failures across113 files,20007 assertions; typecheck225 files; graph71 sections/568 nodes/645 edges; inventory116 implemented/26 partial/29 pending/9 excluded;113 built-in commands. Full TaskD and 100% applicable compatibility remain unfinished.
