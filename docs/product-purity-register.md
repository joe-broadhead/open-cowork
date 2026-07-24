---
title: Product purity register and claim boundary
description: Finding register for JOE-1029 Wave 1+, public claim matrix, and forbidden claims for Open Cowork.
---

# Product purity register and claim boundary

**Epic:** [JOE-1029](https://linear.app/joe-broadhead/issue/JOE-1029)
**Milestone:** Product Purity — World-Class Workbench (2026-07)
**Source audit:** product/UX audit on monorepo `master` (2026-07-24)

This page is the **scope gate** for product purity work. New purity work must map
to an issue under JOE-1029 (or a documented Won't Do). Public marketing and
release notes must respect the claim matrix.

## Hero promise (shipped and marketed)

```text
Home → Chat → Team | Tools & Skills | Playbooks | Projects
```

Optional secondary Studio (default off; progressive disclosure):

- Knowledge, Approvals, Channels, Artifacts

Optional installable siblings (not Desktop default nav):

- Channel Gateway, Standalone Gateway appliance, durable Gateway (`cowork-gateway`), Wiki (`cowork-wiki`)

## Non-negotiable promises

1. OpenCode owns execution — no second agent runtime
2. Local stays local unless explicit cloud-safe action
3. Cloud workspaces sync across Desktop Cloud, Cloud Web, Channel Gateway
4. Gateway modes are named distinctly (Channel / Standalone / durable Gateway)
5. Every UI control is complete, deferred-labeled, or removed — never fake
6. Public claims match evidence (preview / self-host beta / private hosted / enterprise)
7. OSS self-host remains first-class; hosted stays BYOK

## Public claim matrix

| Surface | Allowed claim language | Not allowed without evidence |
| --- | --- | --- |
| Desktop Local | Private local OpenCode workbench | Hosted/enterprise multi-tenant |
| Desktop Cloud | Synced cloud sessions via Cloud control plane | Implicit local file/MCP/key upload |
| Cloud Web | Browser Studio for same Cloud sessions | Local filesystem, local stdio MCP, local agent authoring parity |
| Channel Gateway | Headless channel access to **Cloud** sessions | Spawning OpenCode; durable Gateway Mission Control |
| Standalone Gateway appliance | Private appliance with own OpenCode + Postgres | Full Desktop Studio session parity until Desktop-safe API ships |
| Desktop ↔ Standalone connection | Connection/health/support registration | “Gateway workspace ready for chat” while sessions are deferred |
| Paired Desktop | Outbound connector / remote access **preview** | Full remote Studio parity until ops are complete |
| Knowledge (in-app) | Chat-adjacent spaces/pages/proposals | Synonym for Wiki product |
| Wiki (`cowork-wiki`) | Optional git-backed knowledge product | Default Desktop Knowledge replacement |
| Durable Gateway (`cowork-gateway`) | Local operator / claim-gated beta | Multi-tenant production GA without evidence |
| Tier-1 channels (Telegram/Slack/email) | Launch-tier adapters | — |
| Tier-3 channels (Discord/WhatsApp/Signal) | Experimental / bridge-backed | Launch marketing without live smoke |

## Forbidden claims (fail closed)

- Unqualified “the gateway” when Channel / Standalone / durable Gateway could apply
- “Always allow” as working policy when control is a no-op
- Settings features labeled only “Coming soon” that still look like toggles
- Pairing or Standalone “ready” without session/list/prompt support
- Knowledge = Wiki (or OpenWiki as synonym for in-app Knowledge)
- Enterprise-ready / hosted GA without rows proven in enterprise readiness matrix
- Mobile / Teams as shipping products (names reserved only)

## Finding → issue map (Wave 1+)

| Finding | Issue | Wave |
| --- | --- | --- |
| Scope / claim boundary | JOE-1030 (this register) | 1 |
| Epic close checklist template | JOE-1033 | 1 |
| Vocabulary matrix | JOE-1041, glossary | 1 |
| Settings Coming soon (voice/digest) | JOE-1031 | 1 |
| Models Test connection teaser | JOE-1035 | 1 |
| Approvals Always-allow honesty | JOE-1039 | 1 |
| Standalone connection-only honesty | JOE-1044 | 1 |
| Projects = Kanban (decision) | JOE-1052 | 1 |
| Knowledge vs Wiki user story | JOE-1055 | 1 |
| Progressive disclosure policy | JOE-1069 | 1 |
| Cloud Web capability banner | JOE-1062 | 1 |
| Local stays local | JOE-1077 | 1 |
| Presence footer truthfulness | JOE-1038 | 1 |
| Remaining purity backlog | JOE-1029 children PP-2+ | later |

## Progressive disclosure (defaults)

Primary feature keys default **on** when omitted: `projects`, `team`, `playbooks`, `tools`.
Secondary keys default **off**: `knowledge`, `approvals`, `channels`, `artifacts`.

See [Progressive disclosure](progressive-disclosure.md) and
`isDesktopFeatureEnabled` in `packages/shared/src/app-config.ts`.

## Related

- [Product contract](product-contract.md)
- [Packaging and product modes](packaging-and-product-modes.md)
- [Product language (glossary)](glossary.md)
- [Knowledge vs Wiki ADR](adr/knowledge-vs-wiki.md)
