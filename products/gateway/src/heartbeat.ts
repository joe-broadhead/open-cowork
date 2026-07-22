import { getConfig } from './config.js'
import { canCurrentDaemonWrite, getCurrentDaemonLeadershipStatus } from './daemon-leadership.js'
import { opencodeSessionWebUrl } from './opencode-web.js'
import { schedulerCycleSnapshots } from './scheduler.js'
import { createLogger } from './logger.js'
import type { RunRecord, WorkState } from './work-store.js'
import { getDaemonClient } from './gateway-runtime.js'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

const log = createLogger({ component: 'heartbeat' })

export type HeartbeatRunStatus = 'never' | 'running' | 'ok' | 'error' | 'skipped'

export interface HeartbeatStatus {
  enabled: boolean
  schedulerEnabled: boolean
  intervalMs: number
  running: boolean
  status: HeartbeatRunStatus
  tickCount: number
  skippedTicks: number
  lastStartedAt?: string
  lastCompletedAt?: string
  lastDurationMs?: number
  lastSummary?: string
  lastError?: string
  nextDueAt?: string
  lastSessionId?: string
  lastSessionUrl?: string
  lastSessionLabel?: string
  lastSessionNote?: string
  lastRunId?: string
  lastStage?: string
}

let timerStarted = false
let heartbeatTimer: NodeJS.Timeout | null = null
let heartbeatInFlight: Promise<void> | null = null
let heartbeatStatus: HeartbeatStatus = {
  enabled: false,
  schedulerEnabled: getConfig().scheduler.enabled,
  intervalMs: heartbeatIntervalMs(),
  running: false,
  status: 'never',
  tickCount: 0,
  skippedTicks: 0,
}

/**
 * Floor on the idle-wake delay so a burst of overdue reschedules cannot spin the
 * event loop; real event-driven work never routes through this timer.
 */
const HEARTBEAT_MIN_WAKE_MS = 250

export function startHeartbeat(): NodeJS.Timeout {
  if (heartbeatTimer) return heartbeatTimer
  timerStarted = true
  syncHeartbeatSchedule(Date.now(), true)
  scheduleNextHeartbeatWake()
  return heartbeatTimer!
}

export async function stopHeartbeat(): Promise<void> {
  timerStarted = false
  if (heartbeatTimer) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  if (heartbeatInFlight) await heartbeatInFlight
}

/**
 * Arm a single self-rescheduling timer that sleeps until the next heartbeat is
 * due instead of polling every second (audit #38). Idle wakeups drop from once a
 * second to roughly once per effective interval (10s with the scheduler running,
 * 5min when it is paused). The delay is capped at one interval so a runtime
 * cadence change (scheduler pause/resume) is still picked up within a bounded
 * window, and event-driven wakeups stay instant because they run the scheduler
 * cycle directly from the daemon's OpenCode event subscription, never via this
 * timer.
 */
function scheduleNextHeartbeatWake(now = Date.now()): void {
  if (!timerStarted) return
  syncHeartbeatSchedule(now)
  const intervalMs = heartbeatStatus.intervalMs || heartbeatIntervalMs()
  const nextDue = heartbeatStatus.nextDueAt ? Date.parse(heartbeatStatus.nextDueAt) : now + intervalMs
  const delay = Math.min(intervalMs, Math.max(HEARTBEAT_MIN_WAKE_MS, nextDue - now))
  heartbeatTimer = setTimeout(onHeartbeatWake, delay)
  heartbeatTimer.unref?.()
}

function onHeartbeatWake(): void {
  if (!timerStarted) return
  const now = Date.now()
  syncHeartbeatSchedule(now)
  const nextDue = heartbeatStatus.nextDueAt ? Date.parse(heartbeatStatus.nextDueAt) : 0
  if (!heartbeatStatus.running && now >= nextDue) {
    runHeartbeatTick('timer')
      .catch((err: any) => log.error('Heartbeat tick failed', { error: err?.message || String(err) }))
      .finally(() => scheduleNextHeartbeatWake())
    return
  }
  scheduleNextHeartbeatWake(now)
}

export function getHeartbeatStatus(): HeartbeatStatus {
  syncHeartbeatSchedule(Date.now())
  return {
    ...heartbeatStatus,
    enabled: timerStarted,
    schedulerEnabled: getConfig().scheduler.enabled,
    intervalMs: heartbeatStatus.intervalMs || heartbeatIntervalMs(),
  }
}

