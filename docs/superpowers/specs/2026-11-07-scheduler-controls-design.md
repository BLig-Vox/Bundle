# Durable local scheduler controls

## Intent

Continue the standing implementation directive after reviewed UTC list/run/work. Add real persisted `schedule:pause`, `schedule:resume` and `schedule:interrupt` consumption, not successful no-ops. Keep Bun/TypeScript, no packages/network/ORM, preserve existing dirty work and no production-state mutation. These are leader-selected bounded contracts under the no-further-questions directive, not external service consent.

## State API and ownership

Create `src/schedule/control.ts` and tests. Private canonical-root `.bundle-schedule/control.json`, version1 closed `{version:1,paused:boolean,generation:string}` where generation is a UUID. Absence means unpaused and stable default generation `00000000-0000-4000-8000-000000000000` in the returned snapshot. Pause/resume preserve this sentinel even on first publication; only interrupt chooses a fresh UUID. The initial empty-string/first-mutation-random design was rejected after a leader regression reproduced first pause accidentally terminating active work as an interrupt. `readScheduleControl(root):Promise<ScheduleControl>`; `pauseSchedule(root)`, `resumeSchedule(root)`, `interruptSchedule(root)` return the persisted snapshot. Pausing/resuming changes only paused; interrupt replaces generation while preserving pause. An interrupt requests graceful termination of current observing consumers after active command settlement. A new process baselines the latest generation and runs normally. No forced termination of imports/active commands/descendants or self-respawn.

Validate explicit absolute canonical root,0700 owned private directories,0600 owned single-link bounded regular files and strict lossless versioned JSON. Unsafe/corrupt state fails closed without reset or secret diagnostics. Use complete synced exclusive temporary file and atomic replacement with bounded unstable-reader retries (ordinary replace/first-publication must not kill healthy consumers). Serialize mutations using a private owned0600 nonexpiring lock; preserve foreign/stale locks for manual inspection, never automatic expiry/unlock. Identity-owned cleanup only. Existing queue control is a pattern, not the same state: no queue storage/import coupling. No guarantee against hostile concurrent tree renames or multi-host transaction.

Create `src/cli/schedule-control.ts`/test registering the three real commands via `registerScheduleControl(program,{root,output})`. Leader registers in program.ts only after actual missing-command tests red. Safe output reports operation/paused/generation only, no trusted exception leaks. No --force needed because no queued work/history is deleted. No clear-cache/finish alias.

## Runtime integration (leader lane)

`runDueSchedules` and `workSchedules` read a baseline generation before work. Recheck control between due command invocations and between work polling slots. Read immediately before claim/lock use; a read-to-command race remains explicit, not an atomic global freeze. Active trusted command settles before interrupt ends successful run/work; later due commands do not start after the observed generation change. Pause yields visible skipped-paused metadata for due tasks but no handler/lock. Work continues polling while paused and resumes future newly observed minute slots only, no backfill or replay of skipped minute. Corrupt control stops further execution generically, preserving state.

Preserve external cancellation130/143/cooperative semantics and embedding signal ownership. No durable exactly-once history is introduced. Returned normal command failures remain failures even if an interrupt follows. Result may carry interrupted:true only when observed; no invented task exit code. Timing remains milliseconds and in-process high-water behavior unchanged.

## Evidence gates

Unit state roundtrip/alias/private/bounds/corruption/foreign lock/contention/concurrent publication tests; actual CLI pause/resume/interrupt red before registration. Real processes prove pause blocks a due marker, resume allows an explicit new run, active interruption waits for handler settlement and skips later work, and new consumer baselines current token. Unsafe state fails closed. Independent review/regression repair/re-review, fresh full tests/types/graph/provenance precede three reference credits. No live-service or timezone/DST claims.
