# Durable local queue batches

## Goal and boundaries

Consume real module and command jobs as atomic persisted local SQLite batches, with receipt-safe accounting, explicit cancellation, retry and terminal-history pruning. This advances the original batch/retry-batch/prune-batches references only after actual worker/process consumption and independent review. It does not implement the separate ORM batch-table adapter, Laravel callbacks/chains, Redis/Horizon, exactly-once delivery or multi-host guarantees.

Use existing Bun/TypeScript and bun:sqlite only. Preserve all existing dirty work, queues, job envelopes, descriptor validation, priority/FIFO, lease/attempt/timeout/signal behavior and file/sidecar ownership checks. Tests use unique disposable roots, never the repository queue or application databases. No installs/downloads/services/commits/pushes. No markup or UI framework.

## Version and rollout

New queue files use strict owned schema version2, retaining the exact existing jobs table and adding exact batch metadata/member tables. Member history persists after successful jobs are acknowledged/deleted. Reject unknown objects, versions and altered DDL without resetting data.

Opening a verified version1 queue refuses with a generic explicit upgrade-required diagnostic unless the caller requests `new QueueStore(path, clock, {upgrade:true})` or `openLocalQueue(root,{upgrade:true})`. Upgrade is an IMMEDIATE transaction after validating the exact version1 application_id/jobs DDL; it preserves ready/delayed/live/failed and corrupt raw job records. Existing version2 queues accept the option idempotently. CLI `queue:upgrade` requires global --force before opening storage; output only {version:2}. No automatic schema upgrade during ordinary worker/inspection startup.

Operators must quiesce ALL old producers/workers/listeners before explicitly upgrading and then run only upgraded binaries. Old already-open binaries cannot be made safe by a new schema: mixed-version operation is unsupported. An upgrade is not a backup or a downgrade tool. Do not open or upgrade real user queue state during implementation.

## Public APIs

`BatchEntry`: closed own enumerable data record `{job:QueueJob,queue?:string,availableAt?:number,maxAttempts?:number}`. Omitted queue defaults to default, attempts retain existing default3. Dense plain array of1..128 entries, no getters/symbols/unknown keys/inherited records; each job uses existing encodeJob; sum of encoded UTF8 job bytes <=1MiB. All entries/options are validated and JSON-snapshotted before any write and, for rooted dispatch, before awaiting canonicalization/opening storage. Empty/oversized batches refuse without publishing anything. Export the entry/result/status types from queue/store.ts (reexports are acceptable).

`QueueStore.enqueueBatch(entries:readonly BatchEntry[]):BatchDispatch`, where `BatchDispatch={id:string,jobIds:readonly number[]}`; id is32 lowercase hex characters from cryptographic randomness. Metadata/jobs/members insert in one IMMEDIATE transaction; sample clock after lock. No serialized closures/services/environment.

`dispatchBatch({root:string,jobs:readonly BatchEntry[]}):Promise<BatchDispatch>` in queue/dispatch.ts uses the same canonical rooted owned store and closes only its own store. Existing dispatchCommand/enqueue return values and two job envelopes are unchanged.

`QueueStore.getBatch(id:string):BatchStatus|null`; `BatchStatus={id,total,pending,succeeded,failed,cancelled,createdAt,cancelledAt:number|null,finishedAt:number|null}` with numeric counts/times (id string). Sum of four counts always equals total. pending includes ready/delayed/live members. finishedAt is nonnull only when pending=0; it clears on a legitimate retry. A cancelledAt flag requests cancellation; it does not imply all running work has settled. No payloads, argv, exception reasons or member source code appear in metadata.

`QueueStore.cancelBatch(id:string):BatchStatus|null` is durable/idempotent. It prevents new batch claims; cancels/removes unreserved or expired pending members including delayed work; preserves failed history and live receipt ownership. Active successful acknowledgment still counts success. Active failure/signal cancellation after batch cancellation becomes terminal cancelled, not runnable again. Do not force-kill handlers, roll back side effects or claim race-free prevention of already-owned work. Expired receipts in cancelled batches reconcile on cancel/get/reserve even when no runnable candidate exists; stale receipts cannot change counters. Finish timestamps use observed settlement time, not fabricated past completion.

