---
title: Private Beta Support Runbook
description: Support workflow for managed BYOK private beta onboarding and incidents.
---

# Private Beta Support Runbook

Use this runbook for managed BYOK private beta support. It is intentionally
designed to work without asking users to expose secrets.

## Support Ownership (public)

Interim public ownership for private-beta support (refresh when the private
on-call roster is filled offline). Do not commit personal phone numbers, private
Slack channel ids, or customer-facing email aliases here.

| Role | Interim public owner | Escalation |
| --- | --- | --- |
| Support primary | Joseph Broadhead | Linear project `open-cowork` / team Joe; Sev1 ≤ 30 minutes |
| Support secondary | TBD in private roster | Same Linear project |
| Cloud auth owner | Joseph Broadhead (interim) | Support primary |
| Worker / BYOK owner | Joseph Broadhead (interim) | Support primary |
| Gateway owner | Joseph Broadhead (interim) | Support primary |
| Platform (Postgres / object store / KMS) | Joseph Broadhead (interim) | Support primary |
| Release / go-no-go owner | Joseph Broadhead | Milestone **Post-#958 Production Next Steps** |

Evidence package: `deploy/private-beta/ops-evidence-package.md`
(Linear: JOE-922 / JOE-968). Private phone trees and chat channels stay offline.

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
5. Check Gateway metrics next: stream reconnects, aggregate and provider-labeled
   delivery retries/dead letters, provider status, and session-stream count.
6. Check object-store and Postgres health for artifact, checkpoint, or replay
   issues.
7. Record outcome, mitigation, owner, and follow-up test.

## Support Bundle Contract

Support bundles should follow the public contract in
[Managed BYOK SaaS Boundary](managed-byok-saas-boundary.md). They may include
app/build metadata, surface, workspace kind, redacted org/session/workflow/run/
artifact/request/delivery ids, status and reason code, sanitized error
summaries, timing/retry/reconnect/queue/projection/quota summaries, BYOK status
metadata, billing entitlement verdicts, and Gateway delivery counts.

They must not include raw BYOK keys, OAuth tokens, Desktop or Gateway tokens,
API tokens, cookie/internal/operator tokens, MCP secrets, channel bot tokens,
signing secrets, database URLs, signed object-store URLs, full chat transcript
bodies unless explicitly attached by the user, local file contents, unredacted
home-directory paths, or customer identifiers in public evidence.

## Onboarding Status And Reason Codes

Support, Cloud Web, Desktop, Gateway, and private operations should use the same
machine-readable status and reason-code taxonomy. The canonical list is in
`deploy/private-beta/managed-byok-readiness-contract.template.json`; common
examples are:

- `auth.invite_required`
- `auth.membership_missing`
- `auth.token_expired`
- `auth.token_revoked`
- `byok.key_missing`
- `byok.validation_failed`
- `billing.subscription_inactive`
- `quota.worker_limit_exceeded`
- `gateway.identity_not_allowed`
- `support.diagnostics_redaction_required`

Do not replace these with provider-specific or customer-specific text in public
artifacts. User-facing messages may be friendlier, but retain the code in logs,
diagnostics, audit exports, and support records.

## BYOK Issue Handling

For user/provider key issues:

1. Confirm the provider id is enabled in the org profile and plan.
2. Confirm the BYOK status endpoint shows configured or active metadata only.
3. Run the bounded provider validation path from the worker role.
4. Check provider-side errors without logging plaintext key material.
5. If compromise is suspected, stop new worker claims for the org, ask the user
   to revoke the provider key with the provider, rotate cloud envelope/KMS
   material if needed, and follow `docs/runbooks/managed-byok-saas.md`.

## Incident Checklists

### Suspected Key Exposure

1. Stop new worker claims for the affected org or provider profile.
2. Revoke or disable the affected BYOK secret metadata record.
3. Ask the customer to revoke the provider key with the upstream provider.
4. Rotate envelope/KMS material if ciphertext handling is in doubt.
5. Review logs, diagnostics, audit exports, Desktop cache artifacts, Gateway
   logs, and launch reports for plaintext exposure.
6. Record the incident timeline, affected orgs, mitigation, and follow-up
   tests in the private incident tracker.

### Token Compromise

1. Revoke the suspected Desktop, Gateway, API, or operator token.
2. Verify the token cannot authenticate on the next request or SSE reconnect.
3. Rotate related service credentials when scope is uncertain.
4. Review audit events for unexpected org, BYOK, gateway, billing, or admin
   actions.
5. Issue replacement scoped tokens only after the actor identity is verified.

### Channel Identity Misbinding

1. Pause the affected channel binding or headless agent.
2. Verify inbound actor identity separately from gateway service-token auth.
3. Check `cloud_channel_identities`, session bindings, interaction tokens, and
   delivery cursors for the affected provider/thread.
4. Rebind the channel only after owner/admin confirmation.
5. Audit whether approvals/questions were resolved by the wrong actor and
   record remediation.

## Gateway Issue Handling

For channel issues:

1. Confirm the gateway service token is valid and scoped.
2. Confirm inbound actor identity resolves separately from gateway service
   auth.
3. Confirm webhook signatures or shared-secret/HMAC headers are present.
4. Confirm the channel binding maps to the expected org, headless agent, and
   cloud profile.
5. Check `/diagnostics.deliveryOperator` for enabled controls and scoped
   `channelBindingIds`.
6. Check the durable delivery cursor and dead-letter queue.
7. Retry dead-lettered deliveries only after reviewing the event body and
   provider error, and use the gateway token that last claimed the delivery
   unless a channel admin is performing broader Cloud-side recovery.

## Desktop Sync Issue Handling

For Desktop cloud workspace issues:

1. Confirm the user is in the cloud workspace, not the local workspace.
2. Confirm the configured cloud URL is HTTPS and matches the managed org.
3. Confirm token refresh/revocation status.
4. Confirm session list and full projection hydrate before cursor resume.
5. Confirm local workspace remains usable if cloud is offline.
6. If cache corruption is suspected, ask the user to export diagnostics first,
   then clear the cloud cache for that workspace only.

## Customer Offboarding

Use offboarding when a private-beta partner leaves, a trial ends, or an
incident requires org shutdown:

1. Disable new execution by pausing entitlement/profile access.
2. Revoke Desktop, Gateway, API, and operator-issued tokens.
3. Disable BYOK secret metadata and confirm no worker can reveal plaintext.
4. Remove or pause channel bindings and delivery streams.
5. Export customer-owned data according to the agreed retention policy.
6. Remove or quarantine object-store prefixes after export and retention review.
7. Preserve audit logs for the agreed retention period.
8. Confirm support can no longer access the org except through approved audit
   retention workflows.

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
