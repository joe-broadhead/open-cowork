import type { HeartbeatStatus } from './heartbeat.js'
import type { MissionChannelSummary } from './mission-data.js'
import type { ServiceHealthReport } from './service-health.js'
import type { StorageBackupSummary, StorageRecoveryDrillSummary } from './storage.js'

export type AlphaHealthIndicatorStatus = 'ok' | 'warning' | 'blocked' | 'unknown'
export type AlphaHealthStatus = 'healthy' | 'attention' | 'blocked' | 'not_proven'

export interface AlphaHealthIndicator {
  id: 'service_health' | 'scheduler_recovery' | 'channel_delivery' | 'open_gates' | 'eval_scorecards' | 'backup_restore' | 'alpha_blockers'
  label: string
  status: AlphaHealthIndicatorStatus
  summary: string
  detail: string
  source: string
  updatedAt?: string
  count?: number
  items: Array<{ label: string; status: AlphaHealthIndicatorStatus; detail?: string; source?: string; updatedAt?: string }>
}

export interface AlphaHealthSummary {
  status: AlphaHealthStatus
  alphaHealthy: boolean | null
  generatedAt: string
  headline: string
  summary: string
  indicators: AlphaHealthIndicator[]
  blockers: AlphaHealthIndicator['items']
  recent: {
    scorecards: any[]
    backups: StorageBackupSummary[]
    recoveryDrills: StorageRecoveryDrillSummary[]
  }
  sources: Array<{ label: string; source: string; available: boolean; count: number }>
}

export interface BuildAlphaHealthSummaryInput {
  now?: Date
  serviceHealth?: ServiceHealthReport
  readiness?: any
  heartbeat?: HeartbeatStatus
  scheduler?: any
  channels?: MissionChannelSummary
  humanGates?: any[]
  questions?: any[]
  permissions?: any[]
  requestSourceAvailable?: boolean
  completionProposals?: any[]
  promotionScorecards?: any[]
  backups?: StorageBackupSummary[]
  recoveryDrills?: StorageRecoveryDrillSummary[]
  runs?: any[]
  tasks?: any[]
  supervisors?: any[]
  alerts?: any[]
}

const RECENT_BACKUP_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_DRILL_MS = 14 * 24 * 60 * 60 * 1000
const RECENT_SCORECARD_MS = 7 * 24 * 60 * 60 * 1000

export function buildAlphaHealthSummary(input: BuildAlphaHealthSummaryInput = {}): AlphaHealthSummary {
  const now = input.now || new Date()
  const scorecards = sortByTime(input.promotionScorecards || [], row => row.updatedAt || row.createdAt)
  const recentScorecards = scorecards.slice(0, 5)
  const backups = sortByTime(input.backups || [], row => row.createdAt).slice(0, 5)
  const recoveryDrills = sortByTime(input.recoveryDrills || [], row => row.completedAt || row.startedAt).slice(0, 5)
  const blockers = alphaBlockers(input, scorecards, recoveryDrills)
  const indicators = [
    serviceHealthIndicator(input.serviceHealth, input.readiness),
    schedulerRecoveryIndicator(input, recoveryDrills, now),
    channelDeliveryIndicator(input.channels),
    openGateIndicator(input),
    evalScorecardIndicator(scorecards, now),
    backupRestoreIndicator(backups, recoveryDrills, now),
    blockerIndicator(blockers),
  ]
  const hasBlocked = indicators.some(indicator => indicator.status === 'blocked') || blockers.length > 0
  const hasUnknown = indicators.some(indicator => indicator.status === 'unknown')
  const hasWarning = indicators.some(indicator => indicator.status === 'warning')
  const status: AlphaHealthStatus = hasBlocked ? 'blocked' : hasUnknown ? 'not_proven' : hasWarning ? 'attention' : 'healthy'
  return {
    status,
    alphaHealthy: status === 'healthy' ? true : status === 'not_proven' ? null : false,
    generatedAt: now.toISOString(),
    headline: alphaHeadline(status),
    summary: alphaSummary(status, indicators, blockers),
    indicators,
    blockers,
    recent: { scorecards: recentScorecards, backups, recoveryDrills },
    sources: [
      { label: 'Gateway runs', source: '/runs', available: Array.isArray(input.runs), count: (input.runs || []).length },
      { label: 'Service health', source: '/gateway/health', available: Boolean(input.serviceHealth), count: input.serviceHealth?.components?.length || 0 },
      { label: 'Channels', source: '/channels/bindings and channel-sync state', available: Boolean(input.channels), count: input.channels?.links?.length || 0 },
      { label: 'Gates and requests', source: '/human-gates and /opencode/requests', available: input.requestSourceAvailable !== false && (Array.isArray(input.humanGates) || Array.isArray(input.questions) || Array.isArray(input.permissions)), count: openGateCount(input) },
      { label: 'Scorecards', source: 'promotion_scorecards', available: Array.isArray(input.promotionScorecards), count: scorecards.length },
      { label: 'Backups', source: 'state/backups/*/metadata.json', available: Array.isArray(input.backups), count: backups.length },
      { label: 'Recovery drills', source: 'state/recovery-drills/*/evidence.json', available: Array.isArray(input.recoveryDrills), count: recoveryDrills.length },
    ],
  }
}

