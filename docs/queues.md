# Durable local jobs and owned workers

Bundle supplies a dedicated local SQLite queue and trusted TypeScript job execution. This is **at-least-once delivery**, not exactly-once side effects, Redis/Horizon interoperability, or multi-host deployment evidence. Jobs must be idempotent where duplicate side effects matter.

## Produce a job

`bun run bundle make:job RebuildIndex` exclusively creates `src/jobs/RebuildIndex.ts` with an own `handle(payload:unknown,signal:AbortSignal)` method. Nested PascalCase names are supported. The default method is an explicit example: replace it with real application work. The consumed `stubs/job.ts.stub` template requires `{{name}}`; custom output is executed through the real owned worker and persisted CLI queue in tests. There is no automatic dispatch or middleware registration.

Alternatively write a trusted module exporting a function `(payload: unknown, signal: AbortSignal)` or a class with an own prototype method. Validate the payload in application code; the queue's JSON validation is not application authorization.

```ts
import { openLocalQueue } from "./src/queue/opening.ts";

const queue = await openLocalQueue(import.meta.dir);
try {
  queue.enqueue("default", {
    module: "src/jobs/RebuildIndex.ts",
    export: "RebuildIndex",
    method: "handle",
    payload: { itemId: 7 },
  }, { maxAttempts: 3 });
} finally {
  queue.close();
}
```

`method` is omitted for a function export. Jobs contain executable references, never serialized function source. Paths are safe root-relative `.ts` segments using letters/digits/underscore/hyphen; declaration files, traversal, unsafe exports and oversized/lossy JSON are refused. Actual execution also checks files/parents against symlinks/hard links and resolves only own exports/class methods. Imported modules and dependencies are trusted code, not a sandbox.

`openLocalQueue(root)` canonicalizes root aliases and opens only `.bundle-queue/queue.sqlite`. It does not use `DB_CONNECTION`, ORM models or application databases. New queue directories/files use private modes; the path, file ownership, sidecars and dedicated schema/application marker are checked. Unsafe or unrelated databases are refused, not adopted or reset. This state is gitignored because payloads can contain secrets. Existing parent directories must satisfy ownership/write checks; safety assumes no hostile concurrent tree renaming.

## Dispatch a console command

`dispatchCommand` in `src/queue/dispatch.ts` persists a versioned built-in envelope rather than an application module reference:

```ts
import { dispatchCommand } from "./src/queue/dispatch.ts";

const id = await dispatchCommand({
  root: import.meta.dir, // explicit absolute project root, canonicalized before opening
  argv: ["report:daily", "2026-11-07", "--tag", "invoices"],
  queue: "default",
  maxAttempts: 3,
});
```

The return value is the queued job ID, **not** a command result. `queue` defaults to `default`; optional `availableAt` is an absolute epoch-millisecond availability. The first argv entry is a Bundle command name, not a global flag or shell string; place supported flags after that name. The full dense argv is bounded to128 strings,4096 UTF-16 units per string and64KiB serialized envelope. NULs, malformed/unsupported envelopes, lossy values, invalid queue/attempt/availability options and nonabsolute roots refuse before queue storage creation. Dispatch snapshots argv before awaiting filesystem work and does not import the target command to check existence. A command created after dispatch can execute; a removed/renamed or malformed command fails when consumed.

An owned job worker invokes the real runner against the selected root with a fresh parser/service scope and the worker's AbortSignal. No callbacks, service objects, lifecycle hooks or dispatch-time environment are serialized. The worker inherits its execution-time environment, which trusted code can access. `cwd` is not changed: custom commands must use `context.root` for rooted application files. All ordinary trusted module loading limitations remain; the parent CLI's own application-command discovery occurs before job execution and is not bounded by the owned job timeout.

Exactly exit0 is acknowledged. Every nonzero runner status, including a handler merely returning130/143, is failed/retried under the stored policy; it is not cancellation. Finished command attempts add `commandExitCode` to execution/attempt metadata. Timeout and real queue cancellation retain their existing failure/refund semantics and do not invent a command exit status. Explicitly noninteractive prompts accept valid defaults or refuse without reading terminal input. Context output/error and parser diagnostics are discarded; there is no persisted/replayed command output. **This is not comprehensive output secrecy:** trusted direct `console`/process writes and application-spawned subprocesses can still use their own streams. Use application-controlled logging for reports, without secrets.

Argv is stored in private SQLite and is **not secret-redacted**: never dispatch passwords/tokens in arguments. The new `{kind:"command",version:1,argv:[...],middleware?:[...]}` shape shares the existing version1 jobs table and preserves legacy module jobs. Older Bundle consumers cannot execute it; upgrade consumers before producers and avoid mixed-version consumers while these jobs exist. At-least-once execution requires idempotent application commands; queued execution does not authorize destructive operations or supply missing force flags.

