---
name: analyze-chart
description: "Explain a specific Amplitude chart, including trends, anomalies, drivers, and follow-up questions."
allowed-tools: "mcp__amplitude__*"
metadata:
  owner: "cowork"
  provider: "amplitude"
  version: "1.0.0"
---

# Analyze Chart

Use this skill when the user shares or references a chart and wants to know what it means.

Workflow:
- Retrieve the chart and understand the metric, filters, and grouping.
- Identify notable trends, step changes, and anomalies.
- Test likely explanations with adjacent context if needed.
- Return a concise interpretation plus next actions.
