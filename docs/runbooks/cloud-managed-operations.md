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

## Web Unavailable Or Erroring

Use this when `GET /healthz` fails, Cloud Web returns elevated 5xx responses,
or users cannot load the Cloud Web Workbench.

1. Check ingress/load-balancer health and TLS certificate status.
2. Check `open_cowork_cloud_http_requests_total` by status and role.
3. Check structured logs by `request_id` for the failing route.
4. Verify Postgres connectivity from the web role.
5. Verify cookie/OIDC configuration if only authenticated routes fail.
6. Scale web replicas up only after the dependency error is understood.
7. If a new image caused the failure, roll back web first; keep workers running
   only if command processing remains healthy.

## Worker Backlog

Use this when prompt latency rises, commands remain pending, or projection lag
grows.

1. Check `open_cowork_cloud_command_queue_depth`,
   `open_cowork_cloud_command_oldest_age_ms`, and
   `open_cowork_cloud_worker_loop_duration_ms`.
2. Check worker heartbeats and active sessions in `GET /api/workers/heartbeats`.
3. Check lease signals: `open_cowork_cloud_worker_lease_claims_total`,
   `open_cowork_cloud_worker_lease_renewals_total`, and
   `open_cowork_cloud_worker_stale_owner_rejections_total`.
4. Check BYOK reveal failures and provider errors before scaling workers.
5. Scale workers horizontally only when Postgres connection pool and provider
   quota have headroom.
6. If one session is poisoning the queue, use session abort/retry controls
   rather than direct database edits.

## Scheduler Stalled

Use this when scheduled workflows do not start or heartbeat age exceeds the
alert threshold.

1. Check scheduler heartbeat freshness.
2. Check `open_cowork_cloud_scheduler_claims_total` and
   `open_cowork_cloud_scheduler_failures_total`.
3. Confirm exactly one scheduler deployment group is active for the environment.
4. Confirm database time and application time are not drifting.
5. Restart scheduler only after checking logs for claim transaction failures.
6. Verify one due workflow claim after restart and confirm no double-fire.

## Postgres Connection Exhaustion

Use this when web, worker, scheduler, or Gateway routes fail with database pool
or timeout errors.

1. Check managed database connection count, wait events, slow queries, and CPU.
2. Temporarily scale workers down before web if user reads must remain
   available.
3. Check queue depth and scheduler claims; high worker concurrency may be
   exhausting the pool.
4. Confirm migrations are not running repeatedly.
5. Add pool capacity or a connection pooler only after bounding worker replicas.
6. Do not increase all role replicas at the same time.

## Object-Store Errors

Use this when artifacts, uploads, exports, or checkpoint restore/save fails.

1. Check object-store service health and credentials/workload identity.
2. Verify bucket/container/prefix exists and has versioning enabled.
3. Check checkpoint restore logs before allowing workers to resume failed
   sessions.
4. For transient object-store failures, keep web reads available and pause
   worker scale-up.
5. For permission failures, rotate or repair object-store credentials and run
   one artifact read/write smoke.

## KMS Or Secret Adapter Errors

Use this when BYOK metadata exists but runtime reveal, cookie secret, OIDC
secret, channel credential, or envelope decryption fails.

1. Check secret manager/KMS availability and IAM on the runtime service account.
2. Confirm `OPEN_COWORK_CLOUD_SECRET_KEY_REF`,
   `OPEN_COWORK_CLOUD_COOKIE_SECRET_REF`, OIDC refs, and gateway secret refs
   point to current versions.
3. Do not copy plaintext secrets into environment variables as a workaround in
   managed deployments.
4. If a KMS key was rotated, verify old ciphertext can still be revealed before
   disabling old key material.
5. Run BYOK metadata and worker validation smoke after repair.

## OIDC Outage

Use this when sign-in, token refresh, or browser callback handling fails.

1. Check IdP status and OIDC discovery document.
2. Check `OPEN_COWORK_CLOUD_PUBLIC_URL`, callback path, client id, and client
   secret reference.
3. Check auth failure rate and backoff state.
4. Keep existing authenticated sessions unless cookie secret rotation is part of
   the incident.
5. Do not switch public deployments to `auth.mode=none`.
6. If emergency admin access is needed, use a scoped API token through private
   networking and audit the action.

## Gateway Provider Outage

Use this when Telegram, Slack, email, webhook, or another channel provider
fails while cloud sessions still execute.

1. Check gateway `/ready` provider status and
   `open_cowork_gateway_delivery_retries_total`.
2. Keep cloud workers running; failed channel delivery should retry or
   dead-letter without blocking execution.
3. Rotate only the affected channel credential if provider auth failed.
4. Use `/deliveries?status=failed` and retry/dead-letter controls after the
   provider recovers.
5. Notify users that desktop and web remain authoritative while chat delivery is
   degraded.

## Webhook Abuse

Use this when webhook auth failures, replay rejections, or rate-limit denials
spike.

1. Confirm public webhook routes require HMAC/shared-secret signatures.
2. Check replay and auth-failure counters by source.
3. Rotate the affected webhook secret if a signing secret may be exposed.
4. Tighten rate limits or temporarily disable the affected channel binding.
5. Preserve audit and redacted diagnostics for incident review.

## BYOK Provider Key Failure

Use this when model calls fail because a user provider key is missing, expired,
revoked, or rejected by provider policy.

1. Confirm read APIs expose metadata only: provider, last4/fingerprint, status,
   and health.
2. Check `open_cowork_cloud_byok_reveal_failures_total` without logging
   plaintext.
3. Mark the provider credential invalid/expired through BYOK metadata.
4. Ask the org owner/admin to rotate the provider key.
5. Resume worker execution only after a bounded validation succeeds.

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