## Job middleware

`bun run bundle make:job-middleware Billing/Trace` creates an explicitly pass-through function at `src/queue/middleware/Billing/Trace.ts`, with a correct relative type import. Replace the example and register it explicitly when enqueuing:

```ts
queue.enqueue("default", {
  module: "src/jobs/RebuildIndex.ts",
  export: "RebuildIndex",
  method: "handle",
  payload: { itemId: 7 },
  middleware: [{ module: "src/queue/middleware/Billing/Trace.ts", export: "Trace" }],
});
```

`dispatchCommand` also accepts optional `middleware` references, validated/snapshotted alongside argv before asynchronous opening. At most16 references fit within the same64KiB job envelope; module paths/exports/methods use the same512/128 limits. The generator checks the eventual reference before creating output, consumes the seventeenth `stubs/job-middleware.ts.stub` (`{{name}}`, `{{runtimeImport}}`), and refuses overwrite/symlinked parents. Module references name functions or own class methods; classes get fresh instances. All referenced modules are checked/imported before pipeline invocation and run as trusted code.

`JobMiddleware` is `(context:{job:unknown,signal:AbortSignal},next:JobMiddlewareNext)=>void|Promise<void>`. `next()` returns a native `Promise<void>`; `next.recover(handler)` is the explicit recovery alternative, also returning a native promise. The job is the whole module/command descriptor; narrow its shape and validate application payloads yourself. Middleware runs in listed nesting order: before-first, before-second, handler, after-second, after-first. Each next may start downstream at most once. Already-started downstream is awaited even if middleware forgets to await its next promise; an observed repeated next fails instead of executing the target twice. Keep work attached to returned promises; this is not background-task supervision.

**Returning without next is intentional successful short-circuiting:** the job is acknowledged without invoking its handler. It is not automatic release, delay, retry or authorization. The ordinary `next()` path always propagates a downstream failure, **even if middleware locally catches it**, so forgetting to return/await a rejected next promise cannot silently acknowledge failed work. To deliberately recover a module/nested middleware failure, call `await next.recover(async error => { /* application recovery */ })` instead of next; only successful recovery completes, and a throwing/rejected recovery fails normally. Both forms share one invocation limit and any started work/recovery is awaited even if its return is ignored. This explicit Bun recovery API differs from conventional implicit try/catch recovery; no promise-handler-observation heuristic is used. A nonzero console-command status remains failed even after explicit recovery. Finished command status can be0 while a later middleware error still fails the job; no command status is emitted if the command was skipped. Middleware/imports share the owned execution timeout/cancellation and cannot intentionally pin the parent beyond its existing cleanup boundary. Side effects are not undone. Old workers do not understand middleware-bearing descriptors; use the same coordinated consumer rollout as command envelopes.

## Consume jobs

```sh
bun run bundle queue:work --once
bun run bundle queue:work --queue high,default --tries 3 --max-jobs 20 --timeout 60000
bun run bundle queue:work --stop-when-empty --backoff 1000
```

The default queue is `default`. `--queue` is a comma-separated priority list: due work from the first queue is selected first, with FIFO IDs among eligible work inside a queue. `--once` attempts at most one currently available job; `--max-jobs` bounds attempts; `--stop-when-empty` stops when no selected work is currently due, even if future-delayed or reserved work still exists.

**Bundle timing flags use milliseconds**, unlike Laravel's seconds-based options. Idle `--sleep` defaults to 1000 ms; failure `--backoff` defaults to 1000 ms. The whole owned-job lifetime, including import, defaults to a 60000 ms timeout. Work CLI timeouts permit 1–86399000 ms so the reservation lease retains a margin within its 24-hour bound. Invalid work options fail before queue storage is initialized. Producer `enqueue(...,{maxAttempts})` supplies the default budget. Optional `--tries <count>` (1–100) explicitly overrides the budget for newly claimed eligible jobs; without it, the stored producer/previous budget is retained.

A chosen override is persisted atomically with a claim, so subsequent default consumers, lease recovery, retries and settlement see the same limit. A lower override declares already-exhausted eligible work failed **without** executing or incrementing it, then considers the next job. A higher override can reclaim eligible expired work even when its old budget was exhausted. Live reservations, unrelated queues, not-yet-due jobs and candidates after the selected claim keep their policy. Cancellation refunds its current attempt but retains the chosen limit; explicit retry resets attempts, not that stored policy. Exhaustion is declared lazily when eligible work is considered in a selected queue, not by a global sweep of unrelated queues. Such nonexecuting failure classification is not included in processed/max-jobs attempt counts.

