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

1. Confirm the cloud web role returns `200` from `GET /readyz`; use
   `GET /livez` separately to diagnose process liveness.
2. Confirm authenticated operators can read `GET /api/runtime/status`.
3. Confirm `GET /api/workers/heartbeats` shows at least one fresh worker and
   one fresh scheduler heartbeat when those roles are enabled.
4. Confirm the gateway returns `200` from `GET /health` and `GET /ready`.
5. Confirm gateway `/metrics` includes provider count, aggregate delivery
   counters, provider-labeled counters, and error counters when metrics are
   enabled.
6. Confirm object-store writes work by creating a small artifact or running a
   checkpoint-enabled smoke session.
7. Confirm BYOK status reads return metadata only and no plaintext keys.

## Rollback

Rollback is image-based only while both images use the same clean pre-release
schema baseline. The application does not ship historical upgrade or downgrade
paths. Before deploying a build with a changed baseline, take and verify a
restorable database backup; rollback across that boundary requires restoring
the matching backup or recreating an empty pre-release schema.

1. Pause new rollout traffic at the load balancer or ingress.
2. Scale new workers to zero first so they stop claiming new sessions.
3. Keep at least one scheduler active unless scheduled workflow execution is
   intentionally paused.
4. Roll back cloud `web`, `worker`, and `scheduler` images to the previous
   known-good tag.
5. Roll back gateway images independently if channel delivery or webhook
   handling regressed.
6. Verify `GET /readyz`, `GET /api/workers/heartbeats`, gateway `/ready`, and
   one cloud session prompt.
7. Resume traffic and monitor error rate, command latency, projection lag, and
   gateway delivery retries.

Do not hand-edit the ledger, stamp an existing schema, or drop individual
tables/columns during incident rollback. The readiness check validates ledger
IDs, required tables, and current concurrent indexes. Restore the matching
backup or recreate an empty schema, then ship a corrected clean baseline.

For worker-only regressions, prefer rolling workers back first while keeping
web reads available. Keep the scheduler active only if due workflow claims are
healthy and worker capacity exists.

## Worker Drains

Workers own OpenCode execution while a lease is active. To drain safely:

1. Mark the worker or worker pool `draining` through the admin API.
2. Stop autoscaler scale-up for the pool so no replacement workers start
   claiming work during the drain.
3. Allow active leases to finish or checkpoint, then confirm worker
   `currentLoad=0` and `activeWorkIds=[]`.
4. Confirm no stale owner writes are accepted by checking projection version,
   lease-token error logs, and
   `open_cowork_cloud_worker_stale_owner_rejections_total`.
5. Confirm checkpoint writes are enabled before moving active sessions across
   nodes.

No database transaction should remain open while OpenCode is running.

The worker process also waits for an active command loop to finish during
shutdown until `OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS` elapses. Use that as a
safety net only; drain before terminating pods or hosts.

## Worker Registration

Use this when bootstrapping a new worker pool.

1. Create or update the worker pool with mode `self_hosted` or `saas_operated`.
2. Set `maxWorkers`, `maxConcurrentWork`, region, and capability metadata.
3. Register a worker in `pending` state.
4. Issue a scoped expiring worker credential and store the one-time plaintext
   only in the platform secret manager.
5. Start the worker with a stable `OPEN_COWORK_CLOUD_WORKER_ID`, shared
   Postgres control-plane URL, shared object store, checkpoints enabled, JSON
   logs, and metrics.
6. Verify heartbeat metadata is redacted and includes version, capabilities,
   current load, and region/deployment label.
7. Activate the worker and run a bounded smoke prompt.

Do not start customer-hosted workers against a separate managed control plane
in v1.

## Worker Credential Rotation

1. Issue a replacement credential with the same minimal scopes.
2. Store the new credential in the secret manager.
3. Restart or roll the affected worker after drain.
4. Verify the worker heartbeats with the new credential.
5. Revoke the old credential and confirm old-token heartbeat rejection.
6. Check audit rows for issued, rotated, last-used, and revoked events.

Never paste worker credentials into issue comments, chat, logs, diagnostics, or
release reports.

## Pause, Drain, Resume, And Retire

- Pause: use when a pool should stop claiming and renewing work temporarily.
  Existing work should be recovered by another active worker or allowed to
  expire according to policy.
- Drain: use before rollouts and planned host termination. Draining workers
  renew current leases but should not claim new work.
