# Code-only vendor publication

`vendor:publish` copies explicitly registered local configuration, language and data resources into an application. It reads trusted root `publish.ts` only for this explicit action. It does not scan installed dependencies, execute source assets, download packages, or publish UI markup.

## Declare resources

```typescript
import { definePublications } from "./src/publication/definitions.ts";

export default definePublications({
  version: 1,
  assets: [
    {
      package: "acme",
      tag: "defaults",
      source: "vendor-resources/acme/config.ts",
      destination: "config/acme.ts",
    },
    {
      package: "acme",
      tag: "messages",
      source: "vendor-resources/acme/fr.ts",
      destination: "lang/fr.ts",
    },
  ],
});
```

The manifest is executable trusted application code. Asset contents are copied as bytes without import. The configuration loader or translation API validates and consumes the published file later. Publication itself does not prove semantic validity of arbitrary TypeScript/JSON.

## Select and publish

```bash
bun run bundle vendor:publish --package acme
bun run bundle vendor:publish --tag messages
bun run bundle vendor:publish --package acme --tag defaults
bun run bundle vendor:publish --all
```

Package and tag together select their intersection. `--all` cannot combine with those selectors. No selection or no matching assets fails; there is no implicit broad publication or interactive selector. Output is JSON with repository-relative created paths in manifest order.

Every existing target is preserved, including with global `--force`. Existing regular files, hardlinks, symlinks, dangling links and directories refuse before publication. There is no overwrite, merge or unpublish operation.

## Configuration-only publication

No-argument `config:publish` retains its exclusive built-in app.ts publication and never imports publish.ts. Explicit selectors use the same manifest/preflight/writer as vendor publication, but select **only config/*.ts destinations**:

```sh
bun run bundle config:publish --package acme --tag defaults
bun run bundle config:publish --all
```

Package/tag intersection and all-exclusivity rules are identical. All means all registered configuration assets, not language/resources. Missing matching configuration fails. Valid irrelevant non-config sources are not read or copied, but the full manifest must still validate. Configuration sources are copied as bytes, not imported; later config:show/cache consumers validate/import them. Existing files are preserved even with force, selected results contain created paths, and no-argument legacy output is unchanged. Publication does not invalidate a pre-existing configuration cache: clear/rebuild explicitly to consume changed configuration. Cancellation and later-I/O nontransactional limits are shared with vendor publication. No package scanning/downloads or manifest rewriting is implied.

## Supported resources and bounds

- Version exactly 1; closed copied/frozen plain own-data manifest and asset records, dense ordinary arrays.
- At most 128 assets and 32 package names. Package/tag syntax is `[a-z][a-z0-9._-]{0,127}`. Duplicate destinations fail across the whole manifest.
- Paths are safe ASCII root-relative POSIX paths, at most 256 bytes. Segments match `[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}`; dot/dotdot, absolute paths, backslashes and empty segments fail.
- Sources end in `.ts`, `.json` or `.txt`; `.d.ts` is excluded. Destination extension must match.
- Destinations: top-level `config/<identifier>.ts`, `lang/<locale>.ts`, or nested `resources/*.json`/`*.txt`. Config names match the configuration loader and exclude prototype keys; locales match the localization API. No arbitrary application code paths or UI templates.
- Source/target must differ. A selected source cannot also be a selected destination.
- Manifest source at most 64 KiB; selected sources at most 64 KiB each and 1 MiB total. Sources must be regular single-link non-symlink files, read with bounded descriptor checks.

## Safety and cancellation

The root is an explicit absolute directory; canonical aliases are accepted. Selected sources, target conflicts and existing ancestors are fully preflighted before writing. Symlinked parents are rejected. New directories request mode0700 and files request mode0600 with exclusive no-follow creation. Publication never imports or modifies an existing target, changes its permissions or opens the ORM database.

Predictable validation, source, path and conflict errors precede output creation. Multi-file publication is not a transaction: later I/O, cancellation or an exclusive-create race can leave earlier newly published files while reporting failure. Files are never rolled back by deleting application targets. Cancellation is cooperative, including checks around trusted import/awaits and before each create; an uncooperative import cannot be forcefully interrupted in this process.

Errors are generic and do not include private asset contents or trusted exceptions. Manifest code and its transitive imports can still produce direct side effects/output. Fixed-URL Bun ESM caching applies; source changes need a fresh process. This is not a sandbox, hostile concurrent path-replacement defense, power-loss persistence guarantee or multi-host transaction.

Package provider discovery/bootstrap is a separate contract in [packages](packages.md). Existing providers can normally boot before CLI actions; publication does not bypass ordinary application bootstrap. There is no new class stub or dependency installation.