Each job runs in a fresh owned Bun worker. It receives its original JSON-safe payload and an AbortSignal; a referenced class gets a fresh instance. Ordinary completion is acknowledged only through the current unexpired receipt. Failed/timed-out attempts are retried after backoff until the stored attempt policy permanently fails them. Cooperative SIGINT/SIGTERM cancellation stops only the owned worker, requeues and refunds the current attempt, and exits 130/143; an unresponsive worker is terminated after a 250 ms cleanup grace. It never intentionally terminates an embedding host or undoes trusted external side effects/spawned processes.

The parent renews leases while work runs. A lost/expired receipt stops its owned execution and produces an ownership error, never an invented successful acknowledgment. SQLite lease/ownership decisions sample the clock **after acquiring** the immediate write lock, including under contention. If a process dies after effects but before acknowledgment, its expired reservation may execute again. Long lock waits, clock changes, or process crashes do not establish exactly-once delivery.

Per-attempt JSON output includes `{id,queue,attempt,outcome,settlement}` and conditional `commandExitCode` for finished console-command attempts. Outcomes are `completed`, `failed`, `cancelled`, or `timed-out`; settlements distinguish `acknowledged`, retryable `released`, and permanently `failed`. A handled job failure does not itself crash the healthy worker process or mean every job succeeded. Application code can still write its own console output to the shared process streams; keep it separate if consuming worker metadata mechanically.

## Fresh-process queue listener

```sh
bun run bundle queue:listen --queue high,default --tries 3 --timeout 60000
bun run bundle queue:listen --max-cycles 2 --sleep 1000
```

`queue:listen` supervises one fresh owned Bun process running the real rooted `queue:work --once` per cycle. `--max-cycles` counts **child invocations**, not jobs/attempts: an empty or paused cycle still counts. Defaults and queue/tries/timeout/backoff bounds match the worker; times remain milliseconds. There is no `--max-jobs` alias. The listener sleeps after **every** cycle (default1000ms), even when work existed, so this favors reload isolation rather than throughput. The child uses the canonical selected root as cwd and runner context, an ignored stdin and execution-time environment; each cycle imports source afresh without creating application helper files or executing a shell.

Child stdout/stderr are decoded/forwarded concurrently as raw chunks without accumulating a whole run. Ordinary per-attempt JSON is unchanged; trusted direct output can interleave and is not automatically sanitized. After owned child exit, streams have up to250ms to drain, then readers are cancelled so an application-created grandchild retaining inherited pipes cannot pin the listener. Normal EOF preserves final output, but output still buffered or produced past that bound may be lost; this is not a lossless log transport. A nonzero child exit fails the listener generically rather than causing a respawn storm. A handled job failure is different: `queue:work` settles it normally and exits0, allowing later cycles. Injected output/error callbacks are synchronous; stream/callback failures stop and reap the owned child before a generic rejection, not leave a child behind.

SIGINT/SIGTERM forwards cooperative cancellation to the owned child, then escalates after1000ms only if it remains alive, awaiting cleanup. Cooperative job cancellation normally settles/refunds its attempt; hard termination instead leaves lease recovery to the store. Pre-aborted API calls start no child. This is not process-group supervision: application-spawned processes are not killed or their effects undone. Root aliases canonicalize; unsafe control state still fails closed.

A listener baselines the current restart generation and checks it between child cycles. A changed generation lets active work/child settle, then exits successfully before another cycle. Pause/resume is enforced by child claims. These are read/claim-boundary requests, not atomic global freezes. Restart cannot force a genuinely hung active child/import to complete; external cancellation can terminate the owned process after grace. Parent CLI discovery also remains trusted and outside the owned job timeout. The command does not install a service manager, restart itself after exit, or verify Redis/multi-host behavior.

`listenQueue({root,env?,signal?,queues?,sleepMs?,timeoutMs?,maxAttempts?,retryDelayMs?,maxCycles?,output?,error?})` in `src/queue/listener.ts` returns `{cycles}` after owned cleanup. Callers own any injected writer lifetime and unrelated processes.

## Persisted pause, resume and graceful restart

```sh
bun run bundle queue:pause high
bun run bundle queue:resume high
bun run bundle queue:restart
```

