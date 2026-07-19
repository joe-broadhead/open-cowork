# Production-grade audit: PR #956

**Date:** 2026-07-19  
**PR:** https://github.com/joe-broadhead/open-cowork/pull/956  
**HEAD audited:** `a0591630` (`fix/opencode-sdk-duplication-audit`)  
**Base:** `master` (post product partitions)  
**Method:** First-principles review of the full PR surface (diff + call sites + CI packaging + adversarial probes). Wide (all themes) and deep (security-critical paths exercised).

**CI at audit time:** all required checks **green** (validate, coverage, cloud-gates, packages ×3, CodeQL, gateway, docs).

---

## Executive scorecard

| Domain | Grade | Verdict |
| --- | --- | --- |
| **Supply-chain / OpenCode pin** | **A** | Durable Gateway pinned to **1.18.1** exact; boundary tests + docs extended |
| **Secret redaction DRY** | **A−** | Shared primitives real; products correctly *layer* for contracts — residual forks remain by design |
| **Crypto (constant-time)** | **A** | Digest path for gateway bearer/HMAC; empty-input fail-closed; gateway-channel local twin documented |
| **Network / SSRF policy** | **B+** | Strong private-endpoint assert (scheme, creds, wildcards); link-local/`169.254` allow needs explicit threat notes |
| **Timeouts / cancellation** | **B+** | Shared `fetchWithTimeout`/`withDeadline` solid; one local `openCodeFetch` timeout still duplicated |
| **Packaging / release** | **A** | Frozen lockfile, shared prebuild, standalone pack vendors workspace shared |
| **Boundaries / modularity** | **A−** | Dual channel freeze documented; module-size budget enforced (config extract) |
| **Test / CI hygiene** | **A** | Shared unit tests, boundary tests, product suites, lint secret-scan aware fixtures |
| **Production readiness (this PR scope)** | **A− / ship-with-notes** | Safe to merge after review; residuals are documented follow-ups, not silent landmines |

**Overall:** **World-class for the stated audit goals** (pin alignment + security primitive DRY + dual-stack freeze + pack/CI). Not “zero residual debt” — residual debt is **named, scoped, and non-blocking**.

---

## 1. Scope of the PR (what was actually changed)

| Bucket | Files / surface |
| --- | --- |
| Shared kernels | `secret-redaction.ts`, `constant-time.ts` (+ digest), `private-host-policy.ts`, `fetch-with-timeout.ts` |
| Consumers | products/gateway security/deadlines/assets; standalone redaction/network/server; channel-gateway `config-redaction.ts`; gateway-channel crypto comment; whatsapp digest |
| OpenCode | pin `1.18.1`, boundary roots, docs |
| Packaging/CI | pnpm-lock, ci-gateway/release-gateway shared build, pack-standalone, standalone-smoke, validate-standalone gate, THIRD_PARTY_NOTICES |
| Policy | `product-channel-ownership.md`, original duplication audit evidence |
| MCP | dependency-free `textResult` only |

~36 files, +1176 / −360 lines.

---

## 2. First principles: what “production grade” means here

1. **Fail closed** on auth, host policy, empty secrets.  
2. **No secret exfil** via logs/diagnostics/exports beyond intentional, access-controlled partial ops views.  
3. **No supply-chain skew** across products that speak the same OpenCode protocol.  
4. **DRY without false abstraction** — product contracts may differ; shared covers token families + crypto + host policy.  
5. **Releaseable** — monorepo CI and standalone pack both work.  
6. **Ratchets** — boundary tests prevent silent regression.  
7. **Honest residuals** — dual channel stack and classic session APIs are freezes, not “done” migrations.

---

## 3. Security audit (deep)

### 3.1 Authentication crypto

| Control | Implementation | Assessment |
| --- | --- | --- |
| Empty secret never authenticates | `if (!left \|\| !right) return false` | **Pass** |
| Timing-safe compare | `crypto.timingSafeEqual` | **Pass** |
| Length oracle on raw compare | Short-circuit on length | **Accepted** for non-secret lengths; docs push **digest** for bearer tokens |
| Bearer / WhatsApp verify | `constantTimeEqualsDigest` (SHA-256 then TSE) | **Pass** — length-independent compare |
| gateway-channel local twin | Same algorithm as shared `constantTimeEquals` | **Pass** for pack boundary; **drift risk** if one is updated without the other (comment only, no CI twin test) |

