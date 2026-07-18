---
title: Wiki
description: Optional git-backed knowledge product in the Open Cowork family (standalone install; not the in-app Knowledge store).
---

# Wiki

**Wiki** is the Open Cowork family name for the optional, standalone
git-backed knowledge product (historically developed as
[open-wiki](https://github.com/joe-broadhead/open-wiki)). After monorepo
import it lives under `products/wiki` and installs as **`cowork-wiki`**
(see [Product partitions ADR](adr/product-partitions.md)).

Wiki is **not** the in-app **Knowledge** surface. Knowledge is
app-owned SQLite/Postgres storage for chat-adjacent notes and proposals.
Wiki is a separate product with its own CLI, web UI, HTTP API, Spaces,
and MCP tiers. Dual-track policy:
[Knowledge vs Wiki ADR](adr/knowledge-vs-wiki.md).

## What Wiki is for

- Git-ledger pages, sources, claims, and reviewable proposals
- Team Spaces with explicit read / propose / review / maintain roles
- Search and static export for humans and agents
- Hosted or local-first operation independent of Desktop

## Current integration posture (Open Cowork Desktop / Cloud)

- **Do not** ship a default Wiki MCP in public Open Cowork config.
- Install Wiki **separately** (standalone CLI once packaged from the
  monorepo; until import, follow the private open-wiki install docs).
- If a trusted local Wiki MCP is available, add it as a **user-managed**
  custom MCP with an explicit command, auth mode, and tool allowlist.
- Cloud Web, Desktop Cloud workspaces, Channel Gateway, and Standalone
  Gateway **must not** require a local Wiki checkout.

## Boundary notes

- OpenCode remains the execution engine; Wiki does not replace OpenCode
  sessions or agent runtime.
- Knowledge MCP tools (`knowledge_*`) and Wiki MCP tools must stay
  namespaced separately so agents do not write to the wrong store.
- Soft Desktop “link local Wiki” UX (detect binary, write MCP entry) is
  optional and **default off** (JOE-909).

## Related

- [Knowledge store ownership](knowledge-store-ownership.md) — in-app Knowledge
- [Knowledge vs Wiki ADR](adr/knowledge-vs-wiki.md)
- [Product partitions ADR](adr/product-partitions.md)
- [Monorepo privacy ADR](adr/monorepo-privacy.md) — import gates for public history
