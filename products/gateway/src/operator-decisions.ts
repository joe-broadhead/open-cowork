import type { PendingPermissionRequest, PendingQuestionRequest } from './opencode-requests.js'
import type { HumanGateRecord, RoadmapCompletionProposalRecord } from './work-store.js'

export type OperatorDecisionSource =
  | 'gateway_human_gate'
  | 'gateway_completion_proposal'
  | 'opencode_question'
  | 'opencode_permission'
  | 'channel_action'

export type OperatorDecisionOwner = 'gateway' | 'opencode' | 'channel'

export type OperatorDecisionState =
  | 'pending'
  | 'answered'
  | 'expired'
  | 'denied'
  | 'requires_open_code'
  | 'requires_gateway'
  | 'stale'
  | 'blocked'

export interface OperatorDecisionAction {
  id: string
  label: string
  command?: string
  owner: OperatorDecisionOwner
  enabled: boolean
  style?: 'primary' | 'danger'
  reason?: string
}

export interface OperatorDecisionSummary {
  id: string
  source: OperatorDecisionSource
  owner: OperatorDecisionOwner
  state: OperatorDecisionState
  title: string
  summary: string
  safeNextAction: string
  authority: string
  actions: OperatorDecisionAction[]
  sessionId?: string
  taskId?: string
  roadmapId?: string
  expiresAt?: string
  reasonCode?: string
  evidenceRef: string
}

export type OperatorDecisionSurface =
  | 'opencode_web_tui'
  | 'trusted_channel'
  | 'cli_mcp'
  | 'mission_control'

export type OperatorDecisionSurfaceStatus = 'aligned' | 'recovery_required' | 'unavailable'

export interface OperatorDecisionSessionRecovery {
  status: 'available' | 'metadata_only' | 'unavailable' | 'unknown'
  reason?: string
  recoveryHint?: string
  tuiCommand?: string
  missionControlUrl?: string
  evidenceUrl?: string
}

export interface OperatorDecisionJourneyOptions {
  trustedChannelCount?: number
  sessionRecovery?: OperatorDecisionSessionRecovery
}

export interface OperatorDecisionSurfaceSummary {
  surface: OperatorDecisionSurface
  label: string
  status: OperatorDecisionSurfaceStatus
  decisionState: OperatorDecisionState
  owner: OperatorDecisionOwner
  summary: string
  safeNextAction: string
  evidenceRef: string
}

export interface OperatorDecisionJourney {
  decisionId: string
  source: OperatorDecisionSource
  owner: OperatorDecisionOwner
  state: OperatorDecisionState
  safeNextAction: string
  authority: string
  surfaceStates: OperatorDecisionSurfaceSummary[]
  receipts: Array<{ kind: string; status: 'required' | 'recorded_by_owner' | 'not_applicable'; summary: string }>
  releaseClaim: 'local_operator_decision_surface_sync_only'
}

export interface ChannelActionDenialInput {
  operation: string
  targetId?: string
  reason: string
  reasonCode: string
}

export function gatewayHumanGateDecision(gate: HumanGateRecord, now = Date.now()): OperatorDecisionSummary {
  const expired = isExpired(gate.expiresAt, now)
  const state: OperatorDecisionState = expired
    ? 'expired'
    : gate.status === 'approved'
      ? 'answered'
      : gate.status === 'rejected'
        ? 'denied'
        : gate.status === 'timed_out'
          ? 'expired'
          : ['pending', 'escalated'].includes(gate.status)
            ? 'requires_gateway'
            : 'blocked'
  const pending = state === 'requires_gateway'
  return {
    id: gate.id,
    source: 'gateway_human_gate',
    owner: 'gateway',
    state,
    title: `Gateway gate ${gate.id}`,
    summary: `${gate.status} ${gate.type}: ${gate.reason}`,
    safeNextAction: pending
      ? `Gateway owns this gate. Decide from a bound trusted channel with /gate approve ${gate.id} once or /gate reject ${gate.id} [note], or use gateway_human_gate_decide.`
      : terminalSafeNextAction(state, 'Gateway human gate'),
    authority: 'Gateway scheduler policy owns this gate; it does not answer OpenCode-native questions or permissions.',
    actions: [
      { id: 'approve_once', label: 'Approve once', command: `/gate approve ${gate.id} once`, owner: 'gateway', enabled: pending, style: 'primary', reason: pending ? undefined : `Decision state is ${state}` },
      { id: 'reject', label: 'Reject', command: `/gate reject ${gate.id}`, owner: 'gateway', enabled: pending, style: 'danger', reason: pending ? undefined : `Decision state is ${state}` },
    ],
    taskId: gate.taskId,
    roadmapId: gate.roadmapId,
    expiresAt: gate.expiresAt,
    reasonCode: gate.status,
    evidenceRef: `human_gate:${gate.id}`,
  }
}