- Resume: use after rollout or dependency recovery. Confirm queue age and
  claim latency before resuming every pool.
- Retire: use after a worker has drained and will not return. Retired workers
  are terminal and should not receive new credentials.

## Rolling Worker Update

1. Confirm release evidence: image digest/checksum/signature, compatibility
   matrix, SBOM/notices, and config schema validation.
2. Drain one pool or deployment group.
3. Roll workers with `maxUnavailable=0`, `maxSurge=1`, and termination grace
   greater than or equal to `OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS`.
4. Watch worker heartbeat age, queue age, claim latency, command latency,
   checkpoint failures, BYOK reveal failures, stale-owner rejections, and dead
   letters.
5. Run one session prompt, one workflow run, and one checkpoint/artifact smoke.
6. Resume the pool, then continue to the next pool.

## Emergency Revoke

Use this for suspected worker credential, image, host, runtime, BYOK, or
object-store compromise.

1. Revoke the worker credential immediately.
2. Mark the worker `revoked`.
3. Stop the host/pod/deployment.
4. Preserve redacted heartbeat, audit, metric, and diagnostic evidence.
5. Allow leases to expire or be reaped; do not hand-edit durable command or
   workflow records.
6. Start a known-good replacement worker and verify stale-owner writes from the
   revoked worker are rejected.
7. Rotate any potentially exposed object-store, channel, provider, or BYOK
   access path according to the suspected blast radius.

## Stuck Queue

Use this when command queue depth or oldest queued age exceeds SLO.

1. Check quota denials and billing/entitlement denials first; blocked work may
   be intentional.
2. Check active worker count, heartbeat age, current load, and worker pool
   status.
3. Check claim latency and lease denials.
4. Check BYOK reveal failures, object-store failures, provider quota, and
   runtime errors before scaling.
5. If a command is retrying repeatedly, use dead-letter/abort controls rather
   than direct database edits.
6. Scale workers only when Postgres connections, object-store throughput, and
   provider/model quota have headroom.

## Stale Lease Spike

Use this when stale-owner rejections or expired lease reaping spikes.

1. Identify whether the spike followed a rollout, node eviction, object-store
   outage, BYOK reveal outage, or provider outage.
2. Confirm workers are using the expected version and checkpoint schema.
3. Check `OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS` and platform termination grace.
4. Pause autoscaling until the root cause is understood.
5. Verify replacement workers restore from checkpoints and do not duplicate
   output.

## Worker Crash Loop

1. Stop automatic scale-up for the pool.
2. Check last heartbeat error code and redacted summary.
3. Check startup config: control-plane URL, secret refs, object store, profile,
   BYOK provider policy, and runtime cache paths.
4. Run the worker image locally or in staging with the same non-secret config
   shape.
5. Roll back if the crash follows a release. Revoke the credential if the host
   or image may be compromised.

## Gateway Backlog

Gateway delivery lag is operationally separate from cloud execution lag.

1. Check gateway `/ready` for provider startup state.
2. Check `/metrics` for `open_cowork_gateway_deliveries_received_total`,
   `open_cowork_gateway_errors_total`, and provider-labeled retry/dead-letter
   counters by `provider_id` and `provider_kind`.
3. Inspect gateway `/diagnostics.deliveryOperator` and confirm listing, retry,
   dead-letter, and `channelBindingIds` match the affected provider shard.
4. Inspect pending `cloud_channel_deliveries` rows by status, `next_attempt_at`,
   `channel_binding_id`, and `last_claimed_by`.
5. For channel-provider outages, keep cloud sessions running and let deliveries
   retry with backoff.
6. For bad provider credentials, rotate the channel secret and restart only the
   affected gateway deployment.

If gateway lag is caused by worker backlog, do not scale Gateway first. Fix
worker queue age, claim latency, BYOK reveal failures, provider quota, or
object-store checkpoint errors, then let the Gateway delivery feed drain from
durable cursors.

## Web Unavailable Or Erroring

Use this when `GET /livez` fails, `GET /readyz` reports unavailable dependencies,
Cloud Web returns elevated 5xx responses,
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
grows. The queue-depth signal is a bounded estimate from worker scans; use it
with oldest queued age and claim latency rather than as an exact backlog count.

