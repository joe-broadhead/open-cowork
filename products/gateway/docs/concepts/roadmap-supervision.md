# Roadmap Supervision

Roadmap supervisors are durable Gateway records that bind one OpenCode session to one roadmap for roadmap-level monitoring and decisions.

Gateway owns supervisor state, event cursors, cadence metadata, completion policy, notification policy references, and audit events. OpenCode owns the supervising session, model execution, skills, tools, questions, permissions, and message history.

Project bindings are the routing layer in front of supervisors. They bind stable aliases and optional OpenCode, Telegram, or WhatsApp surfaces to a roadmap/session pair so each assistant surface can resolve "the current project" without repeating IDs.

## Supervisor Record

A supervisor captures:

- `supervisorId`
- `roadmapId`
- OpenCode `sessionId`
- scheduler profile name, normally `supervisor`
- status: `active`, `paused`, `blocked`, `completed`, or `archived`
- whether it is the default active supervisor for the roadmap
- cadence settings for heartbeat scheduling
- event trigger settings for event-driven wakeups
- last reviewed event cursor and review timestamps
- last supervisor result hash, status, summary, and timestamp
- completion policy
- notification policy reference
- operator note
- created and updated timestamps

## Default Supervisor

A roadmap can have one default active supervisor and optional watcher supervisors. Gateway deterministically selects the default active supervisor by explicit default flag, creation time, and supervisor ID. When a new active supervisor is promoted to default, other active supervisors for that roadmap are demoted.

Only the default active supervisor is intended to be woken for roadmap-level decisions. Watchers remain durable references for future UX and notification routing.

If a request does not include an explicit alias or roadmap ID, Gateway may resolve context from the current channel binding, the current OpenCode session, or the single active default supervisor. If multiple active projects match, resolution returns an ambiguity instead of guessing.

## Wake Scheduling

Gateway wakes default active supervisors through the normal scheduler heartbeat. It does not run one long-lived process per supervisor.

Wakeups are selected from:

- new workflow events after the supervisor's `lastReviewedEventId`
- `nextReviewAt` or `cadence.intervalMs`
- pending completion proposals created after the last review

Each selected wakeup has a unified wake contract:

- `wakeReason`: product-level reason, one of `schedule`, `issue_completed`, `gate_requested`, `failure_alert`, `manual_poke`, `delegated_progress`, `blocked_work`, `stale_run`, `channel_mention`, or `completion_proposal`
- `reason`: legacy-compatible scheduler reason such as `cadence` or `event:allRoadmapTasksDone`
- `windowKey`: deterministic event, cadence, review, or proposal window
- `idempotencyKey`: hash of supervisor, roadmap, wake reason, legacy reason, window, and cursor
- `cursorEventId`: event cursor advanced only when the wakeup completes successfully
- `receiptId`: durable result receipt row for the lease/result lifecycle

Default event triggers include task done, task blocked, stale run lease, run failed or errored, human gate pending or escalated, OpenCode question pending, OpenCode permission pending, critical alert active, manual review requested, delegation progress, channel mention event, all roadmap tasks done, and completion proposal follow-up. A supervisor can disable individual categories through `eventTriggers`, or disable wakeups entirely with `eventTriggers.disabled=true` or `eventTriggers.quiet=true`.

Each wakeup acquires a durable lease on the supervisor record and upserts a `supervisor_wakeup_receipts` row keyed by `idempotencyKey`. While `wakeLeaseOwner` and unexpired `wakeLeaseExpiresAt` are set, another scheduler pass will not prompt the same supervisor. If the lease expires before completion, a later scheduler pass can reacquire the same deterministic wake window with a new lease owner and the same receipt. Gateway sends a bounded prompt to the OpenCode supervisor session and leaves the lease open until a matching structured result is observed in that session.

On completion, Gateway clears the lease, advances the cursor on success, records status `completed` or `failed`, stores the summary and next wake timestamp on the receipt, and appends the legacy audit event (`roadmap.supervisor.wakeup_completed` or `roadmap.supervisor.wakeup_failed`). Receipts also capture inspected inputs, changed durable object IDs, the supervisor recommendation, and the recommended next action so the main-agent briefing can cite what happened without replaying the supervisor session. Failed prompt delivery records a failed receipt without advancing the cursor so the same changed work can be retried deterministically.

The final result must be a fenced JSON object that repeats the exact wake turn identity: `supervisorId`, `roadmapId`, `leaseOwner`, and `cursorEventId`. Gateway rejects stale or mismatched results and suppresses duplicate `lastResultHash` applications.

