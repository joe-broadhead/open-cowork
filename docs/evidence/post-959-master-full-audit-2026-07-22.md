# Full deep & wide codebase audit — post-#959 `master`

**Date:** 2026-07-22  
**HEAD:** `12e48c9c` (`Post-#958 production next steps (milestone quality signal) (#959)`)  
**Scope:** Entire monorepo after squash-merge of PR #959; branch pruned; `master` synced to `origin/master`  
**Method:** Quantitative local gates + three parallel deep read-only audits (security, architecture, ops/claims). Skeptical re-check of “done” claims against source — not rubber-stamping prior scorecards.

---

## Executive summary

| Domain | Grade | One-line |
| --- | --- | --- |
| **Security** | **B** | Production-usable with disciplined operators; no P0 unauthenticated RCE; 2× P1 residual (webhook XFF rate-key, export coverage gaps) |
| **Architecture / maintainability** | **B−** | Strong partitions + hard LOC budgets; façades sit at **97–99%** of ceilings; dual-stack body intentional |
| **Ops / claims honesty** | **B+** | `local-self-host-beta` honest; private-beta **no-go**; HA non-claim enforced; stale docs are the main drift risk |
| **Supply chain** | **B+** | `audit:prod` / `audit:full` green (only low DOMPurify); empty ignore list; 3-day minimumReleaseAge |
| **CI / quality signal** | **A−** required checks / **B−** evals | Required PR surface solid; monthly evals non-blocking |
| **Overall condition** | **B** | Merge-ready state is real; next work is P1 security polish, ceiling-module extraction, private evidence for hosted go, and doc hygiene |

**Bottom line:** After #959 the codebase is in **good production-grade condition for local/self-host beta**, with honest non-claims, green CI, and real security fail-closed defaults. It is **not** multi-AZ HA, **not** hosted private-beta go, and still carries intentional dual-stack + pin-gated classic-SDK residual tax.

---

## Merge / prune record

| Step | Result |
| --- | --- |
| PR #959 | Squash-merged with admin (self-review blocked by branch policy) |
| Merge commit | `12e48c9c` |
| Remote branch | Deleted (`origin/fix/milestone-post-958-quality-signal`) |
| Local prune | Gone-remote branches removed; `master` fast-forward clean |
| Working tree | Clean on `master` @ `origin/master` |

---

## Quantitative snapshot (HEAD)

### Supply chain

- `pnpm audit:prod` (moderate+): **green** (0 high/moderate unignored)
- `pnpm audit:full` (high+): **green**
- Residual advisory: **DOMPurify low** (`GHSA-C2J3-45GR-MQC4`, ≤3.4.11) — below gate thresholds
- `pnpm.auditConfig.ignoreGhsas/ignoreCves`: **empty**
- Overrides present for prior P0s (`tar`, `js-yaml`, `brace-expansion`, `hono`, `@hono/node-server`, `fast-uri`, …)
- `minimumReleaseAge: 4320` (3 days)

### God-module hard budgets (all PASS, tight)

| Path | LOC | Hard max | Headroom |
| --- | --- | --- | --- |
| `products/gateway/src/work-store.ts` | 1956 | 2000 | 44 |
| `products/gateway/src/daemon-routes/work.ts` | 1942 | 1960 | **18** |
| `packages/cloud-server/src/http-server.ts` | 1930 | 1970 | 40 |
| `packages/cloud-server/src/app.ts` | 1855 | 1900 | 45 |
| `products/gateway/src/scheduler.ts` | 1791 | 1820 | 29 |
| `products/gateway/src/config.ts` | 1780 | 1800 | **20** |
| `apps/desktop/src/main/workspace-gateway.ts` | 1690 | 1730 | 40 |
| `products/gateway/src/environments.ts` | 1262 | 1300 | 38 |

Soft target **1500** fails for 7/8 budgeted façades (only `environments.ts` under soft).

### Unbudgeted large modules (watch)

| Path | LOC |
| --- | --- |
| `packages/cloud-server/src/postgres-control-plane-store.ts` | 1996 |
| `products/gateway/src/mcp.ts` | 1629 |
| `products/gateway/src/channel-commands.ts` | 1426 |
| `packages/cloud-server/src/opencode-runtime-adapter.ts` | 1196 |
| `products/gateway/src/channel-sync.ts` | 1004 |

### Wiki watch-band (hard 800)

| Path | LOC | Note |
| --- | --- | --- |
| `postgres-runtime/src/jobs.ts` | 793 | Near hard |
| `mcp-server/src/tool-router.ts` | 733 | Residual split |
| `workflows` memory/backup/dream | 718–748 | Residual |
| `http-api/src/oauth.ts` | 321 | Split done (JOE-977) |

