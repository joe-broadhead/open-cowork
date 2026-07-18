import type { GatewayConfig } from './config.js'
import { getConfig } from './config.js'
import { listChannelSessions } from './channel-sessions.js'
import {
  ensureHumanGate,
  listHumanGates,
  loadWorkState,
  timeoutHumanGate,
  type HumanGateInput,
  type HumanGateRecord,
  type RoadmapCompletionProposalRecord,
  type RunRecord,
  type WorkState,
  type WorkTaskRecord,
  type WorkTaskView,
} from './work-store.js'
import { taskHasAnyRun } from './work-store/queries.js'
import {
  buildOperatorDecisionJourney,
  completionProposalDecision,
  gatewayHumanGateDecision,
  openCodePermissionDecision,
  openCodeQuestionDecision,
  type OperatorDecisionJourney,
  type OperatorDecisionOwner,
  type OperatorDecisionState,
  type OperatorDecisionSurfaceSummary,
  type OperatorDecisionSummary,
} from './operator-decisions.js'

export type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low'
export type AttentionKind = 'gateway_gate' | 'opencode_question' | 'opencode_permission' | 'completion_proposal' | 'task' | 'stale_run'

export interface NeedsAttentionItem {
  id: string
  kind: AttentionKind
  severity: AttentionSeverity
  title: string
  summary: string
  action: string
  owner?: OperatorDecisionOwner
  decisionState?: OperatorDecisionState
  decision?: OperatorDecisionSummary
  decisionJourney?: OperatorDecisionJourney
  surfaceStates?: OperatorDecisionSurfaceSummary[]
  taskId?: string
  roadmapId?: string
  runId?: string
  gateId?: string
  sessionId?: string
  createdAt?: string
  ageMs?: number
  channels?: number
}

export interface NeedsAttentionReport {
  generatedAt: string
  summary: string
  counts: Record<AttentionKind, number>
  items: NeedsAttentionItem[]
  projects: ProjectAttentionGroup[]
}

export interface ProjectAttentionGroup {
  roadmapId?: string
  roadmapTitle: string
  supervisorId?: string
  sessionId?: string
  severity: AttentionSeverity
  items: NeedsAttentionItem[]
  channels: number
}

export function ensureHumanGateForTaskStage(task: WorkTaskRecord, stage: string, _state: WorkState = loadWorkState(), config: GatewayConfig = getConfig()): HumanGateRecord | undefined {
  if (!config.humanLoop.enabled) return undefined
  // Intentionally ignore the passed-in (possibly windowed) state for the
  // "has this task ever started" decision; gateInputForTaskStage consults the
  // durable store so aged-out runs don't trigger a spurious task_start gate.
  const input = gateInputForTaskStage(task, stage, config)
  return input ? ensureHumanGate(input) : undefined
}

export function applyHumanGateTimeouts(config: GatewayConfig = getConfig(), now = Date.now()): { processed: number; gates: HumanGateRecord[] } {
  if (!config.humanLoop.enabled) return { processed: 0, gates: [] }
  const gates: HumanGateRecord[] = []
  for (const gate of listHumanGates({ status: 'open' })) {
    const expires = Date.parse(gate.expiresAt || '')
    if (!Number.isFinite(expires) || expires > now) continue
    const result = timeoutHumanGate(gate.id, gate.timeoutAction || config.humanLoop.timeoutAction, undefined, now)
    if (result?.gate) gates.push(result.gate)
  }
  return { processed: gates.length, gates }
}

