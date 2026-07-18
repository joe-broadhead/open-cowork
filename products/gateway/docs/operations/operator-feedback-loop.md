# Operator Feedback Loop

Use this loop whenever an operator reports friction, confusion, missing behavior, or a product idea. The goal is to turn operator memory and chat fragments into durable Linear issues, tracked evidence, and release decisions without adding another external service.

This loop uses existing Gateway surfaces:

- Gateway evidence from CLI, MCP tools, Mission Control, logs, and redacted channel transcripts.
- Linear issues, comments, labels, milestones, and links as the durable product backlog.
- The release docs and claim registry that already decide whether a claim can move forward.

## Feedback Categories

Choose exactly one primary category. Add secondary categories in the notes only when they change routing.

| Category | Use when | Typical triage target |
| --- | --- | --- |
| `blocker` | The operator cannot complete a local-beta workflow, loses durable work, cannot recover, or sees a trust/security issue. | Beta-blocking issue. |
| `defect` | Existing behavior is wrong, flaky, duplicated, stale, misleading, or regressed. | Beta-blocking or hardening, depending on impact. |
| `confusion` | The operator can continue but cannot tell what happened, what to do next, or which identity/state is canonical. | Hardening unless it hides a blocker. |
| `missing affordance` | The product has enough state to act, but the operator lacks a button, command, link, filter, or visible next action. | Hardening or backlog. |
| `workflow request` | The operator needs a repeatable flow that spans existing surfaces or commands. | Hardening when it affects WF1-WF7; otherwise backlog. |
| `docs gap` | The behavior exists, but setup, usage, evidence, or recovery instructions are absent or stale. | Hardening when it affects beta operation; otherwise backlog. |
| `future idea` | The request is useful but not needed for current local-beta trust, recovery, or release evidence. | Backlog. |

## Capture Record

Capture feedback at the point of friction. A record can live first in a dogfood scorecard row, a Linear comment, or a new Linear issue, but it must use this shape before triage is complete:

```text
Title: [Operator feedback][WFx or surface] Short observable friction

Category: blocker / defect / confusion / missing affordance / workflow request / docs gap / future idea
Workflow: WF1/WF2/WF3/WF4/WF5/WF6/WF7 / cross-workflow / not tied to golden workflow
Surface: TUI / OpenCode Web / Mission Control / CLI / MCP / Telegram / WhatsApp / Discord / docs / setup / scheduler / release
Severity: critical / high / medium / low
Observed:
Expected:
Reproduction:
Evidence:
- commit:
- command or route:
- trace path:
- log, event, screenshot, or transcript path:
- Issue/Run/Session/Channel IDs:
Desired outcome:
Secrets review: redacted / no private content included / not applicable
Reporter:
Date:
Triage decision: beta-blocking / hardening / backlog / duplicate / accepted limitation
Linear link:
Milestone or release gate:
Rerun or verification:
```

Required fields for intake are `Category`, `Workflow`, `Surface`, `Severity`, `Observed`, `Evidence`, and `Desired outcome`. If reproduction is unknown, write `not yet reproducible` and include the closest available evidence. Do not paste raw private messages, credentials, provider tokens, or unredacted personal data into Linear.

## Capture Paths

Use the smallest durable path that preserves evidence.

| Situation | Capture path | Follow-up |
| --- | --- | --- |
| During a daily dogfood run | Add a scorecard note and create or update a Linear issue before ending the run. | Link the scorecard evidence from the Linear issue. |
| During setup or onboarding | Create a Linear issue from the capture record and link the command output or docs page. | Update onboarding docs if the fix is procedural. |
| During channel use | Redact the transcript, capture channel binding IDs, and link Gateway events or evidence-export output. | File one issue per product failure, not one per message. |
| During release review | Comment on the release issue or open a blocking Linear issue when the release decision changes. | Link the release decision and validation evidence. |
| During an agent-run task | Add the capture record to the task report and file Linear before claiming completion. | Include the Linear ID in the PR or final report. |

Do not create a new spreadsheet, chat-only tracker, or external database. Linear is the durable tracker; Gateway artifacts and docs are the evidence sources.

## Triage Checklist

Run this checklist before assigning a decision:

