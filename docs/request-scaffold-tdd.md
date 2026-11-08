# Request scaffold: test-first evidence

Before implementation, `bun test src/cli/requests.test.ts` failed:

```text
error: Cannot find module './requests.ts' from '/root/Bundle/src/cli/requests.test.ts'
0 pass
1 fail
1 error
```

Tests were added first for real generated schemas, all primitive defaults and optional fields, strict unknown keys, pre-write validation, resource limits, exclusive collisions/concurrency, symlinks and path protection, cleanup after a partial staging write, and JSON/error/list/help output through the generated app CLI.

Follow-up red tests exposed invalid generated identifiers (`Class`, `Schema`, imported `Infer`) and the missing `src/requests/**/*.ts` include in generated server tsconfigs. The help subprocess test also exposed Commander writing directly to stdout with an EPERM failure in this environment; CLI help now uses the configured output callback.

The implementation validates and renders before invoking filesystem operations, then uses the shared exclusive atomic source publisher. Its I/O seam injects a partial staging write failure to verify cleanup. Publication collisions exercise hard-link failure cleanup without modifying existing entries. As with the other scaffolds, parent directories must be trusted against hostile concurrent replacement; process death can leave staging files.

Validation: the scaffold suite passes, including independent field-count/source-byte limits and the 64-field success boundary. Strict-mode binding names `Eval` and `Arguments` were also covered by a failing regression test before rejection was added. Repository typecheck, graph verification, and diff whitespace checks pass. A disposable generated app ran its real CLI, server/frontend typechecks, Vite production build, and runtime `safeParse`; compile-time checks used `@ts-expect-error` for missing required fields, string-to-integer coercion, and incorrect optional boolean values. Bundle's subpath resolved through the local dependency. Fresh `bun install --prefer-offline` failed with registry `DNSResolveFailed`; app validation used linked cached dependencies and does not establish fresh-install success.
