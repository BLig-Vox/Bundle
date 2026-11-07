# Code-first HTTP foundation

This is Bundle's bounded Bun-native Request/Response backend runtime, not Laravel/PHP interoperability. Router dispatch, worker-backed serving, validation/resources, executable route caches and their generators have local process/HTTP evidence. Generated applications use a separate React TSX view frontend; it does not alter backend route/controller contracts. Persistent maintenance enforcement is integrated separately below. Authentication and managed reload remain unfinished capabilities.

## Routes and local development

Create a trusted root `routes.ts` with a default-exported router:

```ts
import { createRouter } from "./src/http/router.ts";

const router = createRouter();
router.add("GET", "/health", () => Response.json({ healthy: true }), { name: "health" });
router.add("GET", "/greet/:name", ({ params }) => Response.json({ greeting: params.name }));
export default router;
```

```sh
bun run bundle route:list --json
bun run bundle route:list --path greet --method GET --verbose
bun run bundle serve --host 127.0.0.1 --port 8000
```

`route:list` loads trusted route code or the valid route cache and reads metadata without invoking request handlers or opening an ORM connection itself. `--path` and `--name` are substring filters; `--method` selects one method. Verbose text includes middleware names. JSON includes all safe registered metadata, one row per method. Imports may execute application side effects and retain normal Bun ESM caching; descriptor controller instances are created only for requests. Route listing is not sandboxed, cancellable module evaluation or automatic hot reload.

`serve` defaults to loopback port 8000. Port 0 chooses an ephemeral port and the CLI prints a JSON readiness record with its actual URL. Binding another interface must be explicit. Occupied ports fail instead of being silently shared. `--timeout <milliseconds>` stops successfully after the requested running duration; SIGINT/SIGTERM produce 130/143. An owned Bun worker imports routes and owns the listener. Startup cancellation terminates only that worker even if a route import never settles. Shutdown closes the listener and active connections; a worker still unresponsive after 250 ms is terminated without terminating the embedding host. This does not undo trusted external side effects or spawned processes. It is a development listener, not a production deployment/process manager or security sandbox. Without a valid cache, a missing or unsafe root `routes.ts` fails; there is no silent empty application. Source/module files and their parents reject symlinks/hard links as applicable.

On Linux the worker also serves verified GET/HEAD files beneath the application's `dist/` directory using opened directory/file descriptors; it refuses symlink path components and unavailable/unsafe assets. Native `createRouter()` route misses may fall through to those assets, with `index.html` used for HTML-accepting SPA paths. A matched handler's 404 is preserved. Custom router implementations expose no route-miss distinction, so their 404 responses retain the legacy status-based static fallback. `/api` paths never use static fallback. This production static integration is not yet portable to non-Linux systems.

The programmatic `startApplicationServer({ root, host?, port?, signal? })` returns `{ url, closed, stop() }`. Stop is idempotent; `closed` observes owned-worker closure, including unexpected exit. The signal controls startup only; the caller owns later API shutdown. The CLI separately wires its running lifetime to signals/timeouts and reports unexpected worker closure as failure.

## Executable route cache

For cacheable routes, keep handlers and middleware in separate trusted root-relative TypeScript modules and default-export branded definitions from `routes.ts`:

```ts
import { defineRoutes } from "./src/http/route-definitions.ts";

export default defineRoutes([
  {
    method: "GET", path: "/customers/:id", name: "customers.show",
    handler: { module: "src/http/controllers/ShowCustomer.ts", export: "ShowCustomer", method: "handle" },
    middleware: [{ module: "src/http/middleware/Audit.ts", export: "Audit" }],
  },
]);
```

A handler reference without `method` resolves an exported function. With `method`, it resolves an exported class with an own prototype method and constructs a fresh instance per request. Middleware references resolve functions. `defineRoutes` validates/copies/deep-freezes descriptors; ordinary arrays and closure-based Router instances are explicitly uncacheable, not serialized as inert metadata. Direct handler/middleware references to the root `routes.ts` entrypoint are rejected. Modules must use safe root-relative `.ts` paths, with no traversal, symlinked parents/files or multiply linked files. Imported modules remain trusted executable code.

```sh
bun run bundle route:cache
bun run bundle route:list --json
bun run bundle --force route:cache  # explicitly replace an existing cache
bun run bundle route:clear
```

`bootstrap/cache/routes.json` contains versioned executable module references, never serialized function source. Publication is atomic, mode 0600 and bounded to 1 MiB; existing caches require explicit `--force`. Both inspection and worker serving consume a valid cache before directly importing the `routes.ts` entrypoint. Corrupt/unsafe caches fail rather than silently falling back. Hydration still imports referenced handlers/middleware and their dependencies: those trusted modules can import `routes.ts` transitively, so avoiding such dependencies is an application responsibility, not a no-code-execution guarantee. Cache clearing is idempotent and touches only this cache, preserving configuration and operational locks. Handler source is not frozen into the cache; restart an existing server to load changes. Clearing/rebuilding does not hot-reload an already running worker.

