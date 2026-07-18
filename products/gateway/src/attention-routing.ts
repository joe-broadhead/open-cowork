import { createHash } from 'node:crypto'
import type { ChannelAdapter } from './channels/provider.js'
import { redactSensitiveText } from './security.js'
import { queueEvent } from './wakeup.js'
import { buildNeedsAttentionReport, type NeedsAttentionReport, type ProjectAttentionGroup } from './human-loop.js'
import { decideProgressUpdateDelivery, progressUpdatePolicyForSupervisor, progressUpdatePolicyFromBinding, type ProgressUpdatePolicy } from './progress-update-policy.js'
import {
  appendWorkEvent,
  listRecentWorkEvents,
  loadWorkState,
  updateProjectBinding,
  upsertAlert,
  type ProjectBindingRecord,
  type ProjectNotificationMode,
  type WorkState,
} from './work-store.js'

export type ProjectNotificationDelivery = 'immediate' | 'digest' | 'deferred' | 'muted' | 'deduped' | 'session'

export interface ProjectNotificationTarget {
  key: string
  sessionId: string
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

export interface ProjectAttentionRoute {
  group: ProjectAttentionGroup
  target: ProjectNotificationTarget
  delivery: ProjectNotificationDelivery
  reason: string
  dedupeKey: string
  text: string
  deferredUntil?: string
  suppressedUntil?: string
  escalationBypass?: 'digest' | 'quiet_hours'
}

export interface ProjectAttentionRoutingOptions {
  now?: number
  dedupeWindowMs?: number
  digestIntervalMs?: number
  filePath?: string
  channelDeliveryTimeoutMs?: number
}

export interface ProjectAttentionDeliveryResult {
  routes: ProjectAttentionRoute[]
  sent: ProjectAttentionRoute[]
  failed: Array<{ route: ProjectAttentionRoute; error: string }>
  suppressed: ProjectAttentionRoute[]
}

const DEFAULT_DEDUPE_MS = 60 * 60 * 1000
const DEFAULT_DIGEST_MS = 24 * 60 * 60 * 1000
const DEFAULT_CHANNEL_DELIVERY_TIMEOUT_MS = 15_000

export function buildProjectAttentionRoutes(report: NeedsAttentionReport, state: WorkState = loadWorkState(), options: ProjectAttentionRoutingOptions = {}): ProjectAttentionRoute[] {
  const now = options.now || Date.now()
  const dedupeWindowMs = Math.max(1000, options.dedupeWindowMs || DEFAULT_DEDUPE_MS)
  const digestIntervalMs = Math.max(60_000, options.digestIntervalMs || DEFAULT_DIGEST_MS)
  const routes: ProjectAttentionRoute[] = []

  for (const group of report.projects || []) {
    const targets = notificationTargetsForProject(group, state)
    for (const target of targets) {
      const dedupeKey = routeDedupeKey(group, target)
      const delivery = decideProgressUpdateDelivery({
        policy: target.policy,
        severity: group.severity === 'critical' ? 'critical' : 'normal',
        now,
        digestIntervalMs,
        hasChannelTarget: Boolean(target.provider),
      })
      const text = formatProjectAttentionNotification(group, delivery)
      const deduped = ['immediate', 'digest'].includes(delivery.delivery) && wasRecentlyDelivered(dedupeKey, dedupeWindowMs, now, options.filePath)
      const pendingRetryAt = !deduped && ['immediate', 'digest'].includes(delivery.delivery) ? pendingProjectAttemptRetryAt(dedupeKey, dedupeWindowMs, now, options.filePath) : undefined
      routes.push({ group, target, delivery: deduped ? 'deduped' : pendingRetryAt ? 'deferred' : delivery.delivery, reason: deduped ? 'dedupe window active' : pendingRetryAt ? 'delivery attempt already in progress' : delivery.reason, dedupeKey, text, deferredUntil: pendingRetryAt || delivery.deferredUntil, suppressedUntil: delivery.suppressedUntil, escalationBypass: delivery.escalationBypass })
    }
  }
  return routes
}

export async function deliverProjectAttention(channels: Map<string, Pick<ChannelAdapter, 'sendMessage'>>, input: { report?: NeedsAttentionReport; state?: WorkState } = {}, options: ProjectAttentionRoutingOptions = {}): Promise<ProjectAttentionDeliveryResult> {
  const state = input.state || loadWorkState(options.filePath)
  const report = input.report || buildNeedsAttentionReport({ state, now: options.now })
  const routes = buildProjectAttentionRoutes(report, state, options)
  const sent: ProjectAttentionRoute[] = []
  const failed: Array<{ route: ProjectAttentionRoute; error: string }> = []
  const suppressed: ProjectAttentionRoute[] = []

  for (const route of routes) {
    if (route.delivery !== 'immediate' && route.delivery !== 'digest') {
      suppressed.push(route)
      if (route.delivery !== 'session') appendWorkEvent('project.notification.suppressed', route.group.roadmapId || 'unscoped', eventPayload(route), options.filePath)
      continue
    }
    if (!route.target.provider || !route.target.chatId) {
      suppressed.push({ ...route, delivery: 'session', reason: 'OpenCode session target only' })
      continue
    }
    const channel = channels.get(route.target.provider)
    if (!channel?.sendMessage) {
      suppressed.push({ ...route, delivery: 'deferred', reason: 'channel adapter unavailable' })
      continue
    }
    try {
      const timeoutMs = Math.max(1, options.channelDeliveryTimeoutMs || DEFAULT_CHANNEL_DELIVERY_TIMEOUT_MS)
      recordProjectNotificationAttempt(route, timeoutMs, options)
      await withTimeout(channel.sendMessage(route.target.chatId, route.text.substring(0, 4000), { threadId: route.target.threadId }), timeoutMs, `${route.target.provider} project notification`)
      sent.push(route)
      appendWorkEvent('project.notification.sent', route.dedupeKey, eventPayload(route), options.filePath)
      if (route.delivery === 'digest' && route.target.bindingId) updateProjectBinding(route.target.bindingId, { lastDigestAt: new Date(options.now || Date.now()).toISOString() }, options.filePath)
    } catch (err: any) {
      const error = redactSensitiveText(err?.message || String(err))
      failed.push({ route, error })
      appendWorkEvent('project.notification.failed', route.dedupeKey, { ...eventPayload(route), error }, options.filePath)
      upsertAlert({ key: `project-notification:${route.target.provider}:${targetHash(route.target)}`, severity: 'warning', source: 'project.notifications', target: route.group.roadmapId, summary: `Project notification delivery failed for ${route.group.roadmapTitle}`, evidence: [route.target.provider || 'unknown', error], nextAction: 'Check channel credentials, allowlists, and project notification bindings.' }, {}, options.filePath)
      queueEvent(`Project notification failed for ${route.group.roadmapId || 'unscoped'} via ${route.target.provider}: ${error}`)
    }
  }
  return { routes, sent, failed, suppressed }
}

export function notificationTargetsForProject(group: ProjectAttentionGroup, state: WorkState): ProjectNotificationTarget[] {
  const byKey = new Map<string, ProjectNotificationTarget>()
  const bindings = state.projectBindings.filter(binding => group.roadmapId ? binding.roadmapId === group.roadmapId : !binding.roadmapId)
  for (const binding of bindings) addTarget(byKey, targetFromBinding(binding))
  const supervisor = group.roadmapId ? state.supervisors.find(row => row.roadmapId === group.roadmapId && row.status === 'active' && row.isDefault) || state.supervisors.find(row => row.roadmapId === group.roadmapId && row.status === 'active') : undefined
  if (supervisor) {
    const policy = progressUpdatePolicyForSupervisor(supervisor, state)
    addTarget(byKey, { key: `session:${supervisor.sessionId}`, sessionId: supervisor.sessionId, mode: policy.mode, mutedUntil: policy.mutedUntil, quietHours: policy.quietHours as Record<string, unknown>, lastDigestAt: policy.lastDigestAt, policy })
  }
  return [...byKey.values()].sort((a, b) => Number(Boolean(b.provider)) - Number(Boolean(a.provider)) || a.key.localeCompare(b.key))
}

export function formatProjectAttentionNotification(group: ProjectAttentionGroup, delivery: { delivery: ProjectNotificationDelivery; reason: string }): string {
  const heading = delivery.delivery === 'digest' ? 'Project Digest' : 'Project Attention'
  const lines = [`${heading}: ${group.roadmapTitle}`, `Severity: ${group.severity}${group.roadmapId ? ` · Roadmap: ${group.roadmapId}` : ''}`]
  for (const item of group.items.slice(0, 6)) lines.push(`- [${item.severity}] ${item.title}: ${item.summary}`, `  Action: ${item.action}`)
  if (group.items.length > 6) lines.push(`- ${group.items.length - 6} more item(s) in Gateway Needs Attention.`)
  lines.push('Commands: /project status · /attention · /completion')
  return lines.join('\n')
}

function targetFromBinding(binding: ProjectBindingRecord): ProjectNotificationTarget {
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

function addTarget(targets: Map<string, ProjectNotificationTarget>, target: ProjectNotificationTarget): void {
  if (!targets.has(target.key)) targets.set(target.key, target)
}

function wasRecentlyDelivered(dedupeKey: string, dedupeWindowMs: number, now: number, filePath?: string): boolean {
  const since = new Date(now - dedupeWindowMs)
  return listRecentWorkEvents('project.notification.sent', dedupeKey, since, 100, filePath).length > 0
}

function pendingProjectAttemptRetryAt(dedupeKey: string, dedupeWindowMs: number, now: number, filePath?: string): string | undefined {
  const since = new Date(now - dedupeWindowMs)
  const latest = [
    ...listRecentWorkEvents('project.notification.attempting', dedupeKey, since, 100, filePath),
    ...listRecentWorkEvents('project.notification.sent', dedupeKey, since, 100, filePath),
    ...listRecentWorkEvents('project.notification.failed', dedupeKey, since, 100, filePath),
  ].sort((a, b) => (Date.parse(b.createdAt) - Date.parse(a.createdAt)) || b.id - a.id)[0]
  if (latest?.type !== 'project.notification.attempting') return undefined
  const retryAt = Date.parse(String(latest.payload?.['deferredUntil'] || ''))
  return Number.isFinite(retryAt) && retryAt > now ? new Date(retryAt).toISOString() : undefined
}

function routeDedupeKey(group: ProjectAttentionGroup, target: ProjectNotificationTarget): string {
  return hash([group.roadmapId || 'unscoped', target.key, group.items.map(item => `${item.kind}:${item.id}:${item.severity}`).sort().join('|')].join('\n'))
}

function eventPayload(route: ProjectAttentionRoute): Record<string, unknown> {
  return { dedupeKey: route.dedupeKey, roadmapId: route.group.roadmapId, targetKey: targetHash(route.target), provider: route.target.provider, delivery: route.delivery, reason: route.reason, deferredUntil: route.deferredUntil, suppressedUntil: route.suppressedUntil, escalationBypass: route.escalationBypass, itemCount: route.group.items.length, severity: route.group.severity, mutedUntil: route.target.policy.mutedUntil, quietHours: route.target.policy.quietHours, lastDigestAt: route.target.policy.lastDigestAt }
}

function recordProjectNotificationAttempt(route: ProjectAttentionRoute, timeoutMs: number, options: ProjectAttentionRoutingOptions): void {
  const attemptUntil = new Date((options.now || Date.now()) + timeoutMs).toISOString()
  appendWorkEvent('project.notification.attempting', route.dedupeKey, eventPayload({
    ...route,
    reason: 'delivery attempt in progress',
    deferredUntil: attemptUntil,
  }), options.filePath)
}

function targetHash(target: ProjectNotificationTarget): string {
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
