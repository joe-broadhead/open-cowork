---
title: Product purity dogfood evidence (JOE-1092)
description: Redacted pass/fail notes for pure master defaults on Desktop Local hero path + progressive secondaries.
---

# Product purity dogfood evidence (JOE-1092)

**Linear:** [JOE-1092](https://linear.app/joe-broadhead/issue/JOE-1092) (parent [JOE-1089](https://linear.app/joe-broadhead/issue/JOE-1089))  
**Script:** [product-purity-dogfood.md](product-purity-dogfood.md)  
**Base commit:** `a930442c` (master at branch cut; post private-voice close-out)  
**Date (UTC):** 2026-07-25  
**Method:** Structural / contract-backed dogfood. Full interactive Desktop UI harness was not available in this environment; steps are graded **pass** when automated purity contracts + static config/code paths prove the honesty claim, **blocked** when only interactive UI can prove the step (with reason), and **fail** only if code/docs contradict the purity register.

**Secrets:** none. No provider keys, tokens, or personal paths recorded.

## Preconditions

| Check | Result | Notes |
| --- | --- | --- |
| Clean public defaults (`open-cowork.config.json`) | **pass** | Secondary Studio flags not default-true; no Wiki/Gateway MCP registered by default (`tests/product-purity-contracts.test.ts`) |
| Primary features default on when omitted | **pass** | `DESKTOP_PRIMARY_FEATURE_KEYS` → `isDesktopFeatureEnabled(undefined, key) === true` |
| Secondary features default off when omitted | **pass** | `knowledge`, `approvals`, `channels`, `artifacts`, `voice` default off |
| Release claim gate present | **pass** | `docs/release-checklist.md` Product purity claim gate |

## Script results (Desktop Local hero path)

| # | Step | Result | Evidence / notes |
| --- | --- | --- | --- |
| 1 | First run — Local path primary; advanced collapsed | **pass** (structural) | Progressive disclosure + packaging docs; first-run Local is hero path in product contract / purity register |
| 2 | Home — composer-first blank chat | **pass** (structural) | Home empty launchpad motion not reserved (`HomePage.tsx` contract); composer support matrix reasons wired |
| 3 | Chat — stream / tools / optional @coworker | **blocked (env)** | Requires live Desktop + provider key; no P0 honesty contradiction in contracts |
| 4 | Team — coworker card + Start chat | **pass** (structural) | Team primary feature default on; no Relationships teaser on Tools |
| 5 | Tools & Skills — no Relationships “coming soon” | **pass** | Contract: `CapabilitiesPage.tsx` has no `coming soon` / `relationshipsDisabled` |
| 6 | Playbooks — empty setup path | **pass** (structural) | Playbooks primary surface; support matrix gates incomplete ops |
| 7 | Projects — board not history search | **pass** | Contract: Projects board uses `coordination.projects` + `RestrictedState` |
| 8 | Approvals — Allow once / Deny; no Always allow teaser | **pass** | Contract: no `alwaysAllowUnavailable` / `onAlwaysAllow` wiring |
| 9 | Settings — no Coming soon voice/digest toggles | **pass** | Contract: notifications Coming soon / voiceReplies / dailyDigest teasers removed |
| 10 | Health Center (not Diagnostics) | **pass** | Contract: sidebar `sidebar.healthCenter`; no Diagnostics label |
| 11 | Workspace switcher — Standalone health-only | **pass** | Contract + ADR: Standalone session list/prompt deferred; connection/health only (R-1042) |

## Progressive secondaries (default-off honesty)

| Secondary | Default | Result | Notes |
| --- | --- | --- | --- |
| Knowledge | off | **pass** | Not default nav; Knowledge ≠ Wiki (aliases + Product MCP copy) |
| Approvals | off | **pass** | Soft enablement warning when forced on |
| Channels | off | **pass** | Soft warning: Cloud path required for full value |
| Artifacts | off | **pass** | Soft warning: redaction review |
| Voice | off | **pass** | Soft warning: Desktop Local only; private voice epic closed separately |

## Verdict

| Grade | Meaning |
| --- | --- |
| **Hero-path purity (honesty)** | **PASS** — no incomplete-trap teasers found in gated contracts; defaults match progressive disclosure |
| **Interactive provider loop (stream chat)** | **BLOCKED** — needs local Desktop + credentials; not required to fail the purity honesty gate per JOE-1089 plan non-goals |
| **P0 incomplete traps** | **none filed** |

## Follow-ups (non-blocking)

- Optional human re-run of steps 3–4 with a provider key on a nightly dogfood machine; attach redacted notes to JOE-1092 without secrets.
- Live Cloud extension covered under [cloud-sync residual JOE-1094](cloud-sync-dogfood-residual-joe-1094.md).

## Related

- [Product purity dogfood script](product-purity-dogfood.md)
- [Product purity register](../product-purity-register.md)
- [Product purity residual risks](../product-purity-residual-risks.md)
- Contract tests: `tests/product-purity-contracts.test.ts`
