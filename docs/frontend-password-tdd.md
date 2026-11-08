# Generated password-change UI: contract and TDD evidence

This is the current frontend auth milestone. Earlier frontend/Notes/resource evidence describes historical runs; the totals below apply to this change.

Before coding, read `templates/app/src/routes/Auth.ts.tpl`, `src/web/routes.ts.tpl`, the shared string schema and existing session implementation. `POST /api/auth/password` accepts exactly `{currentPassword,newPassword}`. Each string requires 12–1024 JavaScript string units and at most 1024 UTF-8 bytes, without trimming or normalization. Serialized JSON is capped at 4096 bytes. Success is 204 with a rotated HTTP-only session cookie, after revoking every previous session. A generic 401 can mean a wrong current password or missing/expired/revoked session. Backend policy is unchanged.

The authenticated **Account** action expands a labelled change-password form with current/new/confirmation controls and password-manager autocomplete hints. Client validation checks both submitted passwords, exact confirmation equality and serialized body size before fetch. Errors use fixed text and never read backend error bodies. Success clears all password controls and reports that other sessions were signed out. The browser applies the rotated cookie; React neither reads nor persists it. Form state clears on logout, account changes and closing the form.

Password submissions have an immediate ref lock as well as disabled controls. Logout remains available during pending requests. Every completion, including the follow-up session check, is guarded by the existing session epoch. On password 401, `/api/auth/me` revalidates the same identity: a valid account stays signed in, a confirmed 401 clears private state, and network/server/malformed/other-identity responses show a generic retry error without claiming expiry.

## RED → GREEN

Added React DOM acceptance before implementing the UI. The generated app built, typechecked and migrated SQLite successfully; acceptance then failed on the missing **Account** button (`expect(received).toBeDefined()`, 1 pass / 1 fail, 29 assertions). Only after recording this behavioral RED was `App.tsx.tpl` changed. Evidence: `/tmp/password-red.log`.

The DOM fixture mounts the real App in StrictMode and bridges fetch to the generated router with CLI-migrated SQLite. It creates an account and independent second-device session, verifies wrong-current-password preserves the account and issues `/me`, rejects short/over-byte/over-character/mismatched/over-JSON-limit values before requests, accepts exact length/byte boundaries without modifying values, checks safe mutation and revalidation failures, rotates the cookie, checks both prior cookies are revoked, and verifies old-password failure/new-password login. It also covers duplicate submissions, pending success and pending revalidation across account epochs, form clearing and confirmed expiry. Existing Notes and generated paginated resource CRUD, owner isolation, hostile responses and stale requests still run. Browser local/session storage remain empty.

Reproduce from the framework checkout (host-installed acceptance tools, no new dependencies):

```bash
BUNDLE_ACCEPTANCE_NODE_MODULES=/absolute/path/to/app/node_modules \
BUNDLE_ACCEPTANCE_DOM_MODULE=/absolute/path/to/jsdom/lib/api.js \
bun run scripts/verify-app.ts
bun test
bun run typecheck
bunx --no-install tsc --noEmit
bun run graph:check
git diff --check
```

Linked dependencies verify generated behavior, not a fresh dependency installation. Generated verification runs all three client/Node/server typechecks, app tests, production builds, CLI-generated/applied SQLite migrations, model persistence, resource API acceptance and DOM acceptance.

## Firefox / HTTP

The dependency-free Firefox script now includes password mismatch/UTF-8 rejection, wrong-current-password preservation, successful rotation, a second real HTTP cookie jar's revocation, refresh using the rotated cookie, old-password failure and new-password login, alongside the existing Notes/resource workflow. Enable with `BUNDLE_ACCEPTANCE_FIREFOX=1` on the verification command. Python 3, Firefox and loopback socket access are required.

Firefox is installed here. The real HTTP/browser run succeeded with `BUNDLE_ACCEPTANCE_FIREFOX=1`, using a private headless Firefox profile and the generated Vite/API server. It verified password mismatch and UTF-8 rejection, wrong-current-password preservation, session rotation, a second device's revocation, refresh with the new cookie, old-password failure, new-password login, plus Notes and paginated resource flows. No Chrome fallback was used.

## Final verification (2026-11-08)

- Framework: **243 passed, 3 skipped, 0 failed**. Skips are the live PostgreSQL/MariaDB tests and the environment-restricted socket integration test.
- Generated app: **31 passed, 0 failed** (4717 assertions); client, Node and server typechecks; production builds; CLI migrations; model persistence; auth/password-change/Notes runtime acceptance all passed.
- Migrated resource API acceptance: **2 passed, 78 assertions**. React DOM acceptance: **2 passed, 967 assertions**.
- Framework Bun typecheck, strict TypeScript, graph freshness and diff checks passed.
- Real Firefox/HTTP: **passed**, including password-change lifecycle and existing Notes/resource flows. Fresh dependency installation was not verified; existing dependencies were linked.

Evidence: `/tmp/password-final-acceptance.log`, `/tmp/password-framework.log`, `/tmp/password-typecheck.log`, `/tmp/password-strict.log`, `/tmp/password-graph.log` and `/tmp/password-diff.log`. These are temporary session evidence, not fixtures. No commit or push was made.
