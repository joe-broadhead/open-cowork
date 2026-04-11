---
name: debug-replay
description: "Use replay and analytics signals together to debug a user session or workflow issue."
allowed-tools: "mcp__amplitude__*"
metadata:
  owner: "cowork"
  provider: "amplitude"
  version: "1.0.0"
---

# Debug Replay

Use this skill when the user wants to understand what went wrong in a specific user session.

Workflow:
- Pull the replay or target session context.
- Reconstruct the key steps and breakpoints.
- Cross-check with analytics and error signals.
- Summarize the likely failure path and next investigation steps.
