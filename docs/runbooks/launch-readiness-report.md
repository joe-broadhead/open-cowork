---
title: Launch Readiness Report
description: Go/no-go report template for Open Cowork Cloud, Desktop sync, and Gateway launch evidence.
---

# Launch Readiness Report

Use this report as the release evidence record for each local/self-host beta,
private-beta, public-beta, or managed rollout candidate. Generated harness
output should be attached from `.open-cowork-test/launch-readiness/` or copied
into a downstream private operations repository with secrets and project-specific
identifiers redacted.

For the public-repo private-beta campaign package (validators, gap matrix,
support ownership, go/no-go links), start from
`deploy/private-beta/ops-evidence-package.md` and
`deploy/private-beta/private-beta-go-no-go.public.md` (Linear JOE-922 / JOE-971).

## Release Candidate

- Environment:
- Cloud URL:
- Gateway URL:
- Image tags/digests:
- Commit SHA:
- Cloud image digest:
- Gateway image digest:
- Primary command(s):
- Sanitized environment profile:
- Helm/Compose/Terraform revision:
- Target profile: `local-self-host-beta`, `private-beta`, `public-beta`, or
  `enterprise-scale`
- Accepted Launch Tier:
  `{local-self-host-beta|private-beta|public-beta|general-availability|enterprise-scale}`
- Evidence matrix: `deploy/load/launch-evidence-matrix.json`
- Report owner:
- Date:

## Go/No-Go

- Decision: `go`, `conditional-go`, or `no-go`
- Public claim allowed by this report:
- Claims explicitly not made:
- Private evidence record:
- Public-safe summary:
- Decision owner:
- Reviewers:
- Conditions or blockers:
- Follow-up issues:

## Launch Evidence Register

Every private-beta or higher decision must attach the machine-readable record
from `deploy/private-beta/launch-evidence-record.template.json` in a private
operations system. Copy back only the redacted summary, status, checksum, and
follow-up issue id.

| Evidence item | Status | Private evidence ref | Public redacted summary | Checksum | Follow-up |
| --- | --- | --- | --- | --- | --- |
| deployedDesktopWebGatewayContinuation | | | | | |
| deployedLoadTest | | | | | |
| deployedSoakTest | | | | | |
| workerFailover | | | | | |
| schedulerReplicaFailover | | | | | |
| postgresBackupRestore | | | | | |
| objectStoreArtifactRoundTrip | | | | | |
| secretAdapterResolution | | | | | |
| byokRedactionNoPlaintext | | | | | |
| gatewayDeliveryReplayDeadLetter | | | | | |
| quotaRateLimitBehavior | | | | | |
| billingEntitlementGating | | | | | |
| supportIncidentOwnershipEscalation | | | | | |
| costSloNotes | | | | | |
| releaseRollback | | | | | |

## Load Test Report

Attach the JSON and Markdown output from:

```bash
OPEN_COWORK_LOAD_PROFILE=local-self-host-beta \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
pnpm deploy:load:strict
```

The generated report must include the command name, commit SHA, Cloud and
Gateway image digests, sanitized environment profile, dates, duration, and
go/no-go status.

Summarize:

| Area | Target | Actual | Result | Notes |
| --- | --- | --- | --- | --- |
| Cloud Web reads | | | | |
| session list/search/filter | | | | |
| session create/prompt throughput | | | | |
| worker lease renewal/failover | | | | |
| SSE fanout/reconnects | | | | |
| projection/event lag | | | | |
| workflow scheduler claims | | | | |
| gateway inbound/outbound delivery | | | | |
| artifact metadata/object-store access | | | | |
| admin dashboard reads | | | | |
| BYOK runtime injection path | | | | |

## Soak Test Report

Attach the JSON and Markdown output from:

```bash
OPEN_COWORK_LOAD_PROFILE=local-self-host-beta \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
pnpm deploy:soak:strict
```

