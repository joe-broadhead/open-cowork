---
name: diff-intake
description: "Turn a diff, branch, or PR into an analytics instrumentation change brief."
allowed-tools: "mcp__amplitude__*"
metadata:
  owner: "cowork"
  provider: "amplitude"
  version: "1.0.0"
---

# Diff Intake

Use this skill when analytics instrumentation needs to be planned from a code or product change.

Workflow:
- Read the change summary or diff.
- Identify impacted user actions, state changes, and funnels.
- Produce a compact brief of what analytics should observe.
- Hand off to instrumentation-specific skills when needed.
