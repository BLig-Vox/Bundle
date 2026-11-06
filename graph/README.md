# PROGRESS.md JSON Knowledge Graph

This directory contains the complete local corpus derived from [`PROGRESS.md`](../PROGRESS.md). It is JSON data with a relationship graph, **not a GraphQL server, graph database, or an implemented Laravel installation**.

## Files

| File | Contents |
| --- | --- |
| `corpus.json` | Original Markdown verbatim, its SHA-256 checksum, section hierarchy, every checklist item and completion state, explanatory notes, and fenced code examples. |
| `commands.json` | Deduplicated command identities, executables, namespaces, and every extracted invocation with its owning record and source location. |
| `sources.json` | The documentation links listed in the checklist, their labels, and source locations. These external pages are not downloaded or incorporated. |
| `graph.json` | Nodes and directed relationships connecting the document, sections, items, notes, examples, sources, and commands. |
| `manifest.json` | Format version, source checksum, generator command, output filenames, and counts for validating corpus coverage. |

All five JSON files are generated. Edit `PROGRESS.md` and regenerate rather than editing the JSON directly.

## Commands

From the repository root:

```bash
bun run graph:build
bun run graph:check
bun test
bun run typecheck
```

- `graph:build` regenerates the corpus without executing any checklist examples or fetching external URLs.
- `graph:check` checks all five artifacts against the current source and generator. Missing or stale files cause a nonzero exit; it does not rewrite files.
- Generation is deterministic: unchanged input and generator produce byte-identical JSON. There are no generation timestamps or machine-specific absolute paths.

## Record format

Every record has an `id`. Extracted records include a `location` containing a repository-relative `path` and inclusive, one-based `startLine` and `endLine` values. Example locations include the opening and closing fences; command occurrences inside examples point to the command line itself.

- Sections use `parentId` to retain the heading hierarchy, including subsections and the Sources section.
- Checklist items use `sectionId`, preserve their Markdown `title`, and store the checkbox state as `completed`.
- Notes, examples, and sources use `parentId`. An indented example following a checklist item belongs to that item; surrounding explanatory paragraphs belong to their section or the document.
- Examples retain their code text and fence language; Markdown list indentation is removed from code text.
- Commands retain `executable`, `name`, `namespace`, and `occurrences`. Each occurrence has an `ownerId`, the original `invocation`, and its source location.
- Graph node `type` values are `document`, `section`, `item`, `note`, `example`, `source`, and `command`. Match a node ID to its full record in the other files for details.

Repeated commands share one command record. For example, bare `migrate` and `./vendor/bin/sail artisan migrate` both reference the Artisan `migrate` command while preserving their distinct invocations. The introductory placeholder `php artisan <command>` is preserved as an example but is not treated as a real command.

## Relationships

| Relation | Direction |
| --- | --- |
| `contains` | Document or section → child section or checklist item |
| `has_note` | Document, section, or checklist item → explanatory note |
| `has_example` | Document, section, or checklist item → code example |
| `cites` | Sources section → documentation source |
| `references_command` | Checklist item, note, or example → command |

Relationships represent the structure and explicit references in the checklist. They do not invent dependencies between features or assert that a source validates every command.

## Scope and completion

The corpus includes all 15 numbered categories, as well as subsections, prose, warnings, optional tools, examples, and source links. `manifest.json` reports counts for the current source rather than hard-coded progress totals.

`completed` mirrors the source checkbox only; it is not an installed-package or runtime capability check. The Laravel/PHP and Blade references are source material, not a decision to adopt them in this code-driven Bun/TypeScript project. No implementation items are checked off by generating this corpus.

IDs are deterministic. Changing an item's completion state preserves its ID; renaming it or moving it to another section can change its ID. Identical repeated records receive numeric suffixes. This is a document-derived graph, not a permanent application entity-ID system.

## Generator

The code-first parser and data types live in `src/graph/corpus.ts`. The filesystem entry point is `scripts/build-graph.ts`. The parser targets the current checklist conventions: headings through level three, top-level checkbox items, standalone source links, paragraphs, and triple-backtick code fences. It is not a general-purpose CommonMark parser. The original Markdown is retained verbatim so no source content is lost.
