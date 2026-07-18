import { classifyGatewayTool, type McpToolTier } from './mcp-tool-tiers.js'

export const GATEWAY_MCP_TOOL_NAMES = [
  'gateway_catalog',
  'gateway_dashboard',
  'gateway_observability',
  'gateway_health',
  'gateway_doctor',
  'gateway_readiness',
  'gateway_governance',
  'gateway_attention',
  'gateway_briefing',
  'gateway_triage',
  'gateway_alerts',
  'gateway_roadmap_supervisor_observability',
  'gateway_alert_action',
  'gateway_incident_report',
  'gateway_analytics_summary',
  'gateway_analytics_scorecard',
  'gateway_human_gate_list',
  'gateway_human_gate_create',
  'gateway_human_gate_decide',
  'gateway_logs',
  'gateway_config_get',
  'gateway_config_update',
  'gateway_backup_create',
  'gateway_backup_list',
  'gateway_backup_verify',
  'gateway_recovery_drill',
  'gateway_state_export',
  'gateway_restore',
  'gateway_restart',
  'gateway_channel_binding_list',
  'gateway_channel_connector_status',
  'gateway_channel_binding_get',
  'gateway_channel_binding_upsert',
  'gateway_channel_binding_delete',
  'gateway_channel_send',
  'gateway_channel_send_to_task',
  'gateway_channel_send_to_roadmap',
  'gateway_roadmap_create',
  'gateway_delegation_submit',
  'gateway_roadmap_list',
  'gateway_roadmap_get',
  'gateway_roadmap_create_with_tasks',
  'gateway_plan_initiative',
  'gateway_roadmap_update',
  'gateway_roadmap_recompute',
  'gateway_roadmap_memory',
  'gateway_roadmap_completion_proposal_list',
  'gateway_roadmap_completion_proposal_get',
  'gateway_roadmap_completion_propose',
  'gateway_roadmap_completion_decide',
  'gateway_roadmap_archive',
  'gateway_roadmap_delete',
  'gateway_roadmap_supervisor_list',
  'gateway_roadmap_supervisor_get',
  'gateway_roadmap_supervisor_create',
  'gateway_roadmap_supervisor_update',
  'gateway_roadmap_supervisor_archive',
  'gateway_project_binding_list',
  'gateway_project_binding_get',
  'gateway_project_binding_upsert',
  'gateway_project_binding_update',
  'gateway_project_binding_delete',
  'gateway_project_context_resolve',
  'gateway_project_create',
  'gateway_project_status',
  'gateway_project_digest',
  'gateway_project_review_now',
  'gateway_project_completion_decide',
  'gateway_task_create',
  'gateway_task_bulk_create',
  'gateway_task_list',
  'gateway_task_get',
  'gateway_task_update',
  'gateway_task_dependency_list',
  'gateway_task_dependency_add',
  'gateway_task_dependency_delete',
  'gateway_task_bulk_update',
  'gateway_task_archive',
  'gateway_task_delete',
  'gateway_active_run_list',
  'gateway_active_run_control',
  'gateway_artifact_manifest_list',
  'gateway_artifact_manifest_get',
  'gateway_run_list',
  'gateway_run_get',
  'gateway_environment_list',
  'gateway_environment_get',
  'gateway_environment_action',
  'gateway_environment_reconcile',
  'gateway_work_events',
  'gateway_team_assignment_create',
  'gateway_team_assignment_list',
  'gateway_team_assignment_get',
  'gateway_team_assignment_receipt_record',
  'gateway_scheduler_status',
  'gateway_scheduler_pause',
  'gateway_scheduler_resume',
  'gateway_scheduler_run_once',
  'gateway_dispatch_now',
  'gateway_scheduler_configure',
  'gateway_question_list',
  'gateway_question_reply',
  'gateway_question_reject',
  'gateway_permission_list',
  'gateway_permission_reply',
  'gateway_permission_reject',
  'gateway_opencode_session_list',
  'gateway_opencode_session_get',
  'gateway_opencode_session_messages',
  'gateway_opencode_session_children',
  'gateway_opencode_session_web_url',
  'gateway_opencode_session_abort',
  'gateway_profile_list',
  'gateway_agent_catalog_list',
  'gateway_team_assemble',
  'gateway_profile_inspect',
  'gateway_profile_upsert',
  'gateway_profile_delete',
  'gateway_agent_team_list',
  'gateway_agent_team_get',
  'gateway_agent_team_inspect',
  'gateway_agent_team_validate',
  'gateway_agent_team_propose',
  'gateway_agent_team_apply',
  'gateway_agent_team_delete',
  'gateway_agent_team_bind',
  'gateway_promotion_scorecard_list',
  'gateway_promotion_scorecard_create',
  'gateway_promotion_state',
  'gateway_promotion_decide',
  'gateway_blueprint_preview',
  'gateway_blueprint_catalog_list',
  'gateway_blueprint_preview_text',
  'gateway_blueprint_apply',
  'gateway_opencode_mcp_list',
  'gateway_opencode_mcp_upsert',
  'gateway_opencode_mcp_delete',
  'gateway_opencode_tool_list',
  'gateway_opencode_tool_upsert',
  'gateway_opencode_tool_delete',
  'gateway_opencode_agent_list',
  'gateway_opencode_agent_upsert',
  'gateway_opencode_agent_delete',
  'gateway_opencode_skill_list',
  'gateway_opencode_skill_upsert',
  'gateway_opencode_skill_delete',
  'gateway_persona_list',
  'gateway_persona_create',
  'gateway_agent_presence_list',
  'gateway_agent_presence_get',
  'gateway_agent_presence_create',
  'gateway_agent_presence_update',
  'gateway_session_admit',
] as const

