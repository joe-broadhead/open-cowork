# Server UI

The server-rendered UI is the private team wiki surface for search, reading,
inline links, proposal review, history, and Spaces.

Run it locally:

```sh
openwiki --root examples/basic-wiki serve --host 127.0.0.1 --port 3030
```

The primary navigation stays wiki-first: Home, Pages, Proposals, and Admin when
the current identity has admin scope. Advanced graph, run, API, and raw policy
tools live under Admin.

Admin includes:

- Spaces & Permissions for Space cards, create/edit Space proposals, and access
  dry-runs.
- Service Accounts for sanitized token metadata, active/revoked/expired counts,
  and revoke actions. Raw service-account tokens are only shown by create and
  rotate API/CLI responses.
- Operations and agent/API links for graph, runs, OpenAPI, MCP manifest,
  liveness, readiness, and metrics.

## Hosted Write Mode

Write-capable browser deployments must sit behind a trusted authentication
boundary. Users sign in through SSO or a reverse proxy; OpenWiki receives
trusted identity headers or scoped service-account tokens. Server-rendered write
forms require same-origin POSTs, and any browser POST with an untrusted `Origin`
is rejected.

For public deployments, prefer static export or read-only viewer-scoped serving.
