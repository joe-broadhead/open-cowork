# Packaging and Releases

## Packaging targets

Open Cowork packages desktop artifacts with Electron Builder.

Product naming, compatibility aliases, Gateway migration policy, and support
channels are defined in
[OSS Packaging and Gateway Migration](oss-packaging-migration.md). Treat that
page as the source of truth when changing public artifact names, OCI image
names, Helm chart names, or Gateway mode language.

## Product Artifacts

| Product surface | Release artifact |
| --- | --- |
| Open Cowork Desktop | macOS `.dmg`/`.zip`, Linux `.AppImage`/`.deb` |
| Open Cowork Cloud | `open-cowork-cloud` OCI image, Helm chart, Compose references |
| Open Cowork Gateway | `open-cowork-gateway` OCI image, Helm chart, Compose references |
| Open Cowork Standalone Gateway | source-built `open-cowork-gateway-standalone` CLI; no public image until the image release gate exists |
| Open Cowork Mobile | reserved name; no artifact |
| Open Cowork Teams | reserved product/edition name; no separate runtime |

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

### Windows

Windows packaging is not part of the v0.x preview release matrix. Add a
Windows Electron Builder target, signing policy, and smoke test before
claiming Windows support for a stable release.

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
  - packaged desktop smoke tests on Linux under `xvfb`
  - Linux packaging validation
  - typecheck
  - perf gate
  - production dependency audit at `moderate` severity
  - full dependency audit at `high` severity
  - docs build through `pnpm docs:build`

- `docs.yml`
  - builds MkDocs with `--strict`
  - uploads the built static site as a GitHub Pages artifact
  - deploys the published docs site on pushes to `master`

- `release.yml`
  - builds release artifacts for macOS and Linux
  - runs packaged desktop smoke tests for macOS and Linux release artifacts
    before upload
  - verifies the tag signature, allowed release actor, and required green CI
    checks before publishing
  - reruns Cloud Web, Desktop/Web/Gateway continuation, Docker/Compose,
    Helm, deployment, launch, promotion, private-beta, and ops readiness gates
    before publishing a tag
  - creates GitHub Releases automatically for version tags
  - publishes Cloud and Gateway images to GHCR using immutable release tags
    and captures their registry digests
  - generates Cloud/Gateway image SBOMs and vulnerability scan reports
  - signs Cloud/Gateway image digests with keyless Cosign
  - publishes registry provenance and SBOM attestations for Cloud/Gateway
    image subjects
  - publishes `SHA256SUMS.txt`
  - publishes `latest-mac.yml` only for signed/notarized macOS release
    artifacts, so unsigned preview builds stay on the manual update path
  - attaches GitHub build provenance attestation metadata
  - publishes artifacts and OCI images through the protected
    `release-publish` environment

- `monthly-maintenance.yml`
  - runs on the first day of each month
  - checks dependency audit state, outdated packages, and paired
    OpenCode SDK/runtime drift
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
gh attestation verify ./Open-Cowork-<version>-arm64.dmg --repo joe-broadhead/open-cowork
```

Replace the filename with the artifact you downloaded.

## Verify Cloud and Gateway images

Release images are published to GHCR as:

```text
ghcr.io/<owner>/open-cowork-cloud:<tag>
ghcr.io/<owner>/open-cowork-gateway:<tag>
```

Every release also uploads image evidence files:

```text
open-cowork-cloud.image.json
open-cowork-cloud.image.sbom.cdx.json
open-cowork-cloud.image.scan.grype.json
open-cowork-cloud.image.cosign-verify.json
open-cowork-gateway.image.json
open-cowork-gateway.image.sbom.cdx.json
open-cowork-gateway.image.scan.grype.json
open-cowork-gateway.image.cosign-verify.json
```

Pin deployments by the `digestRef` value from the matching
`*.image.json` file, not by `latest` or another mutable tag.

Verify a Cloud image signature with Cosign:

```bash
digest_ref="$(jq -r .digestRef open-cowork-cloud.image.json)"
cosign verify "$digest_ref" \
  --certificate-identity-regexp '^https://github.com/joe-broadhead/open-cowork/.github/workflows/release.yml@refs/tags/v[0-9].*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Verify registry provenance and SBOM attestations with GitHub:

