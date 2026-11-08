# Generated account session management TDD

The inspected Session schema has only `id`, hidden unique SHA-256 `tokenHash`, `user`, and indexed `expiresAt`. No schema migration or package addition is needed. Newest-first uses descending session ID because there is no creation timestamp. Router parameters decode once into immutable `context.params`; handlers validate canonical positive safe integer IDs. The existing auth middleware rejects mutation Origins before cookie parsing, database initialization or session lookup, and shares only the authenticated user ID.

The explicit routes are authenticated GET `/api/auth/sessions` (with the router's implicit HEAD alias) and DELETE `/api/auth/sessions/:id`. The list queries only the authenticated owner and unexpired rows, orders by descending ID, limits in SQL to 50, and maps exactly `{id,expiresAt,current}`. Current detection hashes the presented HTTP-only cookie and uses `timingSafeEqual` on validated fixed-length hashes. Token hashes and credential material never enter the payload. No user-agent or IP information is collected. The current session can be outside the newest 50.

DELETE also guards Origin at its handler entry. Both its lookup and delete include owner, ID and unexpired scope. Current revocation returns safe 409; foreign, missing and expired targets share the same 404. Success is empty 204. Router errors are sanitized and all responses use no-store. Existing registration, login, logout and password policies are preserved.

Account's Sessions section validates exact fields, safe IDs, boolean markers, at most 50 descending IDs, at most one current marker, and canonical future ISO dates (including rejecting normalized impossible calendar dates). It renders IDs/expiry/current status as text and offers revocation only for other sessions. Relative same-origin requests use the HTTP-only cookie, no-store, fixed errors and no browser credential storage. Successful revocation refreshes the list. Closing Account, logout/account expiry, and password rotation clear sessions and invalidate late work with both session and Account epochs.

## RED before implementation

The real generated-app `auth.test.ts` fixture generates and applies isolated SQLite migrations through the CLI. The two new session tests failed before backend changes: expected unauthenticated list 401 received 404; expected Origin rejection 403 received 405. After implementation both passed with 72 assertions. Evidence: `/tmp/sessions-red.log` and `/tmp/sessions-green.log`.

The mounted React DOM test then failed against the old App with an authenticated account and password form present, but no Sessions list. Evidence: `/tmp/sessions-dom-red.log`. An initial harness run needed the configured `APP_PUBLIC_ORIGIN=http://localhost`; the recorded behavioral RED uses that correct Origin.

## Verification

```sh
bun test
bun run typecheck
bunx --no-install tsc --noEmit
bun run graph:check
git diff --check
BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-request-acceptance-s8UVwY/example/node_modules \
BUNDLE_ACCEPTANCE_DOM_MODULE=/root/.hermes/hermes-agent/node_modules/jsdom/lib/api.js \
bun run scripts/verify-app.ts
```

The absolute dependency paths reuse host-installed packages and do not establish fresh installation. DOM tooling is supplied by the host without adding app dependencies.

- Framework: 243 passed, 3 skipped, 0 failed. Skips are live PostgreSQL/MariaDB and the environment-restricted socket test.
- Framework Bun checking, strict TypeScript, graph freshness and tracked diff whitespace checks passed. Changed untracked templates/scripts were separately checked with `git diff --no-index --check /dev/null FILE`.
- Generated app: strict client/node/server TypeScript, 33 tests, Vite production builds, CLI migrations/seeders, all model field persistence and resource CRUD/pagination acceptance passed.
- Auth tests cover two separate same-account authenticated sessions, foreign owner isolation, current refusal, missing/wrong Origin against a dropped database, canonical IDs, cap/order/expiry, safe errors, no hash/token payloads, and revoked cookies denied by both auth and Notes.
- Migrated runtime API acceptance also checks minimal session shape, current refusal, per-session revocation, no-store and immediate authentication failure for the revoked device.
- React DOM acceptance mounts the actual App in StrictMode against migrated SQLite. It checks current/expiry/list/revoke/refresh, safe mutation errors, malformed shapes/IDs/dates/order/count/current markers, stale Account reads and mutations, stale reads across logout/login, and confirmed session expiry, alongside the existing password/Notes/resource flows.

The latest full generated-app/React DOM rerun completed without act warnings. An earlier timing-sensitive run emitted two React act warnings while asserting asynchronous stale-request behavior; assertions passed in both runs.

## Firefox / HTTP

The Firefox acceptance script exercises the same session list/revoke UI with an independent HTTP cookie jar, verifies the exact metadata/current refusal, revokes the second device, confirms that cookie receives 401, then exercises password rotation and resource/Notes workflows.

The full verification command with `BUNDLE_ACCEPTANCE_FIREFOX=1` passed real Firefox/HTTP acceptance against the generated Vite app and migrated SQLite. Python 3 and Firefox were available; no Chrome fallback was used.

No commits or pushes were made. Existing workspace changes were retained.
