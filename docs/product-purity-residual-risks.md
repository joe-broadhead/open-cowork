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
| R-1042 | P1 | Standalone | Full Desktop session/projection API not implemented | Cannot claim Standalone chat from Desktop | Connection-only UX + ADR; implement later outside purity epic |
| R-1085 | P2 | Cloud offline | Offline mutation paths rely on support matrix; soak evidence env-specific | No offline GA claim | Chat/Home respect `canPrompt`; private ops soak |
| R-1068 | P2 | Enterprise | SSO/backup/tenant rows partial | No enterprise-ready marketing | enterprise-readiness-matrix.md fail-closed |
| R-1071 | P2 | Redaction | Continuous redaction needs ongoing review | — | Boundary tests + secondary surface review |
| R-1081 | P3 | i18n | Non-en catalogs may lag English product nouns | Cosmetic | EN SoT + fallback to en; coverage-status honest |
| R-1074 | P3 | Perf | No new budgets broken intentionally | — | Existing `perf:check` on renderer changes |
| R-1063 | P3 | Feature flags | Soft warnings only — operators can still enable incomplete secondaries | Secondary surfaces opt-in | progressive-disclosure.md + `desktopFeatureEnablementWarnings` |

**P0 residuals:** none.

## Close checklist

See [product-purity-checklist.md](product-purity-checklist.md).
Final wave evidence: [product-purity-final-wave.md](product-purity-final-wave.md).
Register: [product-purity-register.md](product-purity-register.md).
