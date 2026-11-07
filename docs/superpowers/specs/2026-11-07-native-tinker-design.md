# Trusted native JavaScript tinker

## Scope

Implement `tinker` on Bun's existing Node-compatible `node:repl`, not a downloaded shell package or PHP/PsySH. Native probes verified persistent const bindings and top-level await using private in-memory streams on Bun1.4.4. Interactive invocation requires TTY; explicit bounded `--execute <source>` permits noninteractive trusted local JavaScript. This is intentionally arbitrary developer code with process/filesystem/network access, NOT a sandbox, host automation endpoint or remote HTTP/MCP tool. Do not modify Browny or its isolated MCP boundaries.

No automatic source evaluation, database opening, persistent REPL history/transcript or environment printing. Native expression values/errors are developer-visible and can reveal secrets if the developer prints them; do not promise redaction of arbitrary JavaScript. Standard application providers/commands bootstrap normally before tinker. Native JS syntax, multiline/context and top-level await; no PHP or TypeScript annotation parsing claim.

## API / ownership

Expose runTinker in src/console/tinker.ts with explicit absolute existing root, optional input/output streams, ServiceScope and AbortSignal, optional bounded execute string, optional owned openDatabase callback. Execute mode owns a private input stream and refuses simultaneously supplied external input. Interactive mode uses provided/default input only when isTTY is true. Native output stays caller-owned, no process-global stream/exitCode/cwd/environment patches.

Return a frozen receipt with evaluation/failure counts and interrupted/aborted flags. Count terminal native eval errors, not Recoverable multiline continuations. Wrap native eval callbacks to await active awaited evaluations before session completion and owned database cleanup. Uncooperative code can hang/block; no forced termination, rollback or cleanup of unawaited user side effects/spawned processes is promised.

Native session context contains immutable bundle bindings: canonical root, supplied services, explicit rooted module-import helper and lazy database() function. Supply rooted require via createRequire without process.chdir. No fake service container when the host supplied none. database() refuses unless an explicit opener was supplied; cache one owned opening promise and close its successful ORM exactly once after active session work settles. Existing caller service scopes/streams remain caller-owned. Restore original input raw/flowing state and remove only owned listeners; own private execute input is cleaned up. Output/input/startup failure must settle session/owned cleanup before rejection.

## CLI integration

Leader registers tinker with --execute and --allow-database. Forward the real initialized runner service scope into the CLI context so bundle.services consumes provider registrations. No database open by default. Only --allow-database supplies an owned opener; retain production global --force guard, resolve the selected target once and check cancellation before opening. Owned ORM closes after session evaluation. Do not close caller ORM or flush a caller manager.

Native Ctrl+C interrupts/closes with130; SIGINT/SIGTERM retain outer runner130/143 and cooperative session settlement. Execute evaluation failure returns nonzero; clean interactive exit returns0. Explicit --execute source is visible in process argv, so do not put secrets there. Nested tinker sessions/host hooks must retain exclusive input ownership; document trusted/uncooperative limits.

## Verification

Observe missing command/API red first. Private native streams test const/context persistence, top-level await, rooted require/import, error/multiline handling, TTY/argument refusal, execute snapshots/bounds, external abort, input/output failure, listener/raw/flow restoration and database lazy/open/once-close/settlement ownership. Use only new disposable roots/SQLite. Actual CLI execute consumers cover rooted provider service resolution, default no DB, guarded explicit SQLite work/close and status. Actual PTY/signal consumers use existing Python3 support (no install), not the user's real stdin. Full suite/types/source/graph/historical180 gates precede original tinker reference credit.
