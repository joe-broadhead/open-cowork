# Wiki partition surface audit (medium+)

**Date:** 2026-07-21  
**Linear epic:** JOE-917  
**Run issue:** JOE-956  
**HEAD audited:** `8b903d45857e714f5103f22f2ff3b34ff6100196` (`fix/milestone-post-958-quality-signal`)  
**Scope:** `products/wiki` (~100k LOC partition: CLI, HTTP/web, MCP, workflows, policy, postgres-runtime, storage, static-export, deploy, evals)  
**Method:** First-principles inventory of auth, storage, MCP, web/CSRF, multi-tenant/policy, SSRF, secrets, queue/leases, deploy defaults, and CI gates. Sampled implementation against `products/wiki/docs/security/threat-model.md` and monorepo residual note that wiki was only surface-mapped in the 2026-07-21 repo-wide audit. **Tiny nits excluded.**

**Related prior evidence (not re-litigated unless still open in monorepo):**

- `docs/evidence/repo-wide-surface-audit-2026-07-21.md` §6 wiki mapping residual
- `products/wiki/docs/security/threat-model.md` (public-preview baseline)
- `products/wiki/docs/deployment/auth-boundaries.md`, `hosted-human-agent.md`, Helm enterprise gates

---

## Executive scorecard

| Domain | Grade | Why |
| --- | --- | --- |
| **AuthZ / identity** | **B** | Fail-closed hosted auth when Postgres/public origin/runtime mode require it; trusted headers need ≥16-char secret; process-wide `--role` / `OPENWIKI_ROLE` is a multi-tenant footgun on non-loopback. |
| **SSRF / source fetch** | **A-** | DNS pinning, private/metadata blocks (incl. decimal/hex/IPv4-mapped), no redirects, byte/time budgets; security suite exercises the matrix. |
| **Browser CSRF / CORS** | **A-** | Same-origin Origin checks, Fetch Metadata for JSON writes, CORS does not default to `*`; CSP allows `style-src 'unsafe-inline'` only. |
| **MCP (stdio + HTTP)** | **B+** | Tool modes + policy bounds; HTTP rate limits; hosted readiness proves cross-replica sessions when operational state is Postgres. Memory ops state is single-replica only. |
| **Secrets / tokens** | **A-** | SA tokens hashed; CLI rejects `--token` argv; Git remote URL blocks inline credentials; run inputs strip secret headers. |
| **Static export / visibility** | **B+** | Public filter chains sources/claims/facts/paths; path constraints on outDir. |
| **Deploy / Helm** | **B-** | Strong `enterprise.enabled` fail-closed bundle; **web `replicaCount > 1` without shared operational state was not fail-closed** (fixed in this audit remediation). Default image host `0.0.0.0` is correct for containers only with network discipline. |
| **Durability / multi-writer** | **B** | Postgres queue + write coordinator required for hosted modes; local queue fails closed in hosted runtime mode. |
| **CI / quality** | **B** | Path-filtered `ci-wiki.yml` runs typecheck + full package test + pack smoke; hosted readiness evidence is manual/scripted. |
| **Maintainability** | **B** | Hard LOC 800 with many production modules in 500–799 “watch” band (oauth, tool-router, workflows). |

**Overall:** OpenWiki is **production-capable for careful hosted enterprise profiles** (compose + Helm enterprise + threat model), but **public hosted product claims remain blocked** until P0/P1 findings from this audit are Done or Won’t Do under JOE-959. No critical unauthenticated RCE/SSRF holes found in the sampled paths; residual risk is **operator misconfiguration** and **multi-replica / process-wide role** footguns.

---

## Surface map

| Surface | Location | Notes |
| --- | --- | --- |
| HTTP API + server HTML | `packages/http-api` | Auth, OAuth, MCP HTTP, rate limits, browser CSRF, health |
| Policy kernel | `packages/policy` | Scopes, roles, path/section bounds, SA resolution |
| MCP server | `packages/mcp-server` | Tool modes read/proposal/write; job run allowlist |
| Workflows | `packages/workflows` | Source fetch, inbox, proposals, write coordinator, backups |
| Storage | `packages/storage` | Local + S3/MinIO; unknown backends fail closed |
| Jobs / queue | `packages/jobs` | `local` \| `postgres` only |
| Postgres runtime | `packages/postgres-runtime` | Derived index, queue, operational state, leases |
| Static export | `packages/static-export` | Public filter + publish transaction |
| Web assets | `packages/web` | Markdown escaping; client graph |
| CLI | `packages/cli` | serve/mcp/doctor/deploy preflight |
| Deploy | `deploy/{compose,helm,k8s,terraform,docker,proxy}` | Enterprise gates strongest in Helm |
| Security tests | `tests/security-boundaries.test.ts`, `job-run-security.test.ts`, MCP auth suites | Focused `pnpm test:security` gate |

