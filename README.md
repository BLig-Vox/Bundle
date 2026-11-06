# Bundle

A code-first Bun + TypeScript project. Its first application feature is a MikroORM-powered database layer and Laravel-inspired CLI. Development uses no XML, AXAML/XAML, HTML-like UI syntax, or markup-based UI framework.

## Database quick start

SQLite works without a database server:

```bash
bun install
bun run bundle migrate
bun run bundle db:seed
bun run bundle db:show
bun run bundle db:table users
```

The local database is `.data/bundle.sqlite`. Seeding adds explicit demo data; it is not an authentication setup.

```bash
bun run bundle list
bun run bundle make:model Product
bun run bundle make:migration add_products
bun run bundle migrate
bun run bundle migrate:status
```

Edit generated model properties before generating its migration. MariaDB and PostgreSQL drivers and separate migration directories are also configured; choose the connection in `.env` using `.env.example`. Their live integration tests require external disposable databases and are skipped when no test URLs are supplied.

See [the database guide](docs/database.md) for model usage, connection options, migration safety, and the database support/verification matrix. The [Artisan-inspired migration guide](docs/migrations.md) documents batch rollback, step/batch selection, SQL previews, named connections, custom migration paths, deployment isolation, schema dumps/pruning, and deliberate differences from Laravel.

```bash
bun run bundle migrate --step --isolated
bun run bundle migrate:rollback --pretend
bun run bundle migrate:rollback --step 1 --force
bun run bundle migrate:install
bun run bundle schema:dump --isolated
```

`make:model Product -m -s` also scaffolds a migration and seeder after the initial migration baseline has been applied. The CLI does not edit existing models; you maintain their TypeScript fields and mappings.

## Development

Install dependencies:

```bash
bun install
```

Run the entry point:

```bash
bun run start
```

Run with automatic restarts when files change:

```bash
bun run dev
```

Check TypeScript types:

```bash
bun run typecheck
```

The entry point is `index.ts`, which runs the Bundle CLI. `bun run start` shows its command list; pass a command to execute it. No web/UI framework, application build pipeline, or linter has been added yet.

Run the Bun tests:

```bash
bun test
```

Run just the corpus tests:

```bash
bun test ./src/graph/corpus.test.ts
```

## Feature reference and JSON graph

[PROGRESS.md](PROGRESS.md) contains the Laravel CLI feature checklist for reference. It does not indicate that Laravel is installed or that those features have been implemented.

[graph/](graph/README.md) contains a generated JSON corpus and knowledge graph of the entire checklist, including its sections, items, commands, notes, examples, and sources. It is local data, not a GraphQL server.

```bash
bun run graph:build   # Regenerate JSON from PROGRESS.md
bun run graph:check   # Verify JSON is current without rewriting it
```

The original Markdown is preserved verbatim in the corpus, and extracted records link back to source lines. Edit `PROGRESS.md` and regenerate; do not hand-edit the generated JSON.

### Project skill

The project-local [progress-graph skill](.claude/skills/progress-graph/SKILL.md) provides these Claude Code workflows:

```text
/progress-graph          Rebuild the corpus and run validation
/progress-graph sync     Rebuild the corpus and run validation
/progress-graph check    Validate without rewriting artifacts
/progress-graph inspect  Summarize the corpus without modifying files
```

Add task details to inspect particular records or request a source/generator update. The skill preserves the source-of-truth rules and does not treat documented features as implemented capabilities.
