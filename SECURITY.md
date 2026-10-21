# Security scope

Report a suspected vulnerability through the repository's available private GitHub security reporting channel. If private reporting is unavailable, contact the maintainer through a private channel before posting sensitive details. Never include real credentials, customer data, or exploit payloads containing private data in a public issue.

## Trust boundaries

- Application options, endpoints/DSNs, hooks, source maps, and integration callbacks are trusted configuration/code.
- Captured errors and context may contain sensitive data. Hook output, recovered storage records, and network responses require validation.
- Persistent storage is private host/origin state, bound to one destination and one active instance. Do not use shared network directories or databases simultaneously across clients.
- The npm publish token is available only to the guarded release step; tests do not need secrets. CI actions are pinned by commit SHA.

## Properties reviewed and tested

SDK failures must be contained at capture/transport/storage boundaries. Async application callbacks retain normal errors/returns. Queues, payloads, context, spans, map registries, disk records, retries, and retention are bounded. Requests have deadlines. SDK timers/sockets do not keep a healthy Node process alive; OS filesystem operations may remain active until complete.

Default and application-specific redaction run before persistence/transmission; unknown schema fields are stripped and fingerprints recomputed. Hooks see raw input and remain responsible for their own logging. Literal domain rules avoid executing arbitrary user-supplied regular expressions. No request headers, bodies, URLs, cookies, or authentication data are collected automatically by framework integration.

Node outbox files are written privately and atomically; POSIX directories require 0700. Symlinked final directories/files are rejected, invalid recovery records are discarded individually, and destination mismatch/live ownership prevent replay. Existing valid records are preserved when a configuration lowers capacity. Browser outboxes use strict IndexedDB transactions and Web Locks. Storage errors are observable and prevent transmission from an uninitialized store.

Explicit source maps are bounded data; the SDK does not download maps or execute/read source files. Public Sentry DSNs are routed only through the configured receiver; secret DSN passwords are rejected. Browser fetch omits ambient credentials and rejects redirects. Fatal diagnostics contain no original exception text.

## Limits

Redaction cannot discover every kind of private data. Outbox files and IndexedDB records are plaintext; device/origin access controls and encryption remain the host's responsibility. XSS, malicious application code/hooks, OS administrators, compromised local volumes, and malicious dependency/toolchain execution are outside the SDK's isolation boundary. Hooks can block the event loop because they execute in-process.

Persistent delivery is not lossless or exactly once. A kill before the persistence barrier, OS/device/browser failure, browser eviction, finite capacity/retention, or permanent server rejection can lose events. A crash around acknowledgement can duplicate them. Windows directory-entry durability and multi-host locking are not guaranteed by the portable implementation. PID reuse can conservatively block recovery.

The included ingest server is a localhost demo without authentication, durable storage, or cross-origin configuration. Public deployment requires a separate service threat model and access controls. The Sentry adapter covers a tested wire subset and does not implement Sentry's entire quota-category protocol or feature set.

## Automated gates

Full-history Gitleaks, CodeQL security-extended with a zero-findings gate, npm advisories including dev dependencies, registry signature checks, cross-platform regressions, real Chromium tests, clean package consumers, and published artifact integrity checks run through GitHub Actions. These checks reduce risk; they do not certify an absence of vulnerabilities.
