# Explicit native model pruning

## Goal and constraints

Implement original pending `item:2c9da268301e36c3` (`model:prune`) through real force-guarded native MikroORM SQL deletion, not Eloquent traits or empty scaffolds. Trusted root pruning.ts explicitly supplies model/rule registrations. Preview counts, bounded deterministic target selection, transaction/cancellation behavior and actual SQLite consumers precede credit.

Preserve all existing dirty work and database CLI guards/configuration/target semantics. No installs/downloads/services/commits/pushes or existing application-data operations. Tests use unique disposable SQLite roots. Code-first Bun/TypeScript, native classes/EntitySchema, no decorators/markup/UI framework/schema DSL. No db:wipe or live-server provisioning.

## Definitions and source

New database/pruning-definitions.ts provides:

- `definePrunable<T extends object>({name:string,model:EntityClass<T>,where:(signal:AbortSignal)=>FilterQuery<T>|Promise<FilterQuery<T>>}):Prunable`.
- `definePruning(rules:readonly Prunable[]):PruningDefinitions` (branded copied/frozen list).
- `loadPruning(root:string,signal?:AbortSignal):Promise<PruningDefinitions>`.

Public Prunable exposes readonly name, not callback source or secrets; private branded state holds snapshotted model/callback references. Required own enumerable data fields only, plain/null-prototype options, no getters/symbols/unknown fields. Names are ASCII JavaScript-style identifiers1..128 excluding __proto__/prototype/constructor. Model and where must be functions; native metadata later proves mapping. Dense list0..32 rules, branded entries, unique names and unique model identities; copy/freeze. Empty explicitly branded source is valid; missing/unbranded source refuses, not a fake successful no-op.

Root must be absolute and canonicalized; root pruning.ts must be bounded64KiB regular single-link non-symlink source. Import only that explicit trusted source through fixed canonical file URL, with signal checks before/after awaits and generic errors. No scanning model source for traits, source reevaluation/hot reload, downloads or caches. Manifest and transitive imports are trusted executable code, not sandboxes. Validate model selectors/options before source import where possible.

The where factory receives only AbortSignal, never the owned manager. It is evaluated once per selected rule and must produce a native plain nonarray predicate record; nested Date/native ORM query values are allowed, not JSON serialized. It remains trusted query code; criteria do not come directly from request input. Empty predicates intentionally select all eligible rows only under explicit force/bounds. No inference of authentication, tenant identity or authorization. Do not claim isolation from arbitrary source/filter/database-trigger side effects.

## Native consumer

New database/pruning.ts exports:

`pruneModels(manager:SqlEntityManager,definitions:PruningDefinitions,options:PruningOptions):Promise<PruningResult>`

Options are closed copied own data with `{pretend?:boolean,force?:boolean,models?:readonly string[],chunkSize?:number,limit?:number,signal?:AbortSignal}`. Nonpretend operation requires force===true before fork, predicate or query; no implicit destructive default. Optional selectors are dense unique names1..32, all configured or refusal. chunkSize default100,1..1000; limit default1000,1..10000 target rows PER selected rule. Capture selector/flag/numeric values before first await. Pre-abort refuses. Native SQL EntityManager required; use its own clean fork, never flush/clear supplied manager or close caller ORM. Clear owned fork in finally. The installed @mikro-orm/sqlite entrypoint already reexports SqlEntityManager/native SQL types, so no new direct transitive dependency or install is needed.

PruningResult is `{pretend:boolean,models:readonly {name:string,matched:number,selected:number,deleted:number}[]}`; counts are safe nonnegative integers, metadata only. Declaration order retained. Unknown/duplicate selectors and invalid metadata/predicates fail generically. Single scalar mapped primary key with primitive string/number/bigint values only; composite/unmapped/object primary keys refuse before any delete. Validate all selected model metadata and top-level predicate results before the first delete so predictable invalid-rule failures cannot partially prune earlier rules. No criteria/SQL/exception text in public diagnostics/output.

