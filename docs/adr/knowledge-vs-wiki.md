---
title: ADR — Knowledge vs Wiki dual-track policy
description: Keep in-app Knowledge and standalone Wiki as separate systems; no store merge in the monorepo milestone.
---

# ADR: Knowledge vs Wiki dual-track policy

| Field | Value |
| --- | --- |
| Status | **Accepted** |
| Date | 2026-07-18 |
| Linear | [JOE-898](https://linear.app/joe-broadhead/issue/JOE-898) |
| Milestone | Monorepo product partitions (Gateway + Wiki) |

## Context

Open Cowork already ships an in-app **Knowledge** surface:

- Shared contract: `KnowledgeStore` in `@open-cowork/shared`
- Desktop: SQLite via runtime-host
- Cloud: Postgres via cloud-server
- Agent tools: `mcps/knowledge` (`knowledge_propose_knowledge_edit`, …)
- Secondary Studio surface, feature-flagged (`features.knowledge`)

The private **open-wiki** product (import target `products/wiki`) is a different system: git-backed ledger, Spaces, web UI, HTTP API, CLI, and its own MCP tiers.

Merging these stores during monorepo import would couple durability models, auth, multi-tenancy, and UX without a product decision.

## Decision

**Dual track is the default and remains the default for this milestone.**

| System | Public name | Owner | Durability | Default in public Desktop |
| --- | --- | --- | --- | --- |
| In-app knowledge | **Knowledge** | Open Cowork runtime-host + cloud-server + `mcps/knowledge` | SQLite (local) / Postgres (cloud) | Feature secondary; not replaced by Wiki |
| External product | **Wiki** | `products/wiki` (ex open-wiki) | Git ledger + product stores | **Not installed / not MCP-linked by default** |

### Rules

1. **No shared database** between Knowledge and Wiki.
2. **No silent dual-write** from agents or UI.
3. **Distinct tool namespaces** — Knowledge MCP stays `knowledge_*` / `mcp__knowledge__*`. Wiki MCP tools must not reuse Knowledge names.
4. **Public Desktop default config** must not register a Wiki MCP entry (`open-cowork.config.json` and shipped overlays).
5. Docs and Settings must never treat Knowledge and Wiki as synonyms.

### Future bridge (explicit non-goal until a new ADR)

An optional adapter that mirrors selected Wiki pages into Knowledge *proposals* may be designed later. It requires:

- Both products stable in the monorepo
- Explicit user opt-in
- A separate ADR

## Config guidance

- Knowledge: existing `features.knowledge` and built-in knowledge MCP (when enabled).
- Wiki: optional user-managed MCP / CLI only after standalone install (`cowork-wiki`). Soft Desktop “link Wiki” UX is JOE-909 and remains **default off**.

## UI primitive naming (JOE-1034)

In-app Knowledge reuses Studio primitives historically named `WikiPage`,
`WikiSpaceRail`, and `WikiProposeEditDialog` in `@open-cowork/ui`. These are
**visual document-chrome components**, not the Wiki product. Prefer user-facing
copy “Knowledge / Space / Page / Proposal”. Aliases
`KnowledgePage` / `KnowledgeSpaceRail` / `KnowledgeProposeEditDialog` re-export
the same components for new code.

## Consequences

- Importing Wiki does not migrate Knowledge data.
- Operators may run both: Knowledge for chat-adjacent notes, Wiki for org-scale git knowledge.
- Agents must be steered by skills/docs to the correct product when both MCP servers are present.

## Related

- [Knowledge store ownership](../knowledge-store-ownership.md)
- [Wiki product](../openwiki.md)
- [Product partitions ADR](product-partitions.md)