export function buildNeedsAttentionReport(input: { state?: WorkState; gates?: HumanGateRecord[]; questions?: any[]; permissions?: any[]; config?: GatewayConfig; now?: number; readOnly?: boolean } = {}): NeedsAttentionReport {
  const config = input.config || getConfig()
  const now = input.now || Date.now()
  const state = input.state || loadWorkState()
  const gates = input.gates || listHumanGates({ status: 'open' })
  const questions = input.questions || []
  const permissions = input.permissions || []
  const items: NeedsAttentionItem[] = []

  const virtualGates: HumanGateRecord[] = []
  for (const task of state.tasks) {
    if (!task.manualGate) continue
    const existing = gates.find(row => row.taskId === task.id && row.details?.['manualGate'] === task.manualGate)
    if (existing) continue
    const stage = task.currentStage || task.pipeline[0] || 'implement'
    if (input.readOnly) {
      // Read-only triage still SURFACES a not-yet-materialized manual gate as a
      // synthesized (virtual) attention item so triage stays a complete attention
      // read — but it never INSERTS the gate (no work-store write). Gated on
      // humanLoop.enabled to mirror the materializing path, which no-ops when the
      // human loop is off.
      if (!config.humanLoop.enabled) continue
      const gateInput = gateInputForTaskStage(task, stage, config)
      if (gateInput) virtualGates.push(virtualGateRecordFromInput(gateInput, config, now))
    } else {
      const created = ensureHumanGateForTaskStage(task, stage, state, config)
      if (created) gates.push(created)
    }
  }

  for (const gate of gates) items.push(gateAttentionItem(gate, state, now))
  for (const gate of virtualGates) items.push(gateAttentionItem(gate, state, now))
  for (const question of questions) items.push(openCodeRequestItem('opencode_question', question, state, now))
  for (const permission of permissions) items.push(openCodeRequestItem('opencode_permission', permission, state, now))
  for (const proposal of state.completionProposals.filter(proposal => proposal.status === 'pending')) items.push(completionProposalAttentionItem(proposal, state, now))

  const gateTaskIds = new Set([...gates, ...virtualGates].map(gate => gate.taskId).filter(Boolean) as string[])
  for (const task of state.tasks) {
    if (!['blocked', 'paused'].includes(task.status)) continue
    if (gateTaskIds.has(task.id)) continue
    items.push(taskAttentionItem(task, now))
  }

  const staleRunMs = Number(config.governance?.runtime?.staleRunMs || config.humanLoop.defaultTimeoutMs)
  if (staleRunMs > 0) {
    for (const run of state.runs.filter(run => run.status === 'running')) {
      const ageMs = now - Date.parse(run.startedAt)
      if (Number.isFinite(ageMs) && ageMs > staleRunMs) items.push(staleRunAttentionItem(run, state, ageMs))
    }
  }

  items.sort(compareAttentionItems)
  const counts = { gateway_gate: 0, opencode_question: 0, opencode_permission: 0, completion_proposal: 0, task: 0, stale_run: 0 }
  for (const item of items) counts[item.kind]++
  return {
    generatedAt: new Date(now).toISOString(),
    summary: items.length ? `${items.length} item(s) need attention` : 'No human attention required',
    counts,
    items,
    projects: groupAttentionByProject(items, state),
  }
}

export function formatNeedsAttentionReport(report: NeedsAttentionReport): string {
  const lines = [`Needs Attention: ${report.summary}`]
  if (!report.items.length) return lines.join('\n')
  for (const item of report.items.slice(0, 12)) {
    lines.push(`- [${item.severity}] ${item.title}: ${item.summary}`)
    if (item.owner && item.decisionState) lines.push(`  Owner: ${item.owner}; State: ${item.decisionState}`)
    if (item.surfaceStates?.length) lines.push(`  Surfaces: ${formatDecisionSurfaces(item.surfaceStates)}`)
    lines.push(`  Action: ${item.decision?.safeNextAction || item.action}`)
  }
  return lines.join('\n')
}

export function formatHumanGate(gate: HumanGateRecord): string {
  const decision = gatewayHumanGateDecision(gate)
  return [
    `Gate ${gate.id}: ${gate.status}`,
    `Type: ${gate.type}${gate.stage ? ` stage=${gate.stage}` : ''}`,
    gate.taskId ? `Issue: ${gate.taskId}` : '',
    gate.roadmapId ? `Project record: ${gate.roadmapId}` : '',
    `Reason: ${gate.reason}`,
    `Decision owner: Gateway`,
    `Decision state: ${decision.state}`,
    gate.expiresAt ? `Timeout: ${gate.expiresAt} -> ${gate.timeoutAction}` : '',
    `Action: ${decision.safeNextAction}`,
  ].filter(Boolean).join('\n')
}

