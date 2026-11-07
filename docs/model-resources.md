# Model resource controllers

The model-associated resource generator emits code that delegates to an explicitly configured HTTP/MikroORM adapter. It does not infer authentication, writable fields, response fields, routes or database configuration.

```bash
bun run bundle make:controller Api/UserResourceController --resource --model User
```

The supported options are a pair: `--resource` requires `--model`, and `--model` requires `--resource`. Ordinary `make:controller` retains its existing `handle(context)` scaffold. The resource variant instead has five own async methods: `index`, `show`, `store`, `update`, `destroy`. It has no markup-oriented create/edit methods or default handle alias.

Generation preflights an existing top-level `src/models/User.ts` using the same bounded, non-executing syntactic class/export checks as native factories. It never imports a model, opens a database, edits mappings or registers routes. The model must still have valid native metadata when consumed. Nested controller names use computed aliased imports. Existing output and unsafe parents are refused, even with force.

## Configure the real consumer

Given a caller-owned initialized `orm`, register explicit per-request middleware. The existing example `User` has required name/email fields; this is persistence, not authentication.

```typescript
import { User } from "./src/models/User.ts";
import { modelResourceMiddleware } from "./src/http/model-resource.ts";
import { rules, validateRequest } from "./src/http/validation.ts";

const createSchema = rules.object({
  name: rules.string({ min: 1, max: 120 }),
  email: rules.string({ email: true, max: 254 }),
});
const updateSchema = rules.object({
  name: rules.string({ min: 1, max: 120 }),
});

const middleware = modelResourceMiddleware({
  model: User,
  manager: () => orm.em,
  parseId: Number,
  async create(context) {
    const result = await validateRequest(context.request, createSchema, {
      maxBytes: 4096,
    });
    return result.ok
      ? result.value
      : Response.json({ error: "Invalid input" }, { status: 422 });
  },
  async update(context) {
    const result = await validateRequest(context.request, updateSchema, {
      maxBytes: 4096,
    });
    return result.ok
      ? result.value
      : Response.json({ error: "Invalid input" }, { status: 422 });
  },
  serialize: user => ({ id: user.id, name: user.name }),
});
```

This explicitly whitelists writable fields and selected response fields. There is no implicit `request.json()` mass assignment or entity-wide JSON response. Replace the example rules and serializer for the selected model. Put application authentication/authorization middleware before resource handling where required; the adapter does not protect a route automatically.

Bind each generated method to a route, passing the middleware:

```typescript
import { createRouter } from "./src/http/router.ts";
import { UserResourceController } from "./src/http/controllers/Api/UserResourceController.ts";

const controller = new UserResourceController();
const router = createRouter()
  .add("GET", "/users", context => controller.index(context), {
    middleware: [middleware],
  })
  .add("POST", "/users", context => controller.store(context), {
    middleware: [middleware],
  });
```

Register show/update/destroy explicitly on routes with `:id`. A generated class with no corresponding model-resource registration fails closed through Router-sanitized 500; it does not return a successful placeholder response.

## Operations and ownership

| Method | Native operation | Response |
| --- | --- | --- |
| index | `find` with limit 100, explicit serialization | JSON 200 array |
| show | scalar primary-key lookup | JSON 200 or generic 404 |
| store | explicit create parser, `create` and `persistAndFlush` | JSON 201 |
| update | lookup, explicit update parser, primary-key protection, assign/flush | JSON 200 or 404 |
| destroy | lookup and `removeAndFlush` | Empty 204 or 404 |

All responses use `Cache-Control: no-store`. Create/update parsers can return a 400–499 `Response` to refuse without persistence; other Response statuses are invalid. IDs use explicit `parseId` and must resolve to a positive safe integer or a bounded ASCII scalar string. Missing/invalid IDs return generic 400 without querying. Composite primary keys are not supported. Update data may not include own primary-key fields.

The provider must return a real native EntityManager. The adapter forks once for its request binding, uses only that fork and clears it in finally. It never flushes or clears the supplied manager, installs schema, initializes/closes the caller-owned ORM or shares a global request manager. Close that ORM through the application's own lifecycle after its server shuts down. Nested distinct-model bindings are supported; duplicate active same-model bindings refuse.

Callbacks/model references are snapshotted when middleware is constructed. They remain trusted code. Serializers return explicit serializable JSON data; serialized output is limited to 1 MiB. Serialization work is not a CPU/memory sandbox. Request signal checks surround awaited provider/callback/database work and precede persistence. Cancellation does not undo an already committed database operation, and no automatic transaction is implied.

Native errors, invalid callback results and absent registrations become Router-sanitized 500 without private exception text. There is no inferred filtering/pagination/soft deletion, eager relationship handling, unique-error mapping, migrations, authentication or automatic database provisioning.

## Route caches and stubs

Executable route descriptors select an own method explicitly, for example handler `{module: "src/http/controllers/Api/UserResourceController.ts", export: "UserResourceController", method: "index"}`. Register a separate middleware module exporting the explicitly configured adapter. Route-cache hydration does not supply a manager for you. Modules execute in the process/worker that hydrates them; parent CLI providers and ORM instances are not shared into a server worker. Keep provider initialization/lifecycle explicit in that execution context.

`stub:publish` includes the consumed `controller-resource.ts.stub`. Required tokens are `name`, `runtimeImport`, `contextImport`, `modelName`, `modelImport`. The model is imported with an alias, and generated own methods forward the exact request context through `modelResourceFor(context, selectedModel)`. Custom stubs remain trusted executable application code.

Verification must include actual generated/default/custom strict compilation and real local HTTP persistence, not just registered flags. SQLite fixture evidence does not establish expanded PostgreSQL/MariaDB live behavior; those require separately authorized disposable targets.
