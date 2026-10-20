# Releasing tinytrace 1.0.0

Package: **`@garvj65/tinytrace`**. Repository: [garvj65/tinytrace](https://github.com/garvj65/tinytrace). The unscoped `tinytrace` name belongs to another package. Verify npm-account ownership or publishing permission for the configured scope before releasing.

## What the automated release does

[Publish npm](.github/workflows/publish.yml) runs after a successful trusted main-branch CI push, or can be started manually on main. It checks that CI passed for the exact checked-out commit, installs the lockfile with lifecycle scripts disabled, checks npm advisories and registry signatures, and publishes with provenance. The publish lifecycle runs the full tests, size guard, demo, and clean-consumer package/type checks before publishing.

CI includes Linux Node 22/24/26, Windows Node 24, Gitleaks history scanning, and CodeQL security-extended queries. Test jobs never receive a publishing token. Release credentials are available only to the trusted publish job.

An existing immutable npm version is not overwritten. The final step compares the registry tarball's SHA-512 integrity with a fresh local pack. A different artifact under the same version fails verification: increment the version rather than attempting to replace it.

## Authenticate the first release

The repository cannot infer npm account ownership from a GitHub username. Choose an authenticated publisher:

- **GitHub release:** add a granular npm publishing token as the repository Actions secret `NPM_TOKEN`. It must authorize this package/scope and satisfy the npm account's 2FA policy. Do not paste the token into chat, files, workflow text, or commits. Run **Publish npm → Run workflow → main**, or rerun its failed publishing job after authentication is configured.
- **Local first publish:** clone the verified main branch, run `npm ci`, `npm login`, `npm whoami`, `npm run check`, `npm audit --audit-level=low`, and `npm audit signatures`. Then run `npm publish --access public` followed by `npm run verify:registry`. Local publishing does not generate GitHub provenance.

If the npm username differs from `garvj65`, update the package name, lockfile, README, and consumer-test import references before publishing, then run CI again.

## Prefer OIDC for later releases

After the package exists, configure its npm trusted publisher:

| Field | Value |
| --- | --- |
| Organization/user | `garvj65` |
| Repository | `tinytrace` |
| Workflow filename | `publish.yml` |
| Allowed action | Explicitly allow `npm publish` |
| Environment | Leave empty; this workflow has no GitHub environment binding |

The workflow uses Node 24 and npm 11.9.0, meeting npm's documented trusted-publishing requirements. Once OIDC publishing is verified, revoke/remove the bootstrap `NPM_TOKEN`. Never publish on untrusted pull-request events.

See npm's official [publishing guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) and [trusted-publisher guide](https://docs.npmjs.com/trusted-publishers/).

## Version changes

Bump `package.json`, both root version fields in `package-lock.json`, and the fixed package/version allowlist in `scripts/verify-registry.mjs` together. Every published package artifact is immutable, including its packaged README and reference docs. A change to shipped content needs a new version before the next publish. Check the published version and integrity using `npm run verify:registry`; a green source CI run alone does not prove publication.
