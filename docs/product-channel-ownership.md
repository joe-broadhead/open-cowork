# Channel stack ownership (products/gateway vs monorepo providers)

**Status:** Dual-stack **protocol freeze** retained (intentional residual, not incomplete P1)
**Security body:** **Done** — shared verify kernels + rate-limit primitives in `@open-cowork/shared/node` (JOE-934 / post-#958/#959)
**Related:** dual-stack security guard `scripts/check-dual-channel-security.mjs`; shared kernels in `@open-cowork/shared/node`

## Disposition (post-#959)

| Layer | Status | Meaning |
| --- | --- | --- |
| **Security body** (signature verify, Meta/Discord/Telegram/Slack kernels, rate-limit algorithm) | **Done** | Shared; dual-fix checklist still required for security PRs |
| **Protocol / adapter body** (Durable `channels/*` vs monorepo `gateway-provider-*`) | **Intentional residual freeze** | Not an incomplete P1; full protocol re-home is a future epic (capacity), not a missing security fix |

## Two stacks (intentional)

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

## Protocol migration (future epic — not open P1)

Preferred long-term: products/gateway composes `gateway-provider-*` instead of
local `channels/*`. That is a large product change and is **out of band** for
security body work (already shared). Track as a dedicated capacity epic when
ready — **do not re-open as incomplete dual-stack security P1**.

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

### CI gate (JOE-932)

On `pull_request` to `master`, the monorepo `CI` workflow runs:

```bash
node scripts/check-dual-channel-pr-checklist.mjs
```

with the PR body and the changed-file list. The gate is **inactive** (exit 0)
for unrelated monorepo PRs.

**Activates when the PR touches any of:**

| Surface | Paths |
| --- | --- |
| Durable channels | `products/gateway/src/channels/**` |
| Monorepo providers | `packages/gateway-provider-*/**`, `packages/gateway-channel/**`, `apps/channel-gateway/**`, `apps/standalone-gateway/**` |
| Shared security kernels / guards | `packages/shared/src/node/channel-webhook-security.ts`, `packages/shared/src/node/webhook-rate-limiter.ts`, `scripts/check-dual-channel-security.mjs`, this doc, PR template |

**How to satisfy**

1. Tick **N/A** when the change is not channel security/protocol, **or**
2. Tick the stack(s) reviewed and **Both stacks fixed** (or note single-stack ownership / follow-up in **Notes**), **or**
3. Put `Dual-stack checklist: exempt` in **Notes** with a one-line rationale (intentional single-stack protocol work, docs-only ownership wording, etc.).

Local dry-run:

```bash
OPEN_COWORK_CHANGED_FILES=$'products/gateway/src/channels/whatsapp.ts' \
OPEN_COWORK_PR_BODY="$(cat <<'EOF'
- [x] N/A — not a channel security/protocol change
EOF
)" \
node scripts/check-dual-channel-pr-checklist.mjs
```

Kernel wiring regressions (copy-paste HMAC / Ed25519) remain covered by
`scripts/check-dual-channel-security.mjs` via `pnpm boundaries:check`.
