/**
 * Run lifecycle, lease, abort, and environment-view helpers (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts.
 */
import type { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  environmentControllerForBackend,
  finalizeEnvironmentRun,
  redactEnvironmentRecord,
} from '../environments.js'
import { buildRuntimeLifecycleDiagnostics, summarizeRuntimeIsolationProfile } from '../runtime-isolation.js'
import { decideNextTaskState, normalizeTaskQualitySpec, type StageResult, type WorkflowDecision } from '../workflow.js'
import { isActiveRunStatus, isTaskActiveStatus, isTaskRunOwnershipTerminalStatus } from '../runtime-state-machine.js'
import { redactSensitiveText } from '../security.js'
import { appendWorkEventRow } from './event-append.js'
import { calculateTaskReadiness, createRun, recomputeRoadmapStatusInState } from './task-helpers.js'
import { appendDelegationProgressForTask } from './delegation-helpers.js'
import type {
  ActiveRunControlAction,
  ActiveRunControlReason,
  ActiveRunControlResult,
  ActiveRunControlSnapshot,
  RunAttributionInput,
  RunLeaseExpectation,
  RunRecord,
  WorkEnvironmentView,
  WorkEventRecord,
  WorkState,
  WorkTaskRecord,
} from './types.js'

export function environmentViewForRun(run: RunRecord, task?: WorkTaskRecord): WorkEnvironmentView | undefined {
  const environment = run.environment
  if (!environment) return undefined
  const imageDigest = typeof environment.metadata?.['imageDigest'] === 'string' ? environment.metadata['imageDigest'] : undefined
  const expiresAt = Number.isFinite(Date.parse(environment.startedAt)) ? new Date(Date.parse(environment.startedAt) + environment.ttlMs).toISOString() : undefined
  return {
    id: environment.id,
    runId: run.id,
    taskId: run.taskId,
    roadmapId: task?.roadmapId,
    taskTitle: task?.title,
    stage: run.stage,
    sessionId: run.sessionId,
    runStatus: run.status,
    name: environment.name,
    backend: environment.backend,
    status: environment.status,
    provider: environment.provider,
    class: environment.class,
    image: environment.image,
    imageDigest,
    runtime: environment.runtime,
    leaseId: environment.leaseId,
    runEnvironmentId: environment.runId,
    workdir: environment.workdir,
    ttlMs: environment.ttlMs,
    startedAt: environment.startedAt,
    updatedAt: environment.updatedAt,
    expiresAt,
    cleanup: environment.cleanup,
    preflight: environment.preflight,
    resources: environment.resources,
    network: environment.network,
    runtimeProfile: summarizeRuntimeIsolationProfile(run.runtimeProfile, environment),
    lifecycleDiagnostics: buildRuntimeLifecycleDiagnostics(environment),
    artifacts: environment.artifacts.slice(),
    costUsd: run.costUsd,
    metadata: redactEnvironmentRecord(environment.metadata) as Record<string, unknown>,
  }
}

