# Open Cowork Agents MCP

Bundled MCP for creating, previewing, reading, and deleting Open Cowork custom agents.

The MCP does not write agent files directly. It posts to the main-process
loopback bridge so every save uses the same validation, permission building,
and custom-agent store path as the desktop UI.

## Security Model

- The MCP accepts only loopback `http://` bridge URLs from
  `OPEN_COWORK_AGENT_TOOL_URL`.
- Bridge requests require a bearer token from
  `OPEN_COWORK_AGENT_TOOL_TOKEN`; tokens shorter than 32 characters are
  rejected at startup.
- Agent drafts are validated with zod schemas before they are forwarded to the
  desktop bridge.
- Built-in agents are read-only through this MCP. Only custom agents can be
  created, updated, or deleted.
- Saving or deleting an agent remains approval-gated by the agent policy; tool
  descriptions instruct agents to call write operations only after explicit user
  confirmation.

## Development

```bash
pnpm --filter ./mcps/agents build
pnpm --filter ./mcps/agents test
```
