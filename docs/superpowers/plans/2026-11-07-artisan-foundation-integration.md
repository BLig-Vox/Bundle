# Artisan Foundation Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement owned tasks. Steps use checkbox syntax for tracking.

**Goal:** Advance the full applicable Artisan compatibility roadmap by shipping executable foundations, not disconnected APIs or placeholder commands.

**Architecture:** Preserve the existing Bun/TypeScript Commander CLI and MikroORM database contract. Three workers own separate runtime, generator, and operational modules; the leader exclusively integrates shared registration/entry point, compatibility evidence, documentation and generated corpus. Existing PHP/Blade exclusions remain explicit; command-name similarity does not establish full semantic compatibility.

**Tech Stack:** Bun, TypeScript, Commander 15, MikroORM 7.2.7, bun:test.

**Spec:** `docs/cli-roadmap.md`, `docs/cli-compatibility.json`, `docs/cli-implementation-loop.md`.

## Global Constraints

- Use a code-driven approach; no XML, AXAML/XAML, HTML-like UI syntax including JSX/TSX, or markup-based UI frameworks.
- At most three delegated workers active; no nested delegation, commits, pushes, dependency installation, provisioning or existing-database resets.
- Preserve all pre-existing dirty files and existing public database behavior.
- Test writes use unique disposable fixtures; no real `.env` modifications during verification.
- Full applicable compatibility is the project goal, not the completion claim for this bounded milestone.
- Workers must not modify shared `src/cli/program.ts`, `index.ts`, `PROGRESS.md`, documentation, graph artifacts, or other workers' files.

## Review Focus

- Generated custom commands must be discovered/executed by the real entry point, not only a special test host.
- CLI help/version, parser failures and nonzero custom handler results must preserve output and exit semantics without mutating global process state in the runner API.
- Missing/invalid configuration and filesystem collisions/symlinks must refuse without overwriting user content.
- Configuration display and cryptographic failures must not reveal secret values; encrypted output must authenticate before any plaintext publication.
- Existing CLI-process fixtures must include new runtime imports; unit success alone is not public integration evidence.

---

### Task 1: Command application runtime (worker A)

**Files:** `src/console/*`, new `src/cli/runner.ts`, new `src/cli/runner.test.ts`.

**Interfaces:** Preserve `defineCommand`, `registerCommands`, `loadApplicationCommands`. Export `createApplicationCli(context?: {root?: string; env?: Record<string,string|undefined>; output?: (text:string)=>void; error?: (text:string)=>void}): Promise<Command>` and `runCli(args: readonly string[], context?: same): Promise<number>` from `runner.ts`. The application builder calls existing `createCli` then loads trusted project commands; the runner handles Commander exit codes and redacted errors without changing `process.exitCode`. Leader will invoke it from `index.ts`.

- [x] Add regression tests for actual application command loading, listing/help, nonzero exit statuses, handler/parser failures, missing commands directory and collisions.
- [x] Implement the runner/application builder while preserving existing command APIs and considering class-based command usability.
- [x] Run focused tests; state validation blockers rather than claiming success.

### Task 2: Executable code-only generators (worker B)

**Files:** `src/cli/scaffolding.ts`, `src/cli/scaffolding.test.ts`, new `src/cli/generators.ts`, new `src/cli/generators.test.ts`.

**Interfaces:** Export `registerScaffolding(program: Command, context: {root: string; output: (text:string)=>void}): void` from `generators.ts`. Register only functional supported generators: class/interface/enum, an explicitly labelled TypeScript mixin alternative, exception, Bun test, and custom command. Generated commands export loader-compatible definitions without unresolved imports. Keep validation/exclusive writes/path confinement.

- [x] Add failing registration/generation tests covering discovery of supported names, invalid names, no-overwrite/symlink refusal, generated syntax and handler usability.
- [x] Extend scaffold APIs/templates minimally and register generators, preserving existing exports.
- [x] Run focused tests and type checking; report exact supported flags and differences, not arbitrary Artisan parity.

### Task 3: Configuration and environment commands (worker C)

**Files:** `src/configuration/*`, `src/environment/*`, new `src/cli/operations.ts`, new `src/cli/operations.test.ts`.