1. Check `open_cowork_cloud_command_queue_depth_estimate`,
   `open_cowork_cloud_runnable_session_claim_duration_ms`, and
   `open_cowork_cloud_worker_loop_duration_ms`.
2. Check worker heartbeats and active sessions in `GET /api/workers/heartbeats`.
3. Check lease signals: `open_cowork_cloud_worker_lease_claims_total`,
   `open_cowork_cloud_worker_lease_renewals_total`, and
   `open_cowork_cloud_worker_expired_leases_reaped_total`.
   If `open_cowork_cloud_worker_expired_lease_reaper_drain_cap_hits_total`
   increases, expired-lease recovery is exhausting its bounded drain cap and
   may need worker capacity or a stuck-owner investigation.
4. Check stale-owner signals:
   `open_cowork_cloud_worker_stale_owner_rejections_total` should remain near
   zero outside crash/failover drills.
5. Check BYOK reveal failures and provider errors before scaling workers.
6. Scale workers horizontally only when Postgres connection pool and provider
   quota have headroom.
7. If one session is poisoning the queue, use session abort/retry controls
   rather than direct database edits.

## Scheduler Stalled

Use this when scheduled workflows do not start or heartbeat age exceeds the
alert threshold.

1. Check scheduler heartbeat freshness.
2. Check `open_cowork_cloud_scheduler_claims_total` and
   `open_cowork_cloud_scheduler_failures_total`.
3. Check `open_cowork_cloud_scheduler_expired_claims_reaped_total`; any
   sustained increase means workflow start claims are expiring before session
   attachment.
   If
   `open_cowork_cloud_scheduler_expired_claim_reaper_drain_cap_hits_total`
   increases, the scheduler is exhausting its bounded recovery drain cap and
   may need more scheduler capacity or investigation of stalled workflow-start
   claims.
4. Confirm exactly one scheduler deployment group is active for the environment.
5. Confirm database time and application time are not drifting.
6. Restart scheduler only after checking logs for claim transaction failures.
7. Verify one due workflow claim after restart and confirm no double-fire.

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

0. Watch `open_cowork_cloud_object_store_operations_total{status="error"}` (by `operation`
   = get/put/head/delete and `cloud_object_store_kind`) and the
   `open_cowork_cloud_object_store_operation_duration_ms` latency — these cover every durable
   read/write, including the object-store I/O behind checkpoint save/restore.
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

1. Check gateway `/ready` provider status,
   `open_cowork_gateway_provider_state`, and provider-labeled retry/dead-letter
   counters.
2. Keep cloud workers running; failed channel delivery should retry or
   dead-letter without blocking execution.
3. Rotate only the affected channel credential if provider auth failed.
4. Use `/deliveries?status=failed&channelBindingId=<binding>` from the affected
   gateway. Retry/dead-letter controls are valid only for deliveries last
   claimed by that gateway token unless an org channel admin performs broader
   Cloud-side recovery.
5. If `/diagnostics.deliveryOperator.disabledReason` is non-null, fix the
   missing Cloud client capability, admin token, or provider binding before
   replaying deliveries.
6. Notify users that desktop and web remain authoritative while chat delivery is
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

## Tenant Offboarding

1. Disable new session, workflow, Gateway, and worker claims for the org.
2. Drain active workers and wait for active work to finish or checkpoint.
3. Revoke org API tokens, worker credentials, gateway tokens, channel
   credentials, and BYOK provider refs.
4. Export or delete artifacts according to the org retention policy.
5. Preserve audit records required by policy while redacting credentials and
   user content from support bundles.
6. Confirm no worker heartbeat, queued command, workflow run, or gateway
   delivery remains active for the org.

## Suspected Key Exposure

Use this when a BYOK key, worker credential, gateway token, object-store key,
cookie secret, OIDC secret, webhook secret, or billing secret may be exposed.

1. Stop the affected ingress or worker pool if active misuse is possible.
2. Revoke or rotate the exposed secret at the source of truth.
3. Revoke dependent sessions/tokens where required, including worker
   credentials and gateway service tokens.
4. Search redacted logs and diagnostics for the secret fingerprint or last4;
   do not paste the secret itself into tools.
5. Re-run BYOK metadata, worker heartbeat, object-store read/write, webhook
   signature, and gateway readiness smoke tests.
6. Record a private incident report with ids, timestamps, and fingerprints
   only. Do not commit incident evidence to the public repo.

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
