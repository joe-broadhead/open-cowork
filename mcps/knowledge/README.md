# @open-cowork/mcp-knowledge

OpenCode-native MCP server that lets a coworker **propose** knowledge-base (wiki)
edits. Proposals are never applied directly — they stay `PENDING` until a human
Maintainer reviews them in Open Cowork.

## Tool

- `mcp__knowledge__propose_knowledge_edit` — submit a proposed page (title +
  ordered blocks + optional links) for human review.

## Environment

The runtime injects both of these; the server fails closed if either is missing.

| Variable | Purpose |
| --- | --- |
| `OPEN_COWORK_KNOWLEDGE_TOOL_URL` | The bridge endpoint the server POSTs proposals to. Desktop points this at a loopback `http://` bridge; cloud points it at its own `https://<public-url>/api/knowledge/agent`. `http://` is restricted to loopback hosts; `https://` is allowed to any host. URL credentials are rejected. |
| `OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN` | Per-session bearer token (≥32 chars) the bridge verifies. |

The URL/token are set by the Open Cowork runtime, never by the agent/model, so a
prompt cannot redirect proposals elsewhere.

## Build / test

```bash
pnpm --dir mcps/knowledge build
pnpm --dir mcps/knowledge test
```
