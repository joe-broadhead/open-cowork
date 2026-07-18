# OpenCode Setup

Gateway is installed into an OpenCode profile as normal OpenCode assets.

## Installed Assets

Setup installs:

| Asset | Names |
| --- | --- |
| MCP server | `gateway` |
| Agents | `gateway-assistant`, `gateway-planner`, `gateway-coordinator`, `gateway-implementer`, `gateway-reviewer`, `gateway-verifier`, `gateway-supervisor`, `gateway-auditor` |
| Skills | `gateway-assistant`, `gateway-planner`, `gateway-coordinator`, `gateway-stage`, `gateway-review-gate`, `gateway-supervisor` |

The installer only ships Gateway-native assets. Optional MCPs such as GitHub, Google Workspace, Plaud, or Tavily remain user-managed additions to an OpenCode profile.

The setup wizard asks for planner and implement/audit models. Gateway-owned reviewer, verifier, and supervisor profiles default to OpenAI `gpt-5.5` with variant `xhigh`; reviewer and verifier also load `gateway-review-gate` so fresh installs match the profile drift checks.

## Profile Directory

Set `opencodeConfigDir` in `~/.config/opencode-gateway/config.json` when Gateway should install assets into a specific OpenCode profile:

```json
{
  "opencodeConfigDir": "/Users/you/.config/opencode-general"
}
```

If omitted, Gateway uses OpenCode's default config directory.

## Config Template

The repository includes a copyable OpenCode profile template:

```text
src/templates/opencode/opencode.jsonc
```

Skill templates live under:

```text
src/templates/skills/
```

## Reload Requirement

Restart OpenCode after setup or asset updates. OpenCode reads MCP, agent, and skill configuration when it starts.

## MCP Tool Tiers

Gateway exposes many `gateway_*` tools. Bound what any one agent sees with
`GATEWAY_MCP_TOOLS` in the MCP server environment:

| Mode | Surface |
| --- | --- |
| `read` | Inspection only: lists, gets, status, dashboard, observability, briefing, previews, redacted reports. |
| `operate` | Everything in `read` plus day-to-day work: task/roadmap lifecycle, delegation, channel sends, human gates, permission and question replies, scheduler pause/resume, backups. |
| `admin` | Everything, including config updates, profile/team mutation, OpenCode asset upserts and deletes, session aborts, restore, and restart. |

Tiers are cumulative and enforced at registration time — a `read`-tier agent
never learns that mutation tools exist. The default is `operate`; set
`GATEWAY_MCP_TOOLS=admin` only for an explicitly trusted operator surface.

Gateway-generated OpenCode config also passes `OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE`
to the local MCP process. The file path references the daemon credential provisioned by
setup; the bearer value is never copied into `opencode.jsonc`. MCP accepts token files only
when they are bounded owner-only regular files and fails closed on symlinks, unsafe modes,
ownership changes, oversized values, or embedded line breaks.

```jsonc
// opencode.jsonc — a research agent that can inspect but not mutate
{
  "mcpServers": {
    "gateway-read": {
      "command": "node",
      "args": ["/path/to/opencode-gateway/dist/mcp.js"],
      "env": {
        "GATEWAY_MCP_TOOLS": "read",
        "OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE": "/path/to/opencode-gateway-config/http-admin-token"
      }
    }
  }
}
```
