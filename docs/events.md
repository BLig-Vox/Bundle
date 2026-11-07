# Local events and executable registrations

Bundle's event bus is a code-only local runtime, not Laravel/PHP event interoperability or a durable queue. Listeners run in the calling process; there is no automatic transaction/rollback, delivery persistence, retry, timeout or cross-process broadcast.

## Direct dispatch

```ts
import { EventBus } from "./src/events/bus.ts";

const bus = new EventBus();
const unsubscribe = bus.on("invoice.created", async (payload, signal) => {
  if (signal.aborted) return;
  console.log(payload);
}, { name: "audit-invoice" });

await bus.dispatch("invoice.created", { id: 7 });
unsubscribe();
```

Event names are 1–256 ASCII letters/digits/underscore/dot/colon/hyphen, beginning with a letter or digit. Listeners receive the original `unknown` payload and an AbortSignal; validate application payloads yourself. `on(event, listener, {name?}?)` returns an idempotent unsubscribe bound to that registration, even if the same function is registered more than once. An optional display name is bounded and rejects control characters; otherwise the callback's function name (or anonymous label) is used.

`dispatch(event, payload, signal?)` snapshots registration order and awaits listeners sequentially. Subscribing/unsubscribing during a dispatch affects future snapshots, not the current one. Listener failures are collected in order and raised as an AggregateError after other eligible listeners run; side effects are not rolled back. Cancellation is cooperative: it awaits the active listener and skips later listeners once aborted, without treating cancellation alone as an exception or forcibly terminating work. Do not assume a resolved dispatch means every listener ran when its signal was aborted.

`describe()` returns independent metadata snapshots with `{event, listeners: count, listenerNames: [...]}`. It never calls listeners or serializes callback source. Registrations preserve declaration order, not a global lexical sort.

## Application registrations

A trusted root `events.ts` default-exports branded descriptors:

```ts
import { defineEvents } from "./src/events/definitions.ts";

export default defineEvents([
  {
    event: "invoice.created",
    listeners: [
      { module: "src/listeners/InvoiceAudit.ts", export: "InvoiceAudit", method: "handle" },
    ],
  },
]);
```

With `method`, the export must be a class with an own prototype method; hydration creates a fresh instance for each listener invocation. Without `method`, the export must be a function. Names in inspection are executable references such as `src/listeners/InvoiceAudit.ts#InvoiceAudit.handle`. Modules must be safe root-relative `.ts` files, without traversal, declaration-file suffixes, symlinked parents/files or multiply linked files. Direct references to root `events.ts` are rejected. Trusted transitive imports may still execute it and other side effects; this is not a sandbox.

`defineEvents` validates, copies and deeply freezes the dense plain descriptors. Ordinary arrays and arbitrary EventBus instances are not cacheable application registrations. `hydrateEvents(root, definitions)` resolves references into a real bus. `loadApplicationEvents(root)` in `src/events/cache.ts` prefers the valid cache; without a cache it loads `events.ts`, and when both are absent it returns an empty bus. Invalid sources/caches fail, never silently produce an empty registry.

## CLI and cache

```sh
bun run bundle event:list --json
bun run bundle event:cache
bun run bundle --force event:cache
bun run bundle event:clear
```

Listing imports trusted code and resolves exports but does not invoke listeners; text and JSON show both events and listener identities. `event:cache` validates/hydrates before atomic mode-0600 bounded publication at `bootstrap/cache/events.json`. Versioned JSON stores executable module references, never functions; the cache is limited to 1 MiB. Existing caches require explicit force for replacement. Valid caches take precedence before directly importing the registration entrypoint, and actual subsequent processes can dispatch their listeners. Referenced modules and dependencies are still imported normally.

Clear is idempotent and touches only the event cache, preserving configuration, application-cache data and unrelated locks. It validates format before deletion; corrupt/unrelated content and unsafe filesystem artifacts are preserved for manual inspection. No automatic stale-lock expiry is provided.

**Bun module lifetime:** trusted imports retain normal ESM caching, matching route/configuration APIs. Rebuilding changed source uses a fresh CLI process; repeated programmatic builds/loads in one process do not promise source reevaluation or hot reload. Replacing/clearing a disk cache does not replace a bus already held by an application, or freeze listener source code into the JSON.

## Consumed event/listener generators

```sh
bun run bundle make:event Billing/InvoiceCreated
bun run bundle make:listener Billing/RecordInvoice
```

These exclusively create `src/events/Billing/InvoiceCreated.ts` and `src/listeners/Billing/RecordInvoice.ts`. Nested PascalCase names are supported; unsafe/reserved names (including `AbortSignal`), destination symlinks and overwrites are refused. The event exposes static `eventName` and `dispatch(bus,payload,signal?)` against the actual EventBus. Its identity includes every namespace segment, each converted to kebab case and joined with dots: `Billing/Deep/HTTPInvoiceCreated` becomes `billing.deep.http-invoice-created`, distinct from `Shipping/Deep/HTTPInvoiceCreated`. The entire resulting identity must fit the bus's 256-character bound.

The listener has an own `handle(payload:unknown,signal:AbortSignal)` method with explicit example/no-policy behavior. Replace it with application logic and register its executable reference explicitly in `events.ts`; generation neither discovers nor registers listeners automatically. Required runtime imports are computed relative to nested destinations. Of the twenty-six published `.ts.stub` templates, event requires `{{name}}`, `{{runtimeImport}}`, `{{eventName}}`; listener requires `{{name}}`. Customized listener output is exercised through a real cached registration and separate CLI dispatch, including namespace separation.

## Generate missing registered listeners

```sh
bun run bundle event:generate
```

This reads trusted source `events.ts` through the existing branded `defineEvents` contract, deliberately ignoring cached registrations for generation. Missing source refuses; a valid empty source reports empty `created`/`existing` arrays. Bundle event identities are strings, so dispatch does not require event classes; this command does not invent event classes from arbitrary names. `make:event` remains the optional typed producer helper.

Missing references are generatable only as `src/listeners/<nested PascalCase>.ts` with the matching leaf export and `method:"handle"`. The existing consumed listener stub supplies the own-handler class, including trusted custom overrides. Existing checked regular single-link files are preserved without importing them; existing function references and files outside the generation directory remain available to ordinary event consumers. Generation does not validate existing module exports or rewrite registrations/cache.

At most128 events and256 total references; repeated paths are deduplicated. All reference/target-parent/name/template checks finish before publication starts. Unsupported missing references, unsafe parents/files and invalid templates refuse before output. Writes are exclusive; even global `--force` never overwrites listener code. Output JSON lists repository-relative `created` and `existing` paths.

Publication is not a multi-file transaction: a later filesystem I/O failure or concurrent exclusive-create conflict may leave earlier newly generated files for inspection while returning failure. No rollback/hostile tree-replacement guarantee is claimed. Fixed Bun ESM caching and trusted-source side effects retain ordinary limits; no listener is invoked by generation. Actual separate-process tests strictly compile default/custom outputs, preserve source/cache/existing bytes and dispatch through a real cache; the customized handler performs observable work only on dispatch.

Queued listeners and listener dependency injection remain unfinished. Durable jobs have a separate [local queue runtime](queues.md); local event dispatch does not automatically enqueue, retry or persist a listener. No external-service claim follows from either runtime.
