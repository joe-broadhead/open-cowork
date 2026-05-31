---
title: Managed BYOK SaaS Boundary
description: Public/private split, onboarding status contract, support bundle limits, and launch package rules for managed BYOK deployments.
---

# Managed BYOK SaaS Boundary

This page is the public contract for turning Open Cowork into a managed BYOK
service without making the upstream repository depend on private SaaS values.
The machine-readable version lives in
`deploy/private-beta/managed-byok-readiness-contract.template.json`.

The goal is simple: the public repo contains provider-neutral product code,
self-hostable defaults, and launch templates. A downstream managed SaaS repo or
private operations system contains real customers, real infrastructure, real
commercial values, and live launch evidence.

## Public/Private Boundary

Keep these artifacts in the public `open-cowork` repo:

| Area | Public repo may contain | Private/downstream only |
| --- | --- | --- |
| Billing | Billing adapter interfaces, stub adapter, provider-neutral entitlement hooks, Stripe adapter code without live ids. | Real Stripe account ids, products, prices, customer ids, coupon ids, invoices, checkout links, and commercial packaging before intentional public launch. |
| BYOK | Secret-store interfaces, status APIs, worker-role reveal contract, runtime config injection code, redaction tests. | Real provider keys, customer provider accounts, validation evidence with identifiable customers, and production secret-manager paths that reveal tenant/account identity. |
| Deployments | Compose/Helm/GCP templates with placeholder refs, self-host docs, validation scripts. | Real project ids, account ids, domains, regions, VPCs, database urls, object-store buckets, KMS refs, and operator credentials. |
| Onboarding | Generic design-partner checklist, status and reason-code taxonomy, launch templates. | Customer names, org slugs, emails, channel handles, support tickets, completed onboarding records, and customer-specific decisions. |
| Support | Redaction rules, intake workflow, diagnostics schema, incident checklist shapes. | Raw diagnostics bundles, logs, database exports, object-store listings, audit exports, support rosters, on-call rotations, private incident channels, and customer communications. |
| Evidence | Required evidence names and public-safe go/no-go shape. | Screenshots, logs, command output, smoke reports, metrics exports, and restore evidence from managed customers or real production-like environments. |

Public-after-launch items such as a marketing domain, public pricing table,
public status page, or public support alias must be intentionally added as
public product material. Until then, keep them private or placeholder-only.

## Onboarding Status Contract

Managed onboarding records should expose stable machine-readable statuses so
Desktop, Cloud Web, Gateway, support, and private operations can describe the
same state without leaking sensitive details.

Required statuses:

| Status | Meaning |
| --- | --- |
| `not_started` | No private ops onboarding record has begun. |
| `invite_sent` | Owner invite or membership bootstrap has been created. |
| `auth_required` | User must finish login, invite acceptance, or device authorization. |
| `org_ready` | Org, owner, membership, and base policy are ready. |
| `byok_pending_validation` | BYOK metadata exists but worker-role validation has not activated it. |
| `byok_active` | BYOK key is active for at least one allowed provider. |
| `desktop_ready` | Desktop connection or token is issued and validated. |
| `gateway_ready` | Gateway service token and at least one channel binding are validated. |
| `billing_blocked` | Entitlement policy blocks paid or managed execution. |
| `quota_blocked` | Quota policy blocks new work. |
| `support_review` | Operator review is required before launch or continuation. |
| `ready` | The org passed onboarding and smoke evidence. |
| `blocked` | The org cannot proceed without an explicit fix or decision. |
| `offboarded` | Access and execution are disabled for exit or incident handling. |

Required reason codes:

