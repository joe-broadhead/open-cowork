# Release

OpenWiki release readiness is checked against these gates:

- safe static export output paths
- hardened Docker context and image contents
- hosted write-mode auth and browser write protection
- MkDocs documentation
- concise README and community files
- executable schemas
- CLI/HTTP/MCP/OpenAPI parity checks
- deterministic MCP conformance evals for stdio and hosted Streamable HTTP
- deterministic inbox agent orchestration evals for local transcript intake,
  hosted HTTP MCP proposal-mode inbox submission, permissions, duplicates,
  prompt-injection handling, and sync evidence
- deterministic enterprise demo evals for Spaces, agent UX, static export, and
  backup/restore
- explicit source, Docker, static, and npm distribution contracts
- image provenance, SBOM, signing, vulnerability scanning, and digest pinning
- production operations documentation
- release validation workflow for local, static, Docker, Compose, docs, and
  security-basics profiles
- generated reference drift checks for CLI, MCP, operations, schemas, package
  APIs, errors, and compatibility
- focused `pnpm test:security` boundary checks and high-severity dependency
  audit
- 1k scale smoke performance report and scheduled 10k benchmark evidence
- generated release evidence bundle with local artifacts and gate inventory
- release go/no-go status summary that separates local gates from release-day
  and external-provider blockers
- always-present `ci-required` status for branch protection, with Node
  `22.22.3` and `24.x` compatibility coverage
- dependency review, CodeQL TypeScript analysis for public code-scanning
  repositories, weekly npm audit, and Python docs dependency audit
- tag release orchestration that verifies `v<package.json version>` before any
  publish job and blocks npm publish behind the full release train

The current public distribution supports source checkout, the generated
`@openwiki/cli` package, static export, and Docker preview images. Workspace
library packages remain private until an explicit compatibility policy exists.