**Finding SEC-1 (Low):** No automated “algorithm parity” test between `packages/gateway-channel/src/crypto.ts` and shared `constantTimeEquals`. Comment documents intent; a 5-line property test would make parity permanent.

### 3.2 Secret redaction

| Surface | Pattern | Assessment |
| --- | --- | --- |
| Shared `redactSecretText` | `sanitizeForExport` + max length | **Strong** on known token families (sk-ant, JWT, ghp, oc*, etc.) |
| Shared alone on `token=short` | Not redacted (keyed rule needs long values) | **Gap** if used without product layer |
| Shared alone on `postgres://u:pass@` | Password **not** redacted | **Gap** if used without product layer |
| Standalone | Product patterns **then** shared | **Pass** for contracts |
| products/gateway | Product markers + bearer placeholder + shared | **Pass** for contracts |
| channel-gateway diagnostics | URL placeholders + product markers + shared + path normalize | **Pass** after hardening |
| channel-gateway **config** credentials | Partial reveal `abcd...[redacted]...wxyz` | **Intentional ops UX**; residual **info leak** if diagnostics leave admin trust boundary |

**Finding SEC-2 (Medium, pre-existing / accepted):** Admin diagnostics that return partial credential material are only safe if diagnostics are **strictly admin-authenticated and non-public**. Tests prove the format; ops docs should state “never expose diagnostics on untrusted networks.” Not introduced by shared layering, but still a production surface.

**Finding SEC-3 (Low):** Shared redaction is **not** a complete standalone product redactor. Consumers **must** layer product patterns (URL userinfo, short `token=`, product markers). This PR does that correctly for wired gateways; new call sites must not call shared alone for internet-facing logs.

### 3.3 Host policy / SSRF

Shared `assertPrivateHttpEndpoint`:

- Rejects non-http(s), embedded credentials, wildcard bind (when configured).  
- Allows RFC1918, loopback, CGNAT 100.64/10, **link-local 169.254/16**, ULA, fe80::/10.  
- Optional private DNS suffixes only when `allowPrivateDns: true`.

**Probes (executed in audit):**

| Input | Result |
| --- | --- |
| `http://user:pass@127.0.0.1` | Deny (credentials) |
| `http://0.0.0.0:1` | Deny (wildcard) when `allowWildcardBind: false` |
| `8.8.8.8` | Not private |
| `169.254.169.254` | **Treated as private** |
| `host.docker.internal` | Private (hardcoded) |
| `opencode.internal` without flag | Not private |

**Finding SEC-4 (Medium — threat model):** Link-local includes **cloud instance metadata** (`169.254.169.254`). For **OpenCode base URL** configuration this means a misconfigured operator can point the gateway at the metadata service if the host policy is the only guard. Mitigations in practice:

- products/gateway uses a **stricter** local host set (`127.0.0.1` / `localhost` / `::1`) + **explicit trusted peer list** for non-local OpenCode — better.  
- standalone uses shared private policy for OpenCode endpoint — **link-local is allowed**.

**Recommendation (follow-up, not merge-blocker):** Optionally deny `169.254.169.254` / known metadata IPs in `assertPrivateHttpEndpoint`, or document “private OpenCode must not be the metadata endpoint” in standalone deploy docs. DNS rebinding on `.internal` names is accepted for lab/k8s; production should prefer IPs or pinned service discovery.

**Finding SEC-5 (Info):** `0.0.0.0` / `::` are “private host” for bind-style checks but denied as OpenCode **endpoint** hosts via `allowWildcardBind: false`. Correct split.

### 3.4 Timeouts and cancellation

| Helper | Behavior | Assessment |
| --- | --- | --- |
| `fetchWithTimeout` | AbortController + upstream signal fan-in + clearTimeout | **Pass** |
| `withDeadline` | Promise.race + clearTimeout; timer **ref’d** | **Pass** for process lifetime |
| `withDeadline` cancellation | Does **not** cancel the underlying promise’s work | **Inherent** race limitation — callers must not rely on it for hard resource release |
| products/gateway `openCodeFetch` | **Still local** AbortController timeout | **Finding SEC-6 (Low/Med DRY)** — security equivalent, maintenance drift risk |

