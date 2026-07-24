---
title: Product purity epic close checklist
description: Evidence checklist and residual-risk template for JOE-1029 close-out.
---

# Product purity epic close checklist

**Epic:** [JOE-1029](https://linear.app/joe-broadhead/issue/JOE-1029)
**Companion register:** [Product purity register](product-purity-register.md)

Use this before marking the epic Done. Auto gates are preferred; human rows
need evidence linked on the epic comment.

## Checklist

| # | Item | Auto / human | Evidence |
| --- | --- | --- | --- |
| 1 | Finding register complete; every finding mapped or Won't Do | human | `docs/product-purity-register.md` |
| 2 | Secondary feature defaults off when omitted | auto | `tests/desktop-feature-flags.test.ts` |
| 3 | No Settings “Coming soon” notification teasers | auto / human | Settings Notifications panel + tests |
| 4 | Approvals queue has no Always-allow no-op | auto | Studio Approvals tests |
| 5 | Standalone / Paired connection-only honesty in UI | human + tests | Workspace switcher + pairing Settings |
| 6 | Vocabulary matrix published | human | `docs/glossary.md` |
| 7 | Projects = Kanban positioning consistent | human | `docs/projects.md`, desktop-app |
| 8 | Knowledge ≠ Wiki in user copy | human | desktop-app, Product MCP link |
| 9 | Cloud Web capability banner | auto / human | AppShellNotices + browser only |
| 10 | Local stays local claim + boundary tests | auto | `tests/workspace-gateway.test.ts` |
| 11 | Progressive disclosure policy published | human | `docs/progressive-disclosure.md` |
| 12 | Zero open P0 purity children without Waived | human | Linear JOE-1029 children |
| 13 | Residual risk register filled | human | `docs/product-purity-residual-risks.md` |
| 14 | Release notes / marketing claim gate reviewed | human | release checklist |
| 15 | Final wave evidence map complete | human | `docs/product-purity-final-wave.md` |
| 16 | Zero open P0 purity children (Done or Canceled+residual) | human | Linear JOE-1029 children |

## Residual risk template

| ID | Severity | Surface | Description | Claim impact | Mitigation / Waive |
| --- | --- | --- | --- | --- | --- |
| R-… | P0/P1/P2 | … | … | blocks marketing? | … |

**Close rule:** no open P0 residual risks without explicit Waived rationale on the epic.

## Related

- [Progressive disclosure](progressive-disclosure.md)
- [Release checklist](release-checklist.md)
