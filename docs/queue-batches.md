# Durable local queue batches

Batches use the private local queue, independently of ORM databases and `DB_CONNECTION`. Each batch atomically publishes bounded module and/or command jobs and durable member history. Workers retain the existing at-least-once delivery, receipt ownership, attempts and owned-worker execution rules. This is not Laravel wire compatibility, an ORM batch-table adapter, callback/chain orchestration, exactly-once execution, Horizon or a distributed queue.

## Explicit queue schema upgrade

New files use owned schema version2. An existing verified version1 queue is not silently migrated by worker startup or inspection. Stop **all** old producers, workers and listeners, preserve an appropriate backup and inspect the intended project root before explicitly running:

```sh
bun run bundle --force queue:upgrade
```

Only the exact owned version1 schema upgrades, in one SQLite IMMEDIATE transaction. Existing unbatched ready/delayed/reserved/failed jobs and their raw descriptors remain intact. Version2 is accepted idempotently. Altered/foreign schema or unsafe files/sidecars refuse and are preserved; force is not permission to reset them. No automatic downgrade or backup is supplied. All subsequent clients must use the upgraded implementation. Already-open old binaries do not acquire the new accounting/cancellation rules: mixed-version deployments are unsupported.

Programmatic explicit opt-in is `openLocalQueue(root,{upgrade:true})` or `new QueueStore(path,clock,{upgrade:true})`. Ordinary opens refuse version1 with upgrade-required guidance. These APIs touch only the dedicated queue file, not an application database.

## Dispatch and consume

```ts
import { dispatchBatch } from "./src/queue/dispatch.ts";

const published = await dispatchBatch({
  root: projectRoot,
  jobs: [
    {
      queue: "billing",
      job: {
        module: "src/jobs/Billing/RecordInvoice.ts",
        export: "RecordInvoice",
        method: "handle",
        payload: { invoiceId: 42 },
      },
      maxAttempts: 3,
    },
    {
      queue: "billing",
      job: { kind: "command", version: 1, argv: ["report:invoice", "42"] },
      maxAttempts: 1,
    },
  ],
});
// published.id: opaque 32-character lowercase hexadecimal ID
// published.jobIds: corresponding existing numeric queue job IDs
```

This does not execute jobs on dispatch. Consume them through the existing worker:

```sh
bun run bundle queue:work --queue billing --stop-when-empty
bun run bundle queue:batch BATCH_ID
```

Replace `BATCH_ID` with the returned ID. Ordinary command argv persists unredacted; do not put secrets in arguments. Handlers remain trusted executable application code. Native worker ownership is not a sandbox, rollback facility or guarantee that application-spawned processes are reaped.

A batch contains1..128 entries, each a closed own-data record with required `job` and optional `queue`, `availableAt`, `maxAttempts`. Queue defaults to `default`; individual attempt defaults remain3. Existing job-envelope and64KiB per-job limits apply, with at most1MiB of encoded job JSON across the batch. Sparse arrays, getters, symbols, inherited entries, unknown fields and invalid descriptors refuse. Rooted dispatch validates and snapshots all entries before awaiting filesystem work. Metadata, jobs and membership publish in one transaction; validation/publication failure does not leave a partial batch.

The low-level caller-owned `QueueStore.enqueueBatch(entries)` has the same validation and atomicity contract. Rooted dispatch closes only the store it opens. Neither API changes existing `enqueue`/`dispatchCommand` numeric return values or serializes environment, services or closures.

## Status and cancellation

`getBatch(id)` returns null for an unknown ID, otherwise:

```ts
{
  id, total, pending, succeeded, failed, cancelled,
  createdAt, cancelledAt, finishedAt,
}
```

Counts always sum to total. Pending includes waiting, delayed and live members; member history survives successful acknowledgment and deletion of job rows. `cancelledAt` records a batch cancellation request, not proof that every active handler stopped. `finishedAt` is null while anything remains pending and clears when a legitimate retry reopens failed members. Metadata does not expose payloads, argv, module source or failure reasons.

```sh
bun run bundle queue:cancel-batch BATCH_ID
```

`cancelBatch(id)` durably prevents new claims, cancels unreserved/delayed/expired pending members and preserves live receipt ownership. A live owner can still finish successfully. Its later failure or worker-signal cancellation settles as terminal batch cancellation instead of releasing runnable work. There is no forced interruption of active handlers or rollback of side effects. Cancelled expired receipts reconcile on status/cancel/claim, including a claim scan with no runnable candidate; status inspection can therefore settle expired cancellation metadata.

A worker SIGINT/SIGTERM without a batch cancellation request retains the ordinary cooperative behavior: active cancellation refunds the attempt and releases the member, leaving the batch runnable. Batch cancellation and worker-process cancellation are distinct controls.

## Retry and prune

```sh
bun run bundle queue:retry-batch BATCH_ID
bun run bundle --force queue:prune-batches --before 1794000000000
```

`retryBatch(id)` atomically reopens only failed jobs still retained in that noncancelled batch, resetting attempts and failure/lease state. It returns the actual reopened count,0 when none remain, or null for unknown ID; cancelled batches refuse. It does not replay successes, pending/live work or failures already deleted from history. Individual `queue:retry` also reopens its member when permitted and refuses a still-linked cancelled batch.

Prune uses a required strict nonnegative epoch-millisecond cutoff, maximum8640000000000000. `pruneBatches({before})` removes only finished batch metadata/member history with `finishedAt < before`; CLI requires global force before opening storage. It never deletes job rows. Retained failures detach and remain individually retryable as ordinary unbatched jobs. Pending/live batches survive, including cancelled batches that still have a live owner. Invalid IDs/cutoffs and missing required force refuse before storage creation. Unknown batch CLI actions fail rather than fabricating successful empty metadata. Validation/abort guards apply to these owned operations; ordinary earlier provider and command discovery remains trusted startup code and can have its own side effects.

Existing operations account for members in the same transaction as jobs: ack succeeds once, reserve exhaustion records real failure, clear marks deleted unreserved members cancelled, and forget/flush/prune-failed preserve terminal failed member history after removing job records. Clear keeps its existing protection of live and expired receipts. Deleted failures cannot be resurrected by batch retry. No deferred worker callback is the source of durable counts.

## Verification scope

Leader verification passed120 queue/cache/CLI tests with8708assertions plus8 separate-process entrypoint tests with118assertions: generated default-filled/custom jobs mixed with commands, persisted failure/retry, live success/failure cancellation, real worker SIGTERM attempt refund, explicit version1 upgrade/raw preservation and strict-cutoff pruning/detachment. Application databases remain absent. Independent review found an inherited SQL wildcard ownership-filter error;9 benign foreign-object rejection regressions failed before a literal-prefix fix in queue and cache. Full upgrade-field/refusal/internal-object controls, clock rollback, transaction rollback and reopen coverage passed; later coverage is not individually red-first. Independent re-review found no remaining confirmed issue. Final post-source/provenance full suite:849passed,2opt-in live PostgreSQL/MariaDB skips,0failures,18483assertions across89files; strict types183, graph freshness/whitespace and unchanged historical180-reference audit passed. This is local evidence, not exhaustive interleavings, expanded live-server support or full Artisan compatibility.
