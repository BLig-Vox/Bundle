# Explicit code-only vendor publication

## Intent and selected approach

Continue the standing implementation directive with `vendor:publish` backed by real configuration and text/data consumers. Reuse explicit trusted local TypeScript manifests rather than scanning installed dependencies or downloading assets. The alternative of extending cached provider metadata would couple publication to bootstrap recovery and mutate its stable contract; this slice keeps publication separately explicit. No PHP/Blade/XML/HTML/JSX/TSX or markup UI sources are introduced.

## Interfaces and manifest

New `src/publication/definitions.ts` exports:

```typescript
interface PublicationAsset {
  readonly package: string;
  readonly tag: string;
  readonly source: string;
  readonly destination: string;
}
interface PublicationManifest {
  readonly version: 1;
  readonly assets: readonly PublicationAsset[];
}
definePublications(input: PublicationManifest): PublicationManifest;
readPublicationManifest(root: string, signal?: AbortSignal): Promise<PublicationManifest>;
```

Trusted root `publish.ts` default-exports a version-1 manifest, normally using `definePublications`. No import at ordinary startup or dependency scanning; this command explicitly loads it. Missing source refuses. Regular non-symlink single-link source at most 64 KiB. Fixed-URL Bun ESM lifetime applies; no sandbox or reload claim.

Validation copies/freezes closed plain own enumerable data records and dense ordinary arrays. Reject getters, symbols, inherited/non-data fields, sparse arrays and unknown properties. Version must be exactly 1. At most 128 assets and 32 unique package names. Package and tag match `[a-z][a-z0-9._-]{0,127}`. Tags identify a selection, not a directory. Duplicate destinations reject across the whole manifest.

Paths: ASCII safe root-relative POSIX paths of at most 256 bytes, segments `[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}`, no empty/dot/dotdot/backslash/absolute segments. Sources must end in `.ts`, `.json` or `.txt`, not `.d.ts`; destinations must have the same extension. Destinations are restricted to `config/<identifier>.ts` (matching the existing config loader's safe identifier names, excluding constructor/prototype/__proto__), `lang/<locale>.ts` (existing localization grammar), or nested `resources/<segments>.json`/`.txt`. No arbitrary application source overwrites, executable hooks, directories, recursion, symlinks or UI assets. Source and destination must differ. A selected source cannot be any selected destination.

## Publication

New `src/publication/publish.ts` exports:

```typescript
interface PublicationSelection {
  readonly package?: string;
  readonly tag?: string;
  readonly all?: boolean;
}
publishVendorResources(options: {
  root: string;
  selection: PublicationSelection;
  signal?: AbortSignal;
}): Promise<{created: string[]}>;
```

Validate selection before manifest import. Exactly `all:true`, or package and/or tag with no all; package/tag combined means intersection. Missing selection, explicit all:false, unknown fields, malformed names or empty selection result refuse. This explicit-only native command does not pretend to implement an interactive vendor selector or every Laravel flag. Global force never overwrites application resources.

Root is an explicit absolute canonical directory, accepting canonical aliases. Before writing, validate the complete manifest and fully preflight every selected source, destination and existing ancestor. Sources regular single-link non-symlink, at most 64 KiB each and at most 1 MiB aggregate selected content, bounded read with descriptor/inode checks. Contents are copied as bytes, never imported by the publisher. Trusted JSON/config/catalogue validity belongs to the actual consumer; publication is not semantic validation. No private source content in errors/output.

Destinations and parents must stay under canonical root with no symlink components; every existing destination, including dangling links/hardlinks/directories, refuses before any publication. Missing directories can be created after full preflight with mode0700 and rechecked. Exclusive no-follow create at mode0600; output uses manifest order, repository-relative paths. Cooperative abort checks before/after trusted import/awaits and immediately before each exclusive create. Direct source import may ignore cancellation; no force termination.

All predictable validation/path/source/conflict failures occur before output creation. Multi-file publication is not a transaction: later I/O, cancellation or exclusive-create failures can leave earlier newly published files while reporting failure. Never delete, overwrite, chmod or import pre-existing application targets. No hostile concurrent tree-replacement, multi-host or power-loss guarantees. No destination cleanup/ownership manifest, since no overwrite/unpublish is offered.

New `src/cli/publication.ts` exports `registerPublication(program,{root,output,signal?})` and registers `vendor:publish --package <name> --tag <tag> --all`, safe JSON/generic errors. Leader owns `program.ts` wiring and actual compatibility tests; no new stub or package metadata edits.

## Evidence gates

Missing API/public command tests red before production. Focused tests exercise strict manifest/selection bounds, snapshots, no getter execution, source/destination/path/link/type refusal, preflight preservation, duplicate/overlap handling, mode/exclusive force-preservation, cancellation and no source import. Actual separate CLI publishes a `.ts` config consumed through real `config:show`, an explicit language catalogue consumed through `translate` in a fresh command, and JSON data consumed explicitly. Strict compile published TypeScript. Test selectors/filtering and refusal/no database; independently review, reproduce and repair findings, then run fresh complete suite/types/source/graph/provenance before crediting only vendor:publish.

No installs/downloads/services/commits or real application DB/environment mutations. Tests use unique disposable roots. Existing dirty work preserved.
