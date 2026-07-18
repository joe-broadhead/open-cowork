---
name: gateway-review-gate
description: Spec-driven review and verification gate for Gateway tasks across code, docs, slides, research, operations, and other deliverables.
license: MIT
compatibility: opencode
metadata:
  package: opencode-gateway
  role: review
---

# Gateway Review Gate

Use this skill during Gateway `review`, `verify`, and `audit` stages when a task has implementation artifacts, a `qualitySpec`, acceptance criteria, or a definition of done.

## Contract

Review and verification measure the work against the implementation spec, not against a software-only checklist.

Supported deliverables include code, documentation, slides, spreadsheets, research briefs, operations changes, external-system updates, and mixed artifacts.

## Review Mode

1. Identify the artifact type and intended outcome.
2. Read the task description, `qualitySpec`, acceptance criteria, constraints, required artifacts, required evidence, and definition of done.
3. Inspect the produced artifacts and prior stage evidence.
4. For code changes, apply autoreview-style scrutiny for correctness bugs, regressions, security issues, and missing tests.
5. For non-code artifacts, check completeness, factual support, audience fit, formatting constraints, required links/files, and stated delivery requirements.
6. Return `fail` with actionable feedback if material issues remain.
7. Return `blocked` with `needs_user_input` or `needs_credentials` when the spec, approval, credential, or external dependency is missing.

## Verify Mode

1. Use the smallest sufficient proof for the artifact type.
2. Run declared verification commands when applicable.
3. Inspect required files, links, screenshots, logs, or external records when commands are not the right proof.
4. Cite every acceptance criterion and definition-of-done item in artifacts, evidence, or decisions.
5. Return `pass` only when the evidence proves completion.
6. If proof fails because implementation is wrong, return `fail` with `failureClass: "implementation_failed"`.
7. If proof cannot run or evidence is unavailable, return `blocked` or `fail` with the specific next action.

## OpenCode Requests

Use OpenCode-native questions and permission requests when you need human input or approval. Gateway will surface those through Needs Attention, channels, MCP, and the dashboard. Do not create a separate request store.

## Required Final JSON

The final response must include a fenced JSON result compatible with Gateway stage parsing:

```json
{"status":"pass|fail|blocked","summary":"short result","feedback":"specific feedback for the next attempt if any","failureClass":"blocked|needs_user_input|needs_credentials|flaky_test|unsafe|exceeded_budget|unclear_spec|implementation_failed|verification_failed","artifacts":["short artifact refs"],"evidence":[{"type":"diff|test|command|link|screenshot|log|decision|file|note|other","ref":"file, command, URL, log path, or decision id","summary":"why it proves the implementation spec or definition of done"}],"decisions":["durable decisions made"]}
```