function serviceHealthIndicator(report?: ServiceHealthReport, readiness?: any): AlphaHealthIndicator {
  if (!report) return indicator('service_health', 'Service Health', 'unknown', 'Service health report is unavailable.', 'Gateway can still show durable records, but daemon component health was not loaded.', '/gateway/health', [])
  const readinessStatus: AlphaHealthIndicatorStatus | undefined = readiness?.state === 'not_ready' ? 'blocked' : readiness?.state === 'degraded' ? 'warning' : readiness?.state ? 'ok' : undefined
  const readinessState = readiness?.state ? ` Readiness: ${readiness.state}.` : ''
  const items: AlphaHealthIndicator['items'] = [
    ...(report.components || []).map(component => ({ label: component.label, status: component.status === 'ok' ? 'ok' as const : component.status === 'down' ? 'blocked' as const : 'warning' as const, detail: component.summary, source: '/gateway/health' })),
    ...(readinessStatus ? [{ label: 'Readiness', status: readinessStatus, detail: readiness.summary || readiness.state, source: '/readiness' }] : []),
  ]
  const fallbackStatus: AlphaHealthIndicatorStatus = report.status === 'ok' ? 'ok' : report.status === 'down' ? 'blocked' : 'warning'
  const status = strongestStatus(items.length ? items : [{ label: 'Service health', status: fallbackStatus, source: '/gateway/health' }])
  return indicator('service_health', 'Service Health', status, report.summary || 'Service health loaded.', `${report.components?.length || 0} daemon, storage, scheduler, channel, OpenCode, and config checks.${readinessState}`, '/gateway/health', items, report.generatedAt, report.attention?.length || 0)
}