Related public-readiness work is tracked in
[#64](https://github.com/joe-broadhead/open-wiki/issues/64) for final release
evidence/distribution. First-user deployment and agent onboarding docs were
completed in
[#66](https://github.com/joe-broadhead/open-wiki/issues/66).

Release images must pass the local container smoke test and Trivy scan before
publishing. Published digests must include SBOM/provenance attestations and a
keyless signature.

## Current Release Contract

| Surface | Status | Notes |
| --- | --- | --- |
| Source checkout | Ready for public preview | Requires Node, pnpm, Git, and source-run CLI commands. |
| Personal wiki with local agents | Ready for private testing | Use local stdio MCP in `read` or `proposal` mode. |
| npm CLI package | Preview-ready | `pnpm build:cli` emits a bundled `@openwiki/cli` package under `packages/cli/dist`; release tags publish only after the release orchestrator passes. |
| Static export | Ready for public read-only publishing | Best default for public knowledge. |
| Docker image | Preview-ready | CI builds, smoke-tests, scans, publishes, and signs images. Pin digests for deployment. |
| Compose | Local/trusted only | No wildcard CORS default. Hosted writes still need an auth proxy. |
| Helm/Kubernetes/Terraform | Starting points | Review ingress, auth, backups, secrets, and observability before production. |
| PGLite local runtime | Deferred experimental spike | ADR 0009 keeps SQLite/index-store as the local default. PGLite cannot become default until parity, backup/restore, crash-recovery, packaging, migration, and vector-extension gates are proven. |
| npm library packages | Not released | Workspace libraries remain private until compatibility and API stability guarantees exist. |

OpenWiki has external Postgres-backed queue, write-coordination, session,
rate-limit, and metrics backends for hosted deployments. Process-local
fallbacks remain useful for personal and preview profiles, but multi-replica
deployments should configure the external backends and ingress-level rate
limits before accepting write-capable traffic.

## Supported Profile Table

| Profile | Release Status | Primary Gate | Notes |
| --- | --- | --- | --- |
| `local-personal` | Supported for personal/private testing | `local personal profile` job | Initializes `personal-wiki`, builds local stores, checks `/readyz`, and performs stdio MCP smoke. |
| `public-static` | Supported for public read-only publishing | `static export profile` job | Exports public HTML and machine artifacts and verifies private content is filtered. |
| `docker-private` | Supported preview | `docker profile`, `compose profile`, and image workflow | Builds the image, runs read-only root, probes `/readyz` and `/mcp-manifest.json`, and validates Docker Compose config as the local/trusted-network variant. |
| `docs-site` | Supported | `docs profile` job | Runs `mkdocs build --strict`. |
| `hosted-security-basics` | Supported baseline | `release security basics` job | Verifies no wildcard CORS default, trusted headers require a secret, and service-account tokens are hashed/redacted. |
| `helm-kubernetes` | Preview | `pnpm smoke:kubernetes` and manual deployment review | Chart and base manifests are validated by repository tests; kind smoke can apply the base manifests when `OPENWIKI_KIND_SMOKE=1`. |
| `terraform-clouds` | Preview | Manual provider validation | Terraform modules are starting points and require account-specific state, auth, DNS, and backup review. |

## Release Validation Matrix

| Gate | CI job / workflow | Command or Probe |
| --- | --- | --- |
| Stable branch-protection status | `OpenWiki Required CI` / `ci-required` | Aggregates Node compatibility, package smoke, release smoke, npm audit, Python docs audit, and PR dependency review. |
| Minimum Node compatibility | `OpenWiki Required CI` / `node compatibility (22.22.3)` | `pnpm typecheck`; `pnpm test`; `pnpm pack:cli`; `pnpm release:smoke -- local-personal`. |
| Current Node compatibility | `OpenWiki Required CI` / `node compatibility (24.x)` | `pnpm typecheck`; `pnpm test`; `pnpm pack:cli`; `pnpm release:smoke -- local-personal`. |
| Local personal profile | `OpenWiki Release Validation` / `local personal profile` | `pnpm release:smoke -- local-personal` |
| Static export profile | `OpenWiki Release Validation` / `static export profile` | `pnpm release:smoke -- static-export` |
| Docker profile | `OpenWiki Release Validation` / `docker profile` | `docker build --tag openwiki/openwiki:release-smoke .`; `curl /readyz`; `curl /mcp-manifest.json`; Trivy HIGH/CRITICAL scan. |
| Release image publish | `OpenWiki Release Validation` / `release image` | Runs only after `release orchestrator`; publishes GHCR semver tags with SBOM, provenance, Cosign signing, and build provenance attestation. |
| Compose profile | `OpenWiki Release Validation` / `compose profile` | `docker compose -f deploy/compose/docker-compose.yml config --quiet` |
| Docs | `OpenWiki Release Validation` / `docs profile` | `pnpm docs:build` locally; CI runs `mkdocs build --strict` after installing docs dependencies. |
| Postgres profile | `OpenWiki Release Validation` / `postgres profile` | Pinned Postgres service image; `pnpm typecheck`; `pnpm test:postgres`. |
| Package smoke | `OpenWiki Release Validation` / `package smoke` | `pnpm pack:cli`; packaged CLI test; uploads npm tarball artifact with missing-artifact failure. |
| Version tag check | `OpenWiki Release Validation` / `verify version tag` | Fails unless tag name equals `v${package.json.version}`. |
| Release orchestrator | `OpenWiki Release Validation` / `release orchestrator` | Blocks publish jobs unless every release gate and release evidence artifact succeeded in the same workflow run. |
| Generated references | `OpenWiki Lint` | `pnpm docs:reference -- --check` |
| Security basics | `OpenWiki Release Validation` / `release security basics` | `pnpm release:smoke -- security-basics` |
| Security boundary tests | `OpenWiki Lint` and `OpenWiki Release Validation` | `pnpm test:security` |
| Supply-chain audit | `OpenWiki Supply Chain`, `OpenWiki Required CI`, and `OpenWiki Release Validation` | `pnpm audit --audit-level high`; PR dependency review; CodeQL on public code-scanning repositories; Python docs dependency audit; weekly scheduled CVE scan. |
| MCP conformance | `OpenWiki Lint` and manual pre-release eval | `pnpm eval:mcp-conformance` |
| Inbox agent orchestration | `OpenWiki Lint` | `pnpm eval:inbox-agents`; uploads `openwiki-inbox-agent-evals`. |
| OpenCode tool eval setup | `OpenWiki Lint` setup smoke and manual provider eval | `pnpm eval:opencode-tools -- --setup-only`; run the full provider eval before release evidence |
| PGLite runtime status | ADR/documentation gate | Confirm [ADR 0009](../adr/0009-pglite-local-runtime-spike.md) still reflects the release state. If a PGLite spike exists, keep it experimental and attach parity, backup/restore, crash-recovery, migration, package-install, and vector-extension evidence before promotion. |
| Enterprise dogfood/demo corpus | Manual pre-release eval | `pnpm eval:enterprise-demo -- --json` |
| Scale smoke | `OpenWiki Release Validation` / `scale smoke profile` and PR perf workflow | `pnpm perf:check`; uploads `openwiki-scale-smoke`. |
| 10k scale benchmark | `OpenWiki Scale Performance` / `scale-performance` | Weekly scheduled `OPENWIKI_SCALE_MODE=benchmark OPENWIKI_SCALE_STAGE=10k`; uploads `openwiki-scale-performance`. |
| Release evidence bundle | `OpenWiki Release Validation` / `release evidence bundle` and manual pre-release evidence | `pnpm release:evidence`; uploads `artifacts/openwiki-release-evidence.json` with deployment render/validation evidence under `artifacts/deployment/`, missing-artifact failure, and 90-day retention. |
| Release go/no-go status | Manual pre-release evidence | `pnpm release:status`; writes `artifacts/openwiki-release-status.json` with local, release-day, external-provider, and explicitly deferred-provider checks. Provider scope is defined in `release/openwiki-release-scope.json`. Use `-- --enforce` only when every release-day/public/provider item in the current scope is expected to be complete. |
| Kubernetes kind smoke | Manual pre-release evidence | `pnpm smoke:kubernetes`; set `OPENWIKI_KIND_SMOKE=1` to apply `deploy/kubernetes/base` to kind. |
| Image publishability | `OpenWiki Image` / `image` for PR/default branch smoke; `OpenWiki Release Validation` / `release image` for tag publish | Read-only-root smoke, Trivy scan, SBOM, provenance, and Cosign signing. |
| PR/default branch health | `OpenWiki Lint`, `OpenWiki Docs`, `OpenWiki Postgres Runtime`, `OpenWiki Image` | Typecheck, test, UI smoke/quality, screenshots, docs, Postgres, and image gates. |

Run the release workflow manually before tagging:

```sh
gh workflow run openwiki-release.yml --ref master
```

It also runs automatically for `v*` tags.

When branch protection is enabled, require the stable `ci-required` status from
`OpenWiki Required CI`. The status always appears on pull requests and default
branch pushes; other workflow jobs can remain more specialized without becoming
required-status churn.

## npm Release Automation

The `npm CLI package` job in `OpenWiki Release Validation` publishes
`@openwiki/cli` only for `v*` tags after the release orchestrator and release
image jobs pass. The job downloads the smoke-tested `openwiki-npm-package`
artifact from the same workflow run, verifies that the tarball is exactly one
`@openwiki/cli` package, checks that `github.ref_name` matches `v<package
version>`, confirms that version is not already published, verifies the npm
trusted publishing client version, runs `npm publish --dry-run`, and publishes
the same tarball with `npm publish --access public`. npm trusted publishing
generates package provenance automatically when the repository and package are
public.

Before tagging a release, configure a protected GitHub environment named
`npm-release`, then configure the `@openwiki/cli` package on npm with a trusted
publisher for GitHub Actions: `joe-broadhead/open-wiki`, workflow filename
`openwiki-release.yml`, environment `npm-release`, and allowed action
`npm publish`. Do not configure a long-lived npm publisher token for the release
workflow. Keep manual npm publishing as an emergency fallback only; do not
publish `packages/cli` or the monorepo root directly.

## Release And Tag Checklist

Before tagging a release:

- open public roadmap issues for release blockers, follow-up hardening, and
  first-user docs
- confirm the `npm-release` GitHub environment exists and `@openwiki/cli` trusts
  `.github/workflows/openwiki-release.yml` for the `npm publish` action
- confirm the repository is public before tagging so npm and GHCR provenance
  attestations are generated for the inaugural release artifacts
- confirm ADR 0009 still keeps PGLite out of the default local runtime unless
  every documented promotion gate has current evidence
- run `OpenWiki Release Validation` on the commit that will be tagged
  (`pnpm validate:prod` defers anonymous public URL checks until the repo,
  tag, docs, and schemas are published)
- run a clean generated-package install smoke outside the monorepo with
  `node scripts/openwiki-packaged-cli-smoke.mjs artifacts/npm/openwiki-cli-*.tgz`;
  it installs the tarball into a temporary npm project, initializes a personal
  wiki, validates, rebuilds indexes, installs proposal-mode MCP config, runs
  `export static --out-dir public`, creates and verifies a local backup,
  restores it, and validates the restored workspace
- confirm `OpenWiki Required CI` passed on the release commit for both
  supported Node lines
- run or inspect the latest `OpenWiki Scale Performance` 10k benchmark artifact
- run `pnpm release:evidence` after local artifacts are generated
- run `pnpm release:status` after release evidence, public reachability, and
  provider evidence artifacts are generated; keep
  `artifacts/openwiki-release-status.json` with release evidence
- run `pnpm release:public-check -- --tag "v$(node -p "require('./package.json').version")"`
  after the repository, release, schemas, docs site, and release source
  archives are public; keep `artifacts/openwiki-public-release-check.json`
  with release evidence
- create a version tag and GitHub release with source and image digest details
- confirm the release tag exactly matches `v${package.json.version}`
- confirm all default-branch workflows are green
- confirm `OpenWiki Supply Chain` has passed for dependency changes
- confirm `pnpm docs:build` passes locally and MkDocs builds with `--strict` in
  CI
- confirm generated references are current with `pnpm docs:reference -- --check`
- confirm `pnpm test:security` and `pnpm audit --audit-level high` pass
- confirm Docker image smoke, Trivy scan, Cosign signature, SBOM, and provenance
- copy the release notes template from
  `docs/development/release-notes-template.md` and fill in supported and preview
  profiles
- run `pnpm eval:mcp-conformance` and keep the JSON result with release evidence
- run or inspect `pnpm eval:inbox-agents -- --json` and keep the
  `openwiki.inbox_agent_evals.v1` report with dogfood evidence
- run `pnpm eval:enterprise-demo -- --json` and inspect the generated public
  static export plus private-leakage checks
- confirm `/readyz` fails when derived stores are missing and passes after
  `openwiki index` plus `openwiki db rebuild`
- confirm `pnpm perf:check` passes locally or in release validation and attach
  the generated scale report to release evidence

## Public Announcement Checklist

Before making the repository public or announcing a release:

- confirm `docs/guides/mcp-and-agents.md` covers the personal-wiki agent path
- run `pnpm release:public-check -- --tag "v$(node -p "require('./package.json').version")"`
  and confirm every repository, docs-site, support-doc, changelog, raw schema
  `$id`, and release source archive target passes
- confirm Compose and hosted docs do not imply public write access without auth
- confirm the hosted human and agent cookbook in
  `docs/deployment/hosted-human-agent.md` covers separate SSO/proxy and HTTP MCP
  service-account token paths
- confirm [Hosted Inbox Agents](../guides/hosted-inbox-agents.md) covers
  per-user inboxes, shared Space inboxes, token profiles, rate limits,
  operational state, and backup/sync requirements

## Dogfood And Private Validation Checklist

For a private dogfood wiki:

1. Initialize with `--template personal-wiki`.
2. Run `openwiki index` and `openwiki db rebuild`.
3. Serve on `127.0.0.1` until auth and networking are explicitly configured.
4. Connect agents through local stdio MCP in `proposal` mode.
5. Ask agents to search, read, propose, and inspect proposal detail.
6. Review and apply proposals manually before granting write mode.

Do not expose a write-capable server directly to the internet. Use static export
for public read-only content, or put the server behind SSO/reverse proxy auth
with `OPENWIKI_PUBLIC_ORIGIN` configured.

## Post-Release Verification

After publishing the GitHub release:

1. Verify the GHCR digest in the release notes matches the pushed image digest.
2. Verify the Cosign keyless signature for the digest.
3. Verify SBOM and provenance attestations exist for the digest.
4. Verify the docs site is updated and the release page links to the current
   release docs.
5. Pull the image by digest and run the read-only-root smoke locally or in a
   disposable environment.
6. Confirm `latest` and semver tags point to the intended digest.
7. Confirm the release notes clearly separate supported profiles from preview
   profiles.
