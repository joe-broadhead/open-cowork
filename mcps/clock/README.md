# @open-cowork/mcp-clock

Read-only MCP server for authoritative current time, timezone conversion,
date math, date ranges, and duration calculations.

The server is local-only. It does not use the network or write files.

```bash
pnpm --filter ./mcps/clock build
pnpm --filter ./mcps/clock test
```