export function completionProposalDecision(proposal: RoadmapCompletionProposalRecord, now = Date.now()): OperatorDecisionSummary {
  const expired = isExpired(proposal.expiresAt, now)
  const state: OperatorDecisionState = expired
    ? 'expired'
    : proposal.status === 'approved'
      ? 'answered'
      : proposal.status === 'rejected'
        ? 'denied'
        : proposal.status === 'pending'
          ? 'requires_gateway'
          : 'blocked'
  const pending = state === 'requires_gateway'
  return {
    id: proposal.id,
    source: 'gateway_completion_proposal',
    owner: 'gateway',
    state,
    title: `Completion proposal ${proposal.id}`,
    summary: `${proposal.recommendation}${proposal.unresolvedRisks.length ? `; ${proposal.unresolvedRisks.length} unresolved risk(s)` : ''}`,
    safeNextAction: pending
      ? `Gateway owns this completion proposal. Decide from a bound trusted channel with /completion approve ${proposal.id} or /completion reject ${proposal.id} [note], or use gateway_roadmap_completion_decide.`
      : terminalSafeNextAction(state, 'Completion proposal'),
    authority: 'Gateway owns project completion proposals and keeps them separate from OpenCode permission prompts.',
    actions: [
      { id: 'approve', label: 'Approve', command: `/completion approve ${proposal.id}`, owner: 'gateway', enabled: pending, style: 'primary', reason: pending ? undefined : `Decision state is ${state}` },
      { id: 'reject', label: 'Reject', command: `/completion reject ${proposal.id}`, owner: 'gateway', enabled: pending, style: 'danger', reason: pending ? undefined : `Decision state is ${state}` },
    ],
    roadmapId: proposal.roadmapId,
    sessionId: proposal.sessionId,
    expiresAt: proposal.expiresAt,
    reasonCode: proposal.status,
    evidenceRef: `completion_proposal:${proposal.id}`,
  }
}

export function openCodeQuestionDecision(row: PendingQuestionRequest): OperatorDecisionSummary {
  const id = String(row.id || 'unknown_question')
  return {
    id,
    source: 'opencode_question',
    owner: 'opencode',
    state: 'requires_open_code',
    title: `OpenCode question ${id}`,
    summary: summarizeQuestion(row),
    safeNextAction: `OpenCode owns this question. Answer in OpenCode, or from a trusted channel bound to Session ${row.sessionID} with /answer ${id} <label>; Gateway only forwards the answer to OpenCode.`,
    authority: 'OpenCode owns question state and answer validation; Gateway provides a routed operator surface only.',
    actions: openCodeQuestionActions(row),
    sessionId: row.sessionID,
    reasonCode: 'pending',
    evidenceRef: `opencode_question:${id}`,
  }
}

export function openCodePermissionDecision(row: PendingPermissionRequest): OperatorDecisionSummary {
  const id = String(row.id || 'unknown_permission')
  return {
    id,
    source: 'opencode_permission',
    owner: 'opencode',
    state: 'requires_open_code',
    title: `OpenCode permission ${id}`,
    summary: `${row.permission || 'permission'} in Session ${row.sessionID || 'unknown'}`,
    safeNextAction: `OpenCode owns this permission. Approve or deny in OpenCode, or from a trusted channel bound to Session ${row.sessionID} with /approve ${id} once, /approve ${id} always, or /deny ${id}; Gateway does not bypass OpenCode.`,
    authority: 'OpenCode owns permission enforcement; Gateway can only send an operator reply through OpenCode APIs.',
    actions: [
      { id: 'approve_once', label: 'Approve once', command: `/approve ${id} once`, owner: 'opencode', enabled: true, style: 'primary' },
      { id: 'approve_always', label: 'Approve always', command: `/approve ${id} always`, owner: 'opencode', enabled: true },
      { id: 'deny', label: 'Deny', command: `/deny ${id}`, owner: 'opencode', enabled: true, style: 'danger' },
    ],
    sessionId: row.sessionID,
    reasonCode: 'pending',
    evidenceRef: `opencode_permission:${id}`,
  }
}

