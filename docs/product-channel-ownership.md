# Channel stack ownership (products/gateway vs monorepo providers)

**Status:** Frozen dual-stack policy (audit 2026-07-18)
**Related:** `docs/evidence/opencode-sdk-duplication-audit-2026-07-18.md`

## Two stacks (intentional for this milestone close)

| Stack | Location | Consumers |
| --- | --- | --- |
| **Monorepo providers** | `packages/gateway-provider-*` + `packages/gateway-channel` | `apps/channel-gateway`, `apps/standalone-gateway` |
| **Durable Gateway channels** | `products/gateway/src/channels/*` | `cowork-gateway` daemon only |

These stacks share product *concepts* (Telegram/WhatsApp/Discord) but **must not**
be casually dual-fixed. Security and protocol bugs need an explicit owner.

## Ownership matrix

| Change type | Fix in | Do not |
| --- | --- | --- |
| Cloud Channel Gateway delivery | monorepo providers | products/gateway channels |
| Standalone Gateway providers | monorepo providers | products/gateway channels |
| Durable Gateway (cowork-gateway) inbound/outbound chat | products/gateway channels | monorepo providers (unless migrating) |
| Shared crypto / rate-limit / retry primitives | `packages/gateway-channel` or `@open-cowork/shared` | copy-paste into either stack |

## Migration (future)

Preferred long-term: products/gateway composes `gateway-provider-*` instead of
local `channels/*`. That is a large product change and is **out of band** for
the security/SDK DRY fix PR. Track as a dedicated epic when ready.

Until then, this freeze document is the source of truth for dual-stack ownership.

### Shared security kernel (2026-07-21)

Native platform webhook verify and rate-limit kernels live in
`@open-cowork/shared/node`:

- `channel-webhook-security.ts`: `verifyMetaHubSignature256` /
  `verifyMetaHubVerifyToken` (WhatsApp/Meta),
  `verifyDiscordInteractionSignature` (Discord),
  `verifyTelegramWebhookSecretToken` (Telegram secret-token header),
  `verifySlackRequestSignature` (Slack Events/Interactions)
- `webhook-rate-limiter.ts`: fixed-window `WebhookRateLimiter` (Durable façade;
  monorepo `gateway-channel` keeps an algorithm twin for package boundaries)

Inventory: `docs/evidence/channel-stack-security-matrix-2026-07-21.md`.
Regression guard: `scripts/check-dual-channel-security.mjs`.

## Dual-stack security checklist (required on channel security PRs)

Any PR that changes **channel security or protocol** (webhook signature verify,
SSRF/callback URL policy, bearer/HMAC compares, rate limits, trusted-target
allowlists, credential redaction for channel diagnostics) must:

1. Identify which stack owns the bug (matrix above).
2. Check the **other** stack for the same class of defect.
3. Prefer fixing shared primitives in `packages/gateway-channel` or
   `@open-cowork/shared` when both stacks need the behavior.
4. Tick the dual-channel checklist in `.github/pull_request_template.md`.

Do not land a security fix in only one stack without an explicit “other stack
N/A / follow-up” note in the PR body.