---

## Findings (medium → big)

Severity:

- **P0** — exploitable default or CI/production security break *now*
- **P1** — real hosted misconfig / multi-tenant hazard; block public hosted claims
- **P2** — real but contained; schedule progressive work

### P1-1 — Process-wide `serve --role` / `OPENWIKI_ROLE` elevates every request (and merges into identity-less principals)

**Evidence:**

- Docker entrypoint: if `OPENWIKI_ROLE` is set, serves with `--role "$ROLE"` (`deploy/docker/entrypoint.sh`).
- `serveCommand` puts `role` / `scopes` into `defaultPolicy` for **all** requests (`packages/cli/src/commands/ops.ts`).
- `mergeHttpPolicy` applies default role/scopes before request policy (`packages/http-api/src/auth.ts`). A trusted-header request that supplies only `x-openwiki-actor` (no role/scopes) **inherits process-wide admin/maintainer**.
- Default container bind is `0.0.0.0` (`OPENWIKI_HOST` / Helm `openwiki.host`).

Local loopback + no process-wide role is safe. Multi-tenant hosted with `OPENWIKI_ROLE=admin` is not.

**Fix:** Refuse process-wide role/scope elevation unless bind host is loopback. Document that hosted identity must come from trusted headers or tokens per request. (Remediated in this PR.)

### P1-2 — Helm allows `replicaCount > 1` without shared operational state

**Evidence:**

- `enterprise.enabled` requires `operationalStateBackend=postgres`.
- Outside enterprise mode, `replicaCount` can be raised while `operationalStateBackend` stays empty → in-memory MCP sessions / rate-limit windows diverge across pods (docs already warn; chart did not fail).
- Worker multi-replica already fails on RWO PVC; **web** multi-replica lacked the analogous operational-state gate.

**Fix:** Helm `fail` when `replicaCount > 1` and `operationalStateBackend != postgres`. (Remediated in this PR.)

### P1-3 — `OPENWIKI_REQUIRE_AUTH=false` can disable auth even with `OPENWIKI_PUBLIC_ORIGIN` or hosted Postgres backends

**Evidence:** `httpRequiresAuthentication` honors explicit env first (`packages/http-api/src/auth.ts`). An operator can set `OPENWIKI_REQUIRE_AUTH=false` alongside `OPENWIKI_PUBLIC_ORIGIN` or Postgres queue/read backends and get unauthenticated HTTP/MCP on a public origin—contradicting threat model (“public unauthenticated content should use static export”).

**Fix:** Refuse start when auth is explicitly disabled while public origin or hosted Postgres backends are configured. (Remediated in this PR.)

### P1-4 — Public hosted Wiki claims remain process-gated (not a code bug)

**Evidence:** Repo-wide audit left wiki deep audit as residual; README/public preview language still exists; monorepo must not claim multi-tenant public hosted Wiki until JOE-959 closes.

**Fix:** Keep marketing/docs claim gate on JOE-917/JOE-959; no “production multi-tenant hosted Wiki” language without epic Done.

### P2-1 — Large production modules in 500–799 LOC watch band

**Evidence:** Module hard limit 800 is green; many hot files sit just under (e.g. `mcp-server/tool-router.ts` ~733, `http-api/oauth.ts` ~710, `workflows/{backup,dream-cycle,memory}.ts`, `postgres-runtime/{jobs,queries}.ts`). Same class of change-risk as gateway god modules, smaller scale.

**Fix (JOE-977 progressive, 2026-07-22):** Extracted `http-api/oauth.ts` helpers and
token grant routes into `oauth-helpers.ts` + `oauth-token-routes.ts` (façade now
~322 LOC). Extracted graph client controls from `web/src/client/graph/index.js`
into `graph/controls.js` after CSP work pushed it over 800. Remaining watch-band
files (tool-router, postgres jobs/queries, workflows) still progressive when the
next local seam appears.

### P2-2 — `scope-token` auth method grants scopes from a raw bearer string

**Evidence:** `resolveHttpPolicy` treats `parseScopes(token)` as `authMethod: "scope-token"` without a registered service account. Hosted `requireAuthenticatedHttpPolicy` still demands actor/principals, so this does not satisfy hosted auth alone—but it is a sharp edge for local/defaultPolicy token misuse.

**Fix (JOE-972, 2026-07-22):** Scope-tokens are **loopback-only** by default
(`scopeTokenAuthAllowed` / `remoteAddress` on `resolveHttpPolicy`). Non-loopback
clients get no elevation from pure scope-list bearers. Override only via
`OPENWIKI_ALLOW_SCOPE_TOKEN=1`. Documented in `docs/deployment/auth-boundaries.md`.

### P2-3 — Hosted readiness evidence is not a monorepo PR CI gate

