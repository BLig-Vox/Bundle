# Generated owner-scoped REST resources

`make:resource Task --field title:string --field 'body:text?' --field count:integer --field price:number --field done:boolean` runs inside a newly generated app through `bun run bundle`. It takes no interactive input. The default scaffolds offline, including with an invalid database configuration. It requires the installed/linked Bundle validation module and unchanged generated `User`, `Session`, auth middleware, local router, CLI wrapper, app route manifest and paired API/page manifests plus shared frontend runtime. Missing prerequisites, symlinks, custom code or formatting changes fail closed before writes. Older/customized apps need a reviewed manual integration; this command does not upgrade them.

The command publishes `src/models/Task.ts`, `src/requests/Task.ts`, `src/routes/Task.ts`, an editable typed `src/resource-pages/Task.tsx`, and updates both `src/web/resources.ts` and `src/resource-pages.tsx`. The latter is imported statically by App and supplies visible authenticated hash navigation. Existing App and pages are preserved. See [frontend resource design and acceptance](frontend-resource-tdd.md). All imports are static and derived from bounded ASCII identifiers. Registration never imports project source. The app's static routes include `createResourceRoutes(env)` alongside existing Auth, Health and Notes routes. Notes keeps its GET/HEAD/POST behavior.

The model has a generated numeric primary key, a required `User` owner relation with database cascade deletion, and typed scalar properties. Supported fields are string, text, integer, number and boolean; suffix `?` means optional on create and nullable in SQL. There are 1–32 fields. Reserved identifiers, owner/id/timestamp fields, duplicates and equivalent database column names are refused. Strings trim to 1–255 characters, text to 1–10000; integers are safe finite integers, numbers are finite doubles and booleans are strict. Nullable fields accept explicit null on create or PATCH through `schema.optional(schema.nullable(child))`; omitted nullable create fields serialize as null. PATCH can clear a nullable field to SQL NULL with `{ "body": null }`; omitted PATCH fields remain unchanged. Nonnullable fields reject null on both create and PATCH. A non-null value still follows the child schema validation without coercion. This database meaning of `?` differs from `make:request`, where `?` means optional only and continues to reject null. Create requires every required field; Update makes every field optional but rejects an empty object. Both reject unknown keys and coercion.

The resource URL lowercases the name, inserts hyphens at lowercase/digit-to-uppercase boundaries and appends `s`: Task becomes `/api/tasks`, Category becomes `/api/categorys`. Custom paths and linguistic pluralization are outside this slice.

| URL | Methods | Result |
| --- | --- | --- |
| `/api/tasks` | GET, HEAD | Owner's next at most 100 rows, ascending id, optional exclusive `?after=ID` |
| `/api/tasks` | POST | 201 with created JSON |
| `/api/tasks/:id` | GET, HEAD | 200 with JSON, or 404 |
| `/api/tasks/:id` | PATCH | Partial update, 200 with JSON, or 404 |
| `/api/tasks/:id` | DELETE | 204, or 404 |

Collection GET preserves its JSON array response. `X-Has-More: true|false` is calculated by querying 101 rows, returning only the first 100. `after` is an optional canonical positive safe integer; duplicate/unknown query parameters, empty/unsafe/noncanonical values return safe 400 without reflecting input. The database filter combines owner and `id > after`, without offsets or a cursor lookup that could reveal another owner. HEAD retains the same headers. Mutations and item status contracts are unchanged. New rows have higher IDs; deletes can shorten or empty a live page. Previous reuses saved exclusive request boundaries, stays explicit, and is not a snapshot guarantee.

Authentication uses existing session middleware and the typed `authenticatedUserId` context key. No client-supplied ownership is accepted. Every item lookup includes the owner. Missing sessions return 401; foreign-owned and missing items both return safe 404. IDs must be canonical positive safe integers; malformed IDs return safe 400 (router-invalid paths may return 404). All mutations, including PATCH and DELETE, require the fixed configured Origin before any session/database lookup. Host/forwarded headers cannot establish Origin trust. POST/PATCH stream at most 16 KiB JSON through the typed validation helper; malformed JSON/schema returns safe 400, media errors 415 and oversized bodies 413. Output explicitly selects only id and declared scalar fields; owner, User, password and session data are never serialized. Router security headers and generic 500 handling remain active.

## Migrations

Apply the initial app baseline first:

```sh
bun run bundle make:migration initial
# Review the migration SQL/source before applying.
bun run bundle migrate
bun run bundle make:resource Task --field title:string --field 'body:text?' --migration
# Review the new diff, including any other model changes included by MikroORM.
bun run bundle migrate
```

`--migration` / `-m` uses the existing target selection, production guard and migration baseline check before scaffold publication, then the existing guarded diff generator. It generates a migration for review and never applies it. Migration generation is separate from source publication: if that later step fails, the complete scaffold stays available, and the error directs the user to review the target/baseline and retry `make:migration`. No database connection occurs by default.

## Publication and recovery