**Interfaces:** Export `registerOperations(program: Command, context: {root: string; env: Record<string,string|undefined>; output: (text:string)=>void}): void`. Wire config show/cache/clear/publish and env/key/env-encrypt/env-decrypt only to existing real implementations. Use global `--force` for explicit overwrite authorization. Document narrow supported options in help. Keys are never printed unless explicit `key:generate --show`; env encryption accepts explicit key or a documented environment key, never automatically prints generated secrets. Display config with recursive secret redaction.

- [x] Add environment tests for random key format, non-echoing updates, preservation/refusal paths, AES-GCM round trips, wrong key/tampering, file modes and symlink refusal in disposable roots.
- [x] Add CLI registration/action tests for output, config display redaction, force and unsupported input errors without touching repository `.env`.
- [x] Implement registration and minimal backend fixes supported by regressions; run focused validation.

### Task 4: Shared integration, verification and evidence (leader)

**Files:** `src/cli/program.ts`, `index.ts`, existing CLI-process fixtures/tests, root docs/CLAUDE.md, progress ledger/backlog/graph.

- [x] Diagnose current Bun command dispatch/test recursion without changing global harness/security settings; establish a reliable verification route or report its blocker.
  - Root cause: Bun 1.4.4 dispatch is confused by this session's inherited `BUN_OPTIONS=--preload ...`. The preload is a cosmetic Claudex terminal-label shim. Passing that identical preload explicitly after `test` works without changing global settings: `BUN_OPTIONS="" bun test --preload /home/recruas/.config/claudex/preload.cjs <test paths>`. Corpus tests passed: 11 tests, 0 failures. For script execution use command-local `BUN_OPTIONS="" bun run <script>`; no global configuration or permission changes.
- [x] Register worker B/C modules in `createCli`; use worker A runner in `index.ts`; adjust only necessary fixture copies.
- [x] Exercise actual generated-command execution, list/help/version, generator output and config/env operations in disposable CLI-process fixtures.
- [x] Run independent review after implementation with no concurrent writes; resolve verified issues.
- [x] Run full tests, typecheck, graph freshness and whitespace checks, reporting failed/skipped tests separately.
- [x] Reconcile all affected compatibility IDs and duplicate examples with actual bounded evidence; retain partial status for unsupported options/runtime/service gaps.
- [x] Leader-owned independent M2 slice: add `src/cli/testing.ts` and `src/cli/testing.test.ts` exposing `registerTesting(program, context)` for real Bun test subprocess execution, file/name filtering, coverage and explicitly bounded native worker-process parallelism. Preserve child output/status and forward termination signals. Native worker isolation is not Laravel's automatic test-database provisioning. Register in `program.ts`; no overlap with worker-owned generator/operation/runtime files.
- [x] Update progress and loop checkpoint; regenerate corpus using the progress-graph contract. Report exact completed milestone and all remaining full-parity work.

## Verified result (2026-11-07)

Three implementation lanes and their independent reviews completed, followed by two focused repair workers and one integration/test-adapter reviewer; no more than three workers were active at once. Review repairs cover class-instance state binding, stale exit assertions, generator collisions, exclusive cache publication, URL/known-secret redaction, symlink-aware test traversal, complete migration process fixtures and faithful subprocess stream output.

The actual CLI exposes 38 commands. Fresh validation: 239 tests passed, 2 opt-in live-server tests skipped, 0 failed across 17 files; typecheck passed in 48 files, corpus freshness and whitespace checks passed, and generated secret-bearing cache is ignored. Native-worker tests establish overlapping execution in distinct PIDs; CLI-process tests establish generated-command execution, configuration/environment round trips, status propagation, raw Unicode output and signal cleanup.

Compatibility inventory: 113 pending, 34 partial, 24 bounded implemented, 9 excluded = 180. Corpus: 15 categories, 39 sections, 180 unchanged unchecked reference items, 428 nodes, 465 edges. Full applicable Artisan compatibility is not complete. Remaining milestone/runtime/flag/external-service gaps are retained in the roadmap/backlog; no unattended loop, active worker, commit or push remains at this checkpoint.