export function isExpiredLease(value: string | undefined, now: number): boolean {
  const expiresAt = Date.parse(value || '')
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

export function runLeaseExpectationFailure(run: RunRecord, expected: RunLeaseExpectation = {}): ActiveRunControlReason | undefined {
  if (!expected.owner && !expected.generation) return undefined
  if (!run.leaseOwner || !run.leaseExpiresAt) return 'lease_missing'
  const now = expected.now || Date.now()
  if (isExpiredLease(run.leaseExpiresAt, now)) return 'lease_expired'
  if (expected.owner && expected.owner !== run.leaseOwner) return 'lease_owner_mismatch'
  if (expected.generation && expected.generation !== run.schedulerGeneration) return 'scheduler_generation_mismatch'
  return undefined
}

export function recoverRunsInState(state: WorkState, db: DatabaseSync, retryLimit: number, now: number, predicate: (run: RunRecord) => boolean, eventType: string, summary: string): { recovered: number; blocked: number; runIds: string[] } {
  let recovered = 0
  let blocked = 0
  const runIds: string[] = []
  const nowIso = new Date(now).toISOString()
  for (const run of state.runs.filter(run => isActiveRunStatus(run.status) && predicate(run))) {
    const task = state.tasks.find(row => row.id === run.taskId)
    if (!task || task.currentRunId !== run.id) continue
    run.status = 'errored'
    run.completedAt = nowIso
    const runtimeMs = Date.parse(nowIso) - Date.parse(run.startedAt)
    run.runtimeMs = Number.isFinite(runtimeMs) && runtimeMs >= 0 ? runtimeMs : undefined
    run.result = { status: 'blocked', summary, feedback: `${summary}: ${run.sessionId}`, artifacts: [], raw: summary }
    run.environment = finalizeEnvironmentRun(run.environment, false)
    task.currentRunId = undefined
    if ((task.attempts[run.stage] || run.attempt || 1) <= retryLimit) {
      task.status = 'pending'
      task.currentStage = run.stage
      task.note = `${summary} for ${run.stage}; task is eligible to retry.`
      recovered++
    } else {
      task.status = 'blocked'
      task.currentStage = undefined
      task.note = `${summary} for ${run.stage} exceeded retry policy.`
      blocked++
    }
    task.updatedAt = nowIso
    runIds.push(run.id)
    appendWorkEventRow(db, eventType, task.id, { runId: run.id, stage: run.stage, sessionId: run.sessionId, recovered: task.status === 'pending' }, nowIso)
  }
  return { recovered, blocked, runIds }
}

export function normalizeActiveRunControlAction(action: ActiveRunControlAction): ActiveRunControlAction {
  if (action === 'cancel' || action === 'stop' || action === 'retry' || action === 'restart') return action
  throw new Error(`active run control action must be cancel, stop, retry, or restart: ${String(action)}`)
}

export function activeRunControlSnapshot(state: WorkState, run: RunRecord, now: number, lastOperatorAction?: ActiveRunControlSnapshot['lastOperatorAction']): ActiveRunControlSnapshot | undefined {
  const task = state.tasks.find(row => row.id === run.taskId)
  if (!task) return undefined
  const leaseExpiresAt = Date.parse(run.leaseExpiresAt || '')
  const heartbeatFreshness = !run.leaseOwner || !run.leaseExpiresAt
    ? 'missing'
    : Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= now
      ? 'expired'
      : Number.isFinite(leaseExpiresAt) && leaseExpiresAt - now < 5 * 60 * 1000
        ? 'stale'
        : 'fresh'
  const heartbeatAgeMs = Number.isFinite(leaseExpiresAt) ? Math.max(0, now - leaseExpiresAt) : undefined
  const activeAndOwned = isActiveRunStatus(run.status) && isTaskActiveStatus(task.status) && task.currentRunId === run.id
  return {
    runId: run.id,
    taskId: task.id,
    taskTitle: task.title,
    taskStatus: task.status,
    stage: run.stage,
    status: run.status,
    sessionId: run.sessionId,
    profile: run.profile,
    attempt: run.attempt,
    startedAt: run.startedAt,
    leaseOwner: run.leaseOwner,
    leaseExpiresAt: run.leaseExpiresAt,
    schedulerGeneration: run.schedulerGeneration,
    heartbeatFreshness,
    heartbeatAgeMs,
    cancellable: activeAndOwned && heartbeatFreshness !== 'expired' && heartbeatFreshness !== 'missing',
    restartable: activeAndOwned && heartbeatFreshness !== 'expired' && heartbeatFreshness !== 'missing',
    lastOperatorAction,
  }
}

export function lastOperatorActionForRun(events: WorkEventRecord[], runId: string): ActiveRunControlSnapshot['lastOperatorAction'] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type !== 'task.run.operator_controlled') continue
    if (String(event.payload?.['runId'] || '') !== runId) continue
    const action = event.payload?.['action'] === 'cancel' || event.payload?.['action'] === 'stop' || event.payload?.['action'] === 'retry' || event.payload?.['action'] === 'restart'
      ? event.payload['action']
      : 'cancel'
    const outcome = event.payload?.['outcome'] === 'applied' || event.payload?.['outcome'] === 'no_op' || event.payload?.['outcome'] === 'denied'
      ? event.payload['outcome']
      : 'denied'
    return {
      action,
      outcome,
      reason: typeof event.payload?.['reason'] === 'string' ? event.payload['reason'] as ActiveRunControlReason : 'run_not_found',
      actor: String(event.payload?.['actor'] || 'local-operator'),
      source: String(event.payload?.['source'] || 'operator-control'),
      at: event.createdAt,
    }
  }
  return undefined
}

export function restartBehaviorForAction(action: ActiveRunControlAction, applied: boolean): ActiveRunControlResult['restartBehavior'] {
  if (!applied) return 'not_applicable'
  if (action === 'restart') return 'new_opencode_session_on_next_scheduler_dispatch'
  if (action === 'retry') return 'durable_requeue_only'
  return 'not_applicable'
}

export function activeRunControlNextAction(action: ActiveRunControlAction, reason: ActiveRunControlReason): string {
  if (reason === 'applied') {
    if (action === 'restart') return 'Scheduler will create a fresh OpenCode session on the next dispatch for this task.'
    if (action === 'retry') return 'Scheduler will retry durable Gateway work for the same stage without reusing the current session.'
    if (action === 'stop') return 'Inspect the blocked task note before resuming or retrying.'
    return 'The task is cancelled; create or retry separate work only with an explicit operator decision.'
  }
  if (reason === 'run_not_active') return 'No mutation was needed because this run is already terminal.'
  if (reason === 'lease_expired' || reason === 'lease_missing') return 'Run `opencode-gateway operator recover` before cancel/restart so Gateway does not mutate stale ownership.'
  if (reason === 'lease_owner_mismatch' || reason === 'scheduler_generation_mismatch') return 'Refresh active run status and retry only against the current lease owner/generation.'
  if (reason === 'task_not_owned_by_run') return 'Refresh active run status; the task no longer points at this run.'
  return 'Refresh operator status and choose an active run before applying a control.'
}

