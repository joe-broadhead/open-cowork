# Public Release Docs Checklist

Run this checklist before tagging a release candidate, publishing a package, or
switching repository visibility.

## Distribution Clarity

- README and the installation guide lead with a path that exists today.
- Pre-release docs use the source-checkout tarball path:
  `pnpm pack:cli` followed by
  `npm install -g ./artifacts/npm/openwiki-cli-0.0.0.tgz`.
- Published npm examples pin an exact version such as `@openwiki/cli@0.0.0`;
  `@latest` appears only in explicit upgrade guidance after release notes exist.
- Docker examples distinguish local builds, preview images, and
  release-published GHCR digests.
- Hosted examples use `image@sha256:<digest>` for production commands.

## Navigation Hygiene

- The primary MkDocs nav points users at product, guide, reference, deployment,
  development, security, troubleshooting, and changelog pages.
- Archived execution logs and historical specs are not top-level product
  guidance.
- Planning docs that remain published are clearly marked as planning,
  historical, or release checklist material.
- Generated reference docs are current with `pnpm docs:reference -- --check`.

## Community And Reporting Paths

- README links `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, and `CHANGELOG.md`.
- Docs home links support, security reporting, Code of Conduct, and release
  notes.
- Security docs route vulnerability reports to private reporting, not public
  issues.
- Issue templates point security reports away from public issues.

## Enterprise And Deployment Claims

- Deployment profiles say whether they are supported, private, enterprise,
  cloud reference, or preview/demo.
- Write-capable hosted docs require SSO/reverse-proxy auth or scoped
  service-account tokens before public exposure.
- Backup, restore, metrics, and readiness claims match the operations runbooks.
- Cloud Run, Terraform, and provider docs identify storage, auth, state, and
  backup caveats.

## Ownership And Review

- `.github/CODEOWNERS` has explicit owners for workflow, deployment, HTTP, MCP,
  Git, repo, schema, security, and release surfaces.
- PRs touching high-risk areas update tests and docs in the same change.
- Release notes separate supported profiles from preview/reference profiles.

## Validation

```sh
pnpm docs:reference -- --check
python3 -m mkdocs build --strict
pnpm validate
```