export function channelActionDeniedDecision(input: ChannelActionDenialInput): OperatorDecisionSummary {
  const state = channelDenialState(input.reasonCode)
  return {
    id: input.targetId || input.operation,
    source: 'channel_action',
    owner: 'channel',
    state,
    title: `Channel action ${input.operation}`,
    summary: input.reason,
    safeNextAction: channelDenialNextAction(input.reasonCode),
    authority: 'Gateway channel security owns replay, freshness, actor, and binding checks before forwarding any decision.',
    actions: [],
    reasonCode: input.reasonCode,
    evidenceRef: `channel_action:${input.operation}:${input.reasonCode}`,
  }
}

export function decisionFacts(decision: OperatorDecisionSummary): Array<{ label: string; value: string }> {
  return [
    { label: 'Decision owner', value: decision.owner === 'opencode' ? 'OpenCode' : decision.owner === 'gateway' ? 'Gateway' : 'Gateway channel security' },
    { label: 'Decision state', value: decision.state },
    { label: 'Authority', value: decision.authority },
    { label: 'Next action', value: decision.safeNextAction },
  ]
}

export function buildOperatorDecisionJourney(decision: OperatorDecisionSummary, options: OperatorDecisionJourneyOptions = {}): OperatorDecisionJourney {
  const trustedChannelCount = Math.max(0, Number(options.trustedChannelCount || 0))
  const sessionRecovery: OperatorDecisionSessionRecovery = options.sessionRecovery || { status: decision.sessionId ? 'unknown' : 'unavailable' }
  const surfaceStates: OperatorDecisionSurfaceSummary[] = [
    webTuiSurface(decision, sessionRecovery),
    trustedChannelSurface(decision, trustedChannelCount),
    cliMcpSurface(decision),
    missionControlSurface(decision),
  ]
  return {
    decisionId: decision.id,
    source: decision.source,
    owner: decision.owner,
    state: decision.state,
    safeNextAction: decision.safeNextAction,
    authority: decision.authority,
    surfaceStates,
    receipts: decisionReceipts(decision),
    releaseClaim: 'local_operator_decision_surface_sync_only',
  }
}


function openCodeQuestionActions(row: PendingQuestionRequest): OperatorDecisionAction[] {
  const primary = row.questions?.[0]
  const actions = (primary?.options || []).slice(0, 8).map(option => ({
    id: `answer:${cleanCommandText(option.label, 48)}`,
    label: cleanCommandText(option.label, 48),
    command: `/answer ${row.id} ${cleanCommandText(option.label, 200)}`,
    owner: 'opencode' as const,
    enabled: true,
    style: 'primary' as const,
  })).filter(action => action.label && action.command)
  return [...actions, { id: 'reject', label: 'Reject', command: `/reject-question ${row.id}`, owner: 'opencode', enabled: true, style: 'danger' }]
}

function webTuiSurface(decision: OperatorDecisionSummary, recovery: OperatorDecisionSessionRecovery): OperatorDecisionSurfaceSummary {
  if (!decision.sessionId) {
    return surface(decision, 'opencode_web_tui', 'Web/TUI', 'unavailable', 'No OpenCode Session is associated with this decision.', 'Use Mission Control or the owning Gateway command to inspect this decision.')
  }
  if (recovery.status === 'unavailable') {
    const reason = cleanCommandText(recovery.reason || 'session link is unavailable', 180)
    const next = recovery.recoveryHint || `Run /open ${decision.sessionId}; use the TUI command or Mission Control evidence if Web reports the Session missing.`
    return surface(decision, 'opencode_web_tui', 'Web/TUI', 'recovery_required', `OpenCode Web/TUI needs recovery: ${reason}.`, next)
  }
  const next = recovery.recoveryHint || `Open the Session in OpenCode Web/TUI, or run /open ${decision.sessionId} for recovery links if Web reports it missing.`
  return surface(decision, 'opencode_web_tui', 'Web/TUI', 'aligned', `OpenCode Web/TUI should show decision state ${decision.state}.`, next)
}

function trustedChannelSurface(decision: OperatorDecisionSummary, trustedChannelCount: number): OperatorDecisionSurfaceSummary {
  const command = decision.actions.find(action => action.enabled && action.command)?.command
  if (decision.source === 'channel_action') {
    return surface(decision, 'trusted_channel', 'Trusted channel', 'recovery_required', 'The channel action was denied before reaching its owner.', decision.safeNextAction)
  }
  if (trustedChannelCount > 0 && command) {
    return surface(decision, 'trusted_channel', 'Trusted channel', 'aligned', `${trustedChannelCount} trusted bound channel target(s) can surface this decision.`, `Use the current channel action or typed fallback: ${command}; Gateway forwards the reply to ${decision.owner === 'opencode' ? 'OpenCode' : 'the owner'}.`)
  }
  if (command) {
    const bindHint = decision.sessionId ? `bind a trusted channel to Session ${decision.sessionId}` : 'bind a trusted channel to the owning Session, Issue, or Project'
    return surface(decision, 'trusted_channel', 'Trusted channel', 'unavailable', 'No trusted bound channel target is known for this decision.', `Use OpenCode Web/TUI or ${bindHint} before using typed fallback ${command}.`)
  }
  return surface(decision, 'trusted_channel', 'Trusted channel', 'unavailable', 'This decision has no channel action for the current state.', decision.safeNextAction)
}

