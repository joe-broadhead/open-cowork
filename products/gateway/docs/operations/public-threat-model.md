# Public Threat Model

Gateway is a local-first control plane around OpenCode. OpenCode owns model execution, sessions, questions, permissions, tools, skills, and agent runtime behavior. Gateway owns durable orchestration, channel bindings, scheduler state, local service controls, evidence, and operator visibility.

This threat model is the public-release boundary for the current product. It supports a supervised local beta for one trusted operator. It does not claim hosted, team, multi-tenant, or remote-worker readiness.

## Actors

| Actor | Trust level | Notes |
| --- | --- | --- |
| Local operator | Trusted | Owns the machine, Gateway config, OpenCode config, channel allowlists, and release decisions. |
| Local browser/CLI/MCP client | Trusted when local | Expected to run on the same machine as Gateway. Non-local HTTP requires explicit exposed-mode config and scoped bearer tokens. |
| OpenCode | Trusted runtime authority | Gateway asks OpenCode to run sessions and answer permission/question flows; Gateway does not replace OpenCode's runtime model. |
| Trusted channel target | Conditionally trusted | Telegram, WhatsApp, or Discord targets must be allowlisted or claimed before any inbound is accepted. Target trust alone does not forward free text: the sender must also be a trusted actor (allowlisted user id, the claiming sender, or a private chat where sender id equals chat id) unless `security.trustTargetMembersForFreeText` is explicitly enabled. |
| Provider webhook | External | Webhook requests are public ingress and are constrained to documented provider routes with provider verification/signature checks. |
| Untrusted network caller | Untrusted | Should only reach explicitly exposed webhook routes or token-protected exposed HTTP routes. |
| Agent/subagent | Bounded by profile and OpenCode permissions | Agents can request Gateway work through MCP/tools only through the configured local runtime and permission model. |

## Trust Zones

| Zone | Boundary |
| --- | --- |
| `local_http` | Local daemon HTTP, dashboard, CLI, and Gateway MCP traffic. Defaults to `127.0.0.1`. |
| `trusted_channel` | Allowlisted or claim-verified provider targets. Free text is forwarded verbatim as an agent prompt, so it requires a trusted actor by default, not just a trusted target; privileged commands always require actor checks. |
| `public_webhook` | Provider callback ingress for `/webhooks/whatsapp` and `/webhooks/discord`. No other route should be exposed by public webhook mode. |
| `local_process` | Gateway CLI, MCP server, scheduler, backup/restore, and local OpenCode process orchestration. |

## Assets

| Asset | Protection requirement |
| --- | --- |
| Gateway durable state | Preserve integrity, idempotency, recovery, and audit trail. |
| OpenCode sessions | Do not expose private prompts/transcripts through public routes, docs, logs, or redacted evidence. |
| Channel bindings and target IDs | Treat as sensitive identifiers; redact in evidence and docs unless using fixtures. |
| Provider/model tokens | Prefer environment variables; redact from config output, logs, readiness, evidence, and docs. Secret lifecycle posture is reported by `opencode-gateway secrets status` and readiness `security_secret_lifecycle`. |
| Evidence exports | Default to redacted; unredacted export is admin-gated. Local audit/retention posture is reported by readiness `compliance_audit_retention`; compliance-grade hosted retention remains future work. |
| Remote execution contracts | Keep local execution as the default; require explicit remote/container policy, cleanup proof, and reference-based evidence before any future worker claim. See [Runtime Isolation](../configuration/runtime-isolation.md). |
| Quota and cost events | Keep budget, spend, token, channel, and storm evidence redacted and deterministic. Tenant-aware quotas and hosted abuse controls remain future work. |
| Extension packages | Keep Gateway-owned local assets separate from future third-party packages. Governed third-party package trust remains future work. |
| Deployment topology | Keep local-only deployment separate from future self-hosted/hosted claims; those claims stay blocked in the claim registry. |
| OpenCode assets | MCP/tools/agents/skills writes require `asset_write` or `admin`. |
| Scheduler/admin controls | Mutations, restore, and destructive config changes are privileged and human-gated where configured. Shutdown and restart are privileged (`admin`) audited lifecycle controls without a human gate, since they preserve durable state and local process control cannot be gated anyway. |

## Entry Points

The source of truth for classified entry points is `src/security.ts` (`httpCapabilityForRequest`) together with `src/security-policy.ts`.

