---
name: gateway-stage
description: Execute a Gateway scheduler stage and return the required structured stage result.
license: MIT
compatibility: opencode
metadata:
  package: opencode-gateway
  role: execution
---

# Gateway Stage Worker

Use this skill when executing a Gateway scheduler stage in OpenCode.

## Contract

Gateway owns scheduling and task state. OpenCode owns the actual agent runtime, tools, MCPs, model execution, questions, permissions, and session history.

Do the assigned stage only. Do not claim the whole task is complete unless this is the final verification stage and the evidence supports it.

Tasks are not always software tasks. They may produce code, docs, slides, research, operations changes, external-system updates, or mixed artifacts. Measure stage success against the task description, `qualitySpec`, acceptance criteria, constraints, required artifacts, required evidence, and definition of done.

## Stage Behavior

- `implement`: make the requested change and provide artifacts/evidence for review.
- `review`: compare the work to the implementation spec and definition of done. For code, also identify bugs, risks, missing tests, regressions, and unclear behavior. Fail if material issues remain.
- `verify`: run or inspect the smallest sufficient proof for the artifact type. Pass only with sufficient evidence for the spec and definition of done.
- `audit`: assess production readiness and broader operational risks.
- `plan`: clarify approach, dependencies, and acceptance criteria.

## Required Final Output

Finish with a fenced JSON object:

```json
{"status":"pass|fail|blocked","summary":"short result","feedback":"specific feedback for the next attempt if any","failureClass":"blocked|needs_user_input|needs_credentials|flaky_test|unsafe|exceeded_budget|unclear_spec|implementation_failed|verification_failed","artifacts":["short artifact refs"],"evidence":[{"type":"diff|test|command|link|screenshot|log|decision|file|note|other","ref":"file, command, URL, log path, or decision id","summary":"why it matters"}],"decisions":["durable decisions made"]}
```

## Rules

- Use `blocked` when you need user input, credentials, missing context, or an external dependency.
- Use OpenCode-native questions and permission requests for human input or approval; Gateway surfaces them through Needs Attention, channels, MCP, and the dashboard.
- Use `fail` when the stage found fixable issues.
- Use `pass` only when this stage's requirements are met.
- Set `failureClass` for every `fail` or `blocked` result.
- Put actionable retry instructions in `feedback`.
- List short refs in `artifacts` and structured proof in `evidence`.
- If the task has acceptance criteria, definition-of-done items, constraints, required verification commands, required evidence, or required artifacts, cite matching proof before returning `pass`.
