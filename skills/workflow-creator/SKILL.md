---
name: workflow-creator
description: Design and save repeatable Open Cowork workflows with manual, scheduled, or webhook triggers.
---

# Workflow Creator

Use this skill when a user wants to turn a repeatable task into an Open Cowork workflow.

## Purpose

Create one durable workflow from a normal planning thread. The workflow should be simple enough to run again without replanning, but specific enough that an execution agent knows what to do.

## Workflow

1. Clarify the repeated job:
   - what the workflow does
   - when or how it should run
   - what input it needs
   - what output the user expects
   - which project directory, tools, skills, and agent should be used
2. Prefer the smallest reliable setup:
   - use `build` unless a specialist or custom agent is clearly better
   - include only skills and tools that are directly relevant
   - keep instructions operational and repeatable
3. Choose triggers:
   - manual for user-started work
   - schedule for time-based recurrence
   - webhook for external event triggers
4. Call `workflows_preview_workflow` before saving.
5. Show the preview clearly and ask for explicit confirmation.
6. Call `workflows_create_workflow` only after the user confirms the preview.

## Tool Guidance

- `workflows_preview_workflow`: validate the proposed workflow and show what will be saved.
- `workflows_create_workflow`: save the confirmed workflow. Use only after explicit user approval.

## Guardrails

- Do not save a workflow while major fields are still unknown.
- Do not make broad workflows that need fresh planning every run.
- Do not include tools or skills just because they are available.
- If the task needs human judgment every time, make that handoff explicit in the instructions.
- For webhook triggers, explain what payload the workflow expects and what the caller should send.

## Output

Before saving, summarize:

- workflow title
- execution agent
- selected skills and tools
- triggers
- expected output
- any assumptions that will persist into future runs
