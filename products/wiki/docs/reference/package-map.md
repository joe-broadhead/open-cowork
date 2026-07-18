# Package Map

OpenWiki is a pnpm TypeScript monorepo. The generated package inventory,
internal dependency table, and export-shape details live in
[Package APIs](package-apis.md).

At a high level the packages fall into these layers:

- **Foundation:** `@openwiki/core`, `@openwiki/repo`, `@openwiki/policy`
- **Derived indexes and runtimes:** `@openwiki/search`,
  `@openwiki/index-store`, `@openwiki/postgres-runtime`,
  `@openwiki/storage`
- **Workflows and jobs:** `@openwiki/workflows`, `@openwiki/jobs`,
  `@openwiki/git`, `@openwiki/connectors`, `@openwiki/validation`,
  `@openwiki/harness-opencode`
- **Interfaces:** `@openwiki/cli`, `@openwiki/http-api`,
  `@openwiki/mcp-server`, `@openwiki/static-export`, `@openwiki/web`

The supported public contracts are the CLI, HTTP API, MCP tools, JSON schemas,
repository format, static export artifacts, and release artifacts. Workspace
package exports are private implementation APIs unless a future compatibility
policy explicitly promotes them.
