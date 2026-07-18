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
