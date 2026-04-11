---
name: triage-issue
description: "Search Jira for likely duplicate bugs, related incidents, and historical fixes, then help create a new issue or add context to an existing one. Use when the user wants bug triage or duplicate detection."
allowed-tools: "mcp__atlassian-rovo-mcp__*"
metadata:
  owner: "cowork"
  persona: "support"
  provider: "atlassian"
  version: "1.0.0"
---

# Triage Issue

## Mission

Take an error report or bug description, check Jira for duplicates or regressions, and help the user decide whether to update an existing issue or create a new one.

## Workflow

1. Extract the key signal.
- Pull out the error signature, affected component, user impact, and reproduction context.

2. Search Jira from multiple angles.
- Search by error message or signature.
- Search by component or subsystem.
- Search by symptom or user-visible behavior.

3. Classify the result.
- High-confidence duplicate
- Related but not identical
- Possible regression of an older resolved issue
- Likely net-new bug

4. Present the findings.
- Show the most relevant existing issues with status and links.
- Recommend either:
  - add a comment to an existing issue, or
  - create a new issue that references the related ones

5. Act only after confirmation.
- If the user wants to append to an existing issue, add a structured comment.
- If the user wants a new issue, create it with a clear summary, reproduction details, and references.

## Guardrails

- Do not silently create or update Jira issues.
- Prefer multiple targeted searches over one vague search.
- If evidence is weak, say so and avoid overclaiming a duplicate.

## Output Pattern

```md
## Triage Result
[Likely duplicate / Related / New issue]

## Matching Issues
- [PROJ-123](url) - [why it is relevant]

## Recommendation
[Add to existing issue / Create new issue]
```
