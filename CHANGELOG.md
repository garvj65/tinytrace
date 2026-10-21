# Changelog

## 2.0.2 — 2026-10-21

- Finalize the README with project completion status, local receiver setup, API overview, lifecycle guidance, and an explicit guarantees/limitations table.
- Correct the source-map/protocol reference link and explain that registry integrity verification requires the exact release checkout.
- Keep the example persistent outbox outside the repository and align npm metadata with Node/browser support. SDK behavior is unchanged.

## 2.0.1 — 2026-10-21

- Truncate long headerless browser stacks to 32 frames instead of rejecting them.
- Require the current main commit for release automation, preventing stale successful CI from publishing after main moves.
- Verify SDK protocol metadata matches the installed package version.

## 2.0.0 — 2026-10-21

- Add opt-in private Node disk and browser IndexedDB outboxes, persistence barriers, startup replay, stable retry IDs, retention/capacity controls, and delivery counters.
- Retain exhausted transient failures for later durable cycles and preserve written Retry-After deadlines across restart. Fail closed on storage ownership, destination, or initialization errors.
- Add isolated Node AsyncLocalStorage scopes and explicit async browser scopes, with inherited bounded context.
- Add domain-specific literal/key/path redaction and tag allowlists before storage/delivery; validate sanitized payloads and recovered records.
- Add a browser-safe ESM entry, automatic browser errors/rejections, and tested Express 5/native HTTP integration.
- Add explicitly registered flat v3 source maps, nested async/request spans, error correlation, separate transaction hooks/sampling, and basic Sentry envelopes.
- Add CommonJS with shared ESM client identity, clean package/type consumers, hard-kill recovery tests, and real Chromium reload/ownership checks.
- Make release verification version-independent and tolerant of npm propagation delays. Expand the code budget to match the authorized v2 scope.

Migration: fingerprints change; persistent mode is opt-in; browser async code uses explicit scopes; beforeSendTransaction is separate from beforeSend. See RELEASING.md and docs/SDK.md for guarantees and limits.

## 1.0.0 — 2026-10-21

- Publish the zero-runtime-dependency Node SDK with manual/automatic capture, stack parsing, tags, breadcrumbs, sampling, hooks, default redaction, schema validation, bounded batching/retry, and explicit lifecycle APIs.
- Include a local grouping/dedup ingest server, demo GIF, 39 regressions, Linux/Windows CI, Gitleaks, CodeQL, dependency checks, and verified npm provenance/integrity.
- Complete the original 789-line educational milestone with host-owned shutdown and long Retry-After correctness fixes.