function gateInputForTaskStage(task: WorkTaskRecord, stage: string, config: GatewayConfig): HumanGateInput | undefined {
  if (task.manualGate) {
    return {
      type: task.manualGate === 'credentials_required' ? 'credential_use' : task.manualGate === 'external_dependency' ? 'external_side_effect' : task.manualGate === 'approval_required' ? 'task_start' : 'manual',
      taskId: task.id,
      roadmapId: task.roadmapId,
      stage,
      reason: manualGateReason(task.manualGate),
      requestedBy: 'gateway.manual_gate',
      expiresAt: expiresAtForTask(task, config),
      timeoutAction: config.humanLoop.timeoutAction,
      scopeKey: `manual:${task.id}:${task.manualGate}`,
      details: { manualGate: task.manualGate },
    }
  }
  const isFirstStage = stage === (task.pipeline[0] || stage)
  // "Has this task ever run" must come from the durable store, not the caller's
  // (possibly windowed) state.runs: a task whose only runs have aged out of the
  // live window would otherwise look un-started and raise a spurious task_start
  // gate that blocks dispatch. taskHasAnyRun is an index EXISTS probe, and this
  // branch is only reached when task_start approval is actually enabled.
  if (config.humanLoop.taskStartApproval && isFirstStage && !taskHasAnyRun(task.id)) {
    return gateInput(task, stage, 'task_start', 'Task start requires operator approval', config)
  }
  if (config.humanLoop.stageApprovals.includes(stage)) {
    return gateInput(task, stage, 'stage_transition', `Stage transition to ${stage} requires operator approval`, config)
  }
  return undefined
}

/**
 * Synthesize a read-only, in-memory HumanGateRecord from the gate input that
 * WOULD be materialized for a task/stage. Used only to surface a pending manual
 * gate in read-only triage; it is never persisted (marked `details.virtual`).
 */
function virtualGateRecordFromInput(input: HumanGateInput, config: GatewayConfig, now: number): HumanGateRecord {
  const iso = new Date(now).toISOString()
  return {
    id: `virtual:${input.scopeKey || `${input.type}:${input.taskId || ''}`}`,
    type: input.type,
    status: 'pending',
    roadmapId: input.roadmapId,
    taskId: input.taskId,
    runId: input.runId,
    stage: input.stage,
    reason: input.reason,
    requestedBy: input.requestedBy || 'gateway.manual_gate',
    requestedAt: iso,
    updatedAt: iso,
    expiresAt: input.expiresAt,
    timeoutAction: input.timeoutAction || config.humanLoop.timeoutAction,
    scopeKey: input.scopeKey,
    details: { ...(input.details || {}), virtual: true },
  }
}

function gateInput(task: WorkTaskRecord, stage: string, type: HumanGateInput['type'], reason: string, config: GatewayConfig): HumanGateInput {
  return {
    type,
    taskId: task.id,
    roadmapId: task.roadmapId,
    stage,
    reason,
    requestedBy: 'gateway.policy',
    expiresAt: expiresAtForTask(task, config),
    timeoutAction: config.humanLoop.timeoutAction,
    scopeKey: `${type}:task:${task.id}:${stage}`,
    details: { priority: task.priority },
  }
}

function expiresAtForTask(task: WorkTaskRecord, config: GatewayConfig): string {
  const timeout = config.humanLoop.priorityTimeoutMs[task.priority] || config.humanLoop.defaultTimeoutMs
  return new Date(Date.now() + timeout).toISOString()
}

function gateAttentionItem(gate: HumanGateRecord, state: WorkState, now: number): NeedsAttentionItem {
  const task = gate.taskId ? state.tasks.find(row => row.id === gate.taskId) : undefined
  const ageMs = now - Date.parse(gate.requestedAt)
  const decision = gatewayHumanGateDecision(gate, now)
  const channels = channelCount(gate.taskId, gate.roadmapId)
  const decisionJourney = buildOperatorDecisionJourney(decision, { trustedChannelCount: channels })
  return {
    id: gate.id,
    kind: 'gateway_gate',
    severity: gateSeverity(gate, task, now),
    title: `Gateway gate ${gate.id}`,
    summary: `${gate.status} ${gate.type}${task ? ` for ${task.title}` : ''}: ${gate.reason}`,
    action: decision.safeNextAction,
    owner: decision.owner,
    decisionState: decision.state,
    decision,
    decisionJourney,
    surfaceStates: decisionJourney.surfaceStates,
    taskId: gate.taskId,
    roadmapId: gate.roadmapId,
    runId: gate.runId,
    gateId: gate.id,
    createdAt: gate.requestedAt,
    ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
    channels,
  }
}

