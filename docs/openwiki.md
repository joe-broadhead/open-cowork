---
title: Wiki
description: Optional git-backed knowledge product (cowork-wiki). Not the in-app Knowledge store.
---

# Wiki

**Wiki** is the Open Cowork product name for the optional, **git-backed knowledge
substrate**. Source of truth is the monorepo partition
[`products/wiki`](https://github.com/joe-broadhead/open-cowork/tree/master/products/wiki)
(workspace `cowork-wiki-workspace`, packages `@openwiki/*`, CLI **`cowork-wiki`**,
compat bin `openwiki`).

Wiki is **not** LangChain “OpenWiki” tooling and **not** the in-app **Knowledge**
surface. Dual-track policy:
[Knowledge vs Wiki ADR](adr/knowledge-vs-wiki.md).

## Operator mental model

| Surface | What it is |
| --- | --- |
| **OpenCode** | Execution engine (sessions, agents, tools) |
| **Knowledge** | App-owned SQLite/Postgres notes next to chat (Desktop/Cloud) |
| **Wiki** | Separate product: git ledger, Spaces, HTTP/MCP/CLI, static export |
| **Gateway** | Durable work coordinator (not a knowledge store) |

## What Wiki is for

- Git-ledger pages, sources, claims, and reviewable proposals
- Team Spaces with explicit read / propose / review / maintain roles
- Search and static export for humans and agents
- Local-first or hosted operation independent of Desktop

## Install (standalone)

```bash
# Monorepo developers
pnpm install --frozen-lockfile
pnpm --filter cowork-wiki-workspace pack:cli
node products/wiki/scripts/standalone-smoke.mjs

# Clean machine from a packed tarball
npm install -g ./openwiki-cli-*.tgz   # or the packed @openwiki/cli artifact
cowork-wiki --help                    # preferred bin after dual-bin pack
openwiki --help                       # compat
```

Release tags use `wiki@v*` / `wiki-v*` (workflow
`.github/workflows/release-wiki.yml`). Desktop `v*` releases do **not** publish
Wiki by default.

## Desktop / Cloud integration posture

- **Do not** ship a default Wiki MCP in public Open Cowork config.
- Install Wiki separately; add MCP only as a **user-managed** custom MCP.
- Soft Desktop **Link local Wiki** (Tools & Skills) stays **default off**
  ([JOE-909](https://linear.app/joe-broadhead/issue/JOE-909)): requires an
  absolute wiki root and `cowork-wiki` / `openwiki` on `PATH` (or an explicit
  binary path). Token **files** only — never paste secrets into config.
- Channel Gateway and Standalone Gateway must not require a local Wiki checkout.

## Boundary notes

- Knowledge MCP tools (`knowledge_*`) and Wiki MCP tools stay namespaced separately.
- No shared SQLite with the runtime-host Knowledge store.
- OpenCode remains the execution engine.

## Related

- Product tree: `products/wiki/` and `products/wiki/packages/*`
- [Knowledge store ownership](knowledge-store-ownership.md)
- [Knowledge vs Wiki ADR](adr/knowledge-vs-wiki.md)
- [Product partitions ADR](adr/product-partitions.md)
