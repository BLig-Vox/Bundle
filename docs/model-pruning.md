# Explicit native model pruning

`model:prune` consumes an explicit trusted root `pruning.ts` registry and the selected existing database. It is a native MikroORM bulk-delete facility, not Eloquent traits or automatic model scanning.

## Register rules

```ts
import { definePrunable, definePruning } from './src/database/pruning-definitions.ts';
import { User } from './src/models/User.ts';

export default definePruning([
  definePrunable({
    name: 'ExpiredUsers',
    model: User,
    where(signal) {
      signal.throwIfAborted();
      return { updatedAt: { $lt: new Date('2020-01-01T00:00:00Z') } };
    },
  }),
]);
```

Choose application-specific eligibility carefully. Rules do not infer authentication, tenant scope, soft deletion or authorization. An empty predicate intentionally targets all rows allowed by native filters.

The registry is a copied/frozen branded list of at most 32 unique rule names and model identities. Names are JavaScript-style ASCII identifiers, excluding `__proto__`, `prototype` and `constructor`. Configurations must be closed own-data records, without accessors or symbols. An explicit empty branded registry is valid; missing or invalid source refuses.

Root `pruning.ts` must be a regular, single-link, nonsymlink file at most 64 KiB. Imports use its canonical fixed URL: changes require a fresh process, not hot reload. Source, transitive imports, providers, predicates and ORM filters remain trusted executable application code, not sandboxes.

## Commands

```sh
bun run bundle model:prune --pretend
bun run bundle model:prune --pretend --model ExpiredUsers --limit 500
bun run bundle --force model:prune --model ExpiredUsers --chunk 100 --limit 500
bun run bundle --database archive --force model:prune --model ExpiredUsers
```

Every nonpreview call requires global `--force`, including outside production. Force and argument checks precede pruning-source import and database resolution. Unknown registered selections refuse before opening the database. SQLite must already exist as a regular single-link nonsymlink file; missing targets and `:memory:` refuse without creating parents or files. Named connections and server TLS settings use the existing database configuration contract. Filesystem preflight is not atomic against hostile concurrent tree replacement.

- `--model`: comma-separated unique registered names, at most 32. Omission selects all rules in declaration order.
- `--chunk`: 1–1000 direct targets per transaction, default 100.
- `--limit`: 1–10000 selected targets **per rule**, default 1000.
- `--pretend`: counts only, with no framework deletion or entity hydration. Trusted imports and filters can still have ordinary side effects.

Results contain only `{pretend, models: [{name, matched, selected, deleted}]}`. Preview reports `selected = min(matched, limit)` and zero deletions. Counts and selected keys are observations, not a cross-query concurrent snapshot. Exceptions are generic and do not print criteria, SQL, records or trusted exception messages.

## Native API and lifecycle

`pruneModels(manager, definitions, options)` accepts a native SQL entity manager and the same explicit registry. Options are `pretend`, `force`, `models`, `chunkSize`, `limit` and cooperative `signal`. Nonpreview requires `force: true` before forking or running predicates.

The operation owns a clean fork, never flushes/clears the supplied manager, and never closes the caller's ORM. Each selected rule's metadata and top-level predicate are checked before the first deletion. The predicate is evaluated once with only an AbortSignal. Nested native query values such as Dates are not JSON-serialized.

Only a single mapped scalar primary key is supported. Composite/object keys and custom primary-key conversion types refuse, except the exact built-in native BigIntType. Bigint extraction must preserve exact values; unsafe rounded numeric keys are never accepted. Actual execution takes a finite ascending primary-key snapshot bounded by the per-rule limit, then processes chunks. Each native delete includes both original eligibility and the selected IDs; native default filters apply. Concurrent changes can reduce actual affected counts. It does not repeatedly reselect until a table is empty.

Native bulk deletion **does not run per-entity remove or pruning hooks**. Database cascades, triggers and trusted filters retain their own effects; returned deleted counts describe direct targets, not cascade totals. Transactions are per chunk, not per run. A failure or cancellation can leave earlier chunks committed. Checks within the active transaction permit rollback before commit, but cancellation after a commit cannot undo it. Uncooperative application code is not forcibly terminated.

The CLI owns database close and emits success output only after cleanup. No ORM-table generator, callbacks, scheduler registration, retention daemon or live external-driver certification is implied.

## Verification status

Independent CLI/backend review is complete. The verified SQLite high-bigint precision finding was reproduced before repair: keys above the safe JavaScript integer range were rounded by raw driver results and safely refused. Exact text projection of the quoted mapped column now preserves bigint keys; the independently rerun neighboring-key probe deletes only the selected key. Safe numeric guards remain in place.

Focused actual-process tests cover default and named disposable SQLite targets, preview preservation, missing-force refusal, bounded multi-chunk deletion, reopen persistence and no implicit database creation. CLI tests cover invalid bounds/selectors, pre-abort, generic source errors, unsafe target refusal and output only after cleanup, including completion cancellation. Native tests cover filters, mapped number/string/bigint keys, source/metadata preflight, caller pending state, active-chunk rollback and prior commits, post-commit cancellation, cascades and no entity hooks. Added coverage is not all individually red-first; the missing command and bigint repairs have observed red/green evidence.

Fresh repaired pre-ledger verification passed 879 tests with 2 opt-in live-database skips and 0 failures across 93 files (18,932 assertions); strict typechecking passed in 190 files. Source/graph/inventory now preserve all 180 historical reference IDs, titles and checkbox states, with only the model-pruning reference newly credited. Final post-provenance verification also passed: 879 tests, 2 opt-in live-database skips, 0 failures and 19,109 assertions; strict types, graph freshness and whitespace checks passed. No live PostgreSQL/MariaDB pruning verification was performed.
