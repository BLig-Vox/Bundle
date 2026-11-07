# Explicit trusted local package metadata

This is an offline Bun package-registration contract, not Composer/npm auto-discovery or a package installer. Package records group explicit root-relative provider references consumed by the real application lifecycle. Dependencies are not scanned, downloaded or automatically trusted.

Create trusted root `packages.ts`:

```ts
import { definePackages } from "./src/packages/definitions.ts";

export default definePackages([
  {
    name: "billing",
    providers: [
      { module: "src/providers/Billing/LoggingProvider.ts", export: "LoggingProvider" },
    ],
  },
]);
```

Referenced classes use the ordinary [provider contract](providers.md). `make:provider` can create the class, but does not edit this manifest.

```sh
bun run bundle package:discover
bun run bundle --force package:discover
bun run bundle package:clear
```

## Discovery and consumption

Discovery reads and validates trusted `packages.ts`, preflights all referenced provider module paths and publishes actual version1 metadata at `bootstrap/cache/packages.json`. The metadata builder does not import referenced provider modules or construct/register/boot their classes. Source manifests are themselves executable trusted TypeScript with ordinary Bun ESM caching; this is not a sandbox.

A later normal CLI startup reads valid cached metadata, appends its providers after root `providers.ts` references, validates combined bounds/duplicates, and boots the real combined provider lifecycle before command imports. An absent root provider registry does not suppress cached packages. Package source is not imported by normal startup, and absent cache does not implicitly discover packages. Invalid metadata fails closed, never falls back to source or silently drops package providers.

Normal CLI bootstrap may already execute **previously cached/root providers** before any action, including discover/clear. The no-provider-execution guarantee applies to the metadata builder and newly inspected references, not to ordinary earlier startup. Cached and root references cannot duplicate the same module/export. Combined maximum remains64 providers, and nonempty automatic bootstrap still refuses caller-owned containers. Cancellation and cleanup preserve ordinary runner ownership.

## Definition limits

`definePackages` accepts dense own-data arrays of at most32 records with exactly name/providers. Names are unique lowercase ASCII identifiers matching `[a-z][a-z0-9._-]{0,127}`. Provider references are copied/frozen through shared `defineProviders` validation, total maximum64 and no duplicate module/export across packages. Empty valid manifests represent empty metadata, not fabricated plugin instances.

A missing source is an empty manifest. A present root source must be a regular single-link non-symlink file of at most1MiB with a default array; branding is optional. Roots are explicit absolute directories with canonical aliases. Safe root-relative `.ts` provider references receive shared module-file/path preflight; transitive dependencies and runtime exports are checked/executed by ordinary later provider consumption, not promised valid by metadata alone.

## Publication, clear and recovery

Published metadata is bounded1MiB strict closed version1 JSON with fatal UTF8 decoding and duplicate-key rejection. Cache files must be owned mode0600 single-link regular files; unsafe links, ownership/modes, malformed content and unrelated state refuse. Existing shared bootstrap/cache directories are checked, not reset or chmodded.

Publication writes/syncs a private exclusive temporary file, then creates the target exclusively or replaces a safe owned target only with explicit `--force`. Failed source validation/preflight preserves existing metadata. Runner cancellation is passed into discovery and checked around trusted import/preflight and immediately before publication; cancellation observed before that commit refuses publication and preserves any prior cache. Atomic publication is the commit point, not a rollback protocol for cancellation arriving after it begins. Readers tolerate bounded ordinary atomic replacement/first-publication transitions. This is not a power-loss/multi-host transaction or defense against hostile concurrent tree replacement.

`package:clear` removes only valid owned package metadata, without importing its source or referenced providers inside the clear API. Other bootstrap caches, locks, application data and package source remain. Corrupt/unsafe metadata is preserved for inspection. Because normal provider bootstrap precedes CLI actions, broken cached providers or unsafe metadata can prevent the public clear/discover command from starting; do not assume a repair bypass. An inspection host can explicitly use backend APIs after reviewing state. No automatic unsafe deletion or secret recovery mode is supplied.

## Backend APIs and verification scope

`src/packages/definitions.ts` exports `PackageDefinition` and `definePackages`. `src/packages/cache.ts` exports `readPackageDefinitions(root,signal?)`, `loadCachedPackages(root)`, `cachePackages(root,{overwrite?,signal?}?)` and `clearPackageCache(root)`. Cached reads return undefined only for absence. Cache returns path/package/provider counts, not constructed plugin instances; backend clear never owns a provider/container lifecycle.

Tests use local disposable roots and actual separate CLI processes; source/cache correctness does not establish external package ecosystems, live-service interoperability or production readiness. Vendor assets/publication, installers/project creation, package downloads, managed reload and automatic worker-specific integration remain separate work. No markup, PHP manifests or install-time scripts are introduced.
