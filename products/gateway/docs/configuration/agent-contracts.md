# Agent Contracts

Gateway agent contracts describe bounded OpenCode sessions. They are production contracts for routing, validation, blueprint registry entries, eval/arena scorecard evidence, and promotion gates. They are not a second agent runtime.

OpenCode owns the actual agents, skill files, MCP server config, tool execution, model providers, permissions, questions, token accounting, and session history. Gateway owns deterministic references to those OpenCode primitives, dispatch routing, validation, run attribution, environment selection, quality defaults, and operator-visible lifecycle state.

Current public release support remains Gateway-owned local assets. Governed third-party packages and marketplace behavior are future work with no enforcement today; those claims stay blocked in the claim registry.

## Agent Profile Contract

An agent profile is a named, bounded adapter from a Gateway workflow role to one OpenCode-native execution shape.

| Field | Required | Owner | Purpose |
| --- | --- | --- | --- |
| `description` | no | Gateway | Human-readable purpose and limits. Do not store secrets. |
| `version` | no | Gateway | Operator-managed profile catalog version. Mission Control falls back to a stable revision hash when absent. |
| `updatedAt` | no | Gateway | ISO-8601 timestamp for the last profile catalog update. |
| `model.providerID` | yes | OpenCode | Provider ID used by OpenCode. |
| `model.modelID` | yes | OpenCode | Provider model ID used by OpenCode. |
| `model.variant` | no | OpenCode | Optional OpenCode model variant. |
| `agent` | yes | OpenCode | OpenCode agent name. |
| `skills` | yes | OpenCode | Exact OpenCode skills the profile expects to load. |
| `mcpServers` | no | OpenCode | MCP server names the profile expects OpenCode to expose. Gateway validates names as references only. |
| `tools` | no | OpenCode | Tool or MCP tool names the profile expects to use. Gateway validates names as references only. |
| `permission` | yes | OpenCode | OpenCode permission policy for this profile. Values are `allow`, `ask`, or `deny`. |
| `environment` | no | Gateway | Gateway execution environment selector. |
| `heartbeatMs` | yes | Gateway | Scheduler heartbeat hint for long-running profile work. |
| `maxTokens` | yes | Gateway | Legacy token budget hint. Keep until `budget.maxTokens` replaces it. |
| `budget` | no | Gateway | Per-profile budget hints: `maxTokens`, `maxCostUsd`, `maxRuntimeMs`, `retryLimit`, and `humanGate`. |
| `role` | yes | Gateway | `planning` or `execution`. |
| `capabilities` | no | Gateway | Explicit capability labels this profile claims, used by team requirements. |
| `outputContract` | no | Gateway | Required output shape and evidence for downstream review, verify, arena, and scorecards. |
| `promotionState` | no | Gateway | Lifecycle state: `draft`, `evaluated`, `promoted`, `deprecated`, or `blocked`. |

`skills`, `mcpServers`, `tools`, and `capabilities` are bounded lists. A profile should contain only the abilities needed by its role. Avoid "universal" profiles that combine write access, broad shell, web, secrets, every skill, and every MCP tool unless the operator explicitly accepts that risk.

### Output Contract

Use `outputContract` when a profile must produce machine-checkable results.

```json
{
  "format": "stage-result",
  "requiredEvidence": ["tests run or documented blocker"],
  "requiredDecisions": ["nextStage, retryStage, or taskStatus"],
  "artifactRefs": true,
  "failureClass": true
}
```

Valid `format` values are `text`, `json`, `stage-result`, and `supervisor-result`. `schema` may hold future JSON-schema-like shape metadata, but Gateway currently treats it as structured config, not as an eval runner.

### Budget Contract

`budget` is a profile-local governance hint. Global, roadmap, task, and stage enforcement still lives under `governance`.

```json
{
  "maxTokens": 120000,
  "maxCostUsd": 3,
  "maxRuntimeMs": 3600000,
  "retryLimit": 1,
  "humanGate": "on-risk"
}
```

Valid `humanGate` values are `never`, `on-risk`, and `always`.

## Agent Team Contract

An agent team maps deterministic workflow roles or scheduler stages to profiles. Teams are the unit blueprints and arenas should use when evaluating multi-stage behavior.