function schedulerRecoveryIndicator(input: BuildAlphaHealthSummaryInput, drills: StorageRecoveryDrillSummary[], now: Date): AlphaHealthIndicator {
  const scheduler = input.scheduler || {}
  const heartbeat = input.heartbeat
  const duplicateRuns = duplicateActiveRunTaskIds(input.runs || [])
  const supervisors = input.supervisors || []
  const staleSupervisors = supervisors.filter(row => ['stale', 'blocked'].includes(String(row.health || row.status)))
  const latestDrill = drills[0]
  const items: AlphaHealthIndicator['items'] = [
    { label: 'Scheduler', status: scheduler.enabled === false ? 'blocked' : 'ok', detail: scheduler.enabled === false ? 'Scheduler is disabled.' : 'Scheduler is enabled.', source: '/gateway/health' },
    { label: 'Heartbeat', status: heartbeatStatus(heartbeat), detail: heartbeat?.lastSummary || heartbeat?.status || 'Heartbeat unavailable.', source: '/gateway/health', updatedAt: heartbeat?.lastCompletedAt },
    { label: 'Duplicate active runs', status: duplicateRuns.length ? 'blocked' : 'ok', detail: duplicateRuns.length ? duplicateRuns.join(', ') : 'No duplicate active runs detected in durable run records.', source: '/runs' },
    { label: 'Supervisor recovery', status: staleSupervisors.length ? 'warning' : 'ok', detail: staleSupervisors.length ? `${staleSupervisors.length} supervisors are stale or blocked.` : 'No stale supervisor rows in the current summary.', source: '/roadmap-supervisors' },
  ]
  if (latestDrill) items.push({ label: 'Latest recovery drill', status: latestDrill.status === 'pass' ? staleStatus(latestDrill.completedAt, now, RECENT_DRILL_MS) : 'blocked', detail: latestDrill.status === 'pass' ? latestDrill.id : latestDrill.error || latestDrill.id, source: latestDrill.evidencePath || latestDrill.path, updatedAt: latestDrill.completedAt })
  const status = strongestStatus(items)
  return indicator('scheduler_recovery', 'Scheduler And Recovery', status, status === 'ok' ? 'Scheduler and recovery evidence look usable.' : 'Scheduler or recovery evidence needs attention.', `${duplicateRuns.length} duplicate active-run task IDs; ${staleSupervisors.length} stale/blocked supervisors.`, '/gateway/health, /runs, recovery-drills', items, heartbeat?.lastCompletedAt || latestDrill?.completedAt, duplicateRuns.length + staleSupervisors.length)
}

function channelDeliveryIndicator(channels?: MissionChannelSummary): AlphaHealthIndicator {
  if (!channels) return indicator('channel_delivery', 'Channel Delivery', 'unknown', 'Channel summary is unavailable.', 'No channel delivery assumptions are made without the channel binding and sync summaries.', '/channels/bindings', [])
  const providerItems = channels.providers.map(provider => ({ label: provider.provider, status: provider.health === 'ok' ? 'ok' as const : provider.health === 'down' && !provider.configured ? 'unknown' as const : provider.health === 'down' ? 'blocked' as const : 'warning' as const, detail: provider.note, source: '/channels/bindings' }))
  const syncStatus: AlphaHealthIndicatorStatus = !channels.sync.syncEnabled ? 'warning' : channels.sync.pendingInbound > 0 ? 'warning' : 'ok'
  const syncItem = { label: 'Delivery sync', status: syncStatus, detail: `${channels.sync.deliveriesTracked} checkpoints, ${channels.sync.pendingInbound} pending inbound.`, source: 'channel-sync state', updatedAt: channels.sync.lastSyncAt }
  const items = [...providerItems, syncItem]
  const enabledProviders = channels.providers.filter(provider => provider.enabled).length
  const configuredProviderItems = providerItems.filter((_, index) => channels.providers[index]?.configured || channels.providers[index]?.enabled)
  const status = enabledProviders ? strongestStatus([...configuredProviderItems, syncItem]) : 'unknown'
  return indicator('channel_delivery', 'Channel Delivery', status, enabledProviders ? 'At least one trusted channel adapter is enabled.' : 'No trusted channel adapter is enabled yet.', `${enabledProviders}/${channels.providers.length} adapters enabled; ${channels.links.length} channel links mirrored.`, '/channels/bindings and channel-sync state', items, channels.sync.lastSyncAt, channels.sync.pendingInbound)
}

