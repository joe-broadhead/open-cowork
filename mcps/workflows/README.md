# Workflows MCP

This bundled MCP lets the Workflow Designer agent preview and save Open Cowork
workflows from a normal setup thread.

The server talks only to the app-owned localhost bridge started by the Electron main process. It does not read or write workflow storage directly.

## Security Model

- The MCP accepts only loopback `http://` bridge URLs from
  `OPEN_COWORK_WORKFLOW_TOOL_URL`.
- Bridge requests require a bearer token from
  `OPEN_COWORK_WORKFLOW_TOOL_TOKEN`; tokens shorter than 32 characters are
  rejected at startup.
- Workflow drafts are validated with zod schemas before they are forwarded to
  the desktop bridge.
- Saving a workflow remains approval-gated by the agent policy; the MCP tool
  description tells agents to call `create_workflow` only after explicit user
  confirmation.

## Development

```bash
pnpm --filter ./mcps/workflows build
pnpm --filter ./mcps/workflows test
```