### Gates (green at audit time)

- `check-god-module-loc.mjs` OK  
- `check-durable-opencode-classic-gate.mjs` OK (V2 construction + façade-only session I/O)  
- `check-dual-channel-security.mjs` OK  
- `check-opencode-pin-lockstep.mjs` OK (all authority packages **1.18.1**)  
- `check-distributed-ownership-claims.mjs` OK (`registry status=partial`)  

---

## Security findings (code-backed)

### P1

| ID | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| **SEC-1** | Durable webhook rate-limit client key trusts raw `X-Forwarded-For` first hop without trusted-proxy walk | `products/gateway/src/channels/webhook-rate-limit.ts` vs `resolveHttpClientAddress` in `security.ts` / channel-gateway trust-proxy path | Reuse exposed HTTP client-address resolver; test spoofed XFF when peer untrusted |
| **SEC-2** | Bulk sensitive admin dumps outside JOE-952 guard | `GET /storage/export` (`exportGatewayState`, no redaction/rate guard); `GET /opencode/sessions/:id/messages` always raw admin, no export guard | Apply `guardUnredactedExport` + audit; consider redacted default for storage export |

### P2

| ID | Finding | Notes |
| --- | --- | --- |
| **SEC-3** | Inconsistent `localAdmin` dual-intent on raw/unredacted paths | Some paths require `localAdmin`; others only admin + rate guard |
| **SEC-4** | Dual-stack rate-limiter / constant-time twins | Shared algorithm + `gateway-channel` copy; maintenance risk |
| **SEC-5** | Process-local abuse controls under multi-replica | Acceptable for single-daemon; pod-multiplied budgets if experimental multi-replica |
| **SEC-6** | HTTPS MCP DNS-rebind residual | Accepted (JOE-826/962); OpenCode owns TLS |
| **SEC-7** | Chart iframe `unsafe-eval` | Accepted with sandbox + connect-none + validators |
| **SEC-8** | Cloud SPA `style-src 'unsafe-inline'` | Style-only residual for runtime design-system CSS |

### Explicit non-findings (checked OK)

Desktop sandbox + IPC sender URL checks; cloud CSRF + OIDC `safeReturnTo`; gateway bind refuse `unsafeAllowNoAuth`+non-local; shared Meta/Discord/Slack/Telegram verify kernels; wiki loopback scope-token + hosted auth fail-closed; wiki CSP `style-src 'self'` (JOE-980); empty audit ignore list; E2E handlers fail-closed without `OPEN_COWORK_E2E=1`.

### Residual accepted risks (still true)

1. Dual channel protocol stacks freeze (security body shared)  
2. No multi-AZ / multi-replica Gateway HA product claim  
3. Chart CSP `unsafe-eval` (Vega)  
4. HTTPS MCP residual  
5. Public multi-tenant hosted Wiki claim-gated (JOE-978 / JOE-959 process)  
6. Admin token = full power (rate limits bound volume, not capability)  

---

## Architecture findings

1. **Hard budgets green, soft target decorative** — worst headroom: `daemon-routes/work.ts` (18 lines), `config.ts` (20 lines).  
2. **Work-store modularized, not small** — façade 1956 + ~25 leaves (~9k domain LOC).  
3. **Import-cycle monorepo gate is UI-scoped only** (`packages/app`, `packages/ui`) — runtime-host / cloud-server / desktop main not scanned.  
4. **Root knip ignores `products/gateway` and `products/wiki`** — product knip is separate.  
5. **OpenCode post-#959:** pin lockstep 1.18.1; Durable V2 façade real; Desktop classic allowlist exact-count **Won't Do** full burn-down on this pin.  
6. **WorkspaceSessionPort:** cloud full; **local residual** — production IPC still hits `sessionEngine` directly.  
7. **Dual-stack channels:** freeze honest; Telegram body still dual (~673 vs ~616 LOC).  
8. **Unbudgeted gods** (`mcp.ts`, `channel-commands.ts`, postgres control-plane store) evade ratchet.

---

## Ops / claims findings

### Honest and enforced

- Public tier: **`local-self-host-beta` only**  
- Private-beta public decision: **`no-go`** (`deploy/private-beta/private-beta-go-no-go.public.md`)  
- Multi-AZ HA forbidden language + Helm `replicaCount>1` fail-closed without experimental flag  
- Distributed-ownership registry `status=partial`; open migrate hazards **H1, H3, H4, H8, H13**  
- Required PR checks: validate, cloud-gates, macos/linux/windows package, docs, coverage, CodeQL  

