---
title: ADR — Product partitions, naming matrix, and dependency rules
description: Monorepo layout and naming for Open Cowork, Channel Gateway, durable Gateway, Standalone Gateway, and Wiki.
---

# ADR: Product partitions, naming matrix, and dependency rules

| Field | Value |
| --- | --- |
| Status | **Accepted** |
| Date | 2026-07-18 |
| Linear | [JOE-900](https://linear.app/joe-broadhead/issue/JOE-900) |
| Milestone | Monorepo product partitions (Gateway + Wiki) |

## Context

Open Cowork is the flagship multi-surface product on top of OpenCode. Two sibling products historically lived in private repos:

- **opencode-gateway** — durable work coordinator (daemon, scheduler, Mission Control, MCP)
- **open-wiki** — git-backed knowledge substrate (CLI, web, HTTP API, MCP)

Inside open-cowork, **Channel Gateway** is `apps/channel-gateway` / `@open-cowork/channel-gateway` (renamed from `apps/gateway`). Naming both that surface and durable **Gateway** without qualifiers causes operator and agent-tool ambiguity.

## Decision

### 1. Product-partitioned monorepo

```text
open-cowork/
  apps/
    desktop/
    channel-gateway/      # Channel Gateway (renamed from apps/gateway)
    standalone-gateway/
  packages/               # @open-cowork/* libraries
  mcps/                   # Open Cowork bundled MCPs
  products/
    gateway/              # durable Gateway (ex opencode-gateway)
    wiki/                 # Wiki (ex open-wiki monorepo)
  third_party/            # native/external binaries only (e.g. time-keep)
```

### 2. Naming matrix (source of truth)

| Historical name | Monorepo path (target) | Public product name | Installable bin / image |
| --- | --- | --- | --- |
| Open Cowork Desktop | `apps/desktop` | **Open Cowork** (Desktop) | GH release installers |
| Open Cowork Cloud | `packages/cloud-server` + unified renderer | **Open Cowork** (Cloud) | `open-cowork-cloud` OCI |
| `apps/gateway` | `apps/channel-gateway` | **Channel Gateway** | preferred image `open-cowork-channel-gateway` (dual-tag `open-cowork-gateway`) |
| `apps/standalone-gateway` | keep | **Standalone Gateway** | CLI: `open-cowork-gateway-standalone` |
| opencode-gateway | `products/gateway` | **Gateway** | bin: **`cowork-gateway`** (optional shim `opencode-gateway` for one minor) |
| open-wiki | `products/wiki` | **Wiki** | bin: **`cowork-wiki`** (optional shim `openwiki` during transition) |
| In-app knowledge | `packages/runtime-host` + `mcps/knowledge` | **Knowledge** | MCP namespace `knowledge` |

**Forbidden in user-facing copy and package metadata:**

- Bare global npm bins named only `gateway` or `wiki`
- Calling the durable product **OpenCode Gateway** in Open Cowork product docs after import (historical external name may appear only in migration notes)
- Unqualified “the gateway” when Channel Gateway, Standalone Gateway, and Gateway could all apply

### 3. Dependency rules

1. **One-way:** `@open-cowork/*` shared libraries may be used by apps and products. Shared libraries must not depend on apps or products.
2. **No product-to-product implementation imports.** `products/gateway` does not import `products/wiki` source (and vice versa). Channel Gateway does not import durable Gateway source.
3. **Composition only** via MCP, HTTP, config, or published packages — not in-process Electron fusion of Gateway/Wiki daemons.
4. **OpenCode remains execution authority.** Gateway coordinates durable work; it is not a second agent runtime. Wiki stores knowledge; it does not execute models for Open Cowork sessions.
5. **Knowledge store ≠ Wiki store** (see [Knowledge vs Wiki ADR](knowledge-vs-wiki.md)).

### 4. Versioning posture

Independent product versions (Changesets or equivalent — JOE-903):

- Open Cowork desktop/cloud family: existing `0.x` / future family tags
- Gateway: continue **1.3.x** after import
- Wiki: `0.x` when published

### 5. Non-goals (this milestone)

- Merging Channel Gateway and durable Gateway codebases
- Replacing Knowledge with Wiki
- Single monorepo-wide semver for all products
- Default-on Gateway/Wiki MCP in public Desktop config
- Bare npm package names that collide with generic ecosystem bins

## Review checklist for future PRs

- [ ] Does this blur **Gateway** vs **Channel Gateway** vs **Standalone Gateway**?
- [ ] Does this add a forbidden cross-product import?
- [ ] Does this assume OpenCode is no longer the executor?
- [ ] Does this force a desktop release when only Gateway/Wiki changed?

## Consequences

- Channel Gateway package rename (`apps/channel-gateway`) is complete; keep dual-tag OCI until operators migrate.
- Docs and OCI names must update on a compatibility window (JOE-902, JOE-910).
- Boundary enforcement becomes a CI concern (JOE-905).
- Private **opencode-gateway** / **open-wiki** remotes freeze 2026-07-18 and archive after monorepo SoT + release gate (JOE-915).

## Related

- [Monorepo privacy ADR](monorepo-privacy.md)
- [Knowledge vs Wiki ADR](knowledge-vs-wiki.md)
- [Product repo freeze and archive](../runbooks/product-repo-archive.md)
- [Packaging and product modes](../packaging-and-product-modes.md)
- [Glossary](../glossary.md)