### 3.5 AuthZ / surface exposure (PR-touched)

- Standalone admin digest compare uses shared digest — good.  
- No new public unauthenticated endpoints introduced.  
- channel-gateway redaction only changes diagnostic **content**, not auth gates.

---

## 4. OpenCode modularity audit

| Check | Status |
| --- | --- |
| Pin products/gateway `@opencode-ai/sdk` **1.18.1** exact | **Pass** (was `^1.17.18`) |
| Boundary `sourceRoots` includes `products/gateway/src` | **Pass** |
| Authority packages list includes products/gateway | **Pass** |
| Classic residual allowlist pin-gated JOE-845 | **Pass** (pre-existing ratchet) |
| Full V2 session call-shape rewrite | **Out of scope / correct freeze** on 1.18.1 |

**Finding SDK-1 (Accepted residual):** Durable Gateway still uses **classic** `createOpencodeClient` + extensive `client.session.*`. Pin alignment removes supply-chain skew; API shape migration remains a follow-up. Documented in `opencode-sdk-v2-boundary.md` and PR body.

**Finding SDK-2 (Info):** Many gateway files import SDK types/call session APIs beyond the “allowlisted residual” **file list** used for classic **method** counts. Boundary root scan still applies to `products/gateway/src` for **import path** rules — verify classic **method** allowlist is not under-counting files outside the JOE-845 table. Current CI green implies allowlist still matches measured classic method usage.

---

## 5. Duplication / architecture

### 5.1 Dual channel stacks

`docs/product-channel-ownership.md` freezes ownership:

| Stack | Owner |
| --- | --- |
| monorepo `gateway-provider-*` | channel-gateway + standalone |
| `products/gateway/src/channels/*` | cowork-gateway only |

**Assessment:** Production-correct **policy** for a large migration deferred. Not a silent dual-fix trap if the freeze is followed.

### 5.2 Redaction still multi-shaped by product

| Product | Marker style |
| --- | --- |
| Shared export | `[REDACTED_TOKEN]`, `/Users/[REDACTED_HOME]` |
| products/gateway | `Bearer <redacted>`, `<redacted:N chars>` |
| standalone | `Bearer [redacted]`, record `[redacted]` |
| channel-gateway | partial reveal for secrets; path `/Users/[redacted]` |

**Assessment:** Intentional **contract preservation**. Shared owns **token family coverage**; products own **stable markers**. This is the right production pattern after CI forced placeholder/URL protect layers.

### 5.3 MCP bootstrap

`textResult` only, dependency-free — correct for esbuild inline + per-package typecheck. **Pass.**

---

## 6. Packaging & release

| Gate | Assessment |
| --- | --- |
| `pnpm-lock` sync after gateway-channel dep drop | **Pass** |
| CI Gateway builds shared first | **Pass** |
| `pack-standalone.mjs` vendors `@open-cowork/shared` dist + rewrites `file:` | **Pass** (smoke green) |
| Public deps (`@opencode-ai/sdk`, zod, MCP SDK) still from registry | **Pass** |
| prepack/prepare stripped from staged package | **Pass** |
| Static validator reads shared host-policy phrases | **Pass** |

**Finding PKG-1 (Low):** Vendor pack copies **only** `@open-cowork/shared`. Future workspace runtime deps need the same treatment or pack will break again. Comment/script structure makes extension obvious.

**Finding PKG-2 (Info):** Vendored shared is `0.0.0` private — correct for private monorepo product; not for public npm publish of cowork-gateway as a third-party dependency of other orgs without a publish plan.

---

## 7. Testing & CI

| Layer | Coverage |
| --- | --- |
| Shared unit | token redact, record redact, constant-time, host policy smoke, withDeadline, fetch export |
| Boundary | products/gateway roots + pin authority |
| products/gateway | full vitest suite (was 1333) |
| standalone | 82 tests including network + redaction contracts |
| channel-gateway | 110 tests including diagnostics redaction |
| CI matrix | validate, coverage, cloud-gates, 3 OS packages, CodeQL, gateway product job |

