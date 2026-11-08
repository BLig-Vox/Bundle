# Runtime validation: test-first evidence

Tests were executed before `src/validation/schema.ts` was created and before the generated Notes route was changed. Actual red-run excerpts:

```text
$ bun test src/validation/schema.test.ts
error: Cannot find module './schema.ts' from '/root/Bundle/src/validation/schema.test.ts'
0 pass
1 fail
1 error

$ bun test src/cli/apps.test.ts -t 'make:app produces'
error: expect(received).toContain(expected)
Expected to contain: "bundle/src/validation/schema.ts"
... at /root/Bundle/src/cli/apps.test.ts:45:17
0 pass
1 fail
```

After the initial green run, regression tests exposed four refinements before they were fixed:

- Sticky regex `/a/y` incorrectly accepted `ba` after discarding its sticky flag. The red run reported `Expected: false / Received: true`. The implementation now clones all regex flags and resets `lastIndex` before every parse.
- Nested proxies invoked reflection traps and lost their nested issue path. The red run expected `["nested"]` and received `[]`. Built-in proxy detection now rejects proxies before reflection or property access, preserving paths and invoking no traps.

- An array with its prototype set to null was classified as an object, returning `unknown_key` instead of `invalid_type`. An explicit array exclusion now preserves object type checks regardless of the array prototype.

- A forged RegExp prototype produced an engine error instead of the fixed configuration error. Built-in RegExp detection now rejects it before reading native regex internals.

The resulting tests cover strict primitives, bounds, trim and regex state, nested objects/arrays, optional fields, TypeScript inference (including expected compile errors), a global issue cap, deterministic ordering, sensitive values and unknown keys, accessors, proxies, prototype safety, configuration snapshots, and malformed construction options. Generated Notes tests exercise actual requests and isolated SQLite, preserving safe HTTP errors and response semantics. No request parser changes were needed.