export function runHeartbeatNow(client = getDaemonClient(), source = 'manual'): Promise<void> {
  return runHeartbeatTick(source, client)
}

export function clearHeartbeatForTest(): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  timerStarted = false
  heartbeatInFlight = null
  heartbeatStatus = {
    enabled: false,
    schedulerEnabled: getConfig().scheduler.enabled,
    intervalMs: heartbeatIntervalMs(),
    running: false,
    status: 'never',
    tickCount: 0,
    skippedTicks: 0,
  }
}

function runHeartbeatTick(source: string, client = getDaemonClient()): Promise<void> {
  const intervalMs = heartbeatIntervalMs()
  heartbeatStatus = { ...heartbeatStatus, enabled: timerStarted, schedulerEnabled: getConfig().scheduler.enabled, intervalMs }
  if (heartbeatInFlight) {
    heartbeatStatus = {
      ...heartbeatStatus,
      running: true,
      status: 'skipped',
      skippedTicks: heartbeatStatus.skippedTicks + 1,
      lastSummary: `Skipped ${source} heartbeat because the previous heartbeat is still running.`,
    }
    return heartbeatInFlight
  }
  heartbeatInFlight = executeHeartbeat(client, source, intervalMs).finally(() => { heartbeatInFlight = null })
  return heartbeatInFlight
}

async function executeHeartbeat(client: OpencodeClient | undefined, source: string, intervalMs: number): Promise<void> {
  const started = Date.now()
  heartbeatStatus = {
    ...heartbeatStatus,
    enabled: timerStarted,
    schedulerEnabled: getConfig().scheduler.enabled,
    intervalMs,
    running: true,
    status: 'running',
    tickCount: heartbeatStatus.tickCount + 1,
    lastStartedAt: iso(started),
    lastCompletedAt: undefined,
    lastDurationMs: undefined,
    lastError: undefined,
    lastSummary: `Heartbeat ${source} started.`,
  }

  try {
    if (!client) {
      heartbeatStatus = { ...heartbeatStatus, status: 'skipped', lastSummary: 'Skipped heartbeat because the OpenCode client is unavailable.' }
      return
    }
    if (!getConfig().scheduler.enabled) {
      heartbeatStatus = { ...heartbeatStatus, status: 'ok', lastSummary: 'Scheduler disabled; heartbeat checked service health only.' }
      return
    }
    if (!canCurrentDaemonWrite()) {
      const leadership = getCurrentDaemonLeadershipStatus()
      heartbeatStatus = { ...heartbeatStatus, status: 'skipped', lastSummary: `Skipped scheduler heartbeat because this daemon is ${leadership.mode}. ${leadership.remediation}` }
      return
    }
    // Reuse the scheduler cycle's own start/end snapshots instead of
    // materializing the whole work state again for the activity diff.
    const { before, after: state } = await schedulerCycleSnapshots(client)
    const activity = detectHeartbeatActivity(before, state)
    const sessionUrl = activity?.sessionId ? await resolveSessionUrl(client, activity.sessionId) : undefined
    heartbeatStatus = {
      ...heartbeatStatus,
      status: 'ok',
      lastSummary: summarizeState(state, activity),
      ...(activity ? {
        lastSessionId: activity.sessionId,
        lastSessionUrl: sessionUrl || heartbeatStatus.lastSessionUrl,
        lastSessionLabel: activity.label,
        lastSessionNote: activity.note,
        lastRunId: activity.runId,
        lastStage: activity.stage,
      } : {
        lastSessionId: undefined,
        lastSessionUrl: undefined,
        lastSessionLabel: undefined,
        lastSessionNote: undefined,
        lastRunId: undefined,
        lastStage: undefined,
      }),
    }
  } catch (err: any) {
    heartbeatStatus = { ...heartbeatStatus, status: 'error', lastError: err?.message || String(err), lastSummary: `Heartbeat failed: ${err?.message || err}` }
    log.error('Heartbeat failed', { error: err?.message || String(err), lastRunId: heartbeatStatus.lastRunId, correlationId: heartbeatStatus.lastSessionId })
  } finally {
    const nextIntervalMs = heartbeatIntervalMs()
    heartbeatStatus = {
      ...heartbeatStatus,
      running: false,
      schedulerEnabled: getConfig().scheduler.enabled,
      intervalMs: nextIntervalMs,
      nextDueAt: timerStarted ? iso(Date.now() + nextIntervalMs) : heartbeatStatus.nextDueAt,
      lastCompletedAt: iso(Date.now()),
      lastDurationMs: Date.now() - started,
    }
  }
}

