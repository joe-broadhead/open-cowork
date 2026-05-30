---
title: Backup and Restore Runbook
description: Executable backup, restore, and recovery drill procedure for Open Cowork Cloud.
---

# Backup and Restore Runbook

This runbook covers provider-neutral recovery for Open Cowork Cloud, workers,
scheduler, and Gateway channel delivery state. It assumes Postgres is the
control-plane source of truth and object storage holds artifacts, uploads,
exports, workspace snapshots, runtime checkpoints, and diagnostics bundles.

## Recovery Objectives

Set these explicitly per environment:

| Environment | Postgres retention | Object-store retention | RPO | RTO |
| --- | --- | --- | --- | --- |
| Internal/dev | daily snapshot, 7 days | versioned, 7 days | 24h | 4h |
| Private beta | PITR, 7-14 days | versioned, 14 days | 15m | 2h |
| Managed production | PITR, 30 days | versioned, 30 days | 5m | 1h |

Use the same retention window for Postgres and object storage. Restoring
Postgres to a point in time while restoring object storage to a different point
can produce missing artifacts, stale checkpoint references, or duplicate channel
deliveries.

## What Must Be Protected

- Postgres control plane: orgs, accounts, memberships, API tokens, sessions,
  commands, events, projections, leases, workflows, worker heartbeats, BYOK
  metadata, billing/usage rows, channel bindings, interactions, deliveries, and
  audit events.
- Object storage: cloud artifacts, uploads, exports, workspace snapshots,
  runtime/XDG checkpoints, generated runtime content, and diagnostics bundles.
- Secret manager/KMS references: Open Cowork secret adapter keys, cookie
  secrets, OIDC client secret, object-store credentials, gateway service tokens,
  channel provider credentials, and billing webhook secrets.

Raw BYOK/provider keys should not be dumped to local files. BYOK ciphertext or
KMS refs are part of Postgres; plaintext exists only in the worker runtime path.

## Backup Schedule

Postgres:

```bash
# Managed providers should use PITR first. This logical dump is the portable
# break-glass backup and local drill input.
pg_dump "$OPEN_COWORK_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file "$OPEN_COWORK_BACKUP_DIR/postgres/open-cowork-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Object storage:

```bash
# S3-compatible stores, including DigitalOcean Spaces.
aws s3 sync "$OPEN_COWORK_OBJECT_STORE_URI" \
  "$OPEN_COWORK_BACKUP_DIR/object-store/" \
  --only-show-errors

# GCS.
gcloud storage rsync --recursive \
  "$OPEN_COWORK_OBJECT_STORE_URI" \
  "$OPEN_COWORK_BACKUP_DIR/object-store/"

# Azure Blob.
az storage blob sync \
  --source "$OPEN_COWORK_OBJECT_STORE_URI" \
  --destination "$OPEN_COWORK_BACKUP_DIR/object-store/"
```

Secrets:

- Prefer platform-managed versioning and rotation history.
- Export only secret names, versions, KMS refs, and rotation timestamps to the
  drill report.
- Never export provider keys, OAuth refresh tokens, API tokens, cookie secrets,
  channel credentials, or billing webhook secrets as plaintext.

## Restore Procedure

1. Freeze writes by removing public traffic or scaling web to read-only
   maintenance mode.
2. Scale workers, scheduler, and Gateway to zero. Do not let workers claim
   sessions during restore.
3. Restore Postgres first:

```bash
createdb "$OPEN_COWORK_RESTORE_DATABASE_NAME"
pg_restore \
  --dbname "$OPEN_COWORK_RESTORE_DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  "$OPEN_COWORK_POSTGRES_BACKUP_FILE"
```

4. Restore object storage to the same point in time:

```bash
aws s3 sync "$OPEN_COWORK_BACKUP_DIR/object-store/" "$OPEN_COWORK_RESTORE_OBJECT_STORE_URI" --only-show-errors
gcloud storage rsync --recursive "$OPEN_COWORK_BACKUP_DIR/object-store/" "$OPEN_COWORK_RESTORE_OBJECT_STORE_URI"
az storage blob sync --source "$OPEN_COWORK_BACKUP_DIR/object-store/" --destination "$OPEN_COWORK_RESTORE_OBJECT_STORE_URI"
```

5. Start only the cloud web role.
6. Verify `GET /healthz`, `GET /api/workspace`, `GET /api/diagnostics`, and
   `GET /api/metrics` with an operator token.
7. Verify session lists, durable projections, artifact metadata, BYOK metadata,
   billing state, workflow definitions, channel bindings, and delivery cursors.
8. Start one worker and run a bounded smoke prompt.
9. Start scheduler and confirm due workflow claims.
10. Start Gateway and confirm channel deliveries resume from stored cursors
    without duplicate sends.
11. Resume traffic after the restore drill report is complete.

## Restore Drill Report Requirements

Each drill must record:

- environment name, restore target, and timestamp,
- Postgres backup source and restore timestamp,
- object-store snapshot/version used,
- secret manager/KMS version references,
- counts for sessions, projections, artifacts, workflows, channel bindings, and
  pending/failed/dead deliveries before and after restore,
- smoke commands run and their results,
- any data that was intentionally excluded,
- follow-up fixes and owner.

Keep reports under `docs/runbooks/restore-drill-report.md` for the latest drill
or a dated operations folder in downstream private repos. Do not include
customer data, raw credentials, local paths, signed URLs, or provider keys.

## Recovery Boundaries

- Do not hand-edit sessions, projections, or delivery cursors during normal
  recovery. Use service APIs and retry/dead-letter controls.
- Do not drop additive schema columns as part of rollback. Ship a forward fix.
- Do not resume workers until object storage is restored or checkpoint restores
  will fail and workers may regenerate divergent state.
- Do not restore local Desktop threads into cloud automatically. Local Desktop
  workspaces remain local unless users explicitly import/upload content.
