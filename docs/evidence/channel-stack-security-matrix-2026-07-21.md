# Dual-stack channel security / capabilities matrix

**Date:** 2026-07-21
**Linear:** JOE-929 (inventory), JOE-934 (shared kernel)
**Related:** `docs/product-channel-ownership.md`

## Stacks

| Stack | Location | Consumers |
| --- | --- | --- |
| **Monorepo providers** | `packages/gateway-provider-*` + `packages/gateway-channel` | `apps/channel-gateway`, `apps/standalone-gateway` |
| **Durable Gateway** | `products/gateway/src/channels/*` | `cowork-gateway` only |

## Control matrix (post-JOE-934)

| Control | Durable | Monorepo | Shared? | Notes |
| --- | --- | --- | --- | --- |
| Constant-time secret compare | `@open-cowork/shared/node` `constantTimeEquals` / digest | `gateway-channel` `constantTimeStringEqual` (twin) + parity test | **Partial** | Twin kept for gateway-channel pack boundary; `tests/constant-time-parity.test.ts` |
| Meta WhatsApp `X-Hub-Signature-256` | **Shared** `verifyMetaHubSignature256` | Bridge mode — re-sign with Open Cowork ingress HMAC (`gateway-provider-webhook`) | **Kernel for native** | Monorepo WhatsApp is **bridge**, not native Meta verify |
| Meta hub.verify_token | **Shared** `verifyMetaHubVerifyToken` | N/A (bridge) | **Kernel for native** | Durable only |
| Discord Ed25519 interaction | **Shared** `verifyDiscordInteractionSignature` | Bridge mode — Open Cowork ingress re-sign | **Kernel for native** | Durable only |
| Telegram secret-token header | Durable long-poll primary (no webhook path); kernel available | **Shared** `verifyTelegramWebhookSecretToken` on monorepo provider | **Kernel for monorepo native** | JOE-923 progressive |
| Slack `X-Slack-Signature` | N/A in Durable `channels/*` | **Shared** `verifySlackRequestSignature` (provider still owns replay cache) | **Kernel for monorepo native** | JOE-923 progressive; monorepo Slack provider composed |
| Webhook rate limit | Durable façade on `/webhooks/whatsapp|discord` composes **shared** `WebhookRateLimiter` | `gateway-channel` local twin (same algorithm; package boundary keeps zero shared dep) | **Shared for Durable; monorepo twin** | JOE-923 progressive; dual-fix algorithm |
| SSRF / host policy on callbacks | Durable peer / channel target policy | Shared private-host + provider SSRF | **Partial** | Prefer `@open-cowork/shared/node` host policy |
| Credential redaction diagnostics | Durable length/redact paths | Channel-gateway length-only fingerprints (#958) | **Partial** | Dual-fix checklist for redaction changes |
| Slack / Signal / Email / Webhook / CLI | N/A in Durable `channels/*` | Monorepo-only providers | **Monorepo-only** | No Durable twin |

## Migration order (risk-first)

1. ~~Native signature/verify kernels~~ — **done in JOE-934** (`packages/shared/src/node/channel-webhook-security.ts`)
2. Wire Durable WhatsApp + Discord to kernel — **done with this inventory**
3. ~~Slack signing kernel + monorepo compose~~ — **done** (`verifySlackRequestSignature` + `gateway-provider-slack`)
4. ~~Durable inbound webhook rate limit~~ — **done** (process-local twin of `WebhookRateLimiter` on WhatsApp/Discord routes)
5. ~~Compose monorepo Telegram secret verify onto shared helper~~ — **done** (`verifyTelegramWebhookSecretToken` in provider); Durable Telegram remains long-poll primary
6. ~~Fold Durable rate-limit twin into shared package~~ — **done** (`packages/shared/src/node/webhook-rate-limiter.ts` + Durable façade); monorepo `gateway-channel` keeps algorithm twin (pack boundary)
7. ~~Provider body migration (Durable → monorepo providers)~~ — **Closed for this milestone:**
   dual-stack freeze retained (`docs/product-channel-ownership.md`); security body
   fully shared (verify kernels + rate-limit); monorepo Telegram secret on shared
   kernel; Durable keeps native protocol adapters (Telegram long-poll, native
   Meta/Discord) as the Durable-owned stack. Full protocol re-home to
   `gateway-provider-*` remains a future epic outside post-#958.

## Dual-stack security PR rule

Any change to signature verify, SSRF, constant-time compare, rate limits, or channel credential redaction must:

1. Identify stack owner (`docs/product-channel-ownership.md`)
2. Check the other stack
3. Prefer `@open-cowork/shared/node` or `gateway-channel` shared primitives
4. Tick PR template dual-channel checklist

## Explicit non-goals (this pass)

- Full deletion of Durable `channels/*` in favor of monorepo providers
- Replacing bridge-mode monorepo providers with native Meta/Discord verify
