---
name: spec-to-backlog
description: "Convert a Confluence specification or requirements document into a Jira epic and structured implementation backlog. Use when the user wants a spec broken down into actionable Jira work."
allowed-tools: "mcp__atlassian-rovo-mcp__*"
metadata:
  owner: "cowork"
  persona: "product"
  provider: "atlassian"
  version: "1.0.0"
---

# Spec to Backlog

## Mission

Read a Confluence spec, propose a sensible Epic plus implementation tickets, get confirmation, then create the backlog in Jira.

## Workflow

1. Fetch the source spec.
- Use the Confluence page the user provided, or search for the spec if the title is given.

2. Ask for the Jira project.
- Confirm the target Jira project key before creating issues.

3. Break down the work.
- Identify the Epic-level goal first.
- Then create a small set of concrete tickets that cover implementation, integration, testing, and rollout work.
- Prefer clear, independently actionable tickets over vague umbrellas.

4. Present the breakdown.
- Show the Epic title and the proposed child tickets before creating anything.
- Let the user adjust scope or wording.

5. Create the Epic first.
- Capture the created Epic key.

6. Create the child issues.
- Link each ticket to the Epic.
- Use the most appropriate issue type available in the project.

## Guardrails

- Always create the Epic before child tickets.
- Do not create the backlog until the user confirms the breakdown.
- If the spec is thin or ambiguous, create fewer, broader tickets and say why.

## Output Pattern

```md
## Proposed Epic
[Epic title]

## Proposed Tickets
1. [Ticket]
2. [Ticket]
3. [Ticket]

Shall I create these in Jira?
```
