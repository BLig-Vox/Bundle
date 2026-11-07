# Bounded UTC command scheduling

This is a reviewed UTC-only local Bun scheduler contract, not complete Laravel scheduler parity.

Bundle schedules explicit command argv using a trusted code-first root `schedule.ts`. UTC-only minute resolution is deliberate: non-UTC zones are rejected, not silently interpreted in the host timezone. No cron service, queue, dependency, markup or external scheduler is required.

```ts
import { defineSchedules } from "./src/schedule/definitions.ts";

export default defineSchedules([
  { id: "daily-report", argv: ["report:daily", "literal argument"], expression: "30 12 * * *" },
]);
```

The target must be a real built-in or trusted custom command. No command existence preflight or automatic registration is provided; unknown commands fail when due. A descriptor cannot directly target `schedule:run`, `schedule:work` or `schedule:test`, because starting a fresh runner would reset recursion depth. Trusted custom commands can themselves recurse or do arbitrary work; this is not a sandbox.

```sh
bun run bundle schedule:list --json --at 2026-11-07T12:30:00Z
bun run bundle schedule:run --at 2026-11-07T12:30:00Z
bun run bundle schedule:work --sleep 1000 --max-cycles 3
```

## Definitions and matching

At most128 definitions, each with a unique bounded id, explicit1..128 argv entries, expression, optional `timezone:"UTC"` and optional `overlap:"skip"|"allow"`. Defaults are UTC and skip. Closed own-data shapes are copied/frozen; sparse/accessor/symbol/unknown shapes, NUL or malformed Unicode refuse. Args are bounded4096 UTF-16 units each; the first is a valid bounded Bundle command identity. Each normalized definition≤64KiB and complete definitions≤1MiB. Arguments may contain secrets and are not printed in default metadata; they remain present in trusted source and execution memory.

Five numeric cron fields: minute0–59, hour0–23, day1–31, month1–12 and weekday0–6 (Sunday0;7 unsupported). Supports wildcard, integer, inclusive ascending range, comma union and positive step on wildcard/range. No named fields, macros, seconds, integer-step shorthand or arbitrary timezone. Expression≤128 ASCII characters. Matching uses UTC date fields; seconds do not change the selected minute.

For day-of-month/weekday, when both are restricted, either match is sufficient (traditional cron OR). If either is literal `*`, the other controls. A stepped wildcard such as `*/2` counts as restricted. Months/hours/minutes always match together. Invalid bounds/zero steps/empty components refuse before execution. Unsupported calendar combinations simply are not due, never a fabricated next occurrence.

Trusted `schedule.ts` must be a regular single-link file≤1MiB, not a symlink. Absolute root aliases canonicalize. An absent schedule exports no work; unsafe/import-invalid source fails generically. Imports/dependencies remain executable application code. Fixed import URLs retain Bun's ordinary ESM cache; running work does not hot-reload changed source. Use a fresh process to load changes. CLI command discovery occurs before the schedule action and has its ordinary trusted-import limitations.

## Runtime behavior and limits

`schedule:list` evaluates metadata without invoking scheduled handlers. JSON contains id, expression, timezone, overlap and due status, never argv. No next-date computation is claimed.

`schedule:run` selects one absolute minute (current by default) and sequentially invokes due commands through real rooted `runCli`, with fresh service scopes, no shell, noninteractive prompts, discarded injected output/error, and `handleSignals:false`. Results contain id/outcome/conditional exitCode. Nonzero—including merely returned130/143—is failure. Actual cancellation skips later work and is not success. Trusted direct console/process/subprocess output is not comprehensively intercepted; do not run secret-printing commands expecting a sandbox.

`--at` accepts an exact UTC ISO timestamp ending `Z`, with seconds and optional1..3 fractional digits. Invalid calendar dates, local offsets and permissive platform date coercions are refused. Explicit repeated run invocations may repeat effects; there is no durable once-only record.

Default overlap skip acquires `acquireCommandLock(root,"schedule:<id>")`, releases its own identity in `finally`, and reports contention without executing. These are cooperative host-local non-expiring command locks, not a multi-host transaction or cache. A crashed owner requires inspection. No automatic stale deletion or `schedule:clear-cache` alias is provided. Opting into allow bypasses this lock.

