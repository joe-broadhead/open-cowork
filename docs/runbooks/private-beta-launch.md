---
title: Private Beta Launch Package
description: Managed BYOK private beta checklist for Open Cowork Cloud, Desktop sync, and Gateway.
---

# Private Beta Launch Package

Use this runbook to onboard design partners onto a managed BYOK Open Cowork
private beta while keeping the OSS self-host path first-class. It turns the
deployment, security, launch-readiness, and support runbooks into one operator
checklist.

Private beta is a managed service posture, not a different product fork:

- Desktop local workspaces stay local.
- Desktop cloud workspaces sync through Open Cowork Cloud.
- Cloud Web, Desktop cloud workspaces, and Gateway all continue the same cloud
  sessions through the shared control plane.
- Gateway is a channel client and delivery adapter, not an OpenCode runtime.
- Users bring provider keys. Open Cowork does not resell model tokens.
- Billing can be manual or stubbed during private beta.
- OSS self-hosters can run Cloud and Gateway without Stripe or managed-only
  dependencies.

## Launch Scope

Private beta includes:

- managed Open Cowork Cloud Web and API,
- split web, worker, and scheduler roles,
- managed object storage, Postgres, secret adapter/KMS, observability, backups,
  and restore process,
- Desktop cloud workspace connection,
- Gateway for approved channels,
- BYOK setup and status,
- quotas, usage summaries, audit logs, diagnostics, and support workflow.

The public repository owns the reusable launch package:

- `deploy/private-beta/private-beta-launch-profile.template.json` defines the
  generic launch profile, entitlements, provider policy, gateway availability,
  RPO/RTO, required evidence, and security-boundary placeholders.
- `deploy/private-beta/managed-byok-readiness-contract.template.json` defines
  the public/private boundary, onboarding statuses, reason codes, billing/BYOK
  invariants, support bundle limits, and required validation commands.
- `deploy/private-beta/design-partner-onboarding.template.md` defines the
  repeatable design-partner onboarding evidence checklist.
- `deploy/private-beta/go-no-go-report.template.md` defines the final decision
  record.

Completed copies belong in a private operations repository or ticket system.
Do not commit real org ids, project ids, customer names, domains, prices,
provider keys, cloud account ids, token values, or launch evidence here.

## Public/Private Boundary

Use [Managed BYOK SaaS Boundary](managed-byok-saas-boundary.md) as the source
of truth for what can live in the public repository. Public files may include
provider-neutral code, placeholder configs, support redaction rules, launch
templates, self-host docs, and validation scripts. Private operations must hold
real customer records, production project/account ids, live prices, real
domains before public launch, support rosters, incident channels, raw
diagnostics, and completed launch evidence.

Private beta excludes:

- public self-serve signup,
- public self-serve Stripe checkout as a launch blocker,
- enterprise compliance certification,
- implicit migration of local Desktop threads or local project files,
- arbitrary local stdio MCPs, host paths, or machine OpenCode config in cloud.

## Product Promise

Before inviting a design partner, the operator must be able to demonstrate:

1. Create a cloud thread in Cloud Web.
2. Continue that thread from Desktop cloud workspace.
3. Continue or receive updates through Gateway.
4. Submit a BYOK provider key and see only status metadata after save.
5. Trigger approval/question flow from one surface and resolve from another.
6. Upload or create an artifact in cloud and retrieve it from another surface.
7. Revoke a Desktop or Gateway token and see access stop on the next request or
   SSE reconnect.
8. Keep a local Desktop workspace usable while the cloud workspace is offline.

## Managed BYOK Onboarding Checklist

Complete each item for every design partner.

The private onboarding record must cover this exact 10-step flow: create or
invite org owner, verify membership and role, configure BYOK through the
write-only endpoint, run provider validation or audited override, issue Desktop
token or managed connection config, issue Gateway service token and channel
binding when enabled, confirm Cloud Web bootstrap and admin surface, run the
first synced cloud thread from Web, continue the same thread from Desktop, and
continue or notify through Gateway.

