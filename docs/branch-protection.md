# Branch Protection

The canonical public branch is `master`. Require pull requests before merging
and keep direct pushes limited to repository administrators and release
automation.

## Required Checks

Configure GitHub branch protection for `master` with these required status
checks:

| Check | Workflow | Purpose |
| --- | --- | --- |
| `validate` | CI | Lint, audit, tests, typecheck, performance gate, and full build. |
| `cloud-gates` | CI | OpenCode portability proof, Postgres cloud concurrency, Docker/Compose smoke, Helm validation, deployment validators, launch validators, and operations validators. |
| `macos-build` | CI | macOS packaging and packaged-app smoke validation. |
| `linux-package` | CI | Linux packaging and packaged-app smoke validation. |
| `windows-package` | CI | Windows NSIS packaging and packaged-app smoke validation. |
| `docs` | CI | Strict MkDocs build for every PR. |
| `coverage` | CI | Coverage ratchet and PR coverage summary. |

Keep these names in sync with `.github/workflows/ci.yml`. If a workflow job is
renamed, update branch protection in GitHub before merging the rename.

**CodeQL is not a required PR/merge check.** Full monorepo CodeQL regularly
times out and burns multi-hour Action minutes. `.github/workflows/codeql.yml`
runs a deep `security-and-quality` scan **monthly** (and on `workflow_dispatch`)
only — not on every PR or every `master` push.

## Recommended Settings

- Require branches to be up to date before merging.
- Require conversation resolution before merging.
- Require signed commits for release tags; release tags are separately verified
  by `scripts/verify-release-tag-signature.mjs`.
- Protect the `release-publish` environment and require reviewer approval for
  jobs that publish GitHub Releases or GHCR images.
- Keep `OPEN_COWORK_RELEASE_ALLOWED_ACTORS` limited to trusted release
  maintainers; `scripts/verify-release-actor.mjs` blocks unexpected actors and
  `scripts/verify-release-checks.mjs` blocks publishing when required checks
  for the tag commit are missing or red.
- Keep administrator bypass exceptional and document any emergency merge in the
  release notes or incident notes.


## Product partition CI (optional required checks)

Path-filtered workflows (not always required on Desktop-only PRs):

- `CI Gateway` (`.github/workflows/ci-gateway.yml`) — `products/gateway/**` (includes standalone smoke)
- `CI Wiki` (`.github/workflows/ci-wiki.yml`) — `products/wiki/**` (includes standalone smoke)

Product release workflows (independent of Desktop `v*` tags):

- `Release Gateway` (`.github/workflows/release-gateway.yml`) — `gateway@v*` / manual
- `Release Wiki` (`.github/workflows/release-wiki.yml`) — `wiki@v*` / manual

Core `CI` workflow remains the branch-protection baseline for monorepo master.
