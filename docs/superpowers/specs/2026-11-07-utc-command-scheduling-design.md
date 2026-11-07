# Bounded UTC command scheduling

## Direction

Next local slice under the standing implementation directive. Implement real local command scheduling, not queue aliases or no-op control commands. Leader-selected first contract is UTC-only minute cron; reject unsupported timezones rather than claim DST behavior. Alternatives were package-based timezone cron (needs dependency authorization) or Intl-based local-time matching (requires a separately specified DST contract). Neither is needed for this first bounded scheduler. No new packages/network/ORM.

## Definitions and deterministic matching

Create `src/schedule/definitions.ts` and `cron.ts`. Export `ScheduleDefinition {id:string; argv:readonly string[]; expression:string; timezone?:"UTC"; overlap?:"skip"|"allow"}`; normalized definitions always have timezone UTC and overlap skip by default. `defineSchedules(input:readonly ScheduleDefinition[]):readonly ScheduleDefinition[]` validates/copies/freezes all data, at most128 tasks, unique stable ids matching `[A-Za-z][A-Za-z0-9_.:-]{0,127}`. Closed plain own-data shapes, dense arrays, no getters/symbols/unknown fields or lossy Unicode. Each argv1..128 strings, each≤4096 UTF-16 units, no NUL, first token bounded128 matches a Bundle command identity, total JSON descriptor≤64KiB and whole definitions≤1MiB. Validate before any state/execution.

`loadSchedules(root:string):Promise<readonly ScheduleDefinition[]>` canonicalizes explicit absolute root, reads trusted root `schedule.ts` default export, validates source regular/single-link/no symlink and≤1MiB before fixed URL import, absent source→empty. Use ordinary Bun ESM caching, no managed reload. Import/dependencies remain trusted executable code and can have arbitrary side effects; direct import cooperative cancellation limits explicit. Sanitize file/import errors.

`compileCron(expression:string)` returns an immutable compiled matcher; `isCronDue(compiled, at:Date):boolean` rejects invalid/nonfinite Date. Exactly five fields minute0..59/hour0..23/day1..31/month1..12/weekday0..6 (Sunday0;7 refused). Expression≤128 ASCII bytes, whitespace-separated. Supported components `*`, integer, ascending inclusive range, comma union and positive `/step` on wildcard/range only. Reject empty/repeated separators, named months/days, macros, seconds, decimals, signs and invalid bounds/zero steps. For traditional cron day-of-month and weekday: if both fields are restricted use OR; if either is exactly wildcard the other controls; months/hours/minutes always AND. Pin semantics of wildcard steps explicitly: only literal `*` counts as unrestricted, so `*/2` is restricted. Compare UTC fields at the selected minute; seconds do not affect matching. No timers or current-clock reads in parser.

## Consuming runtime (subsequent lane)

`src/schedule/runner.ts` will consume definitions, evaluate one UTC minute and execute explicit argv through real rooted runCli with fresh scopes and handleSignals:false. Default overlap skip uses existing owned local acquireCommandLock keyed by scheduler task id; contention visible, release finally, no auto stale expiry/multi-host claim. Preabort invokes nothing; active command cancellation remains cooperative. Result per task carries id/outcome/exitCode, no sensitive argv output by default. Nonzero task status fails the run; errors sanitized. No shell/network or queue.

`src/cli/schedule.ts` later registers only actual `schedule:list --json`, `schedule:run --at <UTC ISO>` and finite/signal-aware `schedule:work` when the consumer exists. Work must deduplicate absolute minute slots within the process and avoid overlap with its own active command; no missed-minute backfill/persistent exactly-once claim. At this stage no fake schedule:interrupt/pause/resume/clear-cache/finish/test. Do not register anything until actual entry-point tests are red and runtime exists. No inventory credit for parser alone.

## Gates

Unique disposable fixtures only. Deterministic cron/calendar/invalid-field tests; copied shape/argv/duplicate/limit tests and unsafe/absent/canonical-source/import-error tests. Actual separate-process scheduled custom commands, lock contention, failure/cancellation and work cycles required before schedule capability credit. Independent review and fresh full tests/types/graph/source evidence remain mandatory. External timezone/DST, durable controls, service supervision and crash lock recovery remain explicit future work.
