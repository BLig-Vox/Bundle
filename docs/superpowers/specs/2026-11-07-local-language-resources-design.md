# Consumed code-only local language resources

## Intent and selected native approach

Next independently testable slice under the standing full-implementation directive: lang:publish with a real bounded text translation consumer. No markup/UI locale framework, language downloads, dependencies or decorative files. Publish the bundled English code-only catalogue for explicit application override; support additional explicitly written local catalogues without pretending to synthesize translations.

## Runtime contract

New src/localization/messages.ts exports:

- type Messages = Readonly<Record<string,string>>.
- defineMessages(input:Readonly<Record<string,string>>):Messages validates/copies/freezes plain own-data records. Maximum128 entries, ASCII keys matching [a-z][a-z0-9_.-]{0,127}, values bounded4096 UTF8bytes with lossless Unicode, no NUL or terminal control characters except newline/tab. Whole JSON-serialized catalogue maximum64KiB. No accessors/symbols/inherited/undefined/non-string values; bounded empty catalogues valid.
- bundledMessages: frozen English catalogue with exactly `bundle.ready: "Bundle is ready."` and `bundle.greeting: "Hello, {name}."`.
- loadMessages(root:string,locale?:string):Promise<Messages>, default en. Root explicit absolute/canonical directory. Locale bounded2..35 ASCII characters matching [a-z]{2,3}(?:-[A-Za-z0-9]{2,8})* (also total bound), no traversal/path coercion. Root lang/<locale>.ts is trusted default-export own-data text catalogue, regular single-link/no-symlink file maximum64KiB; checked real lang directory and canonical root aliases. Missing en source uses bundled English. Existing en source merges over bundled keys; other locales require an explicit source and have no implicit cross-locale fallback. Missing keys reject rather than return fabricated translation success. Source fixed-URL Bun ESM caching, not managed reload/sandbox; no importing unsafe source during failed validation.
- translate(root:string,key:string,options?:{locale?:string;values?:Readonly<Record<string,string|number>>}):Promise<string>. Validate key/options/replacements and bounds before source import. Values plain own-data maximum32, names [A-Za-z][A-Za-z0-9_]{0,63}, strings maximum512 UTF8bytes/lossless/no prohibited controls or finite numbers. Snapshot before awaits. Replace {name} ASCII placeholders, require every placeholder value and reject supplied unused names. Literal other braces stay plain text. Result bounded8192 UTF8bytes. Generic errors, not trusted source/secret dumps. No pluralization, locale detection, ICU/gettext, nested namespaces, currency/date formatting or markup renderer.

## Publication contract

New src/localization/publication.ts exports publishLanguageResources(root:string):Promise<{created:string[]}>. It exclusively writes `lang/en.ts` containing valid code-only default export of the complete bundled English catalogue, mode0600, using safe root canonicalization/no-symlink parent checks and exclusive no-follow creation. Never import an existing catalogue during publication. Refuse existing/dangling/symlink/hardlink/unrelated output; even global force does not overwrite translations. No application DB/config/environment writes. No new stub inventory entry; catalogue is a real bundled resource, not a generator class stub.

New src/cli/language.ts registers registerLanguage(program,{root,output}) and `lang:publish`, output safe JSON repository-relative created paths and generic failure. Leader integrates program.ts; worker does not modify shared registration/docs/compatibility.

## Evidence gates

Observe missing API/command failures red before production. Backend tests cover bundled/default/override/explicit locale fallback semantics, strict copied/frozen Unicode/control/byte shapes and replacements, pre-import validation, unsafe source/path/size/link refusal and fixed import lifetime. Publication must preserve existing content/links and no output outside destination. Actual separate CLI publishes, generated code strictly compiles, and real custom commands use translate before/after a customized catalogue in fresh processes; no DB opened. Unknown/missing replacement and traversal failure do not emit source secrets. Independent review/reproduce/repair and fresh whole suite/types/graph/provenance precede single lang:publish reference credit.

No dependencies/downloads/services/markup/commits or real application database resets. Trusted transitive imports/constructors/source direct output remain ordinary code side effects, not a security sandbox. No hostile concurrent path replacement, power-loss persistence or multi-host guarantees. All caller-controlled test state uses unique disposable roots.
