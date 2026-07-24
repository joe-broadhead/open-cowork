---
title: Maintainer product map
description: Where code lives for Desktop, Cloud, Channel Gateway, Standalone, durable Gateway, and Wiki (JOE-1066).
---

# Maintainer product map

One page for contributors. Users see product nouns; maintainers need paths.

## Decision tree — where does new code go?

```text
Is it durable Initiatives/Issues/Mission Control for OpenCode?
  → products/gateway (cowork-gateway) — NOT apps/channel-gateway

Is it git-backed Wiki CLI/web/MCP?
  → products/wiki — NOT in-app Knowledge (runtime-host + mcps/knowledge)

Is it chat providers → Cloud (no OpenCode spawn)?
  → apps/channel-gateway + packages/gateway-provider-*

Is it private OpenCode appliance with Gateway Postgres?
  → apps/standalone-gateway

Is it Desktop/Cloud Studio UI or shared renderer?
  → packages/app (+ packages/ui)

Is it Cloud control plane / workers?
  → packages/cloud-server

Is it local OpenCode supervision for Desktop?
  → packages/runtime-host + apps/desktop
```

## Naming matrix (never confuse)

| Public name | Path | Bin / image |
| --- | --- | --- |
| Open Cowork Desktop | `apps/desktop` | installers |
| Open Cowork Cloud | `packages/cloud-server` + `packages/app` browser | `open-cowork-cloud` |
| Channel Gateway | `apps/channel-gateway` | `open-cowork-channel-gateway` |
| Standalone Gateway | `apps/standalone-gateway` | `open-cowork-gateway-standalone` |
| Gateway (durable) | `products/gateway` | `cowork-gateway` |
| Wiki | `products/wiki` | `cowork-wiki` |
| Knowledge (in-app) | runtime-host + `mcps/knowledge` | bundled MCP |

## Dependency rules

1. `@open-cowork/*` libs may be used by apps/products; not the reverse.
2. No product-to-product implementation imports.
3. Compose via MCP / HTTP / config only.
4. OpenCode remains execution authority.

## Related

- [ADR product partitions](adr/product-partitions.md)
- [Product partitions README](https://github.com/joe-broadhead/open-cowork/blob/master/products/README.md) (repo root `products/README.md`)
- [Packaging and product modes](packaging-and-product-modes.md)
