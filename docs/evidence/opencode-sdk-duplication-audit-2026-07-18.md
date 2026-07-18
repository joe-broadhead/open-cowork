# Audit: OpenCode SDK v2 + monorepo duplication

**Date:** 2026-07-18  
**Repo:** open-cowork monorepo (`master` post product partitions, `b3ca93f1`+)  
**Scope:** Wide + deep — OpenCode SDK usage, modular boundaries, and cross-repo
duplicate patterns. Read-only analysis; no code changes in this document.

---

## Executive summary

| Theme | Verdict |
| --- | --- |
| **OpenCode V2 SDK (Desktop / Cloud / Standalone)** | **Strong, intentional, ratcheted.** Pin **1.18.1**, prefer `client.v2.*`, classic residual allowlist is exact-count CI-gated (JOE-845). Not “perfect V2-only” — remaining classic methods are **pin-gated** (no fake V2). |
| **Durable Gateway product (`products/gateway`)** | **Second OpenCode stack.** Classic `@opencode-ai/sdk` root (not `/v2`), package pin **`^1.17.18`** vs monorepo **1.18.1**. Outside desktop boundary scanner source roots. Highest SDK modularity risk. |
| **Duplication overall** | Real and material. Worst: **dual channel/Telegram stacks**, **many redaction implementations**, **constant-time compare copies**, **gateway HTTP/webhook near-clones**, **fetch/timeout helpers**. |
| **Already good extractions** | `runtime-host` V2 facade, shared `opencode-event-translator`, `gateway-channel` retry/rate-limiter, MCP bridge helpers, product partition boundaries. |

**Top 5 extract / reduce opportunities (by impact):**

1. Unify secret redaction onto `@open-cowork/shared`
2. Decide fate of `products/gateway` channels vs `gateway-provider-*` (or freeze dual stack)
3. Align durable Gateway OpenCode client to V2 + pin **1.18.1** (or isolate classic behind one adapter)
4. Single constant-time equals + private-host/SSRF policy
5. Finish webhook HTTP helpers shared by channel-gateway + standalone-gateway

---

## 1. OpenCode architecture (as-is)

### 1.1 Product model

```
OpenCode owns: sessions, tools, permissions, questions, MCP, compaction, event stream
Open Cowork owns: composition (Desktop/Cloud UI, policy, sync, workflows, gateways, deploy)
```

Enforced by package-boundary tests and docs:

- `docs/opencode-sdk-v2-boundary.md`
- `docs/opencode-classic-sdk-burndown.md`
- `tests/opencode-sdk-boundary.test.ts`
- `tests/gateway-package-boundary.test.ts`
- `tests/standalone-gateway-package-boundary.test.ts`

### 1.2 Layering (target mental model)

```
Desktop residual seams / Cloud worker / Standalone adapter
                    │
                    ▼
        @open-cowork/runtime-host
        (process host, V2 client, config, skills, tools)
                    │
                    ▼
        @opencode-ai/sdk/v2  (+ opencode-ai binary where needed)
                    │
                    ▼
        @open-cowork/shared
        (opencode-event-translator → cloud-session-projection)
                    │
                    ▼
        Channel Gateway / UI / cloud-client  (NO SDK)
```

**Parallel stack (partition):**

```
products/gateway (cowork-gateway)
  → classic createOpencodeClient (@opencode-ai/sdk root)
  → own session runtime, peer allowlist, channel adapters
```

### 1.3 Version pins

| Package | `@opencode-ai/sdk` | `opencode-ai` |
| --- | --- | --- |
| `apps/desktop` | **1.18.1** exact | **1.18.1** exact |
| `packages/runtime-host` | **1.18.1** | **1.18.1** |
| `packages/cloud-server` | **1.18.1** | — |
| `apps/standalone-gateway` | **1.18.1** | — |
| **`products/gateway`** | **`^1.17.18`** | — |

**Finding (P0 modularity / supply-chain):** Durable Gateway can resolve a
different SDK minor than Desktop/Cloud. Bump checklist in classic burndown
docs lists authority packages but historically under-emphasized products/gateway.

### 1.4 Import topology

| Entry | Style | Count (approx) |
| --- | --- | --- |
| `@opencode-ai/sdk/v2` (+ `/v2/server`) | Desktop, runtime-host, cloud-server | ~27 files |
| `@opencode-ai/sdk` (classic root) | **products/gateway only** | ~12 files |
| Dynamic `import('@opencode-ai/sdk/v2')` | standalone-gateway `opencode.ts` | 1 module |
| No SDK | channel-gateway, cloud-client, renderer, gateway-provider-*, wiki harness | by design |