function openGateIndicator(input: BuildAlphaHealthSummaryInput): AlphaHealthIndicator {
  const humanGates = (input.humanGates || []).filter(gate => ['pending', 'escalated'].includes(String(gate.status || 'pending')))
  const questions = input.questions || []
  const permissions = input.permissions || []
  const proposals = (input.completionProposals || []).filter(proposal => proposal.status === 'pending')
  const count = humanGates.length + questions.length + permissions.length + proposals.length
  const requestUnavailable = input.requestSourceAvailable === false
  const items = [
    ...humanGates.slice(0, 4).map(gate => ({ label: gate.reason || gate.id, status: 'warning' as const, detail: gate.scopeKey || gate.type, source: '/human-gates', updatedAt: gate.updatedAt || gate.requestedAt })),
    ...questions.slice(0, 3).map(question => ({ label: question.id || 'OpenCode question', status: 'warning' as const, detail: question.sessionID, source: '/opencode/requests' })),
    ...permissions.slice(0, 3).map(permission => ({ label: permission.id || 'OpenCode permission', status: 'warning' as const, detail: permission.sessionID, source: '/opencode/requests' })),
    ...proposals.slice(0, 3).map(proposal => ({ label: proposal.recommendation || proposal.id, status: 'warning' as const, detail: proposal.roadmapId, source: '/roadmap-completion-proposals', updatedAt: proposal.updatedAt })),
    ...(requestUnavailable ? [{ label: 'OpenCode requests', status: 'unknown' as const, detail: 'Question and permission polling did not load.', source: '/opencode/requests' }] : []),
  ]
  const status: AlphaHealthIndicatorStatus = requestUnavailable ? 'unknown' : count ? 'warning' : 'ok'
  return indicator('open_gates', 'Open Gates', status, requestUnavailable ? 'OpenCode request source is unavailable.' : count ? `${count} operator decision${count === 1 ? '' : 's'} open.` : 'No Gateway or OpenCode decisions are waiting.', 'Includes Gateway human gates, OpenCode questions/permissions, and completion proposals.', '/human-gates and /opencode/requests', items, newestTime(items), count)
}

function evalScorecardIndicator(scorecards: any[], now: Date): AlphaHealthIndicator {
  if (!scorecards.length) return indicator('eval_scorecards', 'Eval Scorecards', 'unknown', 'No eval scorecards have been recorded yet.', 'Promotion and Arena evidence will appear here after gateway_promotion_scorecard_* writes durable scorecards.', 'promotion_scorecards', [])
  const blocked = scorecards.filter(scorecardBlocksAlpha)
  const warning = scorecards.filter(scorecard => scorecard.status === 'draft' || scorecard.recommendation === 'hold' || staleStatus(scorecard.updatedAt || scorecard.createdAt, now, RECENT_SCORECARD_MS) !== 'ok')
  const items = scorecards.map(scorecard => ({ label: `${scorecard.subjectKind || 'subject'}:${scorecard.subjectName || scorecard.id}`, status: blocked.includes(scorecard) ? 'blocked' as const : warning.includes(scorecard) ? 'warning' as const : 'ok' as const, detail: `${scorecard.sourceKind || 'scorecard'}:${scorecard.sourceId || '?'} / ${scorecard.recommendation || scorecard.status || '?'}${staleStatus(scorecard.updatedAt || scorecard.createdAt, now, RECENT_SCORECARD_MS) !== 'ok' ? ' / stale evidence' : ''}`, source: 'promotion_scorecards', updatedAt: scorecard.updatedAt || scorecard.createdAt }))
  const status: AlphaHealthIndicatorStatus = blocked.length ? 'blocked' : warning.length ? 'warning' : 'ok'
  return indicator('eval_scorecards', 'Eval Scorecards', status, blocked.length ? `${blocked.length} scorecard${blocked.length === 1 ? '' : 's'} block promotion.` : warning.length ? 'One or more scorecards need refresh before alpha can be called healthy.' : 'Durable scorecards do not block alpha.', `${scorecards.length} profile/team scorecards from durable promotion evidence.`, 'promotion_scorecards', items, newestTime(items), scorecards.length)
}

