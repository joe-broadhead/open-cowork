# Dual-stack channel protocol unification (JOE-994)

**Status:** Capacity epic **closed** — Phases 0–3 façades shipped; native
adapter decommission is **Won't Do** with protocol freeze retained (defaults stay Durable
native). Re-open only when product prioritizes monorepo/bridge as default.
**Security body:** Done (shared kernels + dual-stack checklist / CI gate)
**Linear:** [JOE-994](https://linear.app/joe-broadhead/issue/JOE-994/epic-dual-stack-channel-protocol-unification-capacity)
**Freeze source of truth:** [`product-channel-ownership.md`](product-channel-ownership.md)

This document records the monorepo plan and outcomes for composing Durable
Gateway `products/gateway/src/channels/*` onto monorepo
`packages/gateway-provider-*`. It is **not** an incomplete security P1 and
must not be used to re-open dual-stack security work that is already Done.

## Intentional freeze (do not break)

| Layer | Status |
| --- | --- |
| Signature / token / rate-limit kernels | Shared in `@open-cowork/shared/node` |
| PR dual-stack security checklist | Required (JOE-932) — still required |
| Protocol / adapter implementations | **Two stacks by design**; Durable defaults **native**; monorepo opt-in via `protocolStack` |

Until product changes defaults:

1. Fix security bugs in the owning stack (or shared kernel).
2. Do **not** casually dual-fix protocol adapters.
3. Prefer shared primitives over copy-paste.
4. Prefer monorepo façade path only when `protocolStack: monorepo` is intentional.

## Stack inventory (current)

### Durable Gateway (cowork-gateway)

| Path | Role |
| --- | --- |
| `products/gateway/src/channels/telegram.ts` | Telegram long-poll + send (default) |
| `products/gateway/src/channels/telegram-monorepo-adapter.ts` | Opt-in monorepo grammy façade |
| `products/gateway/src/channels/whatsapp.ts` | WhatsApp Meta hub (default) |
| `products/gateway/src/channels/whatsapp-monorepo-adapter.ts` | Opt-in monorepo bridge façade |
| `products/gateway/src/channels/discord.ts` | Discord interactions (default) |
| `products/gateway/src/channels/discord-monorepo-adapter.ts` | Opt-in monorepo bridge façade |
| `products/gateway/src/channels/channel-inbound-policy.ts` | Shared trust/claims/denial policy |
| `products/gateway/src/channels/provider.ts` | Durable adapter interface |
| `products/gateway/src/channels/renderer.ts` | Structured message render |
| `products/gateway/src/channels/capabilities.ts` | Capability matrix |
| `products/gateway/src/channels/webhook-rate-limit.ts` | Durable rate-limit façade |

### Monorepo providers (channel-gateway / standalone)

| Path | Role |
| --- | --- |
| `packages/gateway-provider-telegram/` | Telegram provider package |
| `packages/gateway-provider-discord/` | Discord bridge provider package |
| `packages/gateway-provider-whatsapp/` | WhatsApp bridge provider package |
| `packages/gateway-provider-slack/` | Slack provider package |
| `packages/gateway-provider-email/` | Email provider package |
| `packages/gateway-provider-cli/` | CLI provider package |
| `packages/gateway-channel/` | Shared monorepo channel utilities + rate-limit twin |
| `apps/channel-gateway/` | Cloud channel gateway consumer |
| `apps/standalone-gateway/` | Standalone gateway consumer |

## Phased acceptance

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
  inbound policy)
- [x] Dual-stack checklist + parity tests green
  (`products/gateway/src/__tests__/telegram-monorepo-facade.test.ts`)
- [x] Feature-flag / config escape hatch for rollback
  (`channels.telegram.protocolStack: durable|monorepo`, default **durable**;
  env `OPEN_COWORK_TELEGRAM_PROTOCOL_STACK` overrides)

**Residuals on monorepo Telegram (flag-on only):** grammy poll offset is not the
HA operational-sidecar cursor; rich HTML `sendRichMessage` falls back to text;
native `setMyCommands` registration is not mirrored. Default path unchanged.

### Phase 3 — Remaining channels + decommission

- [x] Migrate remaining Durable channels (opt-in monorepo façades)
  - Discord + WhatsApp bridge façades over `gateway-provider-discord` /
    `gateway-provider-whatsapp` (WebhookProvider bridge mode)
  - Shared inbound policy: `channel-inbound-policy.ts` (all three providers)
  - Defaults remain **durable native**; monorepo requires bridge credentials
- [x] Protocol stack selectors + daemon channel-map wiring for webhook routes
- [x] **Won't Do (with product sign-off):** remove/archive duplicate **native**
  protocol code while monorepo is not product-default. Native Durable adapters
  remain the default operator path; deleting them would force bridge relays or
  grammy HA tradeoffs without a product default flip.
- [x] Update freeze/ownership docs with residual notes (bridge ≠ native)

**Residuals (monorepo Discord/WhatsApp only):** bridge-mode only (relay must
verify native platform signatures); not a drop-in for Meta/Discord interaction
URLs pointed at Gateway; structured rich payloads degrade to text on bridge
outbound.

## Non-goals

- Re-opening dual-stack **security** as incomplete P1
- Multi-AZ HA claims (orthogonal; JOE-996 closed migrate hazards only)
- Casual dual-edits of protocol bugs without ownership notes
- Forcing monorepo `protocolStack` as default without product/ops readiness

## Machine inventory

```bash
node scripts/check-channel-protocol-inventory.mjs
```

Fails closed if the freeze ownership doc or either stack's expected roots are
missing. Does **not** require monorepo to be the default stack.

## Exit criteria for JOE-994 epic

- [x] Phase 2+ façades landed for production Durable channels (Telegram native
  monorepo; Discord/WhatsApp bridge) **and** explicit **Won't Do** on native
  decommission with protocol freeze retained (defaults stay Durable)
- [x] Ownership doc updated (façades + freeze + checklist still required)
- [x] Dual-stack security checklist still required for security PRs

## Residual register (post-epic; not incomplete P1)

| Residual | Owner path | Reopen when |
| --- | --- | --- |
| Native Durable adapters retained as default | `channels/telegram.ts`, `whatsapp.ts`, `discord.ts` | Product sets monorepo/bridge as default |
| Telegram monorepo HA cursor / rich HTML / setMyCommands | monorepo façade only | HA + product parity required |
| Discord/WhatsApp bridge ≠ native Graph/Interactions | monorepo façade only | Native monorepo providers exist or relays are standard |
| Dual-stack security checklist | PR template + CI gate | Full single-stack ownership (not planned) |

When reopening capacity work, file a **new** epic; do not re-mark security body incomplete.
