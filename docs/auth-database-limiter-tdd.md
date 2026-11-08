# Generated persistent SQL auth limiter

**Current policy:** see the [strict rolling-window milestone](#strict-rolling-window-milestone-2026-11-08) below. Earlier fixed-window and multi-driver sections are historical evidence; the current bundled adapter supports SQLite only.

Generated apps include `src/auth-attempt-limiter.ts`, `src/models/AuthAttemptBucket.ts` and real database integration tests. The factory is `createDatabaseAuthAttemptLimiter(env)`. The stock `src/web/routes.ts` is unchanged: production still rejects absent/process-scoped limiters. App authors must migrate the model and explicitly inject the factory using a fixed static import. Exact commands, configuration, injection example and operational limitations are in the [generated app guide](../templates/app/README.md.tpl#limiter-injection-before-deployment).

## RED before implementation

The first change added one generated-app integration test to `templates/app/src/auth.test.ts.tpl`: `persistent SQL limiter coordinates independent factories against one migrated database`. It creates an isolated real SQLite database with the existing CLI migration flow, dynamically imports the missing adapter, alternates admissions between independently constructed factories, asserts the shared 20-attempt window and bounded retry delay, checks HTTP 429/Retry-After/no-store, and inspects the singleton row for bounded storage without identity data.

It was generated and run **before adding the adapter or model**:

```sh
cd /tmp/bundle-sql-red/example
bun test ./src/auth.test.ts --test-name-pattern 'persistent SQL limiter'
```

`/tmp/bundle-sql-red.log` records **0 pass, 1 fail**, with `Cannot find module './auth-attempt-limiter.ts'`. The original RED fixture remains available separately from the GREEN fixture. No fake shared implementation was introduced to satisfy this test.

## Implementation and GREEN

The adapter uses the existing app `withDatabase` lifecycle and DB configuration. In a transaction it conflict-safely inserts `id = 1`, locks the row, reads the database wall clock after lock acquisition, then checks/updates the fixed window before commit. SQLite's first insert takes a write reservation even when its conflict does nothing; PostgreSQL/MariaDB use explicit `FOR UPDATE`. MariaDB-generated DDL uses InnoDB. SQLite busy errors roll back before a bounded asynchronous retry, avoiding native synchronous busy waits that could block a concurrent local request from committing. Provider/SQL/state/commit failures propagate; auth returns generic 500 and does not process credentials. There is no fallback or request-time schema creation.

The model has only `id`, `attempts`, `expires_at`. Its checks constrain the ID to 1 and count to 0–20. Expiry reuses the same row, and denials neither extend expiry nor grow state. Windows use the database clock and survive independent factory construction and process exit/restart. No request identity, credentials, IPs or history are stored. This is a global fixed window, with the usual adjacent-window burst limitation; deleting/restoring/resetting DB state affects the limiter. See the guide for clock, filesystem, replica, timeout, throughput and policy limits.

Additional generated tests cover:

- 32 concurrent independently constructed SQLite factories on a cold bucket, exactly 20 admissions, bounded denials, unchanged state on repeated denial, expiry reset, singleton/count constraints.
- Four concurrent independent Bun processes consuming eight attempts each; exactly 20 admissions, then a fresh process observes the same exhausted window and expiry after all workers exit.
- Missing migration, inaccessible SQLite path, and a real SQLite trigger that aborts updates: failures reject, admissions roll back and persisted state is unchanged.
- Real SQL factory injection into production route factories under both production flags, shared login/register accounting, and Origin rejection before bucket creation.
- All three real ORM drivers generating singleton/check DDL offline and formatting bound updates, plus dialect-specific conflict/locking/clock SQL. These checks do not establish live server behavior.
- Opt-in PostgreSQL/MariaDB migrated concurrency and fresh-process persistence tests. They require separate empty disposable databases and explicit reset authorization via environment variables; see the guide. **No live PostgreSQL/MariaDB URLs were supplied; both live tests were skipped and remain unverified.**

Focused GREEN:

```sh
cd /tmp/bundle-sql-green/example
bun test ./src/auth.test.ts ./src/auth-attempt-limiter.test.ts
bun run typecheck
```

`/tmp/bundle-sql-green.log`: **29 passed, 2 live-server skips, 0 failed, 620 assertions**. `/tmp/bundle-sql-types.log`: generated client/node/server strict TypeScript passed.

## Full verification

- `bun test`: **245 passed, 3 skipped, 0 failed, 9,544 assertions**, across 25 files. Skips: live PostgreSQL/MariaDB framework persistence and the opt-in generated-dev socket integration.
- `bun run typecheck`, `bunx --no-install tsc --noEmit --strict`, `bun run graph:check`, and `git diff --check`: passed. The generated app additionally verifies the SQL limiter's DDL/query formatting on SQLite, PostgreSQL and MariaDB ORM platforms; live server behavior for PostgreSQL/MariaDB remains unverified.
- Generated-app full acceptance **passed**: **47 app tests, 2 live PostgreSQL/MariaDB skips / 5,101 assertions**, **2 resource tests / 78 assertions**, and **2 rendered/React DOM tests / 1,210 assertions**; client/node/server typechecks, production builds, generated request inference, CLI migrations/seeds, model persistence and auth/session/password/Notes/resource workflows passed. SQLite limiter concurrency passed across independent factories and real child processes with persisted state after process exit.
- A fresh generated app installed **110 packages offline** from the populated local Bun cache with no registry/network access; typecheck, tests, builds and SQLite acceptance passed. This confirms installation from that existing cache, not an uncached registry fetch.
- Real headless Firefox/HTTP acceptance **passed** after the offline install and DOM suite. It exercised session listing/revocation, password lifecycle, login/register, Notes, Task CRUD, owner isolation, refresh, HTTP-only cookies and logout. React emitted `act(...)` warnings during async DOM checks; the dev child exited with code 143 during expected cleanup.

Reproduce acceptance (the linked and offline-install runs use these host-specific paths):

```sh
BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-request-acceptance-s8UVwY/example/node_modules \
BUNDLE_ACCEPTANCE_DOM_MODULE=/root/.hermes/hermes-agent/node_modules/jsdom/lib/api.js \
bun run scripts/verify-app.ts
```

Add `BUNDLE_ACCEPTANCE_FIREFOX=1` in an environment permitting loopback listeners. For a fresh offline install, omit `BUNDLE_ACCEPTANCE_NODE_MODULES` and use a populated cache:

```sh
BUN_INSTALL_CACHE_DIR=/path/to/populated/bun-cache \
BUNDLE_INSTALL_OFFLINE=1 \
BUNDLE_ACCEPTANCE_DOM_MODULE=/path/to/jsdom/lib/api.js \
BUNDLE_ACCEPTANCE_FIREFOX=1 \
bun run scripts/verify-app.ts
```

`BUNDLE_INSTALL_OFFLINE=1` forbids registry/network access; this does not verify an uncached online install.

No packages, commits or pushes were added. Existing working-tree changes were preserved.

## Review fix: PostgreSQL URL schema qualification (2026-11-08)

Before changing the adapter, added offline generated-app regression tests to
`templates/app/src/auth-attempt-limiter.test.ts.tpl`. They construct the real
factory from a static PostgreSQL `DATABASE_URL` and check the SQL plan for both
`tenant_a` and the valid identifier `Tenant"a;--`: insert, `FOR UPDATE` lock and
bound update must all address the same quoted schema. Empty/NUL/overlong schemas
must reject synchronously before connecting; malformed URLs, wrong protocols
and repeated schema options must also reject.

Generated `/tmp/bundle-limiter-schema-red/example` with the unchanged adapter,
using existing linked dependencies (no install or network):

```sh
cd /tmp/bundle-limiter-schema-red/example
bun test ./src/auth-attempt-limiter.test.ts --test-name-pattern 'PostgreSQL.*(URL schema|rejects)'
```

`/tmp/bundle-limiter-schema-red.log`: **0 passed, 3 failed**. Both identifier cases
failed with an expected schema-qualified insert versus the actual unqualified
insert; the invalid-schema case failed because the factory accepted an empty
schema. This RED preceded the implementation.

The adapter now validates the static URL through `databaseSettings`, quotes the
schema as a single identifier by doubling embedded double quotes, and builds all
three statements with the same table reference. The factory snapshots configuration
and selects the plan once, then uses `sql.update` in the existing transaction.
No request-derived identifiers, schema discovery, connection search-path changes,
or transaction/retry/clock changes were introduced. SQLite/MariaDB SQL remains
unchanged, with the update now included in the plan and checked by offline tests.

An additional formatter inspection found that MikroORM substitutes `?` even inside
quoted identifiers when binding updates. Added `tenant?` to rejection coverage
and ran it before adding the guard: `/tmp/bundle-limiter-schema-placeholder-red.log`
records **0 passed, 1 failed**, because the factory accepted that schema. The
factory now rejects `?` as well as empty/NUL/over-63-byte names. Byte-length coverage
includes multibyte names. The generated guide documents these rules and its fixed
production guidance now matches `productionLimiterError` verbatim.

Final verification, in `/tmp/bundle-limiter-schema-green/example`:

```sh
bun test ./src/auth-attempt-limiter.test.ts --test-name-pattern 'PostgreSQL.*(URL schema|rejects)'
bun test ./src/auth.test.ts ./src/auth-attempt-limiter.test.ts
bun run typecheck
```

- `/tmp/bundle-limiter-schema-green.log`: **3 passed, 0 failed, 23 assertions**;
  offline real PostgreSQL platform formatting preserves the quoted identifiers
  and binds both update values correctly.
- `/tmp/bundle-limiter-schema-tests.log`: **32 passed, 2 skipped, 0 failed,
  646 assertions**. Includes all three offline ORM singleton schema/SQL tests,
  SQLite factory/process concurrency, restart persistence, rollback/fail-closed
  behavior, and real auth route injection. The two live PostgreSQL/MariaDB tests
  remain unverified because no server URLs were provided.
- `/tmp/bundle-limiter-schema-types.log`: generated client/node/server typechecks
  passed.
- Framework `bun test ./src/cli/apps.test.ts`: **11 passed, 0 failed,
  183 assertions**, recorded in `/tmp/bundle-limiter-schema-packaging.log`.
- `git diff --check`: passed. Other pre-existing working-tree changes were
  preserved; no commits or pushes.


## Strict rolling-window milestone (2026-11-08)

The fixed-window counter could admit twenty new attempts immediately after a window holding twenty expired. The first change in this milestone added `SQLite strict rolling window admits at most 20 across a real 60-second boundary` to the generated limiter tests. It uses a real isolated SQLite database, CLI-generated/applied migrations, real independent factories and SQL database time; no provider stub, fake implementation, injected clock or modified timestamp rows. It admits one request, waits 1.5 seconds, admits nineteen, denies the twenty-first, waits until just after the first admission's sixty-second boundary, and requires exactly one of twenty further requests to pass while the other nineteen original admissions remain active.

Strict RED ran before any adapter/model edits:

```sh
bun /tmp/bundle-rolling-red-setup.ts
cd /tmp/bundle-rolling-red/example
bun test ./src/auth-attempt-limiter.test.ts --test-name-pattern 'strict rolling window'
```

`/tmp/bundle-rolling-red.log`: **0 pass, 1 fail, 23 assertions**, 60.40 seconds. Expected one new admission, received twenty. The RED fixture is preserved separately from GREEN.

The implementation replaces the count/expiry with one singleton containing exactly twenty ordered, nonnegative integer epoch-millisecond slots. Every admitted request discards the oldest slot and appends DB time. Only the latest twenty admissions are needed: if the oldest is still inside the interval, admission would exceed twenty; otherwise all previously discarded admissions are outside it too. Required integer fields and portable CHECK constraints enforce ID 1, safe bounds and ordering. SQLite can store fractional values in integer-affinity columns; runtime safe-integer validation enforces slot types and also fails closed if constraints were bypassed externally. No identities, request data, dependencies or unbounded history are added.

SQLite's conflict-safe insert remains the transaction's first statement, acquiring the write reservation on cold and existing rows. Row/clock reads and the bound update occur under that reservation; results return after commit. Bounded busy rollback/retry remains unchanged. Independent-process tests retain exactly twenty total admissions and a fresh process still sees denial after every worker exits. SQL/update/provider errors reject and leave stored state unchanged. The production gate and explicit static injection requirement remain intact.

Admission requires the oldest nonzero slot to be **strictly more than 60,001 database milliseconds old**. SQLite's rounded millisecond clock and floating-point conversion get a conservative one-millisecond margin; exact cutoff equality denies. Retry-After rounds up through the next admissible millisecond (maximum 61 seconds). Backward clock changes clamp to the newest timestamp, keeping ordering and conservatively delaying admissions. Forward clock jumps can advance expiry: guarantees require stable database time, not a monotonic physical-clock claim. Denial does not extend timestamps.

The adapter now **refuses PostgreSQL/MariaDB and other drivers before connecting**; old offline SQL formatting tests did not establish live constraint/atomicity correctness. Replaced those plans/tests with explicit refusal coverage. The generated model uses portable bounded-comparison checks and remains in normal server-driver model discovery and migrations. This model portability does not enable the SQLite-only limiter on server drivers. The rest of Bundle's database driver support is unchanged. The generated guide explains bounded row size, twenty-column write costs, global writer contention, per-call connection costs, clock limits and conservative migration from old counter state. An old schema fails closed; no automatic conversion/reset occurs.

First GREEN:

```sh
bun /tmp/bundle-rolling-green-setup.ts
cd /tmp/bundle-rolling-green/example
bun test ./src/auth.test.ts ./src/auth-attempt-limiter.test.ts
bun run typecheck
bun run build
```

`/tmp/bundle-rolling-green.log`: **28 pass, 0 fail, 625 assertions**, including the identical real boundary regression (**60.21 seconds**). Client/node/server typechecks and production build passed (`/tmp/bundle-rolling-types.log`, `/tmp/bundle-rolling-build.log`). Added tests for individual expired-slot reuse while retaining newer timestamps, process-time independence, and externally corrupted state: `/tmp/bundle-rolling-extra.log`, **2 pass, 0 fail, 24 assertions**. Concurrent factory tests verify denial immutability, singleton, negative/text/NULL/unsafe timestamp constraints, ordering and fixed column count. Fractional slot rejection is enforced by runtime state validation (see the portability fix below). These additional tests exercise existing requirements after the primary RED→GREEN.

The real-clock regression makes the generated child suite take over a minute. Increased its framework parent test budget from 30 to 120 seconds and acceptance's test subprocess budget from 45 to 120 seconds. The first full-framework attempt failed at the old parent timeout, recorded in `/tmp/bundle-rolling-framework.log`; this was not an admission-policy failure.

Fresh offline install was attempted with `BUN_INSTALL_CACHE_DIR=/tmp/bundle-sql-install-cache BUNDLE_INSTALL_OFFLINE=1`. It **failed** because the available cache lacks package manifests (`/tmp/bundle-rolling-offline.log`). No registry fallback was used and fresh installation is not claimed for this milestone. Generated acceptance instead reuses the pre-existing installed app dependencies.

Final verification:

- `/tmp/bundle-rolling-framework-final.log`: **243 pass, 5 skip, 0 fail; 9,528 assertions** across 25 files, 93.72 seconds. The parent now successfully runs the complete generated backend suite, including the minute-long rolling regression. Skips are opt-in dev integration, two loopback-listener tests denied by this sandbox, and live PostgreSQL/MariaDB framework persistence.
- `/tmp/bundle-rolling-framework-types.log`, `/tmp/bundle-rolling-strict.log`, `/tmp/bundle-rolling-graph.log`: `bun run typecheck`, `bunx --no-install tsc --noEmit --strict`, and `bun run graph:check` passed (404 nodes / 428 edges). `git diff --check` passed.
- `/tmp/bundle-rolling-acceptance.log`: linked-dependency generated acceptance passed **48 app tests / 5,130 assertions**, **2 resource tests / 78 assertions**, and **2 rendered/React DOM tests / 1,210 assertions**. Includes all 30 final auth/limiter tests, real rolling boundary, independent-process concurrency/restart persistence, individual expiry and corrupt-state checks. Client/node/server strict typechecks, production builds, CLI migrations/seeds, model persistence, request inference and auth/session/password/Notes/resource workflows passed.
- The same acceptance command explicitly requested Firefox, but **Firefox did not launch**: sandbox `EPERM` denied `Bun.serve` when reserving loopback ports. The overall command therefore exited nonzero after all preceding stages passed; browser/HTTP acceptance is **not verified** in this milestone. React DOM emitted existing `act(...)` warnings.

Reproduce the linked acceptance attempt (paths are host-specific):

```sh
BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-request-acceptance-s8UVwY/example/node_modules \
BUNDLE_ACCEPTANCE_DOM_MODULE=/root/.hermes/hermes-agent/node_modules/jsdom/lib/api.js \
BUNDLE_ACCEPTANCE_FIREFOX=1 \
bun run scripts/verify-app.ts
```

Omit the Firefox flag where loopback is prohibited. This reuses installed dependencies and does not establish fresh installation. Offline installation and Firefox limitations above supersede historical successful runs for purposes of this milestone. Existing working-tree work was preserved. No dependencies, commits or pushes were added. This change does not establish production auth readiness.


## Rolling model portability fix (2026-11-08)

This is a bounded follow-up to the rolling-window milestone. The model remains in
normal app model discovery for SQLite, PostgreSQL and MariaDB; only the bundled
limiter is SQLite-only. No server-driver migration exclusion is required.

Before changing the model, added generated tests that use `withDatabase` with
`connect: false` and the real PostgreSQL/MariaDB ORM schema generators. They
inspect both CREATE TABLE and ALTER TABLE statements for `auth_attempt_bucket`,
require singleton, all twenty bounded comparisons and ordering checks, and reject
`typeof()`. No server, mock ORM, package install or network is used.

```sh
bun test /tmp/bundle-portability-red/example/src/auth-attempt-limiter.test.ts \
  --test-name-pattern 'portable auth bucket'
```

`/tmp/bundle-portability-red.log`: **0 passed, 2 failed** on the generated SQLite
`typeof()` expressions, before the model edit. The separate RED fixture retains
the original model. The model now uses only `slot_N >= 0 and slot_N <=
9007199254740991`, preserving the singleton and ordering checks. The adapter,
transaction/retry/clock algorithm, runtime safe-integer validation and production
gate are unchanged.

The SQLite corrupt-state regression now covers negative, fractional and text
slots written with `pragma ignore_check_constraints = on`. Each case verifies
the corrupt value actually persisted, then requires consumption to reject with
`Invalid auth limiter database state` and leave the row unchanged. Portable
comparisons do not enforce SQLite integer storage; runtime validation does.
`/tmp/bundle-portability-green.log`: **5 passed, 0 failed, 135 assertions** for
the two offline schema tests and three corruption cases.

Final verification (existing linked dependencies; no installation):

- `/tmp/bundle-portability-focused.log`: generated auth/limiter suite **34 passed,
  0 failed, 781 assertions**, including the real sixty-second rolling regression,
  independent factories/processes, restart persistence and fail-closed routes.
- `/tmp/bundle-portability-app-types.log`: generated client/node/server typechecks
  passed. `/tmp/bundle-portability-migration.log`: generated and applied the app's
  SQLite migration through the CLI; status shows one executed and none pending.
- `/tmp/bundle-portability-framework.log`: full framework suite **243 passed,
  5 skipped, 0 failed, 9,528 assertions** across 25 files (95.28 seconds). Skips:
  opt-in dev integration, two sandbox-denied loopback tests and two opt-in live
  server persistence tests. PostgreSQL/MariaDB DDL is verified offline here;
  live server behavior is not claimed.
- `/tmp/bundle-portability-framework-types.log`, `/tmp/bundle-portability-strict.log`
  and `/tmp/bundle-portability-graph.log`: framework typecheck, strict TypeScript
  and graph check passed (404 nodes / 428 edges). `git diff --check` passed.

Generated deployment docs and the repository README now distinguish the portable
model from the SQLite-only limiter. Existing working-tree changes were preserved;
no packages, commits or pushes were added.
