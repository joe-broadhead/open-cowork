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
- [ ] perf baseline environment is intentional; refresh
      `benchmarks/perf-baseline.json` on the target CI runner with
      `pnpm perf:baseline` after Node, runner OS, or workload changes
- [ ] `git diff --check`
- [ ] working tree is clean

### Documentation

- [ ] `mkdocs build --strict`
- [ ] published docs site reflects the latest merged docs changes
- [ ] README matches current product behavior
- [ ] config docs match `open-cowork.config.json`
- [ ] packaging and release docs match the workflows
- [ ] `docs/architecture.md` OpenCode SDK versions match `apps/desktop/package.json`
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
- [ ] Linux smoke walkthrough has been run locally or covered by CI for this release

### Release configuration

- [ ] version numbers are correct across all workspace `package.json` files
- [ ] repository metadata and remotes point at the intended public `open-cowork` repo
- [ ] first public release history-reset/squash decision is complete before making the repo public
- [ ] release workflows point at the correct package names and scripts
- [ ] macOS and Linux packaging scripts still match Electron Builder config
- [ ] release workflow is still tag-driven only
- [ ] signing/notarization configuration is present for the public release repo, or this is the explicitly documented unsigned `v0.0.0` public preview with `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` enabled for that tag only
- [ ] the release repo or fork has the signing inputs expected by the release workflow (`MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); a first `v*` tag intentionally fails without those inputs unless the unsigned preview override is enabled
- [ ] release assets still include `SHA256SUMS.txt`, `THIRD_PARTY_NOTICES.md`, SBOMs, and provenance attestation
- [ ] docs drift is acceptable for this release: the published Pages site tracks `master`, not immutable versioned docs; decide on versioned docs before v0.2.0
- [ ] every `[Unreleased]` changelog bullet has been checked against the app before moving it into the tagged release section
- [ ] `CHANGELOG.md`: rename the `[Unreleased]` heading to `[vX.Y.Z] - YYYY-MM-DD` with the tag version and tag date, then add a fresh empty `[Unreleased]` section above it for the next cycle
- [ ] `CHANGELOG.md` release date equals the tag date
- [ ] release notes drafted from the `[vX.Y.Z]` block (Added / Changed / Fixed / Removed)

## Tagged release

1. Create a version tag:

```bash
git tag v0.0.0
git push origin v0.0.0
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

## Rollback and hotfix

If a public release goes out with a blocking issue:

1. Edit the GitHub Release and mark it as a pre-release or delete the
   affected binary assets so new users stop downloading them.
2. Add a short notice to the release body explaining the affected
   version, platforms, and workaround.
3. Open a hotfix branch from `master`, apply the smallest fix, and run
   the release validation commands from this checklist.
4. Bump to the next patch tag. Do not rewrite or re-push the broken
   public tag once users may have fetched it.
5. Publish the patch release, verify checksums and provenance, then
   update the broken release body to point users at the fixed version.
6. If the issue is security-sensitive, follow `SECURITY.md` for advisory
   handling before posting public details.
