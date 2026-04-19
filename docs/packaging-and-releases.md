# Packaging and Releases

## Packaging targets

Open Cowork packages desktop artifacts with Electron Builder.

Current release targets:

### macOS

- `.zip`
- `.dmg`
- `x64`
- `arm64`

### Linux

- `.AppImage`
- `.deb`
- `x64`

## Local packaging

From the repository root:

```bash
pnpm --dir apps/desktop dist:ci:mac
pnpm --dir apps/desktop dist:ci:linux
```

Artifacts are written to:

```text
apps/desktop/release/
```

## CI workflow

The repository includes:

- `ci.yml`
  - lint
  - tests
  - desktop Electron smoke tests on macOS
  - typecheck
  - perf gate
  - dependency audit at `high` severity
  - docs build

- `docs.yml`
  - builds MkDocs with `--strict`
  - uploads the built static site as a GitHub Pages artifact
  - deploys the published docs site on pushes to `main`

- `release.yml`
  - builds release artifacts for macOS and Linux
  - creates GitHub Releases automatically for version tags
  - publishes `SHA256SUMS.txt`
  - attaches GitHub build provenance attestation metadata

- `monthly-maintenance.yml`
  - runs on the first day of each month
  - checks dependency audit state, outdated packages, and SDK drift
  - exists to catch maintenance issues without a noisy nightly signal

## Documentation deployment

The docs site is built from `docs/` using MkDocs Material and deployed
through GitHub Pages. The deploy workflow does not push a generated
branch back into the repo; it uploads the built `site/` directory as a
Pages artifact and lets GitHub handle the publish step. That keeps the
release repo cleaner and makes docs deploys easier to reason about in CI.

## Release flow

Recommended release flow:

1. Merge validated changes to `main`
2. Create and push a version tag like `v0.2.0`
3. Let `release.yml` build platform artifacts
4. Verify the resulting GitHub Release includes checksums and provenance
5. Smoke-test at least one macOS build and one Linux build before announcing it

## Signing and notarization

The upstream workflow currently builds unsigned artifacts by default.

That is acceptable for:
- internal testing
- development builds
- downstream customization work

For public production distribution, downstream maintainers should add:
- macOS code signing
- macOS notarization
- any Linux package signing they require
- any internal release approval or artifact mirror steps they require

### Signing pointers for downstream

electron-builder reads the standard signing environment variables. A
typical macOS release job sets:

```yaml
env:
  CSC_LINK: ${{ secrets.MAC_CERTIFICATE_P12_BASE64 }}
  CSC_KEY_PASSWORD: ${{ secrets.MAC_CERTIFICATE_PASSWORD }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

The upstream `release.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY: false`
to skip signing. A downstream fork typically removes that line and
adds the block above. electron-builder's own documentation — in
particular [Code Signing](https://www.electron.build/code-signing)
and [Notarization](https://www.electron.build/notarize) — is the
authoritative reference for the full set of knobs.

For a genuinely production-grade public release, treat signing and
notarization as a release requirement, not an optional polish item.
The upstream workflow is a solid unsigned release pipeline; the final
public release repo still needs secrets and policy configured around it.

## Notes

The packaged app bundles:
- the desktop renderer and main/preload code
- Open Cowork config and schema
- bundled skills
- bundled MCP packages
- the OpenCode CLI/runtime dependency needed by the desktop app

Chart rendering in packaged builds is sandboxed in the main process. If a downstream
distribution needs to support unusually heavy Vega/Vega-Lite specs, it can raise the
render timeout with `OPEN_COWORK_CHART_TIMEOUT_MS`.
