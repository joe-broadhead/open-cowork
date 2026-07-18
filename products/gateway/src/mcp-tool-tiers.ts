/**
 * MCP tool tiers.
 *
 * Gateway registers ~150 `gateway_*` MCP tools. Handing an agent all of them
 * at once hurts tool selection and widens the blast radius of a confused
 * agent. Tools are therefore classified into three cumulative tiers:
 *
 *   read     inspection only: lists, gets, status, dashboards, logs,
 *            observability, readiness, previews, redacted reports.
 *   operate  day-to-day work: task/roadmap lifecycle, delegation, channel
 *            sends, human gates, question replies, permission rejection, scheduler
 *            pause/resume.
 *   admin    configuration and destructive control: config updates, profile
 *            and team mutation, OpenCode asset upserts/deletes, session
 *            aborts, restore, restart.
 *
 * The active tier comes from GATEWAY_MCP_TOOLS (read|operate|admin) at MCP
 * server start; each tier includes the tiers below it. The default is
 * `operate` (see resolveMcpToolMode) — a deliberate choice, not an accident:
 * the default single-operator agent gets every day-to-day workflow tool,
 * including the composite `plan_initiative` and `dispatch_now` (operate) and
 * `triage` (read), but NOT admin/config, asset mutation, restart, restore, or
 * delete authority. Those stay opt-in behind GATEWAY_MCP_TOOLS=admin so a
 * confused or compromised default agent cannot rewrite config/assets or
 * destroy durable state. Raising the default to `admin` was considered and
 * rejected: it would widen the blast radius of the default surface for no
 * everyday benefit. Operators who want their agent to manage config/assets
 * opt into admin explicitly.
 */

import type { HttpCapability } from './security.js'

export type McpToolTier = 'read' | 'operate' | 'admin'

const READ_TOOLS = new Set([
  'catalog',
  'dashboard', 'observability', 'health', 'doctor', 'readiness', 'governance',
  'attention', 'triage', 'briefing', 'alerts', 'logs', 'incident_report',
  'analytics_summary', 'analytics_scorecard',
  'work_events', 'roadmap_memory', 'promotion_state',
  'project_digest', 'project_status', 'project_context_resolve',
  'channel_connector_status', 'permission_list', 'question_list',
])

const ADMIN_TOOLS = new Set([
  'config_update', 'profile_upsert', 'profile_delete',
  'backup_create', 'backup_verify', 'recovery_drill', 'state_export',
  'agent_team_apply', 'agent_team_bind', 'agent_team_delete',
  // These routes are protected by the asset_write HTTP capability. MCP has no
  // separate asset-write mode, so they belong to its cumulative admin tier.
  'team_assemble', 'agent_team_validate', 'agent_team_propose',
  'blueprint_apply', 'promotion_decide',
  'opencode_agent_upsert', 'opencode_agent_delete',
  'persona_create',
  // Session-creating and trusted-routing-binding primitives are operator setup,
  // not day-to-day agent actions: keep them out of the default `operate` tier so
  // a delegated agent cannot spawn sessions or re-point the operator's sticky
  // free-text channel to an agent/session of its choosing.
  'session_admit', 'agent_presence_create', 'agent_presence_update',
  'opencode_skill_upsert', 'opencode_skill_delete',
  'opencode_tool_upsert', 'opencode_tool_delete',
  'opencode_mcp_upsert', 'opencode_mcp_delete',
  'opencode_session_abort', 'opencode_session_messages',
  'scheduler_configure',
  // Approving OpenCode permissions grants the exact shell/edit capability that
  // OpenCode asked a human to authorize, so keep `once`/`always` approval out of
  // the default operate tier. The separate permission_reject tool remains
  // available for day-to-day safe denial.
  'permission_reply',
  'channel_binding_upsert', 'channel_binding_delete',
  'project_binding_upsert', 'project_binding_update', 'project_binding_delete',
  'task_delete', 'roadmap_delete',
  'restore', 'restart',
])

const OPERATE_TOOLS = new Set([
  // Preview is mutation-free, but its POST route intentionally requires the
  // operator HTTP capability. Override the generic `_preview` read suffix so a
  // read-tier server never advertises a call its capability guard must reject.
  'blueprint_preview', 'blueprint_preview_text',
])

const READ_SUFFIXES = [
  '_list', '_get', '_status', '_inspect', '_preview', '_preview_text',
  '_observability', '_messages', '_children', '_web_url', '_scorecard_list',
]

export function classifyGatewayTool(name: string): McpToolTier {
  if (ADMIN_TOOLS.has(name)) return 'admin'
  if (OPERATE_TOOLS.has(name)) return 'operate'
  if (READ_TOOLS.has(name)) return 'read'
  if (READ_SUFFIXES.some(suffix => name.endsWith(suffix))) return 'read'
  return 'operate'
}

export function resolveMcpToolMode(raw: string | undefined): McpToolTier {
  if (raw === 'read' || raw === 'operate' || raw === 'admin') return raw
  return 'operate'
}

export function toolEnabledForMode(name: string, mode: McpToolTier): boolean {
  const tier = classifyGatewayTool(name)
  if (mode === 'admin') return true
  if (mode === 'operate') return tier !== 'admin'
  return tier === 'read'
}

export function minimumMcpTierForHttpCapability(capability: HttpCapability): McpToolTier {
  if (capability === 'admin' || capability === 'asset_write') return 'admin'
  if (capability === 'operator') return 'operate'
  return 'read'
}

export function mcpModeAllowsHttpCapability(mode: McpToolTier, capability: HttpCapability): boolean {
  const required = minimumMcpTierForHttpCapability(capability)
  if (mode === 'admin') return true
  if (mode === 'operate') return required !== 'admin'
  return required === 'read'
}