function backupRestoreIndicator(backups: StorageBackupSummary[], drills: StorageRecoveryDrillSummary[], now: Date): AlphaHealthIndicator {
  const latestBackup = backups[0]
  const latestDrill = drills[0]
  const items: AlphaHealthIndicator['items'] = []
  if (latestBackup) items.push({ label: 'Latest backup', status: latestBackup.ok === false ? 'blocked' : staleStatus(latestBackup.createdAt, now, RECENT_BACKUP_MS), detail: `${latestBackup.id} / ${latestBackup.ok === false ? (latestBackup.errors || []).join('; ') : 'verified metadata loaded'}`, source: latestBackup.path, updatedAt: latestBackup.createdAt })
  else items.push({ label: 'Latest backup', status: 'unknown', detail: 'No Gateway backup metadata found.', source: 'state/backups/*/metadata.json' })
  if (latestDrill) items.push({ label: 'Latest recovery drill', status: latestDrill.status === 'pass' ? staleStatus(latestDrill.completedAt, now, RECENT_DRILL_MS) : 'blocked', detail: latestDrill.status === 'pass' ? latestDrill.id : latestDrill.error || latestDrill.id, source: latestDrill.evidencePath || latestDrill.path, updatedAt: latestDrill.completedAt })
  else items.push({ label: 'Latest recovery drill', status: 'unknown', detail: 'No recovery drill evidence found.', source: 'state/recovery-drills/*/evidence.json' })
  const status = strongestStatus(items)
  return indicator('backup_restore', 'Backup And Restore Drill', status, status === 'ok' ? 'Recent backup and recovery drill evidence are present.' : 'Backup or restore drill evidence needs attention.', 'Uses backup metadata verification and recovery drill evidence files.', 'state/backups and state/recovery-drills', items, newestTime(items), items.filter(item => item.status !== 'ok').length)
}

function blockerIndicator(blockers: AlphaHealthIndicator['items']): AlphaHealthIndicator {
  return indicator('alpha_blockers', 'Unresolved Alpha Blockers', blockers.length ? 'blocked' : 'ok', blockers.length ? `${blockers.length} unresolved alpha blocker${blockers.length === 1 ? '' : 's'} found.` : 'No unresolved alpha blockers found in durable evidence.', 'Critical alerts, blocked Issues, failed drills, blocking scorecards, and duplicate active runs.', 'alerts, tasks, drills, scorecards, runs', blockers.slice(0, 8), newestTime(blockers), blockers.length)
}

function alphaBlockers(input: BuildAlphaHealthSummaryInput, scorecards: any[], drills: StorageRecoveryDrillSummary[]): AlphaHealthIndicator['items'] {
  const rows: AlphaHealthIndicator['items'] = []
  for (const alert of (input.alerts || []).filter(alert => (alert.status === 'active' || !alert.status) && alert.severity === 'critical')) rows.push({ label: alert.summary || alert.key || alert.id, status: 'blocked', detail: alert.nextAction, source: '/alerts', updatedAt: alert.lastSeenAt || alert.updatedAt })
  for (const task of (input.tasks || []).filter(task => task.status === 'blocked' || task.status === 'paused').slice(0, 8)) rows.push({ label: task.title || task.id, status: 'blocked', detail: `${task.status} ${task.readiness?.reason || ''}`.trim(), source: '/tasks', updatedAt: task.updatedAt })
  if (input.serviceHealth?.status === 'down') rows.push({ label: 'Service health is down', status: 'blocked', detail: input.serviceHealth.summary, source: '/gateway/health', updatedAt: input.serviceHealth.generatedAt })
  for (const scorecard of scorecards.filter(scorecardBlocksAlpha).slice(0, 4)) rows.push({ label: `Scorecard blocks ${scorecard.subjectKind || 'subject'}:${scorecard.subjectName || scorecard.id}`, status: 'blocked', detail: scorecard.conclusion || failedThresholdSummary(scorecard) || scorecard.sourceId, source: 'promotion_scorecards', updatedAt: scorecard.updatedAt || scorecard.createdAt })
  if (drills[0]?.status === 'fail') rows.push({ label: 'Latest recovery drill failed', status: 'blocked', detail: drills[0].error || drills[0].id, source: drills[0].evidencePath || drills[0].path, updatedAt: drills[0].completedAt })
  for (const taskId of duplicateActiveRunTaskIds(input.runs || [])) rows.push({ label: `Duplicate active runs for ${taskId}`, status: 'blocked', detail: 'More than one active run exists for one task.', source: '/runs' })
  return rows
}

function indicator(id: AlphaHealthIndicator['id'], label: string, status: AlphaHealthIndicatorStatus, summary: string, detail: string, source: string, items: AlphaHealthIndicator['items'], updatedAt?: string, count?: number): AlphaHealthIndicator {
  return { id, label, status, summary, detail, source, updatedAt, count, items }
}

