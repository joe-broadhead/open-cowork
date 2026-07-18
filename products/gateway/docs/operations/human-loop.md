# Human Loop

Gateway keeps OpenCode-native questions and permissions canonical for execution-level tool/model decisions. Gateway human-loop gates are durable policy gates for scheduler and work-management decisions.

## Gate Types

Durable Gateway gates can represent:

- `task_start`
- `stage_transition`
- `external_side_effect`
- `budget_exception`
- `destructive_action`
- `credential_use`
- `manual`

Each gate is stored in `gateway.db` with task, roadmap, run, stage, scope, timeout, decision, and audit metadata.

## Policy

Configure gate policy under `humanLoop`:

```json
{
  "humanLoop": {
    "enabled": true,
    "taskStartApproval": false,
    "stageApprovals": ["verify"],
    "defaultTimeoutMs": 86400000,
    "timeoutAction": "escalate",
    "priorityTimeoutMs": {
      "HIGH": 3600000,
      "MEDIUM": 14400000,
      "LOW": 86400000
    }
  }
}
```

Manual task gates are created when a task has `manualGate` set to `approval_required`, `credentials_required`, `external_dependency`, or `waiting_for_user`.

Stage gates are created immediately before dispatch. No OpenCode session is created until the gate is approved.

## Decisions

Operators can approve or reject gates:

- `approve` with `once` scope resolves the current narrow gate scope.
- `approve` with `always` records an auditable standing approval for the same scope key.
- `reject` blocks the related task.

Every decision writes `human_gate.decided` and `audit.human_decision` workflow events.

Gateway now exposes all operator decisions through one contract:

| Source | Owner | Pending State | Safe Action |
| --- | --- | --- | --- |
| Gateway human gate | Gateway | `requires_gateway` | `/gate approve <gateId> once`, `/gate reject <gateId> [note]`, or `gateway_human_gate_decide`. |
| Project completion proposal | Gateway | `requires_gateway` | `/completion approve <proposalId>`, `/completion reject <proposalId> [note]`, or `gateway_roadmap_completion_decide`. |
| OpenCode question | OpenCode | `requires_open_code` | Answer in OpenCode, or use `/answer <questionId> <label>` from a trusted channel bound to the owning Session. Gateway forwards the answer to OpenCode. |
| OpenCode permission | OpenCode | `requires_open_code` | Approve or deny in OpenCode, or use `/approve <permissionId> once`, `/approve <permissionId> always`, or `/deny <permissionId>` from a trusted channel bound to the owning Session. Gateway does not bypass OpenCode. |
| Channel callback/action | Gateway channel security | `pending`, `stale`, `expired`, `denied`, or `blocked` | Refresh Needs Attention, bind the correct trusted channel, or answer through the owning OpenCode/Gateway surface. |

Common terminal and recovery states are `answered`, `expired`, `denied`, `stale`, and `blocked`. Stale, replayed, wrong-actor, wrong-channel, expired, missing, and duplicate channel replies fail closed and write redacted audit events.

## Operator Journey

Gateway also projects selected decisions, session links, channel controls, and support output into an operator journey contract. This contract answers the same questions across channels, Web/TUI recovery, Mission Control, and support output:

| Field | Meaning |
| --- | --- |
| `currentAction` | What the operator can do now. |
| `waitOwner` | The system that owns the wait: `opencode`, `gateway`, `channel`, `provider`, `operator`, or `none`. |
| `permissionState` | Whether the wait is OpenCode-owned, Gateway-owned, channel-security blocked, operator-attention required, blocked, or not required. |
| `recoveryPath` | The primary surface, fallback surfaces, and safe next action when the current surface is stale, unavailable, deferred, or blocked. |
| `channelCapability` | Provider/native-control truth using `supported`, `partial`, `fallback`, `blocked`, or `deferred`. |
| `proofState` | The evidence state: `passed`, `partial`, `missing`, `blocked`, `deferred`, or `waived`. |

OpenCode remains the owner of OpenCode questions, permissions, Session state, and tool approval. Gateway can route a trusted-channel answer or permission reply to OpenCode, but it does not bypass OpenCode enforcement.

## Timeouts

When a pending gate reaches `expiresAt`, scheduler timeout enforcement applies the gate action:

- `remind`: keeps the gate pending and extends timeout.
- `escalate`: marks the gate escalated and keeps work blocked.
- `pause`: marks the gate timed out and pauses the task.
- `block`: marks the gate timed out and blocks the task.

## Needs Attention

The unified Needs Attention report includes:

- Pending or escalated Gateway gates.
- OpenCode-native questions.
- OpenCode-native permissions.
- Blocked and paused Gateway tasks.
- Stale Gateway runs.

Surfaces:

- Dashboard: Needs Attention card.
- HTTP: `GET /attention`.
- MCP: `gateway_attention`.
- Channels: `/attention`.

Gate operations:

- HTTP: `GET /human-gates`, `POST /human-gates`, `POST /human-gates/{gateId}/decision`.
- MCP: `gateway_human_gate_list`, `gateway_human_gate_create`, `gateway_human_gate_decide`.
- Channels: `/gates`, `/gate approve <gateId> [once|always] [note]`, `/gate reject <gateId> [note]`.
