---
name: chart-creator
description: Use the charts MCP well: choose the right chart tool, prepare chart-ready data, and explain the output clearly.
---

# Chart Creator

Use this skill when a task needs a chart, diagram, or visual explanation built with the local charts MCP.

## Purpose

- Turn structured findings into the clearest possible visual.
- Pick the correct charts MCP tool instead of forcing everything through one chart type.
- Prefer simple, legible visuals over decorative complexity.
- Explain what the visual shows, why that chart type was chosen, and what the user should notice.

## Available tools

- `bar_chart`
  Use for category comparisons. Inputs: `data`, `x`, `y`, optional `color`, optional `horizontal`.
- `line_chart`
  Use for trends over time. Inputs: `data`, `x`, `y`, optional `color`. The `x` field should be temporal or time-like.
- `area_chart`
  Use for composition over time, especially stacked series.
- `scatter_plot`
  Use for relationships between two numeric measures. Optional `color` and `size`.
- `pie_chart`
  Use only for simple part-to-whole comparisons with a small number of categories. Optional `donut`.
- `histogram`
  Use for one numeric distribution. Inputs: `field`, optional `bins`.
- `heatmap`
  Use for intensity across two dimensions. Inputs: `x`, `y`, `value`.
- `boxplot`
  Use to compare distributions across categories.
- `map`
  Use when the data includes latitude and longitude.
- `mermaid`
  Use for process diagrams, flows, or sequences rather than quantitative charts.
- `custom_spec`
  Use only when the standard tools above are not enough and you truly need a custom Vega-Lite spec.

## Workflow

1. Confirm the exact question the visual needs to answer.
2. Reduce the data to the minimum rows and fields needed for that visual.
3. Make the data chart-ready:
   - use a flat array of objects
   - use clear field names
   - avoid deeply nested or mixed-shape records
   - aggregate first if the comparison is at a higher grain
4. Pick the MCP tool that matches the analytical task:
   - `line_chart` for change over time
   - `bar_chart` for category comparisons
   - `area_chart` for composition over time
   - `scatter_plot` for numeric relationships
   - `histogram` for one-variable distributions
   - `heatmap` for two-dimensional intensity
   - `boxplot` for distribution comparisons
   - `map` for geographic points
   - `mermaid` for process or structure
5. Pass the exact field names the tool expects.
6. Use a clear title. Override width and height only when the default layout would be obviously poor.
7. Return the visual plus a concise explanation of the key takeaway.

## Guardrails

- Do not use `pie_chart` when there are many categories, tiny differences, or a ranked bar chart would be clearer.
- Do not use `line_chart` or `area_chart` unless the x-axis is genuinely ordered and time-like.
- Do not overload one chart with multiple unrelated comparisons.
- Do not jump to `custom_spec` first. Use the standard chart tools unless they clearly cannot express the needed visual.
- If the data is incomplete, ambiguous, or not chart-ready, say so before charting.
- If a table is clearer than a chart, say that explicitly instead of forcing a visual.
- When using `mermaid`, keep the syntax valid and the diagram minimal.

## Output Shape

- One short sentence on why this visual type was chosen.
- The chart or diagram output.
- Two or three bullets describing the key signal the user should notice.