| Field | Required | Owner | Purpose |
| --- | --- | --- | --- |
| `description` | no | Gateway | Human-readable team purpose. Do not store secrets. |
| `version` | no | Gateway | Operator-managed semantic or registry version. |
| `updatedAt` | no | Gateway | ISO-8601 timestamp for the last team catalog update. |
| `promotionState` | no | Gateway | Lifecycle state for the team as a deployable unit. |
| `roles` | yes | Gateway | Stage or role to profile mapping. `default` is required or inferred. |
| `capabilityRequirements` | no | Gateway | Stage or role requirements the resolved profile must satisfy before dispatch. |
| `qualitySpecDefaults` | no | Gateway | Default acceptance criteria, constraints, artifacts, evidence, or verification commands merged into tasks. |
| `revision` | generated | Gateway | Deterministic hash of team config used for run attribution. |

Common roles are `plan`, `implement`, `review`, `verify`, `audit`, `support`, `report`, and `default`. Stage names may be product-specific as long as the scheduler pipeline and team roles agree.

Gateway checks capability requirements against the resolved profile's OpenCode agent name, skills, explicit `capabilities`, `tools`, `mcpServers`, and allowed permission keys. If a requirement is missing, Gateway blocks before creating an OpenCode session.

## Access Inspection Model

Operators can inspect effective access for one profile with `GET /profiles/:name/inspection` or `gateway_profile_inspect`, and for one team with `GET /agent-teams/:name/inspection` or `gateway_agent_team_inspect`. Agent Factory catalog responses also include the same `inspection` object for profile and team rows.

Each inspection response has:

| Field | Meaning |
| --- | --- |
| `kind` | `profile` or `team`. |
| `name` | Profile or team name. |
| `status` | `valid`, `warning`, or `blocked`. |
| `grants` | Normalized agents, skills, MCP servers, tools, explicit capabilities, permission policies, and environment exposure. |
| `requirements` | Team capability requirements and whether the resolved profile satisfies each one. |
| `subjects` | Profiles included in the inspection. A team lists every resolved role profile. |
| `warnings` | Stable warning records with `code`, `severity`, `message`, `action`, and optional `failClosed`. |

Warning severities are ordered as `info`, `low`, `medium`, `high`, and `critical`. Critical warnings and any warning with `failClosed: true` make the inspection `blocked`. Validation and mutation paths fail closed for blocked inspections when a referenced profile, skill, MCP server, tool, environment, or required team capability is unknown or unavailable.

Gateway-owned tool names are matched against the registered `gateway_*` MCP tool inventory. A name with a `gateway_` prefix is not trusted by prefix alone.

Stable warning codes include:

| Code | Severity | Meaning |
| --- | --- | --- |
| `LP_AGENT_UNKNOWN` | critical | Profile references an unavailable OpenCode agent. |
| `LP_SKILL_UNKNOWN` | critical | Profile references an unavailable OpenCode skill. |
| `LP_MCP_UNKNOWN` | critical | Profile references an unavailable MCP server. |
| `LP_TOOL_UNKNOWN` | critical | Profile references an unavailable tool. |
| `LP_GATEWAY_MCP_MISSING` | critical | A `gateway_` tool is declared without the `gateway` MCP server. |
| `LP_REQUIRED_GRANT_MISSING` | critical | A profile or team lacks read access or a required capability. |
| `LP_PERMISSION_POLICY_MISSING` | critical | Profile has no explicit permission map. |
| `LP_PERMISSION_BROAD_ALLOW` | critical | Wildcard or default allow grants are present. |
| `LP_PERMISSION_SECRET_ALLOW` | critical | Secret-like credential grants are allowed without an operator decision. |
| `LP_ENVIRONMENT_UNKNOWN` | critical | Profile environment cannot be resolved. |
| `LP_ENVIRONMENT_PRIVILEGED_CONTAINER` | critical | Profile uses a privileged container environment. |
| `LP_PERMISSION_RISKY_ALLOW` | high | High-impact grants such as `edit`, `bash`, `webfetch`, or `websearch` are allowed. |
| `LP_ROLE_GRANT_TOO_BROAD` | high | Planning profile allows edit or shell access. |
| `LP_RISKY_COMBINATION` | high | Profile combines write, shell, and web access. |
| `LP_ENVIRONMENT_NETWORK_UNRESTRICTED` | high | Environment grants unrestricted network access. |
| `LP_ENVIRONMENT_SECRETS` | high | Environment exposes named secrets. |
| `LP_PERMISSION_CONFLICT` | medium | Broad allow grants conflict with narrower ask or deny entries. |
| `LP_ENVIRONMENT_REMOTE` | medium | Profile uses a remote execution backend. |
| `LP_PROFILE_NO_SKILLS` | medium | Profile declares no skills. |

