---
title: Gateway Provider Readiness
description: Production readiness tiers, capabilities, authentication, and test expectations for Open Cowork Gateway channel providers.
---

# Gateway Provider Readiness

Gateway providers in this document are Cloud Channel Gateway adapters. They
never own OpenCode execution, sessions, workflow scheduling, or Cloud
control-plane state. Every provider normalizes channel input into Cloud
channel APIs and renders Cloud session events back to the channel.

Standalone Team Gateway may reuse provider packages later, but its private
runtime/control-plane ownership is a separate product mode and not part of this
Cloud Channel Gateway readiness matrix.

The typed source of truth is
`apps/gateway/src/provider-readiness.ts`. The Gateway test suite verifies that
this page, the matrix, and actual provider capabilities stay aligned.

## Provider Identity Contract

Gateway provider configuration separates provider kind from provider instance:

- `kind` is the adapter implementation, such as `telegram`, `slack`, `email`,
  or `webhook`.
- `id` is the configured provider instance, such as `telegram-main`,
  `telegram-support`, `slack-work`, or `webhook-ci`.
- `channelBindingId` is the Cloud control-plane binding that maps the provider
  instance to a headless agent and delivery route.

Kind-only ids such as `telegram` are supported for single-provider deployments.
Production configs with named instances should use kind-prefixed ids such as
`telegram-acme` so multiple providers of the same kind can coexist without
sharing cursors, health, deliveries, or channel-thread bindings.

Every provider exposes `id`, `kind`, and capabilities, and may expose runtime
health. Provider readiness and diagnostics use the instance id for routing and
the kind for capability/policy decisions.

## Provider Readiness Matrix

| Provider | Tier | Status | Modes | Auth / signing | Approvals | Files | Contract tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `telegram` | Tier 1 | Launch | polling, webhook | Bot token; webhook secret when webhook mode is enabled | Inline buttons plus token fallback | Upload/download | `packages/gateway-provider-telegram/src/telegram-provider.test.ts`, `packages/gateway-provider-telegram/src/telegram-retry.test.ts`, `apps/gateway/src/daemon.test.ts` |
| `slack` | Tier 1 | Launch | webhook | Bot token and Slack signing secret | Inline buttons plus token fallback | Upload/download | `packages/gateway-provider-slack/src/slack-provider.test.ts`, `apps/gateway/src/daemon.test.ts` |
| `email` | Tier 1 | Launch | webhook | Inbound shared secret plus stable `messageId`/`id` replay key; SMTP credentials where required | Token fallback | Inbound uploads capped by Gateway request-body limit; outbound artifact links | `packages/gateway-provider-email/src/email-provider.test.ts`, `apps/gateway/src/event-renderer.test.ts` |
| `webhook` | Tier 2 | Utility | webhook | HMAC/timestamp shared secret for ingress and outbound delivery | Inline buttons if bridge supports them; token fallback otherwise | Inline inbound files capped by Gateway request-body limit; outbound links | `packages/gateway-provider-webhook/src/webhook-provider.test.ts`, `apps/gateway/src/daemon.test.ts` |
| `cli` | Tier 2 | Utility | stdio | Trusted local process boundary; no public HTTP ingress | Token fallback | Inbound metadata; outbound links | `packages/gateway-provider-cli/src/cli-provider.test.ts`, `scripts/gateway-cloud-smoke.mjs` |
| `discord` | Tier 3 | Later hardening (Discord Bridge) | signed bridge webhook | Bridge shared secret | Inline buttons plus token fallback | Bridge uploads/downloads capped by Gateway request-body limit | `packages/gateway-provider-discord/src/discord-provider.test.ts`, `packages/gateway-provider-webhook/src/webhook-provider.test.ts` |
| `whatsapp` | Tier 3 | Later hardening (WhatsApp Bridge) | signed bridge webhook | Bridge shared secret | Inline buttons plus token fallback | Bridge uploads/downloads capped by Gateway request-body limit | `packages/gateway-provider-whatsapp/src/whatsapp-provider.test.ts`, `packages/gateway-provider-webhook/src/webhook-provider.test.ts` |
| `signal` | Tier 3 | Later hardening (Signal Bridge) | signed bridge webhook | Bridge shared secret | Token fallback | Bridge uploads/downloads capped by Gateway request-body limit | `packages/gateway-provider-signal/src/signal-provider.test.ts`, `packages/gateway-provider-webhook/src/webhook-provider.test.ts` |
| `fake` | Tier demo | Demo only | local fake webhook | Explicit `OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true`; loopback by default | Inline buttons plus token fallback | In-memory test files capped by Gateway request-body limit | `packages/gateway-testing/src/fake-channel.test.ts`, `apps/gateway/src/daemon.test.ts`, `scripts/gateway-cloud-smoke.mjs` |