For each rule: check cancellation; resolve native metadata; evaluate predicate once; count matching rows using owned manager. Preview returns matched and selected=min(matched,limit), deleted0 without deletion or entity hydration. Real execution snapshots at most limit primary keys ordered ascending, using native SQL QueryBuilder raw mapped results (not hydrated entities) and native default filters. QueryBuilder.applyFilters() is available in installed7.2.7; nativeDelete also processes native filters. Support field-to-column primary mappings; reject invalid scalar primary values. Selection/count are observations, not a global snapshot under concurrent mutation.

Consume the finite selected-key list in chunkSize slices. Each chunk uses a transaction-owned native manager and nativeDelete with BOTH original predicate and selected-key membership; check signal before and after awaited work within transaction. This prevents infinite reselect loops or deleting newly eligible/unselected keys. Return actual affected target count; concurrent changes/filter decisions may reduce it. No automatic unbounded draining. Caller pending state must remain unflushed and usable.

Native bulk deletion deliberately does not fire per-entity remove/pruning lifecycle hooks; do not silently substitute entity hydration/removal callbacks. Database FK cascades/triggers and trusted native filters remain their native behavior and can affect more than selected target rows; returned counts are direct target rows only. Transactions are per chunk, not all rules/run: earlier committed chunks remain after later failure/cancellation. Cancellation after commit does not undo committed rows. No dry-run SQL-string substitute, soft-delete inference, ORM callback parity or forced termination of uncooperative code.

## CLI and existing target ownership

New cli/model-prune.ts exposes registerModelPrune(program,context). Leader owns program.ts registration and injects a database callback bound to ONE resolved existing --database/--path target per invocation; use existing withDatabase for owned ORM cleanup. Callback must verify SQLite target is an existing regular single-link nonsymlink file before opening in BOTH modes; reject missing files/:memory: without creating target directories/files. Server connections use existing explicit settings/TLS; no live support inferred from local tests. Path/tree checks are not atomic against hostile concurrent replacements.

`model:prune [--model <comma-separated registered names>] [--pretend] [--chunk <1..1000>] [--limit <1..10000>]`.

Every nonpreview invocation requires global --force before source import/target resolution/ORM open, even outside production. Preview needs no force, only counts and performs no framework deletion; trusted source/providers/native filters retain ordinary side effects. No interactive default, generator or new stub. Validate selectors/bounds/force before loading source or opening DB; sanitize source/driver/predicate errors, propagate cooperative signal and owned cleanup. Selected connection settings resolve once and pass unchanged to withDatabase. JSON result contains only above metadata. Missing/unconfigured source refuses, not silently succeeds.

## Verification and review

TaskAQ owns definitions/native consumer and adjacent tests; TaskAR leader owns CLI/registration/actual consumers/docs/source/graph/inventory. Each starts from observed missing API/entrypoint red before production changes; later coverage is labelled honestly.

Required real SQLite tests: branded definitions/snapshot/getter/symbol/dense/duplicate limits; invalid input before callbacks/open; source bounds/link/root/ESM lifetime/cancellation/error confidentiality; default/custom model eligibility and native filters; more than one chunk, primary field mapping, per-rule cap, selected models, empty explicit registry; preview rows unchanged; caller pending state preserved; native delete semantics/relationships; transaction failure and cancellation before commit rolls back active chunk, earlier committed chunks persist; after-await abort must not report successful completion; missing/composite/unmapped/invalid predicate refusals. Do not fabricate external driver verification.

Actual entrypoint tests must configure only disposable existing SQLite, seed eligible/protected rows, run preview/force/scope/chunk/limit paths and reopen to verify persistence and foreign/unselected preservation. Missing force/invalid options/source failures/missing SQLite must not create DB state. Test custom registration, aliases and configured named target, generic errors, signals/cleanup and no root default DB. Independent review + reproduce/fix/re-review + full suite/types/graph/whitespace/historical180 audit precede single original model-prune credit. Existing database and expanded live-server references remain partial; full100%goal remains unfinished.
