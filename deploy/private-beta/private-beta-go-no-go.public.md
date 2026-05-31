# Managed BYOK Private-Beta Public Go/No-Go Summary

This is the public-safe launch decision summary for the managed BYOK private
beta evidence campaign. It intentionally does not include real customer names,
cloud project ids, domains, support tickets, prices, provider account ids,
tokens, signed URLs, raw logs, screenshots, cost exports, or diagnostics
bundles.

## Current Decision

- Decision: `no-go`
- Reason: private deployed evidence has not been attached to a private
  operations record for every blocking item in
  `deploy/private-beta/launch-evidence-record.template.json`.
- Current public tier: `local-self-host-beta`
- Higher tiers not claimed: `private-beta`, `public-beta`,
  `general-availability`, `enterprise-scale`
- Evidence matrix: `deploy/load/launch-evidence-matrix.json`
- Public evidence record template:
  `deploy/private-beta/launch-evidence-record.template.json`

## Promotion Rule

A private-beta `go` requires:

- every blocking evidence item to pass in a private operations record
- a redacted public summary for each item
- a checksum or immutable private evidence reference for each item
- signoff from the release owner, support owner, and security/redaction reviewer
- no open P0/P1 launch-blocking findings

Until that happens, the public repo must keep the accepted claim at
`local-self-host-beta`.

## Required Evidence Register

| Evidence item | Public status | Redacted summary | Private evidence checksum | Follow-up |
| --- | --- | --- | --- | --- |
| `deployedDesktopWebGatewayContinuation` | `pending-private-evidence` | Deployed Desktop/Web/Gateway continuation has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `deployedLoadTest` | `pending-private-evidence` | Strict deployed private-beta load evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `deployedSoakTest` | `pending-private-evidence` | Strict deployed private-beta soak evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `workerFailover` | `pending-private-evidence` | Worker crash/restart evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `schedulerReplicaFailover` | `pending-private-evidence` | Scheduler failover evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `postgresBackupRestore` | `pending-private-evidence` | Postgres backup/restore drill evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `objectStoreArtifactRoundTrip` | `pending-private-evidence` | Object-store artifact round-trip evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `secretAdapterResolution` | `pending-private-evidence` | Secret adapter/KMS resolution evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `byokRedactionNoPlaintext` | `pending-private-evidence` | BYOK no-plaintext evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `gatewayDeliveryReplayDeadLetter` | `pending-private-evidence` | Gateway replay/dead-letter evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `quotaRateLimitBehavior` | `pending-private-evidence` | Quota and rate-limit evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `billingEntitlementGating` | `pending-private-evidence` | Billing/entitlement gating evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `supportIncidentOwnershipEscalation` | `pending-private-evidence` | Support ownership and escalation evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |
| `costSloNotes` | `pending-private-evidence` | Cost, capacity, and SLO evidence has not been publicly summarized. | `{private-checksum}` | `{issue-or-empty}` |

## Public/Private Boundary

Private operations evidence may include deployment-specific logs, metrics,
screenshots, restore output, support ownership, cost exports, and customer
context. Public summaries must reduce that evidence to generic pass/fail status,
redacted notes, checksums, and follow-up issue ids only.

## Validation Commands

Run these before changing this public decision summary:

```bash
pnpm deploy:launch:validate
pnpm deploy:private-beta:validate
pnpm ops:validate
pnpm deploy:continuation:smoke
pnpm deploy:load:strict
pnpm deploy:soak:strict
pnpm deploy:gcp:preflight
pnpm deploy:gcp:smoke
git diff --check
```
