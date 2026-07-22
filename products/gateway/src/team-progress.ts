import { createHash } from 'node:crypto'
import type { ChannelAdapter } from './channels/provider.js'
import { progressCard, renderStructuredMessage, type MessageAction, type MessageFact, type StructuredGatewayMessage } from './channels/renderer.js'
import { decideProgressUpdateDelivery, defaultProgressUpdatePolicy, progressUpdatePolicyFromBinding, type ProgressUpdatePolicy } from './progress-update-policy.js'
import { redactSensitiveText } from './security.js'
import { getTeamTaskAssignment, listTeamTaskAssignments, type AssignmentReceiptRecord, type TeamTaskAssignment } from './team-assignment.js'
import { queueEvent } from './wakeup.js'
import {
  appendWorkEvent,
  listAllWorkEventsByType,
  listWorkEventsByType,
  listRecentWorkEvents,
  loadWorkState,
  updateProjectBinding,
  upsertAlert,
  type ProjectBindingRecord,
  type ProjectNotificationMode,
  type WorkEventRecord,
  type WorkState,
} from './work-store.js'

export type TeamProgressKind = 'started' | 'gate_waiting' | 'blocked' | 'resumed' | 'completed' | 'failed' | 'scheduled_digest'
export type TeamProgressDelivery = 'immediate' | 'digest' | 'deferred' | 'muted' | 'deduped' | 'session'
export type TeamProgressAttention = 'monitor' | 'needs_attention' | 'critical'

export interface TeamProgressTarget {
  key: string
  sessionId?: string
  provider?: string
  chatId?: string
  threadId?: string
  bindingId?: string
  alias?: string
  mode: ProjectNotificationMode
  mutedUntil?: string
  quietHours: Record<string, unknown>
  lastDigestAt?: string
  policy: ProgressUpdatePolicy
}

export interface TeamProgressRoute {
  event: WorkEventRecord
  assignment: TeamTaskAssignment & { receipts?: AssignmentReceiptRecord[] }
  receipt?: AssignmentReceiptRecord
  progress: TeamProgressKind
  attention: TeamProgressAttention
  target: TeamProgressTarget
  delivery: TeamProgressDelivery
  reason: string
  dedupeKey: string
  text: string
  deferredUntil?: string
  suppressedUntil?: string
  escalationBypass?: 'digest' | 'quiet_hours'
}

export interface TeamProgressRoutingOptions {
  now?: number
  dedupeWindowMs?: number
  failureRetryMs?: number
  digestIntervalMs?: number
  filePath?: string
  sessionClient?: TeamProgressSessionClient
  sessionPromptTimeoutMs?: number
  channelDeliveryTimeoutMs?: number
}

export interface TeamProgressSessionClient {
  session?: {
    prompt(args: { path: { id: string }; body: { agent?: string; parts: Array<{ type: 'text'; text: string }> } }): Promise<unknown>
  }
}

export interface TeamProgressDeliveryResult {
  routes: TeamProgressRoute[]
  sent: TeamProgressRoute[]
  failed: Array<{ route: TeamProgressRoute; error: string }>
  suppressed: TeamProgressRoute[]
}

const DEFAULT_DEDUPE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_FAILURE_RETRY_MS = 15 * 60 * 1000
const DEFAULT_DIGEST_MS = 24 * 60 * 60 * 1000
const DEFAULT_SESSION_PROMPT_TIMEOUT_MS = 15_000
const DEFAULT_CHANNEL_DELIVERY_TIMEOUT_MS = 15_000
const CRITICAL_PROGRESS = new Set<TeamProgressKind>(['gate_waiting', 'blocked', 'failed'])

