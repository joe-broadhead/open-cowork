---
title: Gateway
description: Optional durable work coordinator product (cowork-gateway); distinct from Channel Gateway and Standalone Gateway.
---

# Gateway

**Gateway** is the Open Cowork family name for the optional durable work
coordinator historically published as
[opencode-gateway](https://github.com/joe-broadhead/opencode-gateway). After
monorepo import it lives under `products/gateway` and installs as
**`cowork-gateway`** (see [Product partitions ADR](adr/product-partitions.md)).

Gateway owns local Initiatives/Issues, scheduler state, channel bindings for
its own daemon model, Mission Control, and Gateway MCP tools. **OpenCode**
still owns sessions, agents, skills, tools, permissions, and model execution.

Public Desktop builds **do not** bundle Gateway as a default MCP. Treat it as
a trusted user-managed or downstream integration until explicitly linked.

## Do not confuse Gateway with other “gateway” surfaces

| Name | Code (today → target) | Role |
| --- | --- | --- |
| **Gateway** (this page) | external / `products/gateway` | Durable work coordinator + MCP for OpenCode |
| **Channel Gateway** | `apps/gateway` → `apps/channel-gateway` | Chat providers → Open Cowork Cloud (no OpenCode spawn) |
| **Standalone Gateway** | `apps/standalone-gateway` | Gateway-only appliance with private OpenCode + Postgres |

See [Packaging and product modes](packaging-and-product-modes.md).

## Current integration posture

- Install and operate Gateway separately (`cowork-gateway` once packaged;
  until monorepo import, use the private opencode-gateway install path).
- Run its setup/update flow for daemon config, token file, OpenCode assets,
  and service lifecycle.
- Add the Gateway MCP only when the OpenCode profile intentionally needs
  durable tools.
- Keep tool tiers narrow: `read` / `operate` / `admin` as documented by the
  Gateway product.
- Prefer token-file env vars over embedding bearer tokens in config.

## Manual MCP entry (shape)

When a local daemon is running and you want Desktop’s managed OpenCode
runtime to see it, add a custom MCP pointing at the Gateway stdio server.
Exact paths change with install method; prefer the published bin after
monorepo packaging:

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

Use the port from `cowork-gateway status` (or legacy `opencode-gateway status`)
if it is not `4097`. Validate owner-only token files; fail closed on unsafe
paths.

## Boundary notes

- Open Cowork composes with Gateway through OpenCode-native MCP
  configuration. It should not mirror Gateway’s scheduler, issue store, or
  Mission Control inside Electron.
- Public upstream Open Cowork builds must not assume a local Gateway
  checkout, daemon, token file, or dashboard exists.
- Downstream distributions may preconfigure Gateway MCP only when they also
  own installation and support.
- Cloud Web and Cloud APIs must not depend on a local Gateway daemon.

## Related

- [Product partitions ADR](adr/product-partitions.md)
- [Monorepo privacy ADR](adr/monorepo-privacy.md)
- [Standalone Gateway](standalone-gateway.md)
- [Gateway appliance (Channel / remote)](gateway-appliance.md)
