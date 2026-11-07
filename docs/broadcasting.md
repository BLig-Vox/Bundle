# Broadcast channel registry

Bundle currently provides a trusted, code-first registry for naming channels and a native `channel:list` inspection command. This is metadata listing only: there is no broadcast transport, authenticated principal inference, channel authorization, client subscription protocol, or external-service integration.

## Register channel names

Create a root `channels.ts` that default-exports `defineChannels` from Bundle:

```ts
import { defineChannels } from "./src/broadcasting/definitions.ts";

export default defineChannels([
  { name: "orders.{orderId}" },
  { name: "private.users.{userId}" },
]);
```

Names are dot-separated identifiers with optional complete `{parameter}` segments. Each parameter name must be unique within its pattern. Registries are copied, frozen and limited to 128 unique names of at most 256 characters. This registry does not attach authorization callbacks or execute channel handlers.

## Inspect registered names

```sh
bun run bundle channel:list
bun run bundle channel:list --json
```

Text output lists names in declaration order; JSON returns `{ "channels": [{ "name": "..." }] }`. If `channels.ts` is absent, the command reports an empty registry. A present but invalid registry fails instead of silently appearing empty. The command imports the trusted root module and its transitive dependencies, so their normal side effects remain possible; it never opens the ORM database or contacts a service. Bun's normal ESM module cache applies: run a fresh CLI process to observe edits to an already imported registry or its dependencies.

`make:channel` and `install:broadcasting` remain unimplemented. A list of names is not authorization or broadcasting, and no PHP/Blade channel behavior is implied.
