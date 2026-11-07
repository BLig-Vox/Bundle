# Explicit trusted local package metadata discovery

## Intent and chosen approach

Continue the implementation directive with actual consumed package:discover metadata, not a decorative dependency listing. Use explicit trusted root packages.ts rather than scanning/executing arbitrary dependencies or downloading packages. Local package records group safe executable provider references already supported by the real application lifecycle. Registered packages may refer to application-local modules; literal PHP/composer/npm auto-discovery interoperability is not implied. No markup or dependencies are introduced.

## Definitions

New src/packages/definitions.ts:

- PackageDefinition {readonly name:string;readonly providers:readonly ProviderReference[]}.
- definePackages(input:readonly PackageDefinition[]):readonly PackageDefinition[] validates/copies/freezes dense own-data arrays/records. At most32 unique names, each matching [a-z][a-z0-9._-]{0,127}; exactly name/providers fields. Providers reuse defineProviders validation and total maximum64 across packages, no duplicate module/export pair across packages. Empty packages/providers are valid real metadata, not fake plugin instances.
- Root packages.ts must be a bounded1MiB single-link regular non-symlink trusted module with a default array; branding not required. Explicit absolute canonical root. Missing source means empty definitions. Source execution is trusted and fixed-URL Bun ESM caching remains; no hot reload or sandbox.

## Cache API and publication

New src/packages/cache.ts exports:

- readPackageDefinitions(root:string,signal?:AbortSignal):Promise<readonly PackageDefinition[]> reads trusted source only.
- loadCachedPackages(root:string):Promise<readonly PackageDefinition[]|undefined> reads serialized metadata only; undefined means absent, never invalid.
- cachePackages(root:string,{overwrite?:boolean,signal?:AbortSignal}?):Promise<{path:string;packages:number;providers:number}> validates full source/reference definitions, preflights all referenced module paths via checkedRouteFile without importing provider modules, and publishes version1 {version:1,packages:[...]} JSON at bootstrap/cache/packages.json. Bounded whole cache1MiB, fatal UTF8, closed shape and duplicate-key JSON refusal (including nested records); definePackages revalidates content.
- clearPackageCache(root:string):Promise<boolean> removes only valid owned package metadata, without importing source/providers; corrupt/unsafe/unrelated state is preserved for inspection.

Owned private publication: canonical root; existing bootstrap/cache directories must be real nonsymlink directories, not auto-reset. Published cache is owned mode0600 single-link regular file, no symlink/hardlink/foreign owner or permissive state accepted. Temp mode0600 exclusive no-follow write/file-sync; create-only link publication or explicit overwrite rename after rechecking safe owned target. Only matching owned temporary artifacts cleaned; preserve unrelated state. Do not chmod unrelated existing cache directories used by other subsystems. Readers tolerate bounded ordinary atomic replacement/first-link races, not arbitrary hostile tree replacements. Errors are generic package diagnostics, no trusted private content. No power-loss/multi-host transactional guarantee.

## CLI and consuming lifecycle

New src/cli/packages.ts registers:

- package:discover: cachePackages with overwrite only when global --force; output safe metadata counts/path, not arbitrary manifest exception details. No provider module import/constructor/hook execution inside metadata discovery.
- package:clear: clear only valid owned package cache, no source/provider imports. This is a separate native administrative command, not a claim of a Laravel reference alias.

Leader registers this module in program.ts and integrates cached providers into loadProviderDefinitions. Absent package cache does not import packages.ts or implicitly discover anything; users explicitly run package:discover. Present valid cache providers append to root providers.ts references and share full defineProviders duplicate/bound validation before imports. Normal CLI starts then boots the real combined list once via existing lifecycle; caller-owned container refusal still applies. No HTTP/queue worker special registration claim.

Runner startup probe expands to treat present package cache (even without root providers.ts) as configured provider state, preserving the established no-registry pre-aborted-handler behavior. Corrupt/unsafe cached metadata fails before command imports; it is not silently bypassed for package commands. This means unsafe bootstrap state may require manual inspection/recovery before CLI actions can run, as malformed root provider source already does; clear does not destroy corrupt state automatically. Explicit backend clear/load APIs remain available to inspection tooling. Document this deliberate fail-closed operational limit.

## Evidence and ownership

Worker owns only new packages definitions/cache/tests and cli/packages.ts/tests. Leader owns program/provider/runner integration, actual compatibility, docs/source/graph/inventory. Before implementation observe missing APIs/command red; actual separate process discovery must not run referenced providers, then a later actual CLI consumes cached providers without packages.ts source fallback and resolves booted services. Test strict copied shapes/bounds/duplicates/unsafe JSON paths/modes/owners, cache replacement force/no overwrite, invalid source not replacing valid cache, safe clear/no source import, module preflight before publication and ordinary replacement races. No provider namespace module execution just to claim validation.

Independent review, reproduced repairs and fresh whole suite/types/graph/source provenance precede one-reference package:discover credit. Native package:clear is not another original checklist item. vendor:publish, installer/project creation, package assets, npm/composer manifests and downloads stay unfinished. No installs, network, real databases, destructive unrelated file access or commits.
