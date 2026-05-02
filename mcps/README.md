# Bundled MCP Servers

This directory contains MCP servers that ship with Open Cowork.

- `charts/` renders chart artifacts and exposes chart-generation tools.
- `skills/` manages local OpenCode skill bundles.

Each MCP is still an OpenCode-native MCP server. Open Cowork packages,
configures, and permission-scopes these servers; it does not replace
OpenCode's MCP execution model.

Build all bundled MCPs from the repo root:

```bash
pnpm build
```

Run package-specific builds from each MCP workspace when editing one:

```bash
pnpm --dir mcps/charts build
pnpm --dir mcps/skills build
```

Behavioral coverage for bundled MCP policy and helpers currently lives in
the root `tests/` suite and runs with `pnpm test`.

User-facing docs live in [`docs/skills-and-mcps.md`](../docs/skills-and-mcps.md).
