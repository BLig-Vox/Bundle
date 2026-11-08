# Bundle

> **Product direction:** Bundle is intended to grow into a complete, secure-by-default, AI-friendly full-stack framework. A TypeScript page generator, minimal Bun web runtime, and database CLI are implemented. The generated app includes a Vite/React frontend with shadcn/ui conventions, cookie-based account forms and private Notes, plus early SQLite queue storage with `make:job` typed skeletons, statically registered one-shot processing. A continuously polling worker and automatic registry updates remain future work. Production deployment and broader framework features remain future work. See [FRAMEWORK_DIRECTION.md](./FRAMEWORK_DIRECTION.md) for the roadmap and acceptance bar.

A code-first Bun + TypeScript project. Its first application feature is a MikroORM-powered database layer and Laravel-inspired CLI. Development uses no XML, AXAML/XAML, HTML-like UI syntax, or markup-based UI framework.

## Offline project inventory

```bash
bun run bundle inspect
bun run bundle inspect --json
```

`inspect` summarizes the current working project without connecting to a database or importing/executing project code. Default output is compact; `--json` emits one deterministic JSON object with `schemaVersion: 1`, framework/package identity, `sourceRoots`, model filenames, `routes`, `migrations`, `auth`, and exact `next` commands for scaffold/dev/verify. Package identity includes only validated name/version fields, never scripts, dependency URLs, environment values or credentials. Missing identity fields are `null`; missing roots/models/routes are empty arrays. Package status is `ok`, `missing`, `invalid` or `unreadable`.

Discovery is limited to `src` and `templates/app/src`, with regular TypeScript model files (including `.ts.tpl`) directly under their `models` directories. Symlink components and special files are skipped; file reads are bounded to 256 KiB. Route status is `trusted` only for the complete unchanged Bundle registration grammar or shipped Home/auth/Notes manifest plus its exact resource manifest, recognized as text. Other manifests report `untrusted` with no entries; absent/unreadable manifests report `missing`/`unreadable`. Methods include implicit HEAD for GET. Custom route modules are never loaded. Migration state is always `unknown`: local files do not establish applied database state.

Generated auth is explicitly development-only and **not production-ready**. A conventional `src/auth.ts` also triggers an unverified-auth caveat. Inventory does not establish runtime, dependency, migration or security readiness. Suggested commands are fixed conventional invocations, never copied from project scripts; review the project before executing them. Reads assume directories are not concurrently replaced by another writer.

## TypeScript page generator

```bash
bun run bundle make:page Dashboard
```

Creates `src/pages/Dashboard.ts` and prints `{ "created": "src/pages/Dashboard.ts" }`. The plain TypeScript module exports `PageProps` and `render({ title?, heading? } = {})`, returning a complete HTML document with the page name as both defaults. It has no runtime imports, JSX/TSX, UI framework, or new dependencies.

```ts
import { render } from "./src/pages/Dashboard.ts";

const html = render({ title: "Dashboard", heading: "Welcome <visitor>" });
// In your own Bun server handler:
const response = new Response(html, {
  headers: { "Content-Type": "text/html; charset=utf-8" },
});
```

The generator creates a module only. The built-in `serve --mode pages` command recognizes only `Home.ts` at `/`; other page names require explicit route handlers and registration. Dynamic text escapes `&`, `<`, `>`, `"`, and `'`. That escaping is for HTML text and quoted attributes, not JavaScript, CSS, or URL validation.

Names must start with an ASCII uppercase letter and contain only ASCII letters and digits (for example `Dashboard` or `AccountSettings2`). Paths, extensions, whitespace, and reserved device names are rejected before filesystem changes. Existing files, directories, and symlinks are never replaced, even with `--force`. The generator rejects symlinked `src`/`src/pages` directories and publishes a complete temporary file using an exclusive hard link; the filesystem must support hard links. Run in a trusted workspace: hostile concurrent replacement of parent directories is outside this guard. Errors print a concise message and exit nonzero. See [page generator tests](src/cli/pages.test.ts) for the negative and concurrency cases.

## Minimal web runtime

```bash
bun run bundle make:page Home  # only if src/pages/Home.ts does not already exist
bun run bundle serve
bun run bundle serve --port 0 # choose an available port
```

`serve` defaults to `127.0.0.1:3000` and prints JSON `{ "listening": "http://127.0.0.1:3000/" }`. `--host` accepts numeric IPv4/IPv6 addresses only; a non-loopback address explicitly exposes the listener. `--port` accepts decimal integers from 0 through 65535. There are no implicit HOST/PORT environment overrides and no database connection.

