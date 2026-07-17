# UX/UI P1 batch (parent JOE-818) — implementer summary

Branch: `milestone/first-principles-audit-2026-07-17`  
Date: 2026-07-17  
No PR opened; no push.

## Completed P1 (one commit each)

| Issue | SHA | What was done |
| --- | --- | --- |
| **JOE-854** | `5647cdcc` | Adopt Studio ApprovalCard as shared base for chat ApprovalCard; adoption map in `docs/design-system.md` (adopt high-traffic / demote gallery shells). Concurrent **JOE-881** later renamed shell to `StudioApprovalCard`. |
| **JOE-851** | `0b016145` | Split `packages/ui/src/surface-styles.ts` → `packages/ui/src/styles/*-surface.ts`; split `globals.css` → `packages/app/src/styles/domains/{base,shell,studio,chat,settings}.css`; document ownership; update CSS parity/regression readers. |
| **JOE-849** | `4e30e1e2` | Secondary Studio surfaces (`knowledge`, `approvals`, `channels`, `artifacts`) default **off**; primary (`projects`, `team`, `playbooks`, `tools`) default on via `isDesktopFeatureEnabled` + `DESKTOP_SECONDARY_FEATURE_KEYS`. Docs + Sidebar/CommandPalette tests. |
| **JOE-853** | `c97d1428` | Axe smoke for Chat composer+approval, Setup, Command palette; model chip aria-label fix. |
| **JOE-848** | `436e7c36` | Custom MCP form: Input/Textarea/SegmentedControl/Button primitives; permission mode segmented. |
| **JOE-847** | `be12b857` | Embedded DiffViewer wraps DiffView (single family); ownership table in design-system.md. |
| **JOE-850** | `e0cbe32a` | Setup minimal path: Get Started without mandatory connection test; test remains optional; progress copy provider → model → chat. |

### Follow-up on JOE-854 commit hygiene

| Commit | SHA | Note |
| --- | --- | --- |
| fix(sidebar) | `fd05e1bf` | Restored full Sidebar after JOE-854 accidentally staged a half-extract; later **JOE-884** re-split Sidebar properly (with useRef fix landed in JOE-849). |

## P2 completed (time allowed)

| Issue | SHA | What was done |
| --- | --- | --- |
| **JOE-852** | `8fe15b95` | AgentCapabilitiesTab uses shared `EmptyState` icon/title/body. |
| **JOE-859** | `3e712821` | Home drops ad-hoc tracking; `.font-display` uses token tracking; `font-display: swap`. |
| **JOE-860** | `40c04a75` | Document non-EN i18n as experimental/partial (downstream.md + Settings language copy). |

## Incomplete P2 (not started / reason)

| Issue | Reason |
| --- | --- |
| **JOE-876** | Permissions progressive disclosure — SettingsPermissionsPanel redesign not started (scope/time). |
| **JOE-894** | Agent builder / Setup raw controls → DS primitives — large surface area after JOE-848; not started. |
| **JOE-855** | Settings theater voice/digest/usage toggles audit — needs runtime wiring survey; not started. |

## Tests run (targeted)

- `vitest` renderer: ApprovalCard, accessibility-smoke, Sidebar, CommandPalette, CustomMcpForm, DiffViewer, SetupScreen, AgentCapabilitiesTab
- Node: `tests/desktop-feature-flags.test.ts`, studio CSS parity/regression/flex-center/design-tokens-sync

## Notes

- Concurrent milestone agents landed JOE-881/884/etc. on the same branch; P1 commits remain independent.
- Do not push/PR per batch rules.
