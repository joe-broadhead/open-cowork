# @open-cowork/mcp-charts

Bundled MCP server for generating chart artifacts from agent-provided data.

The desktop app packages this server as a local stdio MCP. It returns either
Vega/Vega-Lite specs or Mermaid syntax for Open Cowork's sandboxed chart
renderer to display.

## Security Model

- Tool schemas cap tabular input at 50,000 rows.
- Custom Vega-Lite specs are bounded by byte size, array item count, object
  count, and depth.
- External resource keys (`url`, `href`, `src`) and image marks are rejected.
- Sankey output is capped at 1,000 unique nodes.
- The desktop renderer applies a second inline-spec validation pass before
  static SVG rendering and inside the chart iframe before `vega-embed` runs.

## Development

```bash
pnpm --filter ./mcps/charts build
pnpm test -- tests/charts-mcp-schema.test.ts tests/sankey-chart.test.ts
```
