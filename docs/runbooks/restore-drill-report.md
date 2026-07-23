---
title: Restore Drill Report
description: Non-production restore drill evidence for Open Cowork Cloud operations.
---

# Restore Drill Report

This report is the repository-owned template and baseline drill evidence for
issue #500. Downstream operators should copy it into their private operations
repo for environment-specific drills and replace placeholders with their own
non-secret values.

## Drill Metadata

| Field | Value |
| --- | --- |
| Drill type | Non-production provider-neutral restore rehearsal |
| Scope | Postgres control plane, object-store artifacts/checkpoints, Gateway delivery cursors |
| Restore mode | Web-first, workers/scheduler/Gateway held at zero until validation |
| Report owner | Open Cowork operator |
| Secret handling | Secret names and versions only; no plaintext |

## Required Restore Evidence

The drill is considered passing only when all rows are satisfied.

| Check | Evidence to collect | Pass condition |
| --- | --- | --- |
| Postgres restore | `pg_restore` output and table-count summary | sessions, events, projections, workflows, channel bindings, BYOK metadata, billing/usage, and audit rows are present |
| Object-store restore | provider copy/sync output and prefix-count summary | artifact metadata points at restored blobs; checkpoint manifests are present |
| Secret/KMS references | secret manager version list | cloud secret adapter, OIDC, cookie, gateway, and channel secret refs exist; no plaintext exported |
| Web-only boot | `GET /readyz`, `GET /api/workspace`, `GET /api/diagnostics`, `GET /api/metrics` | all operator reads succeed while workers are still scaled to zero |
| Session projection parity | restored session list and one session projection | latest projection sequence is at least the restored event sequence for the sampled session |
| Artifact metadata | restored artifact list and one download/read check | metadata and blob are both available |
| Worker recovery | one worker enabled and one bounded smoke prompt | worker claims a lease, executes command, writes projection, and saves checkpoint |
| Scheduler recovery | scheduler enabled after worker check | due workflow claim emits a run without double-firing |
| Gateway recovery | Gateway enabled last | delivery cursor resumes without duplicate sends; retry/dead-letter controls work |
| Redaction | diagnostics/log sample | no API token, BYOK plaintext, OAuth token, channel credential, signed URL query, email, or local host path appears |

## Baseline Drill Result

The repository baseline is a dry-runable drill contract, not a live customer
restore. It is verified by:

```bash
pnpm ops:validate
pnpm deploy:validate
```

### Public package refresh (2026-07-21)

| Field | Value |
| --- | --- |
| Last public refresh | 2026-07-21 |
| Commit SHA (package) | see `deploy/private-beta/ops-evidence-package.md` |
| `pnpm ops:validate` | pass on package date |
| Live target restore | **not run in public repo** — required private ops gap (JOE-960) |
| Owner (interim) | Platform / Joseph Broadhead |

Environment-specific drills must additionally run the commands from
`docs/runbooks/backup-restore.md` against a non-production restore target and
attach their redacted command output to the private drill report.

## Follow-Up Template

| Finding | Owner | Severity | Due date | Status |
| --- | --- | --- | --- | --- |
| Example: object-store lifecycle retention shorter than Postgres PITR | Platform | High | YYYY-MM-DD | Open |

Do not merge a managed production launch if a high-severity restore finding is
still open.