`serve` loads the selected project root's fixed `src/web/routes.ts` manifest when present. With no manifest it retains the legacy Home preview. `serve --mode routes` selects only the fixed manifest: a missing manifest means an empty route table (404), with no page or framework fixture fallback. `serve --mode pages` selects only `src/pages/Home.ts`, imports its `render()` and captures its string once at startup. These modes never discover files or derive imports from a URL, query, Host header, or other request data.

### Static route registration

```bash
bun run bundle make:route Greeting --register
bun run bundle make:route AccountSettings --register --path /account/settings
bun run bundle serve --mode routes --port 0
```

`make:route Greeting --register` creates `src/routes/Greeting.ts`, a typed `Request => Response` handler, and registers its lexical static import in `src/web/routes.ts`. If absent, the manifest is created with a local structural `Route` type and an exported `readonly Route[]`; it needs no additional runtime files. JSON output is `{ "created": "src/routes/Greeting.ts", "registered": { "manifest": "src/web/routes.ts", "path": "/greeting" } }`. Default paths use lower-kebab names (`AccountSettings` → `/account-settings`, `HTTPStatus` → `/http-status`). `--path` requires `--register` and accepts `/` or canonical ASCII letter/digit/underscore/hyphen segments and single-segment `:name` parameters (for example, `--path /users/:userId`). Parameter identifiers match `[A-Za-z_][A-Za-z0-9_]*` and must be unique within a path. Encodings, traversal, empty segments, trailing slashes, query strings, fragments, optional segments, and wildcards are rejected before writes.

Distinct routes can be added to an unchanged generated manifest. Repeating the same name/path registration is a no-op, requires an existing regular handler, preserves any handler edits, and returns only `registered`. Reusing a path or handler name for a different mapping fails before changing either file. An existing unregistered handler is never adopted or overwritten, even with `--force`.

Without `--register`, the command creates only the handler and prints `created` and `registration`, containing the import and entry to add manually:

```ts
import { handler as GreetingHandler } from "../routes/Greeting.ts";
// Keep other imports and registrations. Add this entry to the exported array:
export const routes = [
  { path: "/greeting", handler: GreetingHandler },
];
```

The repository's manifest statically imports its Home handler at `/`; another root never falls back to that manifest. The loader resolves only `<root>/src/web/routes.ts`. The manifest is ordinary trusted TypeScript, exporting a `routes` array. Use static imports as above; no automatic filesystem discovery or request-derived imports are provided. `Route` can optionally be imported as a type from this project's `src/web/router.ts`. Paths are case-sensitive, exact absolute paths made of ASCII letters, digits, `_`, `-`, and segment separators (or `/` itself). Single-segment `:name` parameters are supported; wildcards, optional segments, and trailing slash aliases are rejected. An optional `methods: ["GET", "POST"]` declaration enables those methods; omitting it enables GET and HEAD. Only unique GET, POST, PUT, PATCH, DELETE and OPTIONS declarations in a nonempty array are accepted. GET always enables HEAD; HEAD cannot be declared separately. Other methods do not enable HEAD. OPTIONS must be explicitly declared; the router does not generate automatic OPTIONS or CORS responses. The default scaffold URL uses the lower-kebab name; manual registrations must also avoid duplicates. Duplicate structural patterns (such as `/users/:id` and `/users/:name`), duplicate parameter names, ambiguous overlaps, invalid paths, non-callable handlers, malformed manifests, and manifest import failures refuse startup with a generic error rather than falling back to Home.

