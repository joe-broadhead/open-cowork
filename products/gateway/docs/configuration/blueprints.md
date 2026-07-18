# Blueprints

Blueprints are reusable recipes for Gateway profiles, agent teams, OpenCode asset references, permissions, environments, and quality defaults. They are a registry foundation, not a marketplace and not a second agent runtime.

OpenCode continues to own actual agents, skills, MCP servers, tools, permissions, model execution, questions, and sessions. Gateway validates and composes references, previews changes, applies Gateway config after approval, and records rollback context for prior profile/team versions.

## Schema

```json
{
  "name": "warehouse",
  "version": "1.0.0",
  "metadata": {
    "title": "Warehouse delivery team",
    "owner": "data-platform",
    "description": "Bounded SQL/model delivery profile and team."
  },
  "requiredOpenCode": {
    "agents": ["warehouse-agent"],
    "skills": ["warehouse-skill"],
    "mcpServers": ["warehouse"],
    "tools": ["warehouse_query"]
  },
  "environments": ["local-process"],
  "profiles": {
    "warehouse": {
      "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "high" },
      "agent": "warehouse-agent",
      "skills": ["warehouse-skill"],
      "mcpServers": ["warehouse"],
      "tools": ["warehouse_query"],
      "permission": { "read": "allow", "grep": "allow", "edit": "ask", "bash": "ask" },
      "heartbeatMs": 0,
      "maxTokens": 100000,
      "role": "execution",
      "environment": "local-process",
      "capabilities": ["warehouse", "sql"],
      "budget": { "maxTokens": 100000, "retryLimit": 1, "humanGate": "on-risk" },
      "outputContract": { "format": "stage-result", "requiredEvidence": ["query result"], "failureClass": true },
      "promotionState": "evaluated"
    }
  },
  "teams": {
    "warehouse": {
      "version": "1.0.0",
      "promotionState": "evaluated",
      "roles": { "implement": "warehouse", "verify": "verifier" },
      "capabilityRequirements": { "implement": ["warehouse", "warehouse_query"] },
      "qualitySpecDefaults": { "evidenceRequirements": ["warehouse query output"] }
    }
  },
  "qualityDefaults": {
    "evidenceRequirements": ["query output or documented blocker"]
  },
  "rollback": {
    "replaces": ["warehouse"],
    "deprecates": ["warehouse-legacy"],
    "rollbackTargets": ["warehouse-legacy"],
    "notes": "Return to warehouse-legacy if warehouse@1.0.0 fails validation."
  }
}
```

`profiles` uses the same production profile contract described in [Agent Contracts](agent-contracts.md). `teams` uses the same agent team contract and revision behavior as [Agent Teams](agent-teams.md).

## Catalog Library

Mission Control and the read APIs build the Agent Factory catalog from real durable sources:

- `profiles` and `agentTeams` in Gateway config.
- JSON blueprint files in `~/.config/opencode-gateway/blueprints` by default.
- Optional additional directories from `agentFactory.blueprintDirs`.
- Promotion scorecards and decisions persisted in Gateway state.

Each blueprint file contains one blueprint object. The catalog assigns stable IDs in the form `blueprint:<name>@<version>`, shows file source and last-updated metadata, validates the recipe with the same preview path used by apply, and keeps invalid files visible as blocked entries with validation errors.

Profiles and teams also receive catalog IDs:

- `profile:<name>` for Gateway profile config entries.
- `team:<name>` for normalized agent teams, including the generated `default` team.

Profiles may include optional `version` and `updatedAt` metadata. Teams may include optional `version` and `updatedAt` metadata. If no explicit version is set, Mission Control shows the stable config revision hash as the version label. Last-updated falls back to the config file timestamp when explicit metadata is absent.

The catalog summarizes the bounded capability surface rather than exposing raw secrets:

- skills loaded by a profile or required by a blueprint
- MCP server names
- tool names
- explicit capability labels and team capability requirements
- permission counts and allowed permission keys
- promotion state and scorecard status for profiles and teams

## Validation

Blueprint preview fails closed for malformed recipes and reports both errors and warnings.

Validation detects:

- Missing or malformed profile/team fields.
- Missing explicit read permission.
- Unsafe grants such as wildcard, credential, secret, or token permissions set to `allow`.
- Risky grants such as `edit`, `bash`, `webfetch`, or `websearch` set to `allow` as warnings.
- Profile agents, skills, MCP servers, and tools that are not listed in `requiredOpenCode`.
- Required OpenCode agents, skills, MCP servers, and tools that are missing when the selected OpenCode config directory is inspectable.
- Gateway MCP tool references without `mcpServers: ["gateway"]`.
- Missing or malformed environment selectors.
- Rollback and deprecation targets that do not currently exist.

Gateway-shipped assets such as `gateway-implementer`, `gateway-stage`, and `gateway` MCP are treated as known references even before setup installs them.

## Diff And Preview

Preview returns a structured diff with entries like:

```json
{
  "target": "profile",
  "name": "warehouse",
  "action": "create",
  "owner": "gateway",
  "after": { "...": "normalized profile" }
}
```

Gateway-owned targets are `profile` and `agentTeam`. OpenCode-owned targets are `opencodeAgent`, `opencodeSkill`, `opencodeMcp`, and `opencodeTool`. OpenCode entries are reference checks only; a `missing` action means the operator should install or upsert that OpenCode asset before dispatch.

Preview also returns rollback records for any existing profile or team that would be updated:

```json
{
  "target": "agentTeam",
  "name": "warehouse",
  "previousVersion": "0.9.0",
  "previousRevision": "abc123",
  "previous": { "...": "prior normalized team" }
}
```

## Apply

Blueprint apply is intentionally a narrow proposal/apply split:

1. `blueprint_preview` validates the recipe and shows the diff.
2. `blueprint_apply` without a gate creates a human gate and returns `202`.
3. Approve the gate.
4. Repeat `blueprint_apply` with `gateId` or `approvedGateId`.

Apply writes only Gateway profiles and agent teams through the existing config management path. It does not create, edit, or delete OpenCode agents, skills, MCP servers, or tools. Use the existing `opencode_*` asset tools for those assets.

## MCP Tools

- `agent_catalog_list`: list profile, team, and persisted blueprint catalog entries.
- `team_assemble`: resolve a named blueprint/team into a deterministic bounded-team receipt with selected profile versions, least-privilege grants, budget/gate placeholders, and rejection reasons. This does not dispatch sessions.
- `blueprint_catalog_list`: list only persisted blueprint files with validation and source metadata.
- `blueprint_preview`: structured validation and diff.
- `blueprint_preview_text`: readable validation and diff.
- `blueprint_apply`: gated apply for valid Gateway profile/team changes.

Existing `profile_*`, `agent_team_*`, and `opencode_*` tools remain compatible.
