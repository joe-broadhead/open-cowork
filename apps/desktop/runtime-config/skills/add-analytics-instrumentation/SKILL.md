---
name: add-analytics-instrumentation
description: "Run a full analytics instrumentation workflow for a feature, branch, PR, or diff using Amplitude MCP."
allowed-tools: "mcp__amplitude__*"
metadata:
  owner: "cowork"
  provider: "amplitude"
  version: "1.0.0"
---

# Add Analytics Instrumentation

Use this skill when the user wants end-to-end instrumentation planning.

Workflow:
- Inspect the feature, diff, or flow.
- Discover existing event patterns first.
- Propose the highest-value events and properties.
- Turn them into a concrete instrumentation plan with exact surfaces and rationale.

Guardrails:
- Reuse existing naming conventions before inventing new taxonomy.
- Prioritize the smallest event set that answers the product question.