The generated report must include the command name, commit SHA, Cloud and
Gateway image digests, sanitized environment profile, dates, duration, and
go/no-go status.

Record:

- Duration:
- Max error rate:
- p95 read latency:
- p95 mutation latency:
- p95 gateway latency:
- max command queue depth:
- max oldest command age:
- max projection lag:
- SSE reconnect count:
- gateway retry/dead-letter count:
- worker heartbeat gaps:
- scheduler heartbeat gaps:
- memory/CPU trend:
- connection pool trend:

## Final Smoke

- [ ] `pnpm deploy:smoke`
- [ ] `pnpm deploy:desktop:smoke`
- [ ] `pnpm deploy:gateway:smoke`
- [ ] `pnpm deploy:continuation:smoke`
- [ ] `pnpm deploy:failover:drill` with Cloud/Gateway URLs, private worker/
      scheduler/gateway operator hook evidence confirmed, and evidence metadata
      populated.
      Dry-run output is not launch evidence.
- [ ] provider-specific smoke such as `pnpm deploy:gcp:smoke` where applicable

## Failover And Recovery Evidence

- worker crash during pending command:
- worker crash after runtime event before projection write:
- lease expiry and stale-owner write rejection:
- scheduler restart with due workflow runs:
- Gateway restart with delivery cursor resume:
- Cloud Web/API restart with SSE reconnect:
- object-store transient failure:
- BYOK reveal failure:
- database restore/readiness validation:
- failover drill evidence:

## Quota And Abuse Evidence

- prompt/hour quota pressure result:
- worker-minute quota pressure result:
- active-worker quota pressure result:
- gateway channel binding quota result:
- gateway delivery quota result:
- artifact upload/download metering result:
- HTTP rate-limit result and `Retry-After` sample:
- auth backoff result and audit/metric sample:

## Restore And Backup Evidence

- latest backup job id:
- restore drill report location:
- Postgres restore sample:
- object-store restore sample:
- secret/KMS reference check:
- worker recovery smoke:
- scheduler recovery smoke:
- gateway delivery cursor recovery smoke:
- redaction sample reviewed:

## Security Boundary Evidence

- no raw secrets in payloads/cache/logs/renderer/gateway/diagnostics/metrics:
- operator endpoints separate from tenant user APIs:
- API-token TTL/scope/revocation:
- public webhook ingress fails closed:
- trusted-header auth cannot imply admin without signed trusted proof:
- CSP/browser client boundary:
- OpenCode SDK/server-only import boundary:
- public template private-value scan:

## Public Repo Evidence Boundary

The public `open-cowork` repository stores this evidence contract and generic
validators only. Real managed SaaS launch evidence should live in a private
operations repository or ticket system with cloud project ids, customer names,
URLs, and provider-specific identifiers redacted before any excerpt is copied
back into public docs.

## Cost And Scaling Notes

- cloud web replica count and observed CPU/memory:
- worker replica count and observed CPU/memory:
- scheduler replica count and observed CPU/memory:
- gateway replica count and observed CPU/memory:
- Postgres tier, connection count, and slow-query notes:
- object-store request/egress notes:
- BYOK provider quota notes:
- estimated hourly/day cost at observed load:
- autoscaling or manual scaling guidance:

## Known Limits

- user/session/thread count limit before next retest:
- worker/session concurrency limit before next retest:
- gateway/channel delivery limit before next retest:
- artifact size/rate limit before next retest:
- unavailable provider/channel features:
- operational caveats:

## Findings Workflow

For every failed, skipped, conditional, or stale item above, choose one:

| Finding | Evidence | Disposition | Follow-up issue | Tier impact |
| --- | --- | --- | --- | --- |
| | | `immediate-fix` / `narrow-follow-up-issue` / `tier-scoped-out-of-scope` | | |

## Rollback And Support

- rollback image/tag:
- rollback owner:
- support escalation owner:
- incident channel:
- diagnostics bundle location:
- redaction confirmed:
