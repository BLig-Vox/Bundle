# Trusted native JavaScript tinker

> Reviewed native Bun equivalent, not PHP/PsySH interoperability. The repaired pre-provenance full suite passed 1,005 tests with 2 opt-in live-database skips and no failures; strict types passed in 212 files. See the durable plan for final source/provenance gates and broader unfinished compatibility work.

```sh
bun run bundle tinker
bun run bundle tinker --execute 'await Promise.resolve(21 * 2)'
# Enable the explicit owned lazy database helper only when intended:
bun run bundle tinker --allow-database
```

Tinker uses Bun's existing Node-compatible `node:repl`. No REPL package is downloaded, no shell subprocess is started and no code is read from a remote service. This is a **trusted local developer JavaScript environment, not a sandbox**. Code can access the host process, files, modules and network. Do not run untrusted snippets. It is not a remote execution endpoint, browser automation/MCP capability or PHP/PsySH interoperability.

Interactive use requires a TTY; noninteractive use must explicitly supply `--execute`. Inline source is visible in process arguments, so do not put secrets there. Native expression values/errors are visible to the developer and arbitrary code can deliberately print credentials; there is no comprehensive output redaction or capture guarantee. No persistent REPL history/transcript is configured by Bundle; explicit native commands or developer code can still write files.

## Application bindings

Normal application provider/command bootstrap occurs before `tinker`, unlike the independent `new` installer. Existing trusted hooks can perform their ordinary side effects. The real runner's current service scope is forwarded into the REPL; no fake service container is invented for a host that supplies none.

```js
bundle.root
bundle.services?.resolve("application-service")
require("./package.json").name
(await bundle.import("./src/models/User.ts")).User
```

Bindings use the canonical selected root without changing process.cwd. Rooted `require` and the explicit file-import helper let the developer choose application modules deliberately. Native JavaScript bindings/multiline input/top-level await are supported by the REPL. Interactive pasted cells are serialized across awaited evaluation; recoverable multiline input remains one cell. `--execute` evaluates one complete JavaScript program and prints its final result, not every intermediate expression. Use an array or explicit `console.log` to display several values; ordinary JavaScript semicolon-insertion rules apply. Execute source and queued interactive input are bounded to 64 KiB. TypeScript annotations, PHP syntax, source hot reload and arbitrary package installation are not promised. Ordinary Bun ESM caching applies.

## Explicit database ownership

No Bundle-owned database is opened by default, including when `--allow-database` is supplied but the helper is unused. Without that flag `bundle.database()` refuses. With it, the helper lazily opens one owned selected ORM instance and reuses the opening/result for the session:

```js
const orm = await bundle.database()
const em = orm.em.fork()
const User = orm.getMetadata().getByClassName("User").class
await em.count(User)
```

Production-owned helper opening retains global `--force`; configured named target/path selection remains explicit. Database operations can create/change application data and native ORM APIs bypass ordinary migration-command guards. Review the target first. Bundle closes its owned ORM after active awaited session work settles; it does not flush or close a caller manager/ORM.

The flag/guard controls the **Bundle helper only**. Arbitrary trusted JavaScript or pre-existing provider hooks can perform their own database/filesystem/network operations; this is not a security boundary preventing developer code from doing so.

## Lifecycle and limits

The session owns only its native REPL, private execute input and explicitly opened ORM. Supplied service scopes and external input/output streams remain caller-owned. Owned listeners/input state are cleaned up on exit/cancellation/failure. Ctrl+C interruption and outer SIGINT/SIGTERM use standard CLI interruption statuses. Clean interactive exit returns0; explicit evaluation errors return nonzero. Recoverable multiline continuation is not a terminal evaluation failure.

Awaited evaluations settle before owned database cleanup. Cancellation is cooperative: code that blocks the event loop or never settles an awaited operation cannot be forcefully stopped here. Unawaited side effects and application-spawned descendants are not undone or comprehensively reaped. There is no transaction/rollback guarantee, process sandbox, automated secret isolation or persistent debugger.

The programmatic API is `runTinker` in `src/console/tinker.ts`; only explicit `openDatabase` callbacks enable its owned helper. Embedding hosts must provide exclusive input ownership and their intended service scope. Actual native-stream, CLI execute, scoped-provider, disposable SQLite, PTY and signal consumers and final verification results are recorded in the implementation plan once integrated.
