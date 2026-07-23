# Full deep & wide codebase audit — post-#961 `master`

**Date:** 2026-07-23
**HEAD:** `12320da7` (`fix(post-959): close P0–P3 audit residuals (#961)`)
**Prior audit:** `docs/evidence/post-959-master-full-audit-2026-07-22.md` (as-of #959 / `12e48c9c`)
**Method:** Local quantitative gates + three parallel read-only deep audits (security, architecture, ops/claims). Skeptical re-check of #961 “closed” items against source.

---

## Executive summary

| Domain | Grade (post-#959) | Grade (post-#961) | Delta |
| --- | --- | --- | --- |
| **Security** | B | **B+** | SEC-1/SEC-2 closed in HTTP routes; supply chain fully clean |
| **Architecture** | B− | **B** | `config` + `work` under soft 1500; residual unbudgeted gods |
| **Ops / claims** | B+ | **B+** | Package COMPLETE / `no-go` fail-closed; hazards still honest |
| **Supply chain** | B+ | **A−** | `audit:prod` + `audit:full` → **0** advisories at audit time |
| **CI / quality signal** | A− / B− | **A− / B−** | Required checks solid; monthly evals non-blocking residual |
| **Overall** | B | **B+** | Stronger local/self-host beta posture; go/HA still non-claims |

**Bottom line:** After #961, open-cowork is in **strong condition for `local-self-host-beta`**: green security gates, empty advisory graph, soft-budget wins on the two hottest Durable façades, and fail-closed private-beta package validation. It remains **not** multi-AZ HA, **not** hosted private-beta go, and still carries intentional dual-stack protocol freeze + pin-gated classic-SDK residual.

---

## Merge / prune record

| Step | Result |
| --- | --- |
| PR #961 | Squash-merged with admin (review policy) |
| Merge commit | `12320da7` |
| Remote branch | Deleted (`origin/fix/post-959-p0-p3-remediation`) |
| Local | Clean `master` @ `origin/master` |
| Open noise | Dependabot PR #960 (dompurify 3.4.12) — **superseded by #961 override**; safe to close |

---

## Quantitative snapshot (HEAD)

### Supply chain

| Gate | Result |
| --- | --- |
| `pnpm audit:prod` (moderate+) | **green — 0 advisories** |
| `pnpm audit:full` (high+) | **green — 0 advisories** |
| `pnpm.auditConfig` ignores | **empty** |
| DOMPurify | **3.4.12** via override (closes prior low GHSA) |

### Hard god budgets (all PASS)

| Path | LOC | Hard | Soft 1500 | Notes |
| --- | --- | --- | --- | --- |
| `work-store.ts` | 1956 | 2000 | fail | Domain modularized; façade still heavy |
| `http-server.ts` | 1930 | 1970 | fail | Cloud edge |
| `app.ts` (cloud) | 1855 | 1900 | fail | Composition root |
| `scheduler.ts` | 1791 | 1820 | fail | 29-line headroom |
| `workspace-gateway.ts` | 1690 | 1730 | fail | Desktop hub |
| `daemon-routes/work.ts` | **1495** | 1960 | **pass** | **#961 extract** |
| `config.ts` | **1407** | 1800 | **pass** | **#961 extract** |
| `environments.ts` | 1262 | 1300 | pass | Only soft pass pre-#961 among hard set |

### Unbudgeted / watch

| Path | LOC | Note |
| --- | --- | --- |
| `postgres-control-plane-store.ts` | 1996 | Cloud modularity culture; not monorepo god JSON |
| `mcp.ts` | 1629 | **Unbudgeted** Durable god |
| `channel-commands.ts` | 1426 | Unbudgeted |
| `channel-sync.ts` | 1004 | Unbudgeted; HA migrate H1 surface |
| Wiki `jobs.ts` | 761 | Hard 800; subject extract landed |
| Wiki `tool-router.ts` | 733 | Watch band residual |

### Gates green at audit time

- God-module LOC, Durable OpenCode classic gate, dual-channel security, pin lockstep **1.18.1**
- Import cycles: 0 cycles across app + ui + **shared** (post-#959 widen)
- Distributed-ownership claims OK (`status=partial`)
- Private-beta package validate OK (`Decision: no-go`)

---

## #961 remediation verification (code)

| Item | Status | Evidence |
| --- | --- | --- |
| SEC-1 webhook XFF rate-key | **Closed** | `inboundWebhookRateKey` → `resolveHttpClientAddress` + trusted CIDRs only when non-local HTTP |
| SEC-2 `/storage/export` + session messages | **Closed (HTTP)** | Always/raw guarded via `guardUnredactedExport` + redacted message default |
| SEC-3 `localAdmin` dual-intent | **Closed (HTTP dumps)** | Guard defaults `requireLocalAdmin`; ops security.md updated |
| SEC-4 rate-limiter twin | **Mitigated** | `tests/webhook-rate-limiter-parity.test.ts` + dual-channel gate |
| Soft 1500 on work/config | **Closed** | ~1495 / ~1407 after presentation + schema/normalize extracts |
| P0 package completeness | **Closed (public)** | Validator inventory + no-go fail-closed; private campaign still required for go |
| Doc drift Durable V2 | **Closed** | Boundary + standalone decision + historical banner |
| DOMPurify low | **Closed** | 3.4.12 override; audit graph empty |

### New residual from #961 hardening

| ID | Sev | Finding | Recommendation |
| --- | --- | --- | --- |
| **F1** | P2 | MCP `state_export` still calls `/storage/export` **without** `localAdmin=true` → **403 fail-closed** (secure but tool broken) | Update MCP tool to pass dual-intent or dedicated local-only export surface |
| **F2** | P2 | Incomplete **route-level** integration tests for `/storage/export` + messages dual-intent (unit guard tests exist) | Add daemon-routes integration cases |
| **F3** | P2 | Durable Mission Control HTML (`/dashboard`, `/live`) lacks CSP response headers | Add CSP when non-local HTTP allowed |
| **F4** | P3 | `http-api.md` may lag ops security on storage export dual-intent | Sync API docs |

---

## Security findings (post-#961 residual)

### P0

None found for supported **local/self-host** posture.

### P2–P3 (carry + new)

| ID | Sev | Area | Notes |
| --- | --- | --- | --- |
| F1–F4 | P2/P3 | Export completeness / docs | Above |
| F5 | P2 | Process-local rate/export buckets under multi-replica | Accept for single-daemon; pod-multiplies if experimental HA |
| F6 | P2 | HA migrate H1/H3/H4/H8/H13 | Not a default single-daemon vuln; blocks HA claims |
| F7 | P3 | Chart `unsafe-eval` / cloud style-src residual | Accepted with sandbox |
| F8 | P3 | HTTPS MCP residual | Accepted (OpenCode TLS) |
| F9 | P3 | Dual algorithm twins (rate-limiter / constant-time) | Parity tests reduce drift |
| F10 | P3 | `localAdmin` is query intent, not loopback proof | By design; admin token = power |

### Explicit non-findings

Desktop sandbox + IPC sender checks; cloud CSRF + OIDC path-only returnTo; webhook authenticity (Meta/Discord/Slack/Telegram kernels); wiki hosted auth fail-closed + CSP `style-src 'self'`; empty audit ignore list; empty current advisory graph; E2E fail-closed without `OPEN_COWORK_E2E=1`.

---

## Architecture findings

1. **#961 structural win:** `config.ts` and `daemon-routes/work.ts` under soft 1500 with real headroom (hard maxes now loose — should ratchet).
2. **Still soft-fail:** work-store, scheduler, cloud HTTP/app, desktop workspace-gateway.
3. **Unbudgeted gods:** `mcp.ts`, `channel-commands.ts`, `channel-sync.ts`.
4. **Import cycles:** monorepo SCAN_ROOTS = app + ui + shared only; runtime-host skipped on known cycle (see Hardening PR); cloud / desktop main still unscanned.
5. **`createLocalWorkspaceSessionPort`:** progressive IPC wiring started (`local-workspace-session` + artifact handlers); full IPC cutover still open.
6. **Dual-stack freeze honest**; protocol body still dual.
7. **Root knip ignores products/***; product-local knip now CI-gated on gateway/wiki workflows (Hardening PR).

---

## Ops / claims findings

| Control | Status |
| --- | --- |
| Public tier | `local-self-host-beta` only |
| Private-beta decision | **`no-go`** (validator rejects `go`) |
| Multi-AZ HA | Forbidden + Helm fail-closed + registry `partial` |
| Dual-stack protocol delete | Non-claim; security body done |
| Classic full burn-down | Won't Do on pin 1.18.1 |
| Monthly evals | Non-required; JOE-926 alert path present; cadence residual |
| Required CI | validate, cloud-gates, packages, docs, coverage, CodeQL aligned |

---

## Prioritized backlog (post-#961)

### P0 — only if pursuing hosted private-beta go

Private evidence campaign (load/soak/restore/failover/BYOK/support/cost/rollback) + sign-off; flip public decision only after promotion validators.

### P1 — next engineering

| # | Work | Why |
| --- | --- | --- |
| 1 | Fix MCP `state_export` dual-intent / local export path | Tool broken by intentional fail-closed |
| 2 | Route integration tests for storage export + messages | SEC-2 regression armor |
| 3 | Ratchet hard budgets for `config`/`work` after extract | Prevent re-inflation |
| 4 | Budget + extract `mcp.ts` / `channel-commands.ts` | Unbudgeted gods |
| 5 | Scheduler under soft 1500 | 29-line hard headroom |

### P2 — structural progressive

| # | Work |
| --- | --- |
| 1 | Wire `createLocalWorkspaceSessionPort` into local IPC (progressive cutover) |
| 2 | Work-store façade under soft 1500 |
| 3 | Cloud http-server/app soft path |
| 4 | Widen cycle SCAN_ROOTS (runtime-host, cloud-server, desktop main) |
| 5 | Wiki tool-router peel before hard 800 |
| 6 | HA migrate H1/H3/H4/H8/H13 before multi-replica claims |
| 7 | Durable HTML CSP on exposed dashboard/live |
| 8 | Sync `http-api.md` with dual-intent export rules |

### P3 — pin / process / accepted

| # | Work |
| --- | --- |
| 1 | Desktop classic burn-down — wait OpenCode pin >1.18.1 |
| 2 | Chart CSP / HTTPS MCP reopen conditions |
| 3 | Monthly evals: dispatch prove green post-#961 |
| 4 | Close superseding Dependabot #960 if still open |
| 5 | JOE-915 product-repo archive ops residual |
| 6 | Product knip in CI matrix |

---

## Non-claims (re-affirmed at HEAD)

1. Multi-AZ HA / production multi-replica Durable Gateway
2. Hosted private-beta **go**
3. Full dual-stack **protocol** delete
4. Full Desktop classic SDK burn-down on pin 1.18.1
5. Public multi-tenant Wiki product readiness

**Do claim (accurate):** local/self-host beta; Durable V2 construction + session façade; pin lockstep 1.18.1; JOE-952 dual-intent on sensitive HTTP dumps; trusted-proxy webhook rate keys; soft-budget façades for config + work routes; empty advisory graph at this audit; public private-beta package COMPLETE with decision **no-go**.

---

## Surface map

| Surface | Condition | Residual focus |
| --- | --- | --- |
| Desktop | Strong boundary; local port factory only | IPC cutover; classic allowlist; monthly evals |
| Durable Gateway | V2 façade; export/rate-key hardened; soft work/config | MCP tool dual-intent; mcp/channel gods; HA sidecars |
| Channel stacks | Shared security; freeze honest | Protocol dual-maintenance |
| Cloud | Fail-closed public tier; strong auth | Soft LOC; style residual |
| Wiki | Hosted fail-closed; CSP self | Watch-band modules; public hosted claim gate |
| Ops package | COMPLETE + no-go enforced | Private evidence if go is a goal |

---

## Method appendix

- Local: `pnpm audit:*`, LOC inventories, all check scripts, residual greps
- Security explore (post-#961 remediations + residual hunt)
- Architecture explore (budgets, cycles, ports, dual-stack)
- Ops explore (claims, CI, HA, private-beta, evals)

**Related evidence:** `post-959-master-full-audit-2026-07-22.md`, multi-writer hazards, channel security matrix, private-beta ops package, wiki surface audit.

---

## Hardening PR (progressive structural — branch `fix/post-961-hardening-p0-p3`)

Follow-on hardening against this audit's P2 progressive + P3 pin/process items.
Does **not** invent private-beta go or multi-AZ HA claims.

| Close | Item | Notes |
| --- | --- | --- |
| P2-1 | Wire `createLocalWorkspaceSessionPort` | `apps/desktop/src/main/local-workspace-session.ts` + `artifact-handlers.ts` uses `getLocalSessionPort().getSessionView` (progressive; not full IPC rewrite) |
| P2-4 (attempted) | Widen import-cycle `SCAN_ROOTS` | **Skipped** `packages/runtime-host/src` — known cycle `runtime → runtime-config-builder → custom-agents-utils → runtime-tools → runtime`; documented in `scripts/check-import-cycles.mjs` |
| P2-5 | Wiki `tool-router` peel | Helpers → `tool-router-helpers.ts`; router ~643 LOC (under 650/800) |
| P2-6 (docs + flag) | HA migrate hazards honesty | Hazards inventory + multi-daemon doc reaffirm experimental multi-replica still fails `openMigrateHazards`; readiness `multi_writer_ownership` + doctor line |
| P3-6 | Product knip in CI | `ci-gateway.yml` runs `knip`; `ci-wiki.yml` runs `check:dead-code` |
| P0 package | Private-beta validate | Still green; public decision remains **`no-go`** (no invented go) |
| P3-1/2/4 | Docs reaffirm | Classic Won't Do, chart CSP, HTTPS MCP in `security-model.md`; Dependabot #960 superseded by monorepo override |

**Still open (not this PR):** MCP `state_export` dual-intent (P1), route export integration tests, hard budget ratchets, full HA migrate code, full IPC port cutover, classic burn-down wait on pin >1.18.1.

---

*End of post-#961 full audit.*