function cliMcpSurface(decision: OperatorDecisionSummary): OperatorDecisionSurfaceSummary {
  return surface(decision, 'cli_mcp', 'CLI/MCP', 'aligned', `CLI/MCP status should report ${decision.source} as ${decision.state}.`, 'Run /attention from a trusted channel, inspect Gateway status, or call the Gateway MCP attention/status tools before retrying.')
}

function missionControlSurface(decision: OperatorDecisionSummary): OperatorDecisionSurfaceSummary {
  return surface(decision, 'mission_control', 'Mission Control', 'aligned', `Mission Control Needs Attention should show owner ${decision.owner} and state ${decision.state}.`, 'Open Mission Control Needs Attention and follow the same safe next action shown here.')
}

function surface(decision: OperatorDecisionSummary, surfaceName: OperatorDecisionSurface, label: string, status: OperatorDecisionSurfaceStatus, summary: string, safeNextAction: string): OperatorDecisionSurfaceSummary {
  return {
    surface: surfaceName,
    label,
    status,
    decisionState: decision.state,
    owner: decision.owner,
    summary,
    safeNextAction,
    evidenceRef: `${decision.evidenceRef}:${surfaceName}:${status}`,
  }
}

function decisionReceipts(decision: OperatorDecisionSummary): OperatorDecisionJourney['receipts'] {
  if (decision.source === 'channel_action') {
    return [{ kind: 'channel_denial_audit', status: 'recorded_by_owner', summary: 'Gateway channel security records denial receipts before forwarding actions.' }]
  }
  if (decision.owner === 'opencode') {
    return [
      { kind: 'opencode_reply', status: 'required', summary: 'OpenCode owns the final answer/permission receipt.' },
      { kind: 'gateway_notification', status: 'recorded_by_owner', summary: 'Gateway records redacted notification/delivery receipts only.' },
    ]
  }
  return [{ kind: 'gateway_decision', status: 'required', summary: 'Gateway owns and records the final gate/proposal decision receipt.' }]
}

function channelDenialState(reasonCode: string): OperatorDecisionState {
  if (reasonCode === 'stale' || reasonCode === 'replayed') return 'stale'
  if (reasonCode === 'expired') return 'expired'
  if (reasonCode.startsWith('status:')) return 'answered'
  if (reasonCode === 'not_pending' || reasonCode === 'not_found') return 'blocked'
  return 'denied'
}

function channelDenialNextAction(reasonCode: string): string {
  if (reasonCode === 'stale' || reasonCode === 'replayed') return 'Refresh the current attention item and use the newest action or typed fallback.'
  if (reasonCode === 'expired') return 'Refresh status; the original decision expired and must be recreated or handled by its owner.'
  if (reasonCode === 'wrong_channel') return 'Switch or bind the trusted channel to the owning Session, Issue, or Project before deciding.'
  if (reasonCode === 'not_pending' || reasonCode === 'not_found') return 'Refresh Needs Attention; the original request is no longer available.'
  if (reasonCode.startsWith('status:')) return 'Refresh Needs Attention; this decision already reached a terminal state.'
  return 'Use a trusted channel, correct actor, and current action token before retrying.'
}

function terminalSafeNextAction(state: OperatorDecisionState, label: string): string {
  if (state === 'expired') return `${label} expired. Refresh Needs Attention and recreate or recover the owning workflow before deciding.`
  if (state === 'answered') return `${label} already has a terminal answer. Refresh Needs Attention for current work.`
  if (state === 'denied') return `${label} was denied. Inspect the owning workflow before retrying.`
  return `${label} is blocked. Inspect owner state and support diagnosis before retrying.`
}

function summarizeQuestion(row: PendingQuestionRequest): string {
  const first = Array.isArray(row.questions) ? row.questions[0] : undefined
  return String(first?.question || first?.header || `Session ${row.sessionID || 'unknown'} needs an answer`)
}

function isExpired(iso: string | undefined, now: number): boolean {
  const expires = Date.parse(iso || '')
  return Number.isFinite(expires) && expires <= now
}

function cleanCommandText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return maxLength > 0 && text.length > maxLength ? text.substring(0, maxLength).trimEnd() : text
}
