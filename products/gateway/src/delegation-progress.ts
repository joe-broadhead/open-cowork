import { createHash } from 'node:crypto'
import type { ChannelAdapter } from './channels/provider.js'
import { gateApprovalCard, progressCard, renderStructuredMessage, runResultCard, type MessageAction, type MessageFact, type StructuredGatewayMessage } from './channels/renderer.js'
import { queueEvent } from './wakeup.js'
import { redactSensitiveText } from './security.js'
import { decideProgressUpdateDelivery, defaultProgressUpdatePolicy, progressUpdatePolicyFromBinding, progressUpdatePolicyFromTarget, type ProgressUpdatePolicy } from './progress-update-policy.js'
import { createSqliteDelegationProgressReadModel, type DelegationProgressReadModel } from './delegation-progress-read-model.js'
import {
  appendWorkEvent,
  loadWorkState,
  updateProjectBinding,
  upsertAlert,
  type DelegatedWorkProgressKind,
  type ProjectBindingRecord,
  type ProjectNotificationMode,
  type WorkEventRecord,
  type WorkState,
} from './work-store.js'

export type DelegationProgressDelivery = 'immediate' | 'digest' | 'deferred' | 'muted' | 'deduped' | 'session'

export interface DelegationProgressTarget {
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

export interface DelegationProgressRoute {
  event: WorkEventRecord
  target: DelegationProgressTarget
  delivery: DelegationProgressDelivery
  reason: string
  dedupeKey: string
  text: string
  deferredUntil?: string
  suppressedUntil?: string
  escalationBypass?: 'digest' | 'quiet_hours'
}

export interface DelegationProgressRoutingOptions {
  now?: number
  dedupeWindowMs?: number
  digestIntervalMs?: number
  filePath?: string
  readModel?: DelegationProgressReadModel
  sessionClient?: DelegationProgressSessionClient
  sessionPromptTimeoutMs?: number
  channelDeliveryTimeoutMs?: number
  timeoutRetryDelayMs?: number
}

export interface DelegationProgressSessionClient {
  session?: {
    prompt(args: { path: { id: string }; body: { agent?: string; parts: Array<{ type: 'text'; text: string }> } }): Promise<unknown>
  }
}

export interface DelegationProgressDeliveryResult {
  routes: DelegationProgressRoute[]
  sent: DelegationProgressRoute[]
  failed: Array<{ route: DelegationProgressRoute; error: string }>
  suppressed: DelegationProgressRoute[]
}

const DEFAULT_DEDUPE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_DIGEST_MS = 24 * 60 * 60 * 1000
const DEFAULT_SESSION_PROMPT_TIMEOUT_MS = 15_000
const DEFAULT_CHANNEL_DELIVERY_TIMEOUT_MS = 15_000
const DEFAULT_TIMEOUT_RETRY_DELAY_MS = 5 * 60 * 1000
const DELEGATION_PROGRESS_EVENT_LIMIT = 50_000
const CRITICAL_PROGRESS = new Set<DelegatedWorkProgressKind>(['blocked', 'failed', 'gate_opened', 'completion_proposed'])

export function buildDelegationProgressRoutes(state: WorkState = loadWorkState(), options: DelegationProgressRoutingOptions = {}): DelegationProgressRoute[] {
  const now = options.now || Date.now()
  const dedupeWindowMs = Math.max(1000, options.dedupeWindowMs || DEFAULT_DEDUPE_MS)
  const digestIntervalMs = Math.max(60_000, options.digestIntervalMs || DEFAULT_DIGEST_MS)
  const timeoutRetryDelayMs = Math.max(1000, options.timeoutRetryDelayMs || DEFAULT_TIMEOUT_RETRY_DELAY_MS)
  const readModel = options.readModel || createSqliteDelegationProgressReadModel({ filePath: options.filePath })
  const routes: DelegationProgressRoute[] = []

  for (const event of readModel.listProgressEvents({ limit: DELEGATION_PROGRESS_EVENT_LIMIT })) {
    const targets = delegationProgressTargets(event, state)
    for (const target of targets) {
      const dedupeKey = routeDedupeKey(event, target)
      const delivery = decideProgressUpdateDelivery({
        policy: target.policy,
        severity: CRITICAL_PROGRESS.has(progressKind(event)) ? 'critical' : 'normal',
        now,
        digestIntervalMs,
        hasChannelTarget: Boolean(target.provider),
      })
      const deduped = ['immediate', 'digest', 'session'].includes(delivery.delivery) && wasRecentlyDelivered(readModel, dedupeKey, dedupeWindowMs, now)
      const pendingRetryAt = !deduped && ['immediate', 'digest', 'session'].includes(delivery.delivery) ? pendingAttemptRetryAt(readModel, dedupeKey, now) : undefined
      const timeoutRetryAt = !deduped && !pendingRetryAt && ['immediate', 'digest', 'session'].includes(delivery.delivery) ? recentTimeoutRetryAt(readModel, dedupeKey, timeoutRetryDelayMs, now) : undefined
      routes.push({
        event,
        target,
        delivery: deduped ? 'deduped' : (pendingRetryAt || timeoutRetryAt) ? 'deferred' : delivery.delivery,
        reason: deduped ? 'dedupe window active' : pendingRetryAt ? 'delivery attempt already in progress' : timeoutRetryAt ? 'recent timeout retry cooldown' : delivery.reason,
        dedupeKey,
        text: formatDelegationProgressNotification(event),
        deferredUntil: pendingRetryAt || timeoutRetryAt || delivery.deferredUntil,
        suppressedUntil: delivery.suppressedUntil,
        escalationBypass: delivery.escalationBypass,
      })
    }
  }
  return sortDelegationProgressRoutes(routes, readModel, dedupeWindowMs, now)
}

export async function deliverDelegationProgress(channels: Map<string, Pick<ChannelAdapter, 'sendMessage' | 'sendStructuredMessage'>>, input: { state?: WorkState } = {}, options: DelegationProgressRoutingOptions = {}): Promise<DelegationProgressDeliveryResult> {
  const state = input.state || loadWorkState(options.filePath)
  const routes = buildDelegationProgressRoutes(state, options)
  const sent: DelegationProgressRoute[] = []
  const failed: Array<{ route: DelegationProgressRoute; error: string }> = []
  const suppressed: DelegationProgressRoute[] = []

  for (const route of routes) {
    if (route.delivery === 'session') {
      if (!route.target.sessionId) {
        const suppressedRoute = { ...route, delivery: 'deferred' as const, reason: 'missing parent session id' }
        suppressed.push(suppressedRoute)
        appendWorkEvent('delegation.progress.suppressed', route.dedupeKey, eventPayload(suppressedRoute), options.filePath)
        continue
      }
      if (!options.sessionClient?.session?.prompt) {
        const suppressedRoute = { ...route, delivery: 'deferred' as const, reason: 'session client unavailable' }
        suppressed.push(suppressedRoute)
        appendWorkEvent('delegation.progress.suppressed', route.dedupeKey, eventPayload(suppressedRoute), options.filePath)
        continue
      }
      try {
        recordDeliveryAttempt(route, Math.max(1, options.sessionPromptTimeoutMs || DEFAULT_SESSION_PROMPT_TIMEOUT_MS), options)
        await withTimeout(options.sessionClient.session.prompt({
          path: { id: route.target.sessionId },
          body: { agent: 'gateway-assistant', parts: [{ type: 'text', text: sessionProgressPrompt(route) }] },
        }), Math.max(1, options.sessionPromptTimeoutMs || DEFAULT_SESSION_PROMPT_TIMEOUT_MS), 'parent session prompt')
        appendWorkEvent('delegation.progress.notified', route.dedupeKey, eventPayload(route), options.filePath)
        sent.push(route)
      } catch (err: any) {
        const error = redactSensitiveText(err?.message || String(err))
        failed.push({ route, error })
        appendWorkEvent('delegation.progress.failed', route.dedupeKey, { ...eventPayload(route), error }, options.filePath)
        queueEvent(`Delegated progress session notify failed for ${route.target.sessionId}: ${error}`)
      }
      continue
    }
    if (route.delivery !== 'immediate' && route.delivery !== 'digest') {
      suppressed.push(route)
      if (route.delivery !== 'deduped') appendWorkEvent('delegation.progress.suppressed', route.dedupeKey, eventPayload(route), options.filePath)
      continue
    }
    if (!route.target.provider || !route.target.chatId) {
      const suppressedRoute = { ...route, delivery: 'session' as const, reason: 'OpenCode session target only' }
      suppressed.push(suppressedRoute)
      appendWorkEvent('delegation.progress.suppressed', route.dedupeKey, eventPayload(suppressedRoute), options.filePath)
      continue
    }
    const channel = channels.get(route.target.provider)
    if (!channel?.sendMessage && !channel?.sendStructuredMessage) {
      const suppressedRoute = { ...route, delivery: 'deferred' as const, reason: 'channel adapter unavailable' }
      suppressed.push(suppressedRoute)
      appendWorkEvent('delegation.progress.suppressed', route.dedupeKey, eventPayload(suppressedRoute), options.filePath)
      continue
    }
    try {
      const message = structuredProgressMessage(route)
      const channelTimeoutMs = Math.max(1, options.channelDeliveryTimeoutMs || DEFAULT_CHANNEL_DELIVERY_TIMEOUT_MS)
      recordDeliveryAttempt(route, channelTimeoutMs, options)
      const delivery = channel.sendStructuredMessage
        ? channel.sendStructuredMessage(route.target.chatId, message, { threadId: route.target.threadId })
        : channel.sendMessage(route.target.chatId, route.text.substring(0, 4000), { threadId: route.target.threadId })
      await withTimeout(delivery, channelTimeoutMs, `${route.target.provider} progress notification`)
      sent.push(route)
      appendWorkEvent('delegation.progress.notified', route.dedupeKey, eventPayload(route), options.filePath)
      if (route.delivery === 'digest' && route.target.bindingId) updateProjectBinding(route.target.bindingId, { lastDigestAt: new Date(options.now || Date.now()).toISOString() }, options.filePath)
    } catch (err: any) {
      const error = redactSensitiveText(err?.message || String(err))
      failed.push({ route, error })
      appendWorkEvent('delegation.progress.failed', route.dedupeKey, { ...eventPayload(route), error }, options.filePath)
      upsertAlert({ key: `delegation-progress:${route.target.provider}:${targetHash(route.target)}`, severity: 'warning', source: 'delegation.progress', target: String(route.event.payload['roadmapId'] || route.event.subjectId || ''), summary: 'Delegated progress notification delivery failed', evidence: [route.target.provider || 'unknown', error], nextAction: 'Check channel credentials, allowlists, and delegated work notification bindings.' }, {}, options.filePath)
      queueEvent(`Delegated progress notification failed for ${route.event.subjectId || route.event.id} via ${route.target.provider}: ${error}`)
    }
  }

  return { routes, sent, failed, suppressed }
}

export function delegationProgressTargets(event: WorkEventRecord, state: WorkState): DelegationProgressTarget[] {
  const byKey = new Map<string, DelegationProgressTarget>()
  const payload = event.payload || {}
  const parentSessionId = typeof payload['parentSessionId'] === 'string' ? payload['parentSessionId'] : undefined
  const targetMode = payload['notificationTarget'] && typeof payload['notificationTarget'] === 'object' && !Array.isArray(payload['notificationTarget']) ? (payload['notificationTarget'] as any).mode : undefined
  const parentPolicy = targetMode === 'parent_session' ? progressUpdatePolicyFromTarget(payload['notificationTarget']) : defaultProgressUpdatePolicy()
  const channelPolicy = progressUpdatePolicyFromTarget(payload['notificationTarget'])
  if (parentSessionId) addTarget(byKey, { key: `session:${parentSessionId}`, sessionId: parentSessionId, mode: parentPolicy.mode, mutedUntil: parentPolicy.mutedUntil, quietHours: parentPolicy.quietHours as Record<string, unknown>, lastDigestAt: parentPolicy.lastDigestAt, policy: parentPolicy })

  const explicit = explicitChannelTarget(payload['notificationTarget'])
  const parentChannel = explicit || explicitChannelTarget((payload['notificationTarget'] as any)?.parentSession?.channel)
  const sessionId = parentSessionId || (typeof (payload['notificationTarget'] as any)?.sessionId === 'string' ? (payload['notificationTarget'] as any).sessionId : undefined)
  if (parentChannel) {
    addTarget(byKey, {
      key: `${parentChannel.provider}:${parentChannel.chatId}:${parentChannel.threadId || ''}`,
      sessionId,
      provider: parentChannel.provider,
      chatId: parentChannel.chatId,
      threadId: parentChannel.threadId,
      mode: channelPolicy.mode,
      mutedUntil: channelPolicy.mutedUntil,
      quietHours: channelPolicy.quietHours as Record<string, unknown>,
      lastDigestAt: channelPolicy.lastDigestAt,
      policy: channelPolicy,
    })
  }

  const roadmapId = typeof payload['roadmapId'] === 'string' ? payload['roadmapId'] : undefined
  const bindingId = typeof payload['projectBindingId'] === 'string' ? payload['projectBindingId'] : undefined
  const bindings = state.projectBindings.filter(binding => (bindingId && binding.id === bindingId) || (roadmapId && binding.roadmapId === roadmapId))
  for (const binding of bindings) addTarget(byKey, targetFromBinding(binding))
  return [...byKey.values()].sort((a, b) => Number(Boolean(b.provider)) - Number(Boolean(a.provider)) || a.key.localeCompare(b.key))
}

export function formatDelegationProgressNotification(event: WorkEventRecord): string {
  return renderStructuredMessage(delegationProgressMessage(event), { plainText: true }).plainText.substring(0, 4000)
}

export function delegationProgressMessage(event: WorkEventRecord): StructuredGatewayMessage {
  const payload = event.payload || {}
  const progress = progressKind(event)
  const summary = typeof payload['summary'] === 'string' ? payload['summary'] : progressTitle(progress)
  const facts = progressFacts(payload)
  const nextAction = progressNextAction(progress, payload)
  const actions = progressActions(progress, payload)

  if (progress === 'gate_opened' && typeof payload['gateId'] === 'string') {
    return gateApprovalCard({
      gateId: payload['gateId'],
      title: progressTitle(progress),
      reason: summary,
      taskId: stringPayload(payload, 'taskId'),
      roadmapId: stringPayload(payload, 'roadmapId'),
      stage: stringPayload(payload, 'stage'),
      expiresAt: stringPayload(payload, 'expiresAt'),
      approveCommand: `/gate approve ${payload['gateId']} once`,
      rejectCommand: `/gate reject ${payload['gateId']}`,
    })
  }

  if ((progress === 'completed' || progress === 'failed' || progress === 'blocked') && typeof payload['runId'] === 'string') {
    return runResultCard({
      runId: payload['runId'],
      title: progressTitle(progress),
      status: progress,
      stage: stringPayload(payload, 'stage') || stringPayload(payload, 'nextStage') || 'delegated-work',
      summary,
      sessionId: stringPayload(payload, 'sessionId'),
      metrics: facts.filter(fact => !['Run', 'Stage', 'Session'].includes(fact.label)),
      nextAction,
      actions,
    })
  }

  return progressCard({
    title: progressTitle(progress),
    status: progress,
    summary,
    currentStep: progressCurrentStep(progress, payload),
    facts,
    nextAction,
    actions,
  })
}

function structuredProgressMessage(route: DelegationProgressRoute): StructuredGatewayMessage {
  const rendered = delegationProgressMessage(route.event)
  return { ...rendered, fallback: { plainText: route.text, markdown: renderStructuredMessage(rendered, { markdown: true }).markdown } }
}

function progressFacts(payload: Record<string, unknown>): MessageFact[] {
  const facts: MessageFact[] = []
  addFact(facts, 'Delegation', payload['idempotencyKey'])
  addFact(facts, 'Roadmap', payload['roadmapId'])
  addFact(facts, 'Task', payload['taskId'])
  addFact(facts, 'Run', payload['runId'])
  addFact(facts, 'Stage', payload['stage'])
  addFact(facts, 'Next stage', payload['nextStage'])
  addFact(facts, 'Session', payload['sessionId'])
  addFact(facts, 'Proposal', payload['proposalId'])
  addFact(facts, 'Binding', payload['projectBindingId'])
  addFact(facts, 'Outcome', payload['taskStatus'] || payload['runStatus'] || payload['status'])
  return facts
}

function progressCurrentStep(progress: DelegatedWorkProgressKind, payload: Record<string, unknown>): string | undefined {
  if (progress === 'dispatched' && typeof payload['stage'] === 'string') return `${payload['stage']} started`
  if (progress === 'stage_advanced' && typeof payload['nextStage'] === 'string') return `${payload['nextStage']} queued`
  if (progress === 'gate_opened') return 'Waiting for operator decision'
  if (progress === 'completion_proposed') return 'Waiting for completion decision'
  return undefined
}

function progressNextAction(progress: DelegatedWorkProgressKind, payload: Record<string, unknown>): string {
  const taskId = stringPayload(payload, 'taskId')
  const roadmapId = stringPayload(payload, 'roadmapId')
  const runId = stringPayload(payload, 'runId')
  if (progress === 'created') return humanizeSchedulerAction(stringPayload(payload, 'nextSchedulerAction')) || 'Wait for scheduler dispatch, or use /status to inspect the queue.'
  if (progress === 'dispatched') return runId ? `Follow run ${runId}, or use /open ${runId}.` : 'Follow the active run, or use /status.'
  if (progress === 'stage_advanced') return stringPayload(payload, 'nextStage') ? `Next stage ${payload['nextStage']} is queued.` : 'Watch the next stage, or use /status.'
  if (progress === 'gate_opened') return stringPayload(payload, 'gateId') ? `Approve or reject gate ${payload['gateId']}.` : 'Review pending Gateway gates with /gates.'
  if (progress === 'completion_proposed') return stringPayload(payload, 'proposalId') ? `Approve or reject completion proposal ${payload['proposalId']}.` : 'Review pending completion proposals with /completion.'
  if (progress === 'completed') return taskId || roadmapId ? `Review outcome with /open ${taskId || roadmapId}. That reply includes TUI and Mission Control fallback guidance if Web does not recover.` : 'Review the completion evidence.'
  if (progress === 'blocked') return taskId ? `Inspect the blocker, then use /task retry ${taskId} or /attention.` : 'Inspect the blocker, then use /attention.'
  if (progress === 'failed') return taskId ? `Inspect the failed attempt, then use /task retry ${taskId}.` : 'Inspect the failed attempt before retrying.'
  return 'Use /status for the latest Gateway state.'
}

function progressActions(progress: DelegatedWorkProgressKind, payload: Record<string, unknown>): MessageAction[] {
  const taskId = stringPayload(payload, 'taskId')
  const roadmapId = stringPayload(payload, 'roadmapId')
  const runId = stringPayload(payload, 'runId')
  const proposalId = stringPayload(payload, 'proposalId')
  const gateId = stringPayload(payload, 'gateId')
  const targetId = runId || taskId || roadmapId
  const actions: MessageAction[] = []

  if (progress === 'gate_opened') {
    if (gateId) {
      actions.push({ label: 'Approve once', command: `/gate approve ${gateId} once`, style: 'primary' })
      actions.push({ label: 'Reject', command: `/gate reject ${gateId}`, style: 'danger' })
    } else {
      actions.push({ label: 'Review gates', command: '/gates', style: 'primary' })
    }
    return actions
  }

  if (progress === 'completion_proposed') {
    if (proposalId) {
      actions.push({ label: 'Approve completion', command: `/completion approve ${proposalId}`, style: 'primary' })
      actions.push({ label: 'Reject completion', command: `/completion reject ${proposalId}`, style: 'danger' })
    } else {
      actions.push({ label: 'Completion', command: '/completion', style: 'primary' })
    }
    return actions
  }

  if (targetId) actions.push({ label: progress === 'created' ? 'Open work' : 'Open', command: `/open ${targetId}`, style: progress === 'created' || progress === 'completed' ? 'primary' : 'secondary' })
  if (progress === 'blocked' || progress === 'failed') {
    if (taskId) actions.push({ label: 'Retry task', command: `/task retry ${taskId}`, style: 'primary' })
    actions.push({ label: 'Attention', command: '/attention' })
  } else {
    actions.push({ label: 'Status', command: '/status' })
  }
  return dedupeActions(actions).slice(0, 4)
}

function addFact(facts: MessageFact[], label: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) facts.push({ label, value })
  else if (typeof value === 'number' || typeof value === 'boolean') facts.push({ label, value: String(value) })
}