function taskAttentionItem(task: WorkTaskView | WorkTaskRecord, now: number): NeedsAttentionItem {
  const ageMs = now - Date.parse(task.updatedAt || task.createdAt)
  return {
    id: task.id,
    kind: 'task',
    severity: taskSeverity(task, now),
    title: `Task ${task.title}`,
    summary: `${task.status}${task.note ? `: ${task.note}` : ''}`,
    action: `gateway_task_resume/retry/cancel taskId=${task.id} OR /task retry ${task.id}`,
    taskId: task.id,
    roadmapId: task.roadmapId,
    createdAt: task.updatedAt,
    ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
    channels: channelCount(task.id, task.roadmapId),
  }
}

function completionProposalAttentionItem(proposal: RoadmapCompletionProposalRecord, state: WorkState, now: number): NeedsAttentionItem {
  const roadmap = state.roadmaps.find(row => row.id === proposal.roadmapId)
  const ageMs = now - Date.parse(proposal.createdAt)
  const decision = completionProposalDecision(proposal, now)
  const channels = channelCount(undefined, proposal.roadmapId)
  const decisionJourney = buildOperatorDecisionJourney(decision, { trustedChannelCount: channels })
  return {
    id: proposal.id,
    kind: 'completion_proposal',
    severity: proposal.unresolvedRisks.length ? 'high' : 'medium',
    title: `Completion proposal for ${roadmap?.title || proposal.roadmapId}`,
    summary: `${proposal.recommendation}${proposal.unresolvedRisks.length ? `; ${proposal.unresolvedRisks.length} unresolved risk(s)` : ''}`,
    action: decision.safeNextAction,
    owner: decision.owner,
    decisionState: decision.state,
    decision,
    decisionJourney,
    surfaceStates: decisionJourney.surfaceStates,
    roadmapId: proposal.roadmapId,
    sessionId: proposal.sessionId,
    createdAt: proposal.createdAt,
    ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
    channels,
  }
}

function staleRunAttentionItem(run: RunRecord, state: WorkState, ageMs: number): NeedsAttentionItem {
  const task = state.tasks.find(row => row.id === run.taskId)
  return {
    id: run.id,
    kind: 'stale_run',
    severity: 'high',
    title: `Stale run ${run.id}`,
    summary: `${run.stage} has been running for ${formatDuration(ageMs)}${task ? ` on ${task.title}` : ''}`,
    action: `Inspect session ${run.sessionId}, then gateway_task_retry or gateway_task_block taskId=${run.taskId}`,
    taskId: run.taskId,
    runId: run.id,
    sessionId: run.sessionId,
    createdAt: run.startedAt,
    ageMs,
  }
}

function openCodeRequestItem(kind: 'opencode_question' | 'opencode_permission', row: any, state: WorkState, now: number): NeedsAttentionItem {
  const id = String(row.id || row.requestId || row.sessionID || kind)
  const createdAt = row.createdAt || row.time?.created ? new Date(row.createdAt || row.time.created).toISOString() : undefined
  const ageMs = createdAt ? now - Date.parse(createdAt) : undefined
  const roadmapId = roadmapIdForSession(String(row.sessionID || ''), state)
  const decision = kind === 'opencode_question' ? openCodeQuestionDecision(row) : openCodePermissionDecision(row)
  const channels = channelCount(undefined, roadmapId, row.sessionID)
  const decisionJourney = buildOperatorDecisionJourney(decision, { trustedChannelCount: channels })
  return {
    id,
    kind,
    severity: 'high',
    title: kind === 'opencode_question' ? `OpenCode question ${id}` : `OpenCode permission ${id}`,
    summary: kind === 'opencode_question' ? summarizeQuestion(row) : summarizePermission(row),
    action: decision.safeNextAction,
    owner: decision.owner,
    decisionState: decision.state,
    decision: { ...decision, roadmapId },
    decisionJourney,
    surfaceStates: decisionJourney.surfaceStates,
    sessionId: row.sessionID,
    roadmapId,
    createdAt,
    ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
    channels,
  }
}

