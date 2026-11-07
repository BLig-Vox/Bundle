# Explicit local development processes

## Scope

Implement original pending dev:list item:8b6457bf63c1137d through a real consumed process registry and foreground `dev` group runner, not help-only metadata. Existing dev reference remains bounded/partial unless its specified Bun equivalent has full evidence; no Vite/front-end framework/install/download is selected. Preserve dirty work and all180 originals. Tests launch only disposable local trusted Bun fixture commands; no external service or real app DB operations. The separate history-uninstall feature is permission-blocked and must not be implemented through this work.

## Backend contracts

New src/development/processes.ts and adjacent tests provide:

- defineDevelopment(processes: readonly {name:string,argv:readonly string[]}[]):DevelopmentDefinitions
- loadDevelopment(root:string,signal?:AbortSignal):Promise<DevelopmentDefinitions>
- runDevelopment({root,definitions,env?,signal?,output?,error?}):Promise<{exitCode:number,cancelled:boolean,processes:readonly {name:string,exitCode:number}[]}>

Copied/frozen branded dense list0..8; unique ASCII names1..64 `[A-Za-z][A-Za-z0-9_-]*`; each closed own enumerable data record name/argv only, no getters/symbols/unknown keys. argv1..64 copied own strings, each1..4096bytes/noNUL, all encoded argv total<=64KiB. First argv must be an explicit command identity `[A-Za-z][A-Za-z0-9:_-]{0,127}`, not dev/dev:list; global options can follow the command, not precede it. No shell parsing/executable path/JS evaluator/binary override. Empty registry can list, but dev refuses no configured process rather than fabricated success. Public definitions expose names/argv; listing intentionally exposes explicit argv, users must not put secrets there.

Source root must be absolute/canonical; explicit root dev.ts <=64KiB regular single-link nonsymlink. Fixed canonical file import, branded default export only, missing source refuses, generic diagnostics and pre/post-await signal checks. No automatic scan or hot reload, no implicit defaults/services. Trusted imports/providers/commands are application code, not sandboxes.

runDevelopment validates and snapshots options/definitions/env/selection before first await. Environment is copied and validated as string/undefined own data; default process.env explicitly copied. Root canonicalized before spawn; optional output/error must be functions, signal native AbortSignal. Run all1..8 configured commands concurrently in owned native Bun children using process.execPath plus fixed package runner module script calling rooted runCli, stdin ignored, stdout/stderr streamed without whole-output buffering. Explicit argv are not serialized into a shell. Set BUNDLE_DEV_CHILD=1; registration refuses dev under this marker before source import. Direct recursive dev/dev:list descriptors refuse; trusted code can still alter env/start other processes, so this is not adversarial recursion isolation.

Foreground group lifecycle: first child exit (including0) ends group and stops peers; first actual exit determines normal group exitCode, peer shutdown statuses remain actual metadata. External abort stops all owned children and returns cancelled true with130 for SIGINT reason/143 otherwise. Spawn/output/wait failures stop/reap all started children then throw generic. Startup checks signal between starts. Stop forwards SIGINT/SIGTERM, escalates only owned child after1000ms to SIGKILL; no process groups/descendant cleanup guarantee. After each child exit drain pipes for at most250ms, then cancel readers to avoid inherited-pipe hang; tail output can be lost. Always remove listeners/timers/readers, reap children even if output sink throws. No self-respawn, background daemon, service manager, watch/reload, external-service health/readiness or undo of command side effects. Group results only after all owned children settle.

## CLI integration

New cli/development.ts registerDevelopment(program,{root,env,output?,error?,signal?}). `dev:list` outputs JSON names/argv consumed by same registry without starting child commands; source import remains executable. `dev` starts real group with streamed output and returns exact group status using runner's established command status convention; inspect queue/listen/testing integration rather than mutating process.exitCode inside API. Pass signal; outer runner retains130/143 behavior. Validate inherited child marker and preabort before loading source for dev. Plain list no download/DB setup. No options needed initially; unknown options fail.

## Evidence/gates

Observed unknown dev:list actual entrypoint red before registration. Definition/source/options validation/snapshot/bounds/link/identity/no-execution-on-list tests, actual rooted custom command side effects, sibling shutdown on first success/nonzero, cancellation130/143, startup/sink failure cleanup and bounded inherited pipes where practical. Fixture commands handshake so tests don't rely on arbitrary sleep. Actual process list/dev default/custom registries and no app DB state. Independent review + verified regression repair/re-review; whole suite/types/graph/whitespace/historical180 provenance before original dev:list credit. No PHP/Vite/Laravel installer parity implied; full100%goal remains unfinished and permission-blocked history work remains pending.