export function isGatewayMcpToolName(name: string): boolean {
  return (GATEWAY_MCP_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * Discovery catalog for the ~140 `gateway_*` MCP tools.
 *
 * This is the single source of truth for in-band tool discovery: it powers the
 * `gateway_catalog` MCP tool (so an agent can navigate the surface without
 * reading source) and the generated `docs/api/mcp-tools.md` reference. Tools
 * registered via loops in `src/mcp.ts` (task_/project_ lifecycle families) are
 * included here even though they are not literal entries in
 * `GATEWAY_MCP_TOOL_NAMES`. A test asserts this catalog stays in parity with the
 * tools actually registered in `src/mcp.ts`.
 *
 * `name` is the registered tool name without the `gateway_` prefix; OpenCode
 * exposes it as `gateway_<name>`. The tier is derived from
 * `classifyGatewayTool` — never stored here — so the catalog and the runtime
 * access surface cannot drift.
 */
export interface GatewayToolCatalogEntry {
  /** Registered tool name without the `gateway_` prefix. */
  name: string
  /** Logical group id (see GATEWAY_TOOL_GROUPS for the display title/order). */
  group: string
  /** One-line purpose for discovery. */
  summary: string
}

/** Ordered group ids with human-readable titles, used for grouped rendering. */
export const GATEWAY_TOOL_GROUPS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'discovery', title: 'Discovery' },
  { id: 'workflows', title: 'Composite Workflows' },
  { id: 'observability', title: 'Dashboards and Observability' },
  { id: 'analytics', title: 'Run Analytics and Scorecards' },
  { id: 'human-loop', title: 'Human Loop and OpenCode Requests' },
  { id: 'service', title: 'Service and Config' },
  { id: 'backup', title: 'Backup and Ops' },
  { id: 'scheduler', title: 'Scheduler, Profiles, and Promotion' },
  { id: 'agent-teams', title: 'Agent Teams' },
  { id: 'blueprints', title: 'Blueprints' },
  { id: 'roadmap', title: 'Initiatives (Roadmaps)' },
  { id: 'project', title: 'Projects' },
  { id: 'work', title: 'Issues, Tasks, and Runs' },
  { id: 'opencode-sessions', title: 'OpenCode Sessions' },
  { id: 'opencode-assets', title: 'OpenCode Assets' },
  { id: 'channel', title: 'Channels' },
]

