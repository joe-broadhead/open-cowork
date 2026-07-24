---
title: Product purity final wave evidence
description: Closing evidence for JOE-1029 remaining children (honesty, contracts, residuals).
---

# Product purity final wave evidence

**Epic:** [JOE-1029](https://linear.app/joe-broadhead/issue/JOE-1029)
**PR:** purity waves on `feat/joe-1029-wave1-product-purity`
**Companion residual register:** [product-purity-residual-risks.md](product-purity-residual-risks.md)

This page maps every late-wave purity child to shipped honesty, code, docs, or
an explicit residual. Full session/API builds that are out of purity scope stay
deferred with residual IDs — never marketed as complete.

## Issue → evidence

| Issue | Outcome | Evidence |
| --- | --- | --- |
| JOE-1034 Knowledge UI aliases | Done | `@open-cowork/ui` re-exports `KnowledgePage` / `KnowledgeSpaceRail` / `KnowledgeProposeEditDialog`; Studio Knowledge imports aliases; [ADR knowledge-vs-wiki](adr/knowledge-vs-wiki.md) |
| JOE-1042 Standalone session API | **Canceled (deferred)** | Full API out of purity epic; connection-only + [ADR standalone-desktop-session-api](adr/standalone-desktop-session-api.md); residual **R-1042** |
| JOE-1047 Knowledge completeness | Done | Empty/error/review/proposal/role chips on Knowledge page; secondary default-off |
| JOE-1048 Chat density | Done | Inspector closed by default; agent-run filters opt-in (`isAgentRunFiltersEnabled`); ToolTrace compact default |
| JOE-1049 Support matrix UX | Done | `disabledReason` / RestrictedState on New chat, composer (`sendDisabledReason`), Projects board, Tools/Studio secondaries |
| JOE-1051 Wiki sibling isolation | Done | Default `open-cowork.config.json` has no Wiki MCP; ProductMcpLinkPanel explicit Link; purity contract test |
| JOE-1057 Approvals completeness | Done | Queue surface + empty; Always-allow removed; open chat; badge from queue model |
| JOE-1058 Cloud coordination honesty | Done | Projects board `RestrictedState` when `coordination.projects` deferred/blocked; mutations `disabledReason` |
| JOE-1059 Tools & Skills | Done | Empty/error forms; Product MCP link polish; no Relationships teaser |
| JOE-1063 Feature enablement gates | Done | `desktopFeatureEnablementWarnings()` soft warnings; progressive disclosure docs |
| JOE-1065 Cloud Web stubs | Done | Inventory below; ThreadList hides local-only menus; support matrix blocks prompt/create |
| JOE-1067 Admin honesty | Done | Billing omitted when adapter off; audit export toast when unavailable |
| JOE-1071 Redaction secondary | Done | Artifacts inspect redaction tests; Channels/Artifacts sanitize helpers |
| JOE-1074 Perf budgets | Done | No intentional budget breaks; `pnpm perf:check` remains gate; [performance.md](performance.md) |
| JOE-1075 Epic close-out | Done | This page + residual register + checklist |
| JOE-1076 A11y + density | Done | Existing EmptyState/Skeleton patterns; RestrictedState; a11y lint policy |
| JOE-1078 Design voice | Done | No new dashboard theater in purity waves; Mercury tokens only |
| JOE-1081 i18n purity | Done | EN is SoT empty catalog + fallbacks; `coverage-status.ts` honest partial coverage |
| JOE-1085 Cloud offline purity | Done | `canPrompt` false offline; presence “Offline cached”; composer blocked with reason |

## Cloud Web CoworkAPI stub inventory (JOE-1065)

Browser build (`packages/app/src/browser/cowork-api.ts`) throws `browserUnavailable`
for ops that require Desktop/local authority. Primary menus **hide** rather than
expose throwy actions where ThreadList / workspace switcher already gate:

| Area | Stub pattern | UI honesty |
| --- | --- | --- |
| workspace add/remove/login | unavailable | Desktop-only; Web uses session cookie bootstrap |
| desktopPairing.* | unavailable | Pairing Settings Desktop-only |
| session rename/delete/fork/share/revert | unavailable or partial | Local thread menus hidden on non-local workspaces |
| session importInventory / copyToCloud | unavailable | Local-only flows |
| projectSource snapshot upload | unavailable | Cloud project create uses Cloud-safe sources on Desktop |
| mcp connect/auth/preflight (stdio) | unavailable | Tools shows policy-safe catalog; no fake local add |
| machineRuntimeConfig / localFiles | not_supported in support matrix | Restricted copy |
| workflows.startDraft / webhook secrets | unavailable | Playbooks read/run where matrix allows |
| diagnostics.perf / app.reset | unavailable | Health Center cloud-safe subset |

Cloud capability banner (AppShellNotices) states browser limits up front.

## Coordination matrix note (JOE-1058)

| Workspace | `coordination.projects` | Projects UI |
| --- | --- | --- |
| Desktop Local | supported | Full kanban |
| Desktop Cloud | often deferred / policy | RestrictedState or disabled mutations with reason |
| Cloud Web | matrix-driven | Same honesty path |
| Standalone connection | not session workspace | Connection-only; Projects not a full Standalone promise |

## Chat density defaults (JOE-1048)

- Review/inspector pane: **closed** until user opens Show Review
- Agent-run filter chrome: **off** unless `localStorage` gate `open-cowork.feature.agentRunFilters=true`
- Tool traces: compact / not expanded when all tools complete
- Primary transcript + inline approvals/questions remain always available

## Feature enablement warnings (JOE-1063)

Call `desktopFeatureEnablementWarnings(features)` from doctor/docs tooling when
validating configs that opt into secondary Studio. Warnings are soft — they do
not fail schema validation — because progressive disclosure is intentional opt-in.

## Claim freeze (release)

Public claims must still match [product-purity-register.md](product-purity-register.md).
No enterprise-ready / Standalone chat / Knowledge=Wiki / unqualified gateway.

## Related

- [Product purity checklist](product-purity-checklist.md)
- [Product purity residual risks](product-purity-residual-risks.md)
- [Progressive disclosure](progressive-disclosure.md)
- [ADR Standalone Desktop session API](adr/standalone-desktop-session-api.md)