function syncHeartbeatSchedule(now = Date.now(), force = false): void {
  const intervalMs = heartbeatIntervalMs()
  const currentDue = heartbeatStatus.nextDueAt ? Date.parse(heartbeatStatus.nextDueAt) : 0
  const intervalChanged = heartbeatStatus.intervalMs !== intervalMs
  const nextDueAt = force || intervalChanged || !Number.isFinite(currentDue) || !heartbeatStatus.nextDueAt
    ? iso(now + intervalMs)
    : heartbeatStatus.nextDueAt
  heartbeatStatus = {
    ...heartbeatStatus,
    enabled: timerStarted,
    schedulerEnabled: getConfig().scheduler.enabled,
    intervalMs,
    nextDueAt,
  }
}

function heartbeatIntervalMs(): number {
  const config = getConfig()
  if (!config.scheduler.enabled) return config.heartbeat.intervalMs
  return Math.max(1000, Math.min(config.heartbeat.intervalMs, config.scheduler.intervalMs))
}

function summarizeState(state: any, activity?: HeartbeatActivity): string {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : []
  const runs = Array.isArray(state?.runs) ? state.runs : []
  const pending = tasks.filter((task: any) => task.status === 'pending').length
  const running = tasks.filter((task: any) => task.status === 'running').length
  const done = tasks.filter((task: any) => task.status === 'done').length
  const blocked = tasks.filter((task: any) => task.status === 'blocked').length
  const activeRuns = runs.filter((run: any) => run.status === 'running').length
  const action = activity ? ` ${activity.note}.` : ' No scheduler session changed this heartbeat.'
  return `Scheduler cycle ok: ${pending} pending, ${running} running, ${done} done, ${blocked} blocked, ${activeRuns} active run${activeRuns === 1 ? '' : 's'}.${action}`
}

interface HeartbeatActivity {
  sessionId: string
  runId: string
  stage: string
  label: string
  note: string
}

function detectHeartbeatActivity(before: WorkState | undefined, after: WorkState): HeartbeatActivity | undefined {
  const beforeRuns = new Map((before?.runs || []).map(run => [run.id, run]))
  const newRun = newest(after.runs.filter(run => !beforeRuns.has(run.id)))
  if (newRun) return activityFromRun(after, newRun, `Dispatched ${newRun.stage}`)

  const completed = newest(after.runs.filter(run => {
    const prior = beforeRuns.get(run.id)
    return prior?.status === 'running' && run.status !== 'running'
  }))
  if (completed) return activityFromRun(after, completed, `Completed ${completed.stage} (${completed.status})`)

  const active = newest(after.runs.filter(run => run.status === 'running'))
  if (active) return activityFromRun(after, active, `Checked active ${active.stage}`)
  const latest = newest(after.runs)
  if (latest) return activityFromRun(after, latest, `Latest scheduler run (${latest.status}); no change this heartbeat`)
  return undefined
}

function activityFromRun(state: WorkState, run: RunRecord, action: string): HeartbeatActivity {
  const task = state.tasks.find(row => row.id === run.taskId)
  const title = task?.title || run.taskId
  return {
    sessionId: run.sessionId,
    runId: run.id,
    stage: run.stage,
    label: `${title} [${run.stage}]`,
    note: `${action}: ${title}`,
  }
}

function newest(runs: RunRecord[]): RunRecord | undefined {
  return [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
}

async function resolveSessionUrl(client: OpencodeClient, sessionId: string): Promise<string | undefined> {
  try {
    const { createOpenCodeSessionRuntime } = await import('./opencode-session-runtime.js')
    const got = await createOpenCodeSessionRuntime(client).getSession(sessionId)
    return got.data ? opencodeSessionWebUrl(getConfig().opencodeUrl, got.data) : undefined
  } catch {
    return undefined
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}