## Router and middleware APIs

`createRouter()` returns a `Router` with:

- `add(method: string | readonly string[], path, handler, { name?, middleware? }?)`, returning itself.
- `fetch(request: Request): Promise<Response>`.
- `describe()`, an independent serializable metadata snapshot, not an executable cache.

A handler receives `{ request, params, state }`. Params are frozen null-prototype records; state is a fresh per-request `Map<string, unknown>`. The original Request and its AbortSignal pass through for cooperative cancellation. Middleware receives the same context and `next(): Promise<Response>`; it runs in registration order and may short-circuit. Calling next twice fails. Functions/classes are not serialized into metadata.

Paths are case-sensitive; query strings do not participate, and trailing slash is significant. Only root or slash-delimited ASCII unreserved literals and `:identifier` parameters are supported. Wildcards, optional patterns, dot/empty segments, encoded registration paths and ambiguous incomparable overlaps are rejected explicitly. Duplicate names and same-shape method/path collisions fail before serving. URL segments decode independently; malformed encodings return 400, and an encoded slash stays inside its parameter rather than creating a new segment.

Specificity is selected **before** method matching. For example, a literal `/items/new` is selected ahead of `/items/:id` even when only the parameter route supports the incoming method. A resulting method mismatch is 405, not fallback to a less-specific path. Missing paths return 404; method mismatches include a sorted Allow header. OPTIONS is automatic unless explicitly registered, and HEAD falls back to GET unless explicitly registered. HEAD responses have no body; discarded body cancellation is best-effort and rejection-observed, not awaited indefinitely. Locked/noncooperative streams can still retain their own resources.

Thrown/rejected handlers, invalid non-Response returns and unhandled middleware failures become a generic 500 response with `Cache-Control: no-store` and without stack/exception text. The Router itself does not automatically authorize requests or sanitize data a trusted handler explicitly returns.

## Explicit authorization policies

`bun run bundle make:policy Billing/InvoicePolicy` creates a class under `src/http/policies/Billing/InvoicePolicy.ts`. Its own `can(context:PolicyContext)` method **denies everything by default**; replace it with application decisions and register the guard explicitly. The eighteenth `stubs/policy.ts.stub` consumes `{{name}}`/`{{runtimeImport}}`, with nested imports, strict compilation and no-overwrite/symlink checks. Policy type-name collisions are refused or avoided by generated import aliases.

```ts
import { policyMiddleware } from "./src/http/authorization.ts";
import { InvoicePolicy } from "./src/http/policies/Billing/InvoicePolicy.ts";

const guard = policyMiddleware({
  policy: new InvoicePolicy(),
  ability: "invoice.read",
  principal: () => null, // anonymous example, NOT authentication
  resource: ({ params }) => ({ id: params.id }),
});
router.add("GET", "/invoices/:id", () => Response.json({ example: true }), {
  middleware: [guard],
});
```

This example denies all requests until the application deliberately supplies real policy logic. **Authorization is not authentication:** the library supplies no user/session/token verification, and it does not turn a request header into a trusted identity. Provide authenticated principal resolution separately; null/undefined principal is just an explicit input that a policy can allow or deny. Guards are not installed automatically on other routes. Resource resolution is application code, not a model-binding/tenant-isolation system.

`AuthorizationPolicy` has `can(context):boolean|Promise<boolean>`; `PolicyContext` is `{ability,principal,resource,signal}`. Abilities are1–128 ASCII characters matching `[A-Za-z][A-Za-z0-9_.:-]*`. `evaluatePolicy(policy,context)` validates and awaits a **strict boolean**, preserving original class-instance binding. `authorizePolicy` throws a fixed generic `AuthorizationDeniedError` only on false. Truthy strings/objects, malformed policies and thrown/rejected decisions are errors, never implicit allows.

`policyMiddleware({policy,ability,principal,resource?})` validates its declaration, resolves data independently per request and checks authorization before next. Denial returns `{error:"Forbidden"}`,403 and `Cache-Control:no-store`, without echoing principal/resource/ability or exception data. Invalid/throwing policies propagate to the Router's generic500; unrelated downstream handler failures are not converted into denial. Request AbortSignal is checked before/after awaited resolution/decisions. Trusted noncooperative policies/resolvers are not forcibly terminated, and ordinary module caching remains; reload is not implied. Actual CLI-generated/default/customized policy classes are consumed by live HTTP worker requests, with guest/other denial, explicit fixture-identity allowance and strict/throwing fail-closed cases.

## Validation

`src/http/validation.ts` provides typed code-only rules and structured safe errors:

