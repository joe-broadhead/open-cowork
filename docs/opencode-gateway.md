---
title: Gateway
description: Optional durable work coordinator (cowork-gateway). Distinct from Channel Gateway and Standalone Gateway.
---

# Gateway

**Gateway** is the Open Cowork product name for the optional **durable work
coordinator**. Source of truth is the monorepo partition
[`products/gateway`](https://github.com/joe-broadhead/open-cowork/tree/master/products/gateway)
(package `cowork-gateway`, CLI **`cowork-gateway`**, compat bin
`opencode-gateway`).

## Operator mental model

| Role | Owner |
| --- | --- |
| Sessions, agents, skills, tools, permissions, model execution | **OpenCode** |
| Durable Initiatives/Issues, scheduler, Mission Control, Gateway MCP | **Gateway** |
| Chat providers → Cloud (no OpenCode spawn) | **Channel Gateway** |
| Gateway-only appliance + private OpenCode | **Standalone Gateway** |
| In-app notes / proposals | **Knowledge** (not Gateway) |
| Git-backed knowledge product | **Wiki** (not Gateway) |

OpenCode **executes**. Gateway **coordinates durable work** that outlives any
one session. Public Desktop builds **do not** bundle or pre-enable Gateway MCP.

## Do not confuse “gateway” surfaces

| Name | Path | Role |
| --- | --- | --- |
| **Gateway** (this page) | `products/gateway` | Durable work coordinator + MCP beside OpenCode |
| **Channel Gateway** | `apps/channel-gateway` | Chat providers → Open Cowork Cloud |
| **Standalone Gateway** | `apps/standalone-gateway` | Gateway-only appliance with private OpenCode + Postgres |

Never use unqualified “the gateway” in operator docs — always qualify.

## Install (standalone)

From a monorepo checkout (developers):

```bash
pnpm install --frozen-lockfile
pnpm --filter cowork-gateway build
pnpm --filter cowork-gateway exec npm pack
node products/gateway/scripts/standalone-smoke.mjs
```

From a packed tarball (clean machine):

```bash
npm install -g ./cowork-gateway-*.tgz
cowork-gateway --version
cowork-gateway doctor
```

Release tags use `gateway@v*` / `gateway-v*` (workflow
`.github/workflows/release-gateway.yml`). Desktop `v*` releases do **not**
publish Gateway by default.

## Manual MCP entry (default off)

When a local daemon is running and you intentionally want Desktop’s managed
OpenCode runtime to see it:

```json
{
  "mcp": {
    "gateway": {
      "type": "local",
      "command": ["cowork-gateway", "mcp"],
      "environment": {
        "GATEWAY_DAEMON_URL": "http://127.0.0.1:4097",
        "GATEWAY_MCP_TOOLS": "operate"
      }
    }
  }
}
```

Use the port from `cowork-gateway status` if it is not `4097`. Prefer
owner-only token files over embedding bearer tokens in config. Soft Desktop
“link local Gateway” helpers stay **default off**
([JOE-909](https://linear.app/joe-broadhead/issue/JOE-909)).

## Boundary notes

- Compose via MCP / HTTP / config only — do not import Gateway into Electron main.
- Public upstream builds must not assume a local Gateway checkout or daemon.
- Downstream distributions may preconfigure Gateway MCP only when they own install and support.
- Cloud Web / Channel Gateway must not require a local Gateway daemon.

## Related

- Product docs in-tree: `products/gateway/docs/`
- [Packaging and product modes](packaging-and-product-modes.md)
- [Product partitions ADR](adr/product-partitions.md)
- [Standalone Gateway appliance](gateway-appliance.md)