Generation validates the complete sources and the next manifest before publication, stages every file, verifies staged bytes, and records `recovery.json` with destinations and staged inode identities. Existing artifact files, directories and dangling symlinks are refused, even with `--force`. The only replacement is an unchanged, recognized paired API/page manifests, checked by bytes and inode identity. A project lock serializes resource generators; a changed prerequisite after staging aborts. Publication uses exclusive hard links, so it requires a filesystem that supports them.

Caught failures remove only published files with the staged identity and contents and restore both old manifests exclusively. Concurrent/user edits are preserved. If rollback cannot complete, its error identifies a retained `src/web/.bundle-resource-*` staging directory and the affected destinations. A concurrent file is never overwritten to restore a backup.

This is not a crash-atomic filesystem transaction. Run generators with the app stopped; readers can observe a manifest gap during replacement. Trusted directories are required: identity checks cannot eliminate hostile replacement between a check and unlink. Following a crash or incomplete rollback:

1. Stop generators and the app; confirm no generator still owns `src/web/.bundle-resource.lock`.
2. Inspect `.bundle-resource-*`, `recovery.json`, staged source and `previous-manifest.ts`/`previous-pages.tsx` against current destinations. Back up current user edits first.
3. Either finish publishing reviewed staged artifacts/manifest or remove only unchanged generator-owned files. Restore the previous manifest only when the destination is absent; preserve a concurrent manifest for manual reconciliation.
4. Verify the model/request/handler/import registrations agree. Remove recovery material and the stale lock only after reconciliation; run typecheck/tests and restart the app.

A crash before staging may leave just the lock. A crash after completion but before cleanup may leave a complete scaffold plus staging/lock. Filesystem recovery does not reverse database changes or remove migrations: inspect those separately.

## TDD and acceptance evidence

The first `src/cli/resources.test.ts` run failed with unknown `make:resource` before implementation (`/tmp/resource-red.log`). The integration test generates an app, creates/applies its baseline through the CLI, generates the resource diff with `--migration`, applies it, then exercises real SQLite through the static app router. It covers two users, CRUD round-trip, empty/invalid partial updates, malformed IDs, unauthenticated requests, missing/wrong Origin, strict field validation, bounded bodies, bounded ordered lists, deletion, owner cascade deletion and unchanged Notes behavior.

Further tests cover exact-manifest rejection without code execution, missing/untrusted prerequisites, existing artifacts/registrations, starter/resource table-name collisions (including digit/case aliases), offline generation, production migration guards, concurrent generators, staging/every publication failure and preservation of concurrent model/manifest edits. Inspection had a failing test before adding resource-route recognition and now fails closed on executable manifest suffixes.

`scripts/verify-app.ts` also generates a resource and applies its migration using the app CLI. Its acceptance fixture checks real generated schema/model types (including expected compile errors), runs migrated two-user CRUD, and runs the app typecheck, tests and production build. `BUNDLE_ACCEPTANCE_NODE_MODULES` selects explicit linked-dependency acceptance; this verifies behavior/build, not a fresh package installation. Existing development-auth deployment limits still apply.


## Nullable PATCH test-first evidence

Before implementation, `bun test src/validation/schema.test.ts src/cli/resources.test.ts src/cli/requests.test.ts` produced 27 pass / 5 fail (`/tmp/nullable-red.log`). Four failures covered the missing `schema.nullable` combinator; the migrated two-user SQLite resource test returned 400 instead of 200 when clearing `body` with null. The focused GREEN run passed all 32 tests (`/tmp/nullable-green.log`).

Combinator tests cover explicit null, strict child delegation and transformations, nested optional/nullable inference with expected compile errors, trusted issue paths without values, snapshots and detached outputs, and rejection of invalid/foreign children without invoking hooks. Request scaffold regression tests still reject null for every optional primitive type.

The linked generated-app acceptance fixture checks inferred create/update types, nullable string/text/integer/number/boolean values on create and PATCH, persisted nulls on a subsequent GET, unchanged omitted PATCH fields, nonnullable null rejection, empty PATCH rejection, and owner isolation using two real users and migrated SQLite.

Final verification for nullable PATCH: the full repository suite passed 235 tests with 5 environment-dependent skips and no failures (`/tmp/nullable-full.log`). `bun run typecheck`, strict `tsc --noEmit`, `bun run graph:check`, and whitespace checks covering tracked and untracked task files passed. Linked acceptance via `BUNDLE_ACCEPTANCE_NODE_MODULES=/tmp/bundle-request-acceptance-s8UVwY/example/node_modules bun run scripts/verify-app.ts` passed frontend/node/server typechecks, 31 generated-app tests, production builds, CLI migration generation/application, model persistence and the dedicated 41-assertion two-user resource test (`/tmp/nullable-acceptance.log`). This verifies linked dependencies, not a fresh installation. No commit or push was made.

## Keyset pagination verification

Collection pagination replaces the hard first-100 ceiling while retaining 100 rows per page and the array response. Backend and frontend RED evidence, ORM-seeded 201+ row tests, three-page DOM navigation, deletes/inserts, validation and final verification results are recorded in [pagination TDD evidence](frontend-resource-tdd.md#keyset-pagination-tdd).