export function buildTeamProgressRoutes(state: WorkState = loadWorkState(), options: TeamProgressRoutingOptions = {}): TeamProgressRoute[] {
  const now = options.now || Date.now()
  const dedupeWindowMs = Math.max(1000, options.dedupeWindowMs || DEFAULT_DEDUPE_MS)
  const failureRetryMs = Math.max(1000, options.failureRetryMs || DEFAULT_FAILURE_RETRY_MS)
  const failedTargetCooldowns = recentFailedTargetKeys(failureRetryMs, now, options.filePath)
  const digestIntervalMs = Math.max(60_000, options.digestIntervalMs || DEFAULT_DIGEST_MS)
  const routes: TeamProgressRoute[] = []
  const assignmentById = new Map(listTeamTaskAssignments({ limit: 1000 }, options.filePath).map(assignment => [assignment.id, assignment]))

  for (const event of listTeamProgressSourceEvents(options.filePath)) {
    for (const item of teamProgressItemsForEvent(event, assignmentById, options.filePath)) {
      for (const target of teamProgressTargets(item.assignment, state)) {
        routes.push(routeFor({ event, assignment: item.assignment, receipt: item.receipt, progress: item.progress, target, now, dedupeWindowMs, failureRetryMs, failedTargetCooldowns, digestIntervalMs, filePath: options.filePath }))
      }
    }
  }

  for (const route of scheduledDigestRoutes({ state, assignments: [...assignmentById.values()], now, dedupeWindowMs, failureRetryMs, failedTargetCooldowns, digestIntervalMs, filePath: options.filePath })) routes.push(route)
  return routes.sort((a, b) => a.event.id - b.event.id || a.assignment.id.localeCompare(b.assignment.id) || a.target.key.localeCompare(b.target.key))
}

export async function deliverTeamProgressBriefings(channels: Map<string, Pick<ChannelAdapter, 'sendMessage' | 'sendStructuredMessage'>>, input: { state?: WorkState } = {}, options: TeamProgressRoutingOptions = {}): Promise<TeamProgressDeliveryResult> {
  const state = input.state || loadWorkState(options.filePath)
  const routes = buildTeamProgressRoutes(state, options)
  const sent: TeamProgressRoute[] = []
  const failed: Array<{ route: TeamProgressRoute; error: string }> = []
  const suppressed: TeamProgressRoute[] = []
  const failedTargets = new Set<string>()

  for (const route of routes) {
    const routeTargetKey = targetHash(route.target)
    if (failedTargets.has(routeTargetKey)) {
      suppressed.push({ ...route, delivery: 'deduped', reason: 'recent failed target cooldown' })
      continue
    }
    if (route.delivery === 'session') {
      if (!route.target.sessionId) {
        const suppressedRoute = { ...route, delivery: 'deferred' as const, reason: 'missing parent session id' }
        suppressed.push(suppressedRoute)
        appendWorkEvent('team_assignment.briefing.suppressed', route.dedupeKey, eventPayload(suppressedRoute), options.filePath)
        continue
      }
      if (!options.sessionClient?.session?.prompt) {
        const suppressedRoute = { ...route, delivery: 'deferred' as const, reason: 'session client unavailable' }
        suppressed.push(suppressedRoute)
        appendWorkEvent('team_assignment.briefing.suppressed', route.dedupeKey, eventPayload(suppressedRoute), options.filePath)
        continue
      }
      try {
        const { createOpenCodeSessionRuntime } = await import('./opencode-session-runtime.js')
        await withTimeout(createOpenCodeSessionRuntime(options.sessionClient as any).prompt({
          sessionId: route.target.sessionId,
          agent: 'gateway-assistant',
          parts: [{ type: 'text', text: sessionTeamProgressPrompt(route) }],
          async: false,
        }), Math.max(1, options.sessionPromptTimeoutMs || DEFAULT_SESSION_PROMPT_TIMEOUT_MS), 'team progress parent session prompt')
        appendWorkEvent('team_assignment.briefing.notified', route.dedupeKey, eventPayload(route), options.filePath)
        sent.push(route)
      } catch (err: any) {
        const error = redactSensitiveText(err?.message || String(err))
        failed.push({ route, error })
        failedTargets.add(routeTargetKey)
        appendWorkEvent('team_assignment.briefing.failed', route.dedupeKey, { ...eventPayload(route), error }, options.filePath)
        queueEvent(`Team progress session briefing failed for ${route.target.sessionId}: ${error}`)
      }
      continue
    }

    if (route.delivery !== 'immediate' && route.delivery !== 'digest') {
      suppressed.push(route)
      if (route.delivery !== 'deduped') appendWorkEvent('team_assignment.briefing.suppressed', route.dedupeKey, eventPayload(route), options.filePath)
      continue
    }
    if (!route.target.provider || !route.target.chatId) {
      suppressed.push({ ...route, delivery: 'session', reason: 'OpenCode session target only' })
      continue
    }
    const channel = channels.get(route.target.provider)
    if (!channel?.sendMessage && !channel?.sendStructuredMessage) {
      suppressed.push({ ...route, delivery: 'deferred', reason: 'channel adapter unavailable' })
      continue
    }
    try {
      const message = structuredTeamProgressMessage(route)
      const delivery = channel.sendStructuredMessage
        ? channel.sendStructuredMessage(route.target.chatId, message, { threadId: route.target.threadId })
        : channel.sendMessage(route.target.chatId, route.text.substring(0, 4000), { threadId: route.target.threadId })
      await withTimeout(delivery, Math.max(1, options.channelDeliveryTimeoutMs || DEFAULT_CHANNEL_DELIVERY_TIMEOUT_MS), `${route.target.provider} team progress briefing`)
      sent.push(route)
      appendWorkEvent('team_assignment.briefing.notified', route.dedupeKey, eventPayload(route), options.filePath)
      if (route.delivery === 'digest' && route.target.bindingId) updateProjectBinding(route.target.bindingId, { lastDigestAt: new Date(options.now || Date.now()).toISOString() }, options.filePath)
    } catch (err: any) {
      const error = redactSensitiveText(err?.message || String(err))
      failed.push({ route, error })
      failedTargets.add(routeTargetKey)
      appendWorkEvent('team_assignment.briefing.failed', route.dedupeKey, { ...eventPayload(route), error }, options.filePath)
      upsertAlert({ key: `team-progress:${route.target.provider}:${targetHash(route.target)}`, severity: 'warning', source: 'team.progress', target: route.assignment.roadmapId || route.assignment.taskId || route.assignment.id, summary: 'Team progress briefing delivery failed', evidence: [route.target.provider || 'unknown', error], nextAction: 'Check channel credentials, allowlists, and team progress notification bindings.' }, {}, options.filePath)
      queueEvent(`Team progress briefing failed for ${route.assignment.id} via ${route.target.provider}: ${error}`)
    }
  }

  return { routes, sent, failed, suppressed }
}

