# Operations and CI

This page is the operator-facing map of the repository automation:
what runs, when it runs, and what each workflow is expected to prove.

## Workflow summary

| Workflow | Trigger | What it proves |
|---|---|---|
| `ci.yml` | push to `master`, pull requests | lint, tests, typecheck, perf gate, docs build, unpackaged + packaged macOS smoke tests, macOS and Linux packaging sanity |
| `codeql.yml` | push to `master`, pull requests, weekly schedule | static analysis over the TypeScript / Electron codebase using CodeQL security + quality queries |
| `docs.yml` | push to `master`, manual dispatch | MkDocs builds cleanly and the published docs site can be deployed to GitHub Pages |
| `release.yml` | version tags (`v*`) | release artifacts build, macOS packaged smoke passes, signing policy is enforced, checksums are generated, SBOMs are attached, provenance is published |
| `monthly-maintenance.yml` | first day of each month, manual dispatch | dependency audit state, outdated packages, pinned-SDK health, advisory latest-SDK compatibility |

## CI quality bar

The main CI workflow is the public merge gate. A pull request is not
ready to merge unless it survives:

- `pnpm audit --prod --audit-level high`
- CodeQL on `master`, pull requests, and the weekly schedule
- `pnpm lint`
- `pnpm lint:a11y --max-warnings=0`
- `git diff --check`
- `pnpm test`
- `pnpm test:renderer`
- `pnpm typecheck`
- `pnpm perf:check`
- `mkdocs build --strict`
- `pnpm test:e2e` on macOS
- `pnpm --dir apps/desktop dist:ci:mac`
- `pnpm --dir apps/desktop test:e2e:packaged` on macOS
- `pnpm --dir apps/desktop dist:ci:linux`

That combination is intentional: it covers code quality, docs quality,
desktop boot health, and packaging sanity in one place.

## Docs deployment

The docs site is built from `docs/` with MkDocs Material and deployed to
GitHub Pages.

Key characteristics of the docs deploy:

- the build is strict, so stale nav entries and malformed Markdown fail fast
- the workflow uploads the generated `site/` directory as a Pages artifact
- deployment happens from GitHub Actions rather than a generated commit pushed back into the repo

Local equivalent:

```bash
python -m pip install -r docs/requirements.txt
mkdocs build --strict
```

## Release automation

Release tags (`vX.Y.Z`) trigger the release workflow.

The release pipeline currently guarantees:

- macOS zip + dmg artifacts
- Linux AppImage + deb artifacts
- packaged macOS smoke validation against the built `.app`
- `SHA256SUMS.txt`
- CycloneDX and SPDX SBOMs
- GitHub build provenance attestation

The release workflow now enforces one of two explicit modes:

- signed macOS artifacts when the required signing/notarization secrets are present
- unsigned preview artifacts only when the `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES`
  repository variable is deliberately enabled

For a truly public production release, keep the signed path configured
and treat the unsigned override as preview-only:

- macOS signing
- macOS notarization
- any Linux package-signing or mirror steps your distribution requires

## Monthly maintenance

The repository no longer uses a nightly maintenance cadence. Scheduled
automation runs monthly so the project gets a predictable maintenance
window without constant background churn.

That monthly window includes:

- Dependabot PRs for npm dependencies
- Dependabot PRs for GitHub Actions SHA bumps
- the monthly maintenance workflow's audit and SDK drift checks

This keeps the repository healthy while leaving day-to-day CI focused on
real product changes.

## Recommended operator routine

If you are responsible for keeping the repository release-ready:

1. Keep `master` green in CI.
2. Review monthly maintenance output and dependency PRs promptly.
3. Make sure the GitHub Pages docs site matches the current repo state.
4. Before tagging, run the full [Release Checklist](release-checklist.md).
5. Treat any unsigned release override as preview-quality until signing and notarization are configured.