## Lifecycle States

| State | Meaning | Dispatch Guidance |
| --- | --- | --- |
| `draft` | Defined but not trusted. | Use for local testing, registry preview, and arena setup. |
| `evaluated` | Completed the required eval suite or manual review. | Eligible for staged rollout when selected explicitly. |
| `promoted` | Approved for production Gateway work. | Preferred default for registry and team selection. |
| `deprecated` | Retained for old runs or rollback references. | Do not select by default for new work. |
| `blocked` | Known unsafe, broken, or policy-disallowed. | Do not dispatch until fixed and re-evaluated. |

Gateway stores lifecycle state as metadata plus durable scorecard and decision history. Arena or eval evidence can move a subject to `evaluated` or `blocked`; mutating trust decisions such as `promoted`, `deprecated`, and rollback require an approved Gateway human gate. Existing configs remain compatible because dispatch enforcement for `deprecated` and `blocked` is still a policy decision layered on top of routing.

Promotion records include stable scorecard IDs, subject kind/name/revision, eval or Arena source, metric scores, thresholds, evidence, conclusion, recommendation, linked gate IDs, and created/updated timestamps. Decision history records who requested a promote/deprecate/rollback/block action, which gate approved or rejected it, and the state transition that was applied.

## Existing Config Mapping

Existing `profiles` map directly to the profile contract:

| Existing field | Contract field |
| --- | --- |
| `profiles.<name>.model` | `model` |
| `profiles.<name>.agent` | `agent` |
| `profiles.<name>.skills` | `skills` |
| `profiles.<name>.permission` | `permission` |
| `profiles.<name>.environment` | `environment` |
| `profiles.<name>.heartbeatMs` | `heartbeatMs` |
| `profiles.<name>.maxTokens` | `maxTokens`, and eventually `budget.maxTokens` |
| `profiles.<name>.role` | `role` |

Existing `agentTeams` map directly to the team contract:

| Existing field | Contract field |
| --- | --- |
| `agentTeams.<name>.description` | `description` |
| `agentTeams.<name>.roles` | `roles` |
| `agentTeams.<name>.capabilityRequirements` | `capabilityRequirements` |
| `agentTeams.<name>.qualitySpecDefaults` | `qualitySpecDefaults` |
| generated `revision` | `revision` |

The generated `agentTeams.default` mirrors `scheduler.stageProfiles`, so existing scheduler stage routing already has a team-shaped contract.

## Validation Rules

Gateway validation should fail closed for malformed contracts:

- Profiles require `model.providerID`, `model.modelID`, and a valid `role`.
- Profile names, team names, stages, roles, capabilities, MCP server names, and tool references must be bounded strings with safe identifier characters.
- Skill references must be listed explicitly in `skills`. Gateway can verify Gateway-shipped skills and can validate optional downstream skills only as configured references because OpenCode owns their files.
- MCP server and tool references must stay in `mcpServers` and `tools`. Gateway validates reference shape and requirement satisfaction, while OpenCode remains the source of truth for installed MCP config and available tools.
- Permissions must use `allow`, `ask`, or `deny`. Risky permissions such as `edit`, `bash`, web, credential, or external side effect access should default to `ask` or `deny` unless a profile's purpose requires them.
- `environment` must reference a configured Gateway environment or inline selector accepted by the environment registry. Remote and privileged environments follow the existing environment approval policy.
- Budgets must stay within Gateway governance bounds: token counts and retry limits are non-negative, cost is finite, and runtime is at most 30 days.
- Output contracts must use a known format and bounded required evidence or decision labels.
- Team roles must resolve to existing profiles. `default` is inferred from `implement` or the first role when omitted.
- Team capability requirements must be satisfied by the resolved profile before dispatch. Missing requirements block the task with an operator-visible reason.
- Quality defaults must be structured objects. Do not store credentials, private notes, or secret-bearing values in them.

## Examples

### Implementer

