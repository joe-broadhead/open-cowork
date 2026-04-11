---
name: capture-tasks-from-meeting-notes
description: "Convert meeting notes or a Confluence meeting page into Jira tasks with sensible summaries, descriptions, and assignees. Use when the user wants action items extracted and turned into Jira work."
allowed-tools: "mcp__atlassian-rovo-mcp__*"
metadata:
  owner: "cowork"
  persona: "project-ops"
  provider: "atlassian"
  version: "1.0.0"
---

# Capture Tasks From Meeting Notes

## Mission

Extract action items from meeting notes and turn them into Jira tasks with clear assignees and context.

## Workflow

1. Get the notes.
- Accept pasted notes directly, or fetch the meeting notes from Confluence if the user gives a page URL.

2. Parse action items.
- Look for assignee patterns such as `@name`, `Name will ...`, `Action: Name - ...`, or `TODO: ... (Name)`.
- For each action item, capture:
  - assignee name
  - task summary
  - any useful meeting context

3. Ask for the Jira destination.
- Confirm the target Jira project before creating anything.

4. Resolve assignees.
- Use Atlassian directory or Jira user lookup tools where available.
- If a name is ambiguous or not found, ask instead of guessing.

5. Present the plan.
- Show the parsed tasks before creating them.
- Let the user skip, edit, or confirm the list.

6. Create the tasks.
- Create the Jira issues only after confirmation.
- Put the meeting context and original note text into the issue description when helpful.

## Guardrails

- Never create Jira work without showing the extracted list first.
- If assignees are unclear, ask.
- Keep summaries action-oriented and specific.

## Output Pattern

```md
I found these action items:

1. [Task summary]
   Assigned to: [Name]

2. [Task summary]
   Assigned to: [Name]

Should I create these in Jira?
```