These reversible controls use private bounded version-1 `.bundle-queue/control.json`, not changes to job rows or the ORM. Pause/resume is idempotent per validated queue. Restart changes an opaque generation token for this project root; it requests running consumers to **exit successfully after active work settles**, not abort a job, undo effects, invalidate a receipt or spawn a replacement process. A fresh consumer baselines the latest token and can continue normally. The separate `queue:listen` loop supplies fresh owned child cycles; it also exits on a restart-generation change. Use an external supervisor or explicitly start the consumer again when replacement after that exit is needed; `queue:restart` itself starts nothing.

Workers read control state between claim attempts. They filter paused selections, finish/acknowledge in-flight work normally, and observe a new restart generation before the next claim. With all selected work paused, continuous work waits using its configured idle polling interval and cancellation remains prompt; once/stop-when-empty treats paused work as currently ineligible. Resume/restart observation can therefore wait for configured sleep or active work. A state read and SQLite claim are **not one cross-process transaction**: a later control change can race a claim already beginning; this is not a guarantee that pause atomically freezes every process at the CLI return instant.

Absent state is a clean baseline and reads create neither state nor jobs. Invalid/unsafe state fails closed before further claims, without printing raw state values; active owned work still settles before the next control read. State is at most64KiB and128 distinct paused queue names. Canonical root aliases work; below-root symlinked/unowned/writable queue directories, symlinked/hardlinked/nonregular/wrong-mode files, corruption/duplicate or unknown keys and oversized content are refused and preserved. Readers retry demonstrably unstable snapshots (inode replacement, first-publication link transitions or disappearance after observation) up to 64 times, with 1 ms waits. Sustained instability fails closed rather than becoming a clean baseline; stable unsafe metadata still refuses, and a stable hardlink is rejected after the bounded retries. Atomic mutations use an owned `.control.lock`, exclusive temporary files and mode0600 publication. A crash may leave a lock for **manual inspection**, never automatic expiry. No hostile concurrent tree-renaming or multi-host guarantee is made.

## Failed-job controls

```sh
bun run bundle queue:failed
bun run bundle queue:failed --queue default --limit 100
bun run bundle queue:failed --queue default --limit 100 --after 7
bun run bundle queue:retry 7
bun run bundle --force queue:forget 7
```

Failed listing returns `{failed, nextAfterId}` with generic metadata reasons, never payloads or raw handler exception messages. `--limit` accepts 1–1000 (CLI default 1000); repeat the same queue filter and pass the nonnull `nextAfterId` to `--after` to continue. IDs are strictly ascending, not offset-based, so deleting a cursor record does not skip later IDs. This is live pagination, not a frozen history snapshot: concurrent inserts/retries/deletions can change later pages. A null continuation means no further matching row was observed in that query. Invalid queue/cursor/size inputs fail before opening storage. `queue:retry <id>` resets one failed job's attempts and makes it available now; repeated side effects remain an application concern. `queue:forget <id>` requires force and removes only a failed record, never a pending/reserved job. Unknown IDs report an explicit false result. All-job deletion, automatic retention and batch retry are not implied. The scoped explicit cleanup commands below are separate from single-ID controls.

## Local monitoring and explicit cleanup

```sh
bun run bundle queue:monitor --queue default
bun run bundle queue:monitor --queue default --max 100
bun run bundle --force queue:clear default
bun run bundle --force queue:flush --queue default
bun run bundle --force queue:flush --all
bun run bundle --force queue:prune-failed --queue default --before 1794000000000
```

Monitor returns one local SQLite snapshot `{queue,ready,delayed,reserved,expired,failed}`. States are disjoint; reservations are split at lease expiry, and failed rows are not active. `--max` optionally compares ready+delayed+reserved+expired with the threshold: equality is allowed, an exceeded maximum adds `exceeded:true` and exits 1. Without a threshold it just reports counts. An exceeded invocation dispatches local `queue.busy` with the same metadata through the real cache-first application event registry. Listener errors are sanitized and still fail. Normal trusted import/cooperative listener limits apply; this is neither a background monitoring daemon nor durable notification/Redis evidence. Repeated invocations can emit repeated busy events.

**Every deletion command requires `--force`.** Clear requires a named queue and deletes only its unreserved nonfailed ready/delayed rows, preserving both live **and expired** receipts for worker recovery, failed history and other queues. Flush deletes failed history only; prune deletes only failed records whose failure timestamp is **strictly less than** `--before` (explicit nonnegative epoch milliseconds, not a timezone string or implicit retention age). Flush/prune require exactly one of `--queue <name>` or `--all`; force alone does not select everything. Invalid selection/names/cutoffs and absent force refuse before queue storage is opened. There is no automatic retention timer, reserved-job cancellation, unowned filesystem cleanup or schema reset.

These guarded commands are destructive when explicitly run against an application queue. Inspect scope and preserve any needed history before running them; implementation tests use disposable files, not existing application queues.

