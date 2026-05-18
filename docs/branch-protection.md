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
| `macos-build` | CI | macOS packaging and packaged-app smoke validation. |
| `linux-package` | CI | Linux packaging and packaged-app smoke validation. |
| `docs` | CI | Strict MkDocs build for every PR. |
| `coverage` | CI | Coverage ratchet and PR coverage summary. |
| `analyze (javascript-typescript)` | CodeQL | JavaScript/TypeScript security and quality analysis. |

Keep these names in sync with `.github/workflows/ci.yml` and
`.github/workflows/codeql.yml`. If a workflow job is renamed, update branch
protection in GitHub before merging the rename.

## Recommended Settings

- Require branches to be up to date before merging.
- Require conversation resolution before merging.
- Require signed commits for release tags; release tags are separately verified
  by `scripts/verify-release-tag-signature.mjs`.
- Keep administrator bypass exceptional and document any emergency merge in the
  release notes or incident notes.
