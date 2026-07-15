# OpenWiki CLI

[OpenWiki](https://github.com/langchain-ai/openwiki) is an optional external CLI
for generating and refreshing agent-friendly repository documentation. Current
OpenWiki releases are not bundled into Open Cowork as an MCP server.

Open Cowork keeps its built-in Knowledge area app-owned. Use OpenWiki when a
team wants a repo-local `openwiki/` documentation tree that can be reviewed,
committed, and kept fresh outside the app.

## Current integration posture

- Install OpenWiki separately with the upstream package (`npm install -g
  openwiki`, or your package manager equivalent).
- Run OpenWiki directly in the repository:

  ```sh
  openwiki --init
  openwiki --update
  ```

- Do not configure `openwiki mcp --stdio --tools proposal` as a default Open
  Cowork MCP. The current `openwiki` package exposes a documentation CLI and
  connector workflows; it does not advertise that stale MCP launcher as a
  supported server command.
- If a downstream deployment has a separate OpenWiki-compatible MCP service,
  add it as a downstream `mcps` entry with an explicit URL/command, auth mode,
  and tool allowlist. Do not make the public app depend on a local OpenWiki
  checkout.

## Boundary notes

- OpenWiki is an external documentation engine, like OpenCode is an external
  execution engine. Open Cowork may compose with it, but should not absorb or
  mirror its runtime behavior.
- The built-in Knowledge area remains the supported in-app proposal/review
  surface for product-managed knowledge.
- Cloud Web, Desktop, Gateway, and Cloud API must not couple to a local
  OpenWiki checkout.
