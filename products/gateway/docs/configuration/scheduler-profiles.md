# Scheduler Profiles

Scheduler profiles map a durable work stage to an OpenCode agent, model, skills, permissions, environment, budget, output contract, and promotion state. The production contract is defined in [Agent Contracts](agent-contracts.md).

## Profile Fields

| Field | Purpose |
| --- | --- |
| `model.providerID` | OpenCode provider ID such as `openrouter`, `anthropic`, `openai`, or `google`. |
| `model.modelID` | Provider model ID. |
| `model.variant` | Optional OpenCode model variant. |
| `agent` | OpenCode agent to run. |
| `skills` | Skills to load for the session. |
| `mcpServers` | Optional OpenCode MCP server references this profile expects. |
| `tools` | Optional OpenCode tool references this profile expects. |
| `permission` | OpenCode permission map for this profile. |
| `heartbeatMs` | Profile-level heartbeat hint. |
| `maxTokens` | Token budget hint. |
| `role` | `planning` or `execution`. |
| `environment` | Optional Gateway execution environment selector. |
| `capabilities` | Optional explicit labels used by agent team requirements. |
| `budget` | Optional token, cost, runtime, retry, and human-gate hints. |
| `outputContract` | Optional result shape, evidence, decision, artifact, and failure-class requirements. |
| `promotionState` | Optional lifecycle state: `draft`, `evaluated`, `promoted`, `deprecated`, or `blocked`. |

### Choosing a model

Stages that carry a quality spec (acceptance criteria, definition-of-done, evidence, required artifacts) require the profile's model to return a **structured stage result that satisfies the evidence contract**. Under-powered or non-instruction-following models frequently emit malformed result JSON or omit required evidence IDs, so the quality gate blocks the task at `verify` after its attempt limit — burning runs and budget without completing. Use a capable instruction-following model (the shipped defaults target a strong tier) for stage profiles; reserve smaller/cheaper models for low-stakes stages without a strict evidence contract.

## Default Profiles

| Profile | Agent | Role | Typical stage |
| --- | --- | --- | --- |
| `planner` | `gateway-planner` | planning | `plan` |
| `coordinator` | `gateway-coordinator` | planning | operations and channel coordination |
| `implementer` | `gateway-implementer` | execution | `implement` |
| `reviewer` | `gateway-reviewer` | execution | `review` |
| `verifier` | `gateway-verifier` | execution | `verify` |
| `supervisor` | `gateway-supervisor` | planning | roadmap supervisor turns |
| `auditor` | `gateway-auditor` | execution | `audit` |

## Stage Mapping

`scheduler.stageProfiles` maps stage names to profile names:

```json
{
  "default": "implementer",
  "implement": "implementer",
  "review": "reviewer",
  "verify": "verifier",
  "audit": "auditor",
  "plan": "planner"
}
```

Every stage in `scheduler.defaultPipeline` must resolve to an existing profile. Gateway prevents deleting profiles still referenced by scheduler stages.

## Review And Verify Defaults

The default `reviewer`, `verifier`, and `supervisor` profiles use OpenAI `gpt-5.5` with variant `xhigh`. Review and verify load both `gateway-stage` and `gateway-review-gate`; supervisor loads `gateway-supervisor`.

The review gate is spec-driven rather than code-only:

- It checks code with autoreview-style scrutiny for bugs, regressions, security issues, and missing tests.
- It checks docs, slides, research, operations, and external artifacts against the task quality spec and definition of done.
- It uses OpenCode-native questions and permission requests when human input or approval is required.
- Verifier failures with `failureClass: "implementation_failed"` route back to `implement`; pure verification failures retry `verify`.

`opencode-gateway doctor` and readiness detect stale Gateway-owned profile defaults. Setup and explicit profile updates should preserve user-customized profiles unless the operator chooses to overwrite them.

## Mechanical Review-Gate Isolation

Gateway enables `scheduler.reviewGateIsolation` by default for `review`, `verify`, and `audit` stages. This is a mechanical permission policy applied at scheduler dispatch time, after profile resolution and before the OpenCode prompt is sent. It means a reviewer/verifier profile can stay broadly useful in configuration, while the actual gate session receives an isolated permission map.

Default isolated gate behavior:

- Denies mutation and network-oriented capabilities: `edit`, `write`, `webfetch`, `websearch`, `browser`, `task`, and `todowrite`.
- Restricts `bash` to explicit evidence command prefixes such as `git status`, `git diff`, `rg`, `npm test`, `npm run verify`, and the strict MkDocs command.
- Adds a prompt notice naming denied capabilities, allowed evidence commands, and forbidden context such as remote GitHub/Linear context, browser/web tools, out-of-repo directories, and personal notes.
- Emits a bounded `review_gate.isolation.enforced` work event with the stage, profile, denied capabilities, changed permission keys, and allowed command count/list.

If required proof cannot be collected inside the isolated policy, the reviewer/verifier should return a blocked stage result with the precise missing evidence or approval instead of bypassing the policy.

Minimal configuration example:

```json
{
  "scheduler": {
    "reviewGateIsolation": {
      "enabled": true,
      "stages": ["review", "verify", "audit"],
      "allowBashEvidenceCommands": true,
      "bashAllowlist": ["git status", "git diff", "rg", "npm test", "npm run verify"]
    }
  }
}
```

Set `allowBashEvidenceCommands=false` to deny shell access entirely for gate stages. Keep implementer and coordinator profiles separate; this policy is for review-style gate sessions only.

## Managing Profiles

Use MCP tools for deterministic profile management:

- `gateway_profile_list`
- `gateway_profile_upsert`
- `gateway_profile_delete`
- `gateway_scheduler_configure`

Use `opencode-gateway doctor` or `gateway_doctor` to inspect the active config and profile state.