export function formatTeamProgressBriefing(route: Pick<TeamProgressRoute, 'event' | 'assignment' | 'receipt' | 'progress' | 'attention'>): string {
  return renderStructuredMessage(teamProgressMessage(route), { plainText: true }).plainText.substring(0, 4000)
}

export function teamProgressMessage(route: Pick<TeamProgressRoute, 'event' | 'assignment' | 'receipt' | 'progress' | 'attention'>): StructuredGatewayMessage {
  const assignment = route.assignment
  const receipt = route.receipt
  const title = teamProgressTitle(route.progress)
  const facts = teamFacts(assignment, receipt, route.attention)
  const nextAction = teamNextAction(route.progress, assignment, receipt)
  const actions = teamActions(route.progress, assignment, receipt)
  return progressCard({
    title,
    status: route.progress,
    summary: teamSummary(route.progress, assignment, receipt),
    currentStep: teamCurrentStep(route.progress, assignment, receipt),
    facts,
    nextAction,
    actions,
  })
}

function routeFor(input: { event: WorkEventRecord; assignment: TeamProgressRoute['assignment']; receipt?: AssignmentReceiptRecord; progress: TeamProgressKind; target: TeamProgressTarget; now: number; dedupeWindowMs: number; failureRetryMs: number; failedTargetCooldowns: Set<string>; digestIntervalMs: number; filePath?: string }): TeamProgressRoute {
  const attention = attentionForProgress(input.progress)
  const delivery = decideProgressUpdateDelivery({
    policy: input.target.policy,
    severity: CRITICAL_PROGRESS.has(input.progress) ? 'critical' : 'normal',
    now: input.now,
    digestIntervalMs: input.digestIntervalMs,
    hasChannelTarget: Boolean(input.target.provider),
  })
  const dedupeKey = routeDedupeKey(input.event, input.assignment, input.target, input.progress)
  const deduped = ['immediate', 'digest', 'session'].includes(delivery.delivery) && wasRecentlyDelivered(dedupeKey, input.dedupeWindowMs, input.now, input.filePath, input.event.type !== 'team_assignment.digest_due')
  const failedCooldown = !deduped && ['immediate', 'digest', 'session'].includes(delivery.delivery) && (wasRecentlyFailed(dedupeKey, input.failureRetryMs, input.now, input.filePath) || input.failedTargetCooldowns.has(targetHash(input.target)))
  const route = {
    event: input.event,
    assignment: input.assignment,
    receipt: input.receipt,
    progress: input.progress,
    attention,
    target: input.target,
    delivery: deduped || failedCooldown ? 'deduped' as const : delivery.delivery,
    reason: deduped ? 'dedupe window active' : failedCooldown ? 'recent failed delivery cooldown' : delivery.reason,
    dedupeKey,
    text: '',
    deferredUntil: delivery.deferredUntil,
    suppressedUntil: delivery.suppressedUntil,
    escalationBypass: delivery.escalationBypass,
  }
  return { ...route, text: formatTeamProgressBriefing(route) }
}

