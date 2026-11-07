# Generate missing registered class listeners

## Intent and chosen native contract

Continue the standing implementation directive with consumed `event:generate`, not registration-only scaffolding. Bundle events use explicit string identities and executable references, not PHP event class names; no event class is required to dispatch a named event. The command generates missing explicitly registered class listeners while preserving existing listener files. `make:event` remains the separate optional typed producer helper. This bounded native equivalent does not fabricate event classes for arbitrary event names.

## Source and ownership

Read trusted root events.ts through existing `readEventDefinitions`: valid branded defineEvents array, ordinary fixed Bun ESM caching. Ignore cached registrations for generation, because stale bootstrap metadata must not rewrite source decisions. Do not rewrite events.ts or cache, auto-discover handlers or execute listeners during generation. Missing source refuses; a valid empty source reports empty generated/existing arrays, not a nonexistent backend success.

New `generateRegisteredEventListeners(root:string)` in `src/cli/event-generation.ts` orchestrates source loading and a shared scaffold helper. CLI `event:generate` registers in events.ts with JSON `{created:string[],existing:string[]}` repository-relative source paths. Existing global --force never overwrites listener files. Generic errors, no trusted exception dumps.

Shared helper in scaffolding.ts may expose `generateEventListenerScaffolds(root,definitions)` using existing defineEvents validation/nameSegments/renderStub/writeScaffold rather than duplicating name/stub/path rules. Complete source/reference/target/template preflight before any writes. At most128 event definitions and256 total references; deduplicate repeated identical references to avoid duplicate writes. Source/descriptor runtime remains trusted, no sandbox.

## Missing and existing references

Existing referenced files receive the ordinary checkedRouteFile safety checks, including safe parents, regular single-link/no symlink source. Preserve them byte-for-byte and list them once; do not import them or claim their exports/semantics were validated by generation. Existing function references or own methods outside the generator directory remain supported by normal event consumers.

A missing reference is generatable only when module is `src/listeners/<nested PascalCase>.ts`, export equals the PascalCase leaf, and method is exactly handle. Validate through existing reserved-name/nameSegments rules. Reject unsupported missing function/custom-method/path/export shapes before creating any output. Parent symlinks/dangling links/unsafe files refuse; no automatic directory repair. The generated own-handle class comes from the existing consumed listener.ts.stub, including trusted custom overrides and strict syntax/token checks. Namespace references and actual runtime imports retain existing make:listener semantics.

Publish exclusively with the existing safe scaffold writer after every planned target and rendered template validates. Preserve existing files even with --force. Publication is not a multi-file transaction: a later filesystem I/O/concurrent exclusive-create failure may leave earlier newly created files for inspection; return nonzero and never claim all targets succeeded. No hostile concurrent path-replacement safety or rollback promise.

## Evidence gates

Before production implementation, actual CLI missing-command regression must fail. Backend tests should fail for absent API, then cover full-preflight-before-writes, existing valid/unrelated references, dedup, no overwrite, unsafe paths/symlinks, missing-source/empty-source, custom template and bounds. Strictly compile generated class output and consume registered classes through actual event:list/cache/dispatch in a separate CLI process; a customized listener must perform observable work when dispatched, not at generation/import. Verify source/cache bytes unchanged by generation, even with force.

No new dependency, package, markup, install/network call, schema/database, automatic event registration, queued listener, event hot reload or full Laravel event-discovery parity. The current25-template inventory remains unchanged. Independent review/reproduce/repair and fresh whole suite/types/graph/provenance precede single-reference credit.
