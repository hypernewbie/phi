# `@hypernewbie/phi-code` — npm package notes

## npm v12 install-time security

As of npm v12 (https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/),
**`postinstall` scripts no longer run by default**. This package's `postinstall`
(`scripts/install.js`) downloads the platform-native Go binary from GitHub releases
— without it, `phi` won't install.

### Project-scoped installs
This `package.json` ships an `allowScripts` entry that auto-approves the script:

```json
"allowScripts": { "@hypernewbie/phi-code": true }
```

So `npm install @hypernewbie/phi-code` (or `--save`) Just Works.

### Global installs (`npm install -g`)
There's no project `package.json` in global mode, so npm v12 can't read the
allowlist. End users on npm v12+ will need one of:

```sh
npm install -g @hypernewbie/phi-code --allow-scripts
```

or persist it once:

```sh
npm config set allow-scripts=@hypernewbie/phi-code --location=user
npm install -g @hypernewbie/phi-code
```

(or use `--ignore-scripts` and run `npx --yes @hypernewbie/phi-code` to fetch the
binary on demand.)

## Trusted publishing (OIDC)

The release workflow (`.github/workflows/release.yml`) is configured for
npm's trusted-publishing flow with OIDC: the `npm-publish` job has
`id-token: write` permission and calls `npm publish --provenance`. To complete
the migration:

1. On npmjs.com → package `@hypernewbie/phi-code` → **Publishing access** →
   **Trusted Publishers** → **Add trusted publisher**:
   - Owner: `hypernewbie`
   - Repository: `phi`
   - Workflow filename: `release.yml`
2. Remove the `NPM_TOKEN` repo secret once you've confirmed a tagged release
   publishes successfully via OIDC alone (set `NODE_AUTH_TOKEN: ''` in the
   workflow temporarily to test).

Until both are done, the workflow falls back to the legacy `NPM_TOKEN` secret.