**Evidence:** `scripts/openwiki-hosted-readiness-evidence.mjs` proves dual HTTP replicas, MCP session stickiness, shared rate limits, write-coordinator contention—but is operator/release scripted, not required on every wiki PR.

**Fix (JOE-975, 2026-07-22):** PR `CI Wiki` keeps only the dry-run unit contract
(`hosted-readiness-evidence.test.ts`). `Release Wiki` runs
`pnpm evidence:hosted-readiness -- --dry-run`. Live `--enforce` stays
operator/release when Postgres is available—not every monorepo PR. Documented in
`docs/deployment/performance.md` and workflow comments.

### P2-4 — CSP `style-src 'self' 'unsafe-inline'`

**Evidence:** `packages/http-api/src/request.ts` security headers. Markdown/HTML paths escape; residual defense-in-depth gap if an HTML injection lands later.

**Fix (JOE-980, 2026-07-22):** Dropped `style-src 'unsafe-inline'`. Graph height uses
`data-graph-height` + CSS presets/CSSOM; legend chip colors use `data-chip-color`
+ CSSOM. No remaining server-rendered `style=` attributes on the HTML UI path.

### P2-5 — File-backed OAuth state is single-node

**Evidence:** Docs (`auth-boundaries.md`) already: file OAuth state is not multi-replica safe. Enterprise path uses Postgres operational state for MCP/rate limits; OAuth state backend selection must stay explicit for multi-replica OAuth.

**Fix (JOE-979, 2026-07-22):** Runtime `oauthFileStateUnsafeReason` fails closed
for hosted mode, shared operational Postgres, or `OPENWIKI_WEB_REPLICAS` /
`WEB_REPLICAS` > 1 with non-loopback issuers. Doctor/preflight `oauth-state`
check; Helm multi-replica + OAuth requires Postgres OAuth/ops state and rejects
explicit file OAuth state.

---

## Controlled risks / non-findings

| Area | Status |
| --- | --- |
| SSRF source fetch | Strong: blocked hosts, DNS pin all answers, no redirects, credentials forbidden in URL |
| Trusted header spoofing | Secret required (≥16 chars), timing-safe compare |
| Browser write CSRF | Origin + Fetch Metadata |
| Webhook authenticity | GitHub HMAC / GitLab token |
| SA token persistence | Hashes only; CLI blocks argv tokens |
| Git option injection | Revision validation + `execFile` arrays |
| Static export path escape | Child-of-workspace + symlink guards |
| Unknown queue/storage backends | Fail closed (not silent no-op) |
| Compose defaults | Bind `127.0.0.1:3030`, Postgres backends force auth, no default CORS `*` |
| Helm enterprise bundle | Digest pin, requireAuth, trusted headers secret, Postgres backends, workers, egress NP |

---

## Linear issue matrix

| Audit ID | Linear | Priority | Status |
| --- | --- | --- | --- |
| P1-1 | JOE-976 | High | Done (this PR) |
| P1-2 | JOE-973 | High | Done (this PR) |
| P1-3 | JOE-974 | High | Done (this PR) |
| P1-4 | JOE-978 | High | In Progress (claim gate until JOE-959) |
| P2-1 | JOE-977 | Medium | Progressive (oauth split done; more seams residual) |
| P2-2 | JOE-972 | Low | Done (loopback-only scope-tokens) |
| P2-3 | JOE-975 | Low | Done (dry-run PR + release gate; enforce operator) |
| P2-4 | JOE-980 | Low | Done (CSP style-src self only; no unsafe-inline) |
| P2-5 | JOE-979 | Low | Done (doctor + runtime + Helm multi-replica OAuth) |

## Remediation status (this PR)

| ID | Finding | Status |
| --- | --- | --- |
| P1-1 | Process-wide role on non-loopback | **Fixed** — `validateProcessWideDefaultPolicy` + entrypoint discipline |
| P1-2 | Helm web multi-replica without shared ops state | **Fixed** — Helm fail |
| P1-3 | Explicit auth disable with public/hosted backends | **Fixed** — `validateHostedAuthConfiguration` at serve start |
| P1-4 | Public hosted claim gate | **Process** — JOE-978 / JOE-959 open until epic AC |
| P2-* | Progressive | Filed under JOE-917 |

---

## Recommended fix order

1. Land this PR’s fail-closed serve/Helm guards (P1-1..P1-3).  
2. Close JOE-959 after any additional P1s from review.  
3. Schedule P2 module splits + scope-token hardening + optional hosted-readiness CI.  
4. Only then allow public multi-tenant hosted Wiki claims.

---

## Claim gate

**Do not claim:** multi-tenant public hosted OpenWiki / Open Cowork Wiki as production-complete  
**Until:** JOE-917 epic AC met (audit evidence + all P0/P1 Done or Won’t Do).

Local personal wiki, loopback serve, static export, and Helm **enterprise** profile (when values fully set) remain the supported production-like shapes described in product docs.
