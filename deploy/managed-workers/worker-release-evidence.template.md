# Managed Worker Release Evidence Template

Copy this template into a private operations repo for each managed-worker
release. Keep this public template generic; do not add real project ids,
domains, account ids, customer names, prices, emails, credentials, signed URLs,
or private incident evidence.

## Release Metadata

| Field | Value |
| --- | --- |
| Release tag | `vX.Y.Z` |
| Cloud image digest | `sha256:REPLACE_WITH_DIGEST` |
| Gateway image digest, if touched | `sha256:REPLACE_WITH_DIGEST` |
| OpenCode runtime version | `REPLACE_WITH_RUNTIME_VERSION` |
| Service-plane protocol version | `REPLACE_WITH_PROTOCOL_VERSION` |
| Event/projection contract version | `REPLACE_WITH_CONTRACT_VERSION` |
| Checkpoint schema version | `REPLACE_WITH_SCHEMA_VERSION` |
| Operator | `TEAM_OR_ROLE` |
| Environment | `staging` / `private-beta` / `production` |

## Pre-Deploy Gates

| Gate | Command or evidence | Pass condition | Result |
| --- | --- | --- | --- |
| Repository checks | `pnpm lint && pnpm typecheck && pnpm test` | all pass | pending |
| Continuation gate | `pnpm test:cloud-continuation` | Desktop/Web/Gateway continuation passes | pending |
| Deployment validators | `pnpm deploy:validate && pnpm ops:validate` | all public templates and ops artifacts validate | pending |
| Docs build | `pnpm docs:build` | strict docs build passes | pending |
| Postgres concurrency | real Postgres `tests/cloud-postgres-concurrency.test.ts` | claims, queues, leases, quotas pass | pending |
| Image provenance | digest/checksum/signature output | image tag resolves to immutable artifact | pending |
| SBOM/notices | release artifacts | SBOM and notices generated | pending |
| Config schema | downstream config validation | no hardcoded private values in public repo | pending |

## Compatibility Decision

| Check | Expected | Observed | Decision |
| --- | --- | --- | --- |
| Worker version accepted by control plane | compatible | pending | pending |
| Older worker drains rather than claims incompatible work | yes | pending | pending |
| New worker reports expected capabilities | yes | pending | pending |
| Checkpoint restore reads previous schema | yes | pending | pending |
| Session projection replay remains compatible | yes | pending | pending |

## Drain And Rolling Update

1. Mark target worker pool `draining`.
2. Confirm `currentLoad=0` or only approved long-running work remains.
3. Confirm `open_cowork_cloud_command_oldest_age_ms` is within SLO.
4. Roll the worker image with `maxUnavailable=0` and `maxSurge=1`.
5. Confirm new worker heartbeats and no stale-owner write spikes.
6. Resume the pool and run smoke prompts/workflows.

| Evidence | Result |
| --- | --- |
| Drain command/audit event id | pending |
| Heartbeat before rollout | pending |
| Heartbeat after rollout | pending |
| Queue age before/after | pending |
| Stale-owner rejection count | pending |
| Smoke session id | pending |
| Smoke workflow run id | pending |

## Rollback Drill

| Step | Pass condition | Result |
| --- | --- | --- |
| Roll back worker image to previous digest | worker heartbeats return on previous digest | pending |
| Existing queued command remains durable | no duplicate execution | pending |
| Projection remains readable | latest projection loads | pending |
| Artifacts/checkpoints remain downloadable | one sample read succeeds | pending |

## Emergency Revoke Drill

| Step | Pass condition | Result |
| --- | --- | --- |
| Revoke worker credential | heartbeat and worker writes are rejected | pending |
| Mark worker revoked | worker cannot claim or renew | pending |
| Lease expiry/reaper recovers work | replacement worker claims safely | pending |
| Audit/diagnostics redacted | no tokens, BYOK plaintext, signed URLs, cookies, or local paths | pending |

## Go/No-Go

| Area | Status | Notes |
| --- | --- | --- |
| Correctness | pending | |
| Security | pending | |
| Cost/quotas | pending | |
| Observability | pending | |
| Restore readiness | pending | |
| Support readiness | pending | |

Decision: `GO` / `NO-GO`
