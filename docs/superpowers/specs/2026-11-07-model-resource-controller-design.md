# Consumed model-associated resource controllers

## Intent and selected native approach

Implement the remaining original resource-controller example under the standing implementation directive. `make:controller PostController --resource --model Post` emits own index/show/store/update/destroy methods consumed by a real explicit HTTP/MikroORM adapter. Preserve ordinary make:controller output. No automatic routes, model edits, database connections during generation, authentication, inferred request fields or markup. Native Data Mapper behavior is explicit; no Eloquent/PHP promise.

An explicit per-request manager/validation/serialization middleware is the selected implementation default. Opening a hidden global ORM in generated classes would violate request isolation and ownership. Empty CRUD methods would not establish a consuming backend.

## HTTP adapter interfaces

New `src/http/model-resource.ts` imports native MikroORM types and existing HttpContext/HttpMiddleware/HttpHandler, and exports:

```typescript
interface ModelResourceOperations {
  readonly index: HttpHandler;
  readonly show: HttpHandler;
  readonly store: HttpHandler;
  readonly update: HttpHandler;
  readonly destroy: HttpHandler;
}
interface ModelResourceOptions<T extends object> {
  readonly model: EntityClass<T>;
  readonly manager: (context: HttpContext) => EntityManager | Promise<EntityManager>;
  readonly parseId: (value: string) => string | number;
  readonly create: (context: HttpContext) => RequiredEntityData<T> | Response | Promise<RequiredEntityData<T> | Response>;
  readonly update: (context: HttpContext) => EntityData<T> | Response | Promise<EntityData<T> | Response>;
  readonly serialize: (entity: T) => unknown | Promise<unknown>;
}
function modelResourceMiddleware<T extends object>(options: ModelResourceOptions<T>): HttpMiddleware;
function modelResourceFor<T extends object>(context: HttpContext, model: EntityClass<T>): ModelResourceOperations;
```

Option records are copied/snapshotted at middleware construction; required own data callbacks/model class, no accessors or unknown fields. Model selection is constructor identity, not guessed strings. Missing/invalid registration fails closed through Router-sanitized500. No duck-typed fake manager: provider must return a real native EntityManager. The adapter calls manager.fork() once per middleware invocation and uses only that fresh fork, never flushing/clearing the supplied manager. It never initializes/closes the caller-owned ORM or installs schema. Await next and clear the owned fork in finally, restoring prior request registry state even on failure. Explicit per-request bindings support nested distinct-model middleware; duplicate active same-model bindings refuse. No global request manager.

Callbacks are trusted application code. Create/update parsers explicitly whitelist and validate fields, normally using existing code-only validation. They may return a Response with400..499 to refuse without persistence; other Response statuses are invalid. There is no default request.json mass assignment, automatic auth or default serializer. Applications must place authorization before resource middleware when needed. Return JSON/no-store responses; serializers explicitly select public fields. JSON output must be serializable and at most1MiB after serialization (trusted serialization work is not a CPU/memory sandbox).

Operations:
- index: native em.find(model, {}, {limit:100}), serialize selected entities, JSON200 array. No unbounded list, implicit filter/sort/pagination or managed streaming.
- show/update/destroy use params.id. Call explicit parseId, then accept only positive safe integers or bounded ASCII strings matching `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`; invalid/missing id returns generic400 without executing a query. Single scalar primary key only; unsupported composite models fail generically. Unknown entity returns generic404/no-store.
- store: call create parser; valid native required entity data goes through em.create then persistAndFlush, serialize entity and JSON201.
- update: find existing entity, call update parser, prohibit own primary-key fields in update data, em.assign/flush then serialize JSON200. Explicit parser validation controls writable non-primary fields; native entity data may contain legitimate Date/entity references and is not restricted to JSON DTOs.
- destroy: find, removeAndFlush, empty204/no-store. No fabricated success for absent entities.

Check request.signal before/after awaited provider, callbacks and database operations, and before persistence. Cancellation is cooperative and does not undo already committed writes; no automatic transaction/side-effect rollback. Native errors and invalid callback results remain Router-sanitized500, not private exception dumps. Returned validation Response gets no-store. No inferred soft deletion, relations/eager loading, auth, migrations, unique-error mapping or cross-database live verification.

## Generator interfaces and compatibility

Scaffold worker owns changes to `src/cli/scaffolding.ts`, `src/cli/generators.ts` and their tests; add resource/controller model options to the existing public scaffold option type. Reuse existing factory model-source preflight and source rules: required existing safe top-level src/models/<PascalCase>.ts, bounded regular single-link/no-symlink source, syntactic named class/default-schema export check with no model import or DB connection. It does not prove runtime metadata validity.

`make:controller <name> --resource --model <name>` is the supported pair. Reject --model without --resource and --resource without --model before writing directories; unrelated kinds refuse these options. Output remains src/http/controllers/<nestedName>.ts. Ordinary no-option controller retains handle(context) output and existing default stub.

Add consumed `controller-resource.ts.stub`, making26 total stubs. Required tokens: name, runtimeImport (model-resource.ts), contextImport (router.ts), modelName, modelImport. Computed relative imports are aliased, including selected model as _Model. Output class has own async index/show/store/update/destroy methods forwarding the exact context to modelResourceFor(context,_Model). Do not emit handle alias, create/edit markup routes, constructor injection or route registration. Cached class descriptors explicitly select their own method.

No overwrite, even force; preserve existing name/path/template/parent safeguards. Custom resource-controller stubs use the same consumed mechanism and compile/execute. Prevent reserved identifiers/import collisions as existing aliases do. No new dependencies/downloads/services or changed model mappings.

## Ownership and evidence gates

Runtime worker owns ONLY new model-resource.ts/tests. Scaffold worker owns ONLY scaffolding/generators and their tests. Leader owns actual compatibility tests, docs, source/graph/inventory and any required shared26-stub integration expectations. At most3 active delegated workers.

Observe missing runtime API and unsupported flag/real CLI example red before production. Real disposable MikroORM SQLite tests must persist/create/read/update/delete through Router requests, isolate forked manager state, enforce explicit validation/id/404/primary protection and sanitized errors, and preserve cancellation/cleanup/ownership. No mocked repository as sole evidence. Actual CLI generates nested default/custom controllers, strictly compiles, then a real local HTTP server consumes generated own methods through explicit middleware and schema, with observable persistence and cleanup. Route cache hydration selects own index/show methods. Generation does not create DB files/import a model marker or mutate mappings; no automatic route setup claim.

Independent review, reproduced fixes, fresh full suite/types/graph/provenance and unchanged180 original references precede single model-resource-example credit. SQLite proves SQLite only; opt-in PostgreSQL/MariaDB contracts stay skipped unless authorized disposable targets supplied. No real application database/environment mutations, commits, installs or service provisioning.