### 1.5 Classic residual on pin 1.18.1 (Desktop/runtime-host)

Documented as **Won't Do full burn-down** until OpenCode grows native V2 routes.
Exact allowlist (file:method:count) in CI:

| Family | Methods |
| --- | --- |
| Session | `command`, `delete`, `diff`, `fork`, `share`, `unshare`, `summarize`, `todo`, `update` |
| MCP | `status`, `connect`, `disconnect`, `auth.authenticate`, `auth.remove` |
| Explorer | `file.read`, `file.status`, `find.symbols`, `find.text` |
| Tools | `tool.list` |

**V2-correct practices already present:**

- Prefer `client.v2.*` when routes work
- Double-envelope unwrap only via `unwrapNativeData` (`opencode-v2.ts`, JOE-873)
- Directory-scoped clients for event subscriptions
- Shared event translator (JOE-838) for post-SDK product kinds
- Compatibility registry + `pnpm proof:opencode:compatibility`

### 1.6 V2 gaps / imperfections (actionable)

| ID | Finding | Severity | Recommendation |
| --- | --- | --- | --- |
| SDK-1 | **products/gateway uses classic root SDK**, not `/v2` | High | Migrate to V2 client + `unwrapNativeData` / session helpers from runtime-host or a thin product adapter; pin **1.18.1** exact |
| SDK-2 | **Version range `^1.17.18`** on products/gateway | High | Align pin with monorepo authority; include in bump checklist |
| SDK-3 | products/gateway **outside** `opencode-sdk-boundary` import-path sourceRoots | Medium | Extend boundary tests to scan `products/gateway/**` for import style + pin |
| SDK-4 | Classic residual methods still on Desktop | Medium (accepted) | Continue pin-gated burndown; never fake V2 |
| SDK-5 | Desktop still holds residual SDK seams (IPC types, event subscriptions) | Medium | Progress JOE-842 desktop-composition-shell plan |
| SDK-6 | Dual OpenCode adapters: cloud `opencode-runtime-adapter` (~1.2k LOC) vs runtime-host `runtime.ts` / `opencode-adapter` | Medium | Extract shared “spawn + client + event pump” kernel; keep cloud projection thin |
| SDK-7 | Standalone re-implements client creation (good V2) but private network policy duplicated | Low–Med | Share private-host BlockList |
| SDK-8 | `products/gateway` `openCodeFetch` reimplements timeout abort | Low–Med | Shared `fetchWithTimeout` |

### 1.7 What “perfect V2” would mean here

Not “zero classic calls” on 1.18.1 — OpenCode does not expose working V2 for
those residual methods. Perfect V2 **for this monorepo** means:

1. **Single pin** for all SDK consumers (including products/gateway)
2. **Only `/v2` entry** for new code; classic only on exact allowlist
3. **No second classic client stack** without an adapter that still peels
   envelopes through shared helpers
4. **All post-SDK events** go through `packages/shared` translator → projection
5. **Channel Gateway never imports SDK** (already true)

---

## 2. Duplication audit (cross-repo)

### 2.1 Already extracted (do not re-extract)

| Kernel | Location | Consumers |
| --- | --- | --- |
| Event translation | `packages/shared/src/opencode-event-translator.ts` | standalone, runtime paths |
| Gateway retry / webhook rate limit | `packages/gateway-channel` | channel + standalone providers |
| Provider packages | `packages/gateway-provider-*` | channel + standalone |
| MCP bridge | `mcps/shared/bridge.ts` | bridge MCPs |
| Atomic file writes | `packages/shared/src/node/fs-atomic.ts` | desktop (good) |
| Log sanitizer | `packages/shared/src/log-sanitizer.ts` | partial adoption |

### 2.2 Critical / high impact duplicates

#### D1 — Dual channel stacks (Telegram / Discord / WhatsApp)

| Stack A | Stack B |
| --- | --- |
| `products/gateway/src/channels/*` (raw fetch, own adapters) | `packages/gateway-provider-*` + channel-gateway |

Independent retry, redaction, trust/claim, webhooks. **Largest functional
duplicate** in the monorepo.

**Extract / policy options:**

- **A (preferred long-term):** Migrate durable gateway channels onto
  `gateway-provider-*` composition.
