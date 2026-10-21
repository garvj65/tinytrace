# Releasing tinytrace

The package is `@garvj65/tinytrace`. Version 1.0.0 is the initial published SDK; version 2.0.0 is the final operational/platform expansion. npm versions are immutable.

## Release process

1. Update version in package.json and both root version fields in package-lock.json. Add changelog/migration notes.
2. Run npm ci --ignore-scripts, npm run check, npm run test:browser, npm audit --audit-level=low, and npm audit signatures. Install the pinned Playwright Chromium binary first if needed.
3. Open a PR and inspect the exact changed runtime paths, package exports, persistence/privacy contracts, docs, and CI results. The main-branch CI matrix includes browser, security, and CodeQL jobs.
4. Merge only after those checks succeed. Publish npm runs after trusted main-branch push CI succeeds and checks the exact release SHA again. The workflow uses Node 24 and npm 11.9.0, LF output, and an uncached release install.
5. Publishing runs package-consumer tests, attaches public provenance, and verifies the registry name/version and SHA-512 tarball integrity against a deterministic local pack. Registry propagation is polled for up to roughly four minutes plus request timeouts.
6. Inspect the successful release run and npm page. An existing immutable version is skipped and still integrity-verified. A different artifact with the same version fails verification; it must not be overwritten.

Only package.json/lockfile version fields need updating for future versions; registry verification and artifact names are version-independent. The verified tarball is retained as a main CI artifact for 14 days. README/package bytes are part of the immutable artifact: changing them without a version bump means the current tree will no longer reproduce the previous tarball.

## Publishing authentication

The GitHub repository secret NPM_TOKEN must hold a granular token with package/scope publish access and the noninteractive 2FA policy needed by npm publish. Keep it out of files/chat/logs. Tokens expire; rotate/revoke them through npm and update the repository secret. The secret is passed only to the publish step.

After the package exists, npm trusted publishing can replace this bootstrap token. In the package's npm settings, add GitHub Actions with:

| Field | Value |
| --- | --- |
| Organization/user | garvj65 |
| Repository | tinytrace |
| Workflow filename | publish.yml |
| Environment | Blank (no environment is used by this workflow) |
| Allowed action | Explicitly allow npm publish |

The workflow already grants id-token: write and uses a supported npm/Node toolchain. Validate a new-version publish through OIDC before revoking/removing NPM_TOKEN. Do not try to republish an existing version as a credential test. Consult [current npm trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/) when making account changes.

## V1 to v2 migration

Existing Node capture/init/tag/breadcrumb/flush/close calls continue to work, and ESM/CommonJS share a client. Fingerprints change to a portable grouping algorithm, so old/new versions can form different groups. Error and message redaction remains enabled by default. Payloads additionally support browser platform, release, trace contexts, spans, and transaction events; a custom receiver should accept these fields.

Persistent mode is opt-in. Use a private persistent local directory on Node or a distinct browser database per live client; add domain privacy rules before enabling storage. A synchronous capture ID does not confirm disk persistence: use captureExceptionAsync or persist. Transient exhausted retries remain queued in durable mode, so flush/close can return false while recoverable records remain on disk.

Wrap concurrent Node work in withScope or use request middleware. Browser async code must use the callback's explicit scope. beforeSend remains the error/message hook; beforeSendTransaction handles transactions. Source maps must be registered explicitly, or use Node's native source-map flag.

The browser entry needs an ingest endpoint with an appropriate CORS policy. The included CLI server remains a localhost demo. Public Sentry DSNs use a tested error/message/basic-transaction envelope subset; a live Sentry project must be checked by its owner before relying on that deployment.
