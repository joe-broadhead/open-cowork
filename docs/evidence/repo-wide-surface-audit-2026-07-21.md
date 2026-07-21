# Repo-wide surface audit (medium+)

**Date:** 2026-07-21
**HEAD audited:** `8863765d` (`Merge pull request #957 … codeql-action-4.37.1`)
**Method:** First-principles inventory of every major surface (apps, products, packages, CI, deploy, supply chain), then deep dives on security, dual stacks, reliability, and ops. **Tiny nits excluded.** Only medium-to-big fix items.

**Prior context (not re-litigated as “new” unless still open):**
- `docs/evidence/pr-956-production-grade-audit-2026-07-19.md` (shipped with SEC-2/4/6 notes)
- `docs/evidence/opencode-sdk-duplication-audit-2026-07-18.md`
- `docs/product-channel-ownership.md` (frozen dual-stack policy)

## Residual tracking pointer (JOE-964)

**Do not re-litigate remediations closed in PR #958** against this document as if they were still open on `master`. Use this pointer:

| Source | Role |
| --- | --- |
| **PR #958** (`fix/audit-p0-p2-remediation-2026-07-21` → master) | Closed the primary P0–P2 remediations called out at audit time (quality signal bridge, security residuals that landed in that PR, supply-chain overrides, chart CSP docs, etc.) |
| **Linear milestone** [Post-#958 Production Next Steps (2026-07-21 residual)](https://linear.app/joe-broadhead/project/open-cowork) | Tracks **residuals and progressive epics** after #958 |
| Branch `fix/milestone-post-958-quality-signal` | Multi-commit implementation branch for that milestone (single PR at end) |

### Audit ID → residual issue map (post-#958)

| Audit ID (this doc) | Closed in #958? | Residual / epic (Linear) | Evidence / notes |
| --- | --- | --- | --- |
| P0-1 `audit:full` red | **Yes** (overrides / process) | JOE-957 supply-chain maintenance | Prefer upgrades; monthly re-check |
| P0-2 Nightly / UI evals red | **Partial** (#958 monthly + bridge work continued on milestone) | JOE-918 / JOE-924 / JOE-925 | Product contracts; not “done” by reschedule alone |
| P1-1 Dual channel stacks | **No** (inventory + kernel only later) | JOE-923 (+ JOE-929/934 foundation on milestone) | Full body migrate still progressive |
| P1-2 OpenCode adapters / classic | **Partial** (pin lockstep in #958 era) | JOE-916 | Kernel + classic inventory on milestone; Durable V2 still progressive |
| P1-3 HA multi-writer | **No** (docs/fail-closed) | JOE-931 | Design + claim gates; not multi-AZ HA |
| P1-4 God modules | **Partial** | JOE-919 / JOE-951 / JOE-942 | Budgets + first splits; work-store still large |
| P2-1 private-host metadata | **Yes** (where fixed for MCP/gateway peers) | — | Re-open only if new surface reintroduces allow |
| P2-2 unredacted admin exports | **Partial** | JOE-952 under JOE-920 | Channel length-only vs Durable Gateway residual |
| P2-7 chart CSP | **Partial** | JOE-946 under JOE-920 | Sandbox docs; parent unsafe-eval residual |
| P2-8 Desktop dual workspace bridges | **Partial** (#958 port intro) | **JOE-921** (+ JOE-965/967/970) | Port inventory + full contract on milestone |
| Wiki deep audit | **No** (explicit non-goal of #958) | JOE-917 | Evidence package on milestone |
| Private-beta hosted claims | **No** | JOE-922 | Public package + `no-go` until private ops |

**Explicit non-claims of #958 (still true):** dual-stack **delete**, full Durable Gateway **V2 migration**, multi-AZ **HA**, complete wiki deep audit (later JOE-917), and “product eval bugs fully fixed by monthly schedule alone.”

---

## Executive scorecard

| Domain | Grade | Why |
| --- | --- | --- |
| **Surface map / partitions** | **B+** | Product partitions exist and boundary scripts enforce major bans; residual ghosts and dual stacks remain. |
| **AuthZ / exposure** | **B** | Fail-closed defaults are real; explicit footguns (`unsafeAllowNoAuth`, unredacted admin exports, partial credential diagnostics) need hard ops discipline. |
| **SSRF / host policy** | **B** | Strong MCP + Durable Gateway peer screens; shared “private endpoint” policy still treats `169.254/16` as private (metadata risk). |
| **Supply chain** | **D (today)** | `pnpm audit:full` fails open high/critical advisories with empty ignore list — next green CI is blocked until fixed. |
| **Architecture / DRY** | **C+** | Intentional freezes documented; cost is real (channels ×2, OpenCode adapters ×3, classic vs V2). |
| **Reliability / HA** | **C** | Helm blocks multi-replica; multi-daemon doc admits process-local / sidecar multi-writer unsafety. |
| **CI / quality signals** | **C** | Core PR CI historically green; Nightly Evals red **10+ consecutive days**; product tests path-filtered correctly but easy to forget. |
| **Maintainability** | **C** | God modules (work-store 6.5k, environments 2.5k, cloud app/http ~1.9k) dominate change risk. |

**Overall:** Production-usable with strong local fail-closed habits, **but master is currently one Dependabot/PR away from a hard `audit:full` fail**, Nightly Evals are a dead signal, and the dual channel + dual SDK architecture is the largest structural tax left after the product-partition work.

---

## 1. Surface map (what exists)

Approximate source LOC (TS/JS, excl. `node_modules` / `dist`):

| Surface | LOC (approx) | Role |
| --- | --- | --- |
| `products/gateway` (`cowork-gateway`) | **~110k** | Durable work coordinator: daemon, scheduler, Mission Control, MCP, channels |
| `products/wiki` (`cowork-wiki-workspace` + packages) | **~100k** | Wiki CLI/web/MCP/storage partition |
| `packages/*` | **~207k** | Shared, cloud-server (~55k class), app/ui, channel providers, runtime-host |
| `apps/desktop` | **~32k** | Electron main + packaging |
| `apps/channel-gateway` | **~12k** | Cloud Channel Gateway |
| `apps/standalone-gateway` | **~7k** | Single-process gateway appliance |
| `apps/gateway` | **0 source** | **Ghost** — leftover `dist/` only (rename residue) |
| `mcps/*` | **~3.5k** | Charts, skills, knowledge, workflows, … |
| `scripts/` | **~20k** | CI, release, deploy, audit gates |
| `tests/` (repo root) | 357 test files | Monorepo node/integration tests |

**Channel stacks (frozen dual ownership):**

| Stack | Location | Consumers |
| --- | --- | --- |
| Monorepo providers | `packages/gateway-provider-*` + `gateway-channel` (~9k LOC) | `channel-gateway`, `standalone-gateway` |
| Durable Gateway channels | `products/gateway/src/channels/*` (~1.5k+ provider code + large command/sync surface) | `cowork-gateway` only |

**OpenCode execution stacks:**

| Runtime | SDK entry | Notes |
| --- | --- | --- |
| Desktop + `runtime-host` | `@opencode-ai/sdk/v2` | Primary product path |
| Standalone Gateway | `@opencode-ai/sdk/v2` | Thin adapter `apps/standalone-gateway/src/opencode.ts` |
| Cloud worker | custom adapter (~1.2k LOC) | `packages/cloud-server/src/opencode-runtime-adapter.ts` |
| Durable Gateway | **classic** `@opencode-ai/sdk` root | Pin **1.18.1** aligned; call shape still classic |

---

## 2. Findings (medium → big only)

Severity scale used here:

- **P0 / High** — breaks CI, production security posture, or continuous quality signal now
- **P1 / Medium-High** — structural debt that will produce real bugs or dual-fix misses
- **P2 / Medium** — real but contained; schedule as dedicated work

### P0-1 — `pnpm audit:full` is red on current lockfile (CI gate will fail)

**Evidence:** Running `node scripts/pnpm-audit.mjs --audit-level high` on `8863765d` reports:

| Advisory | Severity | Package | Installed |
| --- | --- | --- | --- |
| GHSA-23HP-3JRH-7FPW | **critical** | `tar` | 7.5.17 |
| GHSA-8X88-C5MF-7J5W | high | `tar` | 7.5.17 |
| GHSA-52CP-R559-CP3M | high | `js-yaml` | 4.2.0 |
| GHSA-3JXR-9VMJ-R5CP | high | `brace-expansion` | 2.1.1 and 1.1.13 |

`package.json#pnpm.auditConfig` ignore lists are **empty**.
`.github/workflows/ci.yml` runs `pnpm audit:full` on every PR/push to master.

Last master CI success was **2026-07-19** (post-#957). Advisories / resolution state have moved since; **the next PR that touches master will hit this gate** unless versions are bumped or explicit, time-boxed ignores + override pins are landed.

**Fix:**
1. Override / bump `tar`, `js-yaml`, and `brace-expansion` (or their parents) to fixed ranges.
2. Prefer real upgrades over ignore list.
3. Only if no fixed release exists: temporary `ignoreGhsas` with expiry comment + monthly-maintenance follow-up.

---

### P0-2 — Nightly Evals failed 10 consecutive runs (dead quality signal)

**Evidence:** `gh run list --workflow=nightly-evals.yml --limit 10` → **all failure**.
Latest (`29809502812`, 2026-07-21):

1. Timeout waiting for `[data-nav-view="admin"]` (admin nav surface missing/renamed).
2. `prompt-stream-approval.eval.test.ts`: **`no app subscriber received the synthetic approval`** (retries also fail).

This is not flake noise — same failure class for **~10 days**. Nightly is intentionally non-blocking for release, so **nobody is forced to notice** that offline approval projection / admin nav contracts regressed.

**Fix:**
1. Treat Nightly red streak as a product bug: restore approval subscriber wiring or update the eval harness to the current event contract.
2. Fix or retire the admin nav selector.
3. Optional ratchet: alert after N consecutive red nightlies (Slack/GitHub issue).

---

### P1-1 — Frozen dual channel stacks (~10k+ LOC ×2 concepts)

**Evidence:** `docs/product-channel-ownership.md` freezes two stacks by design. Concrete providers exist in both:

- Durable: `products/gateway/src/channels/{telegram,whatsapp,discord}.ts` (+ renderer/capabilities)
- Monorepo: `packages/gateway-provider-{telegram,whatsapp,discord,slack,signal,email,webhook,cli}`

Security bugs (signature verify, SSRF on webhook callbacks, rate limits, constant-time compare) must be fixed **twice** or risk silent skew. Ownership matrix helps humans; it does not prevent drift.

**Fix (epic, not drive-by):** Prefer durable Gateway composing `gateway-provider-*` (or a shared protocol kernel in `gateway-channel` / `@open-cowork/shared`). Until then, any channel security change PR template should require dual-stack checklist.

---

### P1-2 — Three OpenCode adapters + classic vs V2 split

**Evidence:**

| Adapter | LOC | API |
| --- | --- | --- |
| `packages/cloud-server/src/opencode-runtime-adapter.ts` | 1216 | Cloud worker |
| `packages/runtime-host/src/runtime.ts` + `opencode-adapter.ts` | ~1280 | Desktop |
| `apps/standalone-gateway/src/opencode.ts` | 601 | Standalone (V2) |
| `products/gateway/src/opencode-client.ts` + session runtime | large | **Classic** client |

Pin is aligned to **1.18.1** (good; closes prior supply-chain skew). Call-shape divergence remains: Durable Gateway still classic `client.session.*`; Desktop/Standalone use V2. Classic residual methods on Desktop are pin-gated (`docs/opencode-classic-sdk-burndown.md`); Durable Gateway classic surface is much larger and is **not** on the same burndown table as Desktop.

**Fix:**
1. Keep pin-lockstep forever (already policy).
2. Epic: Durable Gateway V2 migration when OpenCode exposes working routes (same reopen checklist as JOE-845).
3. Extract shared “spawn + client + event pump” kernel to collapse cloud vs runtime-host duplication (prior SDK-6).

---

### P1-3 — Durable Gateway is single-writer / single-replica by architecture

**Evidence:**

- Helm: `gateway replicaCount > 1 is unsafe while stream/replay state is process-local` (`helm/open-cowork-gateway/templates/deployment.yaml`).
- Product doc: `products/gateway/docs/concepts/multi-daemon-scaling.md` — JSON sidecars (`sessions.json`, `channel-sync.json`, `events.json`), process-local locks, notification in-flight maps are **not** multi-writer safe.
- Process-local maps in live code (`channel-sync` poll state, environment warm pools, usage cache, session stream managers in channel-gateway).

This is correctly fail-closed in Helm for the monorepo chart. Risk is **operator/docs drift** (custom deploy without chart guards) and **future HA marketing** without finishing distributed ownership.

**Fix:** Keep chart fail; expand runbook “never run two full daemons on one state dir”; only enable `experimentalDistributedOwnership` with a proving suite. Do not claim multi-AZ HA for Durable Gateway until sidecars + ownership move to SQLite/Postgres with fencing.

---

### P1-4 — God modules concentrate change and regression risk

| File | LOC | Why it matters |
| --- | --- | --- |
| `products/gateway/src/work-store.ts` | **6523** | Core durable state API surface (~239 exports) |
| `products/gateway/src/environments.ts` | **2524** | Env backends + remote preflight |
| `packages/cloud-server/src/http-server.ts` | **1930** | HTTP edge + SSE |
| `packages/cloud-server/src/app.ts` | **1855** | App composition + runtime routing |
| `products/gateway/src/daemon-routes/work.ts` | **1927** | Work HTTP surface |
| `products/gateway/src/scheduler.ts` | **1800** | Orchestration |
| `products/gateway/src/config.ts` | **1778** | Config schema + env overlay |
| `apps/desktop/src/main/workspace-gateway.ts` | **1672** | Desktop↔gateway bridge |

Module-boundary budgets track **graph edges/cycles**, not **max file LOC**. Partial extraction exists (`work-store/*` ~4k additional), but the façade remains enormous.

**Fix:** Enforce max-lines budgets on owner modules (e.g. 1500 soft / 2000 hard) and continue port-first splits already started for work-store / orchestration-kernel.

---

### P2-1 — Shared private-host policy allows cloud metadata (`169.254.169.254`) — SEC-4 still open

**Evidence:** `packages/shared/src/node/private-host-policy.ts` adds `169.254.0.0/16` to the private set. `assertPrivateHttpEndpoint` therefore **allows** `http://169.254.169.254/…` as a “private” OpenCode base URL.

Contrasts:

- MCP URL policy **rejects** metadata link-local.
- Durable Gateway `opencodePeers` / OpenCode URL policy **rejects** link-local/metadata.
- Standalone (shared policy) **allows** it.

**Fix:** Deny known metadata addresses (at least `169.254.169.254`, GCP/Azure metadata hostnames) inside `assertPrivateHttpEndpoint`, or add `denyCloudMetadata: true` default for OpenCode endpoints. Keep RFC1918 for lab OpenCode if needed.

---

### P2-2 — Partial credential diagnostics + unredacted admin exports — SEC-2 still open

**Evidence:**

- Channel-gateway / gateway diagnostics intentionally return partial credential shapes (`abcd…[redacted]…wxyz`).
- Durable Gateway HTTP API documents `redact=false` / `unredacted=true` on evidence, config, sessions — gated to **admin** (+ `localAdmin=true` for some paths).

Safe only if admin tokens never leave a trusted operator network and diagnostics are never fronted publicly without auth.

**Fix:**
1. Docs runbook: “diagnostics & unredacted exports are high-sensitivity; never expose Gateway admin without mTLS/VPN.”
2. Consider removing partial credential reveal in favor of length/fingerprint only.
3. Rate-limit + audit every unredacted export (already partially audited).

---

### P2-3 — `unsafeAllowNoAuth` remains a production footgun

**Evidence:** `OPENCODE_GATEWAY_UNSAFE_ALLOW_NO_AUTH` / `security.unsafeAllowNoAuth` can admit unauthenticated non-local HTTP. Readiness marks this as **critical fail** when combined with non-local bind — good. Still callable in tests and operator configs.

**Fix:** In public production tier / Helm public profile, **reject process start** (not only readiness fail) when `unsafeAllowNoAuth && allowNonLocalHttp`. Keep for isolated lab only.

---

### P2-4 — Ghost `apps/gateway` (dist-only leftover)

**Evidence:** `apps/gateway/` has **no** `package.json`, only local `dist/` + `node_modules` (gitignored). ADR says rename to `apps/channel-gateway`. Directory still exists in the workspace tree and confuses agents/operators (`apps/*` workspace glob).

**Fix:** Delete the empty tree from developer machines; add a CI check that `apps/gateway` does not reappear without a package.json; update any stale docs/scripts that still say `apps/gateway`.

---

### P2-5 — Root `pnpm test` does not run Durable Gateway unit suite

**Evidence:** Root `package.json` `test` runs packages, mcps, channel-gateway, standalone-gateway, and `scripts/run-node-tests.mjs` — **not** `pnpm --filter cowork-gateway test`.

Durable Gateway is covered by **path-filtered** `.github/workflows/ci-gateway.yml` (paths: `products/gateway/**`, `packages/shared/**`, lockfile, workflow). That is intentional for modular CI, but:

- Local `pnpm test` green ≠ Gateway green.
- Shared-only changes correctly trigger Gateway CI; pure monorepo script changes might not.

**Fix:** Document in CONTRIBUTING/AGENTS: “Gateway tests: `pnpm --filter cowork-gateway test`.” Optionally add a thin root script `test:gateway` and call it from a weekly full-matrix job.

---

### P2-6 — Dual crypto implementations (gateway-channel vs shared) — SEC-1 residual

**Evidence:** `packages/gateway-channel` keeps a local constant-time twin for pack boundary; shared has `constantTimeEquals` / digest. Comment-only parity; no automated twin test.

**Fix:** One property test that both implementations match on a fixed vector set, run in monorepo CI.

---

### P2-7 — Cloud CSP requires `unsafe-eval` for Vega charts

**Evidence:** `packages/cloud-server/src/http-response-writers.ts` documents `script-src 'self' 'unsafe-eval'` for Vega compile-to-function. Style also allows `'unsafe-inline'`.

Accepted tradeoff for chart UX; still expands XSS blast radius if any script injection path appears.

**Fix:** Prefer sandboxed chart iframe (Desktop already sandboxes chart frames) for cloud SPA long-term; or compile charts server-side.

---

### P2-8 — Desktop dual workspace bridges

**Evidence:** `workspace-gateway.ts` (1672) + `cloud-workspace-adapter.ts` (948) — two large paths for local vs cloud composition. Easy to fix a bug in one and miss the other (session projection, pairing, artifact access).

**Fix:** Shared “workspace session port” interface; adapters only translate transport.

---

## 3. What is *not* a medium+ finding (intentionally)

These look scary but are **controlled** or **already mitigated**:

| Item | Why not escalated |
| --- | --- |
| Classic SDK residual methods on Desktop | Pin-gated allowlist + burndown doc; cannot fake V2 on 1.18.1 |
| Dual channel freeze policy | Documented ownership; debt is P1 architecture, not silent ignorance |
| Electron `nodeIntegration: false`, `sandbox: true`, `contextIsolation: true` | Correct defaults observed |
| Cloud session access via `getSession(tenantId, userId, …)` | Tenant-scoped; `findSession` used for internal runtime event routing with worker append under session tenant |
| Product partition boundary script | Covers desktop↔products, channel↔products, wiki bans |
| Helm replicaCount fail for Gateway | Correct fail-closed for process-local state |
| CodeQL init/analyze co-pin | Fixed in #957 |

---

## 4. Priority backlog (recommended order)

| # | ID | Severity | Effort | Action |
| --- | --- | --- | --- | --- |
| 1 | **P0-1** | High | S–M | Unblock `audit:full` (tar / js-yaml / brace-expansion) |
| 2 | **P0-2** | High | M | Repair Nightly Evals (approval subscriber + admin nav) |
| 3 | **P2-1** | Medium | S | Deny cloud metadata in shared private-host policy for OpenCode URLs |
| 4 | **P2-3** | Medium | S | Fail-closed start when `unsafeAllowNoAuth` + non-local |
| 5 | **P2-4** | Medium | XS | Remove ghost `apps/gateway` residue + guard |
| 6 | **P2-6** | Medium | XS | Crypto twin property test |
| 7 | **P1-4** | Med-High | L | LOC budgets + continue work-store / environments splits |
| 8 | **P1-1** | Med-High | XL | Channel stack unification epic |
| 9 | **P1-2** | Med-High | XL | OpenCode adapter kernel + Durable Gateway V2 when routes exist |
| 10 | **P1-3** | Med-High | L | Only with real distributed ownership design |
| 11 | **P2-2/5/7/8** | Medium | S–L | Ops docs, test scripts, CSP, desktop port extraction |

---

## 5. Suggested first PR (smallest high leverage)

**Title:** `fix: unblock audit:full + deny OpenCode metadata hosts`

1. Bump/override vulnerable `tar` / `js-yaml` / `brace-expansion` until `pnpm audit:full` is green.
2. Deny `169.254.169.254` (and documented metadata hosts) in `assertPrivateHttpEndpoint` or OpenCode-specific wrapper; add unit tests.
3. Optional drive-by: delete empty `apps/gateway` if present in tree; add CI assert.

Do **not** mix channel unification or work-store splits into that PR.

---

## 6. Method notes / limits

- Static + repo evidence + GitHub Actions history; no live production traffic analysis.
- Did not re-run full monorepo test suite (hours); relied on recent master green (2026-07-19) + current audit/evals signals.
- Wiki partition (~100k LOC) was mapped and auth entrypoints sampled; a dedicated wiki-only deep audit is still warranted before public hosted claims.
- Did not re-open closed Dependabot PRs; new advisories may require fresh upgrades.

---

## 7. Bottom line

The monorepo’s **product partitions and security primitives (post-#956) are in good shape for a private/beta product**. The medium+ problems that still need fixing are:

1. **Supply-chain gate is currently red** — treat as fire.
2. **Nightly Evals are a multi-day red streak** — treat as fire for signal integrity.
3. **Dual channel + dual OpenCode adapter architecture** — largest structural cost; only solvable as epics.
4. **God modules and single-writer Gateway** — correct for local beta, wrong if HA/multi-tenant marketing races ahead of implementation.
5. **Residual security threat-model items (metadata host, partial secrets, unsafeAllowNoAuth)** — small code changes, high clarity.

Ship fixes in that order.
