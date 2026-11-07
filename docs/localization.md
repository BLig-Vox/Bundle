# Local language resources

Bundle provides explicit text catalogues. `lang:publish` creates the bundled English resource at `lang/en.ts`; applications consume it through the translation API. It does not download translations or automatically wire catalogue resources into generated React views.

```bash
bun run bundle lang:publish
```

The command returns `{"created":["lang/en.ts"]}`. Publication exclusively creates a mode-0600 file under a checked real directory. Existing translations are preserved: even global `--force` does not overwrite an existing file, dangling link, hardlink or other target. Publication never imports an existing catalogue and does not open the ORM database. No new class stub is added to `stub:publish`.

## Consume a catalogue

```typescript
import { translate } from "./src/localization/messages.ts";

const message = await translate(projectRoot, "bundle.greeting", {
  values: { name: "Vox" },
});
// Hello, Vox.
```

`projectRoot` must be an explicit absolute directory. Canonical root aliases are accepted. The bundled catalogue has exactly two entries:

| Key | English text |
| --- | --- |
| `bundle.ready` | `Bundle is ready.` |
| `bundle.greeting` | `Hello, {name}.` |

`defineMessages(input)` validates, copies and freezes a flat text record. An application catalogue is trusted TypeScript with a default export:

```typescript
export default {
  "bundle.ready": "Prêt ✓",
  "bundle.greeting": "Bonjour, {name}.",
};
```

The default locale is `en`. Missing English source uses bundled messages; an existing `lang/en.ts` overrides bundled keys. Other locales require an explicitly written `lang/<locale>.ts`, with no cross-locale fallback. `loadMessages(root, locale?)` returns the validated catalogue. Unknown keys fail; the API does not return a key as a successful translation.

Imports use fixed module URLs and normal Bun ESM caching. Editing an imported file does not reload it in the same process. Use a fresh process to consume changed source. Validation and filesystem checks are repeated, but they do not invalidate the module cache.

## Bounds and interpolation

- Catalogue: at most 128 own enumerable data properties; plain or null-prototype records only. No symbols, accessors, inherited records, undefined or non-string values.
- Keys: `[a-z][a-z0-9_.-]{0,127}`. Values: at most 4096 UTF-8 bytes each, and at most 64 KiB for the serialized whole catalogue. Text must be lossless Unicode, without NUL or terminal controls other than newline/tab.
- Source: regular single-link non-symlink file, at most 64 KiB, beneath a checked real `lang` directory.
- Locale: 2–35 ASCII characters matching `[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*`. Paths and locale traversal are rejected.
- Replacement record: at most 32 own data values, names matching `[A-Za-z][A-Za-z0-9_]{0,63}`. Strings have a 512 UTF-8 byte limit and the same Unicode/control rules; numbers must be finite.
- Interpolation replaces ASCII `{name}` placeholders. Every placeholder requires a value; unused supplied names fail. Other braces remain literal text. Final output is limited to 8192 UTF-8 bytes.

Key, option and replacement shapes/bounds are validated and copied before source import. Whether a supplied name is unused is determined from the loaded message. API errors are generic and do not echo trusted import exceptions. Trusted source can still write directly to output or start side effects: this is not a sandbox.

There is no pluralization, ICU/gettext, nested catalogue tree, locale detection, date/currency formatting, markup rendering, translation download or managed reload. Filesystem checks do not protect against hostile concurrent path replacements; no power-loss durability or multi-host guarantee is claimed.

## Verification

Focused tests live in `src/localization/*.test.ts` and `src/cli/language.test.ts`. Actual entry-point tests in `src/cli/compatibility.test.ts` publish and strictly compile resources, consume default and customized Unicode catalogues in fresh CLI processes, preserve existing content despite force, reject unsafe locale input before catalogue import and leave database storage absent.