| Code | Use |
| --- | --- |
| `auth.invite_required` | No accepted invite or allowed signup path. |
| `auth.membership_missing` | Identity is known but lacks org membership. |
| `auth.role_insufficient` | Actor lacks owner/admin/member role for the action. |
| `auth.token_expired` | Desktop, Gateway, API, or operator token expired. |
| `auth.token_revoked` | Token was revoked and must not be retried silently. |
| `byok.key_missing` | No usable BYOK key exists for the required provider. |
| `byok.provider_disabled` | Provider is disabled by profile, policy, or plan. |
| `byok.validation_failed` | Worker-role provider validation failed. |
| `byok.unsupported_provider` | Provider has no supported managed BYOK path. |
| `billing.subscription_required` | Managed execution requires an active entitlement. |
| `billing.subscription_inactive` | Subscription or manual entitlement is inactive, past due, canceled, or disabled. |
| `quota.prompt_limit_exceeded` | Prompt rate or prompt quota is exhausted. |
| `quota.worker_limit_exceeded` | Worker/session capacity is exhausted. |
| `gateway.channel_not_bound` | Channel thread is not bound to an allowed headless agent/session. |
| `gateway.identity_not_allowed` | Channel actor failed membership or channel RBAC. |
| `gateway.signature_required` | Public webhook/channel ingress lacks required signing proof. |
| `desktop.managed_org_required` | Desktop must connect to a managed org and cannot use arbitrary cloud connections. |
| `support.diagnostics_redaction_required` | Evidence or diagnostics must be redacted before support can attach it. |

User-facing copy can be friendlier, but APIs, dashboards, diagnostics, and
support records should retain these codes so failures remain searchable and
testable.

## Billing And Entitlement Boundary

Self-host deployments must keep working with `cloud.billing.provider=none` or
the stub billing adapter. Commercial billing must be optional and swappable.

Managed private beta can run on manual or stub billing while operators prove
the product flow. Public self-serve must not launch until billing webhooks,
replay protection, rate limits, quotas, and entitlement gates are proven.

Required gates:

- Subscription or manual entitlement state overlays runtime policy.
- `past_due`, `canceled`, `disabled`, and `inactive` states block new paid
  execution.
- Expensive managed work is blocked before worker spawn or lease claim where
  possible.
- Read, export, and offboarding paths stay available unless abuse policy
  requires suspension.
- Billing webhook ingress requires provider signature verification and replay
  protection.
- Billing provider imports stay outside core runtime and self-host paths.

## BYOK Boundary

BYOK plaintext is never readable over HTTP. It is revealed only inside the
worker-role runtime or validation path, scoped by org/provider/session, and
injected through `provider.<id>.options`. It must not be placed in
`process.env`, logs, diagnostics, SSE payloads, renderer state, Desktop cache,
Gateway payloads, billing payloads, or public launch evidence.

Read APIs can return only status-style fields: provider id, last4, fingerprint,
health, status, validation source, and last validation time.

## Support Bundle Contract

A support bundle may include:

- app version, build id, commit, feature flags, surface, and workspace kind,
- redacted org/session/workflow/run/artifact/request/delivery ids,
- status and reason code,
- sanitized error summaries,
- timing, retry, reconnect, queue depth, projection lag, quota, and worker
  heartbeat summaries,
- BYOK provider id and status metadata without plaintext,
- billing plan key, subscription status, and entitlement verdict without
  provider customer data,
- Gateway provider kind, delivery status, and dead-letter counts without
  channel secrets.

A support bundle must not include raw BYOK keys, OAuth tokens, Desktop or
Gateway tokens, API tokens, cookie/internal/operator tokens, MCP secrets,
channel bot tokens, signing secrets, database URLs, signed object-store URLs,
full chat transcript bodies unless explicitly attached by the user, local file
contents, unredacted home-directory paths, or customer identifiers in public
evidence.

## Launch Package Rules

Before inviting managed BYOK users, run:

```bash
pnpm deploy:private-beta:validate
pnpm deploy:validate
pnpm deploy:launch:validate
pnpm ops:validate
pnpm test
pnpm typecheck
pnpm lint
pnpm docs:build
git diff --check
```

Completed launch evidence belongs in a private operations repository or ticket
system. The public repo keeps only templates and redacted examples.
