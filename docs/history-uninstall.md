# Verified SQLite migration-history uninstall

`migrate:uninstall` removes **only** a conservatively verified native migration tracking table. It does not roll back migrations, remove application tables or rows, erase migration files/snapshots, drop schemas, or unlock migrations. Removing tracking loses knowledge of applied migrations; a later migration application can attempt to recreate existing schema. Review the target and preserve backups before using it.

```sh
bun run bundle migrate:uninstall --pretend
bun run bundle --force migrate:uninstall
bun run bundle --database archive --force migrate:uninstall
```

Every real invocation requires global `--force` before resolving/opening the target, including outside production. Preview does not require force and does not initialize history. `--isolated`, `--graceful` and `--cascade` are not supported: failures must remain failures and this command never creates a lock or cascades dependency deletion.

## Deliberate SQLite-only support

Both modes require an existing regular single-link nonsymlink SQLite file. Missing files, `:memory:`, directories, symlinks and hardlinks refuse without creating storage. Named connections resolve once and retain existing target/path settings. Non-SQLite connections are refused before CLI database open; there is no destructive PostgreSQL/MariaDB support claim from local tests.

The configured history name is platform-quoted and must not collide with a mapped entity or the separate migration lock table. The backend inspects SQLite native schema in an owned transaction without calling history-creation APIs. It accepts only the exact locally verified native id/name/executed_at layout, with optional Bundle batch column and known defaults/constraints. Conservative refusal of otherwise compatible alternate DDL is intentional.

The operation refuses:

- Views or altered/unrecognized history layouts, extra/missing columns, unexpected indexes or constraints.
- Triggers on history, detected dependent views/triggers, or inbound foreign keys from other tables.
- Any row in the existing migration lock table, or an unsafe lock object.
- Unsupported platform/schema, mapped-name collision, invalid options or observed cancellation.

The command preserves unsafe/foreign state for inspection; it never disables foreign keys or uses `CASCADE`. An existing empty lock table remains intact; a missing lock table is not created. The view/trigger dependency check is deliberately conservative textual matching, not a general SQL dependency parser. Path/schema preflight is not protection against hostile concurrent replacement. Concurrent clients that do not honor migration isolation and concurrent DDL remain outside a global coordination guarantee.

## Results and lifecycle

Results contain only:

```ts
{ pretend: boolean, installed: boolean, removed: boolean }
```

`installed: false, removed: false` reports an absent tracking table truthfully, not a completed deletion. Preview of valid existing history reports installed true, removed false. Real successful removal reports installed true, removed true.

`uninstallMigrationHistory(orm, {force?,pretend?,signal?})` uses its own native manager fork and transaction, clears only that fork, and never flushes/clears the supplied manager or closes the caller's ORM. CLI ownership wraps database open/close and emits a result only after cleanup. A cancellation observed after the drop query but before transaction completion rolls back that active transaction. Cancellation after commit cannot undo completed removal; generic diagnostics therefore advise inspecting actual tracking state.

Native migrator storage can cache table existence. Do not assume reinstall works in the same ORM instance after removal. The real CLI closes its owned ORM, and a **fresh process** can run `migrate:install` to recreate empty tracking without applying migrations. This does not recover lost migration records.

## Verification status and authorization

Implementation/testing was initially permission-blocked. The user explicitly approved deleting `mikro_orm_migrations` only in newly created disposable test databases, never existing application databases. Development tests remained within that scope; no existing application database was accessed for deletion.

Observed unknown-command and missing-API reds preceded implementation. Actual default/named disposable SQLite consumers migrate/seed, preview/refuse/remove/reopen/reinstall and verify application rows, unrelated tables/views, lock table and migration source/snapshot bytes remain unchanged. Focused refusal tests cover missing/linked/unsupported targets and options. A mapped-entity collision regression failed before replacing incorrect Object.values(Map) metadata enumeration with native Map values; it now refuses before deletion. Additional native tests cover unsafe schema/dependencies/locks, cancellation rollback and unsupported-platform refusal without connecting. Independent review accepted the metadata Map.values repair and explicit main-schema lock lookup. A non-deleting query-trace regression verifies the qualified lock read and that an active lock issues no DROP; the reviewer's denied end-to-end shadowing/drop probe was not rerun by the leader or another worker. The first whole-suite run exposed test snapshot contamination from using project migration paths with an in-memory database; tests now use disposable migration roots and guard project snapshot bytes. The newly generated untracked snapshot was preserved outside the project. Focused migration tests/types pass. Repaired combined pre-ledger full verification passed 923 tests with 2 opt-in live-database skips, 0 failures and 18,869 assertions across 98 files; strict types passed in 198 files. Source/inventory reconciliation credits only this explicit SQLite equivalent. Final post-provenance verification passed 923 tests with 2 opt-in live-database skips, 0 failures and 19,214 assertions across 98 files; strict types, graph freshness, whitespace and historical180 provenance passed. No unexpected project migration snapshot was regenerated. No full Laravel command/flag parity or live-server evidence is implied.
