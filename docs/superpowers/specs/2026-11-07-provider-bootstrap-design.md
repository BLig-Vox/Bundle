# Explicit local application provider bootstrap

## Intent and selected approach

Continue the standing implementation directive with a real consumer before generating providers. Reuse the synchronous ServiceContainer for dependency registration; providers have asynchronous ordered lifecycle hooks, not asynchronous service factories. The leader selects explicit trusted root `providers.ts` references rather than filesystem/package scanning or import-time registration. This avoids accidental dependency discovery and duplicate boot during nested `context.call`. No package download, XML, decorators or markup.

## Public backend contract

New `src/console/providers.ts` exports:

- `ProviderReference { readonly module:string; readonly export:string }`.
- `ProviderContext { readonly root:string; readonly container:ServiceContainer; readonly signal:AbortSignal }`.
- `ApplicationProvider { register(context:ProviderContext):void|Promise<void>; boot?(context:ProviderContext):void|Promise<void>; dispose?():void|Promise<void> }`.
- `defineProviders(input:readonly ProviderReference[]):readonly ProviderReference[]`: validate/copy/freeze closed dense own-data records before imports, maximum64, module/export each maximum256/128 ASCII characters, unique module/export pairs. Safe root-relative `.ts` files, no traversal/absolute/d.ts/root providers.ts reference. Safe JS export identifier excluding constructor/prototype/__proto__.
- `loadProviderDefinitions(root:string,signal?:AbortSignal):Promise<readonly ProviderReference[]>`: explicit absolute canonical root, missing root providers.ts means empty; source is bounded1MiB single-link regular non-symlink. Trusted default array need not be branded. No source hot reload, normal fixed-URL Bun caching.
- `bootProviders({root,container,signal,definitions?}):Promise<{dispose():Promise<void>}>`: root canonicalized; definitions loaded if omitted, fully validated, referenced source files preflighted before imports. References require native classes with own prototype register and optional own prototype boot/dispose functions; inherited/accessor hooks refuse. No-argument construction. Frozen shared context. Instantiate/register all in reference order, then boot all in order. Abort checks before/after awaits/imports prevent further cooperative work. Normal trusted imports/constructors cannot be forcibly stopped or sandboxed.

Backend never disposes the caller's container. Its idempotent disposal calls all instantiated provider dispose hooks in reverse order, even after partial registration/boot failure; failures aggregate into generic provider errors, not trusted exception messages. Failure/cancellation closes created providers before rejecting. Application resources registered in the container retain ordinary ServiceContainer ownership and disposal. Provider hooks must not take ownership of resources separately registered as container-owned.

## Runner ownership and ordering

Only outer `runCli` loads/boots configured providers, after signal setup but before first service scope, command lifecycle start or trusted command module import. Nested `context.call` shares its container and never repeats provider bootstrap. Finally settle all command scopes, dispose providers reverse order, then dispose runner-owned container. Provider failure prevents command parsing/imports and returns nonzero; actual handled SIGINT/SIGTERM preserve130/143. `handleSignals:false` adds no process ownership. `createApplicationCli` remains a build/load-only API without automatic provider lifecycle; embedding hosts can explicitly use backend APIs.

Automatic root provider bootstrap with a caller-supplied `context.container` refuses a nonempty provider registry before referenced provider imports/registration: repeating runs otherwise leave registrations bound to disposed instances or fail duplicate keys. This is an explicit safety boundary, not silently skipped providers. Hosts can explicitly own `bootProviders` + container lifetimes and use build-only `createApplicationCli`. Empty/absent provider registries preserve existing caller-container behavior. No global cache ties provider lifetimes to a reusable caller container.

## Consumed generator, separate integration

`make:provider Billing/LoggingProvider` will emit `src/providers/Billing/LoggingProvider.ts`, own register/boot hooks and computed aliased type import into the real backend. Example registration binds a namespaced singleton message string (not a fake successful no-op); registration is explicit in root providers.ts, never import/construction-time. Corresponding provider.ts.stub requires name/runtimeImport/serviceKey. Generator consumes existing exclusive safe scaffold writer; default/custom output gets strict compile + real command resolution/boot evidence before credit. This brings published stubs from24 to25. Generator integration follows the current native generator repair to avoid shared-file ownership conflicts.

## Tests and non-goals

Test red before backend exists: strict shape/refusal/copies, all-register-before-boot ordering, command service resolution, once-only nested bootstrap, reverse exactly-once cleanup, partial failure cleanup, cancellation boundaries and no command import on bootstrap failure. Actual CLI must consume a configured class through a real custom command without ORM coupling. Unsafe source/refs/stale fixed imports refuse or retain normal caching, never execute shell discovery. Caller-owned container remains usable and undisposed after refusal. Native exports/own hooks are runtime checked, not a security sandbox.

No package discovery/cache, publication manifests, framework extension auto-discovery, worker HTTP/queue integration, service auto-reload, decorator injection or full Laravel provider parity in this slice. Providers may execute arbitrary trusted direct output/subprocesses; generic Bundle diagnostics do not intercept that output. Filesystem checks exclude hostile concurrent path replacement. No commits, installs, network or application database mutation.
