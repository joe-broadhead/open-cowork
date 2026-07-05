# Bundled MCP Servers

This directory contains MCP servers that ship with Open Cowork.

- `charts/` renders chart artifacts and exposes chart-generation tools.
- `clock/` resolves current time, timezone conversions, date ranges, durations, and calendar math.
- `skills/` manages local OpenCode skill bundles.
- `agents/` previews and manages custom OpenCode agents through the app bridge.
- `workflows/` previews and creates Open Cowork workflows through the app bridge.
- `knowledge/` proposes human-reviewed knowledge-base (wiki) edits through the app bridge.
- `semantic-ui/` reports UI status/snapshots and runs approval-gated local UI actions through the app bridge.
- `shared/` holds the bridge HTTP client (`shared/bridge.ts`) used by the bridge-backed MCPs above. It is not a workspace package: each MCP imports it by relative path (`../../shared/bridge.js`) and esbuild inlines it into that MCP's bundle. Host policy is explicit per MCP — agents, workflows, and semantic-ui are loopback-http-only, while knowledge additionally allows non-loopback https for its cloud runtime (`allowNonLoopbackHttps: true`).

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
pnpm --dir mcps/clock build
pnpm --dir mcps/skills build
pnpm --dir mcps/agents build
pnpm --dir mcps/workflows build
pnpm --dir mcps/knowledge build
pnpm --dir mcps/semantic-ui build
```

Each bundled MCP has a local contract test under `mcps/<name>/tests/`.
Run one package with `pnpm --filter ./mcps/<name> test`, or run the
full repo test suite with `pnpm test`.

User-facing docs live in [`docs/skills-and-mcps.md`](../docs/skills-and-mcps.md).