`schedule:work` polls observed minutes; default1000ms, explicit positive max-cycles optional. It executes a minute only when newer than that process's high-water mark, preventing repeat ticks and backward-clock replay. Long commands/polls can skip minutes; there is no backfill, persistent restart deduplication or catch-up. Definitions are fixed for the process. It reports per-slot metadata and bounded final counts without accumulating an unbounded history. Max-cycles counts polls, not executed tasks. SIGINT/SIGTERM propagate cooperative cancellation and choose130/143; uncooperative imports/commands can prevent shutdown because no owned process termination boundary is claimed here.

Embedding `runCli(...,{handleSignals:false})` also disables scheduler-owned process-signal subscriptions; the embedding host can still supply an AbortSignal. Normal standalone CLI130/143 behavior is preserved.

Programmatic APIs are in `src/schedule/runner.ts`: `listSchedules(definitions,at)`, `runDueSchedules({root,env?,signal?,at?})`, and `workSchedules({root,env?,signal?,sleepMs?,maxCycles?,now?,onResult?})`. Clock/result callbacks are trusted and can fail; resulting errors are generic. Callback output may deliberately publish metadata only.

## Explicit and interactive task execution

```sh
bun run bundle schedule:test --task daily-report
bun run bundle schedule:test
```

This executes exactly one configured task **with real side effects**, even if its cron expression is not due. It is not a dry run. `--task` accepts an exact configured id; unknown/invalid/empty ids refuse without invoking a scheduled handler. Without it, the existing prompt adapter presents only ids, not argv or private arguments. A real terminal or explicitly injected host selection adapter is required; non-TTY input has no implicit default. Empty registries, cancellation after selection and adapter values absent from the registry refuse.

`runScheduledTask({root,id,env?,signal?})` validates the registry, baselines persisted state and reuses the ordinary command execution pipeline. Pause skips the selected task; held overlap locks skip rather than bypassing ownership; failure retains conditional command exit status; signals and graceful interrupt remain cooperative. The command does not unpause, edit source, advance a work consumer's high-water mark or provide a durable once-only record. Selected nested commands still receive noninteractive prompts and discarded injected I/O. Direct trusted output remains outside this suppression contract. Repeated invocations may repeat effects.

## Persisted pause, resume and graceful interrupt

```sh
bun run bundle schedule:pause
bun run bundle schedule:resume
bun run bundle schedule:interrupt
```

Private `.bundle-schedule/control.json` contains bounded strict version1 paused/generation state, independent of queues/ORM databases. The directory is owned0700, state owned0600 single-link regular JSON; mutation uses an owned nonexpiring lock and atomic publication. Ordinary replacement/first-publication reader races use bounded retries. Corrupt/unsafe state fails closed and stays for inspection; stale/foreign locks are not automatically removed. State is persistent across ordinary processes, not a power-loss/multi-host transactional durability guarantee or hostile concurrent tree-replacement defense.

An absent control uses a stable UUID generation sentinel. Pause/resume preserve it, including first publication; only interrupt chooses a new generation. This prevents an initial pause from accidentally terminating an already observing consumer. Controls affect the entire root scheduler, not selected task ids.

`runDueSchedules`/`workSchedules` baseline the current generation before trusted schedule source import and check state between command invocations and polling slots. A paused due task reports skipped-paused without its handler/overlap lock. Work continues observing while paused; resume permits future newly observed slots, not replay/backfill of a skipped minute. A new explicit schedule:run may intentionally execute that minute again, as before.

Interrupt is graceful: active trusted work settles before an observing run/work exits, no later task starts after the generation change is observed, and a replacement consumer baselines the latest generation. A finished command failure remains failure even when interruption follows. Results carry interrupted:true only when observed. This is not cancellation of an active/hung import/command, process-group termination, service self-respawn or an atomic freeze with a command claim; a state-read-to-invocation race remains. External SIGINT/SIGTERM retain their separate cooperative cancellation130/143 behavior.

Programmatic state APIs are `readScheduleControl(root)`, `pauseSchedule(root)`, `resumeSchedule(root)` and `interruptSchedule(root)` in `src/schedule/control.ts`. Read-before-import fail-closed checks do not sandbox normal CLI command discovery/import side effects.

Not implemented: timezone/DST scheduling, sub-minute tasks, background finish protocol, service supervision or safe stale-mutex removal. Unsupported controls are not registered as successful no-ops.

## Verification

Deterministic matching/definition tests and real command/lock/work runtime tests accompany actual CLI list/run/work and cooperative SIGTERM fixtures. Independent review and fresh full suite/types/graph/source evidence are required before compatibility credit; local fixtures are not multi-host or production-readiness evidence.