- The record names the workflow and surface where the operator hit friction.
- The category is one of the defined feedback categories.
- Severity reflects operator impact, not implementation size.
- Evidence includes at least one durable reference: commit, command, route, trace path, log/event excerpt, screenshot path, transcript excerpt, or Gateway ID.
- The desired outcome describes the operator-visible result, not only an implementation guess.
- Secrets and private content are redacted.
- Existing Linear issues were searched by workflow, surface, category, and key IDs before opening a new issue.
- The issue links related dogfood scorecard rows, acceptance criteria, milestone, PR, or release decision when available.
- The next validation step is explicit, including which workflow or command to rerun.

## Decision Rubric

Use the highest applicable decision. When uncertain between two decisions, choose the stricter one until evidence proves the risk is lower.

| Decision | Choose when | Required action |
| --- | --- | --- |
| `beta-blocking` | Any WF1-WF7 pass condition fails; setup cannot proceed; work identity forks or disappears; durability, recovery, security, review evidence, or trusted-channel progress is broken; or an operator cannot decide what to do next during a critical path. | File or update a Linear issue immediately, mark it against the local-beta milestone or release gate, stop claiming the affected workflow as passed, and rerun from the failed workflow after the fix. |
| `hardening` | The workflow can complete, but the friction weakens trust, repeatability, observability, docs, or daily dogfood speed. | File or update a Linear issue, attach evidence, assign to the next hardening milestone or current beta stabilization bucket, and verify with the affected workflow or docs build. |
| `backlog` | The feedback is valuable but does not affect current beta workflows, release evidence, security, recovery, or operator trust. | File or label as backlog/future, keep the desired outcome, and do not block release decisions. |
| `duplicate` | A live Linear issue already covers the same workflow, surface, and desired outcome. | Add the new evidence as a comment to the existing issue and link the duplicate record. |
| `accepted limitation` | The behavior is explicitly documented as out of scope and does not block the current run. | Add the evidence to the scorecard or release notes and link the existing limitation or issue. |

Severity guidance:

| Severity | Meaning |
| --- | --- |
| `critical` | Blocks local-beta operation, risks data/security trust, loses work, or invalidates release evidence. |
| `high` | Blocks a daily workflow but has a clear workaround that preserves evidence and safety. |
| `medium` | Slows or confuses an operator while the workflow remains recoverable. |
| `low` | Cosmetic, wording, convenience, or future-product feedback. |

## Linear Mapping

Every actionable record should end in one of these Linear states:

| Feedback decision | Linear shape | Milestone/release connection |
| --- | --- | --- |
| Beta-blocking | One issue per blocking outcome, linked to the failed workflow and evidence. | Attach to the local-beta milestone or release gate; release cannot claim that workflow until resolved or explicitly accepted. |
| Hardening | One issue per repeatable friction pattern, grouped by surface when useful. | Attach to the beta hardening milestone or the next stabilization batch. |
| Backlog/future | One issue or project note with category and desired outcome. | Keep out of release-blocking milestones unless reprioritized. |
| Duplicate | Existing issue comment with new evidence. | Preserve original milestone and add new release evidence if it changes risk. |
| Accepted limitation | Existing issue or scorecard note. | Mention in release notes when it affects operator expectations. |

Linear issue titles should start with `[Local beta]` for beta-blocking and hardening work. Add the workflow ID when one applies, for example `[Local beta][WF3] Telegram progress receipt is not traceable`.

## Release Decisions

Before a local-beta or release-candidate decision, review open feedback by decision:

- Release is blocked when any `beta-blocking` issue remains open for the workflows being claimed.
- Release may proceed with `hardening` issues only when the release notes name the risk, workaround, and follow-up milestone.
- `backlog` and `future idea` records do not block release, but they should remain searchable by category and surface.
- A release decision should link the current feedback query, blocking issue list, accepted limitations, and validation evidence.
- When a fix lands, rerun the affected workflow or command and comment the result on the Linear issue before closing it.

## Example Records

### WF3 Trusted Channel Progress Is Missing

```text
Title: [Operator feedback][WF3] Telegram accepted work but no progress receipt reached parent session

Category: defect
Workflow: WF3
Surface: Telegram, Mission Control, OpenCode TUI
Severity: critical
Observed: Trusted Telegram accepted the delegated task, but Mission Control showed no delegation.progress receipt and the parent TUI session had no callback.
Expected: The trusted channel and parent session both show the same task/run progress receipt.
Reproduction: Run WF3 from the daily dogfood runbook with Telegram configured, then inspect Mission Control events for the delegated task.
Evidence:
- commit: abc1234
- command or route: /dashboard events filtered by task_123
- trace path: ~/.config/opencode-gateway/dogfood-traces/2026-06-15-wf3.json
- log, event, screenshot, or transcript path: dogfood-evidence/wf3-progress-redacted.png
- Issue/Run/Session/Channel IDs: task_123, run_456, session_789, channel_telegram_alpha
Desired outcome: A trusted Telegram delegation always records progress evidence visible in Mission Control and the parent session.
Secrets review: transcript redacted
Reporter: local-beta operator
Date: 2026-06-15
Triage decision: beta-blocking
Linear link:
Milestone or release gate: local-beta WF3 gate
Rerun or verification: rerun WF3 from step 4 after fix
```