The onboarding evidence record should preserve these checkpoint names: create or invite org owner;
verify membership and role; write-only endpoint; continue the same thread from Desktop.

### 1. Account And Org

- [ ] Confirm the partner has accepted private beta terms and the support path.
- [ ] Create or approve the org in `closed` or `invite` signup mode.
- [ ] Assign one owner and at least one admin/member as appropriate.
- [ ] Confirm IdP email domain, role mapping, and membership are correct.
- [ ] Record org id, owner email, plan key, support contact, and launch date in
      the private operations tracker.
- [ ] Confirm audit events are written for membership, token, BYOK, billing,
      gateway, and support-sensitive actions.

### 2. BYOK Setup

- [ ] Explain that provider usage is billed by the provider to the user's key.
- [ ] Save the provider key through the BYOK endpoint or dashboard.
- [ ] Confirm read APIs return only provider, status, last4/fingerprint,
      health, and timestamps.
- [ ] Run bounded provider validation from the worker role.
- [ ] Confirm no raw key material appears in logs, diagnostics, browser state,
      Desktop cache, Gateway logs, or launch reports.
- [ ] Document the provider id and status. Do not record the plaintext key.

### 3. Desktop Connection

- [ ] Issue a scoped Desktop token or complete OIDC Desktop login.
- [ ] Confirm Desktop connects to the managed cloud URL over HTTPS.
- [ ] Confirm session list, create, prompt, abort, SSE, cache hydration, and
      offline read-only behavior.
- [ ] Confirm local workspace remains available with no cloud dependency.
- [ ] Revoke the test token and prove it stops working.

### 4. Gateway And Channels

- [ ] Create a headless agent/channel binding for the org.
- [ ] Store channel credentials in the gateway secret store or platform secret
      manager.
- [ ] Confirm public channel webhooks require provider signatures or
      timestamped HMAC/shared-secret auth.
- [ ] Confirm fake provider is disabled outside local/demo contexts.
- [ ] Send a message through the channel, bind or create a cloud session, and
      verify SSE rendering back to the channel.
- [ ] Resolve a permission approval or question from the channel.
- [ ] Verify async/proactive delivery and retry/dead-letter visibility.

### 5. Billing And Quotas

- [ ] Assign a private beta plan key from
      `deploy/private-beta/private-beta-plans.json`.
- [ ] Keep billing mode manual or stubbed unless a signed billing adapter is
      intentionally enabled.
- [ ] Confirm subscription or entitlement state allows intended beta usage.
- [ ] Configure quota caps for concurrent sessions, workers, prompts, gateway
      deliveries, and artifact bytes.
- [ ] Run the ordinary launch-readiness gate with zero unexpected quota
      rejections.
- [ ] Run a deliberate quota-pressure pass and confirm clear 429/402 responses
      without 5xx spikes.

### 6. Final Smoke

Run the same deployment:

```bash
pnpm deploy:smoke
pnpm deploy:desktop:smoke
pnpm deploy:gateway:smoke
pnpm deploy:continuation:smoke
pnpm deploy:load:strict
pnpm deploy:soak:strict
```

Attach the generated load/soak reports and final Web/Desktop/Gateway smoke
evidence to the private operations tracker. Keep project ids, bucket names,
secrets, tokens, BYOK values, and customer identifiers out of committed
reports.

## Hosted BYOK Setup Flow

The design partner path should be documented and repeatable without engineering
tribal knowledge:

1. Operator creates or approves the org.
2. User signs in through the configured IdP.
3. User or operator adds BYOK provider key.
4. Operator validates BYOK status and quotas.
5. User connects Desktop to the managed cloud URL.
6. Operator creates Gateway channel binding or gives user a scoped Gateway
   setup token.
7. User validates Web, Desktop, and Gateway continuation.
8. Operator records support contact, known limits, and expected response time.