function heartbeatStatus(heartbeat?: HeartbeatStatus): AlphaHealthIndicatorStatus {
  if (!heartbeat) return 'unknown'
  if (!heartbeat.schedulerEnabled) return 'blocked'
  if (heartbeat.status === 'error') return 'blocked'
  if (heartbeat.status === 'never') return 'warning'
  return 'ok'
}

function staleStatus(timestamp: string | undefined, now: Date, limitMs: number): AlphaHealthIndicatorStatus {
  if (!timestamp) return 'unknown'
  const age = ageMs(timestamp, now)
  if (!Number.isFinite(age)) return 'unknown'
  return age > limitMs ? 'warning' : 'ok'
}

function ageMs(timestamp: string | undefined, now: Date): number {
  const time = Date.parse(timestamp || '')
  return Number.isFinite(time) ? now.getTime() - time : Number.POSITIVE_INFINITY
}

function strongestStatus(items: AlphaHealthIndicator['items']): AlphaHealthIndicatorStatus {
  if (items.some(item => item.status === 'blocked')) return 'blocked'
  if (items.some(item => item.status === 'warning')) return 'warning'
  if (items.some(item => item.status === 'unknown')) return 'unknown'
  return 'ok'
}

function sortByTime<T>(rows: T[], time: (row: T) => string | undefined): T[] {
  return [...rows].sort((a, b) => Date.parse(time(b) || '') - Date.parse(time(a) || ''))
}

function duplicateActiveRunTaskIds(runs: any[]): string[] {
  const active = new Map<string, number>()
  for (const run of runs) {
    if (!run?.taskId || !['running', 'leased'].includes(String(run.status))) continue
    active.set(run.taskId, (active.get(run.taskId) || 0) + 1)
  }
  return [...active.entries()].filter(([, count]) => count > 1).map(([taskId]) => taskId)
}

function scorecardBlocksAlpha(scorecard: any): boolean {
  return scorecard.status === 'blocked' || scorecard.recommendation === 'block' || (scorecard.thresholds || []).some((threshold: any) => threshold.passed === false)
}

function failedThresholdSummary(scorecard: any): string | undefined {
  const failed = (scorecard.thresholds || []).filter((threshold: any) => threshold.passed === false).map((threshold: any) => threshold.id || threshold.name).filter(Boolean)
  return failed.length ? `Failed thresholds: ${failed.join(', ')}` : undefined
}

function openGateCount(input: BuildAlphaHealthSummaryInput): number {
  return (input.humanGates || []).filter(gate => ['pending', 'escalated'].includes(String(gate.status || 'pending'))).length +
    (input.questions || []).length +
    (input.permissions || []).length +
    (input.completionProposals || []).filter(proposal => proposal.status === 'pending').length
}

function newestTime(items: AlphaHealthIndicator['items']): string | undefined {
  return items.map(item => item.updatedAt).filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
}

function alphaHeadline(status: AlphaHealthStatus): string {
  if (status === 'healthy') return 'Alpha healthy'
  if (status === 'blocked') return 'Alpha blocked'
  if (status === 'attention') return 'Alpha needs attention'
  return 'Alpha health is not proven yet'
}

function alphaSummary(status: AlphaHealthStatus, indicators: AlphaHealthIndicator[], blockers: AlphaHealthIndicator['items']): string {
  if (status === 'healthy') return 'Current durable evidence says the private-alpha build is healthy.'
  if (status === 'blocked') return `${blockers.length || indicators.filter(indicator => indicator.status === 'blocked').length} blocking signal${(blockers.length || indicators.filter(indicator => indicator.status === 'blocked').length) === 1 ? '' : 's'} need resolution before calling this build alpha-healthy.`
  if (status === 'attention') return 'No hard blocker is visible, but one or more health indicators need operator attention.'
  return 'The dashboard has enough first-run context to show setup gaps, but durable operational evidence is still missing.'
}