- **B (freeze):** Document dual stack as permanent partition; no dual bugfixes;
  security fixes only on one path with explicit ownership matrix.

#### D2 — Secret redaction (many near-copies)

Implementations include (non-exhaustive):

- `packages/shared/src/log-sanitizer.ts`
- `apps/channel-gateway/src/config.ts` (large local redact*)
- `apps/standalone-gateway/src/redaction.ts`
- `packages/cloud-server/src/operational-text-redaction.ts`
- `packages/cloud-server/src/audit-redaction.ts`
- `products/gateway/src/security.ts` + `channels/telegram.ts` + `observability-snapshot.ts`
- `apps/desktop/src/main/desktop-pairing/redaction.ts`
- wiki backup / credential redactors

**Risk:** Pattern drift → one surface leaks what another redacts.

**Extract:** `@open-cowork/shared` API:

- `redactSecretText`
- `redactRecordByKey`
- `redactForExport`
- optional domain wrappers (pairing, audit) that call primitives only

#### D3 — Constant-time string compare (4–5 copies)

- `packages/shared/src/node/constant-time.ts`
- `packages/gateway-channel/src/crypto.ts`
- `apps/standalone-gateway/src/server.ts`
- `products/gateway/src/security.ts`
- `products/gateway/src/channels/whatsapp.ts`

**Extract:** one `constantTimeEquals` in shared/node; re-export from
gateway-channel if package boundaries require.

#### D4 — Channel-gateway vs standalone webhook HTTP

Near-duplicate: rate-limit claim, client IP, Retry-After, admin bearer, body
size limit, readiness.

**Extract:** `enforceWebhookRateLimit`, `readLimitedBody`, `webhookClientSource`,
`adminBearerAuthorized` (gateway-channel or small `gateway-http`).

#### D5 — OpenCode private URL / SSRF host policy

- `apps/standalone-gateway/src/network-policy.ts`
- `products/gateway/src/opencode-url-policy.ts`
- `packages/gateway-provider-webhook/src/webhook-url-policy.ts`
- MCP bridge loopback policy

**Extract:** single private-range / loopback policy table.

#### D6 — Fetch timeout / retry primitives

- `products/gateway/src/deadlines.ts` (`fetchWithTimeout`)
- `products/gateway/src/opencode-client.ts` (AbortController timeout)
- `mcps/shared/bridge.ts`
- `packages/gateway-channel/src/retry.ts` (good shared retry)
- SSE backoff in channel-gateway local

**Extract:** shared `fetchWithTimeout` + capped jitter backoff helper.

### 2.3 Medium impact

| Cluster | Notes |
| --- | --- |
| Config env readers | Repeated bool/int/required/placeholder across gateways |
| Local JSONC in products/gateway `opencode-assets.ts` | Use shared `parseJsoncText` |
| Doctor / readiness shapes | Shared types exist; builders + TTL single-flight cache still local |
| Logging | shared node logger vs products/gateway logger — share redaction only |
| MCP bootstrap | near-identical `McpServer` + `textResult` + stdio in each MCP |
| MCP contract tests | copy-pasted `withBridge` / failing bridge helpers |
| Process kill helpers | SIGTERM→SIGKILL patterns outside runtime-host tree cleaner |
| Atomic write | desktop uses shared; products/gateway has local `atomicWriteFile` |
| Wiki git process wrappers | package-local `execFile` vs `@openwiki/git` |

### 2.4 Intentional non-duplicates (do not merge)

| Pair | Why separate |
| --- | --- |
| Channel Gateway vs products/gateway OpenCode | Channel is cloud_client; durable gateway owns OpenCode |
| Session engine vs gateway work-store | Different durability models |
| Standalone HTML dashboard vs mission control | Different product surfaces |
| Renderer UI vs gateway HTML | Not comparable |

---

## 3. Modular architecture assessment

### Strengths

- Clear product partitions (`products/{gateway,wiki}`) with boundary checker
- Runtime-host as shared Desktop/Cloud OpenCode substrate
- Channel Gateway SDK-free by contract
- Classic V2 residual ratchet (cannot silently expand)
- Shared event translator after SDK boundary

### Weaknesses

- **Two OpenCode client generations** (V2 monorepo vs classic products/gateway)
- **Two channel provider ecosystems**
- **Security primitives not centralized** (redaction, constant-time, host policy)
- Desktop composition shell residuals still import SDK types at the edge
- products/gateway not fully covered by the same OpenCode import-boundary
  sourceRoots as apps/packages

