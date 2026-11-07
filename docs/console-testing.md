# Native console testing harness

> Final post-provenance verification passed 944 tests, with 2 opt-in live-database skips and no failures (19,350 assertions across 101 files). Strict types passed in 202 files; graph freshness and whitespace checks passed.

`testCommand` exercises the actual rooted Bundle runner with captured injected I/O and scripted **native** prompts. It does not replace handlers with mocks or intercept process-global stdin/stdout. Use ordinary process integration tests when you need OS signal, binary-entrypoint or direct subprocess/global-output evidence.

```ts
import { testCommand } from './src/console/testing.ts';

const result = await testCommand(['report:daily'], {
  root: '/absolute/path/to/disposable/project',
  env: { ...process.env, APP_ENV: 'test' },
  prompts: [
    { method: 'text', message: 'Report date', lines: ['2026-11-07'] },
  ],
});
result.assertExitCode(0).assertOutputIncludes('Report complete').assertNoError();
```

The example assumes your explicitly registered command asks the exact native text prompt. The harness never invents a report command or provisions a database. Trusted commands/providers/imports still execute application code and can perform ordinary side effects; use disposable roots/services appropriate to the code under test.

## Scripted native interaction

A prompt step contains only `method`, `message` and `lines`. Supported methods are `text`, `password`, `confirm`, `select`, `multiselect` and `search`. Each step must match the next requested method and exact message. Lines are submitted only for that prompt, preserving native validators/retries, choice indexes, search queries and password transitions. For example:

```ts
prompts: [
  { method: 'text', message: 'Name', lines: ['', 'Ada'] },
  { method: 'password', message: 'Secret', lines: ['fixture-only-value'] },
  { method: 'confirm', message: 'Continue', lines: ['yes'] },
  { method: 'select', message: 'Team', lines: ['2'] },
  { method: 'multiselect', message: 'Roles', lines: ['1,2'] },
  { method: 'search', message: 'Country', lines: ['un', '1'] },
]
```

The blank first text line can exercise the command's required-value validation; invalid inputs are not automatically considered valid. Search needs both query and selection lines. Unexpected/mismatched/missing or unused steps fail the harness after runner-owned cleanup, rather than accidentally passing an assertion that the command exited one.

Scripts are copied before execution: at most 64 steps and 32 lines per step, 4096 UTF-8 bytes per line, 64 KiB total input. Lines cannot contain newline/CR/NUL/control characters; use separate lines for separate native reads. Empty lines can exercise defaults. Private in-memory TTY/raw-mode state supports password entry without touching a real terminal. Native prompt output does not echo submitted passwords; commands can still explicitly print secrets, so captured output is not a comprehensive secret-redaction boundary.

## Results, bounds and ownership

Options include absolute `root`, copied `env`, optional prompt steps, cooperative `signal` and aggregate `maxOutputBytes` (default/max 1 MiB). The root is canonicalized; argv and options are validated/snapshotted before execution. No shell or dependency download is involved.

Readonly result fields are `exitCode`, `output`, `error` and separate `promptOutput`. Chainable assertions check exact status, output/error/prompt substring or empty error output. A command can legitimately write to stderr on success (for example Bun's test report); `assertNoError` checks captured error text, not status alone. Assertions use normal assertion failures, not runtime dependency on `bun:test`.

Capture is bounded across injected output/error/prompt streams. Exceeding the cap or a harness prompt mismatch fails after the runner has settled its owned scopes/providers/services. The harness owns only its private streams/listeners and uses `handleSignals: false`, without changing process.exitCode, environment, stdin or global signal ownership. Trusted uncooperative commands/imports are not forcibly terminated; cancellation remains cooperative.

Direct `console.log`, raw process writes and application-spawned subprocess streams that bypass injected context callbacks are **not** captured. Ordinary Bun ESM source caching remains in effect; use a fresh process when changed-source lifetime matters. Independent harness calls must use separate fixture resources in addition to their independent private prompt streams. This is not automatic per-worker database provisioning, command sandboxing or a lossless process transcript.

## Consuming tests

Leader consumers exercise generated `make:command` output and generated `make:test --unit` through the real runner, automatic required-argument prompting with validation retry/error status, and native text/password/confirmation/choice/search interaction. Combined backend/public consumer verification passes 13 tests with 35 assertions, including later snapshot/cancellation/scope-provider cleanup and argument-validation coverage. Independent review reproduced a caught unexpected concurrent-prompt rejection being suppressed by a command; a red-first consumer and mismatch-recording repair now fail after command settlement, accepted on narrow re-review. The original console input/output assertion reference is credited after repaired pre-ledger full verification (944 passed, 2 opt-in live-server skips, 0 failures, 19,122 assertions across 101 files/types202) and historical180 reconciliation. Final post-provenance gates passed: 944 tests, 2 opt-in live-server skips, 0 failures and 19,350 assertions across 101 files; types202, graph freshness and whitespace checks passed. Automatic per-worker DB provisioning and feature-specific HTTP test generation remain separate unfinished references.
