import * as fs from 'node:fs'
import { buildAnalyticsScorecard } from './analytics.js'
import { getConfig, getConfigDir } from './config.js'
import { getHeartbeatStatus, type HeartbeatStatus } from './heartbeat.js'
import { buildGovernanceReport } from './governance.js'
import { listStorageBackups } from './storage.js'
import { getQueuedEvents, queueEvent } from './wakeup.js'
import { getCurrentDaemonLeadershipStatus, type DaemonLeadershipSnapshot } from './daemon-leadership.js'
import { getRuntimeMetricsSamples, type RuntimeSample } from './runtime-metrics.js'
import { createLogger } from './logger.js'
import {
  listAlerts,
  listChannelBindings,
  listHumanGates,
  listWorkEvents,
  listWorkEnvironments,
  loadWorkState,
  resolveAlertsNotInKeys,
  upsertAlert,
  TERMINAL_WORK_TASK_STATUSES,
  type AlertInput,
  type AlertRecord,
  type WorkState,
} from './work-store.js'
import { listTaskRunCountsAtOrAbove } from './work-store/queries.js'

export interface ObservabilityMetrics {
  generatedAt: string
  scheduler: { enabled: boolean; maxConcurrent: number; intervalMs: number }
  queue: { pending: number; running: number; blocked: number; paused: number; done: number }
  runs: { total: number; running: number; failedLastHour: number; averageRuntimeMs: number }
  environments: { total: number; active: number; retained: number; cleanupFailed: number }
  cost: { totalUsd: number; tokens: number }
  human: { gates: number; questions: number; permissions: number }
  channels: { bindings: number; recentFailures: number }
  opencode: { reachable: boolean | null }
  alerts: { active: number; critical: number; warning: number }
}

export interface AlertEvaluationContext {
  now?: number
  state?: WorkState
  heartbeat?: HeartbeatStatus
  opencodeReachable?: boolean | null
  questions?: any[]
  permissions?: any[]
  leadership?: DaemonLeadershipSnapshot
  runtimeSamples?: RuntimeSample[]
  freeDiskBytes?: number
}

const log = createLogger({ component: 'alerts' })
const ALERT_SOURCE = 'gateway.alerts'
const FAILURE_WINDOW_MS = 60 * 60 * 1000
const FAILURE_THRESHOLD = 3
const ALERT_DEDUPE_MS = 15 * 60 * 1000
const BACKUP_STALE_MS = 24 * 60 * 60 * 1000
// Disk-space thresholds for the Gateway state directory. Probed on the alert
// cadence (not per write) so low disk is a proactive pushed alert rather than a
// surprise at the moment a durable write fails.
const DISK_WARNING_BYTES = 1024 * 1024 * 1024 // 1 GiB
const DISK_CRITICAL_BYTES = 200 * 1024 * 1024 // 200 MiB
// Runtime growth: require a minimum sample count and a clear sustained rise so a
// flat or noisy series does not trip the alert.
const RUNTIME_GROWTH_MIN_SAMPLES = 6
const RUNTIME_GROWTH_RATIO = 1.25
const RUNTIME_GROWTH_ABSOLUTE_BYTES = 64 * 1024 * 1024 // 64 MiB
const EVENT_LOOP_LAG_HIGH_MS = 250
const EVENT_LOOP_LAG_MIN_SAMPLES = 5

export async function runAlertEngine(context: AlertEvaluationContext = {}): Promise<{ active: AlertRecord[]; detected: AlertRecord[]; metrics: ObservabilityMetrics }> {
  const now = context.now || Date.now()
  const state = context.state || loadWorkState()
  const inputs = detectAlerts({ ...context, state, now })
  const activeKeys = new Set(inputs.map(input => input.key))
  const detected: AlertRecord[] = []
  for (const input of inputs) {
    const result = upsertAlert(input, { dedupeMs: ALERT_DEDUPE_MS, now })
    detected.push(result.alert)
    if (result.notify) queueEvent(`ALERT ${result.alert.severity}: ${result.alert.summary}`)
  }
  resolveAlertsNotInKeys(ALERT_SOURCE, activeKeys, undefined, now)
  const active = listAlerts({ status: 'open' })
  return { active, detected, metrics: buildObservabilityMetrics({ ...context, state, now }, active) }
}

