# Consumed native ORM generators

These are bounded MikroORM 7 code-first equivalents, not Eloquent casts/global scopes/automatic observer discovery. Generation writes TypeScript only: it does not connect to a database, import application model code, change model mappings or install dependencies.

```sh
bun run bundle make:factory Billing/UserFactory --model User
bun run bundle make:cast Billing/TrimmedText
bun run bundle make:scope Billing/NamedUsers
bun run bundle make:observer Billing/RecordCreates
```

## Factory

`database/factories/Billing/UserFactory.ts` extends the installed `@mikro-orm/seeder` Factory using the existing named `User` class at `src/models/User.ts`. The model name is required, top-level and validated. The source must be a regular single-link non-symlink file of at most1MiB with a syntactically exported named class and default export. This preflight does not execute the model, prove its runtime mapping is valid, or infer required properties. Dependencies remain trusted executable application code when later consumed.

Use a fresh entity manager, explicit attributes and the native factory API:

```ts
import { UserFactory } from "./database/factories/Billing/UserFactory.ts";

const em = orm.em.fork();
const user = await new UserFactory(em).createOne({
  name: "Example",
  email: "example@example.invalid",
});
```

The example `definition(input?)` copies explicitly supplied attributes and throws if none are supplied. Native `createOne` persists and flushes; `makeOne` constructs without the same persisted-result promise. Replace the definition with application-specific defaults if needed. No Faker, relationship guessing, factory registry or Laravel factory syntax is supplied.

## Paired new model and factory

```sh
bun run bundle make:model Product --factory --seed
# After the initial migration baseline is applied, optionally also generate a model-diff migration:
bun run bundle make:model Invoice -mfs
```

`-f/--factory` creates `database/factories/ProductFactory.ts` importing the newly generated `src/models/Product.ts`; `-s/--seed` adds `database/seeders/ProductSeeder.ts`. The factory consumes the same published `factory.ts.stub` as standalone make:factory, without importing a model during planning. The generated model has an auto-generated ID and timestamp defaults; pass explicit `{}` or your mapped attributes to the native factory. The seeder is an explicit example to fill in, not automatic fixture data or automatic seeding.

Every selected code output is rendered and its existing destination ancestors/conflicts checked before creating code files. Invalid names, malformed factory stubs, existing files/directories/dangling links and symlink parents refuse without creating the other selected code outputs, even with force. Names retain the existing top-level PascalCase model-name rules and scalar-name exclusions; the generic scaffold reserved-type list does not add new model-name restrictions. Every selected filename, including Factory/Seeder suffix and `.ts`, must fit 255 bytes (ASCII stems: 245 with factory, 246 with seeder, 252 model-only). Existing code is never modified. Later I/O or native migration failure can leave earlier new files: no whole-run transaction, rollback deletion or hostile concurrent tree guarantee is supplied.

Without `-m`, generation does not open a database. With `-m`, existing production force and model-diff baseline guards apply before code publication, then native migration generation inspects the new model; no automatic migration application or seeding occurs. The focused consumers persist a new factory entity using real SQLite and run the actual `-mfs` entrypoint followed by explicit migrate/db:seed in a disposable root. Full-suite and review status are tracked in the durable implementation plan; no new live-server evidence is implied.

## Custom type (cast alternative)

`src/database/types/Billing/TrimmedText.ts` extends native `Type<string,string>`. Its example database conversion validates and trims strings; JS conversion validates and preserves the stored string. Column declaration delegates to the native platform text type. Register it explicitly in an `EntitySchema` property:

```ts
import { EntitySchema } from "@mikro-orm/core";
import { TrimmedText } from "./src/database/types/Billing/TrimmedText.ts";

class Note { id!: number; text!: string; }
const NoteSchema = new EntitySchema<Note>({
  class: Note,
  properties: {
    id: { type: "number", primary: true },
    text: { type: new TrimmedText() },
  },
});
```

Add the schema to your ordinary ORM metadata configuration. Generated code never edits an existing property or supplies an Eloquent `$casts` API.

## Explicit query helper (scope alternative)

`src/database/scopes/Billing/NamedUsers.ts` exports a generic async function receiving an EntityManager, entity class/name and native FilterQuery. It executes a real `em.find` with an example limit of100:

```ts
import { NamedUsers } from "./src/database/scopes/Billing/NamedUsers.ts";
import { User } from "./src/models/User.ts";

const users = await NamedUsers(orm.em.fork(), User, { name: "Example" });
```

Customize the predicate and explicit cap for your application. It is not an automatically applied global scope, route authorization or model method injection.

## Explicit subscriber (observer alternative)

`src/database/observers/Billing/RecordCreates.ts` implements native EventSubscriber with an own `afterCreate` hook and an instance `createdCount` example. Register an instance on the manager that will perform the operation:

```ts
import { RecordCreates } from "./src/database/observers/Billing/RecordCreates.ts";

const em = orm.em.fork();
const observer = new RecordCreates();
em.getEventManager().registerSubscriber(observer);
// Subsequent creates flushed through this manager invoke the native hook.
```

There is no import-time registration, automatic model association or durable event history. Replace the counter with application behavior; it is not an audit log.

## Paths, templates and evidence

Nested PascalCase names are supported. Native imports are aliased to avoid generated declaration collisions; model imports are computed relative to the destination. Existing reserved-name rules remain enforced. Existing output, invalid names, symlinked destination parents and unsafe source files refuse, even with global `--force`. This is a trusted local project operation, not protection against hostile concurrent directory replacement.

`stub:publish` currently publishes26 code-only `.ts.stub` templates (including separately consumed provider and model-resource controller scaffolds). The four overrides are `factory.ts.stub`, `cast.ts.stub`, `scope.ts.stub` and `observer.ts.stub`. Each requires `{{name}}`; factory also requires `{{modelName}}` and `{{modelImport}}`. Unknown tokens and invalid syntax refuse. Trusted customized stubs can change behavior; syntax checks are not semantic validation or a sandbox. Publication never overwrites an existing template set.

Generator tests strictly compile the generated examples and consume all four with real disposable SQLite persistence. Actual separate CLI tests also persist/flush a generated factory row, roundtrip a mapped custom type, filter using the named helper and observe native afterCreate after explicit registration. Generation is tested with invalid DB configuration to establish that it does not open that database. These tests do not establish live PostgreSQL/MariaDB, power-loss, production or full Laravel command/flag compatibility.
