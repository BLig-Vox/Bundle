# Explicit foreground development processes

Bundle's `dev:list` and `dev` share a trusted root `dev.ts` registry. Nothing is installed during project creation or started implicitly by ordinary CLI startup. Generated applications configure a Bun API child and a Vite frontend child; dependencies must be installed explicitly in that generated app first. Runtime tests pass for generated-app typechecking, Vite readiness, React Fast Refresh/HMR updates, `ui:build`, combined API+web startup, `/api` proxying, serving generated output through the production worker on Linux, and stopping both listeners. Non-Linux production static serving remains unavailable. This is a bounded local Bun command group, not a process-group sandbox, readiness monitor or system service manager.

```ts
import { defineDevelopment } from './src/development/processes.ts';

export default defineDevelopment([
  { name: 'server', argv: ['serve', '--host', '127.0.0.1', '--port', '8000'] },
  { name: 'queue', argv: ['queue:listen', '--queue', 'default'] },
]);
```

Configure application routes before running this example. Queue commands use their documented private local storage and side effects. Optional log followers or custom commands must be explicitly registered. The generated application `dev.ts` registers the API and Vite frontend as explicit children; it does not install their packages or promise readiness before the group is considered started.

```sh
bun run bundle dev:list
bun run bundle dev
```

`dev:list` emits `{processes:[{name,argv}]}` without invoking configured commands. Importing `dev.ts` is executable trusted code, so listing is not a sandboxed static parse. Listing intentionally exposes argv: **do not put secrets in process arguments**. Source/provider/command side effects and streamed diagnostics are not undone or comprehensively redacted by the development runner.

## Definitions and source

`defineDevelopment([...])` returns a copied/frozen branded list. It accepts at most eight uniquely named records with only own enumerable `name`/`argv` data. Names use ASCII letters followed by letters/digits/underscore/hyphen, at most 64 characters. Each argv has 1–64 strings, each bounded to 4096 UTF-8 bytes without NUL; total encoded argv are capped at 64 KiB. The first argument must be an explicit command identity, not an executable path or leading global option. Global flags can follow the command. Direct `dev`/`dev:list` recursion is refused.

An explicit empty registry can list; `dev` refuses to start an empty group. Missing/unbranded source refuses, never silently launches defaults or reports empty success. `loadDevelopment(root, signal?)` requires an absolute canonicalizable root and root `dev.ts` as a regular single-link nonsymlink file at most 64 KiB. Fixed canonical URL imports retain ordinary Bun ESM caching: changed source requires a fresh process. Path checks do not prevent hostile concurrent tree replacement.

## Foreground lifecycle

`runDevelopment({root,definitions,env?,signal?,output?,error?})` launches each configured argv in an owned Bun child through the fixed native Bundle runner, rooted to the project. It does not use a shell or accept a caller-selected executable. Child stdin is ignored; stdout/stderr stream without whole-output buffering. Injected callbacks receive arbitrary text chunks, not guaranteed complete lines.

The first child exit, including status zero, ends the group and stops peers. That first exit determines the normal group status; this does not claim all configured services ran successfully or became ready. A nonzero status propagates through the real CLI. SIGINT/SIGTERM cancel the group with 130/143. Startup, wait or output failures stop and reap all children already started, then fail generically. API results contain `{exitCode,cancelled,processes:[{name,exitCode}]}` after owned children settle.

Shutdown forwards the requested signal, with a one-second SIGKILL escalation for an unresponsive **owned child only**. Pipe draining after exit is bounded to 250 ms, then readers are cancelled so inherited pipes cannot hang the supervisor; late output can be lost. This does not terminate process groups or guarantee cleanup of application-spawned descendants, undo side effects, restart crashed services, background the group or implement managed reload/watch.

Children receive `BUNDLE_DEV_CHILD=1`; nested `dev` refuses before its source is imported. Trusted code can change environment or launch unrelated processes, so this is an accidental-recursion guard, not adversarial isolation. Child commands use their ordinary CLI/provider lifecycle and cancellation behavior.

## Verification status

Focused backend and CLI tests pass, and real entry-point tests consume the same registry for listing/execution, verify listing does not run commands, preserve first-exit status zero/seven, stop peers and forward actual SIGINT/SIGTERM with owned-child reaping. Independent scoped review found no verified correctness issue. Additional later coverage verifies bounded inherited-pipe drain, partial-spawn-failure reaping, descriptor bounds and environment/source snapshots (14 backend tests, 40 assertions); CLI guards add five tests, 15 assertions. These later tests are coverage, not individually red-first feature proof. Repaired combined pre-ledger full verification passed 923 tests with 2 opt-in live-database skips, 0 failures and 18,869 assertions across 98 files; strict types passed in 198 files. The dev:list reference is credited while broader multi-tool dev integration remains partial. Final post-provenance verification for this bounded dev:list/dev group slice passed 923 tests with 2 opt-in live-database skips, 0 failures and 19,214 assertions across 98 files; strict types, graph freshness, whitespace and historical180 provenance passed. New generated Vite integration is a separate in-progress change; its test currently fails at frontend readiness and does not establish HMR, service availability, Vite/Octane parity or external integration.
