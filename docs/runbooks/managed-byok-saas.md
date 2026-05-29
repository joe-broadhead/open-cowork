---
title: Managed BYOK SaaS Runbook
description: Operating checklist for a hosted Open Cowork Cloud BYOK service.
---

# Managed BYOK SaaS Runbook

This runbook covers the hosted service shape where users bring model/provider
keys and the operator runs cloud sync, workers, object storage, dashboard, and
gateway channel bindings.

## Operating Model

- Open Cowork sells hosted convenience, reliability, sync, and managed channel
  operations.
- Users bring provider keys. Open Cowork does not resell model tokens.
- OSS self-host deployments must continue to work with no billing provider or
  with the stub billing provider.
- Billing, IdP, object store, secret manager, and gateway provider choices stay
  behind adapters.

## Org Signup Mode

Choose one org signup mode per environment:

- `closed`: operators create orgs manually. Use for private beta and internal
  enterprise installs.
- `invite`: users can join only with an invite token or approved membership
  record. Use for design partners and paid trials.
- `domain`: users can self-serve when their email domain is allowlisted.
- `open`: public self-serve. Use only after quotas, billing, abuse controls,
  and support processes are live.

For public SaaS, record the chosen org signup mode in deployment config and
audit changes. Do not auto-provision active orgs for arbitrary identities unless
the environment is intentionally configured for open signup.

## Token TTL And Client Access

- Desktop API tokens should have a token TTL appropriate for user devices,
  usually 30 to 90 days.
- Gateway service tokens should be shorter lived where operationally possible,
  usually 7 to 30 days, and scoped to the org/channel bindings they serve.
- One-time token plaintext is shown only at creation.
- Revocation must block desktop/gateway clients immediately on the next API
  request or SSE reconnect.
- Store token hashes only; never store or log raw token values after creation.

## Invite/Domain Controls

- Keep owner/admin membership changes audited.
- For invite mode, expire unused invite tokens and rate-limit invite creation.
- For domain mode, require verified email from the IdP and deny consumer email
  domains unless they are explicitly part of the plan.
- Removed org members should lose access to dashboard, desktop sync, gateway
  approval authority, and future token creation.

## Billing Setup

- Configure the billing adapter through environment or secret references.
- Keep Stripe or any future provider imports out of core cloud runtime code.
- Webhook signing is mandatory for billing events.
- Subscription states map to entitlements that overlay runtime policy:
  active/trialing may start execution; past_due/canceled cannot start new
  workers or new paid features.
- Keep read/export paths available for canceled orgs unless legal or abuse
  policy requires suspension.
- Record usage events for prompt count, session starts, worker minutes, storage
  usage, and gateway delivery volume.

## BYOK Validation

Before marking a provider key active:

1. Store the key through the BYOK secret store using org/provider AAD.
2. Reveal plaintext only inside the worker role validation path.
3. Build provider runtime config as `provider.<id>.options`.
4. Run a bounded model-call validation or provider metadata check.
5. Confirm read APIs return only status, provider, last4/fingerprint, and
   health.
6. Confirm logs, diagnostics, HTTP payloads, renderer state, and cache contain
   no raw key material.

If validation fails, keep the previous active key if one exists and store the
new key as failed metadata only when that is safe for the provider.

## Gateway Operations

- Gateway deployments use scoped service tokens, never user refresh tokens.
- Channel credentials live in the gateway secret store or platform secret
  manager.
- Public webhook providers require signing secrets or shared secrets.
- Fake provider is disabled in managed environments.
- Gateway metrics and diagnostics require an admin token, VPN, private
  networking, or equivalent operator access.
- Delivery backlog is monitored separately from cloud command execution.
- Poison deliveries are dead-lettered after retry exhaustion and can be
  manually retried after operator review.

## Incident Response

### Suspected BYOK Exposure

1. Disable new worker claims for the affected org.
2. Rotate or revoke the affected provider key with the provider.
3. Rotate cloud envelope/KMS material if ciphertext access may be compromised.
4. Export redacted audit events and diagnostics.
5. Patch the leak, add a regression test, and notify affected users according
   to policy.

### Billing Webhook Abuse

1. Disable billing webhook ingress or rotate the webhook signing secret.
2. Replay known-good events from the provider dashboard.
3. Reconcile `cloud_subscriptions` and usage records.
4. Confirm entitlement gates match the billing provider state.

### Gateway Channel Compromise

1. Rotate channel credentials in the provider.
2. Rotate gateway service token.
3. Restart only affected gateway deployments.
4. Review channel interaction audit events for unauthorized approvals.
5. Dead-letter suspicious outbound deliveries and require manual retry.

### Cloud Data Restore

1. Freeze writes for the affected org or environment.
2. Restore Postgres and object storage to the same point in time.
3. Start web with workers and gateway disabled.
4. Verify sessions, projections, BYOK metadata, billing state, and channel
   bindings.
5. Start one worker, run a bounded smoke prompt, then re-enable scheduler and
   gateway.

## Launch Gates

Private beta can run with manual billing, closed/invite org signup mode, and a
small number of managed gateway channels. Public self-serve requires:

- signup mode explicitly set,
- token TTLs enforced,
- invite/domain controls documented,
- billing adapter and signed webhooks configured,
- BYOK validation active,
- gateway operations runbook exercised,
- incident response contacts and escalation paths ready,
- quotas, rate limits, backups, restore checks, and OTLP/logging verified.