### WF2 Dashboard Needs A Clear Next Action

```text
Title: [Operator feedback][WF2] Mission Control shows degraded readiness without a next action

Category: confusion
Workflow: WF2
Surface: Mission Control
Severity: medium
Observed: The dashboard showed readiness degraded, but the attention card did not explain whether the operator should restart, inspect logs, or ignore the warning.
Expected: Degraded readiness includes a specific next action and evidence source.
Reproduction: Start Gateway with a stale run lease fixture, open /dashboard, and inspect Overview.
Evidence:
- commit: abc1234
- command or route: http://127.0.0.1:4097/dashboard
- trace path: not applicable
- log, event, screenshot, or transcript path: dogfood-evidence/wf2-readiness-next-action.png
- Issue/Run/Session/Channel IDs: run_stale_1
Desired outcome: The operator can tell what is wrong and which command or page to inspect next.
Secrets review: no private content included
Reporter: local-beta operator
Date: 2026-06-15
Triage decision: hardening
Linear link:
Milestone or release gate: beta hardening
Rerun or verification: open Mission Control with stale lease fixture and confirm the next action is visible
```

### Setup Docs Miss OpenCode Restart Step

```text
Title: [Operator feedback][WF1] Setup completed but OpenCode did not load Gateway MCP until restart

Category: docs gap
Workflow: WF1
Surface: docs, setup, OpenCode TUI
Severity: high
Observed: The operator ran setup successfully, then OpenCode TUI could not see gateway_* tools because OpenCode was already running.
Expected: Onboarding tells the operator to restart OpenCode after setup when needed.
Reproduction: Run setup while OpenCode is open, then ask TUI for Gateway tool status before restarting.
Evidence:
- commit: abc1234
- command or route: opencode-gateway setup --yes
- trace path: not applicable
- log, event, screenshot, or transcript path: dogfood-evidence/wf1-setup-mcp-redacted.txt
- Issue/Run/Session/Channel IDs: session_setup_1
Desired outcome: Day-zero setup docs and setup output make the restart requirement unmissable.
Secrets review: no private content included
Reporter: local-beta operator
Date: 2026-06-15
Triage decision: hardening
Linear link:
Milestone or release gate: beta hardening
Rerun or verification: docs build plus fresh WF1 setup pass
```

### Future Multi-Operator Dashboard View

```text
Title: [Operator feedback][Mission Control] Show multiple operators on the dashboard

Category: future idea
Workflow: not tied to golden workflow
Surface: Mission Control
Severity: low
Observed: A second operator wanted to see separate ownership lanes on the dashboard.
Expected: Future hosted or team mode can distinguish operator-owned work.
Reproduction: Not applicable; product idea from local-beta planning.
Evidence:
- commit: abc1234
- command or route: not applicable
- trace path: not applicable
- log, event, screenshot, or transcript path: planning note linked in Linear
- Issue/Run/Session/Channel IDs: not applicable
Desired outcome: Multi-operator work is visible without confusing single-user local Gateway state.
Secrets review: not applicable
Reporter: local-beta operator
Date: 2026-06-15
Triage decision: backlog
Linear link:
Milestone or release gate: none; future hosted/team mode
Rerun or verification: product design review before implementation
```

## Agent Runbook

An agent can run this loop by following these steps:

1. Copy the capture record and fill every required field from Gateway evidence, redacted operator notes, or Linear context.
2. Apply the triage checklist and decision rubric.
3. Search Linear for an existing issue by workflow, surface, category, and key IDs.
4. Create a new issue or comment on the existing issue.
5. Link the issue from the scorecard, PR, release decision, or acceptance evidence.
6. State the rerun point and validation command before marking the triage complete.

Completion means the feedback is no longer only in chat memory: it has a category, decision, durable Linear link, evidence, desired outcome, and release or milestone relationship.