export function abortActiveRunInState(state: WorkState, db: DatabaseSync, task: WorkTaskRecord, action: string, note: string | undefined, now: string): string | undefined {
  const activeRun = task.currentRunId ? state.runs.find(run => run.id === task.currentRunId && isActiveRunStatus(run.status)) : undefined
  if (!activeRun) return undefined
  activeRun.status = 'errored'
  activeRun.completedAt = now
  const runtimeMs = Date.parse(now) - Date.parse(activeRun.startedAt)
  activeRun.runtimeMs = Number.isFinite(runtimeMs) && runtimeMs >= 0 ? runtimeMs : undefined
  activeRun.result = {
    status: 'blocked',
    summary: `${action} requested by Gateway`,
    feedback: note,
    artifacts: [],
    raw: `${action} requested by Gateway`,
  }
  activeRun.environment = finalizeEnvironmentRun(activeRun.environment, false)
  task.currentRunId = undefined
  appendWorkEventRow(db, 'task.run.aborted', task.id, {
    runId: activeRun.id,
    stage: activeRun.stage,
    sessionId: activeRun.sessionId,
    action,
    note: note ? redactSensitiveText(note) : undefined,
    runStatus: activeRun.status,
  }, now)
  return activeRun.sessionId
}

export function activeRunSessionIdsForTasks(state: WorkState, taskIds: Set<string>): string[] {
  const sessionIds = new Set<string>()
  for (const task of state.tasks) {
    if (!taskIds.has(task.id)) continue
    const activeRun = task.currentRunId ? state.runs.find(run => run.id === task.currentRunId && isActiveRunStatus(run.status)) : undefined
    if (activeRun?.sessionId) sessionIds.add(activeRun.sessionId)
  }
  for (const run of state.runs) {
    if (taskIds.has(run.taskId) && isActiveRunStatus(run.status)) sessionIds.add(run.sessionId)
  }
  return [...sessionIds]
}

export function finishRunInState(run: RunRecord, result: StageResult, now: string, attribution: RunAttributionInput = {}): void {
  run.status = result.status === 'pass' ? 'passed' : result.status === 'blocked' ? 'blocked' : 'failed'
  run.completedAt = now
  applyRunAttribution(run, attribution)
  const runtimeMs = Date.parse(now) - Date.parse(run.startedAt)
  run.runtimeMs = Number.isFinite(runtimeMs) && runtimeMs >= 0 ? runtimeMs : undefined
  run.result = result
  run.environment = finalizeEnvironmentRun(run.environment, result.status === 'pass')
}

export function collectRunEnvironmentArtifacts(run: RunRecord, result: StageResult, filePath: string): StageResult {
  if (!run.environment) return result
  try {
    const collection = environmentControllerForBackend(run.environment.backend).collectArtifacts(run.environment)
    if (!collection.ok) return result
    const environmentArtifacts = persistFileArtifactRefs(run.id, collection.artifacts, filePath)
    const artifacts = uniqueResultStrings([...(result.artifacts || []), ...environmentArtifacts])
    run.environment = { ...run.environment, artifacts: uniqueResultStrings([...(run.environment.artifacts || []), ...environmentArtifacts]) }
    if (!environmentArtifacts.length || !collection.evidence.length) return { ...result, artifacts }
    const evidence = [
      ...(result.evidence || []),
      ...collection.evidence.map(summary => ({ type: 'log' as const, ref: environmentArtifacts[0] || run.environment!.id, summary })),
    ]
    return { ...result, artifacts, evidence }
  } catch {
    return result
  }
}

export function persistFileArtifactRefs(runId: string, refs: string[], filePath: string): string[] {
  const artifactDir = path.join(path.dirname(filePath), 'artifacts', runId)
  const copied = new Map<string, string>()
  const out: string[] = []
  for (const ref of refs) {
    const source = fileArtifactPath(ref)
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      out.push(ref)
      continue
    }
    fs.mkdirSync(artifactDir, { recursive: true })
    const target = path.join(artifactDir, `${artifactHash(source).slice(0, 12)}-${path.basename(source)}`)
    fs.copyFileSync(source, target)
    copied.set(source, target)
    out.push(`file:${target}`)
  }
  for (const target of copied.values()) rewriteCapturedMetadata(target, copied)
  return uniqueResultStrings(out)
}

