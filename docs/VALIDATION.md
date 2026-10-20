# v1 validation

The committed CI workflow is the source of current pass/fail evidence: [Actions](https://github.com/garvj65/tinytrace/actions) and [hardening PR](https://github.com/garvj65/tinytrace/pull/1).

| Check | Verification |
| --- | --- |
| Strict TypeScript build | ESM JavaScript and declarations; checked indices and unused locals/parameters. |
| Regression suite | 39 tests, including host on/once/prepended handlers before and after init, strict rejection deduplication, privacy, hook schema rejection, real HTTP Retry-After, and ingest validation. |
| Platforms | Linux Node 22, 24, 26; Windows Node 24. |
| Lifecycle bounds | Child-process shutdown duration, confirmed in-flight background requests, and repeated listener cleanup. |
| Demo | Real loopback HTTP: 3 events grouped into 2 issues, delivery true. The GIF illustrates this flow; fingerprint values may differ across releases. |
| Package consumer | Install the actual tarball without development dependencies; exercise HTTP delivery and default redaction, then type-check consumer imports and an intentionally invalid option. |
| Size | 789 handwritten TypeScript/JavaScript lines including tests, demo, and verification scripts; 410 lines are runtime SDK/server code. CI enforces fewer than 800 lines. |
| Secret scanning | Gitleaks 8.24.3 with full Git history. Test tokens are synthetic. |
| Static analysis | CodeQL JavaScript/TypeScript security-extended queries; CI fails if the generated SARIF contains findings. |
| Dependency integrity | npm advisory checks including development dependencies and npm registry signature verification. Runtime dependencies: zero. |
| Release | Trusted exact-commit CI gate, publish provenance, and registry tarball integrity comparison. Requires authenticated npm publishing permission. |

## Contract checks

Queue overflow, exhausted retries, and retry hints beyond budget can lose events by design. A timed-out flush leaves background work running; close cancels it. Flush reports any transport-level loss since initialization. Delivery is in-memory and best effort.

Host lifecycle ownership is recorded when its handler exists at initialization or is registered later and remains delegated until reinitialization. This avoids inferring ownership from a listener count that changes while `once` handlers execute. Frameworks can use `globalHandlers: false`. The SDK does not reproduce every Node rejection flag or custom exception-capture callback behavior.

Redaction is pattern-based and applied after the hook and schema snapshot. It covers supported fields, duplicated exception messages, tag keys/values, recognized credential formats, emails, and home-directory usernames. It does not identify every possible secret or personal-data format. Hooks and application loggers remain trusted code and can expose their own input.

The ingest server is a bounded, unauthenticated loopback demo. Public hosting, durable delivery, request-local context, source maps, UI, framework adapters, and Sentry protocol compatibility remain outside v1.

The initial environment was unavailable during this hardening pass; executable verification is performed on GitHub-hosted runners. Passing checks provide evidence for the tested contracts, not a guarantee that every possible defect is absent.
