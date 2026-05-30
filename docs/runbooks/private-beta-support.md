---
title: Private Beta Support Runbook
description: Support workflow for managed BYOK private beta onboarding and incidents.
---

# Private Beta Support Runbook

Use this runbook for managed BYOK private beta support. It is intentionally
designed to work without asking users to expose secrets.

## Support Intake

Collect:

- org id or org slug,
- user email or channel identity,
- surface: Cloud Web, Desktop cloud workspace, local Desktop workspace, Gateway,
  BYOK, billing/quota, or admin dashboard,
- session id, run id, workflow id, artifact id, or channel delivery id when
  available,
- timestamp and timezone,
- expected behavior and observed behavior,
- whether the issue blocks all work or one surface,
- redacted diagnostics bundle or launch-readiness report if available.

Do not request:

- provider API keys,
- OAuth refresh/access tokens,
- Desktop cloud tokens,
- Gateway service tokens,
- channel signing secrets,
- cookie secrets,
- database URLs,
- object-store signed URLs,
- full local filesystem paths unless the user intentionally shares a redacted
  path for a local-only issue.

## Triage Matrix

| Symptom | First checks | Escalation |
| --- | --- | --- |
| Cannot sign in | IdP status, org membership, signup mode, cookie settings, clock skew, audit event. | Cloud auth owner. |
| BYOK validation fails | Provider status, key fingerprint, worker role logs, quota/provider error code, redaction. | Worker/BYOK owner. |
| Desktop does not sync | Token status, workspace URL, SSE reconnects, local vs cloud workspace id, cache status. | Desktop sync owner. |
| Gateway does not reply | Gateway health/readiness, provider webhook signature, channel binding, delivery backlog, dead letters. | Gateway owner. |
| Approvals/questions stuck | Session projection pending state, command queue age, gateway interaction token, actor RBAC. | Projection/runtime owner. |
| Artifacts missing | Projection metadata, object-store read/write, signed URL redaction, restore status. | Object-store owner. |
| Quota/billing blocked | Subscription state, entitlement overlay, quota counters, expected 402/429 response. | SaaS operations owner. |
| Admin panel inconsistent | API bootstrap, role membership, audit rows, cache-control, browser console redaction. | Cloud Web owner. |

## Diagnostics Workflow

1. Ask the user for a redacted diagnostics bundle or reproduce from operator
   logs using org/session ids.
2. Verify the bundle contains no raw BYOK, API token, OAuth token, channel
   secret, cookie, database URL, or signed object-store URL.
3. Correlate request id, org id, session id, run id, worker id, scheduler id,
   and gateway delivery id.
4. Check Cloud metrics first: command age, projection lag, worker heartbeats,
   quota rejections, BYOK failures, and HTTP error rate.
5. Check Gateway metrics next: stream reconnects, delivery retries, dead
   letters, provider status, and session-stream count.
6. Check object-store and Postgres health for artifact, checkpoint, or replay
   issues.
7. Record outcome, mitigation, owner, and follow-up test.

## BYOK Issue Handling

For user/provider key issues:

1. Confirm the provider id is enabled in the org profile and plan.
2. Confirm the BYOK status endpoint shows configured or active metadata only.
3. Run the bounded provider validation path from the worker role.
4. Check provider-side errors without logging plaintext key material.
5. If compromise is suspected, stop new worker claims for the org, ask the user
   to revoke the provider key with the provider, rotate cloud envelope/KMS
   material if needed, and follow `docs/runbooks/managed-byok-saas.md`.

## Gateway Issue Handling

For channel issues:

1. Confirm the gateway service token is valid and scoped.
2. Confirm inbound actor identity resolves separately from gateway service
   auth.
3. Confirm webhook signatures or shared-secret/HMAC headers are present.
4. Confirm the channel binding maps to the expected org, headless agent, and
   cloud profile.
5. Check the durable delivery cursor and dead-letter queue.
6. Retry dead-lettered deliveries only after reviewing the event body and
   provider error.

## Desktop Sync Issue Handling

For Desktop cloud workspace issues:

1. Confirm the user is in the cloud workspace, not the local workspace.
2. Confirm the configured cloud URL is HTTPS and matches the managed org.
3. Confirm token refresh/revocation status.
4. Confirm session list and full projection hydrate before cursor resume.
5. Confirm local workspace remains usable if cloud is offline.
6. If cache corruption is suspected, ask the user to export diagnostics first,
   then clear the cloud cache for that workspace only.

## Escalation Evidence

Every escalation should include:

- issue title and severity,
- org id,
- affected surface,
- affected session/channel/workflow/artifact ids,
- request ids,
- first bad timestamp,
- last known good timestamp,
- redacted logs or diagnostics path,
- metrics screenshot or report,
- whether there is a rollback or mitigation.

Never attach raw secrets to issues, support tickets, chat, or release evidence.
