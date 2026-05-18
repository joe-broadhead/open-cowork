---
name: chart-creator
description: Use the charts MCP to create clear, truthful, well-labeled data visualizations from structured data, including correct chart choice, chronological date axes, readable labels, and concise interpretation.
---

# Chart Creator

Use this skill when the user asks for a chart, diagram, visual explanation, or chart-ready redesign.

## Core Rule

When the charts MCP is available, call the appropriate `mcp__charts__*` tool. Do not merely print a Vega-Lite spec or Mermaid source unless the user explicitly asks for raw source only.

## Workflow

1. Identify the question the chart must answer.
2. Reduce the data to a flat array of objects with clear field names and one row per plotted mark.
3. Validate the grain, units, ordering, and category count before plotting.
4. Choose the simplest chart that shows the signal without distorting it.
5. Call the matching charts MCP tool with complete inline data.
6. Explain briefly what the chart shows and any caveat needed to read it correctly.

## Tool Choice

- `mcp__charts__line_chart`: default for ordered trends over dates, times, weeks, months, versions, or ranks.
- `mcp__charts__bar_chart`: category comparison or ranking. Use bars for dates only when discrete daily/weekly/monthly magnitudes are the point; keep dates chronological, not value-sorted. For horizontal bars, use `x` for the numeric value and `y` for the category.
- `mcp__charts__area_chart`: magnitude or composition over an ordered sequence; use only when filled area helps, not for ordinary single-series trends.
- `mcp__charts__scatter_plot`: relationship between two numeric measures.
- `mcp__charts__pie_chart`: simple part-to-whole with a small category count; use `donut` for a cleaner share view.
- `mcp__charts__heatmap`: intensity by two dimensions.
- `mcp__charts__map`: geographic points with latitude and longitude fields; use only when location is the primary dimension.
- `mcp__charts__histogram` or `mcp__charts__boxplot`: distributions.
- `mcp__charts__funnel_chart`: ordered stage dropoff.
- `mcp__charts__waterfall_chart`: additive positive/negative contributions.
- `mcp__charts__bump_chart`: rank changes over time.
- `mcp__charts__streamgraph`: centered stacked areas for composition changing over time; avoid when ordinary stacked areas are clearer.
- `mcp__charts__calendar_heatmap`: daily intensity across weeks/months/years when the calendar pattern matters.
- `mcp__charts__bullet_chart`: actual vs target with optional qualitative ranges.
- `mcp__charts__candlestick_chart`: open, high, low, close values across a time axis.
- `mcp__charts__sankey`: weighted flows between stages or categories.
- `mcp__charts__mermaid`: process, flow, sequence, or architecture diagrams rather than quantitative charts.
- `mcp__charts__custom_spec`: only when the standard tools cannot express the needed visual.

## Data Viz Standards

- Time series must be chronological. Do not sort dates by value unless the user explicitly asks for a ranking.
- Use ISO date strings (`YYYY-MM-DD`) for date-only fields. Use explicit ISO instants with offsets for timestamp fields.
- For "daily", "weekly", or "monthly" metrics, keep the x-axis at that calendar grain; do not allow time-of-day labels on date-only charts.
- Prefer line charts for trends. Prefer bars for categorical comparison. Prefer horizontal bars for long labels.
- Keep one metric per y-axis unless a shared unit makes comparison honest. Avoid dual axes unless explicitly requested.
- Use human-readable titles that include metric, segment, and date range when known.
- Label axes with the actual field meaning and unit, for example `sessions`, `revenue_usd`, `conversion_rate_pct`, or `date`.
- Use color for grouping or emphasis, not decoration. Avoid redundant color when there is only one series.
- If there are too many categories, show the top categories plus an "Other" bucket only when the aggregation is explicit.
- If the table is clearer than a chart, say so and provide the table instead of forcing a visual.

## Guardrails

- If data is missing, ask for it or explain exactly what fields are needed.
- Do not invent rows, units, source dates, or categories.
- Keep titles, units, labels, and caveats explicit.
- Prefer a readable chart over a decorative one.
- Never hide a sorting, filtering, grouping, or aggregation choice; state it briefly.
- If a tool call fails validation, fix the input and retry once with complete data.