| Surface | Capability classes | Examples |
| --- | --- | --- |
| HTTP | `read`, `operator`, `asset_write`, `admin`, `webhook`, `conditional` | Dashboard/readiness reads, durable work mutations, OpenCode asset writes, storage restore, webhook ingress, redacted/unredacted evidence export. |
| MCP tools | `read`, `operator`, `asset_write`, `admin` | Gateway dashboard, task/roadmap mutation, channel sends, config update, backup/restore, profile/asset upsert. |
| Channel commands | `trusted_channel` | Status/read commands, session binding, work control, human gate/question/permission replies. |
| CLI | `local_cli` | Channel onboarding, service operation, backup/restore, soak and release evidence. |

Automated tests mine the daemon route files, MCP server declarations, and channel command cases and fail when a new surface is not classified.

## Privileged Operations

Privileged operations are any action that can mutate durable state, start or abort OpenCode work, deliver provider messages, read local files, export evidence, write OpenCode assets, restore storage, change runtime config, or approve human-loop decisions.

The current capability boundaries are:

| Capability | Meaning |
| --- | --- |
| `read` | Redacted local state inspection, health, dashboard, readiness, lists, and reports. |
| `operator` | Durable work mutation, scheduler actions, channel sends, human-gate decisions, and OpenCode replies. |
| `asset_write` | OpenCode MCP/tool/agent/skill create, update, or delete. |
| `admin` | Config mutation, unredacted export, backup/restore, recovery drills, shutdown, restart, and full exposed HTTP administration. |
| `webhook` | Provider webhook ingress only. |
| `conditional` | Route where query parameters change the required capability, such as redacted vs unredacted config/evidence export. |

A future hosted/team authorization model would map these effects to roles and capability grants. No such model is enforced today; earlier design documents live in Git history (see the [Decision Log](../history/decision-log.md)).

## MCP Trust Tier And Agent Authority

State this plainly, because it is the single most important thing to understand
before pointing an untrusted agent at the Gateway MCP:

- The MCP proxy runs at a **fixed** `local_trusted` trust tier — it is the local
  operator's own tool surface, so the policy engine treats it as trusted by
  construction. The tool-level tier is what actually bounds an MCP client, and it
  is set by `GATEWAY_MCP_TOOLS` (`read` | `operate` | `admin`).
- The **default is `operate`**. An `operate`-tier MCP client can drive nearly the
  entire durable operator surface: create/mutate tasks and roadmaps, dispatch and
  pause work, send channel messages, and decide human gates. It cannot do `admin`
  work (config mutation, asset writes, restore, restart) without an explicit
  `GATEWAY_MCP_TOOLS=admin` opt-in.
- A **trusted free-text channel message is forwarded verbatim as an agent
  prompt** (see the `trusted_channel` zone). Composed with the point above, the
  blunt consequence is: **an MCP-`operate` agent driven by a trusted free-text
  channel actor is, in effect, a full durable operator.** This is acceptable
  *only* under the stated threat model — you trust your machine and the agents
  you run on it. It is not a multi-principal control.

Mitigations that hold under local trust:

- For any profile you do **not** fully trust (experimental agents, shared
  targets), run the MCP proxy at **`GATEWAY_MCP_TOOLS=read`** so it can inspect
  but not mutate. Raise to `operate`/`admin` deliberately, per profile.
- Keep destructive OpenCode tools (bash/edit) in OpenCode **ask** mode for any
  shared or lower-trust target, so a prompt-driven agent cannot act unattended.
- **Human gates that authorize an external effect are not MCP-approvable.** When
  `security.requireNonMcpDestructiveApproval` is on (default), a gate of type
  `destructive_action`, `external_side_effect`, `budget_exception`, or
  `credential_use` cannot be self-approved through the MCP proxy tier — the
  operator must approve it out-of-band (HTTP/CLI). This closes the confused-deputy
  path where a delegated agent rubber-stamps its own external authority. Purely
  procedural gates (`task_start`, `stage_transition`, `manual`) remain
  MCP-approvable because they authorize no external effect.

## Abuse Cases

