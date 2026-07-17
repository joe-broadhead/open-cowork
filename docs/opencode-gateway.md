# OpenCode Gateway

[OpenCode Gateway](https://github.com/joe-broadhead/opencode-gateway) is an
optional external durable-work coordinator for OpenCode. It owns local
Initiatives, Issues, scheduler state, channel bindings, Mission Control, and
Gateway MCP tools. OpenCode still owns sessions, agents, skills, tools,
permissions, and model execution.

Open Cowork does not bundle OpenCode Gateway as a default MCP because it is a
separate local service with its own daemon, SQLite state, operator credential,
dashboard, and release-readiness contract. Treat it like a trusted
user-managed/downstream integration, not like a built-in zero-install tool.

## Current integration posture

- Install and operate OpenCode Gateway separately.
- Run its setup/update flow so it can provision its daemon config, token file,
  OpenCode assets, and service lifecycle.
- Add the Gateway MCP only when the target OpenCode profile intentionally needs
  durable Gateway tools.
- Keep its tool tier narrow:
  - `read` for inspection/status/dashboard/briefing.
  - `operate` for day-to-day task, roadmap, scheduler, channel, and human-loop
    work.
  - `admin` only for explicitly trusted operator surfaces that may mutate
    config, assets, restores, restarts, or destructive operations.
- Do not confuse OpenCode Gateway with Open Cowork's own Cloud Channel Gateway
  or Standalone Gateway product modes. They solve different product problems.

## Manual MCP entry

If a user or downstream build wants Open Cowork's managed OpenCode runtime to
see an existing local Gateway daemon, add a custom MCP entry that points at the
Gateway stdio server:

```json
{
  "mcp": {
    "gateway": {
      "type": "local",
      "command": ["node", "/absolute/path/to/opencode-gateway/dist/mcp.js"],
      "environment": {
        "GATEWAY_DAEMON_URL": "http://127.0.0.1:4097",
        "GATEWAY_MCP_TOOLS": "operate",
        "OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE": "/absolute/path/to/opencode-gateway-config/http-admin-token"
      }
    }
  }
}
```

Use the port printed by `opencode-gateway status` if it is not `4097`.
Prefer the token-file variable over embedding bearer tokens in config. The
Gateway MCP validates owner-only regular token files and fails closed on unsafe
paths or contents.

## Boundary notes

- Open Cowork should compose with Gateway through OpenCode-native MCP
  configuration. It should not mirror Gateway's scheduler, durable issue store,
  Mission Control, or channel runtime.
- Public upstream Open Cowork builds should not assume a local
  `opencode-gateway` checkout, daemon, token file, or dashboard exists.
- Downstream distributions may include a preconfigured Gateway MCP only when
  they also own the corresponding local service installation and support model.
- Cloud Web, Desktop Cloud workspaces, and Open Cowork Cloud APIs must not
  depend on a local OpenCode Gateway daemon.