function groupAttentionByProject(items: NeedsAttentionItem[], state: WorkState): ProjectAttentionGroup[] {
  const groups = new Map<string, NeedsAttentionItem[]>()
  for (const item of items) {
    const roadmapId = item.roadmapId || (item.taskId ? state.tasks.find(task => task.id === item.taskId)?.roadmapId : undefined) || roadmapIdForSession(item.sessionId || '', state)
    const key = roadmapId || 'unscoped'
    const rows = groups.get(key) || []
    rows.push({ ...item, roadmapId })
    groups.set(key, rows)
  }
  return [...groups.entries()].map(([key, rows]) => {
    const roadmap = state.roadmaps.find(row => row.id === key)
    const supervisor = roadmap ? state.supervisors.filter(row => row.roadmapId === roadmap.id && row.status === 'active').sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt))[0] : undefined
    return {
      roadmapId: roadmap?.id,
      roadmapTitle: roadmap?.title || 'Unscoped attention',
      supervisorId: supervisor?.supervisorId,
      sessionId: supervisor?.sessionId || rows.find(row => row.sessionId)?.sessionId,
      severity: rows.map(row => row.severity).sort((a, b) => severityRank(a) - severityRank(b))[0] || 'low',
      items: rows.sort(compareAttentionItems),
      channels: channelCount(undefined, roadmap?.id, rows.find(row => row.sessionId)?.sessionId),
    }
  }).sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.roadmapTitle.localeCompare(b.roadmapTitle))
}

function roadmapIdForSession(sessionId: string, state: WorkState): string | undefined {
  if (!sessionId) return undefined
  const run = state.runs.find(row => row.sessionId === sessionId)
  const task = run ? state.tasks.find(row => row.id === run.taskId) : undefined
  if (task) return task.roadmapId
  const supervisor = state.supervisors.find(row => row.sessionId === sessionId)
  if (supervisor) return supervisor.roadmapId
  const binding = state.projectBindings.find(row => row.sessionId === sessionId)
  return binding?.roadmapId
}

function gateSeverity(gate: HumanGateRecord, task: WorkTaskRecord | undefined, now: number): AttentionSeverity {
  if (gate.status === 'escalated') return 'critical'
  if (gate.expiresAt && Date.parse(gate.expiresAt) <= now) return 'high'
  return task ? taskSeverity(task, now) : 'medium'
}

function taskSeverity(task: WorkTaskRecord | WorkTaskView, now: number): AttentionSeverity {
  const deadline = Date.parse(task.deadlineAt || '')
  if (Number.isFinite(deadline) && deadline <= now) return 'critical'
  if (task.priority === 'HIGH') return 'high'
  if (task.priority === 'MEDIUM') return 'medium'
  return 'low'
}

function compareAttentionItems(a: NeedsAttentionItem, b: NeedsAttentionItem): number {
  const severity = severityRank(a.severity) - severityRank(b.severity)
  if (severity !== 0) return severity
  return (b.ageMs || 0) - (a.ageMs || 0)
}

function severityRank(value: AttentionSeverity): number {
  return value === 'critical' ? 0 : value === 'high' ? 1 : value === 'medium' ? 2 : 3
}

function channelCount(taskId?: string, roadmapId?: string, sessionId?: string): number {
  try {
    return listChannelSessions().filter(link =>
      (taskId && link.taskId === taskId) ||
      (roadmapId && link.roadmapId === roadmapId) ||
      (sessionId && link.sessionId === sessionId),
    ).length
  } catch {
    return 0
  }
}

function manualGateReason(gate: string): string {
  if (gate === 'approval_required') return 'Waiting for operator approval'
  if (gate === 'credentials_required') return 'Waiting for credentials'
  if (gate === 'external_dependency') return 'Waiting for an external dependency'
  return 'Waiting for user input'
}

function summarizeQuestion(row: any): string {
  const first = Array.isArray(row.questions) ? row.questions[0] : undefined
  return first?.question || first?.header || `Session ${row.sessionID || 'unknown'} needs an answer`
}

function summarizePermission(row: any): string {
  const patterns = Array.isArray(row.patterns) && row.patterns.length ? ` (${row.patterns.join(', ')})` : ''
  return `${row.permission || 'permission'}${patterns} in session ${row.sessionID || 'unknown'}`
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

function formatDecisionSurfaces(rows: OperatorDecisionSurfaceSummary[]): string {
  return rows.map(row => `${row.label}=${row.status}`).join(', ')
}