`QueueStore.retryBatch(id:string):number|null` returns null for unknown batch; throws generic refusal for a cancelled batch; otherwise atomically resets only retained failed jobs, clears their failure/attempt/lease state, marks corresponding members pending and clears finishedAt when any reopened. Returns0 for valid noncancelled batch with nothing retained to retry. It never replays successes, deleted failures or waiting/live members.

`QueueStore.pruneBatches({before:number}):number` removes only terminal batch metadata/member history with finishedAt strictly less than validated epoch-ms cutoff (same maximum8640000000000000). It never deletes jobs, even retained failed rows; those detach and remain individually retryable as ordinary jobs. Pending/live batches survive. Invalid ids (not exact32 lowercase hex) or cutoff refuse before mutation/opening in CLI.

## Integrated transitions

All changes to jobs and their batch member state occur in the SAME IMMEDIATE transaction, never deferred worker callbacks. Update ack, settle/release, fail, reserve exhaustion, individual retry, clear and failed-history deletion paths. Derive counts from member records rather than incomplete remaining jobs; protect against double settlement and expired/stale receipts. `settle` adds terminal `cancelled` disposition, propagated through QueueWorkResult settlement; existing unbatched returned dispositions remain unchanged. Worker-signal cancellation of an ordinary noncancelled batch refunds attempt and releases as before, without changing member to terminal failure.

Individual retry reopens retained failed member/batch only if not batch-cancelled; cancelled-batch member returns false. Forget/flush/prune-failed preserve failed member history after deleting the job. clear marks deleted unreserved pending members terminal cancelled; existing live/expired receipt protection remains unchanged. Acknowledgment records success before deleting job; reserve exhaustion records failure only if its conditional update actually succeeds. Nested transactions and clock rollback must not produce counters for mutations that did not happen.

## CLI

New cli/queue-batches.ts registers through program.ts:

- `queue:batch <id>` emits bounded BatchStatus; unknown id fails generically, no successful fabricated batch.
- `queue:cancel-batch <id>` emits actual BatchStatus; unknown id fails. No force required, consistent with ordinary retry/control actions.
- `queue:retry-batch <id>` emits {id,retried}; unknown/cancelled refuses, no payload/reason output.
- `queue:prune-batches --before <epoch-ms>` requires global --force and emits {before,removed}.
- `queue:upgrade` requires global --force before opening and emits {version:2}.

Validate all ids/cutoffs/required force before storage creation. Sanitize any backend error at CLI boundary, retaining actionable generic upgrade-required guidance. Respect pre-aborted cooperative signals before opening. Existing source/provider imports retain trusted execution and ordinary cancellation limitations.

## Verification and review

TaskAO owns queue store/validation/dispatch/open/worker integration and focused tests. TaskAP owns CLI/registration and actual entry-point tests/docs/inventory. Tasks are sequenced at exact API boundary; no concurrent store editing. Every new behavior starts with an observed missing-feature/red regression; later boundary coverage is labelled honestly.

Required real disposable SQLite tests: atomic mixed enqueue/reopen; no early rows on invalid/oversized input; known-v1 explicit upgrade/preserved raw ready/live/failed data and unknown/foreign/DDL refusal; rollback on publication error; persisted status after ack/terminal failure/retry/cancel/lease expiry; caller/process cancellation refund; same-file two-connection claim/cancel/stale ownership; actual worker mixed module/command execution; deleted failed history and clear interactions; strict prune cutoff/detachment preserving runnable/live/failed jobs. Actual CLI subprocess tests cover default/custom generated jobs, batch status/cancel/retry/prune/upgrade, force/id/cutoff pre-storage refusal and generic metadata/no DB_CONNECTION side effects. No arbitrary-delay readiness checks where observable handshakes exist.

Independent review must inspect accounting at EVERY existing mutation, cancellation/lease races, validated schema migration and real consuming tests, not just help output. Reproduce findings red before fixes, re-review, then full suite, strict types, graph freshness, whitespace and original180 reference audit before progress credit. Queue batch table generator remains pending without a separate consuming ORM adapter. Full100%scope remains unfinished after this slice.
