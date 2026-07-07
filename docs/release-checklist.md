# Release Checklist

This checklist is intended for the first public tagged releases and later release dry runs.

Reference workflows in the repository root:

- [`.github/workflows/ci.yml`](https://github.com/joe-broadhead/open-cowork/blob/master/.github/workflows/ci.yml) — lint, typecheck, tests, audit, docs build, macOS unpackaged smoke validation, macOS/Linux packaged smoke validation, and macOS/Linux packaging validation.
- [`.github/workflows/docs.yml`](https://github.com/joe-broadhead/open-cowork/blob/master/.github/workflows/docs.yml) — strict MkDocs build + GitHub Pages deploy.
- [`.github/workflows/release.yml`](https://github.com/joe-broadhead/open-cowork/blob/master/.github/workflows/release.yml) — tag-driven release, signing preflight, checksums, provenance.
- [`.github/workflows/monthly-maintenance.yml`](https://github.com/joe-broadhead/open-cowork/blob/master/.github/workflows/monthly-maintenance.yml) — monthly drift checks for dependencies and SDK compatibility.

## Release Claim Levels

Do not use a stronger claim level in release notes, docs, marketing copy, or
support handoffs until every required evidence item for that level is complete
and linked from the release Go/No-Go report.

| Claim level | Allowed claim | Required evidence |
| --- | --- | --- |
| `local-self-host-beta` | Local or trusted self-host beta only. | Protected CI gates plus supply-chain artifacts, local/self-host smoke tests, deployment validators, docs build, private-value scan, and no public managed-SaaS promise. |
| `private-hosted-beta` | Managed BYOK with design partners only. | Everything from `local-self-host-beta`, plus production-like load/soak, restore drill, worker failover, BYOK redaction, Gateway replay/dead-letter recovery, support ownership, and private Go/No-Go evidence. |
| `public-beta` | Public hosted BYOK signups with caps and support coverage. | Everything from `private-hosted-beta`, plus abuse controls, quota evidence, branch-protected Cloud/Gateway/continuation gates, immutable release artifacts, and public-safe launch evidence. |
| `enterprise-ready` | Enterprise downstream/self-host and managed deployment claim. | Everything from `public-beta`, plus HA topology evidence, backup/restore RPO/RTO proof, audit/security evidence, downstream branding/configuration proof, and support runbooks. |

## Before tagging

### Repository quality

- [ ] `pnpm test`
- [ ] `pnpm test:cloud-continuation`
- [ ] `pnpm test:renderer`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm perf:check`
- [ ] `pnpm deploy:validate -- --require-tools` has passed in an environment
      with Docker and Helm installed; static fallback output is not release
      evidence.
- [ ] `pnpm deploy:smoke:strict` has passed against the production-candidate
      Cloud and managed Gateway URLs with admin/operator tokens.
- [ ] `pnpm deploy:launch:validate`
- [ ] `pnpm deploy:launch:evidence:validate`
- [ ] `pnpm deploy:promotion:validate -- --tier local-self-host-beta`
- [ ] `pnpm deploy:private-beta:validate`
- [ ] `pnpm proof:opencode:compatibility`
- [ ] `pnpm ops:validate`
- [ ] perf baseline environment is intentional; refresh
      the environment-specific `benchmarks/perf-baseline.*.json` on the
      target CI runner with `pnpm perf:baseline` after Node, runner OS,
      or workload changes
- [ ] `git diff --check`
- [ ] working tree is clean
- [ ] release actor is listed in `OPEN_COWORK_RELEASE_ALLOWED_ACTORS`, the tag
      commit has every required CI/CodeQL check green, and the
      `release-publish` protected environment approval path is ready for GitHub
      Release and GHCR publishing jobs

### Documentation

- [ ] `pnpm docs:build`
- [ ] published docs site reflects the latest merged docs changes
- [ ] README matches current product behavior
- [ ] config docs match `open-cowork.config.json`
- [ ] packaging and release docs match the workflows
- [ ] [OSS Packaging and Gateway Migration](oss-packaging-migration.md) matches
      the current Desktop, Cloud, Gateway, Standalone Gateway, image, package,
      and compatibility-alias behavior
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
- [ ] `pnpm test:live-scenarios` passes and its redacted evidence has been
      reviewed for the release claim tier
- [ ] `pnpm headless:host check`, foreground `pnpm headless:host start`/`stop`
      lifecycle, and `pnpm headless:host doctor` pass without
      exposing raw tokens, auth headers, provider keys, or local home paths
- [ ] portable sandbox policy/lifecycle tests pass for Docker and Apple
      Container command planning without raw local mount paths in diagnostics
- [ ] `pnpm proof:cloud:opencode-portability --json` passes with redacted
      OpenCode portability evidence and an explicit sandbox engine preflight
      result (`sandbox-runtime-engine-available`,
      `sandbox-runtime-engine-unavailable`, or
      `sandbox-runtime-engine-check-failed`)
- [ ] if sandboxed execution is part of the release claim, `pnpm
      proof:sandbox:opencode-session -- --json --strict --image
      <sandbox-image> --image-sha256 <sha256:...>` passes with
      `sandbox-opencode-session-passed`; missing engine/image, blocked policy,
      or command failure evidence is reviewed but not counted as a successful
      sandbox session proof

### Release configuration

- [ ] version numbers are correct across all workspace `package.json` files
- [ ] repository metadata and remotes point at the intended public `open-cowork` repo
- [ ] first public release history-reset/squash decision is complete before making the repo public
- [ ] release workflows point at the correct package names and scripts
- [ ] release notes state the accepted launch tier: `v0.x` preview, private
      hosted beta, public beta, stable, or enterprise-ready
- [ ] if the release claim tier is stronger than `local-self-host-beta`,
      repository variable `OPEN_COWORK_RELEASE_CLAIM_TIER` is set and secret
      `OPEN_COWORK_PROMOTION_EVIDENCE_MANIFEST_B64` contains the base64-encoded
      private promotion manifest for the exact tag commit.
- [ ] Cloud Channel Gateway and Standalone Gateway are not described as the
      same product mode in release notes, docs, or deployment assets
- [ ] any `opencode-gateway` or `opencode-agent-gateway` compatibility alias
      points at the matching Open Cowork artifact and is marked as legacy
- [ ] macOS, Windows, and Linux packaging scripts (`dist:ci:mac`, `dist:ci:win`, `dist:ci:linux`) still match Electron Builder config
- [ ] release workflow is still tag-driven only
- [ ] release tag will be an annotated signed tag and GitHub shows it as verified
- [ ] signing/notarization configuration is present for the public release repo, or this is the explicitly documented unsigned `v0.x` public preview with `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` enabled for that tag only
- [ ] if `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES` was enabled for an unsigned preview tag, the repository variable is scheduled to be unset immediately after the GitHub Release publishes
- [ ] the release repo or fork has the macOS signing inputs expected by the release workflow (`MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); a first `v*` tag intentionally fails without those inputs unless the unsigned preview override is enabled
- [ ] the release repo or fork has the Windows signing inputs expected by the `build-windows` job: either the native certificate (`WIN_CERTIFICATE_PFX_BASE64` + `WIN_CERTIFICATE_PASSWORD`) or the SignPath trio (`SIGNPATH_API_TOKEN` secret + `SIGNPATH_ORGANIZATION_ID`/`SIGNPATH_PROJECT_SLUG` variables); a `v1.0.0`+ tag fails without one of these unless the unsigned preview override is enabled
- [ ] all three OS build checks (`macos-build`, `windows-package`, `linux-package`) are green on the tag commit; `scripts/verify-release-checks.mjs` blocks publishing otherwise
- [ ] Linux artifacts are either covered by a detached `SHA256SUMS.txt.asc` signature (`OPEN_COWORK_RELEASE_GPG_PRIVATE_KEY`, optional `OPEN_COWORK_RELEASE_GPG_PASSPHRASE`) or explicitly documented as unsigned `v0.x` artifacts verified through `SHA256SUMS.txt` plus GitHub provenance
- [ ] release assets still include `SHA256SUMS.txt`, `SHA256SUMS.txt.asc` when checksum signing is configured, `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.tar.gz`, SBOMs, and provenance attestation
- [ ] GHCR Cloud and Gateway images have immutable digest metadata, Cosign
      signatures, image SBOMs, image vulnerability scan JSON, and registry
      provenance/SBOM attestations.
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
      `local-self-host-beta`, `private-beta`, or `public-beta` target profile.
- [ ] `deploy/load/launch-evidence-matrix.json` states the exact accepted
      launch tier through `acceptedPublicTier`; the public repo currently
      claims only `local-self-host-beta` unless private operations evidence
      explicitly upgrades the tier.
- [ ] managed worker release evidence has been completed from
      `deploy/managed-workers/worker-release-evidence.template.md` in the
      private operations repo.
- [ ] private-beta evidence has been completed from
      `deploy/private-beta/launch-evidence-record.template.json`, validated
      with `pnpm deploy:launch:evidence:validate -- --manifest <private-record>
      --require-private-pass`, promoted with `pnpm deploy:promotion:validate
      -- --tier private-hosted-beta --manifest <private-record>`, and summarized in
      `deploy/private-beta/private-beta-go-no-go.public.md` without private
      values.
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
- [ ] `pnpm deploy:load:strict` passed against the production-like
      Cloud/Gateway deployment.
- [ ] `pnpm deploy:soak:strict` passed against the production-like
      Cloud/Gateway deployment.
- [ ] `pnpm deploy:failover:drill` captured worker, scheduler, and Gateway
      failover evidence or recorded explicit private operator hook evidence.
      `pnpm deploy:failover:drill:dry-run` is only a local contract check and
      is not launch evidence.
- [ ] release rollback evidence records artifact revoke/unpublish steps, worker
      drain or disablement, support/customer communication owner, and checksum
      or immutable private evidence reference.
- [ ] load and soak JSON/Markdown reports are attached to the release or
      downstream operations evidence.
- [ ] `docs/runbooks/launch-readiness-report.md` has a completed Go/No-Go
      decision, Accepted Launch Tier, Known limits, Cost and scaling notes,
      Final smoke status, and Findings Workflow.
- [ ] final Cloud Web/Desktop/Gateway smoke gates passed after the soak run.
- [ ] Cloud Web and Desktop visual parity checklist completed from the Studio
      Production Visual QA Matrix in `docs/cloud-web-workbench.md`: Home/Chat
      and composer, Projects/thread history, runtime review, approvals,
      questions, coworker picker/cards, delegated specialist lanes, Team,
      Playbooks, Tools & Skills, Channels, Artifacts, Settings/Admin,
      BYOK/token/Gateway/audit/diagnostics, responsive desktop/tablet/mobile
      layout, loading/empty/error/disabled/permission/offline/retry states,
      destructive confirmations, one-time reveal flows, and
      `/assets/fonts/*.woff2` font loading.
- [ ] Studio production audit checklist completed from
      `docs/cloud-web-workbench.md`: canonical shared tokens, shared Studio
      primitives, shared product vocabulary, Cloud API client-only browser
      boundary, secondary Admin path, safe redaction, honest performance
      budgets, and docs that describe shipped behavior only.
- [ ] Knowledge/OpenWiki integration verified: the Cloud Web Knowledge route,
      `Capture to knowledge` CTA, native Knowledge API contract, review queue,
      version history, graph, and no-local-OpenWiki-checkout boundary all match
      the renderer's Knowledge surface documented in
      `docs/cloud-web-workbench.md`.

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
   - Windows NSIS `-setup.exe` installer
   - `latest.yml` for signed Windows releases only
   - Windows `*.blockmap`
   - Linux AppImage artifacts
   - Linux deb artifacts
   - `SHA256SUMS.txt`
   - `SHA256SUMS.txt.asc` when checksum signing is configured
   - `THIRD_PARTY_NOTICES.md`
   - `THIRD_PARTY_LICENSES.tar.gz`
   - `sbom.cdx.json` and `sbom.spdx.json`
   - `open-cowork-cloud.image.json`
   - `open-cowork-cloud.image.sbom.cdx.json`
   - `open-cowork-cloud.image.scan.grype.json`
   - `open-cowork-cloud.image.cosign-verify.json`
   - `open-cowork-gateway.image.json`
   - `open-cowork-gateway.image.sbom.cdx.json`
   - `open-cowork-gateway.image.scan.grype.json`
   - `open-cowork-gateway.image.cosign-verify.json`
4. Confirm Cloud and Gateway `vX.Y.Z` GHCR tags point at the
   `digestRef` values in `open-cowork-*.image.json`; those final tags
   must be created only after SBOM, scan, signing, and attestation steps
   succeed.
5. Smoke-test at least one macOS build, one Windows build, and one Linux
   build.
6. For signed macOS and Windows releases, run a staging update check from
   version `N` to `N+1`: install the previous signed build, open Settings,
   check for updates, download the new signed update, restart to install,
   and confirm the app relaunches on the new version. Do not perform this
   self-update test for unsigned preview artifacts. Linux uses the verified
   manual-download path in [Verifying Releases](verifying-releases.md).

## After release

- [ ] sanity-check downloads from the GitHub Release page
- [ ] verify checksums against `SHA256SUMS.txt`
- [ ] if `SHA256SUMS.txt.asc` is present, verify the detached signature before trusting the checksums
- [ ] verify Cloud and Gateway image signatures with Cosign against the release
      workflow identity and immutable digest refs from the `*.image.json` files.
- [ ] verify Cloud and Gateway image provenance/SBOM attestations with
      `gh attestation verify` against the same digest refs.
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
