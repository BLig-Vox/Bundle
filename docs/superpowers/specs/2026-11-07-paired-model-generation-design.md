# Paired native model generation

## Scope

Extend the existing `make:model <Name>` with `-f, --factory`, composable with existing `-s, --seed` and `-m, --migration`. Use the existing code-first MikroORM model/seeder source and consumed `factory.ts.stub`; emit `database/factories/<Name>Factory.ts` importing `src/models/<Name>.ts`. No new dependency, database adapter, authentication or service is implied.

## Planning and publication

Render and validate all selected code outputs before creating files/directories: model, optional named seeder and optional factory. Check existing destination ancestors for symlinks/non-directories and refuse any existing destination, including dangling links, even with force. Invalid names, built-in scalar model names, malformed factory stubs and selected-output conflicts must leave all code destinations untouched. Root aliases can resolve canonically. No application model imports during planning.

Use the shared exclusive no-follow scaffold writer. Predictable failures precede publication; later I/O/cancellation or concurrent collisions may leave earlier new files. Do not claim a multi-file transaction or remove outputs on failure. Trusted trees must not be concurrently replaced by hostile processes.

Migration behavior retains existing production force guard and model-diff baseline checks before code generation. After code outputs are created, native migration generation discovers the new model. Migration I/O/runtime failure can leave those code files; no precomputed migration filename/transaction guarantee is implied. No automatic migration application or seeding occurs.

## Verification

Observe missing `--factory` red through the real CLI builder. Test model/factory/seeder composition, short aliases, every selected-file collision preserving all other outputs, invalid names and scalar names, malformed consumed custom factory stub, symlink parents/dangling targets and no database creation without `-m`. Consume generated native Factory with disposable SQLite metadata/schema and create persisted entities. Test full model/migration/factory/seeder path in a disposable project/migration root, without touching actual application databases or repository migration snapshots. Full suite, types, graph/provenance and whitespace gates precede any compatibility credit.
