# Release Notes Template

Copy this template into the GitHub release body and replace placeholders before
publishing.

## OpenWiki vX.Y.Z

Release date: YYYY-MM-DD

Git tag: `vX.Y.Z`

Image digest: `ghcr.io/joe-broadhead/open-wiki@sha256:<digest>`

Release validation: `<OpenWiki Release Validation run URL>`

Npm package: `@openwiki/cli@X.Y.Z`

Package artifact: `openwiki-cli-X.Y.Z.tgz` (`sha256:<tarball-sha256>`)

10k benchmark evidence: `<OpenWiki Scale Performance run URL>` /
`openwiki-scale-performance` / `openwiki-scale-perf-benchmark-10k.json`

Public reachability evidence: `artifacts/openwiki-public-release-check.json`

## Supported Profiles

| Profile | Status | Verification |
| --- | --- | --- |
| `local-personal` | Supported for personal/private testing | `pnpm release:smoke -- local-personal` |
| `public-static` | Supported for public read-only publishing | `pnpm release:smoke -- static-export` |
| `docker-private` | Supported preview | Read-only-root image smoke with `/readyz` and `/mcp-manifest.json` probes; Docker Compose config is validated as this profile's local/trusted-network variant. |

## Preview Profiles

| Profile | Preview Caveat |
| --- | --- |
| `helm-kubernetes` | Manifests and chart are validated, but cluster smoke remains operator-specific. |
| `aws-ecs-efs` | Terraform is a starting point; review DNS, TLS, remote state, auth, and backups. |
| `gcp-gke` | Terraform is a starting point; review Workload Identity, ingress, state, and backups. |
| `cloud-run-readmostly` | Preview/demo/read-mostly profile; do not use for concurrent Git writes. |

## Highlights

- <human-facing product or release highlight>
- <agent/MCP capability highlight>
- <deployment or operations highlight>

## Compatibility

- Node.js: `>=22.22.3`, Node 24 recommended.
- Package manager: pnpm 11.9.0 through Corepack.
- Public distribution: source checkout, generated `@openwiki/cli` package, static export artifacts, and GHCR image.
- npm library packages: not released.

## Verification Checklist

- [ ] `OpenWiki Release Validation` workflow passed for the tagged commit.
- [ ] `@openwiki/cli@X.Y.Z` was published by the `npm CLI package` job with npm
      provenance.
- [ ] `OpenWiki Image` workflow passed for the tag.
- [ ] `OpenWiki Supply Chain` workflow passed or `pnpm audit --audit-level high`
      was run against the release lockfile.
- [ ] `pnpm test:security` passed for the tagged commit.
- [ ] `pnpm docs:reference -- --check` passed for the tagged commit.
- [ ] GHCR digest matches this release note.
- [ ] Cosign signature verifies for the digest.
- [ ] SBOM attestation is available for the digest.
- [ ] Build provenance attestation is available for the digest.
- [ ] Docs site is updated.
- [ ] `pnpm release:public-check` passed and
      `artifacts/openwiki-public-release-check.json` is attached or linked.
- [ ] 10k benchmark artifact is attached or linked and clearly described as
      advisory local/scheduled benchmark evidence, not hosted Postgres
      enterprise-capacity proof.
- [ ] Static export profile produced HTML plus `openapi.json`,
      `mcp-manifest.json`, `search-index.json`, and JSONL artifacts.

## Security Posture

- Threat model: `docs/security/threat-model.md`.
- Human auth: trusted SSO/reverse-proxy boundary; no native login in this
  release.
- Agent auth: service-account bearer tokens with read/proposal/write tool
  modes and policy scopes.
- Browser writes: same-origin protection with `OPENWIKI_PUBLIC_ORIGIN`.
- Source fetches: SSRF controls, redirect blocking, timeouts, byte limits, and
  connector credential refs.
- Supply chain: high-severity pnpm audit, image scan, SBOM, provenance, Cosign
  signature, and optional GitHub dependency review where dependency graph is
  enabled.

Known preview limitations:

- Kubernetes, Terraform, and cloud profiles are reference starting points and
  require operator review for DNS, TLS, state, secrets, ingress, and backups.
- Local filesystem mode is not a clustered multi-writer store.
- Write-capable HTTP and MCP endpoints must not be exposed publicly without
  authenticated ingress.
- Hosted AWS, GCP, and managed Postgres evidence must be linked when
  available, or explicitly caveated as pending with links to the provider
  evidence issues.

## Upgrade Notes

- <required operator action, if any>
- <known limitation or preview caveat, if any>