function scheduledDigestRoutes(input: { state: WorkState; assignments: Array<TeamProgressRoute['assignment']>; now: number; dedupeWindowMs: number; failureRetryMs: number; failedTargetCooldowns: Set<string>; digestIntervalMs: number; filePath?: string }): TeamProgressRoute[] {
  const routes: TeamProgressRoute[] = []
  const windowKey = Math.floor(input.now / input.digestIntervalMs)
  for (const assignment of input.assignments) {
    const receipt = latestAssignmentReceipt(assignment)
    if (receipt && isTerminalCompletionReceipt(receipt)) continue
    for (const target of teamProgressTargets(assignment, input.state).filter(target => target.policy.mode === 'digest')) {
      const lastDigest = Date.parse(target.lastDigestAt || '')
      if (Number.isFinite(lastDigest) && input.now < lastDigest + input.digestIntervalMs) continue
      const event = syntheticDigestEvent(assignment, windowKey, input.now)
      routes.push(routeFor({ event, assignment, receipt, progress: 'scheduled_digest', target, now: input.now, dedupeWindowMs: input.dedupeWindowMs, failureRetryMs: input.failureRetryMs, failedTargetCooldowns: input.failedTargetCooldowns, digestIntervalMs: input.digestIntervalMs, filePath: input.filePath }))
    }
  }
  return routes
}

function isTeamProgressSourceEvent(event: WorkEventRecord): boolean {
  return event.type === 'team_assignment.created' || event.type === 'team_assignment.gate_result' || event.type === 'team_assignment.review_outcome' || event.type === 'team_assignment.completion'
}

function listTeamProgressSourceEvents(filePath?: string): WorkEventRecord[] {
  return [
    ...listAllWorkEventsByType('team_assignment.created', filePath),
    ...listAllWorkEventsByType('team_assignment.gate_result', filePath),
    ...listAllWorkEventsByType('team_assignment.review_outcome', filePath),
    ...listAllWorkEventsByType('team_assignment.completion', filePath),
  ].filter(isTeamProgressSourceEvent).sort((a, b) => a.id - b.id)
}

function teamProgressItemsForEvent(event: WorkEventRecord, assignmentById: Map<string, TeamProgressRoute['assignment']>, filePath?: string): Array<{ assignment: TeamProgressRoute['assignment']; receipt?: AssignmentReceiptRecord; progress: TeamProgressKind }> {
  if (event.type === 'team_assignment.created') {
    const assignments = ((event.payload as any)?.receipt?.assignments || []) as TeamTaskAssignment[]
    return assignments.map(assignment => ({ assignment: assignmentById.get(assignment.id) || assignment, progress: 'started' as const }))
  }
  const receipt = (event.payload as any)?.receipt as AssignmentReceiptRecord | undefined
  if (!receipt?.assignmentId) return []
  const assignment = assignmentById.get(receipt.assignmentId) || getTeamTaskAssignment(receipt.assignmentId, filePath)
  if (!assignment) return []
  return [{ assignment, receipt, progress: progressForReceipt(event.type, receipt) }]
}

function progressForReceipt(eventType: string, receipt: AssignmentReceiptRecord): TeamProgressKind {
  if (eventType === 'team_assignment.completion') {
    if (receipt.status === 'passed' || receipt.status === 'approved') return 'completed'
    if (receipt.status === 'blocked') return 'blocked'
    return 'failed'
  }
  if (receipt.status === 'pending') return 'gate_waiting'
  if (receipt.status === 'blocked') return 'blocked'
  if (receipt.status === 'failed' || receipt.status === 'rejected') return 'failed'
  if (receipt.status === 'passed' || receipt.status === 'approved') return 'resumed'
  return 'gate_waiting'
}

