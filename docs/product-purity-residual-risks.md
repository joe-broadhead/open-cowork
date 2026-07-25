---
title: Product purity residual risks (JOE-1029 close)
description: Residual risk register after product purity waves 1–final.
---

# Product purity residual risks

**Epic:** JOE-1029
**Filled:** 2026-07-24
**Rule:** No P0 open without Waive.

| ID | Sev | Surface | Description | Claim impact | Mitigation |
| --- | --- | --- | --- | --- | --- |
| R-1042 | P1 | Standalone | Full Desktop session/projection API not implemented | Cannot claim Standalone chat from Desktop | Connection-only UX + ADR; [JOE-1091 residual](runbooks/standalone-session-api-residual-joe-1091.md); implement later with contract tests before matrix flip |
| R-1094 | P2 | Cloud sync | Live Desktop↔Web↔Channel Tier-1 dogfood env unavailable in post-purity wave | Cannot claim sync “proven” for release without live notes | [JOE-1094 residual](runbooks/cloud-sync-dogfood-residual-joe-1094.md); code path honesty retained |
| R-1085 | P2 | Cloud offline | Offline mutation paths rely on support matrix; soak evidence env-specific | No offline GA claim | Chat/Home respect `canPrompt`; private ops soak |
| R-1068 | P2 | Enterprise | SSO/backup/tenant rows partial | No enterprise-ready marketing | [enterprise-readiness-matrix.md](enterprise-readiness-matrix.md) fail-closed + owners/next evidence (JOE-1093) |
| R-1071 | P2 | Redaction | Continuous redaction needs ongoing review | — | Boundary tests + secondary surface review |
| R-1081 | P3 | i18n | Non-en catalogs may lag English product nouns | Cosmetic | EN SoT + fallback to en; coverage-status honest |
| R-1074 | P3 | Perf | No new budgets broken intentionally | — | Existing `perf:check` on renderer changes |
| R-1063 | P3 | Feature flags | Soft warnings only — operators can still enable incomplete secondaries | Secondary surfaces opt-in | progressive-disclosure.md + `desktopFeatureEnablementWarnings` |

**P0 residuals:** none.

## Post-purity wave evidence (JOE-1089)

| Wave | Issue | Artifact |
| --- | --- | --- |
| W1 | JOE-1092 | [product-purity-dogfood-evidence-joe-1092.md](runbooks/product-purity-dogfood-evidence-joe-1092.md) |
| W2 | JOE-1090 | [pure-release-notes-claim-freeze.md](samples/pure-release-notes-claim-freeze.md) |
| W3 | JOE-1093 | [enterprise-readiness-matrix.md](enterprise-readiness-matrix.md) (owners + next evidence) |
| W4 | JOE-1094 | [cloud-sync-dogfood-residual-joe-1094.md](runbooks/cloud-sync-dogfood-residual-joe-1094.md) |
| W5 | JOE-1091 | [standalone-session-api-residual-joe-1091.md](runbooks/standalone-session-api-residual-joe-1091.md) |

## Close checklist

See [product-purity-checklist.md](product-purity-checklist.md).
Final wave evidence: [product-purity-final-wave.md](product-purity-final-wave.md).
Register: [product-purity-register.md](product-purity-register.md).