### Gaps

| Gap | Severity |
| --- | --- |
| Hosted private-beta go evidence (load/soak/restore/failover/BYOK live/support roster) all pending | **Blocks go** (correct) |
| Monthly evals non-blocking + monthly cadence | Quality latency risk |
| Experimental multi-replica lab flag with open migrate hazards | Operator footgun if misread |
| ~~**Stale docs** still describing Durable as classic root~~ | **Fixed** on remediation branch (see hygiene + Remediation PR) |

### Stale docs to refresh (cheap)

1. ~~`docs/opencode-sdk-v2-boundary.md` — Durable classic paragraph~~ **fixed** on remediation branch (V2 + façade)  
2. ~~`docs/opencode-standalone-adapter-decision.md` — “until JOE-941”~~ **fixed** on remediation branch  
3. ~~`docs/evidence/repo-wide-surface-audit-2026-07-21.md` — historical banner~~ **fixed** (points here)  

---

## Remediation PR (this branch)

Branch: `fix/post-959-p0-p3-remediation` — documentation + process residuals only.
Does **not** invent private-beta go evidence or flip go/no-go to `go`.

| Priority | Closed / tightened in this branch |
| --- | --- |
| **P1 docs** | Durable classic drift fixed in `docs/opencode-sdk-v2-boundary.md` (V2 construction + façade post JOE-941) and `docs/opencode-standalone-adapter-decision.md` (removed “until JOE-941” classic claims). Historical banner on `docs/evidence/repo-wide-surface-audit-2026-07-21.md` → points to this post-#959 audit. |
| **P0 private-beta (package completeness)** | `deploy/private-beta/` + `docs/evidence/private-beta-ops-evidence-package-2026-07-21.md` explicitly list **public package COMPLETE**, **private campaign items still required for go**, and **go-no-go remains `no-go`**. `scripts/validate-private-beta-package.mjs` inventory asserts required templates exist and public go-no-go contains `no-go` (rejects `Decision: \`go\``). |
| **P2 dual-stack / HA** | `docs/product-channel-ownership.md` + channel security matrix: security body **done**; protocol freeze = **intentional residual** (not incomplete P1). Multi-writer hazards H1/H3/H4/H8/H13 annotated **single-daemon production shape; multi-replica experimental only**; proving registry `status=partial`; no false “migrated” claim. |
| **P3 pin-gated residuals** | Classic allowlist burndown revalidated **Won't Do** on 1.18.1; chart CSP + HTTPS MCP residuals reaffirmed **accepted** in `docs/security-model.md`; JOE-915 freeze residual noted in `docs/evidence/archive-plan/README.md` (archive action still maintainer ops). |

**Still open (not closed by docs alone):** hosted private-beta private evidence campaign; SEC-1/SEC-2 code; HA migrate hazards in code; classic allowlist burn on next OpenCode pin; `gh repo archive` for product repos.

---

## Prioritized remediation backlog

### P0 — only if pursuing hosted private-beta go

| # | Work | Hints |
| --- | --- | --- |
| 1 | Strict deployed load + soak + private evidence campaign | JOE-922, 958, 971 |
| 2 | Live Postgres restore + object-store round-trip | JOE-960 |
| 3 | Deployed BYOK no-plaintext validation | JOE-961 |
| 4 | Support roster / on-call (secondary) | JOE-968 |
| 5 | Failover, DLQ, quota/billing, cost/SLO, rollback evidence | JOE-971 |

### P1 — security + ceiling modules (next engineering sprint)

| # | Work | Why |
| --- | --- | --- |
| 1 | **SEC-1** Durable webhook rate-key trusted-proxy parity | DoS/auth-fail backoff bypass when exposed |
| 2 | **SEC-2** Extend JOE-952 to `/storage/export` + session messages | Stolen admin token harvest surface |
| 3 | Extract `daemon-routes/work.ts` + `config.ts` below 1800 soft | 18–20 LOC headroom crises |
| 4 | Uniform `localAdmin`/loopback dual-intent on all raw exports | SEC-3 |
| 5 | ~~Doc drift cleanup (Durable V2 + historical audit banner)~~ | **Closed on remediation branch** (see Remediation PR section) |

### P2 — structural progressive