**Finding TEST-1 (Low):** Shared host-policy tests do **not** cover:

- credential embedding deny  
- wildcard bind deny  
- `169.254.169.254` explicit stance  
- private DNS flag  

Adding these would lock the threat model in CI.

**Finding TEST-2 (Low):** No integration test that standalone pack tarball installs **and** imports `@open-cowork/shared/node` at runtime beyond `--version`/doctor smoke (smoke is still valuable).

---

## 8. Operational / reliability

| Topic | Notes |
| --- | --- |
| Deadlines | Shared re-export from products/gateway `deadlines.ts` — good composition |
| Logger redaction | Gateway continues configuredSecrets loop after shared — defense in depth |
| Atomic write / JSONC | products/gateway uses shared node helpers — reduces local FS footguns |
| Error messages | Standalone maps public-host errors to product wording — ops-stable |

---

## 9. Adversarial / abuse cases considered

| Scenario | Outcome |
| --- | --- |
| Empty admin token vs empty provided | Fail closed |
| Bearer token length timing | Digest path on critical compares |
| OpenCode URL with `user:pass@` | Denied (standalone + products) |
| OpenCode URL `https://evil.com` | Denied (standalone private; products unless trusted peer) |
| OpenCode URL `http://169.254.169.254/` | **Allowed by shared private policy** — see SEC-4 |
| Diagnostic log with sk-ant / JWT | Scrubbed via shared families |
| Diagnostic URL `?token=secret` | Product URL redaction preserved under placeholders |
| Partial credential in admin diagnostics | Still partially visible by design (SEC-2) |
| Classic SDK method sprawl | Ratcheted by JOE-845 counts |
| Frozen lockfile | Enforced; was a real CI fail mode and is fixed |

---

## 10. What is **not** in this PR (and must not be confused with “incomplete security”)

1. Full durable-gateway **V2 session field** migration.  
2. Migrating `products/gateway/channels` onto `gateway-provider-*`.  
3. Unifying all redaction **marker strings** monorepo-wide.  
4. Removing classic SDK residual methods (OpenCode platform gap).  
5. Desktop composition shell residual SDK seams (JOE-842).

These are **program residuals**, not regressions introduced by #956.

---

## 11. Merge recommendation

| Question | Answer |
| --- | --- |
| Is CI green? | **Yes** |
| Are P0 security defects open in PR scope? | **No** |
| Are Medium findings merge-blocking? | **No** — SEC-2/SEC-4 are threat-model notes + pre-existing ops shapes |
| Ready for production merge after human review? | **Yes** |
| Required reviews | **1** (branch protection) |

**Ship decision:** **Approve and merge** when review is complete. Track SEC-1, SEC-4 (metadata IP), SEC-6 (`openCodeFetch` → shared fetch), TEST-1 as small follow-ups.

---

## 12. Suggested follow-up tickets (priority)

| ID | Priority | Work |
| --- | --- | --- |
| F1 | Med | Deny or specially-case cloud metadata IPs in private-host policy (or standalone OpenCode URL docs) |
| F2 | Med | Document admin-diagnostics partial secret reveal trust boundary |
| F3 | Low | Route products/gateway `openCodeFetch` timeout through `fetchWithTimeout` |
| F4 | Low | Parity test gateway-channel crypto vs shared constantTimeEquals |
| F5 | Low | Expand shared host-policy unit tests (creds, wildcard, link-local stance) |
| F6 | Large | Classic→V2 session shapes on products/gateway when OpenCode supports them |
| F7 | Large | Channel stack migration epic |

---

## 13. Audit attestation

Reviewed:

- Full `origin/master...HEAD` file list and security-critical implementations  
- Live probes of host policy and shared redaction  
- Packaging scripts and CI workflow deltas  
- Boundary tests and freeze docs  
- Product layering correctness under CI-forced marker contracts  

**Attestation:** Within the PR’s stated goals, the change set is **production-grade, CI-proven, and safe to merge** with the residual register above. No stone unturned within monorepo-local evidence available at HEAD `a0591630`.
