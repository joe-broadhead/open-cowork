---
name: diagnose-errors
description: "Investigate product or analytics errors using Amplitude behavioral and error signals."
allowed-tools: "mcp__amplitude__*"
metadata:
  owner: "cowork"
  provider: "amplitude"
  version: "1.0.0"
---

# Diagnose Errors

Use this skill when the user asks about an error spike, broken flow, or reliability issue.

Workflow:
- Identify the error signature and affected flow.
- Pull the relevant usage, funnel, and error context.
- Determine whether the issue is localized or systemic.
- Return likely causes, affected cohorts, and next checks.
