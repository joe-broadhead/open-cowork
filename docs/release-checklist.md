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
- [ ] `pnpm test:renderer`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm perf:check`
- [ ] `pnpm deploy:launch:validate`
- [ ] `pnpm deploy:private-beta:validate`
- [ ] `pnpm ops:validate`
- [ ] perf baseline environment is intentional; refresh
      the environment-specific `benchmarks/perf-baseline.*.json` on the
      target CI runner with `pnpm perf:baseline` after Node, runner OS,
      or workload changes
- [ ] `git diff --check`
- [ ] working tree is clean

### Documentation

- [ ] `pnpm docs:build`
- [ ] published docs site reflects the latest merged docs changes
- [ ] README matches current product behavior
- [ ] config docs match `open-cowork.config.json`
- [ ] packaging and release docs match the workflows
- [ ] if a primary UI route changed, `pnpm screenshots` has regenerated
      `docs/assets/auto/` and the changed screenshots were reviewed before
      release
- [ ] `docs/architecture.md` OpenCode SDK policy points to `apps/desktop/package.json` and `pnpm-lock.yaml`
- [ ] `SECURITY.md` and `SUPPORT.md` are current
- [ ] medium-severity `pnpm audit --prod` output has been reviewed manually if CI stayed green

### Desktop app

- [ ] packaged app launches cleanly from a fresh build
- [ ] startup window appears reliably
- [ ] login/setup flow works
- [ ] home page loads (composer-first welcome surface)
- [ ] workflows page loads (saved workflow list, Add workflow setup-thread flow, run controls, webhook invocation details when present)
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
- [ ] release tag will be an annotated signed tag and GitHub shows it as verified
- [ ] signing/notarization configuration is present for the public release repo, or this is the explicitly documented unsigned `v0.x` public preview with `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` enabled for that tag only
- [ ] if `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` was enabled for an unsigned preview tag, the repository variable is scheduled to be unset immediately after the GitHub Release publishes
- [ ] the release repo or fork has the signing inputs expected by the release workflow (`MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); a first `v*` tag intentionally fails without those inputs unless the unsigned preview override is enabled
- [ ] Linux artifacts are either covered by a detached `SHA256SUMS.txt.asc` signature (`OPEN_COWORK_RELEASE_GPG_PRIVATE_KEY`, optional `OPEN_COWORK_RELEASE_GPG_PASSPHRASE`) or explicitly documented as unsigned `v0.x` artifacts verified through `SHA256SUMS.txt` plus GitHub provenance
- [ ] release assets still include `SHA256SUMS.txt`, `SHA256SUMS.txt.asc` when checksum signing is configured, `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES/`, SBOMs, and provenance attestation
- [ ] signed macOS releases include `latest-mac.yml`; unsigned preview releases do not include signed update feed metadata
- [ ] packaged signed-update marker is schema version 2 and contains only `signedInstallEligible`, `feedConfigured`, `releaseSourceKind`, and `channel` metadata
- [ ] downstream/private update release sources have no tokens, signed URL query strings, bucket credentials, or static headers in renderer IPC payloads, logs, diagnostics, or packaged marker files
- [ ] for signed macOS releases, Settings reports in-app update installation as supported in the packaged smoke run
- [ ] docs drift is acceptable for this release: through the `0.x` preview series, the published Pages site intentionally tracks `master` rather than immutable versioned docs
- [ ] every `[Unreleased]` changelog bullet has been checked against the app before moving it into the tagged release section
- [ ] `CHANGELOG.md`: rename the `[Unreleased]` heading to `[X.Y.Z] - YYYY-MM-DD` with the tag version (without the leading `v`) and tag date, then add a fresh empty `[Unreleased]` section above it for the next cycle
- [ ] `CHANGELOG.md` release date equals the tag date
- [ ] release notes drafted from the `[X.Y.Z]` block (Added / Changed / Fixed / Removed)

### Managed cloud launch readiness

- [ ] `pnpm deploy:load:plan` has been reviewed for the selected
      `private-beta` or `public-beta` target profile.
- [ ] managed worker release evidence has been completed from
      `deploy/managed-workers/worker-release-evidence.template.md` in the
      private operations repo.
- [ ] worker images are pinned by release tag or digest; no deployment uses
      `latest`, mutable aliases, or public repo project/account/customer
      values.
- [ ] worker drain, rolling update, rollback, and emergency revoke drills have
      passing redacted evidence.
- [ ] `OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS` and platform termination grace are
      aligned for worker and scheduler roles.
- [ ] the latest restore drill uses
      `deploy/managed-workers/worker-restore-drill.template.md` and proves
      checkpoints, artifacts, projections, workflows, BYOK refs, and worker
      recovery.
- [ ] for managed BYOK private beta, `pnpm deploy:private-beta:validate`
      passed and `docs/runbooks/private-beta-launch.md` has an owner,
      design-partner checklist, support path, and known limits.
- [ ] `pnpm deploy:load` passed in strict mode against the production-like
      Cloud/Gateway deployment.
- [ ] `pnpm deploy:soak` passed in strict mode against the production-like
      Cloud/Gateway deployment.
- [ ] load and soak JSON/Markdown reports are attached to the release or
      downstream operations evidence.
- [ ] `docs/runbooks/launch-readiness-report.md` has a completed Go/No-Go
      decision, Known limits, Cost and scaling notes, and Final smoke status.
- [ ] final Cloud Web/Desktop/Gateway smoke gates passed after the soak run.

## Tagged release

1. Create a signed annotated version tag:

```bash
git tag -s vX.Y.Z -m "Open Cowork vX.Y.Z"
git push origin vX.Y.Z
```

2. Confirm GitHub shows the pushed tag as verified, then wait for the
   `Release` workflow to finish.
3. Verify the GitHub Release contains:
   - macOS zip artifacts
   - macOS dmg artifacts
   - `latest-mac.yml` for signed macOS releases only
   - Linux AppImage artifacts
   - Linux deb artifacts
   - `SHA256SUMS.txt`
   - `SHA256SUMS.txt.asc` when checksum signing is configured
4. Smoke-test at least one macOS build and one Linux build.
5. For signed macOS releases, run a staging update check from version
   `N` to `N+1`: install the previous signed build, open Settings, check
   for updates, download the new signed update, restart to install, and
   confirm the app relaunches on the new version. Do not perform this
   self-update test for unsigned preview artifacts.

## After release

- [ ] sanity-check downloads from the GitHub Release page
- [ ] verify checksums against `SHA256SUMS.txt`
- [ ] if `SHA256SUMS.txt.asc` is present, verify the detached signature before trusting the checksums
- [ ] disable the `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` repository variable if it was enabled for an unsigned preview release
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
