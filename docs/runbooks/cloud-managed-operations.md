---
title: Cloud Managed Operations Runbook
description: Health, readiness, rollback, diagnostics, and recovery procedures for managed Open Cowork Cloud and Gateway deployments.
---

# Cloud Managed Operations Runbook

This runbook is for operators running hosted or managed Open Cowork Cloud plus
the headless gateway. It assumes split cloud roles, managed Postgres, object
storage, provider secret management, and a separate gateway deployment.

## Readiness Checks

Before routing traffic to a new deployment:

1. Confirm the cloud web role returns `200` from `GET /healthz`.
2. Confirm authenticated operators can read `GET /api/runtime/status`.
3. Confirm `GET /api/workers/heartbeats` shows at least one fresh worker and
   one fresh scheduler heartbeat when those roles are enabled.
4. Confirm the gateway returns `200` from `GET /health` and `GET /ready`.
5. Confirm gateway `/metrics` includes provider count, delivery counters, and
   error counters when metrics are enabled.
6. Confirm object-store writes work by creating a small artifact or running a
   checkpoint-enabled smoke session.
7. Confirm BYOK status reads return metadata only and no plaintext keys.

## Rollback

Rollback is image-based. Schema migrations must remain additive and
idempotent, so rollback does not require destructive database migration.

1. Pause new rollout traffic at the load balancer or ingress.
2. Scale new workers to zero first so they stop claiming new sessions.
3. Keep at least one scheduler active unless scheduled workflow execution is
   intentionally paused.
4. Roll back cloud `web`, `worker`, and `scheduler` images to the previous
   known-good tag.
5. Roll back gateway images independently if channel delivery or webhook
   handling regressed.
6. Verify `GET /healthz`, `GET /api/workers/heartbeats`, gateway `/ready`, and
   one cloud session prompt.
7. Resume traffic and monitor error rate, command latency, projection lag, and
   gateway delivery retries.

If a release introduced a bad additive column or index, keep the column in
place and ship a forward fix. Do not drop columns during incident rollback.

## Worker Drains

Workers own OpenCode execution while a lease is active. To drain safely:

1. Mark the deployment unavailable to the scheduler/HPA or set replicas down
   gradually.
2. Allow active leases to finish or expire.
3. Confirm no stale owner writes are accepted by checking projection version
   and lease-token error logs.
4. Confirm checkpoint writes are enabled before moving active sessions across
   nodes.

No database transaction should remain open while OpenCode is running.

## Gateway Backlog

Gateway delivery lag is operationally separate from cloud execution lag.

1. Check gateway `/ready` for provider startup state.
2. Check `/metrics` for `open_cowork_gateway_deliveries_received_total` and
   `open_cowork_gateway_errors_total`.
3. Inspect pending `cloud_channel_deliveries` rows by status and
   `next_attempt_at`.
4. For channel-provider outages, keep cloud sessions running and let deliveries
   retry with backoff.
5. For bad provider credentials, rotate the channel secret and restart only the
   affected gateway deployment.

## Secret Rotation

Rotate secrets without moving them through logs, chat, issue comments, or
renderer state.

- Cloud envelope key: rotate through the platform secret manager and verify
  BYOK reveal tests before deleting old key material.
- Cookie secret: rotate during a maintenance window because existing browser
  sessions may be invalidated.
- Gateway service token: issue a new scoped token in the dashboard, update the
  gateway secret, restart the gateway, then revoke the old token.
- Channel credentials: rotate in the channel provider first, update the gateway
  secret, then verify provider readiness.
- Object-store keys: prefer workload identity or short-lived credentials; if a
  static key is used, update the secret and verify artifact read/write.

## Diagnostics

Diagnostics must be redacted before leaving the deployment boundary.

Allowed to include:

- service name, version, role, profile, and image tag,
- health/readiness JSON,
- worker heartbeat age and scheduler heartbeat age,
- gateway provider ids, provider kinds, and started flags,
- counters and non-secret policy verdicts,
- sanitized log excerpts.

Must be redacted:

- API tokens, BYOK keys, provider credentials, OAuth tokens, cookies,
  authorization headers, and webhook secrets,
- Postgres URLs with credentials,
- object-store signed URLs, bucket-private URLs, SAS tokens, and pre-signed
  query strings,
- local host paths and workspace paths,
- user email addresses.

Gateway `/diagnostics` is suitable for support only because it returns redacted
gateway configuration and counters. Put it behind private networking, VPN, or
operator auth in managed deployments; do not expose it as a public webhook
surface.

## Restore Check

After restoring from backup:

1. Restore Postgres first.
2. Restore object-store artifacts and checkpoint prefixes for the same point in
   time.
3. Start web with workers scaled to zero.
4. Verify session list and projections load from durable state.
5. Start one worker, run a smoke prompt, and verify checkpoint writes.
6. Start scheduler, then gateway.
7. Verify channel deliveries resume from durable cursors without duplicates.
