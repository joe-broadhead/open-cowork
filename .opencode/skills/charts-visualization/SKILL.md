---
name: charts-visualization
description: "Create interactive data visualizations and diagrams. Use when the user wants charts, graphs, maps, or diagrams to visualize data, trends, distributions, or workflows."
allowed-tools: "mcp__charts__bar_chart mcp__charts__line_chart mcp__charts__area_chart mcp__charts__scatter_plot mcp__charts__pie_chart mcp__charts__histogram mcp__charts__heatmap mcp__charts__boxplot mcp__charts__map mcp__charts__mermaid mcp__charts__custom_spec"
metadata:
  owner: "cowork"
  persona: "visualizer"
  version: "1.0.0"
---

# Charts & Visualization Skill

## Mission

Create clear, interactive data visualizations that help users understand patterns, trends, and relationships in their data.

## Chart Selection Guide

| Data question | Chart type | Tool |
|---------------|-----------|------|
| Compare categories | Bar chart | `bar_chart` |
| Show trend over time | Line chart | `line_chart` |
| Show composition over time | Area chart | `area_chart` |
| Show correlation between two values | Scatter plot | `scatter_plot` |
| Show proportions/shares | Pie/donut chart | `pie_chart` |
| Show data distribution | Histogram | `histogram` |
| Show values across two dimensions | Heatmap | `heatmap` |
| Compare distributions across groups | Box plot | `boxplot` |
| Show geographic data | Map | `map` |
| Show process/workflow | Mermaid diagram | `mermaid` |
| Custom/advanced | Custom Vega-Lite spec | `custom_spec` |

## Workflow

1. **Understand the data** — what fields are available, what types (numeric, categorical, temporal)
2. **Choose the right chart** — use the selection guide above
3. **Prepare the data** — format as array of objects with consistent field names
4. **Create the chart** — call the appropriate tool with data and field mappings
5. **Iterate** — adjust based on user feedback (different chart type, colors, grouping)

## Data Format

All chart tools accept data as an array of objects:
```json
[
  {"country": "France", "gmv": 170.5, "year": 2026},
  {"country": "Germany", "gmv": 111.8, "year": 2026}
]
```

## Tips

- Use `color` parameter to group/segment data by a category
- Line and area charts expect temporal x-axis — use ISO date strings
- Pie charts work best with 3-7 categories; group small ones as "Other"
- For large datasets, consider histogram or heatmap over scatter
- Mermaid supports: flowchart, sequence, gantt, class, state, ER diagrams

## Rules

1. Always label axes and provide a title
2. Use appropriate chart type for the data (don't force pie charts for non-proportional data)
3. When data comes from Nova queries, transform SQL results into the chart data format
