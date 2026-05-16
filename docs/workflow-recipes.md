---
title: Workflow Recipes
description: Practical thread-native workflow examples.
---

# Workflow Recipes

These examples show how to describe repeatable work to Workflow Designer. You
do not fill out a long workflow form. You start a setup thread, iterate until
the task is clear, preview the saved definition, then confirm.

## Daily Repo Digest

Use this when you want a short daily summary of repository activity.

Start the setup thread with:

```text
Create a workflow that runs every weekday at 09:00. It should summarize
commits, PRs, and issue activity for this repo over the previous 24 hours.
The output should be a one-paragraph digest plus three things worth a closer
look. Use the build agent and repo/GitHub tools.
```

Expected saved workflow:

| Field | Value |
|---|---|
| Trigger | Daily schedule |
| Agent | `build` |
| Skills/tools | Git or GitHub tools if available |
| Output | Digest in the run thread |

Daily runs appear on the Workflows page. Open the latest run to inspect the
full transcript and tool calls.

## PR Triage

Use this when you want recurring review help without creating a separate board.

Start with:

```text
Create a weekday workflow that scans open PRs on this repo and identifies
which ones need human attention. For each PR, include the link, suggested
action, and one-line reason. Do not modify code.
```

Good clarifying questions from Workflow Designer:

- Which repo or project directory should it use?
- Which PR states count as "needs attention"?
- Should stale PRs use a specific age threshold?
- Should the output be grouped by owner, status, or urgency?

After you confirm the preview, scheduled runs execute as normal OpenCode
threads.

## Weekly Metrics Report

Use this when a report should recur and may need charts.

Start with:

```text
Create a workflow for Monday 07:00 that generates the weekly metrics report.
Pull the configured metrics, render the standard charts, and produce a concise
markdown summary for leadership. Use the analyst/data skills and charts tool
if available.
```

Expected saved workflow:

| Field | Value |
|---|---|
| Trigger | Weekly schedule |
| Agent | analyst custom agent or `build` |
| Skills/tools | analyst/data skill, charts MCP, data-source MCP |
| Output | Markdown summary and chart artifacts in the run thread |

## Webhook Ticket Enrichment

Use this when another system should trigger work.

Start with:

```text
Create a workflow that runs from a webhook. The JSON payload will include
ticket_id, customer_name, and issue_summary. The workflow should enrich the
ticket with related context, draft a response, and return the result in the
run thread. It should not send the response automatically.
```

After saving, copy the webhook curl example from the workflow card and POST
JSON with the generated secret in an authorization header:

```bash
curl -X POST "$WEBHOOK_URL" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $WEBHOOK_SECRET" \
  -d '{"ticket_id":"T-123","customer_name":"Acme","issue_summary":"Login failures"}'
```

The trigger payload is included in the run prompt.

## Good Workflow Shape

Strong workflows have:

- one clear outcome
- explicit trigger behavior
- a named consumer for the output
- known tools or skills when they matter
- a project directory only when the task needs real filesystem access
- a clear "do not do" boundary for sensitive actions

Avoid mega-workflows. If one saved task is trying to triage PRs, produce a
metrics report, and draft customer emails, split it into separate workflows.

## Read Next

- [Workflows](workflows.md)
- [Skills & MCPs](skills-and-mcps.md)
- [Configuration](configuration.md)