```bash
gh attestation verify "oci://${digest_ref}" \
  --repo joe-broadhead/open-cowork \
  --signer-workflow joe-broadhead/open-cowork/.github/workflows/release.yml

gh attestation verify "oci://${digest_ref}" \
  --repo joe-broadhead/open-cowork \
  --signer-workflow joe-broadhead/open-cowork/.github/workflows/release.yml \
  --predicate-type https://cyclonedx.org/bom
```

Repeat the same commands with `open-cowork-gateway.image.json` for the
Gateway image. Treat the `*.image.scan.grype.json` files as release
evidence: final `vX.Y.Z` image tags are published only after SBOM
generation, vulnerability scanning, signing, and registry attestations
complete, and a release must not publish if the image scan reaches the
workflow threshold.

Linux `.AppImage` and `.deb` artifacts are verified with
`SHA256SUMS.txt`, GitHub build provenance, and `SHA256SUMS.txt.asc` when
a release GPG key is configured. Detached checksum signatures are
required for `v1.0.0` and later Linux releases.

## Build output

`pnpm build` is expected to complete without Vite/Rolldown warnings. The
large Mermaid renderer is intentionally isolated behind a lazy chunk, so
the Vite chunk-size threshold is set high enough to avoid warning on that
known path while still catching accidental multi-megabyte growth.

Electron Builder may surface Node's `DEP0190` warning from an upstream
shell invocation during local packaging. That warning is reviewed and
accepted for the `v0.x` preview line. It does not affect the release gates; lint,
typecheck, unit tests, smoke tests, packaged smoke, perf, audit, and
strict docs builds must still pass.

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

The default tag workflow validates the public `local-self-host-beta` promotion
claim with `pnpm deploy:promotion:validate -- --tier local-self-host-beta`.
Stronger hosted claims require `OPEN_COWORK_RELEASE_CLAIM_TIER` plus a private
evidence manifest. For tag releases, set repository variable
`OPEN_COWORK_RELEASE_CLAIM_TIER` and provide the base64-encoded private
manifest in secret `OPEN_COWORK_PROMOTION_EVIDENCE_MANIFEST_B64`; the workflow
materializes it into `OPEN_COWORK_PROMOTION_EVIDENCE_MANIFEST` before running
the gate. Local operators can pass `--manifest <private-record>` directly.
Without completed private-pass report evidence the promotion gate fails closed.

## Signing and notarization

The release workflow no longer silently publishes unsigned macOS
artifacts. A tagged release now does one of two things:

- builds signed/notarized-capable macOS artifacts when the required
  secrets are present, embeds signed-update capability metadata in the
  packaged app, verifies the packaged Settings updater capability,
  uploads `latest-mac.yml`, then publishes the GitHub Release
- fails unless the `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` repository
  variable is explicitly enabled for a preview-only unsigned `v0.x`
  build; in that mode the workflow can publish a GitHub Release, and the
  release notes / README must clearly mark the artifacts as unsigned
  public-preview builds. Unsigned preview builds intentionally omit
  `latest-mac.yml`, so Settings keeps showing the manual update fallback.

That keeps public production releases honest while still leaving a
deliberate escape hatch for the initial unsigned public preview.

For signed macOS releases, the packaged smoke test runs with
`OPEN_COWORK_EXPECT_SIGNED_UPDATE_INSTALL=true` and calls the renderer's
typed `updates.installCapability()` API. The smoke does not download or
install an update; it only proves the signed build advertises in-app
installation support. Unsigned preview and non-macOS package smoke runs
keep that expectation unset, so the same test proves Settings stays on
the manual-update fallback.

`electron-updater` remains a production dependency even when upstream
preview builds have no default publish feed. Manual GitHub release checks
are always available in Settings; signed macOS in-app installation
activates only when release feed metadata is embedded in the packaged
app and `latest-mac.yml` is published for that signed release. Keeping
the updater dependency in the package avoids downstream forks needing a
different dependency graph when they enable a signed feed.