## Programmatic store and worker APIs

`QueueStore(path, clock?, {upgrade?:true}?)` in `src/queue/store.ts` is synchronous; its parent directory must exist. New state is exact owned schema2; existing verified schema1 requires explicit opt-in after stopping all old processes. `openLocalQueue(root,{upgrade:true})` and force-guarded `queue:upgrade` provide the same upgrade; no automatic migration, downgrade or mixed-version safety. See [batch rollout and lifecycle](queue-batches.md). Stored invalid JSON/unsupported descriptors decode to `null` in `Reservation.job`/`FailedJob.job` (callers must narrow it). Such a row is still claimed with ordinary ownership/attempt accounting, fails generically in owned execution and eventually enters failed history without starving subsequent work. Raw SQLite job text is retained unchanged for inspection; list/page APIs do not throw or return that raw invalid blob. This is not a database reset or adoption of an unrelated schema. The optional clock returns epoch milliseconds.

- `enqueue(queue, job, {availableAt?, maxAttempts?}?)` returns a numeric ID; defaults are immediate availability and three attempts.
- `reserve(queues, {leaseMs?,maxAttempts?}?)` atomically returns `null` or `{id,queue,job,attempt,receipt}`. The receipt is an opaque 64-hex-character owner token, not the numeric job ID.
- `ack(receipt)`, `heartbeat(receipt,{leaseMs?}?)`, `fail(receipt,reason)` and legacy `release(receipt,{delayMs?}?)` return booleans, always requiring current ownership and an unexpired lease.
- `settle(receipt,{outcome:"failed"|"cancelled",delayMs?})` atomically returns `released`, `failed`, terminal batch `cancelled` or `null` for ownership loss. Worker cancellation refunds the current attempt in an ordinary noncancelled batch; an explicit batch cancellation prevents release/retry of its members. Ordinary failure preserves max-attempt policy. Legacy release retains its boolean contract and does not distinguish final failure; consumers needing that distinction use settle.
- `listFailed(queue?)` retains its legacy first-1000 array contract. `failedPage({queue?,afterId?,limit?}?)` defaults to 100 records and returns `{failed,nextAfterId}`; limits are 1–1000. Programmatic records include jobs/reasons; only CLI metadata is automatically minimized.
- `snapshot(queue)` returns `{ready,delayed,reserved,expired,failed}` from one SQL query and one clock sample. `clear(queue)` removes only unreserved nonfailed jobs. `flushFailed({queue}|{all:true})` and `pruneFailed(({queue}|{all:true}) & {before})` return deletion counts with exact explicit scope/cutoff. Programmatic callers must provide their own authorization; CLI force is not a backend permission system.
- `retry(id)`, `forgetFailed(id)` and `close()` manage dedicated state. Direct programmatic failure reasons/payloads are not automatically secret-redacted; protect the private file and use suitable application logging policy.
- `encodeJob(job)` validates and serializes a bounded module descriptor or versioned command envelope without opening storage. The job generator uses module validation before creating files, enforcing both the 128-character export and 512-character final module-path bounds. Enqueue and owned consumption also validate job variants; malformed persisted jobs are not acknowledged as successful.

Limits: 64 queues per claim, 128-character queue/export/method names, 512-character module paths, 64 KiB serialized jobs, 64 JSON nesting levels, 100 attempts, 24-hour leases, 30-day release delays and 4096-byte programmatic failure reasons. Nonplain/cyclic/accessor/sparse/lossy values are refused. Lease recovery uses SQLite transactions and a five-second busy timeout; real local competing-process tests are not evidence of network-filesystem or multi-host safety.

`runQueuedJob({root,job,timeoutMs?,signal?})` in `execution.ts` provides the owned executor separately. `workQueue({root,store,queues?,signal?,once?,stopWhenEmpty?,maxJobs?,maxAttempts?,sleepMs?,timeoutMs?,retryDelayMs?,onResult?})` consumes and settles jobs, returning `{processed}`; callers retain ownership of their store. Cooperative callbacks/listeners outside the owned job worker are not forcibly terminated.

## Remaining scope

[Durable local batches](queue-batches.md) now supply atomic mixed dispatch, status/cancellation and retained-failure retry/terminal-history prune through real workers. They do not supply an ORM batch-table adapter or callback/chains. System-service replacement/self-respawn, background metrics/automatic retention, framework table migrations and Redis/server adapters remain unfinished capabilities. Implemented snapshots and explicit scoped cleanup do not imply those subsystems. A generated event/listener is not a queued listener. Server/external-service verification remains gated; nothing here provisions services or touches existing ORM databases.