function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === 'string' && payload[key] ? payload[key] as string : undefined
}

function humanizeSchedulerAction(value: string | undefined): string {
  if (!value) return ''
  if (value === 'wait_for_scheduler_dispatch') return 'Wait for scheduler dispatch, or use /status to inspect the queue.'
  if (value === 'inspect_existing_delegation') return 'Inspect the existing delegated work before retrying.'
  return value.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
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

function sessionProgressPrompt(route: DelegationProgressRoute): string {
  return [
    'Gateway delegated-work progress update.',
    'Parent receipt: record this update concisely in the existing parent OpenCode Session.',
    'Do not restart, duplicate, or take over the delegated work; this prompt is receipt-only.',
    '',
    route.text,
  ].join('\n')
}

function targetFromBinding(binding: ProjectBindingRecord): DelegationProgressTarget {
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

function explicitChannelTarget(value: unknown): { provider: string; chatId: string; threadId?: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const target = value as any
  if (target.mode !== undefined && target.mode !== 'channel') return undefined
  if (typeof target.provider !== 'string' || typeof target.chatId !== 'string') return undefined
  return { provider: target.provider, chatId: target.chatId, threadId: typeof target.threadId === 'string' ? target.threadId : undefined }
}

function addTarget(targets: Map<string, DelegationProgressTarget>, target: DelegationProgressTarget): void {
  const existing = targets.get(target.key)
  if (!existing || (!existing.bindingId && target.bindingId)) targets.set(target.key, target)
}

function progressKind(event: WorkEventRecord): DelegatedWorkProgressKind {
  const value = event.payload?.['progress']
  return value === 'created' || value === 'dispatched' || value === 'stage_advanced' || value === 'blocked' || value === 'gate_opened' || value === 'completed' || value === 'failed' || value === 'completion_proposed' ? value : 'created'
}

function progressTitle(progress: DelegatedWorkProgressKind): string {
  if (progress === 'created') return 'Delegated Work Created'
  if (progress === 'dispatched') return 'Delegated Work Dispatched'
  if (progress === 'stage_advanced') return 'Delegated Work Advanced'
  if (progress === 'blocked') return 'Delegated Work Blocked'
  if (progress === 'gate_opened') return 'Delegated Work Needs Approval'
  if (progress === 'completed') return 'Delegated Work Completed'
  if (progress === 'failed') return 'Delegated Work Failed'
  return 'Delegated Completion Proposed'
}

function wasRecentlyDelivered(readModel: DelegationProgressReadModel, dedupeKey: string, dedupeWindowMs: number, now: number): boolean {
  const since = new Date(now - dedupeWindowMs)
  const receipts = readModel.listRouteReceipts({ dedupeKey, since, limit: 100 })
  if (receipts.some(receipt => receipt.state === 'delivered' || receipt.state === 'retried')) return true
  return readModel.listDeliveryEvents({ type: 'delegation.progress.notified', dedupeKey, since, limit: 100 }).length > 0
}

function pendingAttemptRetryAt(readModel: DelegationProgressReadModel, dedupeKey: string, now: number): string | undefined {
  const retryAt = readModel.listRouteReceipts({ dedupeKey, limit: 20 })
    .filter(receipt => receipt.state === 'pending')
    .map(receipt => Date.parse(receipt.deferredUntil || ''))
    .filter(value => Number.isFinite(value) && value > now)
    .sort((a, b) => b - a)[0]
  return retryAt ? new Date(retryAt).toISOString() : undefined
}

function wasRecentlyFailed(readModel: DelegationProgressReadModel, dedupeKey: string, dedupeWindowMs: number, now: number): boolean {
  const since = new Date(now - dedupeWindowMs)
  const receipts = readModel.listRouteReceipts({ dedupeKey, since, limit: 100 })
  if (receipts.some(receipt => receipt.state === 'failed')) return true
  return readModel.listDeliveryEvents({ type: 'delegation.progress.failed', dedupeKey, since, limit: 100 }).length > 0
}

function recentTimeoutRetryAt(readModel: DelegationProgressReadModel, dedupeKey: string, timeoutRetryDelayMs: number, now: number): string | undefined {
  const since = new Date(now - timeoutRetryDelayMs)
  const receiptRetryAt = readModel.listRouteReceipts({ dedupeKey, since, limit: 100 })
    .filter(receipt => receipt.state === 'failed' && typeof receipt.error === 'string' && /\btimed out after \d+ms\b/.test(receipt.error))
    .map(receipt => Date.parse(receipt.updatedAt) + timeoutRetryDelayMs)
    .filter(value => Number.isFinite(value) && value > now)
    .sort((a, b) => b - a)[0]
  if (receiptRetryAt) return new Date(receiptRetryAt).toISOString()
  const retryAt = readModel.listDeliveryEvents({ type: 'delegation.progress.failed', dedupeKey, since, limit: 100 })
    .filter(event => typeof event.payload?.['error'] === 'string' && /\btimed out after \d+ms\b/.test(event.payload['error']))
    .map(event => Date.parse(event.createdAt) + timeoutRetryDelayMs)
    .filter(value => Number.isFinite(value) && value > now)
    .sort((a, b) => b - a)[0]
  return retryAt ? new Date(retryAt).toISOString() : undefined
}

function sortDelegationProgressRoutes(routes: DelegationProgressRoute[], readModel: DelegationProgressReadModel, dedupeWindowMs: number, now: number): DelegationProgressRoute[] {
  const failed = new Map<string, boolean>()
  const recentlyFailed = (route: DelegationProgressRoute) => {
    const cached = failed.get(route.dedupeKey)
    if (cached !== undefined) return cached
    const value = wasRecentlyFailed(readModel, route.dedupeKey, dedupeWindowMs, now)
    failed.set(route.dedupeKey, value)
    return value
  }
  return routes.sort((a, b) =>
    Number(recentlyFailed(a)) - Number(recentlyFailed(b))
    || routeDeliveryRank(a) - routeDeliveryRank(b)
    || a.event.id - b.event.id
    || a.target.key.localeCompare(b.target.key))
}

function routeDeliveryRank(route: DelegationProgressRoute): number {
  if ((route.delivery === 'immediate' || route.delivery === 'digest') && route.target.provider && route.target.chatId) return 0
  if (route.delivery === 'session') return 1
  if (route.delivery === 'deduped') return 3
  return 2
}

function routeDedupeKey(event: WorkEventRecord, target: DelegationProgressTarget): string {
  return hash([event.payload?.['progressKey'] || event.id, target.key].join('\n'))
}

function eventPayload(route: DelegationProgressRoute): Record<string, unknown> {
  return { dedupeKey: route.dedupeKey, progressEventId: route.event.id, progressKey: route.event.payload['progressKey'], idempotencyKey: route.event.payload['idempotencyKey'], progress: route.event.payload['progress'], targetKey: targetHash(route.target), provider: route.target.provider, sessionId: route.target.sessionId, delivery: route.delivery, reason: route.reason, deferredUntil: route.deferredUntil, suppressedUntil: route.suppressedUntil, escalationBypass: route.escalationBypass, mutedUntil: route.target.policy.mutedUntil, quietHours: route.target.policy.quietHours, lastDigestAt: route.target.policy.lastDigestAt }
}

function recordDeliveryAttempt(route: DelegationProgressRoute, timeoutMs: number, options: DelegationProgressRoutingOptions): void {
  const attemptUntil = new Date((options.now || Date.now()) + timeoutMs).toISOString()
  appendWorkEvent('delegation.progress.attempting', route.dedupeKey, eventPayload({
    ...route,
    reason: 'delivery attempt in progress',
    deferredUntil: attemptUntil,
  }), options.filePath)
}

function targetHash(target: DelegationProgressTarget): string {
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
