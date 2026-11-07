# Explicit isolated SQLite test databases

```sh
bun run bundle test --parallel --isolated-databases
bun run bundle test --parallel --processes 4 --isolated-databases ./tests/Feature
```

`--isolated-databases` requires `--parallel`. Ordinary test runs and `--parallel` without this explicit flag retain the existing Bun behavior. Worker count remains native (default2, explicit1–16); file patterns, name filters and Bun text coverage are forwarded. This mode is Linux-only because cleanup ownership checks use `/proc/<pid>/stat` process-start identities.

## What it does

The parent creates a mode0700 private `.bundle-test-databases/run-*` and an exclusive mode0600 manifest containing only the canonical project root and a random ownership token. Bun's real parallel workers each execute a fixed shipped preload before test files. The preload validates that run record, reserves its actual PID-specific directory/SQLite file and migrates it with the existing SQLite migration modules. No worker ID/environment variable is assumed; concurrent tests show distinct PIDs and distinct database paths. `snapshot:false`/`snapshotOnMigrate:false` avoid generating framework snapshots beside application migration source. Framework setup never opens, copies, truncates or resets the configured application database; the child environment is replaced with a test-only SQLite selection and empty named connections.

Global `--database`, `--path` and `--realpath` selections are refused rather than silently ignored. PostgreSQL/MariaDB server fixtures are not created, downloaded, reset or implied. Application tests still own external ports/files/services and must clean their own fixtures.

## Failure, cancellation and cleanup

SIGINT/SIGTERM from the real CLI runner cooperatively abort this operation; it signals the owned native Bun test process group only while the original group leader's PID, parent, start identity and group still match, and escalates only after rechecking that identity. If the leader has exited, remaining same-group members are not signalled through a potentially reused numeric PGID. Recorded workers are verified against the owned parent and Linux process-start identities. Before deletion, a Linux `/proc/<pid>/stat` ancestry watcher records descendants of the owned native test process, including children that detach into another process group; any recorded descendant still alive under the same PID/start identity keeps the private run preserved. Owned output readers are drained/cancelled within bounds. Setup failure is nonzero and test bodies do not run if the preload fails. Unknown metadata, changed run identity, still-live/unverifiable workers, environment-marked descendants, or cleanup uncertainty preserves the private run for inspection rather than deleting possibly active state. The empty `.bundle-test-databases` parent may remain.

No test code is sandboxed: trusted tests can explicitly open other databases, print secrets, alter filesystem state or launch descendants. The worker preloader only makes its default `process.env` select the owned per-worker SQLite database; it is not a security boundary. Cleanup observes descendants while they remain in the owned process tree and preserves files if a recorded child is still alive, including ordinary detached descendants. A hostile test can exit between observations or otherwise escape tracking, so this is not universal process-tree containment. No test transaction, rollback of arbitrary side effects, exact-once behavior or server-driver support is claimed. A crashed host may leave private state requiring manual inspection; no automatic stale-run scavenger is provided.

Verification uses new disposable roots, concurrent writes of the same logical row, distinct worker/PID paths, migration snapshot-source byte comparisons, sentinel application DB preservation, setup failure, filters, actual CLI entrypoint, Unicode/space roots and owned cancellation. No current user application database is touched.