### Target modular layout (recommended)

```
@open-cowork/shared
  redact*, constantTimeEquals, fetchWithTimeout, privateHostPolicy,
  opencode-event-translator, fs-atomic, parseJsonc

@open-cowork/runtime-host
  ONLY place that creates managed OpenCode servers + primary V2 client
  (cloud/standalone/desktop call into this; no second spawn stacks)

@open-cowork/gateway-channel + gateway-provider-*
  ALL channel providers (including eventual products/gateway migration)

products/gateway
  durable work orchestration only — OpenCode via thin adapter over V2
  channels either import providers or are frozen

mcps/shared
  bootstrap + contract test helpers
```

---

## 4. Recommended program of work

### Phase 0 — Decision (1 session)

1. **products/gateway channels:** migrate to monorepo providers **or** freeze dual stack with ownership matrix.
2. **products/gateway OpenCode:** migrate to V2 + pin 1.18.1 **or** document classic as frozen second authority with bump choreography.

### Phase 1 — Security primitives (high ROI, low product risk)

1. Shared redaction API + migrate channel/standalone/cloud/gateway call sites
2. Shared constant-time equals
3. Shared private-host / SSRF policy

### Phase 2 — Gateway app DRY

1. Webhook HTTP helpers (channel + standalone)
2. Provider registry factory (plugin map)
3. Shared fetchWithTimeout

### Phase 3 — OpenCode V2 perfection

1. Pin products/gateway to 1.18.1 exact; switch to `@opencode-ai/sdk/v2`
2. Extend `opencode-sdk-boundary` tests to products/gateway
3. Reuse `unwrapNativeData` / session create helpers where applicable
4. On each OpenCode bump: classic burndown checklist (already documented)

### Phase 4 — Housekeeping

1. MCP bootstrap + contract helpers
2. products/gateway JSONC + atomic write → shared
3. Doctor builders / readiness cache helpers
4. Wiki git process consolidation
5. Desktop composition shell residuals (JOE-842)

---

## 5. OpenCode V2 compliance scorecard (honest)

| Criterion | Score | Notes |
| --- | --- | --- |
| Prefer native V2 where available | **A** | Desktop/cloud/standalone |
| No fake V2 shims | **A** | Explicit policy |
| Pin coherence | **B−** | products/gateway skew |
| Single client factory | **C+** | multiple create paths |
| Envelope unwrap centralized | **A−** | V2 unwrap helper; classic path separate |
| Event translation shared | **A** | JOE-838 |
| Channel isolation from SDK | **A** | enforced |
| Classic residual control | **A** | exact allowlist |
| Durable gateway on V2 | **D** | classic root + older pin |

**Overall monorepo OpenCode posture: B+**  
**If products/gateway is in scope for “perfect V2”: B− until pin + V2 migration.**

---

## 6. Evidence index

| Artifact | Path |
| --- | --- |
| V2 boundary | `docs/opencode-sdk-v2-boundary.md` |
| Classic burndown | `docs/opencode-classic-sdk-burndown.md` |
| Desktop composition residuals | `docs/desktop-composition-shell.md` |
| Boundary test | `tests/opencode-sdk-boundary.test.ts` |
| V2 facade | `packages/runtime-host/src/opencode-v2.ts` |
| SDK→product adapter | `packages/runtime-host/src/opencode-adapter.ts` |
| Event translator | `packages/shared/src/opencode-event-translator.ts` |
| Standalone adapter | `apps/standalone-gateway/src/opencode.ts` |
| Durable classic client | `products/gateway/src/opencode-client.ts` |
| Cloud runtime adapter | `packages/cloud-server/src/opencode-runtime-adapter.ts` |

---

## 7. Conclusion

The monorepo already has a **world-class intentional OpenCode boundary** for
Desktop/Cloud/Standalone: V2-first, classic residual ratcheted, event
translation shared, Channel Gateway cleanly SDK-free.

The main threats to “perfect V2” and modularity are not ignorance of the SDK —
they are **second stacks**:

1. **products/gateway classic OpenCode client** (pin + entrypoint skew)
2. **products/gateway channel adapters** vs monorepo provider packages
3. **Security primitive forks** (redaction, constant-time, host policy)

Address those three and most of the high-impact duplication collapses into
existing modules (`runtime-host`, `shared`, `gateway-channel` /
`gateway-provider-*`) without inventing a new framework.
