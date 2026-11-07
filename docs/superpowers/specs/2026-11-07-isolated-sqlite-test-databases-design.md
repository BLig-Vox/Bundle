# Explicit native parallel SQLite test databases (queued design)

## Goal and evidence precondition

Close a concrete remaining native-test gap without touching existing application databases or requiring blocked server provisioning. Add an explicitly selected SQLite test-database setup mode; ordinary bundle test/--parallel remains unchanged. First probe and prove Bun1.4.4 native --preload execution in real parallel children using only private marker fixtures. Do not invent a worker environment variable or assume parent/worker preload ordering. If a reliable owned per-process setup contract cannot be established, keep this slice pending rather than fake isolation.

## Proposed bounded contract

`bundle test --parallel --isolated-databases [files...]` explicitly creates NEW private disposable SQLite state for native test processes using the real MikroORM model/migration baseline. No existing application DB is opened/reset/copied, no seed/service/download or server credentials are created. SQLite-only: refuse a selected nonSQLite connection or unsupported setup before provisioning. Tests still isolate caches/files/external services themselves. No PostgreSQL/MariaDB or Laravel test runner claim from SQLite evidence.

Parent owns one unique checked private fixture directory, launches fixed trusted native test/setup code without shell/executable override and removes only that directory after owned children/streams settle. Test children receive explicit test-only database environment; named application records must not silently select production targets. Child setup chooses a unique per-process database identity (not an undocumented worker-ID assumption), prepares only that new SQLite database and closes the setup ORM before tests. Any migration snapshot/source output must target copied private migration sources, never repository migrations. Test commands/imports remain trusted and may deliberately access other resources; this is not a sandbox/security restriction on arbitrary test JavaScript.

Native Bun worker parent/preload behavior and cancellation ownership must be proven before choosing the implementation interface. Preserve current default raw test output/status, filters/coverage/native worker choices and actual SIGINT/SIGTERM handling. Markers/paths may be diagnostic metadata, not credential output. No global host environment/stdio/process.exitCode patches. Do not turn a setup failure into successful no-op provisioning. Crash residue is preserved for inspection rather than deleting an unverified path later.

## Verification gate

Missing option/API red, real two-process tests concurrently migrating/writing the same logical table/key without cross-worker collision, distinct new database paths and unchanged sentinel application database/source bytes. Default/no-flag behavior unchanged; setup/migration/import failure and cancellation reap only owned processes before verified fixture cleanup. Refuse unsafe parents/sources, links, unsupported driver/options and overwrite. Actual generated project/native test/typecheck consumers and full regression/review/provenance gates required. Keep existing partial classifications until every specifically claimed remaining requirement is backed; the separate external live-service blocker remains untouched.