## Result Contract

Supervisor turns end with this fenced JSON shape:

```json
{
  "turn": {
    "supervisorId": "supervisor_...",
    "roadmapId": "roadmap_...",
    "leaseOwner": "gateway-...",
    "cursorEventId": 123
  },
  "status": "ok|blocked|needs_user|completion_proposed|failed",
  "summary": "operator-readable result",
  "actions": [
    { "type": "create_task|ask_question|request_permission|block_roadmap|propose_completion|schedule_next_review|summary|none", "summary": "action summary" }
  ],
  "questions": ["question text"],
  "proposedTasks": [
    { "title": "task title", "description": "task description", "priority": "HIGH|MEDIUM|LOW" }
  ],
  "completion": {
    "recommendation": "not_done|ready_for_user_approval|done",
    "evidence": ["evidence refs"],
    "risks": ["residual risks"]
  },
  "nextReviewAt": "2026-06-14T00:00:00.000Z"
}
```

Safe action policy:

- `none` and `summary` record the turn result only.
- `create_task` records proposed tasks by default; it creates durable tasks only when `supervisor.completionPolicy.allowDirectTaskCreate=true`.
- `ask_question` and `request_permission` are audited, but the actual user interaction remains OpenCode-native.
- `block_roadmap` can mark the roadmap blocked.
- `propose_completion` creates a durable completion proposal; completion still follows the roadmap completion policy.
- `schedule_next_review` updates `nextReviewAt` when it is a valid ISO timestamp.
- Unsupported, duplicate, or malformed actions are rejected and audited without side effects.

## Lifecycle

Create a supervisor when a project assistant session should monitor a roadmap:

```bash
gateway_roadmap_supervisor_create roadmapId=roadmap_123 sessionId=ses_123
```

Bind a human-friendly alias and surface to that project:

```bash
gateway_project_binding_upsert alias=payments roadmapId=roadmap_123 sessionId=ses_123
```

Pause or block a supervisor when it should not be woken. Mark it completed when no further supervision is needed but the record should remain visible. Archive it when it should leave active views.

Archiving a roadmap archives its supervisor records. Deleting a roadmap deletes its supervisor and project binding records with the roadmap, tasks, and runs so no orphaned supervisor state remains.

## Project Assistant UX

The `/project` command family is the channel-first project assistant interface. It resolves the current project from the bound chat/thread before falling back to explicit aliases, roadmap IDs, OpenCode session context, or the single active supervisor. Ambiguous context returns candidates instead of guessing.

Channel commands:

- `/project create <alias> [title] [--rebind]`: create a roadmap, default supervisor, OpenCode session binding, and channel project binding.
- `/project bind <alias> <roadmapId> [--rebind]`: bind this channel to an existing roadmap and create a default supervisor if one is missing.
- `/project status [alias|roadmapId]` or `/p status`: show roadmap, task, gate, completion, attention, supervisor, and notification state.
- `/project digest [alias|roadmapId]` or `/digest`: show recent project workflow events.
- `/project decisions [alias|roadmapId]`: list pending Gateway gates and completion proposals for the project.
- `/project review-now [alias|roadmapId]`: schedule the default supervisor for immediate review without duplicating an already queued or leased review.
- `/project complete approve|reject [proposalId] [note]`: decide the pending project completion proposal. `proposalId` can be omitted when exactly one proposal is open for the resolved project.
- `/project watch [alias|roadmapId]` or `/watch`: set this surface to immediate project notifications.
- `/project unwatch [alias|roadmapId]` or `/unwatch`: mute this surface without deleting the durable project binding.
- `/project open [alias|roadmapId]`: return OpenCode Web/TUI links for the project assistant session.
- `/project pause|resume [alias|roadmapId]`: pause or resume the default supervisor.
- `/project unbind [alias]`: remove the channel project binding.

OpenCode/MCP users get the same high-level UX through `gateway_project_create`, `gateway_project_status`, `gateway_project_digest`, `gateway_project_review_now`, `gateway_project_completion_decide`, `gateway_project_pause`, and `gateway_project_resume`. These tools call the `/projects`, `/projects/summary`, `/projects/digest`, `/projects/review-now`, `/projects/completion-decision`, and `/projects/supervisor-action` HTTP routes so CLI, Web, Telegram, and WhatsApp surfaces use one shared resolver and formatter.

Project creation and binding do not silently replace an existing alias or surface. Pass `--rebind` in channels or `allowRebind=true` over HTTP/MCP to explicitly replace a binding.

