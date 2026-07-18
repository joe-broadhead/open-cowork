# HTTP API Reference

Run the server:

```sh
openwiki --root examples/basic-wiki serve
```

Useful endpoints:

- `GET /livez`
- `GET /readyz`
- `GET /metrics`
- `GET /openapi.json`
- `GET /mcp-manifest.json`
- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`
- `GET /api/v1/search?q=...`
- `POST /api/v1/ask`
- `POST /api/v1/proposals`
- `GET /api/v1/policy/preview`
- `GET /api/v1/auth/service-accounts`
- `POST /api/v1/auth/service-accounts`
- `POST /api/v1/auth/service-accounts/{id}/revoke`
- `POST /api/v1/auth/service-accounts/{id}/rotate`
- `POST /api/v1/publish`

The generated OpenAPI document is served at `/openapi.json` and included in
static exports.

`/readyz` returns `ready` only when the Git workspace and required derived
stores are healthy. `openwiki setup personal` and `openwiki setup team` build
those stores automatically; workspaces created with raw `init` should run
`openwiki index` and `openwiki db rebuild` before treating the server as ready.

`/mcp` is the Streamable HTTP MCP endpoint. `POST` accepts JSON-RPC messages and
returns either `application/json` or `text/event-stream`. `GET` opens a
server-to-client SSE stream for clients with an `MCP-Session-Id` from
`initialize`. Hosted clients should send `MCP-Protocol-Version: 2025-11-25` and
authenticate with service-account bearer tokens or trusted proxy identity
headers. MCP tool responses are bounded; oversized tool results return
truncation metadata instead of unbounded `structuredContent`.

Service-account list and inspect routes return sanitized metadata only. Create
and rotate responses return the raw bearer token exactly once; store it in a
secret manager and use list/inspect for later lifecycle checks.
