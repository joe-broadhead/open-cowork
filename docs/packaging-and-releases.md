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
  - packaged desktop smoke tests on macOS
  - Linux packaging validation
  - typecheck
  - perf gate
  - dependency audit at `high` severity
  - docs build

- `docs.yml`
  - builds MkDocs with `--strict`
  - uploads the built static site as a GitHub Pages artifact
  - deploys the published docs site on pushes to `master`

- `release.yml`
  - builds release artifacts for macOS and Linux
  - creates GitHub Releases automatically for version tags
  - publishes `SHA256SUMS.txt`
  - attaches GitHub build provenance attestation metadata

- `monthly-maintenance.yml`
  - runs on the first day of each month
  - checks dependency audit state, outdated packages, and SDK drift
  - exists to catch maintenance issues without a noisy nightly signal

## Verify a download

Release assets include `SHA256SUMS.txt`. After downloading an artifact
from GitHub Releases, place it in the same directory as the checksum
file and run:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

GitHub build provenance is attached to the release artifacts. With the
GitHub CLI installed, verify an artifact against this repository:

```bash
gh attestation verify ./Open-Cowork-0.1.0-arm64.dmg --repo joe-broadhead/open-cowork
```

Replace the filename with the artifact you downloaded.

Linux `.AppImage` and `.deb` artifacts do not carry detached GPG
signatures in v0.1.0. Verify Linux downloads with `SHA256SUMS.txt` and
the GitHub build provenance attestation above.

## Accepted Build Warnings

The Vite 8 / Rolldown build currently emits a small set of known
warnings in local and CI builds:

- React plugin guidance about the future `@vitejs/plugin-react-oxc`
  path.
- Rolldown compatibility warnings from `vite-plugin-electron` options.
- A large lazy Mermaid vendor chunk.

These warnings are reviewed and accepted for v0.1.0. They do not affect
the release gates; lint, typecheck, unit tests, smoke tests, packaged
smoke, perf, audit, and strict docs builds must still pass.

## Documentation deployment

The docs site is built from `docs/` using MkDocs Material and deployed
through GitHub Pages. The deploy workflow does not push a generated
branch back into the repo; it uploads the built `site/` directory as a
Pages artifact and lets GitHub handle the publish step. That keeps the
release repo cleaner and makes docs deploys easier to reason about in CI.

## Release flow

Recommended release flow:

1. Merge validated changes to `master`
2. Create and push a version tag like `v0.2.0`
3. Let `release.yml` build platform artifacts
4. Verify the resulting GitHub Release includes checksums and provenance
5. Smoke-test at least one macOS build and one Linux build before announcing it

## Signing and notarization

The release workflow no longer silently publishes unsigned macOS
artifacts. A tagged release now does one of two things:

- builds signed/notarized-capable macOS artifacts when the required
  secrets are present, then publishes the GitHub Release
- fails unless the `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` repository
  variable is explicitly enabled for a preview-only unsigned build; in
  that mode the workflow uploads build artifacts, skips GitHub Release
  publication, and fails the final release-policy job loudly so the tag
  cannot be mistaken for a public release

That keeps public production releases honest while still leaving a
deliberate escape hatch for internal dry runs.

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

The upstream release workflow checks for that full set before the macOS
build starts. If any value is missing, the tag build fails unless the
unsigned preview override is explicitly enabled. With those Apple
notarization credentials present, electron-builder runs its notarization
integration for the packaged macOS app. electron-builder's own
documentation — in particular [Code Signing](https://www.electron.build/code-signing)
and [Notarization](https://www.electron.build/notarize) — is the
authoritative reference for the full set of knobs.

For a genuinely production-grade public release, treat signing and
notarization as a release requirement, not an optional polish item.

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

The packaged macOS smoke lane can be run locally after packaging with:

```bash
pnpm --dir apps/desktop dist:ci:mac
OPEN_COWORK_PACKAGED_EXECUTABLE="$(node scripts/find-macos-packaged-executable.mjs)" pnpm test:e2e:packaged
```
