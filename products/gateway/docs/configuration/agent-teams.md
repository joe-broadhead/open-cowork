# Agent Teams

Agent teams let one Gateway project use project-scoped role routing without creating a second agent runtime. Gateway still launches normal OpenCode sessions. OpenCode still owns agents, models, permissions, questions, token accounting, and session history. The production profile and team schema is defined in [Agent Contracts](agent-contracts.md).

## Terms

| Term | Owner | Purpose |
| --- | --- | --- |
| Workflow role | Gateway | Stable stage responsibility such as `implement`, `review`, `verify`, `audit`, or `default`. |
| Gateway profile | Gateway | Named adapter from a workflow role to one OpenCode agent, model, skill set, permissions, heartbeat hint, and token hint. |
| OpenCode agent | OpenCode | Native agent definition used inside the OpenCode session. |
| Agent team | Gateway | Project or domain mapping from workflow roles to Gateway profiles, with optional capability requirements and quality defaults. |
| Promotion state | Gateway | Profile or team lifecycle state: `draft`, `evaluated`, `promoted`, `deprecated`, or `blocked`. |

Resolution order for a task stage is:

1. `task.stageProfiles[stage]`
2. `task.agentTeam.roles[stage]`
3. `roadmap.agentTeam.roles[stage]`
4. `scheduler.stageProfiles[stage]`
5. `scheduler.stageProfiles.default`

The generated `default` team mirrors `scheduler.stageProfiles`. Define additional teams only for project or domain routing that should differ from the global scheduler defaults.

## Safe Configuration Pattern

Define OpenCode-native agents and skills first, then create Gateway profiles, then create an agent team that points to those profiles.

Do not put credentials in agent team descriptions, role names, capability requirements, quality defaults, or project notes. Agent teams are shown in the dashboard, API responses, MCP output, and audit events.

```json
{
  "profiles": {
    "analytics-implementer": {
      "model": { "providerID": "openai", "modelID": "gpt-5.5", "variant": "xhigh" },
      "agent": "gateway-implementer",
      "skills": ["gateway-stage", "dbt-analytics"],
      "permission": { "gateway_*": "allow", "read": "allow", "edit": "ask", "bash": "ask" },
      "heartbeatMs": 0,
      "maxTokens": 160000,
      "role": "execution"
    }
  },
  "agentTeams": {
    "dbt-analytics": {
      "description": "dbt analytics delivery team",
      "roles": {
        "default": "analytics-implementer",
        "implement": "analytics-implementer",
        "review": "reviewer",
        "verify": "verifier"
      },
      "capabilityRequirements": {
        "implement": ["dbt-analytics"]
      },
      "qualitySpecDefaults": {
        "evidenceRequirements": ["dbt compile/test output or a documented blocker"],
        "requiredArtifacts": ["changed model or analysis file", "run notes"]
      }
    }
  }
}
```

Capability requirements are checked against the resolved profile's OpenCode agent name, skills, or allowed permission keys. If a stage cannot satisfy a requirement, Gateway blocks before creating the OpenCode session and records an operator-visible reason.

Teams may also carry `version` and `promotionState`. Profiles may satisfy requirements through explicit `capabilities`, `tools`, and `mcpServers` as well as agent, skill, and permission references.

Promotion state is evidence-backed. `GET /agent-teams` and `GET /profiles` include a compact `promotion` projection that references the latest scorecard and applied decision without exposing profile permissions beyond the existing profile payload or any secret-bearing config. Use `POST /promotion/scorecards` to persist Arena/eval evidence, then `POST /promotion/decisions` to open or apply the human-gated promote, deprecate, rollback, or block decision.

## Binding A Team

Bind teams to roadmaps when the whole project uses the same domain routing. Bind teams to tasks only for exceptions.

HTTP mutations and MCP mutation tools require a Gateway human gate. Validation and proposal calls are non-mutating.

```bash
curl -s http://127.0.0.1:4097/agent-teams/validate \
  -H 'content-type: application/json' \
  -d '{"name":"dbt-analytics","team":{"roles":{"default":"analytics-implementer"}}}'
```

```bash
curl -s http://127.0.0.1:4097/agent-teams/dbt-analytics/bind \
  -H 'content-type: application/json' \
  -d '{"roadmapId":"roadmap_123"}'
```

The bind call without an approved `gateId` returns `202` with a human gate. Approve the gate, then repeat with `gateId` or `approvedGateId`.

## dbt Analytics Example

Use a dbt analytics team for analytics roadmaps that need SQL/model context, explicit evidence, and cautious command permissions.

Recommended safeguards:

- Keep write permissions as `ask` unless the workspace is isolated.
- Require `dbt-analytics` capability on `implement` so a generic implementer cannot dispatch accidentally.
- Require evidence such as `dbt compile`, `dbt test`, generated docs, or a documented warehouse-access blocker.
- Keep credentials in the environment, OpenCode MCP config, or secret manager, not in Gateway team config.

## HR Recruiting Example

Use an HR recruiting team for candidate pipeline operations, interview packet drafting, or recruiting analytics where PII handling is stricter than normal software work.

```json
{
  "agentTeams": {
    "hr-recruiting": {
      "description": "HR recruiting operations with PII review gates",
      "roles": {
        "default": "coordinator",
        "plan": "planner",
        "implement": "coordinator",
        "review": "reviewer",
        "verify": "verifier"
      },
      "capabilityRequirements": {
        "default": ["gateway_*"],
        "implement": ["read"]
      },
      "qualitySpecDefaults": {
        "acceptanceCriteria": ["No candidate PII is posted to public channels", "External messages require human approval"],
        "evidenceRequirements": ["redaction check", "approval gate ID for external sends"]
      }
    }
  }
}
```

Recommended safeguards:

- Require human gates for external side effects and credential use.
- Prefer review-only or coordinator profiles for candidate communications.
- Avoid channel broadcasts unless the target chat/thread is explicitly allowlisted.
- Keep candidate names, emails, and private notes out of team descriptions and quality defaults when possible.

## Observability

Mission data and the dashboard show sanitized team state:

- Team names, descriptions, revisions, role-to-profile-to-agent routing, and reference counts.
- Invalid roadmap/task/run references as warnings.
- Recent run attribution: team, team revision, resolved profile, resolved OpenCode agent, stage, and status.
- Quality default keys, not secret-bearing values from unrelated config.

Profile permissions and channel credentials are not emitted in the agent-team mission payload.
