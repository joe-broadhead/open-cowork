# Governance

Gateway governance enforces operator-configured cost, token, and runtime ceilings for Gateway-managed scheduler work. It does not replace provider billing dashboards and it does not kill user-owned OpenCode sessions outside Gateway runs.

## Policy Scopes

Budgets can be configured at four scopes:

- `governance.global`
- `governance.roadmaps.<roadmapId>`
- `governance.tasks.<taskId>`
- `governance.stages.<stage>`

Supported limits:

- `dailyCostUsd`
- `weeklyCostUsd`
- `monthlyCostUsd`
- `totalCostUsd`
- `tokenLimit`
- `action`: `block`, `pause`, or `warn`

Example:

```json
{
  "governance": {
    "enabled": true,
    "action": "block",
    "global": { "dailyCostUsd": 10, "monthlyCostUsd": 200 },
    "roadmaps": {
      "roadmap_launch": { "totalCostUsd": 50 }
    },
    "tasks": {
      "task_expensive": { "tokenLimit": 250000, "action": "pause" }
    },
    "stages": {
      "implement": { "tokenLimit": 2000000, "action": "pause" },
      "audit": { "dailyCostUsd": 2, "action": "warn" }
    },
    "runtime": { "maxRunMs": 7200000, "staleRunMs": 3600000 }
  }
}
```

## Enforcement

Before dispatch, the scheduler evaluates global, roadmap, task, and stage budgets for the task's next stage.

When a hard budget is exhausted:

- `block` marks the task blocked with the budget reason.
- `pause` pauses the task with the budget reason.
- `warn` allows dispatch and emits visible warnings.

When a budget is at or above 80 percent usage, Gateway allows dispatch and reports a warning.

Runtime ceilings are checked for running Gateway runs on scheduler cycles. If `governance.runtime.maxRunMs` is greater than zero and a run exceeds it, Gateway blocks the run, aborts the Gateway-managed OpenCode session, and records runtime attribution.

## Attribution

Completed runs record queryable attribution in `gateway.db`:

- `costUsd`
- `inputTokens`
- `outputTokens`
- `reasoningTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `runtimeMs`

Attribution comes from OpenCode session metadata after the stage result is available. If OpenCode cannot provide usage metadata, Gateway records the run completion without cost/token values.

## Operator Surfaces

CLI:

```bash
opencode-gateway governance
```

MCP:

```text
gateway_governance
```

Channel:

```text
/governance
/budget
/status
```

HTTP:

```text
GET /governance
```

Dashboard:

- Budget KPI.
- Governance card with totals and configured budget states.
- Budget-blocked or budget-paused tasks appear in Needs Attention.

## Synthetic Stop-Loss Drill

Use a temporary state directory and a zero-dollar budget to prove dispatch stops without live model usage:

```bash
export OPENCODE_GATEWAY_CONFIG_DIR=/tmp/opencode-gateway-governance
export OPENCODE_GATEWAY_STATE_DIR=/tmp/opencode-gateway-governance
opencode-gateway task add "Governance stop-loss drill"
```

Set this in `config.json`:

```json
{
  "governance": {
    "global": { "dailyCostUsd": 0 }
  }
}
```

Run one scheduler cycle with `gateway_scheduler_run_once`. Expected result: no OpenCode session is dispatched and the task is blocked with `global daily cost exhausted`.
