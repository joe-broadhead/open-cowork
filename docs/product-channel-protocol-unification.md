# Dual-stack channel protocol unification (JOE-994)

**Status:** Capacity epic — **Phase 2 Telegram opt-in façade shipped**; WhatsApp/Discord **protocol freeze retained**
**Security body:** Done (shared kernels + dual-stack checklist / CI gate)
**Linear:** [JOE-994](https://linear.app/joe-broadhead/issue/JOE-994/epic-dual-stack-channel-protocol-unification-capacity)
**Freeze source of truth:** [`product-channel-ownership.md`](product-channel-ownership.md)

This document is the monorepo plan for **when** capacity prioritizes collapsing
Durable Gateway `products/gateway/src/channels/*` onto monorepo
`packages/gateway-provider-*`. It is **not** an incomplete security P1 and
must not be used to re-open dual-stack security work that is already Done.

## Intentional freeze (do not break)

| Layer | Status |
| --- | --- |
| Signature / token / rate-limit kernels | Shared in `@open-cowork/shared/node` |
| PR dual-stack security checklist | Required (JOE-932) |
| Protocol / adapter implementations | **Two stacks by design until this epic ships** |

Until a phase below is explicitly scheduled:

1. Fix security bugs in the owning stack (or shared kernel).
2. Do **not** casually dual-fix protocol adapters.
3. Prefer shared primitives over copy-paste.

## Stack inventory (current)

### Durable Gateway (cowork-gateway)

| Path | Role |
| --- | --- |
| `products/gateway/src/channels/telegram.ts` | Telegram long-poll + send |
| `products/gateway/src/channels/whatsapp.ts` | WhatsApp Meta hub |
| `products/gateway/src/channels/discord.ts` | Discord interactions |
| `products/gateway/src/channels/provider.ts` | Durable adapter interface |
| `products/gateway/src/channels/renderer.ts` | Structured message render |
| `products/gateway/src/channels/capabilities.ts` | Capability matrix |
| `products/gateway/src/channels/webhook-rate-limit.ts` | Durable rate-limit façade |

### Monorepo providers (channel-gateway / standalone)

| Path | Role |
| --- | --- |
| `packages/gateway-provider-telegram/` | Telegram provider package |
| `packages/gateway-provider-discord/` | Discord provider package |
| `packages/gateway-provider-slack/` | Slack provider package |
| `packages/gateway-provider-email/` | Email provider package |
| `packages/gateway-provider-cli/` | CLI provider package |
| `packages/gateway-channel/` | Shared monorepo channel utilities + rate-limit twin |
| `apps/channel-gateway/` | Cloud channel gateway consumer |
| `apps/standalone-gateway/` | Standalone gateway consumer |

## Phased acceptance (when capacity opens)

### Phase 0 — Inventory + freeze (this doc)

- [x] Document both stacks and freeze disposition
- [x] Link JOE-994 from ownership doc
- [x] Machine inventory script (see below) keeps paths honest

### Phase 1 — Shared protocol contracts only

- [x] Extract **non-security** protocol types/capabilities that both stacks can
  import without moving Durable onto monorepo packages
  (`packages/shared/src/channel-protocol-contract.ts`; Durable
  `CHANNEL_ADAPTER_CAPABILITY_KEYS` re-exports shared keys)
- [x] Conformance tests for capability declarations
  (`packages/gateway-channel/src/dual-stack-contract*.ts`,
  `tests/channel-protocol-dual-stack-contract.test.ts`)
- [x] No behavior change for operators (comparison/conformance only; freeze retained)

### Phase 2 — Compose one Durable channel onto monorepo provider

- [x] Pick one provider: **Telegram**
- [x] Durable adapter becomes thin façade over `gateway-provider-telegram`
  (`products/gateway/src/channels/telegram-monorepo-adapter.ts` + shared
  inbound policy in `telegram-inbound-policy.ts`)
- [x] Dual-stack checklist + parity tests green
  (`products/gateway/src/__tests__/telegram-monorepo-facade.test.ts`)
- [x] Feature-flag / config escape hatch for rollback
  (`channels.telegram.protocolStack: durable|monorepo`, default **durable**;
  env `OPEN_COWORK_TELEGRAM_PROTOCOL_STACK` overrides)

**Residuals on monorepo stack (flag-on only):** grammy poll offset is not the
HA operational-sidecar cursor; rich HTML `sendRichMessage` falls back to text;
native `setMyCommands` registration is not mirrored. Default path unchanged.

### Phase 3 — Remaining channels + decommission

- [ ] Migrate remaining Durable channels
- [ ] Remove or archive duplicate protocol code
- [ ] Update freeze doc to “unified” with residual notes

## Non-goals

- Re-opening dual-stack **security** as incomplete P1
- Multi-AZ HA claims (orthogonal; JOE-996 closed migrate hazards only)
- Casual dual-edits of protocol bugs without ownership notes

## Machine inventory

```bash
node scripts/check-channel-protocol-inventory.mjs
```

Fails closed if the freeze ownership doc or either stack’s expected roots are
missing. Does **not** require protocol unification to be complete.

## Exit criteria for JOE-994 epic

- [ ] Phase 2+ landed for all production Durable channels **or** explicit Won’t
  Do with product sign-off and freeze retained
- [ ] Ownership doc updated
- [ ] Dual-stack security checklist still required for security PRs
