# Releasing tinytrace

The current npm name is the provisional `@garvj65/tinytrace`. The unscoped `tinytrace` is already a different package. Confirm the scope is yours before publishing, or rename the package to your own npm scope.

1. Sign in locally with `npm login`, then check `npm whoami`. Never commit credentials or put a publishing token in the repository. Confirm publishing permission for the configured npm scope before releasing.
2. If needed, run `npm pkg set name=@YOUR_NPM_USERNAME/tinytrace`, then `npm install --package-lock-only`. Update the README's name. Package metadata points to `https://github.com/garvj65/tinytrace`; retain that URL when publishing this repository.
3. Run `npm ci`, `npm test`, and `npm run demo`. Inspect `npm pack --dry-run`, then run `npm pack` to generate the installable tarball. Build output, declarations, README, license, and the demo GIF should be present; tests and credentials should not.
4. In a temporary empty directory, run `npm init -y` and `npm install /absolute/path/to/garvj65-tinytrace-0.1.0.tgz --ignore-scripts`. For a renamed package, use its actual generated tarball filename. Smoke-test `node --input-type=module -e 'import { captureMessage, close } from "@garvj65/tinytrace"; captureMessage("safe before init"); console.log(await close())'` with the final package name.
5. Run `npm publish --access public --dry-run`, inspect it, then `npm publish --access public`. Complete npm's required account/2FA checks. Verify the published package with `npm view @garvj65/tinytrace version` and install it in a clean consumer directory.

For subsequent CI releases, configure npm trusted publishing for the actual repository and workflow and add a dedicated release workflow with `id-token: write`. Do not publish on every push. CI in this project only verifies code; it does not publish. npm's current requirements and setup are in its official [publishing guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) and [trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

Optional next project: a separate Sentry envelope adapter. Check Sentry's current protocol documentation first and test it independently. The local `{ events: [...] }` format is intentionally not advertised as compatible with Sentry ingest.