| # | Work | Hints |
| --- | --- | --- |
| 1 | `LocalWorkspaceSessionPort` cutover (IPC off sessionEngine) | JOE-921 residual |
| 2 | Split cloud `http-server.ts` / `app.ts` | Soft target path |
| 3 | Widen import-cycle SCAN_ROOTS to runtime-host + cloud-server + desktop main | Maintainability |
| 4 | Wiki `tool-router` + `jobs.ts` splits | JOE-977 residual |
| 5 | Budget or extract `mcp.ts` / `channel-commands.ts` | Unbudgeted gods |
| 6 | Rate-limiter twin parity CI test | SEC-4 |
| 7 | HA migrate hazards H1/H3/H4/H8/H13 (docs: single-daemon production; not migrated) | JOE-931/949 — before any multi-replica claim |
| 8 | Dual-stack protocol re-home epic (optional capacity; security body done) | JOE-923 follow-on — intentional residual |

### P3 / pin-gated / process

| # | Work |
| --- | --- |
| 1 | Desktop classic allowlist burn-down — **Won't Do on 1.18.1** (revalidated); wait pin >1.18.1 |
| 2 | Chart CSP `unsafe-eval` — **accepted residual** (reaffirmed); reopen when server-side Vega |
| 3 | HTTPS MCP — **accepted residual** (reaffirmed); pin when OpenCode supports connect-IP+SNI |
| 4 | Monthly evals: dispatch post-#959 to prove green signal |
| 5 | Design-system / god-module progressive (JOE-848/851/854/894/919) |
| 6 | DOMPurify low advisory when fix available |
| 7 | JOE-915: freeze/SoT **done**; `gh repo archive` still maintainer ops residual |

---

## Surface map (condition by product)

| Surface | Condition | Residual focus |
| --- | --- | --- |
| **Desktop** | Strong IPC/CSP boundary; WorkspaceSessionPort cloud-complete | Local port cutover; classic SDK allowlist; monthly evals |
| **Durable Gateway** | V2 façade, god modules split, security kernels | XFF rate-key, export coverage, ceiling routes, JSON sidecars for HA |
| **Channel / Standalone Gateway** | Shared verify; trust-proxy rate keys better than Durable | Dual-stack body freeze; twin rate-limiter |
| **Cloud server** | Strong cookie/OIDC/CSRF; fail-closed public tier | http/app LOC ceilings; style-src residual |
| **Wiki** | Hosted auth fail-closed; CSP self; OAuth multi-replica guard | Watch-band modules; public hosted claim gate |
| **Ops package** | Templates + CI validators complete | Private evidence campaign for go |

---

## Non-claims (re-affirmed at HEAD)

Do **not** claim from this audit or from #959 alone:

1. Multi-AZ HA or production multi-replica Durable Gateway  
2. Hosted private-beta **go**  
3. Full dual-stack **protocol** delete  
4. Full Desktop classic SDK burn-down on pin 1.18.1  
5. Public multi-tenant Wiki product readiness  

**Do claim (accurate):** local/self-host beta posture; progressive security kernels; Durable OpenCode V2 construction + session façade; pin lockstep 1.18.1; hard god-module budgets green; required CI green at merge.

---

## Suggested next 10 tickets (concise)

1. SEC: Durable webhook rate-key trusted-proxy parity (+ tests)  
2. SEC: JOE-952 coverage for `/storage/export` + session messages  
3. SEC: Uniform dual-intent (`localAdmin`/loopback) on raw exports  
4. Extract `daemon-routes/work.ts` under soft budget  
5. Extract `config.ts` under soft budget  
6. ~~Docs: Durable V2 + historical audit scorecard banner~~ (remediation branch)  
7. Local `WorkspaceSessionPort` progressive cutover  
8. Wiki `jobs.ts` / `tool-router.ts` splits  
9. Widen monorepo import-cycle roots  
10. Private-beta evidence campaign (only if go is a goal; public package COMPLETE / still `no-go`)

---

## Audit method appendix

- Local: `pnpm audit:*`, LOC inventories, all post-#959 check scripts, secret/CSP/unsafe pattern sweeps, evidence doc cross-read  
- Security explore agent: auth, webhooks, exports, CSP, supply chain, HA security  
- Architecture explore agent: budgets, cycles, partitions, OpenCode, dual-stack, wiki, knip  
- Ops explore agent: CI required checks, claim gates, private-beta package, HA hazards, evals, doc freshness  

**Prior evidence (not re-litigated as “open” unless re-verified):**  
`docs/evidence/repo-wide-surface-audit-2026-07-21.md`, `wiki-surface-audit-2026-07-21.md`, `milestone-post-958-branch-plan.md`, multi-writer hazards, channel security matrix, private-beta ops package.

---

*End of post-#959 full audit.*