## Configurable Update Release Sources

Open Cowork's public distribution uses GitHub Releases as its default
update release source. Downstream distributions can keep their release
metadata and artifacts private by setting `updates.releaseSource` in the
app config instead of patching the updater code. Supported source kinds
are `github-releases`, `generic-http`, and `gcs`.

The updater marker embedded during packaging is schema version 2:

```json
{
  "schemaVersion": 2,
  "signedInstallEligible": true,
  "feedConfigured": true,
  "releaseSourceKind": "gcs",
  "channel": "latest"
}
```

The marker intentionally contains only capability metadata. It must not
contain bearer tokens, signed URLs, bucket credentials, static headers,
or mutable auth state. Release-source credentials are resolved in the
main process at check/download time.

For a private GCS feed, upload Electron updater metadata and artifacts
to:

```text
gs://<bucket>/<prefix>/<channel>/latest-mac.yml
gs://<bucket>/<prefix>/<channel>/<artifact files referenced by latest-mac.yml>
```

Then configure:

```json
{
  "auth": {
    "mode": "google-oauth",
    "googleOAuth": {
      "clientId": "your-google-client-id",
      "scopes": [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/devstorage.read_only"
      ]
    }
  },
  "updates": {
    "enabled": true,
    "manualFallbackUrl": "https://support.example.test/releases",
    "releaseSource": {
      "kind": "gcs",
      "label": "Private release feed",
      "bucket": "acme-cowork-releases",
      "prefix": "desktop",
      "channel": "latest",
      "auth": { "kind": "google-oauth" }
    }
  }
}
```

If a downstream builder needs entitlement checks or very short-lived
artifact URLs, use `auth.kind: "signed-url-broker"`. The app calls the
broker from the main process after Google sign-in; the broker returns an
updater-compatible generic feed URL. Treat those returned URLs as
credentials: keep TTLs short and do not copy them into docs, logs, IPC
payloads, crash reports, or diagnostics.

Before announcing a signed public tag, run one manual staging update from
version `N` to `N+1`: install the previous signed build, open Settings,
check for updates, download the new signed update, restart to install,
and confirm the relaunched app reports the new version. This manual
exercise is intentionally outside CI because it uses a real published
feed and real signed artifacts.

### Signing gate inputs

`.github/scripts/release-signing-mode.mjs` is the release gate that
decides whether a tagged build is allowed to proceed as a signed public
release or an unsigned preview. It requires all of these runtime
environment variables:

| Runtime env var | GitHub secret or variable used upstream | Purpose |
| --- | --- | --- |
| `CSC_LINK` | `MAC_CERTIFICATE_P12_BASE64` secret | Base64-encoded Apple Developer ID Application certificate exported as a `.p12` |
| `CSC_KEY_PASSWORD` | `MAC_CERTIFICATE_PASSWORD` secret | Password for the `.p12` signing certificate |
| `APPLE_ID` | `APPLE_ID` secret | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` secret | App-specific password for the Apple ID |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` secret | Apple Developer Team ID |
| `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` | repository variable | Preview-only escape hatch for unsigned `v0.x` tag dry runs |

For signed releases, leave `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` unset
or false. If any signing value is missing, the workflow fails before a
GitHub Release can be published. For `v0.x` preview releases only, the
override permits unsigned publication with explicit warning text. For
`v1.0.0` and later, the release policy fails unless macOS signing and
notarization are configured. Treat the unsigned override as a temporary
per-tag switch: enable it only for the preview release run, then unset it
as soon as the GitHub Release has been verified.

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

`pnpm test:e2e:packaged` is the release gate and fails before smoke test
discovery unless `OPEN_COWORK_PACKAGED_EXECUTABLE` points at an executable
file or a macOS `.app` bundle with a resolvable executable under
`Contents/MacOS`. Broad discovery jobs that intentionally allow packaged
tests to skip can use `pnpm test:e2e:packaged:optional`; do not use the
optional command in release or branch-protection gates.
