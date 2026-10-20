# Security scope

tinytrace is a small Node.js monitoring SDK and loopback ingest demonstration. The application, SDK configuration, endpoint selection, and `beforeSend` code are trusted. Exception contents, captured context, and incoming ingest bodies are treated as untrusted data.

## Protections and boundaries

- Hook output is serialized into a bounded snapshot, validated against the event schema, and stripped of unknown fields before batching.
- Pattern-based redaction is enabled by default and covers supported event fields and tag keys. It is not a universal PII detector. `beforeSend` receives original data; application hooks and host loggers must apply their own privacy policy.
- SDK fatal diagnostics contain no raw exception. Event fingerprints are recomputed after default redaction; hashes alone are not anonymization.
- The queue includes the active batch in its capacity bound. Event bodies, request duration, retry counts, and retry waits are bounded. HTTP redirects are not followed, and TLS certificate validation uses Node defaults.
- The CLI ingest server binds to `127.0.0.1`, limits request/batch sizes, and bounds groups/deduplication history. It has no authentication or durable storage and must not be exposed as a public service.
- Use HTTPS for remote ingest destinations. Process-wide tags/breadcrumbs are not tenant or request isolation.
- Node lifecycle interception is explicit. Once the host registers an error handler, it owns shutdown until reinitialization; removing a host handler does not hand ownership back to the SDK. Frameworks that own this lifecycle can disable `globalHandlers`.

## Automated checks

CI runs Gitleaks against Git history, CodeQL security-extended queries, npm advisory checks including development dependencies, registry signature verification, and functional/privacy/lifecycle/package regression tests. Third-party actions are pinned to reviewed commit SHAs. Checkout credentials are not persisted. Publish credentials are confined to the trusted release job.

These checks do not establish that the software is free of all defects or that arbitrary sensitive data can never be captured. Review deployment-specific data policies and keep Node.js and development dependencies updated.

## Reporting

Use GitHub private vulnerability reporting if enabled. Otherwise, open a public issue containing only a non-sensitive summary and request a private reporting channel. Never post credentials, unredacted customer recordings, private-key material, or sensitive event payloads in a public issue.