export const GATEWAY_TOOL_CATALOG: readonly GatewayToolCatalogEntry[] = [
  { name: 'catalog', group: 'discovery', summary: 'List the grouped Gateway MCP tool inventory with each tool\'s group, tier, and purpose for in-band discovery.' },

  { name: 'plan_initiative', group: 'workflows', summary: 'One atomic call: create an Initiative + its Issues + dependency edges (+ optional supervisor). Replaces roadmap_create_with_tasks + N task_dependency_add (+ supervisor_create).' },

  { name: 'dashboard', group: 'observability', summary: 'Text dashboard: health, scheduler, Issues, Initiatives, runs, sessions, and pending OpenCode requests.' },
  { name: 'briefing', group: 'observability', summary: 'Latest main-agent briefing: changed work, active runs, blockers, gates, completions, alerts, and next actions.' },
  { name: 'observability', group: 'observability', summary: 'Session, token, cost, and per-agent execution trace summary from observability artifacts.' },
  { name: 'roadmap_supervisor_observability', group: 'observability', summary: 'Initiative Supervisor health, due/leased state, last results, and recent supervisor audit events.' },
  { name: 'health', group: 'observability', summary: 'Daemon health, scheduler config, and queue counts.' },
  { name: 'doctor', group: 'observability', summary: 'Deterministic Gateway diagnostic report.' },
  { name: 'readiness', group: 'observability', summary: 'Local operating readiness state, checks, and operating mode.' },
  { name: 'governance', group: 'observability', summary: 'Budget, quota, token, cost, and runtime governance status.' },
  { name: 'attention', group: 'observability', summary: 'Unified Needs Attention across Gateway gates, tasks, runs, and OpenCode-native requests.' },
  { name: 'triage', group: 'observability', summary: 'One read for the whole operator attention set: gates, questions, permissions, blocked tasks, stale runs, completion proposals, and active alerts. Start here.' },
  { name: 'alerts', group: 'observability', summary: 'Active alerts with severity, evidence, and next actions.' },
  { name: 'alert_action', group: 'observability', summary: 'Acknowledge, resolve, or suppress a Gateway alert.' },
  { name: 'incident_report', group: 'observability', summary: 'Generate a local incident report from alert lifecycle and workflow events.' },
  { name: 'logs', group: 'observability', summary: 'Read recent Gateway daemon log lines.' },
  { name: 'work_events', group: 'observability', summary: 'List recent Gateway-owned workflow events.' },

  { name: 'analytics_summary', group: 'analytics', summary: 'Run-history spend/usage by profile, agent, or roadmap with outcome distribution, retry hotspots, and budget trend over a bounded window.' },
  { name: 'analytics_scorecard', group: 'analytics', summary: 'Per-profile/agent completion + cost scorecard (completion rate, avg attempts, cost-per-completed-task) with derived underperformers, an errored-run error-class breakdown (operational/external/genuine/unknown), and the genuine-failure-rate over a window.' },

  { name: 'human_gate_list', group: 'human-loop', summary: 'List Gateway-level human approval gates.' },
  { name: 'human_gate_create', group: 'human-loop', summary: 'Create a durable Gateway human gate for a task, run, stage, or roadmap decision.' },
  { name: 'human_gate_decide', group: 'human-loop', summary: 'Approve or reject a Gateway human gate with once/always scope and audit trail.' },
  { name: 'question_list', group: 'human-loop', summary: 'List pending OpenCode-native questions.' },
  { name: 'question_reply', group: 'human-loop', summary: 'Reply to an OpenCode-native question.' },
  { name: 'question_reject', group: 'human-loop', summary: 'Reject an OpenCode-native question.' },
  { name: 'permission_list', group: 'human-loop', summary: 'List pending OpenCode-native permission requests.' },
  { name: 'permission_reply', group: 'human-loop', summary: 'Approve or reject an OpenCode-native permission request. Approval is admin-tier because it grants OpenCode shell/edit capability.' },
  { name: 'permission_reject', group: 'human-loop', summary: 'Reject an OpenCode-native permission request without granting shell/edit capability.' },

  { name: 'config_get', group: 'service', summary: 'Read Gateway configuration with secrets redacted.' },
  { name: 'config_update', group: 'service', summary: 'Patch Gateway config; destructive approval gating may require an approvedGateId retry.' },
  { name: 'restart', group: 'service', summary: 'Request Gateway daemon restart (admin tier, audited; no human gate).' },

  { name: 'backup_create', group: 'backup', summary: 'Create a timestamped Gateway state backup; refuses active runs unless allowActiveRuns=true.' },
  { name: 'backup_list', group: 'backup', summary: 'List Gateway state backups and verification status.' },
  { name: 'backup_verify', group: 'backup', summary: 'Verify a backup checksum, metadata, and SQLite integrity.' },
  { name: 'recovery_drill', group: 'backup', summary: 'Restore a backup into isolated state and write scheduler/storage/channel recovery evidence.' },
  { name: 'state_export', group: 'backup', summary: 'Export durable Gateway state as JSON for audit or machine transfer.' },
  { name: 'restore', group: 'backup', summary: 'Restore state from a verified backup (maintenanceMode + destructive approval).' },

  { name: 'scheduler_status', group: 'scheduler', summary: 'Scheduler configuration and queue counts.' },
  { name: 'scheduler_pause', group: 'scheduler', summary: 'Pause the Gateway scheduler.' },
  { name: 'scheduler_resume', group: 'scheduler', summary: 'Resume the Gateway scheduler.' },
  { name: 'scheduler_run_once', group: 'scheduler', summary: 'Run one scheduler cycle immediately.' },
  { name: 'dispatch_now', group: 'scheduler', summary: 'Run a scheduler cycle now, dispatching ALL ready work up to maxConcurrent (not just one task). Honors a paused scheduler (truthful no-op when paused; resume it explicitly). A taskId/roadmapId ensures that target is eligible and highlights whether it dispatched, without hiding the rest of the cycle. Collapses scheduler_run_once + status.' },
  { name: 'scheduler_configure', group: 'scheduler', summary: 'Update scheduler settings deterministically.' },
  { name: 'profile_list', group: 'scheduler', summary: 'List Gateway scheduler profiles.' },
  { name: 'profile_inspect', group: 'scheduler', summary: 'Inspect effective access, grants, and least-privilege warnings for one profile.' },
  { name: 'profile_upsert', group: 'scheduler', summary: 'Create or update a Gateway scheduler profile.' },
  { name: 'profile_delete', group: 'scheduler', summary: 'Delete a scheduler profile not referenced by stages.' },
  { name: 'agent_catalog_list', group: 'scheduler', summary: 'List the Agent Factory catalog of profiles, teams, and persisted blueprints.' },
  { name: 'team_assemble', group: 'scheduler', summary: 'Assemble a deterministic bounded team from a blueprint without dispatching sessions.' },
  { name: 'team_assignment_create', group: 'scheduler', summary: 'Create executable team assignments with scoped grants, budgets, evidence, gates, and receipts.' },
  { name: 'team_assignment_list', group: 'scheduler', summary: 'List durable team assignments with gate/review/completion receipts.' },
  { name: 'team_assignment_get', group: 'scheduler', summary: 'Get one durable team assignment with receipt history.' },
  { name: 'team_assignment_receipt_record', group: 'scheduler', summary: 'Record a gate result, review outcome, or completion receipt for a team assignment.' },
  { name: 'promotion_scorecard_list', group: 'scheduler', summary: 'List scorecards for Gateway profiles or teams.' },
  { name: 'promotion_scorecard_create', group: 'scheduler', summary: 'Create or update a profile/team scorecard from structured eval evidence.' },
  { name: 'promotion_state', group: 'scheduler', summary: 'Show promotion state and decision history for a profile or team.' },
  { name: 'promotion_decide', group: 'scheduler', summary: 'Human-gated promote, deprecate, rollback, or block of a profile/team.' },

  { name: 'agent_team_list', group: 'agent-teams', summary: 'List Gateway project-scoped agent teams.' },
  { name: 'agent_team_get', group: 'agent-teams', summary: 'Get one agent team and its current references.' },
  { name: 'agent_team_inspect', group: 'agent-teams', summary: 'Inspect effective team access, role/profile grants, and least-privilege warnings.' },
  { name: 'agent_team_validate', group: 'agent-teams', summary: 'Validate an agent team proposal without mutating config.' },
  { name: 'agent_team_propose', group: 'agent-teams', summary: 'Propose an agent team and open a human gate to apply it.' },
  { name: 'agent_team_apply', group: 'agent-teams', summary: 'Apply an agent team after an approved human gate.' },
  { name: 'agent_team_bind', group: 'agent-teams', summary: 'Bind an agent team to one roadmap or task after an approved human gate.' },
  { name: 'agent_team_delete', group: 'agent-teams', summary: 'Delete an unreferenced agent team after an approved human gate.' },

  { name: 'blueprint_catalog_list', group: 'blueprints', summary: 'List persisted blueprint files with validation, diff summary, and source metadata.' },
  { name: 'blueprint_preview', group: 'blueprints', summary: 'Validate a blueprint and return structured diff/preview without mutating anything.' },
  { name: 'blueprint_preview_text', group: 'blueprints', summary: 'Validate a blueprint and return a readable diff/preview.' },
  { name: 'blueprint_apply', group: 'blueprints', summary: 'Apply a valid blueprint after an approved human gate.' },

  { name: 'roadmap_create', group: 'roadmap', summary: 'Create a durable Initiative (roadmap).' },
  { name: 'delegation_submit', group: 'roadmap', summary: 'Accept a DelegationRequest v1 and create/replay durable work with an idempotent receipt.' },
  { name: 'roadmap_list', group: 'roadmap', summary: 'List durable Initiatives (roadmaps).' },
  { name: 'roadmap_get', group: 'roadmap', summary: 'Get one Initiative by roadmap ID.' },
  { name: 'roadmap_create_with_tasks', group: 'roadmap', summary: 'Create an Initiative and child Issues atomically.' },
  { name: 'roadmap_update', group: 'roadmap', summary: 'Update Initiative title, status, or priority.' },
  { name: 'roadmap_recompute', group: 'roadmap', summary: 'Recompute Initiative status from child Issue states.' },
  { name: 'roadmap_memory', group: 'roadmap', summary: 'Show bounded Initiative memory: decisions, evidence, failures, recent Issues.' },
  { name: 'roadmap_completion_proposal_list', group: 'roadmap', summary: 'List roadmap completion proposals.' },
  { name: 'roadmap_completion_proposal_get', group: 'roadmap', summary: 'Get one roadmap completion proposal.' },
  { name: 'roadmap_completion_propose', group: 'roadmap', summary: 'Propose completion with evidence, residual risks, and recommendation.' },
  { name: 'roadmap_completion_decide', group: 'roadmap', summary: 'Approve or reject a pending completion proposal.' },
  { name: 'roadmap_archive', group: 'roadmap', summary: 'Archive an Initiative and its child Issues.' },
  { name: 'roadmap_delete', group: 'roadmap', summary: 'Delete an Initiative and its child Issues/runs.' },
  { name: 'roadmap_supervisor_list', group: 'roadmap', summary: 'List durable Initiative Supervisors.' },
  { name: 'roadmap_supervisor_get', group: 'roadmap', summary: 'Get one Initiative Supervisor.' },
  { name: 'roadmap_supervisor_create', group: 'roadmap', summary: 'Create an Initiative Supervisor for a roadmap and OpenCode session.' },
  { name: 'roadmap_supervisor_update', group: 'roadmap', summary: 'Update supervisor profile, status, cadence, cursor, or policy.' },
  { name: 'roadmap_supervisor_archive', group: 'roadmap', summary: 'Archive a roadmap supervisor.' },

  { name: 'project_binding_list', group: 'project', summary: 'List project aliases and channel/OpenCode surface bindings.' },
  { name: 'project_binding_get', group: 'project', summary: 'Get one project binding.' },
  { name: 'project_binding_upsert', group: 'project', summary: 'Create or rebind a project alias to a roadmap, session, and optional surface.' },
  { name: 'project_binding_update', group: 'project', summary: 'Update a project binding.' },
  { name: 'project_binding_delete', group: 'project', summary: 'Delete a project binding.' },
  { name: 'project_context_resolve', group: 'project', summary: 'Resolve current project context by alias, roadmap, session, or channel surface.' },
  { name: 'project_create', group: 'project', summary: 'Create a supervised project with roadmap, default supervisor, and alias binding.' },
  { name: 'project_status', group: 'project', summary: 'Show project status for the resolved context.' },
  { name: 'project_digest', group: 'project', summary: 'Show recent project events and decisions for the resolved context.' },
  { name: 'project_review_now', group: 'project', summary: 'Queue an immediate supervisor review for the resolved project.' },
  { name: 'project_completion_decide', group: 'project', summary: 'Approve or reject the resolved project\'s pending completion proposal.' },
  { name: 'project_pause', group: 'project', summary: 'Pause the resolved project\'s roadmap supervisor.' },
  { name: 'project_resume', group: 'project', summary: 'Resume the resolved project\'s roadmap supervisor.' },

  { name: 'task_create', group: 'work', summary: 'Create a durable Issue (scheduler task).' },
  { name: 'task_bulk_create', group: 'work', summary: 'Create multiple Issues atomically.' },
  { name: 'task_list', group: 'work', summary: 'List durable Issues (scheduler tasks).' },
  { name: 'task_get', group: 'work', summary: 'Get an Issue by task ID.' },
  { name: 'task_update', group: 'work', summary: 'Update task fields deterministically.' },
  { name: 'task_bulk_update', group: 'work', summary: 'Update multiple tasks atomically.' },
  { name: 'task_dependency_list', group: 'work', summary: 'List dependencies and readiness for a task.' },
  { name: 'task_dependency_add', group: 'work', summary: 'Add a dependency that must complete before a task can run.' },
  { name: 'task_dependency_delete', group: 'work', summary: 'Delete a task dependency.' },
  { name: 'task_pause', group: 'work', summary: 'Pause a task.' },
  { name: 'task_resume', group: 'work', summary: 'Resume a paused task.' },
  { name: 'task_cancel', group: 'work', summary: 'Cancel a task.' },
  { name: 'task_retry', group: 'work', summary: 'Retry a task.' },
  { name: 'task_done', group: 'work', summary: 'Mark a task done.' },
  { name: 'task_block', group: 'work', summary: 'Block a task.' },
  { name: 'task_archive', group: 'work', summary: 'Archive a task.' },
  { name: 'task_delete', group: 'work', summary: 'Delete a task and its runs.' },
  { name: 'active_run_list', group: 'work', summary: 'List active runs with lease owner, heartbeat freshness, and cancel/restart eligibility.' },
  { name: 'active_run_control', group: 'work', summary: 'Apply one lease-safe active-run control: cancel, stop, retry, or restart.' },
  { name: 'artifact_manifest_list', group: 'work', summary: 'List bounded local run artifact manifests with redacted refs and counts.' },
  { name: 'artifact_manifest_get', group: 'work', summary: 'Get one bounded local run artifact manifest without raw file paths.' },
  { name: 'run_list', group: 'work', summary: 'List recent scheduler runs.' },
  { name: 'run_get', group: 'work', summary: 'Get a run by run ID or OpenCode session ID.' },
  { name: 'environment_list', group: 'work', summary: 'List execution environments with backend, lease, cleanup, and artifact state.' },
  { name: 'environment_get', group: 'work', summary: 'Inspect one execution environment by environment ID or run ID.' },
  { name: 'environment_action', group: 'work', summary: 'Retain, release, abort, or cleanup one execution environment.' },
  { name: 'environment_reconcile', group: 'work', summary: 'Reconcile stale execution environments and summarize cleanup state.' },

  { name: 'opencode_session_list', group: 'opencode-sessions', summary: 'List OpenCode sessions, optionally Gateway-only.' },
  { name: 'opencode_session_get', group: 'opencode-sessions', summary: 'Get one OpenCode session and Web/TUI links.' },
  { name: 'opencode_session_messages', group: 'opencode-sessions', summary: 'Read recent messages for an OpenCode session.' },
  { name: 'opencode_session_children', group: 'opencode-sessions', summary: 'List child sessions for an OpenCode session.' },
  { name: 'opencode_session_web_url', group: 'opencode-sessions', summary: 'Return the OpenCode Web URL for a session, or fallback link text.' },
  { name: 'opencode_session_abort', group: 'opencode-sessions', summary: 'Abort an OpenCode session.' },

  { name: 'opencode_mcp_list', group: 'opencode-assets', summary: 'List OpenCode MCP server config entries.' },
  { name: 'opencode_mcp_upsert', group: 'opencode-assets', summary: 'Create or update an OpenCode MCP server config entry.' },
  { name: 'opencode_mcp_delete', group: 'opencode-assets', summary: 'Delete an OpenCode MCP server config entry.' },
  { name: 'opencode_tool_list', group: 'opencode-assets', summary: 'List OpenCode custom tool files.' },
  { name: 'opencode_tool_upsert', group: 'opencode-assets', summary: 'Create or update an OpenCode custom tool file.' },
  { name: 'opencode_tool_delete', group: 'opencode-assets', summary: 'Delete an OpenCode custom tool file.' },
  { name: 'opencode_agent_list', group: 'opencode-assets', summary: 'List OpenCode-native agents.' },
  { name: 'opencode_agent_upsert', group: 'opencode-assets', summary: 'Create or update an OpenCode-native agent.' },
  { name: 'opencode_agent_delete', group: 'opencode-assets', summary: 'Delete an OpenCode-native agent.' },
  { name: 'opencode_skill_list', group: 'opencode-assets', summary: 'List OpenCode skills.' },
  { name: 'opencode_skill_upsert', group: 'opencode-assets', summary: 'Create or update an OpenCode skill SKILL.md file.' },
  { name: 'opencode_skill_delete', group: 'opencode-assets', summary: 'Delete an OpenCode skill directory.' },
  { name: 'persona_list', group: 'opencode-assets', summary: 'List OpenCode agents labeled as personas.' },
  { name: 'persona_create', group: 'opencode-assets', summary: 'Create a primary-mode OpenCode agent persona.' },
  { name: 'agent_presence_list', group: 'opencode-sessions', summary: 'List always-on AgentPresence bindings.' },
  { name: 'agent_presence_get', group: 'opencode-sessions', summary: 'Get one AgentPresence record.' },
  { name: 'agent_presence_create', group: 'opencode-sessions', summary: 'Create an AgentPresence sticky assistant binding.' },
  { name: 'agent_presence_update', group: 'opencode-sessions', summary: 'Update AgentPresence status/channel/session binding.' },
  { name: 'session_admit', group: 'opencode-sessions', summary: 'Capacity-gated OpenCode session admit (no free spawn).' },

  { name: 'channel_connector_status', group: 'channel', summary: 'List channel connector setup status with redacted prerequisites and repair diagnostics.' },
  { name: 'channel_binding_list', group: 'channel', summary: 'List Telegram/WhatsApp channel bindings.' },
  { name: 'channel_binding_get', group: 'channel', summary: 'Get one channel binding.' },
  { name: 'channel_binding_upsert', group: 'channel', summary: 'Create or update a channel binding.' },
  { name: 'channel_binding_delete', group: 'channel', summary: 'Delete a channel binding.' },
  { name: 'channel_send', group: 'channel', summary: 'Send a message to a specific configured channel chat.' },
  { name: 'channel_send_to_task', group: 'channel', summary: 'Send a message to channels bound to a task or its roadmap.' },
  { name: 'channel_send_to_roadmap', group: 'channel', summary: 'Send a message to channels bound to a roadmap.' },
]