export function fileArtifactPath(ref: string): string | undefined {
  if (!ref.startsWith('file:')) return undefined
  const value = ref.slice('file:'.length)
  return value ? path.resolve(value) : undefined
}

export function rewriteCapturedMetadata(target: string, copied: Map<string, string>): void {
  if (!target.endsWith('.json')) return
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const key of ['stdoutPath', 'stderrPath']) {
      const value = typeof parsed[key] === 'string' ? path.resolve(parsed[key]) : undefined
      if (value && copied.has(value)) parsed[key] = copied.get(value)
    }
    fs.writeFileSync(target, JSON.stringify(parsed, null, 2))
  } catch {}
}

export function artifactHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function uniqueResultStrings(values: unknown[]): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

export function applyRunAttribution(run: RunRecord, attribution: RunAttributionInput = {}): void {
  run.costUsd = normalizeMetric(attribution.costUsd)
  run.inputTokens = normalizeMetric(attribution.inputTokens)
  run.outputTokens = normalizeMetric(attribution.outputTokens)
  run.reasoningTokens = normalizeMetric(attribution.reasoningTokens)
  run.cacheReadTokens = normalizeMetric(attribution.cacheReadTokens)
  run.cacheWriteTokens = normalizeMetric(attribution.cacheWriteTokens)
}

export function runAttributionKey(run: RunRecord): string {
  return [run.costUsd || 0, run.inputTokens || 0, run.outputTokens || 0, run.reasoningTokens || 0, run.cacheReadTokens || 0, run.cacheWriteTokens || 0].join(':')
}

export function runTokens(run: RunRecord): number {
  return Number(run.inputTokens || 0) + Number(run.outputTokens || 0) + Number(run.reasoningTokens || 0) + Number(run.cacheReadTokens || 0) + Number(run.cacheWriteTokens || 0)
}

export function normalizeMetric(value: unknown): number | undefined {
  const number = Number(value || 0)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

export function applyStageResultInState(state: WorkState, task: WorkTaskRecord, run: RunRecord, result: StageResult, retryLimit: number, now: string): WorkflowDecision {
  task.currentRunId = undefined
  task.attempts[run.stage] = run.attempt
  const decision = decideNextTaskState(task, run.stage, result, retryLimit)
  if (result.status === 'pass' && decision.retryStage && decision.note?.startsWith('Quality gate missing required evidence')) {
    run.status = 'failed'
    run.result = { ...result, status: 'fail', feedback: decision.note, failureClass: result.failureClass || 'verification_failed' }
    run.environment = finalizeEnvironmentRun(run.environment, false)
  }
  task.status = decision.taskStatus
  task.note = decision.note || task.note
  task.updatedAt = now

  if (decision.nextStage) task.currentStage = decision.nextStage
  else if (decision.retryStage) task.currentStage = decision.retryStage
  else task.currentStage = undefined

  if (isTaskRunOwnershipTerminalStatus(task.status)) recomputeRoadmapStatusInState(state, task.roadmapId, now)
  return decision
}

export function startWorkTaskRunInState(state: WorkState, db: DatabaseSync, id: string, stage: string, sessionId: string, profile: string, lease: { owner?: string; leaseMs?: number; generation?: string } = {}, resolution: import('./types.js').RunResolutionInput = {}, nowDate = new Date()): import('./types.js').WorkTaskRunStartResult | undefined {
  const task = state.tasks.find(row => row.id === id)
  if (!task || task.status !== 'pending' || task.currentRunId) return undefined
  const roadmap = state.roadmaps.find(row => row.id === task.roadmapId)
  if (roadmap?.status === 'archived') return undefined
  if (!task.pipeline.includes(stage)) return undefined
  if ((task.currentStage || task.pipeline[0] || 'implement') !== stage) return undefined
  if (calculateTaskReadiness(task, state).status !== 'runnable') return undefined
  const now = nowDate.toISOString()
  if (resolution.taskQualitySpec) task.qualitySpec = normalizeTaskQualitySpec(resolution.taskQualitySpec)
  const run = createRun(task, stage, sessionId, profile, nowDate, lease, resolution)
  state.runs.push(run)
  task.status = 'running'
  task.currentStage = stage
  task.currentRunId = run.id
  task.updatedAt = now
  appendWorkEventRow(db, 'task.run.started', task.id, { runId: run.id, stage, sessionId, profile, agentTeam: run.agentTeam, agentTeamVersion: run.agentTeamVersion, resolvedProfile: run.resolvedProfile, resolvedAgent: run.resolvedAgent }, now)
  appendDelegationProgressForTask(db, task, 'dispatched', { runId: run.id, stage, sessionId, profile, status: task.status, summary: `Delegated task dispatched to ${stage}: ${task.title}` }, now, run.id)
  return { task, run }
}