function latestAssignmentReceipt(assignment: TeamProgressRoute['assignment']): AssignmentReceiptRecord | undefined {
  return [...(assignment.receipts || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1)
}

function isTerminalCompletionReceipt(receipt: AssignmentReceiptRecord): boolean {
  return receipt.receiptKind === 'completion' && ['passed', 'approved', 'failed', 'rejected'].includes(receipt.status)
}

function teamProgressTargets(assignment: TeamTaskAssignment, state: WorkState): TeamProgressTarget[] {
  const byKey = new Map<string, TeamProgressTarget>()
  if (assignment.sessionId) {
    const policy = defaultProgressUpdatePolicy()
    addTarget(byKey, { key: `session:${assignment.sessionId}`, sessionId: assignment.sessionId, mode: policy.mode, quietHours: policy.quietHours as Record<string, unknown>, mutedUntil: policy.mutedUntil, lastDigestAt: policy.lastDigestAt, policy })
  }
  const roadmapId = assignmentRoadmapId(assignment, state)
  const bindings = state.projectBindings.filter(binding => roadmapId && binding.roadmapId === roadmapId)
  for (const binding of bindings) addTarget(byKey, targetFromBinding(binding))
  return [...byKey.values()].sort((a, b) => Number(Boolean(b.provider)) - Number(Boolean(a.provider)) || a.key.localeCompare(b.key))
}

function assignmentRoadmapId(assignment: TeamTaskAssignment, state: WorkState): string | undefined {
  if (assignment.roadmapId) return assignment.roadmapId
  const task = assignment.taskId ? state.tasks.find(row => row.id === assignment.taskId) : undefined
  if (task?.roadmapId) return task.roadmapId
  const run = assignment.runId ? state.runs.find(row => row.id === assignment.runId) : undefined
  if (!run) return undefined
  return state.tasks.find(row => row.id === run.taskId)?.roadmapId
}

function structuredTeamProgressMessage(route: TeamProgressRoute): StructuredGatewayMessage {
  const rendered = teamProgressMessage(route)
  return { ...rendered, fallback: { plainText: route.text, markdown: renderStructuredMessage(rendered, { markdown: true }).markdown } }
}

function teamFacts(assignment: TeamTaskAssignment, receipt: AssignmentReceiptRecord | undefined, attention: TeamProgressAttention): MessageFact[] {
  const facts: MessageFact[] = []
  addFact(facts, 'Team', `${assignment.teamName} (${assignment.teamId})`)
  addFact(facts, 'Member', assignment.memberId)
  addFact(facts, 'Role', assignment.role)
  addFact(facts, 'Assigned work', assignment.objective || assignment.taskId || assignment.runId || assignment.roadmapId || assignment.sessionId)
  addFact(facts, 'Task', assignment.taskId)
  addFact(facts, 'Run', receipt?.runId || assignment.runId)
  addFact(facts, 'Session', receipt?.sessionId || assignment.sessionId)
  addFact(facts, 'Current gate', receipt?.gateId || currentGate(assignment))
  addFact(facts, 'Evidence', evidenceStatus(assignment, receipt))
  addFact(facts, 'Attention', attention)
  return facts
}

function teamSummary(progress: TeamProgressKind, assignment: TeamTaskAssignment, receipt?: AssignmentReceiptRecord): string {
  if (progress === 'started') return `Team ${assignment.teamName}/${assignment.role} started assigned work${assignment.objective ? `: ${assignment.objective}` : ''}.`
  if (progress === 'scheduled_digest') return `Digest for ${assignment.teamName}/${assignment.role}: ${evidenceStatus(assignment, receipt)}; ${assignment.gates.length} gate(s) configured.`
  return receipt?.summary || `${assignment.teamName}/${assignment.role} ${progress.replace(/_/g, ' ')}.`
}

function teamCurrentStep(progress: TeamProgressKind, assignment: TeamTaskAssignment, receipt?: AssignmentReceiptRecord): string | undefined {
  if (progress === 'started') return assignment.gates.length ? `Working toward gate ${currentGate(assignment)}` : 'Assigned work started'
  if (progress === 'gate_waiting') return receipt?.gateId ? `Waiting at gate ${receipt.gateId}` : 'Waiting at assignment gate'
  if (progress === 'blocked') return receipt?.gateId ? `Blocked at gate ${receipt.gateId}` : 'Blocked'
  if (progress === 'resumed') return receipt?.gateId ? `Gate ${receipt.gateId} cleared` : 'Resumed'
  if (progress === 'completed') return 'Assignment completed'
  if (progress === 'failed') return 'Assignment failed'
  return 'Scheduled team digest'
}

function teamNextAction(progress: TeamProgressKind, assignment: TeamTaskAssignment, receipt?: AssignmentReceiptRecord): string {
  if (progress === 'gate_waiting') return receipt?.gateId ? `Review gate ${receipt.gateId} and record an approved, rejected, passed, or failed receipt.` : 'Review the waiting assignment gate.'
  if (progress === 'blocked') return `Inspect ${assignment.id}, resolve the blocker, then record a resumed gate/review receipt.`
  if (progress === 'failed') return `Inspect ${assignment.id}, decide retry or replacement, and keep the failed receipt as evidence.`
  if (progress === 'completed') return `Fold assignment ${assignment.id} evidence back into the parent work.`
  if (progress === 'resumed') return `Continue assignment ${assignment.id} toward the next gate or completion receipt.`
  if (progress === 'scheduled_digest') return `Review assignment ${assignment.id} if the digest shows stale evidence or gates.`
  return `Monitor assignment ${assignment.id} and record gate, review, or completion receipts as work advances.`
}

function teamActions(progress: TeamProgressKind, assignment: TeamTaskAssignment, receipt?: AssignmentReceiptRecord): MessageAction[] {
  const actions: MessageAction[] = [{ label: 'Open assignment', command: `/team assignment ${assignment.id}`, style: progress === 'started' || progress === 'completed' ? 'primary' : 'secondary' }]
  if (assignment.taskId) actions.push({ label: 'Open task', command: `/open ${assignment.taskId}` })
  if (receipt?.gateId && (progress === 'gate_waiting' || progress === 'blocked')) actions.push({ label: 'Record gate', command: `/team receipt ${assignment.id} ${receipt.gateId}`, style: 'primary' })
  return dedupeActions(actions).slice(0, 4)
}

function currentGate(assignment: TeamTaskAssignment): string | undefined {
  return assignment.gates[0]?.id
}

function evidenceStatus(assignment: TeamTaskAssignment, receipt?: AssignmentReceiptRecord): string {
  const required = assignment.requiredEvidence.filter(item => item.required)
  const evidenceCount = receipt?.evidence?.length || 0
  if (!required.length) return evidenceCount ? `${evidenceCount} evidence ref(s); none required` : 'no required evidence'
  return `${evidenceCount}/${required.length} required evidence ref(s)`
}

function attentionForProgress(progress: TeamProgressKind): TeamProgressAttention {
  if (progress === 'failed') return 'critical'
  if (progress === 'gate_waiting' || progress === 'blocked') return 'needs_attention'
  return 'monitor'
}

function teamProgressTitle(progress: TeamProgressKind): string {
  if (progress === 'started') return 'Team Assignment Started'
  if (progress === 'gate_waiting') return 'Team Assignment Waiting At Gate'
  if (progress === 'blocked') return 'Team Assignment Blocked'
  if (progress === 'resumed') return 'Team Assignment Resumed'
  if (progress === 'completed') return 'Team Assignment Completed'
  if (progress === 'failed') return 'Team Assignment Failed'
  return 'Team Progress Digest'
}

function targetFromBinding(binding: ProjectBindingRecord): TeamProgressTarget {
  const channelKey = binding.provider && binding.chatId ? `${binding.provider}:${binding.chatId}:${binding.threadId || ''}` : ''
  const policy = progressUpdatePolicyFromBinding(binding)
  return {
    key: channelKey || `session:${binding.sessionId}`,
    sessionId: binding.sessionId,
    provider: binding.provider,
    chatId: binding.chatId,
    threadId: binding.threadId,
    bindingId: binding.id,
    alias: binding.alias,
    mode: binding.notificationMode || 'immediate',
    mutedUntil: binding.mutedUntil,
    quietHours: binding.quietHours || {},
    lastDigestAt: binding.lastDigestAt,
    policy,
  }
}

function addTarget(targets: Map<string, TeamProgressTarget>, target: TeamProgressTarget): void {
  const existing = targets.get(target.key)
  if (!existing || (!existing.bindingId && target.bindingId)) targets.set(target.key, target)
}

function wasRecentlyDelivered(dedupeKey: string, dedupeWindowMs: number, now: number, filePath?: string, durableEvent = false): boolean {
  const since = durableEvent ? new Date(0) : new Date(now - dedupeWindowMs)
  return listRecentWorkEvents('team_assignment.briefing.notified', dedupeKey, since, 100, filePath).length > 0
}

function wasRecentlyFailed(dedupeKey: string, failureRetryMs: number, now: number, filePath?: string): boolean {
  const since = new Date(now - failureRetryMs)
  return listRecentWorkEvents('team_assignment.briefing.failed', dedupeKey, since, 100, filePath).length > 0
}

function recentFailedTargetKeys(failureRetryMs: number, now: number, filePath?: string): Set<string> {
  const since = now - failureRetryMs
  const keys = new Set<string>()
  for (const event of listWorkEventsByType('team_assignment.briefing.failed', 5000, filePath)) {
    if (Date.parse(event.createdAt) < since) continue
    const key = typeof event.payload?.['targetKey'] === 'string' ? event.payload['targetKey'] : ''
    if (key) keys.add(key)
  }
  return keys
}

function routeDedupeKey(event: WorkEventRecord, assignment: TeamTaskAssignment, target: TeamProgressTarget, progress: TeamProgressKind): string {
  const scheduledWindow = event.type === 'team_assignment.digest_due' ? event.payload['windowKey'] : ''
  return hash([event.type, event.id, scheduledWindow, progress, assignment.id, target.key].join('\n'))
}

function eventPayload(route: TeamProgressRoute): Record<string, unknown> {
  return {
    dedupeKey: route.dedupeKey,
    progressEventId: route.event.id,
    progress: route.progress,
    attention: route.attention,
    assignmentId: route.assignment.id,
    assignmentReceiptId: route.receipt?.id,
    teamId: route.assignment.teamId,
    teamName: route.assignment.teamName,
    memberId: route.assignment.memberId,
    role: route.assignment.role,
    taskId: route.assignment.taskId,
    roadmapId: route.assignment.roadmapId,
    runId: route.receipt?.runId || route.assignment.runId,
    sessionId: route.target.sessionId,
    gateId: route.receipt?.gateId,
    evidenceStatus: evidenceStatus(route.assignment, route.receipt),
    targetKey: targetHash(route.target),
    provider: route.target.provider,
    delivery: route.delivery,
    reason: route.reason,
    deferredUntil: route.deferredUntil,
    suppressedUntil: route.suppressedUntil,
    escalationBypass: route.escalationBypass,
    mutedUntil: route.target.policy.mutedUntil,
    quietHours: route.target.policy.quietHours,
    lastDigestAt: route.target.policy.lastDigestAt,
  }
}

function syntheticDigestEvent(assignment: TeamTaskAssignment, windowKey: number, now: number): WorkEventRecord {
  return {
    id: -Number(hash(`${assignment.id}:${windowKey}`).slice(0, 8)),
    type: 'team_assignment.digest_due',
    subjectId: assignment.id,
    payload: { progress: 'scheduled_digest', assignmentId: assignment.id, teamId: assignment.teamId, memberId: assignment.memberId, windowKey },
    createdAt: new Date(now).toISOString(),
  }
}

function sessionTeamProgressPrompt(route: TeamProgressRoute): string {
  return [
    'Gateway team progress briefing.',
    'Record this update concisely for the bound session; do not restart or duplicate the assignment.',
    '',
    route.text,
  ].join('\n')
}

function addFact(facts: MessageFact[], label: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) facts.push({ label, value })
  else if (typeof value === 'number' || typeof value === 'boolean') facts.push({ label, value: String(value) })
}

function dedupeActions(actions: MessageAction[]): MessageAction[] {
  const seen = new Set<string>()
  return actions.filter(action => {
    const key = action.command || action.url || action.label
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function targetHash(target: TeamProgressTarget): string {
  return hash(`${target.provider || 'session'}:${target.chatId || target.sessionId}:${target.threadId || ''}`).slice(0, 12)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer)
    })
  })
}
