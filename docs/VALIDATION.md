# Validation — October 20, 2026

Verified locally with Node.js **24.19.0**, npm **11.9.0**, and TypeScript **5.9.3**.

| Check | Evidence |
| --- | --- |
| Clean dependency installation | `npm ci` succeeds from the lockfile. Three development packages are installed; the SDK declares no runtime dependencies. |
| Strict TypeScript compilation | `npm run build` passes, including unused-local/parameter and unchecked-index checks. Emits ESM JavaScript and declarations. |
| Test suite | **19 tests pass**, including child-process fatal delivery/shutdown tests. |
| End-to-end demo | Real HTTP loopback delivery: **3 events, 2 groups, delivery true**. `demo-output.txt` records the actual output; `demo.gif` renders that output as an animation. |
| Package verification | npm tarball inspected and installed into a clean consumer with development dependencies omitted; root ESM imports and real HTTP capture work. |
| Scope | **551** physical lines across `src/*.ts`, `test/*.mjs`, and `examples/*.mjs`; **331** are runtime SDK/server code. Generated build files and configuration/docs are excluded. |

The npm tarball includes compiled files, declarations, README, license, release notes, the SDK reference, validation notes, and the demo GIF. The repository contains TypeScript source, the lockfile, tests, the runnable demo, and GitHub Actions configuration. Build output and package tarballs are reproduced locally rather than committed.

## Review and limitations

- Queue capacity counts the active batch; overflow drops the newest incoming event. Permanent HTTP errors do not retry; transient errors have a finite retry budget and a total per-request deadline.
- One active batch prevents duplicate concurrent sends from overlapping flushes. IDs survive retries, while the local server bounds its deduplication memory.
- Explicit flushes keep their deadline alive; background network work does not keep a healthy test process running. Close detaches only SDK-owned listeners and cancels pending requests/retry timers after its deadline.
- Existing host handlers retain shutdown ownership, including the case where a rejection must escalate to a host uncaught-exception handler added after initialization. Strict-mode rejection tests verify one captured event, not duplicates.
- Public context calls contain invalid values; hook errors, recursion, accidental async hooks, circular payloads, and oversized events are contained. Synchronous event building/hook execution still costs CPU; user code that blocks forever cannot be preempted.
- Transport delivery is best effort and memory-only. Queue overflow, exhausted retries, abrupt exits, and sampling/filtering can discard events. `flush()` reports any transport-level loss since initialization, not just losses during the current flush.
- The ingest server is a loopback demonstration with bounded in-memory counts, no authentication, and no durable storage. Source maps, UI, performance instrumentation, framework adapters, and Sentry protocol compatibility are outside this release.

GitHub Actions is configured for Node 22, 24, and 26; current results are available under [repository Actions](https://github.com/garvj65/tinytrace/actions). The local checks above were run on Node 24.19.0. npm publishing was not performed: `npm whoami` returned `ENEEDAUTH`. The unrelated unscoped npm package `tinytrace` already exists, so the proposed release name is `@garvj65/tinytrace`; scope ownership still needs to be confirmed with the publisher's npm account.
