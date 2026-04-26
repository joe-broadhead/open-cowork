---
name: chart-creator
description: Use the charts MCP to create clear charts from structured data, choosing the right chart tool and explaining the result.
---

# Chart Creator

Use this skill when the user asks for a chart, diagram, visual explanation, or chart-ready redesign.

## Core Rule

When the charts MCP is available, call the appropriate `charts_*` tool. Do not merely print a Vega-Lite spec or Mermaid source unless the user explicitly asks for raw source only.

## Workflow

1. Identify the question the chart must answer.
2. Reduce the data to a flat array of objects with clear field names.
3. Choose the simplest chart that shows the signal.
4. Call the matching charts MCP tool with the data.
5. Explain briefly what the chart shows and why that chart type was chosen.

## Tool Choice

- `charts_bar_chart`: category comparison or ranking. For horizontal bars, use `x` for the numeric value and `y` for the category.
- `charts_line_chart`: ordered trends over time, versions, months, weekdays, or ranks.
- `charts_area_chart`: composition over an ordered sequence.
- `charts_scatter_plot`: relationship between two numeric measures.
- `charts_pie_chart`: simple part-to-whole with a small category count; use `donut` for a cleaner share view.
- `charts_heatmap`: intensity by two dimensions.
- `charts_histogram` or `charts_boxplot`: distributions.
- `charts_funnel_chart`: ordered stage dropoff.
- `charts_waterfall_chart`: additive positive/negative contributions.
- `charts_bump_chart`: rank changes over time.
- `charts_sankey`: weighted flows between stages or categories.
- `charts_mermaid`: process, flow, sequence, or architecture diagrams rather than quantitative charts.
- `charts_custom_spec`: only when the standard tools cannot express the needed visual.

## Guardrails

- If data is missing, ask for it or explain exactly what fields are needed.
- Do not invent rows, units, source dates, or categories.
- Keep titles, units, labels, and caveats explicit.
- Prefer a readable chart over a decorative one.
- If a tool call fails validation, fix the input and retry once with complete data.
