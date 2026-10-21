# V2 validation

The authoritative current results are the [CI runs](https://github.com/garvj65/tinytrace/actions/workflows/ci.yml) and [npm release runs](https://github.com/garvj65/tinytrace/actions/workflows/publish.yml). A release is complete only after exact-commit CI and registry integrity verification succeed.

| Check | Evidence exercised |
| --- | --- |
| Strict builds | ESM/browser modules, CommonJS output, declarations, checked indexing, unused parameters/locals. |
| V1 regressions | Original capture, privacy, stack, retry, batching, dedup, sampling, hook, and fatal lifecycle tests retained. |
| Hard-crash recovery | A child persists a sanitized event, is killed, and a new client replays its original ID. |
| Durable failure modes | Transient-cycle retention, persistent Retry-After across restart, permanent rejection, file/capacity bounds, wrong destinations, live owners, corrupt/expired/symlink records, and runtime expiry. |
| Context isolation | Concurrent async siblings, nested scope restoration, unchanged callback exceptions, and independent request tags. |
| Frameworks | Real Express 5 concurrent failing requests and native Node HTTP rejection handling. |
| Mapping/tracing | Flat v3 mappings, malformed VLQ rejection, browser stacks, child-parent IDs, correlated errors, and separate transaction hooks/sampling. |
| Protocol | Local HTTP receiver validates public-DSN endpoint routing, authenticated envelopes, UTF-8 lengths, exception frame order, transactions, and browser envelopes. |
| Browser | Real Chromium global errors/rejections, explicit async scopes, privacy, spans, credential omission, IndexedDB persistence/reload, tab ownership, destination mismatch, and byte limits. |
| Package consumers | Install the actual tarball without dev dependencies; exercise real HTTP, CommonJS/ESM singleton identity, integrations entry, and Node/browser TypeScript declarations. |
| Platforms | Linux Node 22/24/26, Windows Node 24; Chromium via Playwright. |
| Size | Runtime below 1800 lines and all handwritten runtime/tests/examples/scripts below 3500; v1's 789-line milestone is historical. |
| Secrets | Full reachable Git history with Gitleaks. Test credentials and IDs are synthetic. |
| Static analysis | CodeQL JavaScript/TypeScript security-extended; generated SARIF findings fail CI. |
| Dependencies | npm audit including dev tools and npm audit signatures; no runtime dependencies. |
| Release | Exact trusted main commit, public npm provenance, bounded propagation polling, and SHA-512 tarball integrity comparison. |

## Scope of the evidence

A passed test suite is evidence for these contracts, not proof that every possible defect is absent. Storage durability still depends on the OS, volume, browser, and completion of the persistence barrier. Disk exhaustion, denial, eviction, retention, permanent receiver rejection, and kills before persistence can lose data. Crash windows around acknowledgement can duplicate events.

Windows does not provide portable directory fsync through Node; multi-host/network-filesystem outboxes are unsupported. Browser tests cover Chromium, not every engine. Browser async isolation uses explicit scoped clients; uncaught global errors carry baseline context. Source maps are explicitly registered flat v3 maps. Tracing is basic scoped/request duration measurement without distributed header propagation.

The Sentry wire subset is validated against a local contract receiver and the official documented format. No live Sentry account was configured, so production acceptance by a particular Sentry deployment remains an integration check for its owner. Sessions, attachments, and Sentry SDK feature parity are not claimed.

The ingest server remains an unauthenticated loopback demo with bounded in-memory grouping. A hosted backend, durable server history, UI, authentication, and alerting are outside the final SDK scope.