```json
{
  "model": { "providerID": "openrouter", "modelID": "deepseek/deepseek-v4-pro", "variant": "high" },
  "agent": "gateway-implementer",
  "skills": ["gateway-stage"],
  "mcpServers": ["gateway"],
  "tools": ["gateway_task_update"],
  "permission": { "gateway_*": "allow", "read": "allow", "edit": "allow", "bash": "allow", "question": "allow" },
  "heartbeatMs": 0,
  "maxTokens": 200000,
  "role": "execution",
  "capabilities": ["repo-write", "test-runner"],
  "budget": { "maxTokens": 200000, "retryLimit": 2, "humanGate": "on-risk" },
  "outputContract": { "format": "stage-result", "requiredEvidence": ["diff summary", "tests run"], "artifactRefs": true, "failureClass": true },
  "promotionState": "promoted"
}
```

### Reviewer

```json
{
  "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "xhigh" },
  "agent": "gateway-reviewer",
  "skills": ["gateway-stage", "gateway-review-gate"],
  "permission": { "gateway_*": "allow", "read": "allow", "grep": "allow", "edit": "deny", "bash": "ask" },
  "heartbeatMs": 0,
  "maxTokens": 120000,
  "role": "execution",
  "capabilities": ["review-gate", "evidence-check"],
  "outputContract": { "format": "stage-result", "requiredEvidence": ["findings or explicit no-findings statement"], "failureClass": true },
  "promotionState": "promoted"
}
```

### Verifier

```json
{
  "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "xhigh" },
  "agent": "gateway-verifier",
  "skills": ["gateway-stage", "gateway-review-gate"],
  "permission": { "gateway_*": "allow", "read": "allow", "bash": "allow", "edit": "deny" },
  "heartbeatMs": 0,
  "maxTokens": 120000,
  "role": "execution",
  "capabilities": ["verification", "test-runner"],
  "outputContract": { "format": "stage-result", "requiredEvidence": ["command output or inspection evidence"], "failureClass": true },
  "promotionState": "promoted"
}
```

### Auditor

```json
{
  "model": { "providerID": "openrouter", "modelID": "deepseek/deepseek-v4-pro", "variant": "high" },
  "agent": "gateway-auditor",
  "skills": ["gateway-stage"],
  "permission": { "gateway_*": "allow", "read": "allow", "grep": "allow", "edit": "deny", "bash": "deny" },
  "heartbeatMs": 0,
  "maxTokens": 50000,
  "role": "execution",
  "capabilities": ["production-audit", "risk-classification"],
  "outputContract": { "format": "stage-result", "requiredEvidence": ["risk evidence"], "failureClass": true },
  "promotionState": "evaluated"
}
```

### Support Agent

```json
{
  "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "high" },
  "agent": "gateway-coordinator",
  "skills": ["gateway-coordinator"],
  "mcpServers": ["gateway"],
  "permission": { "gateway_*": "allow", "read": "allow", "question": "allow", "edit": "deny", "bash": "ask" },
  "heartbeatMs": 0,
  "maxTokens": 80000,
  "role": "planning",
  "capabilities": ["support-triage", "status-reporting"],
  "budget": { "maxTokens": 80000, "humanGate": "always" },
  "outputContract": { "format": "json", "requiredDecisions": ["answer, handoff, or create_task"], "artifactRefs": false },
  "promotionState": "draft"
}
```

### Reporter Profile

```json
{
  "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "high" },
  "agent": "gateway-coordinator",
  "skills": ["gateway-coordinator"],
  "permission": { "gateway_*": "allow", "read": "allow", "edit": "deny", "bash": "deny" },
  "heartbeatMs": 0,
  "maxTokens": 40000,
  "role": "planning",
  "capabilities": ["progress-reporting"],
  "outputContract": { "format": "json", "requiredEvidence": ["current state source"], "requiredDecisions": ["report_status"] },
  "promotionState": "evaluated"
}
```

### Small Team

```json
{
  "agentTeams": {
    "small-delivery": {
      "description": "Small bounded delivery team for code changes with review and verification.",
      "version": "1.0.0",
      "promotionState": "evaluated",
      "roles": {
        "default": "implementer",
        "implement": "implementer",
        "review": "reviewer",
        "verify": "verifier",
        "audit": "auditor",
        "support": "support-agent",
        "report": "reporter"
      },
      "capabilityRequirements": {
        "implement": ["repo-write", "test-runner"],
        "review": ["review-gate"],
        "verify": ["verification"],
        "audit": ["production-audit"],
        "support": ["support-triage"],
        "report": ["progress-reporting"]
      },
      "qualitySpecDefaults": {
        "acceptanceCriteria": ["Implementation, review, and verification evidence are attached to the run."],
        "evidenceRequirements": ["changed artifacts", "test or inspection evidence", "known risks"]
      }
    }
  }
}
```