export interface GatewayToolCatalogGroup {
  id: string
  title: string
  tools: Array<{ name: string; qualifiedName: string; tier: McpToolTier; summary: string }>
}

/** Group the catalog and attach the runtime tier for each tool. */
export function buildGatewayToolCatalog(): GatewayToolCatalogGroup[] {
  const byGroup = new Map<string, GatewayToolCatalogGroup>()
  for (const meta of GATEWAY_TOOL_GROUPS) byGroup.set(meta.id, { id: meta.id, title: meta.title, tools: [] })
  for (const entry of GATEWAY_TOOL_CATALOG) {
    const group = byGroup.get(entry.group)
    if (!group) throw new Error(`Unknown catalog group '${entry.group}' for tool '${entry.name}'`)
    group.tools.push({
      name: entry.name,
      qualifiedName: `gateway_${entry.name}`,
      tier: classifyGatewayTool(entry.name),
      summary: entry.summary,
    })
  }
  return [...byGroup.values()].filter(group => group.tools.length > 0)
}

/** Render the grouped catalog as compact discovery text for the `gateway_catalog` MCP tool. */
export function formatGatewayToolCatalogText(mode?: McpToolTier): string {
  const groups = buildGatewayToolCatalog()
  const total = GATEWAY_TOOL_CATALOG.length
  const lines: string[] = [
    `# Gateway MCP Tool Catalog (${total} tools)`,
    '',
    'Tools are exposed to OpenCode as `gateway_<name>`. Tiers: read (inspection),',
    'operate (day-to-day work), admin (config and destructive control). The active',
    'surface is bounded by GATEWAY_MCP_TOOLS; each tier includes the tiers below it.',
  ]
  if (mode) lines.push('', `Active tier: ${mode}. Tools above this tier are hidden from this server.`)
  for (const group of groups) {
    lines.push('', `## ${group.title}`)
    for (const tool of group.tools) lines.push(`- ${tool.qualifiedName} [${tool.tier}]: ${tool.summary}`)
  }
  return lines.join('\n')
}