## Attention Routing

Needs Attention is grouped by roadmap before notifications are routed. Gateway resolves each attention item to a project from its roadmap ID, task ID, supervisor session, project binding, or active run session. Channel delivery targets come from project bindings first and then the default supervisor session as an OpenCode-only target.

Project bindings carry per-surface notification preferences:

- `notificationMode=immediate`: send project attention when it is not deduped or in quiet hours.
- `notificationMode=digest`: hold non-critical items for the digest interval; critical items bypass digest mode unless quiet hours are active.
- `notificationMode=muted` or `mutedUntil`: suppress the surface without deleting the project binding.
- `quietHours.start` / `quietHours.end`: UTC `HH:mm` quiet window. Windows can cross midnight.
- `lastDigestAt`: durable digest cursor for periodic project summaries.

Notifications are deduped by roadmap, target surface, and open attention item set. Gateway records `project.notification.sent`, `project.notification.suppressed`, and `project.notification.failed` events with redacted target hashes. Delivery failures create warning alerts from `project.notifications` without recording channel tokens or raw credentials.

Operator runbook:

1. Use `/attention` or the dashboard Needs Attention card to see project-grouped decisions.
2. Mute noisy surfaces with project notification preferences rather than deleting the binding.
3. Use digest mode for low-urgency projects; keep immediate mode for active launches.
4. Resolve `project.notifications` alerts by checking channel credentials, allowlists, and project bindings.
5. Use completion commands for completion proposals; notification routing does not approve completion automatically.

## Completion Governance

Roadmaps can store quality metadata: objective, acceptance criteria, definition of done, required evidence/artifacts, residual risk notes, and completion policy. Completion policy values are:

- `manual`: user must approve completion.
- `assistant_proposes_user_approves`: default; supervisors propose and a user approves or rejects.
- `auto_when_evidence_complete`: local-only explicit auto-completion when required evidence/artifacts are present and no blockers exist.
- `never_auto_complete`: sensitive roadmaps can never auto-complete.

Example quality metadata:

```json
{
  "objective": "Ship dependable roadmap supervision",
  "acceptanceCriteria": ["All sub-issues are implemented and verified"],
  "definitionOfDone": ["Docs, tests, and operational evidence are complete"],
  "evidenceRequirements": ["npm run verify", "mkdocs build --strict"],
  "requiredArtifacts": ["docs/concepts/roadmap-supervision.md"],
  "residualRiskNotes": ["7-day soak remains required before production certification"],
  "completionPolicy": "assistant_proposes_user_approves"
}
```

Completion proposals include evidence, unresolved risks, recommendation, status, actor/session metadata, and decision notes. Pending proposals appear in the dashboard Needs Attention view, `gateway_attention`, HTTP, MCP, and `/completion` channel commands.

Operator runbook:

1. Review pending proposals with `gateway_roadmap_completion_proposal_list` or `/completion`.
2. Inspect evidence against acceptance criteria and definition of done.
3. Approve with `gateway_roadmap_completion_decide decision=approve` or `/completion approve <proposalId> [note]` when the real outcome is done.
4. Reject with feedback when more work is needed; Gateway records the rejection and schedules the default supervisor for follow-up.
5. Do not use `auto_when_evidence_complete` for sensitive or external-side-effect roadmaps.

Auto-completion is refused when blocked tasks, open required human gates, active critical alerts, missing required evidence/artifacts, or unresolved risks exist.

## Events

Gateway appends workflow events for supervisor changes:

- `roadmap.supervisor.created`
- `roadmap.supervisor.updated`
- `roadmap.supervisor.archived`
- `roadmap.supervisor.wakeup_acquired`
- `roadmap.supervisor.wakeup_completed`
- `roadmap.supervisor.wakeup_failed`
- `roadmap.supervisor.review_requested`
- `roadmap.supervisor.result_applied`
- `roadmap.supervisor.action_rejected`
- `roadmap.supervisor.tasks_proposed`
- `roadmap.supervisor.questions_requested`
- `roadmap.supervisor.permission_requested`
- `project.notification.sent`
- `project.notification.suppressed`
- `project.notification.failed`
- `project.binding.upserted`
- `project.binding.updated`
- `project.binding.deleted`
- `roadmap.completion.proposed`
- `roadmap.completion.approved`
- `roadmap.completion.rejected`
- `roadmap.completion.auto_blocked`

These events are Gateway-owned audit history. Supervisor OpenCode questions and permission requests remain OpenCode-native and are surfaced through Gateway attention views.