Automatic registration accepts only the exact generated manifest grammar, checked as source text without importing or executing it. Changing its formatting, comments, imports, or expressions opts it out of automatic edits. Arbitrary manually authored manifests (including this repository's Home manifest) are left byte-for-byte untouched: registration fails with an actionable import/entry snippet and creates no handler. Generate without `--register` and add the snippet manually in that case. No runtime discovery, computed imports, or request-derived imports are generated.

Registration stages both complete files before publication and uses exclusive hard links. A per-project lock prevents overlapping Bundle registrations; retry a busy operation. Existing manifests are compared by exact content and file identity, removed, and replaced exclusively. A caught publication failure restores the previous manifest and removes the new handler only if it still has the exact staged identity/content. Concurrent user changes are preserved; if rollback fails, the error reports incomplete rollback and retained recovery material. Filesystems must support hard links; unsupported publication fails safely.

This is rollback on caught I/O errors, **not a portable atomic two-file or crash-safe transaction**: readers can observe a brief gap during manifest replacement. Generate before starting/restarting the server. Process termination, power loss, or rollback I/O failure can require recovery; inspect files and any `.bundle-register-*` recovery directory before removing a stale `src/web/.bundle-register.lock`. Use a trusted workspace without concurrent external writers: content/identity checks cannot eliminate a hostile change between checking and unlinking. Real `src`, `src/routes`, and `src/web` directories and a regular manifest are required; symlinks are refused. Handler names follow `make:page` rules. Even `--force` cannot overwrite a handler.

To enable update/delete handlers, edit the manifest explicitly, for example `{ path: "/notes/:id", methods: ["PATCH", "DELETE"], handler: noteHandler }`. This route returns `Allow: PATCH, DELETE` for GET, HEAD, POST, PUT or OPTIONS without calling middleware or the handler. `make:route --register` continues to generate GET/HEAD defaults. Automatic registration accepts unchanged historical generated manifest headers and upgrades their optional method type when adding a route; custom method entries are manual code and require manual registration thereafter.

Allowed methods dispatch the registered handler with the original request, including its method, query and headers. GET also enables HEAD. HEAD returns its status/headers without a body; handlers must account for HEAD when doing work. Missing routes requested with GET/HEAD return 404. A method outside a route’s declaration returns 405 with its precise Allow header in stable GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS order. Unknown paths retain the default GET/HEAD policy: GET/HEAD return 404, other methods return 405 with `Allow: GET, HEAD`. Known `HttpError` instances with status 400, 413, or 415 return their deliberately safe message as plain text; all other handler throws, rejected promises, and invalid response contracts produce generic 500 responses without private messages. Pages mode does not pass request data to `render()`; routes mode does pass the original Request to handlers, so validate and escape any data they use.

Route middleware is optional and scoped to one matched route and an allowed method. Import `Middleware` and `Route` from `src/web/router.ts` (generated apps use their local adapter):

```ts
const authorize: Middleware = (request, next) =>
  request.headers.has("authorization")
    ? next() // Replace this example with real credential/session verification.
    : new Response("Unauthorized", { status: 401 });
const audit: Middleware = async (request, next) => {
  const response = await next();
  return response;
};
const routes: readonly Route[] = [
  { path: "/account", middleware: [audit, authorize], handler },
];
```

`Middleware` receives the original `Request` and `next: () => Promise<Response>`, and returns a `Response` or `Promise<Response>`. Listed middleware enters in order, then unwinds around the handler. Await or return `next()` to continue; return a response to short-circuit later middleware and the handler. Each middleware's `next()` dispatches at most once per request; a repeated call rejects. Registration validates middleware as an array of functions (empty is valid) and copies its entries at router creation, along with the existing handler/method snapshot. Later array or registration edits require a new router/restart. Function closures and external application state are not frozen.

Route patterns compile only when the router starts. Exact static routes win before parameter routes, independently of method and registration order; a static route's 405 never falls through to a parameter handler. For overlapping parameter routes, the route with more static segments wins when it is at least as specific in every position. Ambiguous overlaps such as `/a/:id` and `/:group/b` refuse startup and automatic registration. Matching uses only the startup handler table; captured values never select filesystem paths or imports.

Every middleware and handler in a request receives the same optional `RouteContext`, with `context!.params` exposing a frozen, null-prototype `Readonly<Record<string, string>>`. Static routes receive an empty map. Each dispatch gets its own context and params, including concurrent requests. Captures decode exactly once with `decodeURIComponent`: `/users/%E9%9B%AA` yields `userId: "雪"`, and `%252F` yields the literal value `%2F`. Empty captures, malformed escapes/UTF-8, decoded slash/backslash, NUL, C0/C1 controls, dot segments, or values exceeding **1024 decoded UTF-8 bytes** return secure `400 Bad Request` before middleware and method dispatch, without reflecting input. URL parsing may normalize literal or encoded dot segments before matching; normalized paths retain the normal routing policy. Unmatched and static paths retain exact matching and the existing 404/405 policy. Params are data; apply output escaping and application-specific validation when using them. See [route parameter test-first evidence](docs/route-params-tdd.md) and [HTTP method test-first evidence](docs/route-methods-tdd.md).

Middleware does not run for 404/405 responses or in pages mode, and does not change exact static path matching. Every allowed method receives its original request method; HEAD executes the chain and suppresses/cancels the final body. Final security headers override application values, including early responses. Unexpected middleware throws, rejected promises and invalid response contracts produce the same generic secure 500 as handlers; only actual supported `HttpError` instances expose deliberately public messages. Middleware is trusted application code with process privileges, not a sandbox or automatic authorization guarantee. It can catch downstream errors, read request bodies, or perform side effects; those choices and any asynchronous work it starts remain the application's responsibility. Do not detach `next()` or call it after returning a response. See [middleware test-first evidence](docs/middleware-tdd.md).

Framework route code can import `readJson` from `src/web/request.ts` and `HttpError` from `src/web/http-error.ts`. `await readJson(request, { maxBytes: 16 * 1024 })` returns `Promise<unknown>`; validate the value's shape before use. The default limit is 64 KiB; overrides must be positive safe integers. The helper requires `application/json`, optionally with a single `charset=utf-8` parameter (case-insensitive, quoted UTF-8 accepted). Other media types, charsets, and parameters return 415. Invalid declared Content-Length returns 400; a declared size above the limit returns 413 before reading. Declared length is only a preflight check, never a trusted streaming bound: actual UTF-8 bytes are counted regardless of absent or understated length, and exceeding the limit cancels the body and returns 413. Empty/whitespace bodies, malformed JSON, and invalid UTF-8 return 400. Errors never echo input. Unexpected stream/runtime failures remain generic 500 through the router.

`await readValidatedJson(request, yourSchema, { maxBytes: 16 * 1024 })` combines that same parser with a Bundle `Schema<T>` and returns `Promise<T>` inferred from the schema. It returns parsed output, including explicit string trimming, without coercion. A schema failure throws `HttpError(400, "Invalid request body")`; input, issue paths/codes/values and internal diagnostics are never attached or exposed. Parser errors retain their existing statuses/messages and unexpected failures remain generic 500 through the router. There is no configurable error message. `readJson` remains available with its existing `Promise<unknown>` behavior and options.

`new HttpError(400, "Safe public message")` marks a message as public; never pass request content, secrets, or internal diagnostics to it. The router recognizes only actual instances with status 400/413/415 and applies the same security headers and bodyless HEAD behavior. Callers supply schemas and database behavior. Generated apps import these utilities from their local Bundle dependency for the Notes API.

All responses enforce `nosniff`, `no-store`, a no-referrer policy, frame denial, and a restrictive CSP (`default-src 'none'`, with base, forms, and framing disabled), including handler success and error responses. Other handler headers and status are preserved. This CSP intentionally blocks scripts, styles, images, and external assets. No source, assets, or directory listings are served. Symlinked entry directories/files and non-regular entries are refused before import/listening.

The manifest, handlers, pages, and their transitive imports execute with process privileges. These checks constrain the entry point; they do not sandbox code, enforce static-import syntax, or constrain what trusted application code can import or do. The root and parent directories must be trusted against hostile concurrent replacement; entry checks cannot prevent those races or detect hard links. Restart after editing modules or registrations: Bun caches imported modules within a process, and the router snapshots registrations at startup.

This slice adds no dependencies, UI framework, TSX, route discovery, hot reload, asset pipeline, TLS, authentication, sessions, request validation layer, or production deployment tooling. Listener failures are CLI errors. Runtime tests exercise direct handlers and mocked listener installation, plus real CLI/HTTP tests where sockets are permitted. Socket tests skip only on `EPERM`; direct-handler and mock tests do not establish live HTTP behavior in that environment.

## Typed runtime validation

Import `schema`, `MAX_ISSUES`, and types `Schema`, `Infer`, `ParseResult`, and `ValidationIssue` from `bundle/src/validation/schema.ts` in generated apps (or `./src/validation/schema.ts` in this checkout). `index.ts` is the executable CLI, not a library barrel.

```ts
import { schema, type Infer } from "bundle/src/validation/schema.ts";
import { readValidatedJson } from "bundle/src/web/request.ts";

const noteSchema = schema.object({
  body: schema.string({ trim: true, min: 1, max: 1000 }),
  pinned: schema.optional(schema.boolean()),
});
type NoteInput = Infer<typeof noteSchema>; // { body: string; pinned?: boolean | undefined }
const data = await readValidatedJson(request, noteSchema, { maxBytes: 16 * 1024 });
// data.body is a string and trimmed; data.pinned is boolean | undefined.
```

Compose `schema.string({ min, max, trim, pattern })`, `schema.number({ min, max, integer, finite: true })`, `schema.boolean()`, `schema.literal(value)`, `schema.enum(["draft", "published"])`, `schema.array(item, { min, max })`, `schema.object(shape)`, `schema.optional(field)`, and `schema.nullable(field)`. Numbers always require finite values; literals accept finite numbers, strings, booleans, or null. Enums require distinct strings in a nonempty tuple. String length uses UTF-16 code units after optional trimming; array bounds count items. Length bounds must be nonnegative safe integers; numeric bounds must be finite; min cannot exceed max. Invalid configurations, unknown options, accessors in configuration, and foreign schema objects throw a fixed `Invalid schema configuration` error at construction. Definitions and options are snapshotted; regexes are cloned and reset for each parse, preserving their flags.

`safeParse(unknown)` returns `{ success: true, data }` or `{ success: false, issues }`. Issues contain **only** `{ path, code }`, never values, messages, regexes, expected literals, or private diagnostics. Paths use trusted schema field names and numeric array indices. Strict objects reject unknown own keys, reporting one `unknown_key` at the containing object so untrusted key names cannot leak. Field issues follow schema declaration order, arrays follow index order, and unknown-key issues follow known fields. The global `MAX_ISSUES` cap is 20 across nested schemas; traversal stops once it is reached. Size checks precede item validation. See the exported `IssueCode` union for stable codes.

Objects accept plain or null-prototype records with own data properties. Inherited fields, class instances, input accessors, and proxies are rejected without calling input getters, coercion hooks, validator callbacks, or proxy traps. Optional fields accept missing/undefined values; absent fields stay absent in successful output. `schema.nullable(child)` accepts explicit null and otherwise delegates to the snapshotted child parser with its existing validation and transformations. It infers `Infer<typeof child> | null` without coercion. Nullable alone does not make a field optional; use `schema.optional(schema.nullable(child))` for an optional nullable object field. Outputs are new containers, with safe own properties even for `__proto__`. This adds no package dependency; proxy detection uses Bun's built-in `node:util`. Schemas and regexes are trusted application configuration. The issue cap bounds diagnostics, not total valid input size or trusted regex execution time; continue using `readJson`'s streaming byte cap.

Generated Notes POST uses the strict `{ body: string }` schema with trimming and 1–1000 character bounds. It calls `readValidatedJson` with a 16 KiB cap; invalid shape returns 400 `Invalid request body`. Auth credential/password change handlers also use the helper with a 4096-byte cap, retaining the generic `Invalid credentials.` schema response, ASCII email semantic checks, and unmodified passwords with UTF-8 byte bounds. JSON/media/streaming-byte errors and successful response semantics remain unchanged. Test-first evidence is recorded in [validation tests](docs/validation-tdd.md) and [typed request boundary tests](docs/validated-request-tdd.md).

## Typed request context

Import `RouteContext`, `createContextKey`, and types `ContextKey`, `Middleware`, `Route` from `bundle/src/web/router.ts` (or the generated app's `src/web/router.ts` adapter). Each router dispatch creates a fresh context. Handlers receive it as optional argument two; middleware receives it as optional argument three, preserving `(request, next)` middleware. Keys require explicit symbols and carry invariant value types:

```ts
const userId = createContextKey<number>(Symbol("userId"));
const authorize: Middleware = async (request, next, context) => {
  context!.set(userId, 42); // after application authentication
  return next();
};
const route: Route = {
  path: "/private", middleware: [authorize],
  handler: (_request, context) => Response.json({ id: context!.get(userId) }),
};
// get(userId): number | undefined; delete(userId): boolean
```

Context maps are private to a dispatch, including concurrent dispatches of the same Request. Symbol identity determines key identity; use one shared declaration rather than recreating a symbol. Only trusted application code can access context. Store IDs or other minimal request state, never session cookies/tokens. Context values are not cloned, so application code must avoid inserting shared mutable objects when isolation matters. Route handlers and middleware arrays are snapshotted when the router is created.

Generated Notes mounts `requireAuth` explicitly on `/api/notes` in the manifest. POST requires exact Origin before any database/session lookup, then every GET/HEAD/POST requires a live session before Notes parsing or queries. Middleware stores only the numeric user ID; Notes uses an ORM reference by ID and never re-queries the user. A direct Notes handler call without authenticated context returns 401. Auth endpoints retain their own public login/register and endpoint-specific session policies. Test-first evidence: [request context and Notes middleware](docs/context-auth-tdd.md).

## Request schema generator

```bash
bun run bundle make:request CreatePost \
  --field title:string --field 'body:text?' \
  --field count:integer --field 'published:boolean?'
```

Creates `src/requests/CreatePost.ts` and prints `{ "created": "src/requests/CreatePost.ts" }`. The module imports `schema` and `type Infer` from `bundle/src/validation/schema.ts`, exports `createPost = schema.object(...)`, and exports `type CreatePost = Infer<typeof createPost>`. Acronyms become camel case (`HTTPInput` → `httpInput`). The generated app already declares a local Bundle dependency and includes request modules in its server typecheck. In another project, install a local `bundle` dependency pointing to this checkout. In a handler, use `const data = await readValidatedJson(request, createPost, { maxBytes: 16 * 1024 })`, importing the helper from `bundle/src/web/request.ts` and `createPost` from your generated module. Output is inferred; objects reject unknown keys. Use `createPost.safeParse(unknown)` directly when you need application-level validation issues.

Repeat `--field name:type` at least once. A trailing `?` on the type makes the field optional; quote it in shells. `string` trims and requires 1–255 characters; `text` trims and requires 1–10000 characters. `integer` accepts only finite integer numbers without coercion; `boolean` accepts only actual booleans. Optional fields retain these validations when present. In `make:request`, `?` permits omission/undefined only; it does not accept null.

Request names are PascalCase ASCII letters/digits, at most 64 characters, with device names and conflicting TypeScript identifiers rejected. Field names start with an ASCII letter followed by letters/digits/underscores, at most 64 characters; duplicate names and `constructor`/`prototype` are rejected. All names, specs, the 1–64 field count and 8192-byte generated source limit are checked before filesystem changes. No existing entry is overwritten, even with `--force`. Root ancestors, `src`, and `src/requests` must be real directories without symlinks. Complete source is staged and published with an exclusive atomic hard link; caught errors clean temporary files. Parent directories must remain trusted against concurrent replacement. Generation does not register routes or parse request bodies. Test-first evidence: [docs/request-scaffold-tdd.md](docs/request-scaffold-tdd.md).

## Generated app Notes API

Generated apps include local email/password auth (`POST /api/auth/register`, `/login`, `/logout`, `/password`, `GET /api/auth/me`) and session-protected Notes create/list at `/api/notes`. Passwords use Bun.password Argon2id; unique normalized ASCII email and password hashes live in SQLite. Sessions use random opaque tokens with only SHA-256 hashes and seven-day expiry in the database. Login/register rotate the presented session; logout revokes it. Authenticated password change verifies the current password, atomically replaces its Argon2id hash, revokes all sessions for that user and issues a fresh session cookie. A transactional hash comparison prevents stale concurrent changes from overwriting newer credentials. Cookies are HttpOnly, SameSite=Lax, Path=/, have no Domain and are Secure in production. Notes have a required owner relation; reads filter by the current user and writes take ownership from the session. Auth responses expose only ID/email; note responses expose only ID/body. Responses use no-store and generic unexpected-error messages.

Account includes a Sessions section backed by authenticated `GET /api/auth/sessions` and `DELETE /api/auth/sessions/:id`. Metadata is deliberately minimal: each entry is exactly `{id,expiresAt,current}`, with no token hashes or credentials. Only unexpired sessions are shown, capped at 50 newest first by descending ID; the current session can fall outside this window. No user-agent or IP information is collected. Revocation is owner-scoped; the current session returns 409, and foreign/missing/expired targets share a safe 404. DELETE checks the exact configured Origin before session/database lookup, accepts only canonical positive safe IDs and returns 204 with no-store on success. The UI validates response shapes/dates, refreshes after revocation and clears private list state across Account/session boundaries with stale response protection. Existing generated apps require reviewed manual integration; no schema changes or packages are required. See [session management TDD evidence](docs/frontend-sessions-tdd.md).

All mutations require an exact Origin match against configured `APP_PUBLIC_ORIGIN`, required as HTTPS in production. Development defaults to `http://127.0.0.1:${VITE_PORT ?? 5173}`, derived solely from configuration. Request Host/forwarded headers never establish trust. Register/login accept exactly email/password; password change accepts exactly currentPassword/newPassword, both with the same password bounds. Auth uses a 4 KiB JSON byte cap. Register/login apply bounded ASCII email normalization and preserve passwords exactly; Notes retain bounded JSON/body validation and a 100-row per-user list. See the generated README for exact policies and API examples. Generate/review/apply the initial migration with the CLI based on the app models before use; seeders create no shared account. Existing apps need an explicit data migration for old notes' ownership.

This is a development-only milestone, **not production auth readiness**. Production (`NODE_ENV=production` or `APP_ENV=production`) now fails closed before database/listener startup unless an explicitly shared `AuthAttemptLimiter` is injected into `createRoutes(env, limiter)` (or direct `createAuthHandlers(env, limiter)` calls). The bounded development default allows 20 register/login attempts per minute per handler set, resets on restart, and has no distributed or per-client guarantees; explicitly injecting that process limiter is also rejected in production. **Generated apps include an opt-in SQL `createDatabaseAuthAttemptLimiter(env)` factory and singleton model.** App authors must generate/apply its migration and explicitly inject it before deployment. The global SQL limiter now enforces a strict rolling 20-attempt/60-second policy with twenty bounded timestamp slots. Real SQLite concurrency and restart persistence are tested; the adapter supports SQLite only and refuses PostgreSQL/MariaDB until their runtime behavior and atomicity are verified. The model uses portable checks and remains usable in normal PostgreSQL/MariaDB app migrations. [Rolling-window TDD evidence](docs/auth-database-limiter-tdd.md#strict-rolling-window-milestone-2026-11-08) records the real boundary regression. Use a fixed static import in the app manifest; see the [generated deployment instructions](templates/app/README.md.tpl#limiter-injection-before-deployment). The shared marker is an application assertion, not verification of storage guarantees. [Limiter gate TDD evidence](docs/auth-limiter-tdd.md) records the failing generated-app test and verification limits. Passing the gate does not establish production auth readiness: public deployment still needs reviewed throttling policy, concurrency controls, recovery and operational hardening. The generated React UI supports register/login/logout, Account → Change password, bounded active-session listing and revocation of other sessions, plus authenticated Notes create/list with HTTP-only cookies, strict response checks and account-bound async state. Email verification, password recovery and MFA are not included. Password-change 401 responses revalidate `/api/auth/me`; only confirmed expiry clears the account. Tests use the generated manifest router plus direct handler checks and real isolated SQLite; `scripts/verify-app.ts` performs actual generated-app installation, typecheck/tests/build and CLI migration plus register/login/me/password-change/Notes/logout acceptance. It also checks rendered account controls; opt into React DOM/SQLite interactions with `BUNDLE_ACCEPTANCE_DOM_MODULE` or real Firefox/HTTP interactions with `BUNDLE_ACCEPTANCE_FIREFOX=1`. See the [generated app guide](templates/app/README.md.tpl#frontend-acceptance-for-framework-maintainers) for requirements and commands. [Password-change TDD evidence](docs/frontend-password-tdd.md) and [resource frontend TDD evidence](docs/frontend-resource-tdd.md) record the latest behavioral RED, verification results and Firefox acceptance. [Initial account/Notes TDD evidence](docs/frontend-auth-notes-tdd.md) is retained as historical milestone documentation.

## SQLite queue and one-shot worker (early milestone)

The current app scaffold includes a bounded SQLite queue table, schema-validated static job dispatch, `bun run work:once`, and `make:job` for editable typed handler skeletons. Generate one with `bun run bundle make:job SendWelcome --type mail.welcome --field email:string`; the command prints the fixed import and registry entry, which you must add to `src/jobs/registry.ts` after implementing the generated fail-closed TODO. No generated job is silently registered or processed before you wire it up. There is still no continuously polling worker, so applications must schedule/repeat the one-shot command themselves. Runtime support is SQLite-only and delivery is at-least-once; this is not production-ready background processing. The generated app README documents the API and constraints.

## Database quick start

SQLite works without a database server:

```bash
bun install
bun run bundle migrate
bun run bundle db:seed
bun run bundle db:show
bun run bundle db:table users
```

The local database is `.data/bundle.sqlite`. Seeding adds explicit demo data; it is not an authentication setup.

```bash
bun run bundle list
bun run bundle make:model Product
bun run bundle make:migration add_products
bun run bundle migrate
bun run bundle migrate:status
```

Model fields can be scaffolded with repeated `--field` options or edited before generating a migration. MariaDB and PostgreSQL drivers and separate migration directories are also configured; choose the connection in `.env` using `.env.example`. Their live integration tests require external disposable databases and are skipped when no test URLs are supplied.

See [the database guide](docs/database.md) for model usage, connection options, migration safety, and the database support/verification matrix. The [Artisan-inspired migration guide](docs/migrations.md) documents batch rollback, step/batch selection, SQL previews, named connections, custom migration paths, deployment isolation, schema dumps/pruning, and deliberate differences from Laravel.

```bash
bun run bundle migrate --step --isolated
bun run bundle migrate:rollback --pretend
bun run bundle migrate:rollback --step 1 --force
bun run bundle migrate:install
bun run bundle schema:dump --isolated
```

`make:model Product --field title:string --field price:number --field 'description:text?' -m -s` scaffolds a typed model, diff migration and seeder after the initial migration baseline has been applied. With no fields, the existing id/timestamps scaffold is unchanged. Allowed types are `string`, `text`, `integer`, `number` (double), `boolean`, `date` (`Date`), and `json` (recursive JSON values). A trailing `?` emits an optional TypeScript property, includes it in MikroORM `OptionalProps`, and maps it as `nullable: true`; callers can omit it or pass `null`.

Required `json` fields accept non-null JSON values at the root (nested nulls are supported). Use `json?` to allow SQL NULL or omission at the root, keeping required JSON fields required in MikroORM creation data.

At most 64 fields are accepted, in argument order. Field names are 1–64 ASCII letters/digits/underscores beginning with a letter. Invalid specs, source snippets, reserved identifiers/object members, built-in id/timestamps, and duplicate names (ignoring case/underscores to avoid column collisions) fail before filesystem or database work. Model names are bounded to 64 characters. Existing files, symlink entries and symlink directories are refused, even with `--force`; work in a trusted directory without concurrent parent replacement. The CLI never edits existing models.

`--migration` generates a diff only after the model is written; it never applies migrations. Review the migration and run `migrate` separately. A failed migration generation returns an error that identifies the preserved model (and seeder, when created), so you can fix the cause and retry `make:migration`. File writes are outside database transactions; the command does not promise an atomic model/seeder/migration operation.

## Development

Install dependencies:

```bash
bun install
```

Run the entry point:

```bash
bun run start
```

Run with automatic restarts when files change:

```bash
bun run dev
```

Check TypeScript types:

```bash
bun run typecheck
```

The entry point is `index.ts`, which runs the Bundle CLI. `bun run start` shows its command list; pass a command to execute it. No web/UI framework, application build pipeline, or linter has been added yet.

Run the Bun tests:

```bash
bun test
```

Run just the corpus tests:

```bash
bun test ./src/graph/corpus.test.ts
```

## Feature reference and JSON graph

[PROGRESS.md](PROGRESS.md) contains the Laravel CLI feature checklist for reference. It does not indicate that Laravel is installed or that those features have been implemented.

[graph/](graph/README.md) contains a generated JSON corpus and knowledge graph of the entire checklist, including its sections, items, commands, notes, examples, and sources. It is local data, not a GraphQL server.

```bash
bun run graph:build   # Regenerate JSON from PROGRESS.md
bun run graph:check   # Verify JSON is current without rewriting it
```

The original Markdown is preserved verbatim in the corpus, and extracted records link back to source lines. Edit `PROGRESS.md` and regenerate; do not hand-edit the generated JSON.

### Project skill

The project-local [progress-graph skill](.claude/skills/progress-graph/SKILL.md) provides these Claude Code workflows:

```text
/progress-graph          Rebuild the corpus and run validation
/progress-graph sync     Rebuild the corpus and run validation
/progress-graph check    Validate without rewriting artifacts
/progress-graph inspect  Summarize the corpus without modifying files
```

Add task details to inspect particular records or request a source/generator update. The skill preserves the source-of-truth rules and does not treat documented features as implemented capabilities.


### Generated owner-scoped REST CRUD

Inside a newly generated, installed/linked app:

```sh
bun run bundle make:resource Task --field title:string --field 'body:text?' --field done:boolean
# Offline scaffold by default. After the app migration baseline exists:
bun run bundle make:resource Project --field title:string --migration
# Review the generated diff before applying through the app CLI:
bun run bundle migrate
```

The generated authenticated frontend now includes resource CRUD pages. `make:resource` writes an editable typed `src/resource-pages/Task.tsx`, registers it through the exact static `src/resource-pages.tsx` manifest imported by App, and exposes a Task navigation link at `#/tasks`. Account and Notes UI stays available at `#/notes`. The command never rewrites App or previous pages. Pages support create, bounded list, edit via PATCH (including explicit null), delete, loading/empty/error states, strict runtime response validation, and session-bound stale-response rejection. No frontend dependency or browser token storage is added. See [frontend resource design and TDD evidence](docs/frontend-resource-tdd.md).

The command generates a typed owner model with cascade deletion, strict Create/partial Update schemas (empty updates rejected), a static handler, and exact static registrations at `/api/tasks` and `/api/tasks/:id`. It supports string, text, safe integer, finite number and boolean fields, with optional `?`. For resources, `?` means database nullable: create permits omission or explicit null, and PATCH accepts null to clear the column to SQL NULL. Omitted PATCH fields remain unchanged; nonnullable fields reject null on both create and PATCH, and empty PATCH objects return 400. This differs from `make:request`, where `?` means optional only. Collection GET returns a JSON array of at most 100 ascending owner-scoped IDs per page. Optional `?after=ID` is an exclusive canonical positive safe integer cursor; unknown/duplicate query parameters and invalid cursors return safe 400. `X-Has-More: true|false` comes from a 101-row lookahead. The shared frontend provides Previous/Next navigation with a page indicator and saved cursor boundaries. New rows have higher IDs; deletes can shorten or empty a page, and Previous remains explicit. Pages are live keyset views rather than snapshots; POST creates; item GET/PATCH/DELETE read/update/delete. Authentication comes from existing session/context middleware; all item queries include the owner. Every mutation requires the fixed Origin, including PATCH/DELETE. JSON output explicitly selects id and declared scalar fields. Notes behavior remains intact.

Generation requires unchanged generated User/Session/auth/router/CLI/app routes, the exact paired resource manifests, unchanged shared frontend runtime and the linked Bundle typed validation module. It rejects absent/untrusted prerequisites before writes, never executes registration code and never overwrites existing artifacts. Staged exclusive publication rolls back only unchanged generator-owned files and retains recovery material if concurrent edits prevent rollback. This is caught-error rollback, not a crash-atomic transaction; keep the app stopped during generation and inspect recovery material/lock after interruption. Older/customized apps require manual integration. `--migration` uses the existing production/baseline guards, generates a diff for review and never applies it; a later migration-generation failure preserves the scaffold. See [resource contract, limits, TDD and crash recovery](docs/resource-crud-tdd.md).