## Tier Policy

Tier 1 providers are the launch target. They must have local provider contract
tests, Gateway daemon wiring tests, signed ingress where public, approval
round-trips, file behavior where advertised, and documented live-provider smoke
instructions.

Tier 2 providers are local or integration utilities. They are production-safe
only inside their intended boundary: signed webhook bridges for `webhook`, and
trusted local process boundaries for `cli`.

Tier 3 providers are bridge-backed adapters for later live-provider hardening.
They are useful for downstream experiments, but public launch does not depend
on them until a live provider recipe and smoke path are promoted.

Discord, WhatsApp, and Signal are bridge-mode providers, not native platform
webhook endpoints. A trusted relay must verify the native platform signature or
channel-specific auth first, normalize the payload, and then re-sign it with the
Open Cowork bridge shared secret. Do not point Discord Interactions, Meta
WhatsApp webhooks, or an unauthenticated Signal bridge directly at Gateway; use
the Tier 1 providers or the generic signed webhook provider for public ingress
until native adapters are promoted.

The `fake` provider is not a real channel. It exists for local demos and CI
smokes only. Public exposure is blocked unless a deployer explicitly opts into
the demo override.

## Capability Expectations

- Inline approvals must use provider-native buttons when `inlineButtons` is
  true.
- Channels without buttons must render `/approve`, `/deny`, `/answer`, or
  `/reject` token fallback commands.
- Channels with message editing may update streaming assistant output in place.
- Channels without message editing must chunk or buffer output.
- Files are only sent as provider files when the provider advertises download
  support and the artifact fits provider limits.
- Otherwise, artifacts render as Cloud artifact links.
- Typing indicators are best-effort and must never block prompt execution.

## Security Expectations

- Public webhook providers must fail closed without signing/HMAC/shared-secret
  verification.
- Gateway and Standalone Gateway webhook HTTP surfaces apply source-scoped
  request throttles with `Retry-After` before provider dispatch.
- Generic webhook outbound delivery is signed with timestamped HMAC headers by
  default; legacy shared-secret headers are local compatibility only.
- Gateway service-token authority is separate from inbound actor authority.
  Cloud resolves the channel actor and enforces approval authority.
- Production providers must map incoming messages, commands, and interactions
  to stable provider event ids before Gateway prompts Cloud. Replaying the same
  signed provider event after a Gateway restart must hit the Cloud
  provider-event claim and produce no second prompt.
- Provider sends must preserve the Cloud delivery id as the provider delivery
  id when the provider API allows it. Webhook and bridge providers must also
  send that value as `deliveryId`, `idempotencyKey`, and
  `x-open-cowork-gateway-delivery-id`.
- Diagnostics, logs, provider health, delivery summaries, and metrics must not
  expose raw provider tokens, webhook secrets, API tokens, local paths, or
  signed artifact URLs.
- Local/demo providers must remain loopback-only by default.

## Live Smoke Instructions

Use `pnpm deploy:gateway:smoke` against a real Cloud URL when validating a
deployed appliance. The smoke creates an ephemeral gateway-scoped token,
proves prompt-to-session continuation, exercises approval fallback, creates an
async delivery, verifies delivery acknowledgement, and revokes the token.

Provider-specific live checks:

- Telegram: start with polling for private installs; webhook mode requires an
  HTTPS public URL and webhook secret.
- Slack: configure Events and Interactivity to POST to `/webhooks/slack`; verify
  signed events and button callbacks.
- Email: send an inbound webhook/mail fixture and verify the threaded reply.
- Webhook: send signed bridge payloads and verify unsigned, stale, and replayed
  requests fail.
- CLI: use only for trusted local smoke and never expose it over public HTTP.
