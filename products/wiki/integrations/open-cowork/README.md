# OpenWiki Open Cowork Pack

This pack lets Open Cowork use OpenWiki as a normal knowledge capability
instead of a built-in special case.

It provides:

- Open Cowork `mcps` entries for local stdio and remote HTTP OpenWiki
  servers.
- An Open Cowork `tools` policy fragment with the current read/proposal tool
  inventory.
- Skills that teach agents how to search, cite, propose edits, and ingest
  artifacts through OpenWiki.
- Agent loadouts for researcher, editor, and reviewer roles.
- Workflow recipes for common wiki operations.

Default trust posture:

- Read tools are safe for normal project agents.
- Proposal tools should ask for approval.
- Write workflow tools should be reserved for trusted maintainers.

## Local MCP

Use `mcp/openwiki.local.json` inside Open Cowork's top-level `mcps` array when
OpenWiki is available in the same workspace:

```json
{
  "name": "openwiki",
  "type": "local",
  "authMode": "none",
  "command": ["openwiki", "mcp", "--stdio", "--tools", "proposal"]
}
```

## Remote MCP

Use `mcp/openwiki.remote.json` inside Open Cowork's top-level `mcps` array for
hosted deployments:

```json
{
  "name": "openwiki",
  "type": "remote",
  "authMode": "api_token",
  "url": "https://wiki.company.com/mcp?tools=proposal",
  "headers": {
    "MCP-Protocol-Version": "2025-11-25"
  },
  "headerSettings": [
    { "header": "Authorization", "key": "proposalToken", "prefix": "Bearer " }
  ]
}
```

Hosted OpenWiki MCP access requires an explicit service-account bearer token or
trusted proxy identity. The bundled remote fragment models the bearer-token
path with an `OPENWIKI_PROPOSAL_TOKEN` credential and the current MCP protocol
version header.

## Tool Policy

Use `tools/openwiki.json` inside Open Cowork's top-level `tools` array. It maps
OpenWiki read-mode tools to `allowPatterns` and proposal-mode tools to
`askPatterns`. Write-mode tools are deliberately absent from this pack and
should be added only to maintainer-specific deployments.

## Agents

Use `agents/*.json` inside Open Cowork's top-level `agents` array. They are
current Open Cowork configured-agent definitions (`name`, `description`,
`instructions`, `skillNames`, and `toolIds`) rather than conceptual loadouts.