```ts
import { rules, validateRequest } from "./src/http/validation.ts";

const input = rules.object({
  name: rules.string({ min: 1, max: 100 }),
  enabled: rules.optional(rules.boolean()),
});

router.add("POST", "/customers", async ({ request }) => {
  const result = await validateRequest(request, input, { maxBytes: 16_384 });
  if (!result.ok) return Response.json({ errors: result.errors }, { status: 422 });
  return Response.json({ customer: result.value }, { status: 201 });
});
```

Available factories are `string({min?,max?,email?})`, `number({min?,max?})`, `boolean`, `enum(values)`, `array(rule,{min?,max?})`, `object(shape)`, `optional(rule)`, `nullable(rule)` and `custom(rule, callback)`. There is no implicit scalar coercion. `validate(rule, value, { unknown?: "fail" | "strip", signal? })` returns `{ok:true,value}` or `{ok:false,errors:[{path,code}]}`. Unknown fields fail by default. Errors omit submitted values and custom thrown exception messages. Plain objects/arrays only; unsafe keys/accessors/lossy input are refused. Custom callbacks are trusted code, not sandboxed; external work must cooperate with its signal.

`validateRequest` requires an explicit byte limit, reads UTF-8 JSON as a bounded stream and accepts application/json or application/*+json. Wrong type, excess bytes and cancellation stop body consumption. It combines the Request signal with a supplied signal. It is not a DB uniqueness, authorization, internationalized email or Laravel FormRequest implementation. Dot-separated error paths can be ambiguous for field names containing dots.

## JSON resources

`resource(item, transform, options?)` and `resourceCollection(items, transform, options?)` in `src/http/resources.ts` produce JSON Responses with `{data, meta?}` and optional collection pagination. Transforms must explicitly choose fields; passing a model unchanged is not automatic secret protection.

Options include status/headers and JSON-safe metadata. Collections accept `{pagination:{page,perPage,total}}` and add `lastPage` (at least 1). Invalid paging, cycles, accessors, unsafe keys, nonplain objects, sparse arrays, nonfinite numbers, negative zero and other lossy values are rejected rather than silently stringified. Transform callbacks are trusted executable code. These helpers supply no authentication or authorization policy.

## Live maintenance mode

```sh
bun run bundle down --retry 60 --refresh 10
bun run bundle up
```

The HTTP worker reads `storage/framework/down.json` **before each request**, so down/up affects an already-running listener without restart. Active state returns JSON 503 with `Cache-Control: no-store` and optional Retry-After/Refresh seconds. Retry permits integers 0–86400; refresh permits 1–86400. The status is fixed at 503; no secret bypass, redirects, rendered markup or arbitrary response-status flags are implied. Previously accepted requests are not retroactively canceled.

`enableMaintenance(root,{retrySeconds?,refreshSeconds?}?)`, `disableMaintenance(root)`, `readMaintenance(root)` and `maintenanceResponse(root,request)` live in `src/maintenance/maintenance.ts`. Caller root aliases resolve to the canonical application root; parents beneath it must be real directories. State is strict versioned JSON, bounded to 4096 bytes, atomically written at mode 0600. Existing corrupt, multiply linked, symlinked or incorrectly permissioned state is refused and preserved. The worker fails closed with a sanitized 503 if state cannot safely be read. `up` is idempotent when absent, but never deletes corrupt/unowned content to force recovery. Inspect and repair unsafe state manually.

Mutations use an exclusive owned `storage/framework/.down.lock`; stale locks require inspection and have no unsafe automatic expiry. State, temporary files and this lock are gitignored. Other storage files, caches and operational locks are preserved. Filesystem safety assumes no hostile concurrent tree renaming; maintenance is an application gate, not authentication or a network security perimeter.

## Runtime-backed generators

`make:controller`, `make:middleware`, `make:request`, `make:resource` and `make:rule` take a PascalCase name (optionally slash-separated) and generate TypeScript under the corresponding `src/http/` directory. Their relative runtime imports work for nested destinations. They refuse overwrites, reserved names and unsafe destination parents. `make:policy` separately emits a deny-default authorization class as described above. `stub:publish` includes seven HTTP-related templates among26 `.ts.stub` overrides, including the paired model-resource controller variant. HTTP templates require `{{name}}` and `{{runtimeImport}}`; resource-controller additionally requires `{{contextImport}}`, `{{modelName}}` and `{{modelImport}}`.

Generated controllers expose `handle(HttpContext): Response`; middleware is explicitly pass-through. Requests validate an example bounded JSON `name` field, resources explicitly choose an example `name` field, and rules demonstrate a custom string predicate. Replace these examples with application requirements. Generated code is exercised through actual requests and strict checking. Paired `make:controller Api/UserResourceController --resource --model User` now emits five own methods consumed by explicit per-request native ORM middleware; manager/validation/id/serialization and route registration are application-owned. Ordinary no-option controllers retain handle. See [model resource controllers](model-resources.md) for actual CRUD, isolated manager ownership, cache methods and cancellation limits. Automatic authorization, DB uniqueness rules, session/auth consumers and PHP FormRequest semantics are not implied.
