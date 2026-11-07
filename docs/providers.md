# Explicit local application providers

Providers register real services in the existing ServiceContainer, then boot before trusted command modules are imported. They are local executable application code, not sandboxed plugins, dependency downloads or automatic class discovery. Explicit [package metadata](packages.md) can separately group/cache provider references; package installers are not implied.

```sh
bun run bundle make:provider Billing/LoggingProvider
```

This creates `src/providers/Billing/LoggingProvider.ts`. Generation never registers it automatically or opens a database. Add an explicit root `providers.ts`:

```ts
import { defineProviders } from "./src/console/providers.ts";

export default defineProviders([
  { module: "src/providers/Billing/LoggingProvider.ts", export: "LoggingProvider" },
]);
```

The default generated example registers singleton key `provider:Billing.LoggingProvider`; its factory returns the instance's message, changed from registered to booted by the boot hook. Replace this demonstrative service with application behavior. Custom commands can resolve it through `context.services.resolve<string>("provider:Billing.LoggingProvider")`. No decorator injection, async service factory or automatic root-manifest edit is implied.

## Lifecycle and ownership

`ApplicationProvider` supplies an own prototype `register(context)` method and optional own prototype `boot(context)` and `dispose()` methods. Hooks may be asynchronous; ordinary ServiceContainer factories remain synchronous. Classes are constructed without arguments. Inherited, accessor or instance-shadowed hooks refuse.

ProviderContext is frozen and contains the canonical absolute root, shared container and cooperative AbortSignal. Each outer `runCli`:

1. Loads and validates the explicit provider registry, preflighting all referenced module paths before provider imports.
2. Constructs/registers providers in reference order, then boots all providers in that order.
3. Starts command lifecycle/scopes and imports trusted custom commands only after successful boot.
4. Gives nested `context.call` invocations fresh service scopes on the same initialized container, without repeated provider registration/boot.
5. Settles command scopes, disposes instantiated providers in reverse order, then disposes the runner-owned container and singleton resources.

Failure/cancellation during bootstrap prevents command import/parsing and attempts reverse cleanup of instantiated providers. Provider cleanup is idempotent and attempts every hook despite failures. Generic Bundle provider diagnostics do not print trusted exception messages. A constructor that throws cannot return an instance for cleanup, and arbitrary constructor/import side effects are not undone.

SIGINT/SIGTERM handling stays active through asynchronous provider and container cleanup, preserves130/143 and is removed afterward. `handleSignals:false` preserves host signal ownership; hosts may still pass an AbortSignal. Cleanup error output is deferred until owned disposal is attempted, so a throwing error sink cannot skip container cleanup. Uncooperative imports/hooks cannot be forcibly stopped; no process boundary or rollback is claimed.

Services/resources registered into the container retain its ordinary ownership rules. Providers must not separately own/dispose the same container-owned resource. Provider disposal precedes singleton disposal; design dependent cleanup accordingly.

## Embedding

Automatic root-provider bootstrap refuses a nonempty registry when `runCli` receives a caller-owned `context.container`, without importing referenced providers or mutating/disposing that container. Repeated automatic registration would otherwise leave services bound to disposed provider instances or collide on later calls. Empty/absent registries preserve ordinary caller-container behavior.

Hosts can explicitly compose `loadProviderDefinitions(root,signal?)`, `bootProviders({root,container,signal?,definitions?})` and build-only `createApplicationCli`. The backend's returned `{dispose()}` owns provider instances only, never the supplied container. The host must own service scopes, parsing/status handling, signal subscriptions, provider disposal and container disposal (including failures). `createApplicationCli` itself never automatically imports or boots root providers. Do not use nested independent `runCli` calls on the same configured caller container expecting an implicit shared provider lifetime.

## Definitions and loading limits

`defineProviders` returns a copied/frozen dense array of at most64 unique closed own-data `{module,export}` references. Module names are bounded256 ASCII characters and must identify safe root-relative `.ts` files; absolute/traversal paths, `.d.ts`, root `providers.ts`, accessors, sparse/extra/symbol keys and duplicate pairs refuse. Export identifiers are bounded128 ASCII characters and reject constructor/prototype/__proto__.

Missing root `providers.ts` means no direct providers; valid explicitly discovered package-cache references can still append providers. Normal startup never imports packages.ts to discover them implicitly. Combined direct/cached duplicates or bounds fail before provider module imports; unsafe cached metadata fails closed, not source fallback. A present registry must be a non-symlink single-link regular file of at most1MiB, with a valid default array (branding is optional). Root aliases canonicalize. Direct referenced files receive the shared checked-module path/file preflight; transitive imports remain trusted. Fixed URLs retain ordinary Bun ESM caching; use a fresh process for changed source. Filesystem checks are not atomic against hostile concurrent path replacement. No install-time execution or external package discovery occurs.

## Generator templates and evidence

`make:provider` supports nested PascalCase names and computed aliased type imports. The example service key includes the namespace, avoiding equal-leaf-name collisions across directories. Descriptor bounds are validated by the consuming backend before destination creation. Existing paths, unsafe names and symlinked destination parents refuse, including with global `--force`.

`stub:publish` publishes26 code-only `.ts.stub` templates. `provider.ts.stub` requires `{{name}}`, `{{runtimeImport}}` and `{{serviceKey}}`; unknown/missing tokens or invalid syntax refuse. Custom templates are trusted code, not a semantic contract validator.

Tests exercise register-before-boot, before-command-import ordering, once-only nested bootstrap, scopes/provider/singleton cleanup order, partial failure, caller-container refusal, cancellation and error sanitization. Actual separate CLI processes consume default/custom generated providers with strict typechecking and no ORM database, plus cooperative signals delivered during cleanup. These are bounded local contracts, not complete Laravel provider/package parity, hot reload, multi-host or production-readiness evidence. `package:discover` separately caches explicit trusted local metadata; [its guide](packages.md) documents lifecycle consumption and fail-closed recovery limits. [Explicit local code-only vendor publication](publication.md) is separate from provider bootstrap; project/API/broadcast installers remain unfinished.
