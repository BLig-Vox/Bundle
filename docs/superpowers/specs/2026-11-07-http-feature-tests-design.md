# Native HTTP feature-test scaffolding

## Bounded goal

Complete the original partial feature-test generation reference with an explicitly selected code-only HTTP test and a consuming native loopback test harness. Preserve existing generic make:test and --unit behavior. No third-party test framework, markup, database provisioning, hidden authentication/session setup, mocked router success or package download.

## Runtime API

Add withHttpApplication({root, signal?}, callback) in src/http/testing.ts. Validate and snapshot a closed options record and callback before awaits. Canonical existing absolute root; explicit external AbortSignal is cooperative. Start the existing actual application worker at 127.0.0.1 port0. Give callback a frozen request client with request(path, init?) returning the native Response. Paths must be bounded root-relative single-slash paths without credentials/authority/backslashes/control characters; native URL resolution must retain the owned origin. Requests use manual redirects, not automatic external following. No in-process route-only substitute: maintenance/cache/worker behavior is consumed over the real listener. Caller callback owns consuming/cancelling response bodies. Preserve native RequestInit semantics with the combined cancellation signal; no automatic JSON transformations or framework assertions.

Always stop/await the owned worker in finally, including callback rejection or abort. Cancellation after readiness stops the owned worker, unlike the startup-only underlying server signal, and the API must not report success after abort. Active trusted callbacks remain cooperative; no force termination of caller JavaScript, descendant cleanup, rollback or service sandbox claim. Never close caller scopes/databases or implicitly migrate/seed. Imports remain trusted and use ordinary Bun caching.

## Generation

Add explicit make:test NAME --http /health, mutually exclusive with --unit. Create tests/Feature/<namespaced-name>.test.ts using a consumed http-test.ts.stub; compute relative imports/root URL for arbitrary safe name depth. The scaffold uses Bun test/expect, withHttpApplication, GET of the selected path and an explicit example200 assertion. The caller must choose a real application endpoint and expected semantics; generation never imports routes, starts services or creates an endpoint. Validate the selected path and predictable filename/ancestor/conflict constraints before exclusive writes; force never overwrites. Preserve default generic test locations and existing stubs. Publishing includes the new consumed code-only stub and normal strict typechecking remains valid.

## Evidence gate

Observe missing API/CLI option red. Use unique disposable application roots and existing dependencies only. Actual worker tests cover live JSON route/body/method, cache/maintenance consumption, callback failure, startup/active abort, caller-resource preservation and port closure. Generator consumers execute the generated native Bun feature test against a supplied fixture route; nested names, Unicode/space root, custom stub, invalid paths/unit conflicts, existing output/symlink parents and no generation-time route import are covered. Generated offline project includes the runtime module and still typechecks. Full suite/types/review/provenance/historical180 checks precede any original partial reference upgrade. This does not claim Laravel HTTP assertions, browser testing or parallel database provisioning.