export function detectAlerts(context: AlertEvaluationContext): AlertInput[] {
  const now = context.now || Date.now()
  const config = getConfig()
  const state = context.state || loadWorkState()
  const heartbeat = context.heartbeat || getHeartbeatStatus()
  const alerts: AlertInput[] = []

  if (heartbeat.status === 'error') alerts.push(alert('heartbeat:error', 'critical', 'heartbeat', heartbeat.lastSummary || 'Heartbeat is failing', [heartbeat.lastError || 'unknown error'], 'Inspect /readiness and restart Gateway if the error persists.'))
  const completed = Date.parse(heartbeat.lastCompletedAt || '')
  const staleAfter = Math.max(config.heartbeat.intervalMs * 3, config.scheduler.intervalMs * 3, 5 * 60 * 1000)
  if (Number.isFinite(completed) && now - completed > staleAfter) alerts.push(alert('heartbeat:stale', 'warning', 'heartbeat', `Heartbeat stale for ${formatDuration(now - completed)}`, [`lastCompletedAt=${heartbeat.lastCompletedAt}`], 'Check the daemon log and scheduler status.'))

  const staleRunMs = Number(config.governance?.runtime?.staleRunMs || 60 * 60 * 1000)
  for (const run of state.runs.filter(run => run.status === 'running')) {
    const ageMs = now - Date.parse(run.startedAt)
    if (Number.isFinite(ageMs) && ageMs > staleRunMs) alerts.push(alert(`run:stale:${run.id}`, 'warning', 'scheduler', `Run ${run.stage} is stale for ${formatDuration(ageMs)}`, [`run=${run.id}`, `session=${run.sessionId}`], `Inspect session ${run.sessionId}; retry or block task ${run.taskId}.`, run.taskId))
  }

  const recentFailures = state.runs.filter(run => ['failed', 'blocked', 'errored'].includes(run.status) && Date.parse(run.completedAt || run.startedAt) >= now - FAILURE_WINDOW_MS)
  if (recentFailures.length >= FAILURE_THRESHOLD) alerts.push(alert('runs:repeated-failures', 'warning', 'scheduler', `${recentFailures.length} run failure(s) in the last hour`, recentFailures.slice(-5).map(run => `${run.stage}:${run.status}:${run.taskId}`), 'Open the dashboard bottlenecks and inspect recent failed runs.'))
  for (const group of groupedFailures(recentFailures)) {
    if (group.runs.length < 2) continue
    alerts.push(alert(
      `runs:repeated-failures:${group.key}`,
      group.terminal ? 'critical' : 'warning',
      'scheduler',
      `${group.runs.length} repeated ${group.label} failure(s) in ${group.stage}`,
      group.runs.slice(-5).map(run => redactEvidence(`${run.stage}:${run.status}:${run.taskId}:${run.result?.summary || run.result?.feedback || ''}`)),
      group.terminal ? 'Fix provider credentials, quota, or balance before retrying affected tasks.' : 'Inspect the grouped runs and retry only after the repeated failure source is resolved.',
    ))
  }

  const cleanupFailedEnvironments = state.runs.filter(run => run.environment?.status === 'cleanup_failed')
  if (cleanupFailedEnvironments.length) {
    alerts.push(alert(
      'environments:cleanup-failed',
      'warning',
      'environment',
      `${cleanupFailedEnvironments.length} environment cleanup failure(s) require operator action`,
      cleanupFailedEnvironments.slice(-5).map(run => redactEvidence(`${run.environment?.backend}:${run.environment?.name}:${run.environment?.id}:${run.environment?.metadata?.['cleanupError'] || 'cleanup failed'}`)),
      'Inspect gateway_environment_list status=cleanup_failed, then cleanup or release affected environments.',
    ))
  }

  const governance = buildGovernanceReport(state, config, now)
  if (governance.status === 'blocked') alerts.push(alert('governance:blocked', 'critical', 'governance', governance.summary, governance.budgets.filter(row => !row.allowed).map(row => row.reason), 'Raise or reset budgets only after reviewing spend.'))
  else if (governance.status === 'warn') alerts.push(alert('governance:warn', 'warning', 'governance', governance.summary, governance.budgets.filter(row => row.status === 'warn').map(row => row.reason), 'Review spend trend before starting more work.'))

  const backups = safeBackups()
  const latestBackup = backups.map(row => Date.parse(row.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0]
  if (!latestBackup) alerts.push(alert('backup:missing', 'warning', 'storage', 'No Gateway backup has been created', [], 'Run opencode-gateway backup create or gateway_backup_create.'))
  else if (now - latestBackup > BACKUP_STALE_MS) alerts.push(alert('backup:stale', 'warning', 'storage', `Latest Gateway backup is ${formatDuration(now - latestBackup)} old`, [new Date(latestBackup).toISOString()], 'Create and verify a fresh backup.'))

  const channelFailures = getQueuedEvents().filter(event => /channel sync .*failed|send failed|rejected untrusted/i.test(event)).slice(-10)
  if (channelFailures.length >= 3) alerts.push(alert('channels:failures', 'warning', 'channels', `${channelFailures.length} recent channel failure event(s)`, channelFailures, 'Check channel credentials, allowlists, and webhook reachability.'))

  const deniedSecurity = listWorkEvents(100).filter(event => event.type === 'audit.security' && event.payload?.['result'] === 'denied')
  if (deniedSecurity.length) alerts.push(alert('security:denied-operations', 'warning', 'security', `${deniedSecurity.length} denied sensitive operation(s)`, deniedSecurity.slice(-5).map(event => `${event.payload?.['operation'] || 'operation'}:${event.payload?.['source'] || 'source'}`), 'Review security audit events and channel trust policy.'))

  if (context.opencodeReachable === false) alerts.push(alert('opencode:unreachable', 'critical', 'opencode', 'OpenCode is unreachable', [], 'Start OpenCode or update opencodeUrl.'))

  // Leadership / lease stuck: a daemon wedged unable to write while its writer
  // lease is expired/stale, or leadership is unavailable. Healthy multi-daemon
  // standby (a live writer elsewhere, lease not stale) does not fire.
  const leadership = context.leadership || safeLeadershipStatus()
  if (leadership && !leadership.canWrite && (leadership.stale || leadership.mode === 'no_leader' || leadership.mode === 'unavailable')) {
    alerts.push(alert(
      'leadership:lease-stuck',
      'critical',
      'leadership',
      `Gateway daemon is wedged as ${leadership.mode} and cannot acquire the writer lease`,
      [`mode=${leadership.mode}`, `stale=${leadership.stale}`, `leaseExpiresAt=${leadership.leaseExpiresAt || 'none'}`, `takeoverCount=${leadership.takeoverCount}`],
      `${leadership.remediation} Run "opencode-gateway leadership recover" or restart the daemon to re-acquire the writer lease.`,
    ))
  }

  // Disk space: probe free bytes on the state directory before a write fails.
  const freeDiskBytes = context.freeDiskBytes ?? probeStateDirFreeBytes()
  if (freeDiskBytes !== undefined) {
    if (freeDiskBytes < DISK_CRITICAL_BYTES) {
      alerts.push(alert('disk:low-space', 'critical', 'storage', `Critically low free disk on the Gateway state directory (${formatBytes(freeDiskBytes)} free)`, [`freeBytes=${freeDiskBytes}`, `criticalBelow=${DISK_CRITICAL_BYTES}`], 'Free disk space now or move the Gateway state directory; imminent durable writes can fail or corrupt the store.'))
    } else if (freeDiskBytes < DISK_WARNING_BYTES) {
      alerts.push(alert('disk:low-space', 'warning', 'storage', `Low free disk on the Gateway state directory (${formatBytes(freeDiskBytes)} free)`, [`freeBytes=${freeDiskBytes}`, `warnBelow=${DISK_WARNING_BYTES}`], 'Reclaim disk space or relocate the Gateway state directory before free space runs out.'))
    }
  }

  // Profile health (#205): a scheduler profile whose GENUINE completion has
  // degraded — using the #202 error-class split so Gateway session-recovery
  // churn and provider-balance blips (operational/external errored) never fire
  // this. Reads the bounded run-analytics scorecard, never mutates.
  alerts.push(...detectProfileHealthAlerts(config, now))

  // Stuck-task runaway (#203): a single task accumulating an excessive number of
  // runs — the signal that let one dogfood Issue silently reach 81 runs. Warns
  // BEFORE scheduler.maxRunsPerTask hard-blocks the task, and escalates to
  // critical once the cap has blocked it. Reads a bounded indexed aggregate.
  alerts.push(...detectStuckTaskAlerts(state, config))

  // Process runtime growth: sustained RSS growth or sustained high event-loop lag.
  const runtimeSamples = context.runtimeSamples || safeRuntimeSamples()
  const growth = detectRuntimeGrowthSignal(runtimeSamples)
  if (growth.rssGrowth) {
    alerts.push(alert('runtime:memory-growth', 'warning', 'runtime', `Sustained daemon memory growth: RSS rose from ${formatBytes(growth.firstRssBytes)} to ${formatBytes(growth.lastRssBytes)} over ${growth.sampleCount} samples`, [`firstRssBytes=${growth.firstRssBytes}`, `lastRssBytes=${growth.lastRssBytes}`, `samples=${growth.sampleCount}`], 'Capture a heap snapshot to find the leak, then restart the daemon to reclaim memory if growth continues.'))
  }
  if (growth.eventLoopLagHigh) {
    alerts.push(alert('runtime:event-loop-lag', 'warning', 'runtime', `Sustained high event-loop lag (mean ${Math.round(growth.recentLagMs)}ms over ${EVENT_LOOP_LAG_MIN_SAMPLES} samples)`, [`recentLagMs=${Math.round(growth.recentLagMs)}`, `thresholdMs=${EVENT_LOOP_LAG_HIGH_MS}`], 'Investigate blocking synchronous work or overload; reduce scheduler concurrency or restart the daemon if the stall persists.'))
  }

  return alerts
}

function safeLeadershipStatus(): DaemonLeadershipSnapshot | undefined {
  try { return getCurrentDaemonLeadershipStatus() } catch { return undefined }
}

function safeRuntimeSamples(): RuntimeSample[] {
  try { return getRuntimeMetricsSamples() } catch { return [] }
}

/**
 * Proactive per-profile health alerts (#205). Fires for any scheduler profile
 * with at least `minRuns` terminal runs in the window whose GENUINE failure
 * rate exceeds the configured threshold. Genuine failure rate excludes the
 * operational (session-recovery / force-done / lease-expired) and external
 * (provider-balance / transport / provider-error) error cohorts from #202, so
 * this never fires on the dogfood session-recovery churn. Read-only: computed
 * from the bounded run-analytics scorecard, never mutates state.
 */
export function detectProfileHealthAlerts(config = getConfig(), now = Date.now()): AlertInput[] {
  const rule = config.alerts?.profileHealth
  if (!rule?.enabled) return []
  let scorecard
  try {
    scorecard = buildAnalyticsScorecard({ by: 'profile', windowDays: rule.windowDays }, undefined, now)
  } catch (err: any) {
    log.debug('profile-health scorecard read failed', { error: err?.message || String(err) })
    return []
  }
  const alerts: AlertInput[] = []
  for (const row of scorecard.scorecards) {
    if (row.terminal < rule.minRuns) continue
    if (row.genuineFailureRate <= rule.maxGenuineFailureRate) continue
    const ratePct = (row.genuineFailureRate * 100).toFixed(1)
    const thresholdPct = (rule.maxGenuineFailureRate * 100).toFixed(0)
    const severity: AlertInput['severity'] = row.genuineFailureRate >= 0.75 ? 'critical' : 'warning'
    alerts.push(alert(
      `profile-health:${row.key}`,
      severity,
      'analytics',
      `Profile ${row.key} genuine failure rate ${ratePct}% over ${rule.windowDays}d (${row.genuineErrored}/${row.terminal} terminal runs, threshold ${thresholdPct}%)`,
      [
        `profile=${row.key}`,
        `genuineFailureRate=${ratePct}%`,
        `genuineErrored=${row.genuineErrored}`,
        `operationalErrored=${row.operationalErrored}`,
        `externalErrored=${row.externalErrored}`,
        `terminalRuns=${row.terminal}`,
      ],
      `Run "gateway analytics --scorecard --by profile" and inspect the ${row.key} profile: ${row.genuineErrored} genuine failure(s) exclude ${row.operationalErrored} operational + ${row.externalErrored} external errored run(s). Review the profile prompt/model/permissions.`,
    ))
  }
  return alerts
}

/**
 * Stuck-task alert (#203). Fires for any non-terminal task whose cumulative run
 * count has crossed `alerts.stuckTask.runThreshold`, so the operator sees a
 * runaway BEFORE `scheduler.maxRunsPerTask` hard-blocks it. Once the cap has
 * blocked the task its run count still sits at/above the threshold, so the same
 * rule keeps the alert live (escalated to critical) for the blocked case.
 * Runaway runs are usually session-recovery churn worth investigating via the
 * analytics scorecard. Read-only: a single bounded aggregate over runs that
 * excludes terminal tasks in SQL *before* the limit, so a genuinely-stuck live
 * task can never be crowded out of the window by a backlog of terminal tasks.
 */
export function detectStuckTaskAlerts(state: WorkState, config = getConfig()): AlertInput[] {
  const rule = config.alerts?.stuckTask
  if (!rule?.enabled) return []
  const cap = config.scheduler?.maxRunsPerTask ?? Number.POSITIVE_INFINITY
  let rows: Array<{ taskId: string; runCount: number }>
  try {
    rows = listTaskRunCountsAtOrAbove(rule.runThreshold, 50)
  } catch (err: any) {
    log.debug('stuck-task run-count read failed', { error: err?.message || String(err) })
    return []
  }
  const alerts: AlertInput[] = []
  for (const row of rows) {
    const task = state.tasks.find(t => t.id === row.taskId)
    // Terminal tasks are already excluded in SQL; this guards the rare race where
    // a task went terminal between the aggregate read and this state snapshot.
    if (task && TERMINAL_WORK_TASK_STATUSES.includes(task.status)) continue
    const title = task?.title || row.taskId
    const atCap = row.runCount >= cap
    // Wording follows the task's ACTUAL status, not just the count: a task can be
    // at/over the cap for a cycle before the scheduler blocks it (e.g. right after
    // the cap is lowered), so it should not be described as "blocked" until it is.
    const isBlocked = task?.status === 'blocked'
    const severity: AlertInput['severity'] = atCap ? 'critical' : 'warning'
    const summary = atCap
      ? (isBlocked
          ? `Task ${title} is blocked at the run cap (${row.runCount} runs)`
          : `Task ${title} is at/over the run cap (${row.runCount}/${cap} runs)`)
      : `Task ${title} has accumulated ${row.runCount} runs (threshold ${rule.runThreshold})`
    const posture = isBlocked ? 'Task is blocked' : atCap ? 'At/over the run cap' : `Approaching the ${cap}-run cap`
    const nextAction = `${posture}: review task ${row.taskId} (${row.runCount} runs) and cancel it or raise scheduler.maxRunsPerTask. Runaway runs are often session-recovery churn — investigate with "gateway analytics --scorecard".`
    alerts.push(alert(
      `stuck-task:${row.taskId}`,
      severity,
      'scheduler',
      summary,
      [`task=${row.taskId}`, `runCount=${row.runCount}`, `runThreshold=${rule.runThreshold}`, `maxRunsPerTask=${Number.isFinite(cap) ? cap : 'unbounded'}`, `status=${task?.status || 'unknown'}`],
      nextAction,
      row.taskId,
    ))
  }
  return alerts
}

export function probeStateDirFreeBytes(dir = getConfigDir()): number | undefined {
  try {
    const stat = fs.statfsSync(dir)
    const free = Number(stat.bavail) * Number(stat.bsize)
    return Number.isFinite(free) && free >= 0 ? free : undefined
  } catch (err: any) {
    log.debug('disk free-space probe failed', { error: err?.message || String(err) })
    return undefined
  }
}

export interface RuntimeGrowthSignal {
  rssGrowth: boolean
  eventLoopLagHigh: boolean
  firstRssBytes: number
  lastRssBytes: number
  recentLagMs: number
  sampleCount: number
}

export function detectRuntimeGrowthSignal(samples: RuntimeSample[] = []): RuntimeGrowthSignal {
  const empty: RuntimeGrowthSignal = { rssGrowth: false, eventLoopLagHigh: false, firstRssBytes: 0, lastRssBytes: 0, recentLagMs: 0, sampleCount: samples.length }
  if (samples.length < RUNTIME_GROWTH_MIN_SAMPLES) return empty
  const half = Math.floor(samples.length / 2)
  const firstMean = meanOf(samples.slice(0, half).map(s => s.rssBytes))
  const secondMean = meanOf(samples.slice(half).map(s => s.rssBytes))
  const rssGrowth = firstMean > 0 && secondMean > firstMean * RUNTIME_GROWTH_RATIO && secondMean - firstMean > RUNTIME_GROWTH_ABSOLUTE_BYTES
  const recent = samples.slice(-EVENT_LOOP_LAG_MIN_SAMPLES)
  const recentLagMs = meanOf(recent.map(s => s.eventLoopLagMs))
  // Sustained-majority signal: fire when >= 80% of the recent window exceeds the
  // threshold. Requiring EVERY sample lets a single brief recovery window reset the
  // streak, so a genuinely degraded bursty loop (e.g. 400/100 oscillation) never
  // alerts; a lone transient spike still stays below the majority and does not fire.
  const highCount = recent.filter(s => s.eventLoopLagMs > EVENT_LOOP_LAG_HIGH_MS).length
  const eventLoopLagHigh = recent.length >= EVENT_LOOP_LAG_MIN_SAMPLES && highCount >= Math.ceil(recent.length * 0.8)
  return {
    rssGrowth,
    eventLoopLagHigh,
    firstRssBytes: Math.round(samples[0]!.rssBytes),
    lastRssBytes: Math.round(samples[samples.length - 1]!.rssBytes),
    recentLagMs,
    sampleCount: samples.length,
  }
}

function meanOf(values: number[]): number {
  const valid = values.filter(value => Number.isFinite(value))
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function buildObservabilityMetrics(context: AlertEvaluationContext = {}, activeAlerts = listAlerts({ status: 'open' })): ObservabilityMetrics {
  const now = context.now || Date.now()
  const config = getConfig()
  const state = context.state || loadWorkState()
  const completedRuns = state.runs.filter(run => run.completedAt && run.runtimeMs)
  const failedLastHour = state.runs.filter(run => ['failed', 'blocked', 'errored'].includes(run.status) && Date.parse(run.completedAt || run.startedAt) >= now - FAILURE_WINDOW_MS).length
  const costUsd = state.runs.reduce((sum, run) => sum + Number(run.costUsd || 0), 0)
  const tokens = state.runs.reduce((sum, run) => sum + Number(run.inputTokens || 0) + Number(run.outputTokens || 0) + Number(run.reasoningTokens || 0) + Number(run.cacheReadTokens || 0) + Number(run.cacheWriteTokens || 0), 0)
  const channelFailures = getQueuedEvents().filter(event => /channel sync .*failed|send failed|rejected untrusted/i.test(event)).length
  const environments = state.runs.map(run => run.environment).filter(Boolean)
  return {
    generatedAt: new Date(now).toISOString(),
    scheduler: { enabled: config.scheduler.enabled, maxConcurrent: config.scheduler.maxConcurrent, intervalMs: config.scheduler.intervalMs },
    queue: {
      pending: state.tasks.filter(task => task.status === 'pending').length,
      running: state.tasks.filter(task => task.status === 'running').length,
      blocked: state.tasks.filter(task => task.status === 'blocked').length,
      paused: state.tasks.filter(task => task.status === 'paused').length,
      done: state.tasks.filter(task => task.status === 'done').length,
    },
    runs: { total: state.runs.length, running: state.runs.filter(run => run.status === 'running').length, failedLastHour, averageRuntimeMs: average(completedRuns.map(run => Number(run.runtimeMs || 0))) },
    environments: {
      total: environments.length,
      active: environments.filter(environment => environment?.status === 'prepared' || environment?.status === 'blocked').length,
      retained: environments.filter(environment => environment?.status === 'retained').length,
      cleanupFailed: environments.filter(environment => environment?.status === 'cleanup_failed').length,
    },
    cost: { totalUsd: costUsd, tokens },
    human: { gates: listHumanGates({ status: 'open' }).length, questions: (context.questions || []).length, permissions: (context.permissions || []).length },
    channels: { bindings: listChannelBindings().length, recentFailures: channelFailures },
    opencode: { reachable: context.opencodeReachable === undefined ? null : context.opencodeReachable },
    alerts: { active: activeAlerts.length, critical: activeAlerts.filter(alert => alert.severity === 'critical').length, warning: activeAlerts.filter(alert => alert.severity === 'warning').length },
  }
}

export function formatAlerts(alerts: AlertRecord[]): string {
  if (!alerts.length) return 'No active Gateway alerts.'
  return alerts.slice(0, 12).map(alert => `[${alert.severity}/${alert.status}] ${alert.summary} (${alert.id})\nAction: ${alert.nextAction}`).join('\n\n')
}

export function generateIncidentReport(alertId?: string): string {
  const alerts = alertId ? listAlerts().filter(alert => alert.id === alertId) : listAlerts().slice(0, 20)
  const events = listWorkEvents(200)
  const environments = listWorkEnvironments()
  const lines = ['# Gateway Incident Report', '', `Generated: ${new Date().toISOString()}`, '']
  lines.push('## Alerts', '')
  lines.push(alerts.length ? alerts.map(alert => `- [${alert.severity}/${alert.status}] ${alert.summary} (${alert.id}) key=${alert.key}`).join('\n') : 'No alerts selected.')
  lines.push('', '## Environments', '')
  lines.push(`- ${environments.filter(environment => environment.status === 'prepared' || environment.status === 'blocked').length} active environment(s)`)
  lines.push(`- ${environments.filter(environment => environment.status === 'retained').length} retained environment(s)`)
  lines.push(`- ${environments.filter(environment => environment.status === 'cleanup_failed').length} cleanup failed environment(s)`)
  for (const environment of environments.filter(environment => environment.status === 'retained' || environment.status === 'cleanup_failed').slice(-10)) {
    lines.push(`- [${environment.status}] ${environment.backend}/${environment.name} ${environment.id} run=${environment.runId} cleanup=${environment.cleanup.state}`)
  }
  lines.push('', '## Timeline', '')
  for (const event of events.slice(-30)) lines.push(`- ${event.createdAt} ${event.type}${event.subjectId ? ` ${event.subjectId}` : ''}`)
  lines.push('', '## Root Cause Hints', '')
  lines.push(...rootCauseHints(alerts))
  lines.push('', '## Follow-Ups', '')
  lines.push('- Confirm alerts are acknowledged or resolved.')
  lines.push('- Create durable follow-up tasks for unresolved root causes.')
  lines.push('- Attach relevant evidence from runs, logs, and channel failures.')
  return lines.join('\n')
}

function alert(key: string, severity: AlertInput['severity'], source: string, summary: string, evidence: string[], nextAction: string, target?: string): AlertInput {
  return { key, severity, source: ALERT_SOURCE, target: target || source, summary, evidence, nextAction, details: { rule: source } }
}

function safeBackups(): Array<{ createdAt: string }> {
  try { return listStorageBackups() } catch { return [] }
}

function rootCauseHints(alerts: AlertRecord[]): string[] {
  const hints = new Set<string>()
  for (const alert of alerts) {
    if (alert.key.includes('heartbeat')) hints.add('- Heartbeat alerts usually indicate daemon stalls, scheduler hangs, or OpenCode reachability issues.')
    if (alert.key.includes('failures')) hints.add('- Repeated failures usually indicate unclear specs, missing credentials, flaky tests, or broken stage contracts.')
    if (alert.key.includes('governance')) hints.add('- Governance alerts require budget review before increasing limits.')
    if (alert.key.includes('backup')) hints.add('- Backup alerts require a fresh verified backup and restore drill follow-up if stale for long periods.')
    if (alert.key.includes('channels')) hints.add('- Channel alerts usually involve token, webhook, or allowlist configuration.')
    if (alert.key.includes('environment')) hints.add('- Environment alerts usually require inspecting retained leases, cleanup errors, backend CLI availability, or provider state before retrying affected work.')
    if (alert.key.includes('profile-health')) hints.add('- Profile-health alerts flag a profile whose GENUINE failure rate degraded (operational session-recovery and external provider errors are already excluded). Inspect `gateway analytics --scorecard --by profile` and review the profile prompt, model, and permissions.')
    if (alert.key.includes('stuck-task')) hints.add('- Stuck-task alerts flag one task accumulating excessive runs (a runaway heading for the scheduler.maxRunsPerTask cap). Usually session-recovery churn re-creating runs — inspect `gateway analytics --scorecard`, then cancel the task or raise the cap.')
  }
  return hints.size ? [...hints] : ['- No automated root cause hints available. Inspect timeline and related task/run evidence.']
}

function groupedFailures(runs: WorkState['runs']): Array<{ key: string; label: string; stage: string; terminal: boolean; runs: WorkState['runs'] }> {
  const groups = new Map<string, { key: string; label: string; stage: string; terminal: boolean; runs: WorkState['runs'] }>()
  for (const run of runs) {
    const classification = failureGroupForRun(run)
    const key = `${run.stage}:${classification.key}`
    const existing = groups.get(key) || { key, label: classification.label, stage: run.stage, terminal: classification.terminal, runs: [] }
    existing.runs.push(run)
    groups.set(key, existing)
  }
  return [...groups.values()]
}

function failureGroupForRun(run: WorkState['runs'][number]): { key: string; label: string; terminal: boolean } {
  const text = `${run.result?.failureClass || ''} ${run.result?.summary || ''} ${run.result?.feedback || ''}`.toLowerCase()
  if (/insufficient balance|billing|payment required|no credits|402/.test(text)) return { key: 'provider_balance', label: 'provider balance', terminal: true }
  if (/unauthorized|forbidden|invalid api key|invalid token|authentication|401|403/.test(text)) return { key: 'provider_auth', label: 'provider auth', terminal: true }
  if (/quota exceeded|rate limit|too many requests|429/.test(text)) return { key: 'provider_quota', label: 'provider quota', terminal: true }
  if (/fetch failed|timeout|timed out|network|transport|socket|503|502|504/.test(text)) return { key: 'transport', label: 'transport', terminal: false }
  return { key: run.result?.failureClass || run.status, label: run.result?.failureClass || run.status, terminal: false }
}

function redactEvidence(value: string): string {
  return value
    .replace(/([A-Za-z0-9_]*token[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9_]*key[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
    .substring(0, 1000)
}

function average(values: number[]): number {
  const valid = values.filter(value => Number.isFinite(value) && value >= 0)
  return valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : 0
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}
