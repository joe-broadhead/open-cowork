# MCP Conformance Eval

This deterministic eval verifies OpenWiki as a local and hosted MCP server
without calling an external model provider.

Run from the repo root:

```sh
pnpm eval:mcp-conformance
```

The eval creates a temporary wiki, starts stdio MCP and Streamable HTTP MCP, and
checks:

- `tools/list` parity for `read`, `proposal`, and `write` modes
- stdio startup and JSON-RPC response handling
- HTTP `initialize`, `MCP-Session-Id`, SSE stream, and `DELETE` session cleanup
- service-account bearer-token auth for hosted proposal/write clients
- clear authorization denial for anonymous proposal attempts
- policy filtering for private pages
- search, read, and proposal-mode happy paths
- large tool-output truncation metadata and guidance

It is intended as a pre-release gate and as a regression harness for adding new
MCP tools or transport behavior.
