# Changelog

## 1.0.0 — prepared release

- Core TypeScript SDK, local grouped ingest server, bounded batching and retry, context, sampling, and hooks.
- Stable host shutdown ownership across handler registration order, one-shot listeners, and prepended listeners.
- Default pattern-based redaction, generic fatal diagnostics, schema validation, and immutable event snapshots.
- Respect server retry hints; stop retries when the requested wait exceeds the configured budget.
- Expanded lifecycle/privacy/real-HTTP regressions, Linux and Windows CI, clean-consumer ESM/declaration checks, and an enforced sub-800-line code budget.
- Pinned actions, history secret scanning, CodeQL, npm advisory/signature checks, and a gated npm release with provenance and registry-integrity verification.

Publication is complete only when the configured npm registry version exists and `npm run verify:registry` confirms its artifact.
