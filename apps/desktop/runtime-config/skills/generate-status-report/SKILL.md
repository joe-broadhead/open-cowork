---
name: generate-status-report
description: "Generate Jira-based status reports and optionally publish them to Confluence. Use when the user wants a project update, weekly status, blocker summary, sprint report, or executive summary grounded in Atlassian work tracking."
allowed-tools: "mcp__atlassian-rovo-mcp__*"
metadata:
  owner: "cowork"
  persona: "delivery"
  provider: "atlassian"
  version: "1.0.0"
---

# Generate Status Report

## Mission

Turn Jira project activity into a clear status report, then offer to publish the result to Confluence.

## Required Interaction

This skill is interactive. If the request is underspecified, ask before publishing.

Clarify:
- Jira project or scope
- Time window
- Audience
- Whether the report should be published to Confluence

## Workflow

1. Define the scope.
- Identify the Jira project key or initiative.
- Confirm reporting period if the user did not specify one.
- Choose the audience: executive, team, or daily update.

2. Query Jira in focused slices.
- Pull recently completed work.
- Pull active work in progress.
- Pull blockers and high-priority open work.
- Prefer multiple smaller searches over one oversized query.

3. Analyze the results.
- Count total, completed, active, and blocked work.
- Identify standout accomplishments, risks, and bottlenecks.
- Keep the narrative grounded in actual issue data.

4. Format the report.
- Executive audience: concise summary, metrics, top risks.
- Team audience: more detailed workstream view.
- Daily update: short yesterday/today/blockers format.

5. Offer publication.
- Ask before creating or updating a Confluence page.
- If the user wants publication, identify the target space and page destination first.

## Guardrails

- Do not silently publish to Confluence.
- Do not overstate certainty when Jira data is incomplete.
- Keep the report short enough for the intended audience.

## Output Pattern

```md
## Overall Status
[On track / At risk / Blocked]

## Metrics
- Completed: X
- In progress: Y
- Blocked: Z

## Highlights
- [Highlight]

## Risks / Blockers
- [Risk]

## Sources
- [Jira search or report source]
```