| Abuse case | Current mitigation | Remaining boundary |
| --- | --- | --- |
| Expose Gateway HTTP to a network without auth | Daemon refuses non-local bind unless acknowledged; exposed mode requires scoped tokens or explicit unsafe config. | Hosted/team auth is not implemented. |
| Public webhook reaches non-webhook routes | Public webhook mode exempts only documented provider routes. | Operators should still prefer an authenticating tunnel/proxy with path allowlists. |
| Untrusted chat controls work | Providers fail closed without allowlists unless explicit unsafe allow-all is enabled, and free text inside a trusted target is forwarded only from trusted actors by default. | An actor added to `userIds`, or an operator enabling `trustTargetMembersForFreeText` in a multi-member chat, can still drive a tool-capable agent by prompt; keep bash/edit in OpenCode ask mode for shared targets. |
| Secret leaks in evidence or readiness | Redaction helpers and readiness summaries report credential input IDs, classes, env/config key names, counts, capabilities, and risk codes only. | Managed vaulting, team-safe secret references, and remote-worker scoped injection are future work. |
| Agent gets too many tools or permissions | Profiles, agent teams, and OpenCode permissions constrain access. | Deeper runtime isolation and resource contracts remain future work. |
| Duplicate local daemon mutates state | Local writer leadership fences scheduler/channel writes. | Multi-host execution is not implemented; local writer leadership is the only supported model. |
| Remote worker receives broad filesystem, network, or secret access | Runtime isolation records local environment policy and forbids root workdirs, wildcard remote egress, raw secret material, missing cleanup proof, and worker-applied results. | Remote worker pools and hosted execution are not release claims until sandbox, quota, audit, identity, and topology evidence land. |
| Runaway schedules, retries, or channel sends create unbounded spend or spam | Local governance budgets, scheduler retry limits, capacity holds, channel outbox backoff, dead letters, alerts, and operator pause/resume controls bound the local install. | Tenant-aware quotas and hosted abuse controls remain future design work. |
| Third-party connector, MCP, skill, tool, or agent package widens authority | Asset writes require local `asset_write`/admin; profile/team inspection blocks unknown refs and broad unsafe permissions. | Package manifest trust, integrity, capability diff, install approval, audit, and rollback remain future design work. |
| Operator deploys an unsupported hybrid topology | Local-only mode keeps one writer, local SQLite, local auth, and operator-managed recovery. | Self-hosted/hosted claims require topology, SLO, DR, backend, identity, secrets, audit, and support evidence before release. |

## Readiness Integration

`opencode-gateway readiness` includes security checks for the local boundary: `security_http_boundary` (localhost binding and exposed-mode auth), `security_channel_trust` (fail-closed channel allowlists), `security_secret_placement` (credentials kept out of config), and `security_dangerous_permissions` (bash/edit exposure). Route, tool, and channel-command capability classification is enforced by the focused test suite, which fails when a new surface is not classified — privileged trusted-channel commands must carry sender/binding requirements, OpenCode question/permission decisions must be marked OpenCode-owned, exposed HTTP routes must fail closed, and evidence export rows must carry redaction guidance. This is local single-operator authorization evidence only; it does not prove hosted/team RBAC or multi-tenant isolation.

Readiness also includes `security_secret_lifecycle`. It reports local credential posture without values: configured input IDs, credential classes, env var names, config key names, risk codes, and remediation only. It warns for local compatibility risks such as config-file secret storage or legacy admin HTTP tokens, and fails for hard lifecycle gaps such as WhatsApp credentials without a signed-webhook app secret.

Readiness also includes `compliance_audit_retention`. It reports that local redacted evidence, incident bundles, and an append-only local hash-chained audit ledger foundation are supported, while compliance-grade hosted/team storage, legal hold, and access trails remain unsupported until later implementation evidence exists.

Readiness also includes `governance_quota_budget_model`. It reports local single-operator governance support and makes tenant quota / hosted abuse-control gaps explicit.

Beyond readiness checks, `local-process` remains the supported execution default: local containers and operator-managed remote capacity require explicit operator configuration, self-hosted workers are design-only, and hosted workers are unsupported. The local-only deployment boundary and package/marketplace enforcement gaps are enforced as blocked claims in the claim registry (`opencode-gateway release claims`).

This is an enforcement aid, not a hosted security certification. A passing readiness report means the local-first capability inventory is present and internally consistent; it does not prove multi-user RBAC, hosted tenancy, managed secret custody, or remote-worker sandboxing.

## Release Claim Boundary

Allowed by the current public-release decision (see the [Decision Log](../history/decision-log.md)):

- Supervised local beta for one trusted operator.
- Local plus trusted channels with explicit allowlists or claim-based trust.
- Constrained provider webhook ingress for documented provider routes.
- Capability-scoped exposed HTTP for advanced local/self-managed setups.

Not allowed without later evidence:

- Hosted control plane readiness.
- Team or multi-tenant RBAC.
- Remote worker pool / multi-host execution readiness.
- Compliance certification.
- Marketplace or external extension ecosystem safety.

These blocked claims are machine-checked by the claim registry; the hosted/team-scale product boundary remains the first larger decision ahead.
