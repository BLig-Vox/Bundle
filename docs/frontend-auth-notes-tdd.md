# Generated account and Notes UI acceptance

Historical milestone evidence follows. For the current password-change implementation and verification totals, see [password-change TDD evidence](frontend-password-tdd.md).
The contracts were read from `templates/app/src/web/routes.ts.tpl`, `routes/Auth.ts.tpl` and `routes/Notes.ts.tpl` before changing the frontend:

| Request | Successful response |
| --- | --- |
| POST `/api/auth/register` with exactly email/password | 201, exactly `{id,email}`, HTTP-only cookie |
| POST `/api/auth/login` with exactly email/password | 200, exactly `{id,email}`, replacement cookie |
| GET `/api/auth/me` | 200, exactly `{id,email}` (401 when signed out) |
| POST `/api/auth/logout` | 204, revoked/cleared cookie |
| GET `/api/notes` | 200, array of `{id,body}`, at most 100, ascending ID |
| POST `/api/notes` with exactly body | 201, exactly `{id,body}`, trimmed 1–1000 characters |

Origin enforcement, session hashing/rotation, owner scoping and server validation were unchanged. The UI uses relative same-origin fetch with explicit same-origin credentials and no-store. It does not read cookies, persist credentials/tokens, render server error bodies, or inject note HTML. Client checks enforce ASCII email policy, password character/UTF-8 limits and serialized credential JSON bounds. Response validators reject unexpected fields, unsafe IDs, invalid strings and invalid list windows/order. Session boundaries clear private state and invalidate/abort pending work. Auth mutations are serialized; failed logout blocks account changes pending successful revocation.

## RED before implementation

Added `templates/acceptance/frontend.test.ts.tpl` with rendered accessible account checks and real React DOM account/Notes interactions before replacing the App. Updated `scripts/verify-app.ts` to build the generated output first, then run the rendered acceptance check.

The unchanged status-only frontend passed generated TypeScript checks and Vite production build, then failed the rendered check:

```text
Expected to contain: for="email"
Received: ...Check Bundle server...Ready to connect...
0 pass, 1 fail
```

The initial test harness briefly failed typechecking because the acceptance file was placed under server-only scripts. Moving it to an acceptance directory fixed that harness configuration before recording the behavioral RED. No frontend implementation was changed until that RED was confirmed. `/tmp/frontend-red.log` contains the session's build and failing assertion.

## GREEN evidence (2026-11-08 session)

```bash
BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-request-acceptance-s8UVwY/example/node_modules \
BUNDLE_ACCEPTANCE_DOM_MODULE=/root/.hermes/hermes-agent/node_modules/jsdom/lib/api.js \
bun run scripts/verify-app.ts
bun test
bun run typecheck
bun run graph:check
git diff --check
```

The absolute module paths reuse this environment's installed packages; substitute your own. This run does not establish fresh dependency installation.

- Framework: 235 passed, 5 opt-in tests skipped, 0 failed. Skips cover live PostgreSQL/MariaDB and three socket integration checks.
- Generated app: typecheck, 31 tests, production build, CLI-generated/applied SQLite migrations, generated model/resource acceptance, and register/login/me/password-change/Notes/logout runtime acceptance passed.
- Frontend acceptance: 2 passed, 268 assertions. The DOM test mounts the actual App in StrictMode and routes its fetch requests through the generated manifest against the migrated SQLite database. It submits labelled forms, checks empty/list/create, logs out/in, switches accounts, verifies text escaping and no browser storage, and tests stale reads/writes, invalid shapes/limits, safe errors, draft retention, session expiry and failed logout retry.
- Framework typecheck, graph freshness and whitespace checks passed. Untracked changed templates/scripts were also checked with `git diff --no-index --check /dev/null <file>` (exit 1 denotes differing content; no whitespace diagnostics).

`/tmp/frontend-final-acceptance.log` and `/tmp/frontend-framework-tests.log` contain this session's outputs. These are temporary evidence, not committed fixtures.

## Firefox limitation and reproducible browser check

Firefox is installed, but `python3 templates/acceptance/frontend.py http://127.0.0.1:5173` failed while creating its loopback automation socket with `PermissionError: [Errno 1] Operation not permitted`. The sandbox also denies the sockets needed by Vite/API servers. Therefore no real-browser result is claimed. `/tmp/frontend-firefox.log` contains the failure. No Chrome was used.

Outside the socket-restricted sandbox, set `BUNDLE_ACCEPTANCE_FIREFOX=1` on the verification command. It starts the generated Vite/API servers with their exact configured browser Origin and runs a private headless Firefox profile over real HTTP, including refresh/session restoration, register/create/list/logout/login and account isolation. Python 3 and Firefox are required. `BUNDLE_FIREFOX` can override the binary. A requested browser run fails explicitly if unavailable. DOM tests use a host-supplied jsdom module; neither test tool adds app dependencies.