## OSS Self-Host Equivalent

Self-hosters must be able to run the same product without commercial services:

- Compose: `docker-compose.cloud.yml`, `docker-compose.cloud.split.yml`, and
  `docker-compose.cloud-gateway.yml`.
- Helm: `helm/open-cowork-cloud` and `helm/open-cowork-gateway`.
- Billing: `cloud.billing.provider=none` or `stub`.
- Secrets: self-managed platform secrets, environment refs, KMS refs, or local
  secret adapter choices.
- Object storage: S3, GCS, Azure Blob, DigitalOcean Spaces, compatible S3, or
  local filesystem for single-node demos.
- Gateway: self-hosted process with a scoped cloud service token and provider
  webhook secrets.
- Support: self-owned unless a managed support agreement exists.

Self-hosting must not require Stripe, a managed dashboard account, a hosted
gateway, or a provider-specific cloud project in core code.

## Managed Vs Self-Host Responsibilities

| Area | Managed private beta | OSS self-host |
| --- | --- | --- |
| Cloud hosting | Operator runs web, worker, scheduler, Postgres, object storage, secrets, backups, and observability. | Deployer runs the same components on their own infrastructure. |
| BYOK | User supplies keys; operator stores encrypted metadata and validates status. | Deployer chooses secret adapter/KMS and owns provider-key handling. |
| Billing | Manual or stubbed private beta plan is acceptable. | Disabled/stub billing is supported and should not block product usage. |
| Gateway | Operator may run managed channel bindings. | Deployer runs gateway with their own tokens and channel credentials. |
| Support | Operator triages sync, BYOK, gateway, quota, and account issues. | Deployer owns local operations unless they buy support. |
| Data retention | Operator documents retention and deletion process. | Deployer owns retention policy. |
| Branding | Hosted product uses operator branding and support links. | Downstream can configure name, logo, legal links, support links, and profiles. |

## Security Posture

- BYOK plaintext is write-only from user surfaces and reveal-only inside the
  worker role.
- Raw provider keys, OAuth refresh tokens, API tokens, MCP secrets, channel
  credentials, signed object-store URLs, and cookie secrets must not appear in
  payloads, cache, logs, diagnostics, launch reports, or renderer state.
- Tenant isolation is enforced through org membership, token scopes, durable
  store filters, object-store prefixes, audit rows, and gateway identity
  resolution.
- Public cloud uses OIDC or signed trusted header auth behind a trusted proxy.
- Public gateway ingress requires provider signatures or timestamped HMAC.
- Diagnostics bundles are redacted before sharing with support.
- Local Desktop threads, local files, local stdio MCPs, and machine runtime
  config are never uploaded implicitly.

## Known Private Beta Constraints

Document the exact constraints for each design partner. At minimum:

- accepted provider ids,
- accepted cloud project-source types,
- supported Gateway providers,
- quota caps,
- billing/manual invoice state,
- support hours and escalation path,
- restore-point objective and restore-time objective,
- whether managed channel bindings are shared or dedicated,
- what data retention and deletion process applies.

## Go/No-Go

Private beta is a **go** only when:

- `pnpm deploy:private-beta:validate` passes,
- `pnpm deploy:launch:validate` passes,
- docs build strictly,
- hosted and self-host package examples validate,
- Web/Desktop/Gateway smoke passes against the same deployment,
- load and soak gates pass for `private-beta`,
- BYOK redaction checks pass,
- support runbook is current,
- known limits are documented,
- there is an owner for every launch-day alert.

The final go/no-go report must record the launch profile and target
environment, exact commit and release artifacts, validation commands with timestamps,
load and soak summaries, restore drill summary, security-boundary checklist,
support owner, known risks with mitigations, and the explicit `go`, `conditional-go`,
or `no-go` decision.

If any required smoke, security, support, or recovery evidence is missing, the
launch remains conditional and should not invite new design partners.
