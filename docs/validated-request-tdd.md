# Typed JSON request boundary: test-first evidence

Added RED tests before implementing `readValidatedJson`:

```text
bun test src/web/request.test.ts src/cli/requests.test.ts src/cli/apps.test.ts
25 pass
5 fail
```

Failures covered the missing helper, safe router responses, parser protection forwarding, generated Notes integration, and a real generated app handler passing its CLI-generated `make:request` schema to the helper. Existing `readJson` tests passed. The focused GREEN run passed all 30 tests.

The helper calls `readJson` with the existing options, then calls the supplied Bundle `Schema<T>.safeParse` and returns its parsed data as `Promise<T>`. Validation failure creates only `HttpError(400, "Invalid request body")`, without attaching input, issues, paths, values, or a cause. Tests cover inferred primitive/optional types, trimming without coercion, strict extras, nested private schema paths/expected literals, malformed JSON, empty bodies, media rejection, invalid UTF-8, declared and streamed oversize bodies, custom UTF-8 byte limits and the default cap. The original parser implementation and return behavior remain intact.

Generated Notes uses the helper with its 16 KiB cap. Generated auth uses strict credential/password-change schemas and a 4096-byte cap; it maps only the helper's fixed schema error to `Invalid credentials.` and preserves parser errors. ASCII email normalization/semantic checks, unmodified passwords, and UTF-8 password byte bounds remain explicit. Generated tests assert generic credential schema responses and Notes' fixed generic response.

`scripts/verify-app.ts` generates a schema through the app CLI and compiles/runs a real handler using the helper, including `@ts-expect-error` verification that inferred numeric output does not degrade to `any`. It supports explicitly linked dependencies:

```bash
BUNDLE_ACCEPTANCE_NODE_MODULES=/path/to/installed/node_modules bun run scripts/verify-app.ts
```

Linked-dependency acceptance passed 18 app tests, frontend/server typechecks, Vite production build, SQLite migration/seed/model persistence and auth/password-change/Notes API workflows. This verifies generated-app behavior with existing dependencies, not fresh installation.

Final repository validation: `bun test` passed 201 tests, skipped 5 environment-dependent network/live-database tests, and failed 0; `bun run typecheck`, `bun run graph:check`, and whitespace checks (including all task files that are currently untracked) passed. No commit or push was made.
