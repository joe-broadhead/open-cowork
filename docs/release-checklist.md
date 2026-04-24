# Release Checklist

This checklist is intended for the first public tagged releases and later release dry runs.

Reference workflows in the repository root:

- [`.github/workflows/ci.yml`](https://github.com/joe-broadhead/open-cowork/blob/master/.github/workflows/ci.yml) — lint, typecheck, tests, audit, docs build, macOS unpackaged + packaged smoke validation, macOS/Linux packaging validation.
- [`.github/workflows/docs.yml`](https://github.com/joe-broadhead/open-cowork/blob/master/.github/workflows/docs.yml) — strict MkDocs build + GitHub Pages deploy.
- [`.github/workflows/release.yml`](https://github.com/joe-broadhead/open-cowork/blob/master/.github/workflows/release.yml) — tag-driven release, signing preflight, checksums, provenance.
- [`.github/workflows/monthly-maintenance.yml`](https://github.com/joe-broadhead/open-cowork/blob/master/.github/workflows/monthly-maintenance.yml) — monthly drift checks for dependencies and SDK compatibility.

## Before tagging

### Repository quality

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm perf:check`
- [ ] `git diff --check`
- [ ] working tree is clean

### Documentation

- [ ] `mkdocs build --strict`
- [ ] published docs site reflects the latest merged docs changes
- [ ] README matches current product behavior
- [ ] config docs match `open-cowork.config.json`
- [ ] packaging and release docs match the workflows
- [ ] `SECURITY.md` and `SUPPORT.md` are current
- [ ] medium-severity `pnpm audit --prod` output has been reviewed manually if CI stayed green

### Desktop app

- [ ] packaged app launches cleanly from a fresh build
- [ ] startup window appears reliably
- [ ] login/setup flow works
- [ ] home page loads (composer-first welcome surface)
- [ ] automations page loads (overview, create flow, inbox/runs visible when present)
- [ ] Pulse dashboard loads (runtime pills, metric cards, usage)
- [ ] charts render in packaged builds
- [ ] sandbox artifacts work
- [ ] custom MCP add/test flow works
- [ ] custom agent flow works

### Release configuration

- [ ] version numbers are correct (root `package.json` and `apps/desktop/package.json` match)
- [ ] repository metadata and remotes point at the intended public `open-cowork` repo
- [ ] release workflows point at the correct package names and scripts
- [ ] macOS and Linux packaging scripts still match Electron Builder config
- [ ] release workflow is still tag-driven only
- [ ] signing/notarization configuration is present for the public release repo; use `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` only for unsigned preview workflow artifacts that must not publish a GitHub Release
- [ ] the release repo or fork has the signing inputs expected by the release workflow (`MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); a first `v*` tag intentionally fails without those inputs unless the unsigned preview override is enabled
- [ ] release assets still include `SHA256SUMS.txt` and provenance attestation
- [ ] `CHANGELOG.md`: rename the `[Unreleased]` heading to `[vX.Y.Z] - YYYY-MM-DD` with the tag version and tag date, then add a fresh empty `[Unreleased]` section above it for the next cycle
- [ ] release notes drafted from the `[vX.Y.Z]` block (Added / Changed / Fixed / Removed)

## Tagged release

1. Create a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

2. Wait for the `Release` workflow to finish.
3. Verify the GitHub Release contains:
   - macOS zip artifacts
   - macOS dmg artifacts
   - Linux AppImage artifacts
   - Linux deb artifacts
   - `SHA256SUMS.txt`
4. Smoke-test at least one macOS build and one Linux build.

## After release

- [ ] sanity-check downloads from the GitHub Release page
- [ ] verify checksums against `SHA256SUMS.txt`
- [ ] update any milestone or release tracking issue
- [ ] document known caveats if signing/notarization is still pending
