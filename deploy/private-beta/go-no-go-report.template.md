# Managed BYOK Private-Beta Go/No-Go Report Template

Use this template for a release candidate or design-partner launch decision.
Store completed reports in a private operations repository or ticket system.
The public repo keeps the evidence shape only.

## Launch Profile And Environment

- Launch profile template:
- Target environment:
- Launch readiness target: `private-beta`
- Org/onboarding tracker:
- Cloud URL:
- Gateway URL:
- Region(s):
- Support owner:
- Incident channel:

## Exact Commit And Release Artifact

- Commit SHA:
- Release tag:
- Cloud image digest:
- Gateway image digest:
- Desktop build identifier:
- Helm/Compose/Terraform revision:
- Config revision:

## Validation Commands With Timestamps

Record exact command output artifacts rather than prose summaries. Each
immutable artifact link should be a GitHub Actions run URL, release asset URL,
GHCR digest URL, private evidence record URL, or object-store URL with a
separate SHA256 value.

| Command | Timestamp | Operator | Result | Exact command output artifact | Immutable artifact link |
| --- | --- | --- | --- | --- | --- |
| `pnpm deploy:validate` | | | | | |
| `pnpm deploy:launch:validate` | | | | | |
| `pnpm deploy:launch:evidence:validate` | | | | | |
| `pnpm deploy:private-beta:validate` | | | | | |
| `pnpm ops:validate` | | | | | |
| `pnpm deploy:smoke` | | | | | |
| `pnpm deploy:desktop:smoke` | | | | | |
| `pnpm deploy:gateway:smoke` | | | | | |
| `pnpm deploy:continuation:smoke` | | | | | |
| `pnpm deploy:load:strict` | | | | | |
| `pnpm deploy:soak:strict` | | | | | |
| `pnpm deploy:failover:drill` | | | | | |
| `pnpm deploy:gcp:preflight` | | | | | |
| `pnpm deploy:gcp:smoke` | | | | | |
| `pnpm test:cloud-continuation` | | | | | |
| `pnpm test:cloud-web` | | | | | |
| BYOK security tests | | | | | |
| billing entitlement tests | | | | | |
| `git diff --check` | | | | | |

## Evidence Register

Use `deploy/private-beta/launch-evidence-record.template.json` as the
machine-readable private evidence record. A `go` decision is invalid unless
every blocking item has a private evidence reference, redacted public summary,
checksum or immutable artifact id, owner, and timestamp.

| Evidence item | Status | Private evidence ref | Public redacted summary | Checksum or immutable artifact id | Owner | Immutable artifact link |
| --- | --- | --- | --- | --- | --- | --- |
| `deployedDesktopWebGatewayContinuation` | | | | | | |
| `deployedLoadTest` | | | | | | |
| `deployedSoakTest` | | | | | | |
| `workerFailover` | | | | | | |
| `schedulerReplicaFailover` | | | | | | |
| `postgresBackupRestore` | | | | | | |
| `objectStoreArtifactRoundTrip` | | | | | | |
| `secretAdapterResolution` | | | | | | |
| `byokRedactionNoPlaintext` | | | | | | |
| `gatewayDeliveryReplayDeadLetter` | | | | | | |
| `quotaRateLimitBehavior` | | | | | | |
| `billingEntitlementGating` | | | | | | |
| `supportIncidentOwnershipEscalation` | | | | | | |
| `costSloNotes` | | | | | | |

## Immutable Release Artifacts

- GitHub Actions run URL:
- GitHub Release URL:
- Cloud GHCR digest URL:
- Gateway GHCR digest URL:
- Desktop macOS artifact SHA256:
- Desktop Linux artifact SHA256:
- Cosign verification artifact:
- SLSA provenance attestation:
- SBOM attestation:
- public template private-value scan:

## Load And Soak Summary

- Load profile: `private-beta`
- Load report:
- Soak profile: `private-beta`
- Soak report:
- p95 read latency:
- p95 mutation latency:
- p95 gateway latency:
- max projection lag:
- max command age:
- SSE reconnects:
- gateway retries:
- gateway dead letters:
- quota rejections:
- billing gate denials:

## Failover And Restore Summary

- Worker restart/failover with pending commands:
- Gateway restart with pending deliveries:
- Backup restore drill:
- Postgres restore proof:
- object-store artifact download after restore:
- BYOK provider call after worker restart:
- scheduler recovery:
- diagnostics redaction sample:

## Security Boundary Checklist

- [ ] BYOK plaintext absent from read APIs, logs, diagnostics, launch reports,
      renderer state, Desktop cache, and Gateway logs.
- [ ] Desktop local workspaces stay local and are not uploaded implicitly.
- [ ] Cloud Channel Gateway is a channel client and delivery adapter, not an execution runtime.
- [ ] Public gateway ingress is signed or HMAC-authenticated.
- [ ] Public Cloud auth uses OIDC or signed trusted-header auth.
- [ ] Tokens are show-once, scoped, expiring by default, and revocable.
- [ ] No real project ids, customer names, domains, prices, provider keys,
      billing ids, or cloud account ids are copied into public repo artifacts.
- [ ] Public/private boundary was checked against
      `deploy/private-beta/managed-byok-readiness-contract.template.json`.
- [ ] Support bundle sample follows the allowed/forbidden diagnostics contract.
- [ ] Onboarding failures preserve machine-readable status and reason codes.

## Public/Private Boundary Evidence

- Public template validation:
- Private ops evidence location:
- Redaction reviewer:
- Public repo scanner result:
- Support bundle redaction proof:
- Onboarding status/reason-code sample:

## Known Risks And Mitigations

| Risk | Impact | Mitigation | Owner | Follow-up |
| --- | --- | --- | --- | --- |
| | | | | |

## Decision

- Decision: `{go|conditional-go|no-go}`
- Decision owner:
- Reviewers:
- Support owner:
- Conditions:
- Follow-up issues:
- Next review date:
