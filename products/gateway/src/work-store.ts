import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { getConfig, type HumanGateTimeoutAction } from './config.js'
import { cleanupFailedEnvironmentRun, environmentControllerForBackend, finalizeEnvironmentRun, normalizeEnvironmentSelector, redactEnvironmentRecord, type EnvironmentRunRecord, type EnvironmentSelector } from './environments.js'
import { buildRuntimeLifecycleDiagnostics, summarizeRuntimeIsolationProfile } from './runtime-isolation.js'
import { decideNextTaskState, defaultPipeline, normalizeTaskQualitySpec, type RunStatus, type StageResult, type WorkflowDecision, type WorkStatus } from './workflow.js'
import { type AuditLedgerQueryOptions } from './audit-ledger.js'
import { closeWorkDb, currentWorkDbLeadershipEpoch, getRow, markWorkDbActive, openWorkDb, parseJSON, queryRows, resetWorkDbInitState, unmarkWorkDbActive, withWorkDb, withWorkDbReadOnly, workStatePath } from './work-store/db.js'
import { isDependencyRecord, isProjectBindingRecord, isRoadmapCompletionProposalRecord, isRoadmapRecord, isRoadmapSupervisorRecord, isRunRecord, isTaskRecord, normalizeProjectBindingRecord, normalizeRoadmapQualitySpec, rowToAlert, rowToAuditLedger, rowToDelegationReceipt, rowToDependency, rowToEvent, rowToHumanGate, rowToProjectBinding, rowToRoadmap, rowToRoadmapCompletionProposal, rowToRoadmapSupervisor, rowToRun, rowToSupervisorWakeupReceipt, rowToTask, rowToTaskDispatchReceipt } from './work-store/row-mappers.js'
import { normalizeJsonObject, normalizeOptionalEventId, normalizeOptionalIdentifier, normalizeOptionalIsoTime, normalizeOptionalString, normalizePriority, normalizeProjectAlias, normalizeRequiredString, normalizeStage, normalizeStringList, normalizeThreadId } from './work-store/validators.js'
import { redactSensitiveText } from './security.js'
import { isActiveRunStatus, isTaskActiveStatus, isTaskRunOwnershipTerminalStatus, shouldAbortActiveRunForTaskStatus } from './runtime-state-machine.js'
import { writeRunArtifactManifest } from './artifacts.js'

export type { WorkStoreSchemaInspection } from './work-store/schema.js'
export { closeWorkDb, currentWorkDbLeadershipEpoch, disposeWorkStore, getRow, isStaleWorkDbLeadershipError, openWorkDb, parseJSON, queryRows, recoverInterruptedStorageRestore, resetWorkDbInitState, restrictSqliteDbPermissions, setWorkDbLeadershipEpochProvider, storageRestoreJournalPath, withWorkDb, withWorkDbLeadershipEpoch, withWorkDbReadOnly, workStatePath, writeStorageRestoreJournal } from './work-store/db.js'
export type { SqliteRow, StorageRestoreJournal, StorageRestoreJournalEntry, StorageRestoreRecoveryResult, WorkDbLeadershipEpoch } from './work-store/db.js'
export { listWorkStoreRepositoryDomains, validateWorkStoreMutationContracts } from './work-store/repositories.js'
export type { WorkStoreMutationCompatibilityContract, WorkStoreMutationContractValidation, WorkStoreMutationEntryPoint, WorkStoreRepositoryDomain, WorkStoreRepositoryDomainId, WorkStoreTransactionOwner } from './work-store/repositories.js'
export type { AuditLedgerQueryOptions } from './audit-ledger.js'

export * from './work-store/types.js'
import { assertNoStorageOperationInProgress } from './work-store/storage-lock.js'
import {
  pruneWorkEvents,
} from './work-store/retention.js'
export { runWorkStoreRetentionMaintenance } from './work-store/retention.js'
export type {
  AuditLedgerRetentionResult,
  RowRetentionResult,
  WorkStoreRetentionMaintenanceOptions,
  WorkStoreRetentionMaintenanceResult,
} from './work-store/retention.js'

export {
  listAlerts,
  listAlertsReadOnly,
  upsertAlert,
  resolveAlertsNotInKeys,
  updateAlertStatus,
} from './work-store/alerts.js'
export {
  getChannelBinding,
  upsertChannelBinding,
  listChannelBindings,
  listChannelBindingsReadOnly,
  deleteChannelBinding,
  createChannelClaimCodeRecord,
  findChannelClaimCodeByHash,
  listChannelClaimCodes,
  listChannelClaimCodesReadOnly,
  updateChannelClaimCodeStatus,
  clearChannelBindingsForTest,
} from './work-store/channel-bindings.js'

import {
  INBOX_ROADMAP_ID,
  OPEN_HUMAN_GATE_STATUSES,
  WORK_EVENT_TYPE_QUERY_LIMIT,
} from './work-store/types.js'
import type {
  ActiveRunControlAction,
  ActiveRunControlInput,
  ActiveRunControlOutcome,
  ActiveRunControlReason,
  ActiveRunControlResult,
  ActiveRunControlSnapshot,
  AlertRecord,
  AuditEventInput,
  AuditLedgerRecord,
  ChannelBindingMode,
  DelegatedWorkMutationInput,
  DelegatedWorkProgressKind,
  DelegatedWorkReceipt,
  DelegationProgressRouteReceiptRecord,
  HumanGateDecision,
  HumanGateDecisionInput,
  HumanGateDecisionResult,
  HumanGateInput,
  HumanGateRecord,
  HumanGateScope,
  HumanGateStatus,
  HumanGateType,
  ManualGate,
  ProjectBindingInput,
  ProjectBindingRecord,
  ProjectBindingScope,
  ProjectBindingUpdateInput,
  ProjectContextResolution,
  ProjectNotificationMode,
  RoadmapArchiveResult,
  RoadmapCompletionProposalDecisionInput,
  RoadmapCompletionProposalDecisionResult,
  RoadmapCompletionProposalInput,
  RoadmapCompletionProposalRecord,
  RoadmapCompletionProposalStatus,
  RoadmapDeleteResult,
  RoadmapQualitySpec,
  RoadmapRecord,
  RoadmapStatus,
  RoadmapSupervisorCreateInput,
  RoadmapSupervisorRecord,
  RoadmapSupervisorResultApplyInput,
  RoadmapSupervisorResultApplyResult,
  RoadmapSupervisorStatus,
  RoadmapSupervisorUpdateInput,
  RoadmapSupervisorWakeupRecord,
  RoadmapUpdateInput,
  RunAttributionInput,
  RunLeaseExpectation,
  RunRecord,
  RunResolutionInput,
  SupervisedProjectCreateInput,
  SupervisedProjectCreateResult,
  SupervisorWakeReason,
  SupervisorWakeupReceiptRecord,
  SupervisorWakeupReceiptStatus,
  TaskDispatchAcquisitionKind,
  TaskDispatchAcquisitionRecord,
  TaskDispatchAcquisitionStatus,
  TaskDispatchReceiptRecord,
  TaskDispatchReceiptStatus,
  WorkDependencyInput,
  WorkDependencyRecord,
  WorkDependencyType,
  WorkEnvironmentAction,
  WorkEnvironmentView,
  WorkEventRecord,
  WorkLeaseSummary,
  WorkState,
  WorkTaskAction,
  WorkTaskActionResult,
  WorkTaskArchiveResult,
  WorkTaskBulkUpdateInput,
  WorkTaskCreateInput,
  WorkTaskDeleteResult,
  WorkTaskReadiness,
  WorkTaskReadinessStatus,
  WorkTaskRecord,
  WorkTaskRunCompleteResult,
  WorkTaskRunFailResult,
  WorkTaskRunStartResult,
  WorkTaskUpdateInput,
  WorkTaskUpdateResult,
  WorkTaskView,
} from './work-store/types.js'


export function emptyWorkState(): WorkState {
  return emptyState()
}

/**
 * Options for the public work-state reads.
 * - `all` (default) materializes every run — the durable, complete history that
 *   full-history consumers (backups, evidence export, all-time totals, session
 *   lookups over arbitrarily old runs) still depend on.
 * - `live` materializes only the bounded window the mutation/scheduler hot path
 *   can touch (running runs, `currentRunId` runs, a recent terminal slice), so
 *   materialization latency is flat regardless of cumulative run history.
 *
 * The default stays `all` on purpose: a broad set of consumers reads full
 * `state.runs` for correctness, so callers opt into the bounded window
 * explicitly rather than the default silently truncating history.
 */
export interface LoadWorkStateOptions {
  runsScope?: 'all' | 'live'
}

const WORK_STATE_MATERIALIZATION = Symbol('opencode-gateway.workStateMaterialization')

export function loadWorkState(filePath = workStatePath(), options: LoadWorkStateOptions = {}): WorkState {
  return withWorkDb(filePath, db => readWorkState(db, { runsScope: options.runsScope || 'all' }))
}

export function loadWorkStateReadOnly(filePath = workStatePath(), options: LoadWorkStateOptions = {}): WorkState {
  return withWorkDbReadOnly(filePath, db => readWorkState(db, { runsScope: options.runsScope || 'all' }))
}

export function saveWorkState(state: WorkState, filePath = workStatePath()): void {
  assertFullWorkStateForReplace(state)
  assertNoStorageOperationInProgress(filePath)
  return withWorkDb(filePath, db => {
    writeWorkState(db, state)
  })
}

function assertFullWorkStateForReplace(state: WorkState): void {
  const materialization = (state as any)[WORK_STATE_MATERIALIZATION] as { runsScope?: 'all' | 'live' } | undefined
  if (materialization?.runsScope && materialization.runsScope !== 'all') {
    throw new Error('saveWorkState refuses to replace durable state from a partial live-window WorkState; reload with runsScope=all before saving')
  }
}

export function createRun(task: WorkTaskRecord, stage: string, sessionId: string, profile: string, now = new Date(), lease: { owner?: string; leaseMs?: number; generation?: string } = {}, resolution: RunResolutionInput = {}): RunRecord {
  const attempt = (task.attempts[stage] || 0) + 1
  const leaseMs = lease.leaseMs || 60 * 60 * 1000
  return {
    id: `run_${randomUUID()}`,
    taskId: task.id,
    stage,
    sessionId,
    profile,
    agentTeam: normalizeOptionalString(resolution.agentTeam, 120),
    agentTeamVersion: normalizeOptionalString(resolution.agentTeamVersion, 120),
    resolvedProfile: normalizeOptionalString(resolution.resolvedProfile, 120),
    resolvedAgent: normalizeOptionalString(resolution.resolvedAgent, 120),
    environment: resolution.environment,
    runtimeProfile: resolution.runtimeProfile,
    status: 'running',
    attempt,
    startedAt: now.toISOString(),
    leaseOwner: lease.owner,
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    schedulerGeneration: lease.generation,
  }
}

export function listWorkTaskViews(state: WorkState): WorkTaskView[] {
  const dependencies = state.dependencies || []
  const tasksById = new Map(state.tasks.map(task => [task.id, task]))
  const dependenciesByTask = new Map<string, WorkDependencyRecord[]>()
  for (const dep of dependencies) {
    const rows = dependenciesByTask.get(dep.taskId) || []
    rows.push(dep)
    dependenciesByTask.set(dep.taskId, rows)
  }
  const runsByTask = new Map<string, RunRecord[]>()
  for (const run of state.runs) {
    const rows = runsByTask.get(run.taskId) || []
    rows.push(run)
    runsByTask.set(run.taskId, rows)
  }
  for (const runs of runsByTask.values()) runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  const now = Date.now()
  return state.tasks.map(task => {
    const runs = runsByTask.get(task.id) || []
    const taskDependencies = dependenciesByTask.get(task.id) || []
    return { ...task, activeRun: runs.find(run => isActiveRunStatus(run.status)), lastRun: runs[0], dependencies: taskDependencies, readiness: calculateTaskReadiness(task, state, now, { tasksById, dependenciesByTask }) }
  }).sort(compareTaskReadiness)
}

interface WorkTaskReadinessIndexes {
  tasksById: Map<string, WorkTaskRecord>
  dependenciesByTask: Map<string, WorkDependencyRecord[]>
}

export function calculateTaskReadiness(task: WorkTaskRecord, state: WorkState, now = Date.now(), indexes?: WorkTaskReadinessIndexes): WorkTaskReadiness {
  if (task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') return { status: 'done', reason: `Task is ${task.status}`, blockers: [] }
  if (isTaskActiveStatus(task.status)) return { status: 'running', reason: 'Task already has an active run', blockers: task.currentRunId ? [task.currentRunId] : [] }
  if (task.status === 'paused') return { status: 'paused', reason: task.note || 'Task is paused', blockers: [] }
  if (task.status === 'blocked') return { status: 'blocked', reason: task.note || 'Task is blocked', blockers: [] }
  if (task.manualGate) return { status: 'waiting', reason: manualGateReason(task.manualGate), blockers: [task.manualGate] }
  const earliest = Date.parse(task.earliestStartAt || '')
  if (Number.isFinite(earliest) && earliest > now) return { status: 'scheduled', reason: `Scheduled for ${task.earliestStartAt}`, blockers: [task.earliestStartAt!] }
  const tasksById = indexes?.tasksById || new Map(state.tasks.map(row => [row.id, row]))
  const blockers = blockingDependenciesForTask(task.id, state, indexes)
    .filter(dep => tasksById.get(dep.dependsOnTaskId)?.status !== 'done')
  if (blockers.length) {
    const labels = blockers.map(dep => tasksById.get(dep.dependsOnTaskId)?.title || dep.dependsOnTaskId)
    return { status: 'blocked', reason: `Waiting for dependency: ${labels.join(', ')}`, blockers: blockers.map(dep => dep.dependsOnTaskId) }
  }
  return { status: 'runnable', reason: 'Ready to dispatch', blockers: [] }
}

export function getWorkTaskReadiness(taskId: string, filePath = workStatePath()): WorkTaskReadiness | undefined {
  const state = loadWorkState(filePath)
  const task = state.tasks.find(row => row.id === taskId)
  return task ? calculateTaskReadiness(task, state) : undefined
}

export function listWorkDependencies(taskId?: string, filePath = workStatePath()): WorkDependencyRecord[] {
  const deps = loadWorkState(filePath).dependencies || []
  return taskId ? deps.filter(dep => dep.taskId === taskId) : deps
}

export function listHumanGates(filter: { status?: HumanGateStatus | 'open'; taskId?: string; roadmapId?: string } = {}, filePath = workStatePath()): HumanGateRecord[] {
  return withWorkDb(filePath, db => listHumanGatesFromDb(db, filter))
}

export function listHumanGatesReadOnly(filter: { status?: HumanGateStatus | 'open'; taskId?: string; roadmapId?: string } = {}, filePath = workStatePath()): HumanGateRecord[] {
  return withWorkDbReadOnly(filePath, db => listHumanGatesFromDb(db, filter))
}

function listHumanGatesFromDb(db: DatabaseSync, filter: { status?: HumanGateStatus | 'open'; taskId?: string; roadmapId?: string } = {}): HumanGateRecord[] {
  // Filter in SQL so idx_human_gates_status / idx_human_gates_task serve the
  // hot dashboard/alert-engine queries instead of loading every gate row.
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.status === 'open') {
    clauses.push(`status IN (${OPEN_HUMAN_GATE_STATUSES.map(() => '?').join(', ')})`)
    params.push(...OPEN_HUMAN_GATE_STATUSES)
  } else if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  if (filter.taskId) {
    clauses.push('task_id = ?')
    params.push(filter.taskId)
  }
  if (filter.roadmapId) {
    clauses.push('roadmap_id = ?')
    params.push(filter.roadmapId)
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = queryRows(db, `SELECT * FROM human_gates${where} ORDER BY requested_at ASC`, ...params)
  return rows.map(rowToHumanGate).filter(Boolean) as HumanGateRecord[]
}

export function getHumanGate(id: string, filePath = workStatePath()): HumanGateRecord | undefined {
  return withWorkDb(filePath, db => rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id)) || undefined)
}

export function createHumanGate(input: HumanGateInput, filePath = workStatePath()): HumanGateRecord {
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const gate = insertHumanGateRow(db, input, new Date().toISOString(), { force: true })!
      db.exec('COMMIT')
      return gate
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function ensureHumanGate(input: HumanGateInput, filePath = workStatePath()): HumanGateRecord | undefined {
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const gate = insertHumanGateRow(db, input, new Date().toISOString(), { force: false })
      db.exec('COMMIT')
      return gate
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function decideHumanGate(id: string, input: HumanGateDecisionInput, filePath = workStatePath()): HumanGateDecisionResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const existing = rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id))
    if (!existing) return undefined
    if (!OPEN_HUMAN_GATE_STATUSES.includes(existing.status)) return { gate: existing }
    const decision = normalizeHumanGateDecision(input.decision)
    const actor = normalizeOptionalString(input.actor, 120) || 'operator'
    const source = normalizeOptionalString(input.source, 120) || 'gateway'
    const note = normalizeOptionalString(input.note, 2000)
    const scope = normalizeHumanGateScope(input.scope)
    const now = new Date().toISOString()
    const nextStatus: HumanGateStatus = decision === 'approve' ? 'approved' : 'rejected'
    db.prepare(`UPDATE human_gates SET status = ?, updated_at = ?, decided_by = ?, decision_note = ?, scope = ? WHERE id = ?`)
      .run(nextStatus, now, actor, note || null, scope, id)
    const task = existing.taskId ? state.tasks.find(row => row.id === existing.taskId) : undefined
    if (task) {
      if (decision === 'approve') {
        task.manualGate = undefined
        if (task.status === 'blocked' || task.status === 'paused') task.status = 'pending'
        task.currentStage ||= existing.stage || task.pipeline[0] || 'implement'
        task.note = note || task.note
      } else {
        const abortedSessionId = abortActiveRunInState(state, db, task, 'human gate rejected', note, now)
        task.status = 'blocked'
        task.currentRunId = undefined
        task.note = note || `Rejected human gate: ${existing.reason}`
        appendWorkEventRow(db, 'human_gate.rejected_task', task.id, { gateId: id, abortedSessionId, note }, now)
      }
      task.updatedAt = now
      recomputeRoadmapStatusInState(state, task.roadmapId, now)
    }
    appendWorkEventRow(db, 'human_gate.decided', existing.taskId || existing.roadmapId || id, { gateId: id, decision, scope, actor, source, note }, now)
    appendWorkEventRow(db, 'audit.human_decision', existing.taskId || existing.roadmapId || id, { actor, source, operation: `human_gate.${decision}`, target: id, result: 'ok', scope, note }, now)
    const gate = rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id))!
    return { gate, task }
  })
}

export function consumeHumanGate(id: string, input: { actor?: string; source?: string; note?: string } = {}, filePath = workStatePath()): HumanGateDecisionResult | undefined {
  return mutateWorkState(filePath, (_state, db) => {
    const existing = rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id))
    if (!existing) return undefined
    if (existing.status !== 'approved' || existing.scope === 'always') return { gate: existing }
    const actor = normalizeOptionalString(input.actor, 120) || 'gateway'
    const source = normalizeOptionalString(input.source, 120) || 'gateway'
    const note = normalizeOptionalString(input.note, 2000)
    const now = new Date().toISOString()
    db.prepare('UPDATE human_gates SET status = ?, updated_at = ?, decision_note = COALESCE(?, decision_note) WHERE id = ?')
      .run('consumed', now, note || null, id)
    appendWorkEventRow(db, 'human_gate.consumed', existing.taskId || existing.roadmapId || id, { gateId: id, scope: existing.scope || 'once', actor, source, note }, now)
    appendWorkEventRow(db, 'audit.human_decision', existing.taskId || existing.roadmapId || id, { actor, source, operation: 'human_gate.consume', target: id, result: 'ok', scope: existing.scope || 'once', note }, now)
    const gate = rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id))!
    return { gate }
  })
}

export function timeoutHumanGate(id: string, action: HumanGateTimeoutAction, filePath = workStatePath(), nowMs = Date.now()): HumanGateDecisionResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const existing = rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id))
    if (!existing || !OPEN_HUMAN_GATE_STATUSES.includes(existing.status)) return existing ? { gate: existing } : undefined
    const now = new Date(nowMs).toISOString()
    const task = existing.taskId ? state.tasks.find(row => row.id === existing.taskId) : undefined
    let status: HumanGateStatus = existing.status
    let escalatedAt = existing.escalatedAt
    if (action === 'remind') {
      const nextTimeout = new Date(nowMs + Math.max(1000, getConfig().humanLoop.defaultTimeoutMs)).toISOString()
      db.prepare('UPDATE human_gates SET updated_at = ?, expires_at = ? WHERE id = ?').run(now, nextTimeout, id)
      appendWorkEventRow(db, 'human_gate.reminded', existing.taskId || existing.roadmapId || id, { gateId: id, nextTimeout }, now)
    } else if (action === 'escalate') {
      status = 'escalated'
      escalatedAt = now
      db.prepare('UPDATE human_gates SET status = ?, updated_at = ?, escalated_at = ? WHERE id = ?').run(status, now, now, id)
      appendWorkEventRow(db, 'human_gate.escalated', existing.taskId || existing.roadmapId || id, { gateId: id }, now)
    } else {
      status = 'timed_out'
      db.prepare('UPDATE human_gates SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
      if (task) {
        const abortedSessionId = abortActiveRunInState(state, db, task, `human gate ${action}`, existing.reason, now)
        task.status = action === 'pause' ? 'paused' : 'blocked'
        task.currentRunId = undefined
        task.note = `Human gate timed out: ${existing.reason}`
        task.updatedAt = now
        recomputeRoadmapStatusInState(state, task.roadmapId, now)
        appendWorkEventRow(db, action === 'pause' ? 'human_gate.paused_task' : 'human_gate.blocked_task', task.id, { gateId: id, abortedSessionId }, now)
      }
    }
    appendWorkEventRow(db, 'audit.human_decision', existing.taskId || existing.roadmapId || id, { actor: 'gateway', source: 'timeout', operation: `human_gate.${action}`, target: id, result: 'ok' }, now)
    const gate = rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id)) || { ...existing, status, escalatedAt, updatedAt: now }
    return { gate, task }
  })
}


export function addWorkDependency(input: WorkDependencyInput, filePath = workStatePath()): WorkDependencyRecord {
  return mutateWorkState(filePath, (state, db) => addWorkDependencyInState(state, db, input, new Date().toISOString()))
}

export function deleteWorkDependency(taskId: string, dependsOnTaskId: string, type?: WorkDependencyType, filePath = workStatePath()): boolean {
  return mutateWorkState(filePath, (state, db) => {
    const deps = state.dependencies || []
    const before = deps.length
    state.dependencies = deps.filter(dep => !(dep.taskId === taskId && dep.dependsOnTaskId === dependsOnTaskId && (!type || dep.type === type)))
    const deleted = state.dependencies.length !== before
    if (deleted) appendWorkEventRow(db, 'task.dependency.deleted', taskId, { dependsOnTaskId, type }, new Date().toISOString())
    return deleted
  })
}

export function summarizeWorkTasks(tasks: Array<{ status: WorkStatus; priority: string }>) {
  return {
    total: tasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    running: tasks.filter(t => t.status === 'running').length,
    done: tasks.filter(t => t.status === 'done').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    paused: tasks.filter(t => t.status === 'paused').length,
    cancelled: tasks.filter(t => t.status === 'cancelled').length,
    archived: tasks.filter(t => t.status === 'archived').length,
    high: tasks.filter(t => t.priority === 'HIGH').length,
    medium: tasks.filter(t => t.priority === 'MEDIUM').length,
    low: tasks.filter(t => t.priority === 'LOW').length,
  }
}

export function markWorkTaskDone(text: string, filePath = workStatePath()): boolean {
  return mutateWorkState(filePath, (state, db) => {
    const task = state.tasks.find(row => row.id === text || row.title.includes(text) || row.description.includes(text))
    if (!task) return false
    const now = new Date().toISOString()
    const abortedSessionId = abortActiveRunInState(state, db, task, 'done', undefined, now)
    task.status = 'done'
    task.currentRunId = undefined
    task.currentStage = undefined
    task.updatedAt = now
    recomputeRoadmapStatusInState(state, task.roadmapId, now)
    appendWorkEventRow(db, 'task.done.manual', task.id, { title: task.title, abortedSessionId }, now)
    appendDelegationProgressForTask(db, task, 'completed', { status: task.status, summary: `Delegated task completed: ${task.title}` }, now)
    return true
  })
}

export function createRoadmap(input: { title: string; priority?: 'HIGH' | 'MEDIUM' | 'LOW'; agentTeam?: string; environment?: EnvironmentSelector; qualitySpec?: RoadmapQualitySpec }, filePath = workStatePath()): RoadmapRecord {
  return mutateWorkState(filePath, (state, db) => {
    const now = new Date().toISOString()
    return createRoadmapInState(state, db, input, now)
  })
}

export function createRoadmapWithTasks(input: { title: string; priority?: 'HIGH' | 'MEDIUM' | 'LOW'; agentTeam?: string; environment?: EnvironmentSelector; qualitySpec?: RoadmapQualitySpec; tasks?: WorkTaskCreateInput[] }, filePath = workStatePath()): { roadmap: RoadmapRecord; tasks: WorkTaskRecord[] } {
  return mutateWorkState(filePath, (state, db) => {
    const now = new Date().toISOString()
    const roadmap = createRoadmapInState(state, db, input, now)
    const tasks = normalizeTaskCreateList(input.tasks || []).map(task => createWorkTaskInState(state, db, { ...task, roadmapId: task.roadmapId || roadmap.id }, now))
    recomputeRoadmapStatusInState(state, roadmap.id, now)
    appendWorkEventRow(db, 'roadmap.created_with_tasks', roadmap.id, { taskIds: tasks.map(task => task.id) }, now)
    return { roadmap, tasks }
  })
}

/** One dependency edge in a {@link PlanInitiativeInput}, addressed by task ref. */
export interface PlanInitiativeDependency {
  /** The dependent task: a 0-based index into `tasks[]`, or a new task's title, or an existing task id. */
  taskRef: string | number
  /** The prerequisite task that must complete first, addressed the same way as {@link taskRef}. */
  dependsOnRef: string | number
  type?: WorkDependencyType
}

/** Full spec for {@link planInitiative}: a roadmap, its tasks, their dependency edges, and an optional supervisor. */
export interface PlanInitiativeInput {
  title: string
  priority?: 'HIGH' | 'MEDIUM' | 'LOW'
  agentTeam?: string
  environment?: EnvironmentSelector
  qualitySpec?: RoadmapQualitySpec
  tasks?: WorkTaskCreateInput[]
  dependencies?: PlanInitiativeDependency[]
  /** When provided (with a sessionId), an Initiative Supervisor is bound in the same transaction. */
  supervisor?: Omit<RoadmapSupervisorCreateInput, 'roadmapId'>
}

export interface PlanInitiativeResult {
  roadmap: RoadmapRecord
  tasks: WorkTaskRecord[]
  dependencies: WorkDependencyRecord[]
  supervisor?: RoadmapSupervisorRecord
}

/**
 * Atomically create an Initiative (roadmap), its child Issues (tasks), their
 * dependency edges, and — optionally — a bound supervisor, in one work-store
 * write transaction. Collapses roadmap_create_with_tasks + N task_dependency_add
 * (+ roadmap_supervisor_create) into a single all-or-nothing call: any failure
 * (missing task ref, dependency cycle, unknown profile) rolls the whole
 * transaction back so partial initiatives never persist.
 */
export function planInitiative(input: PlanInitiativeInput, filePath = workStatePath()): PlanInitiativeResult {
  return mutateWorkState(filePath, (state, db) => {
    const now = new Date().toISOString()
    const roadmap = createRoadmapInState(state, db, input, now)
    const tasks = normalizeTaskCreateList(input.tasks || []).map(task => createWorkTaskInState(state, db, { ...task, roadmapId: task.roadmapId || roadmap.id }, now))
    recomputeRoadmapStatusInState(state, roadmap.id, now)
    appendWorkEventRow(db, 'roadmap.created_with_tasks', roadmap.id, { taskIds: tasks.map(task => task.id) }, now)

    const resolveTaskRef = (ref: unknown, label: string): string => {
      if (typeof ref === 'number') {
        if (!Number.isInteger(ref) || ref < 0 || ref >= tasks.length) throw new Error(`${label} index out of range: ${ref}`)
        return tasks[ref]!.id
      }
      if (typeof ref === 'string') {
        const trimmed = ref.trim()
        if (!trimmed) throw new Error(`${label} is required`)
        const byTitle = tasks.filter(task => task.title === trimmed)
        if (byTitle.length === 1) return byTitle[0]!.id
        if (byTitle.length > 1) throw new Error(`${label} matches multiple new tasks by title: ${trimmed}`)
        if (state.tasks.some(task => task.id === trimmed)) return trimmed
        throw new Error(`${label} does not match a new task index/title or an existing task id: ${trimmed}`)
      }
      throw new Error(`${label} must be a task index (number) or a task title/id (string)`)
    }

    const dependencyInputs = Array.isArray(input.dependencies) ? input.dependencies : []
    const dependencies = dependencyInputs.map((dep, index) => {
      if (!dep || typeof dep !== 'object' || Array.isArray(dep)) throw new Error(`dependency at index ${index} must be an object`)
      return addWorkDependencyInState(state, db, {
        taskId: resolveTaskRef(dep.taskRef, `dependencies[${index}].taskRef`),
        dependsOnTaskId: resolveTaskRef(dep.dependsOnRef, `dependencies[${index}].dependsOnRef`),
        type: dep.type,
      }, now)
    })

    let supervisor: RoadmapSupervisorRecord | undefined
    const supervisorInput = input.supervisor
    if (supervisorInput !== undefined && supervisorInput !== null) {
      // A supervisor object without a sessionId is a validation error, not a
      // silent no-op: createRoadmapSupervisorInState throws inside this same
      // transaction so the whole initiative rolls back (matching the piecewise
      // roadmap_supervisor_create behavior instead of dropping the supervisor).
      if (typeof supervisorInput !== 'object' || Array.isArray(supervisorInput)) throw new Error('supervisor must be an object with a sessionId')
      supervisor = createRoadmapSupervisorInState(state, { ...supervisorInput, roadmapId: roadmap.id }, now)
      reconcileDefaultSupervisorInState(state, roadmap.id, supervisor.isDefault ? supervisor.supervisorId : undefined, now)
      appendWorkEventRow(db, 'roadmap.supervisor.created', supervisor.roadmapId, { supervisorId: supervisor.supervisorId, sessionId: supervisor.sessionId, profile: supervisor.profile, isDefault: supervisor.isDefault }, now)
    }

    appendWorkEventRow(db, 'workflow.plan_initiative', roadmap.id, { taskIds: tasks.map(task => task.id), dependencyCount: dependencies.length, supervisorId: supervisor?.supervisorId }, now)
    return { roadmap, tasks, dependencies, supervisor }
  })
}

export function createSupervisedProject(input: SupervisedProjectCreateInput, filePath = workStatePath()): SupervisedProjectCreateResult {
  return mutateWorkState(filePath, (state, db) => {
    const idempotencyKey = normalizeOptionalString(input.idempotencyKey, 240)
    if (idempotencyKey) {
      const existing = findDelegationReceiptInDb(db, idempotencyKey)
      if (existing) {
        if (existing.targetType !== 'project_create') throw new Error(`idempotency key already used for ${existing.targetType}: ${idempotencyKey}`)
        return { ...supervisedProjectResultFromReceipt(state, existing), idempotencyStatus: 'replayed' }
      }
    }
    const now = new Date().toISOString()
    const roadmap = createRoadmapInState(state, db, input.roadmap, now)
    const tasks = normalizeTaskCreateList(input.tasks || []).map(task => createWorkTaskInState(state, db, { ...task, roadmapId: task.roadmapId || roadmap.id }, now))
    recomputeRoadmapStatusInState(state, roadmap.id, now)
    appendWorkEventRow(db, 'roadmap.created_with_tasks', roadmap.id, { taskIds: tasks.map(task => task.id) }, now)

    const supervisor = createRoadmapSupervisorInState(state, { ...input.supervisor, roadmapId: roadmap.id }, now)
    reconcileDefaultSupervisorInState(state, roadmap.id, supervisor.isDefault ? supervisor.supervisorId : undefined, now)
    appendWorkEventRow(db, 'roadmap.supervisor.created', supervisor.roadmapId, { supervisorId: supervisor.supervisorId, sessionId: supervisor.sessionId, profile: supervisor.profile, isDefault: supervisor.isDefault }, now)

    const previous = state.projectBindings.slice()
    const binding = upsertProjectBindingInState(state, { ...input.binding, roadmapId: roadmap.id, title: input.binding.title || roadmap.title }, now)
    for (const stale of previous.filter(row => row.id !== binding.id && !state.projectBindings.some(current => current.id === row.id))) deleteProjectBindingChannelRow(db, stale)
    if (binding.provider && binding.chatId) {
      upsertChannelBindingRow(db, { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId, mode: 'roadmap', roadmapId: binding.roadmapId, title: binding.title || binding.alias }, now)
      appendWorkEventRow(db, 'channel.binding.upserted', binding.sessionId, { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, mode: 'roadmap', roadmapId: binding.roadmapId }, now)
    }
    appendWorkEventRow(db, 'project.binding.upserted', binding.roadmapId, { bindingId: binding.id, alias: binding.alias, scope: binding.scope, sessionId: binding.sessionId, provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId }, now)
    if (input.event?.type) {
      appendWorkEventRow(db, input.event.type, roadmap.id, {
        alias: binding.alias,
        sessionId: supervisor.sessionId,
        taskIds: tasks.map(task => task.id),
        ...(input.event.payload || {}),
      }, now)
    }
    if (idempotencyKey) {
      const receipt: DelegatedWorkReceipt = {
        idempotencyKey,
        idempotencyStatus: 'created',
        targetType: 'project_create',
        taskIds: tasks.map(task => task.id),
        roadmapId: roadmap.id,
        supervisorId: supervisor.supervisorId,
        projectBindingId: binding.id,
        parentSessionId: supervisor.sessionId,
        links: receiptLinks(roadmap, tasks, supervisor, binding),
        nextSchedulerAction: nextDelegationSchedulerAction(tasks, supervisor),
      }
      upsertDelegationReceiptRow(db, receipt, now)
    }
    return { roadmap, tasks, supervisor, binding, idempotencyStatus: idempotencyKey ? 'created' : undefined }
  })
}

function supervisedProjectResultFromReceipt(state: WorkState, receipt: DelegatedWorkReceipt): Omit<SupervisedProjectCreateResult, 'idempotencyStatus'> {
  const roadmap = receipt.roadmapId ? state.roadmaps.find(row => row.id === receipt.roadmapId) : undefined
  if (!roadmap) throw new Error(`project create receipt references missing roadmap: ${receipt.idempotencyKey}`)
  const supervisor = receipt.supervisorId
    ? state.supervisors.find(row => row.supervisorId === receipt.supervisorId)
    : state.supervisors.find(row => row.roadmapId === roadmap.id && row.isDefault)
  if (!supervisor) throw new Error(`project create receipt references missing supervisor: ${receipt.idempotencyKey}`)
  const binding = receipt.projectBindingId
    ? state.projectBindings.find(row => row.id === receipt.projectBindingId)
    : state.projectBindings.find(row => row.roadmapId === roadmap.id)
  if (!binding) throw new Error(`project create receipt references missing project binding: ${receipt.idempotencyKey}`)
  const taskIds = new Set(receipt.taskIds)
  const tasks = state.tasks.filter(task => task.roadmapId === roadmap.id && (!taskIds.size || taskIds.has(task.id)))
  return { roadmap, tasks, supervisor, binding }
}

export function createDelegatedWork(input: DelegatedWorkMutationInput, filePath = workStatePath()): DelegatedWorkReceipt {
  return mutateWorkState(filePath, (state, db) => {
    const existing = findDelegationReceiptInDb(db, input.idempotencyKey)
    if (existing) return { ...existing, idempotencyStatus: 'replayed' }

    const now = new Date().toISOString()
    appendWorkEventRow(db, 'delegation.accepted', input.parentSessionId, {
      idempotencyKey: input.idempotencyKey,
      targetType: input.targetType,
      objective: input.objective,
      parentSessionId: input.parentSessionId,
      notificationTarget: input.notificationTarget,
    }, now)

    let roadmap: RoadmapRecord | undefined
    let supervisor: RoadmapSupervisorRecord | undefined
    let binding: ProjectBindingRecord | undefined
    const tasks: WorkTaskRecord[] = []

    if (input.issue) {
      tasks.push(createWorkTaskInState(state, db, input.issue, now))
      roadmap = state.roadmaps.find(row => row.id === input.issue!.roadmapId)
    } else if (input.project) {
      if (input.project.roadmapId) {
        roadmap = state.roadmaps.find(row => row.id === input.project!.roadmapId)
        if (!roadmap) throw new Error(`roadmap not found: ${input.project.roadmapId}`)
        assertRoadmapAcceptsTasks(state, roadmap.id)
        for (const task of normalizeTaskCreateList(input.project.tasks || [])) {
          tasks.push(createWorkTaskInState(state, db, { ...task, roadmapId: roadmap.id }, now))
        }
      } else {
        roadmap = createRoadmapInState(state, db, {
          title: input.project.title || input.objective,
          priority: input.project.priority,
          agentTeam: input.project.agentTeam,
          environment: input.project.environment,
          qualitySpec: input.project.qualitySpec,
        }, now)
        for (const task of normalizeTaskCreateList(input.project.tasks || [])) {
          tasks.push(createWorkTaskInState(state, db, { ...task, roadmapId: roadmap.id }, now))
        }
      }
      if (roadmap) recomputeRoadmapStatusInState(state, roadmap.id, now)
      if (roadmap && input.project.supervisor) {
        supervisor = createRoadmapSupervisorInState(state, { ...input.project.supervisor, roadmapId: roadmap.id }, now)
        reconcileDefaultSupervisorInState(state, supervisor.roadmapId, supervisor.isDefault ? supervisor.supervisorId : undefined, now)
        appendWorkEventRow(db, 'roadmap.supervisor.created', supervisor.roadmapId, { supervisorId: supervisor.supervisorId, sessionId: supervisor.sessionId, profile: supervisor.profile, isDefault: supervisor.isDefault }, now)
      }
      if (roadmap && input.project.binding) {
        binding = upsertProjectBindingInState(state, { ...input.project.binding, roadmapId: roadmap.id }, now)
        if (binding.provider && binding.chatId) {
          upsertChannelBindingRow(db, { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId, mode: 'roadmap', roadmapId: binding.roadmapId, title: binding.title || binding.alias }, now)
          appendWorkEventRow(db, 'channel.binding.upserted', binding.sessionId, { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, mode: 'roadmap', roadmapId: binding.roadmapId }, now)
        }
        appendWorkEventRow(db, 'project.binding.upserted', binding.roadmapId, { bindingId: binding.id, alias: binding.alias, scope: binding.scope, sessionId: binding.sessionId, provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId }, now)
      }
      if (roadmap) appendWorkEventRow(db, 'roadmap.created_with_tasks', roadmap.id, { taskIds: tasks.map(task => task.id), delegated: true }, now)
    } else {
      throw new Error('delegation mutation requires issue or project input')
    }

    const receipt: DelegatedWorkReceipt = {
      idempotencyKey: input.idempotencyKey,
      idempotencyStatus: 'created',
      targetType: input.targetType,
      taskIds: tasks.map(task => task.id),
      roadmapId: roadmap?.id,
      supervisorId: supervisor?.supervisorId,
      projectBindingId: binding?.id,
      parentSessionId: input.parentSessionId,
      links: receiptLinks(roadmap, tasks, supervisor, binding),
      nextSchedulerAction: nextDelegationSchedulerAction(tasks, supervisor),
    }
    upsertDelegationReceiptRow(db, receipt, now)
    appendWorkEventRow(db, 'delegation.mapped', roadmap?.id || tasks[0]?.id || input.parentSessionId, {
      ...receipt,
      idempotencyStatus: 'created',
      idempotencyKey: input.idempotencyKey,
      notificationTarget: input.notificationTarget,
    }, now)
    appendDelegationProgressRow(db, input.idempotencyKey, 'created', receipt.roadmapId || tasks[0]?.id || input.parentSessionId, {
      ...receipt,
      notificationTarget: input.notificationTarget,
      progressKey: delegationProgressKey(input.idempotencyKey, 'created', receipt.roadmapId || tasks.map(task => task.id).join(',')),
      summary: `Delegated work accepted: ${input.objective}`,
    }, now)
    for (const task of tasks.filter(task => task.manualGate)) {
      appendDelegationProgressRow(db, input.idempotencyKey, 'gate_opened', task.id, {
        ...receipt,
        notificationTarget: input.notificationTarget,
        taskId: task.id,
        roadmapId: task.roadmapId,
        status: task.status,
        stage: task.currentStage,
        manualGate: task.manualGate,
        progressKey: delegationProgressKey(input.idempotencyKey, 'gate_opened', task.id, task.manualGate),
        summary: `Delegated work is waiting: ${manualGateReason(task.manualGate!)}`,
      }, now)
    }
    return receipt
  })
}

export function getDelegationReceipt(idempotencyKey: string, filePath = workStatePath()): DelegatedWorkReceipt | undefined {
  return withWorkDb(filePath, db => findDelegationReceiptInDb(db, idempotencyKey))
}

export function updateRoadmap(id: string, input: RoadmapUpdateInput, filePath = workStatePath()): RoadmapRecord | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const roadmap = state.roadmaps.find(row => row.id === id)
    if (!roadmap) return undefined
    const now = new Date().toISOString()
    if (input.title !== undefined) roadmap.title = normalizeRequiredString(input.title, 'title', 200)
    if (input.priority !== undefined) roadmap.priority = normalizePriority(input.priority)
    if (input.agentTeam !== undefined) roadmap.agentTeam = normalizeOptionalAgentTeam(input.agentTeam, 'agentTeam')
    if (input.environment !== undefined) roadmap.environment = input.environment === null ? undefined : normalizeEnvironmentSelector(input.environment, 'roadmap.environment')
    if (input.qualitySpec !== undefined) roadmap.qualitySpec = input.qualitySpec === null ? undefined : normalizeRoadmapQualitySpec(input.qualitySpec)
    if (input.status !== undefined) {
      const status = normalizeRoadmapStatus(input.status)
      if (input.status === 'archived') throw new Error('use roadmap_archive to archive a roadmap and cascade child tasks')
      roadmap.status = status
    }
    roadmap.updatedAt = now
    appendWorkEventRow(db, 'roadmap.updated', roadmap.id, { fields: Object.keys(input), qualitySpec: Boolean(roadmap.qualitySpec) }, now)
    return roadmap
  })
}

export function recomputeRoadmapStatus(roadmapId: string, filePath = workStatePath()): RoadmapRecord | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const now = new Date().toISOString()
    const roadmap = recomputeRoadmapStatusInState(state, roadmapId, now)
    if (!roadmap) return undefined
    appendWorkEventRow(db, 'roadmap.recomputed', roadmap.id, { status: roadmap.status }, now)
    return roadmap
  })
}

export function listRoadmapSupervisors(filter: { roadmapId?: string; status?: RoadmapSupervisorStatus; includeArchived?: boolean } = {}, filePath = workStatePath()): RoadmapSupervisorRecord[] {
  let supervisors = loadWorkState(filePath).supervisors
  if (filter.roadmapId) supervisors = supervisors.filter(supervisor => supervisor.roadmapId === filter.roadmapId)
  if (filter.status) supervisors = supervisors.filter(supervisor => supervisor.status === filter.status)
  else if (!filter.includeArchived) supervisors = supervisors.filter(supervisor => supervisor.status !== 'archived')
  return supervisors.slice().sort(compareRoadmapSupervisors)
}

export function getRoadmapSupervisor(supervisorId: string, filePath = workStatePath()): RoadmapSupervisorRecord | undefined {
  return loadWorkState(filePath).supervisors.find(supervisor => supervisor.supervisorId === supervisorId)
}

export function getDefaultRoadmapSupervisor(roadmapId: string, filePath = workStatePath()): RoadmapSupervisorRecord | undefined {
  return defaultRoadmapSupervisor(loadWorkState(filePath), roadmapId)
}

export function createRoadmapSupervisor(input: RoadmapSupervisorCreateInput, filePath = workStatePath()): RoadmapSupervisorRecord {
  return mutateWorkState(filePath, (state, db) => {
    const now = new Date().toISOString()
    const supervisor = createRoadmapSupervisorInState(state, input, now)
    reconcileDefaultSupervisorInState(state, supervisor.roadmapId, supervisor.isDefault ? supervisor.supervisorId : undefined, now)
    appendWorkEventRow(db, 'roadmap.supervisor.created', supervisor.roadmapId, { supervisorId: supervisor.supervisorId, sessionId: supervisor.sessionId, profile: supervisor.profile, isDefault: supervisor.isDefault }, now)
    return supervisor
  })
}

export function updateRoadmapSupervisor(supervisorId: string, input: RoadmapSupervisorUpdateInput, filePath = workStatePath()): RoadmapSupervisorRecord | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const supervisor = state.supervisors.find(row => row.supervisorId === supervisorId)
    if (!supervisor) return undefined
    const now = new Date().toISOString()
    applyRoadmapSupervisorUpdate(state, supervisor, input, now)
    reconcileDefaultSupervisorInState(state, supervisor.roadmapId, supervisor.isDefault ? supervisor.supervisorId : undefined, now)
    appendWorkEventRow(db, 'roadmap.supervisor.updated', supervisor.roadmapId, { supervisorId, fields: Object.keys(input) }, now)
    return supervisor
  })
}

export function archiveRoadmapSupervisor(supervisorId: string, input: { note?: string } = {}, filePath = workStatePath()): RoadmapSupervisorRecord | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const supervisor = state.supervisors.find(row => row.supervisorId === supervisorId)
    if (!supervisor) return undefined
    const now = new Date().toISOString()
    supervisor.status = 'archived'
    supervisor.isDefault = false
    supervisor.note = normalizeOptionalString(input.note, 5000) || supervisor.note
    supervisor.updatedAt = now
    reconcileDefaultSupervisorInState(state, supervisor.roadmapId, undefined, now)
    appendWorkEventRow(db, 'roadmap.supervisor.archived', supervisor.roadmapId, { supervisorId, note: supervisor.note }, now)
    return supervisor
  })
}

export function acquireDueRoadmapSupervisorWakeups(input: { now?: number; leaseOwner?: string; leaseMs?: number; limit?: number } = {}, filePath = workStatePath()): RoadmapSupervisorWakeupRecord[] {
  return mutateWorkState(filePath, (state, db) => {
    const nowMs = input.now || Date.now()
    const now = new Date(nowMs).toISOString()
    const leaseOwner = normalizeOptionalString(input.leaseOwner, 200) || `supervisor-${process.pid}`
    const leaseMs = Math.max(60 * 1000, Math.min(input.leaseMs || 10 * 60 * 1000, 24 * 60 * 60 * 1000))
    const limit = Math.max(1, Math.min(input.limit || 5, 50))
    const cursors = state.supervisors.map(supervisor => supervisor.lastReviewedEventId || 0)
    const minCursor = cursors.length ? Math.min(...cursors) : 0
    const events = queryRows(db, 'SELECT * FROM events WHERE id > ? ORDER BY id ASC', minCursor).map(rowToEvent)
    const wakeups: RoadmapSupervisorWakeupRecord[] = []

    for (const supervisor of state.supervisors.sort(compareRoadmapSupervisors)) {
      if (wakeups.length >= limit) break
      if (!supervisorEligibleForWakeup(supervisor, nowMs)) continue
      const due = supervisorWakeupReason(state, supervisor, events, nowMs)
      if (!due) continue
      const idempotencyKey = supervisorWakeupIdempotencyKey(supervisor, due)
      supervisor.wakeLeaseOwner = leaseOwner
      supervisor.wakeLeaseExpiresAt = new Date(nowMs + leaseMs).toISOString()
      supervisor.lastWakeAt = now
      supervisor.lastWakeReason = due.wakeReason
      supervisor.lastWakeEventId = due.cursorEventId || supervisor.lastReviewedEventId
      supervisor.updatedAt = now
      const receipt = upsertSupervisorWakeupReceiptRow(db, supervisor, due, { idempotencyKey, leaseOwner, leaseExpiresAt: supervisor.wakeLeaseExpiresAt }, now)
      appendWorkEventRow(db, 'roadmap.supervisor.wakeup_acquired', supervisor.roadmapId, { supervisorId: supervisor.supervisorId, wakeReason: due.wakeReason, reasonDetail: due.reasonDetail, eventIds: due.events.map(event => event.id), cursorEventId: due.cursorEventId, windowKey: due.windowKey, idempotencyKey, receiptId: receipt.id, leaseOwner, leaseExpiresAt: supervisor.wakeLeaseExpiresAt }, now)
      wakeups.push({ supervisor: { ...supervisor }, reason: due.reason, wakeReason: due.wakeReason, wakeReasonDetail: due.reasonDetail, triggerEvents: due.events, cursorEventId: due.cursorEventId, windowKey: due.windowKey, idempotencyKey, leaseOwner, leaseExpiresAt: supervisor.wakeLeaseExpiresAt, receiptId: receipt.id, notificationPolicyRef: supervisor.notificationPolicyRef })
    }
    return wakeups
  })
}

export function completeRoadmapSupervisorWakeup(supervisorId: string, input: { leaseOwner?: string; cursorEventId?: number; success?: boolean; note?: string; inspectedInputs?: string[]; changedObjectIds?: string[]; recommendation?: string; nextAction?: string } = {}, filePath = workStatePath()): RoadmapSupervisorRecord | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const supervisor = state.supervisors.find(row => row.supervisorId === supervisorId)
    if (!supervisor) return undefined
    if (input.leaseOwner && supervisor.wakeLeaseOwner && supervisor.wakeLeaseOwner !== input.leaseOwner) return undefined
    const now = new Date().toISOString()
    const success = input.success !== false
    const wakeLeaseOwner = input.leaseOwner || supervisor.wakeLeaseOwner
    if (success) {
      supervisor.lastReviewedEventId = Math.max(supervisor.lastReviewedEventId || 0, input.cursorEventId || supervisor.lastWakeEventId || 0)
      supervisor.lastReviewAt = now
      const explicitNextReview = Date.parse(supervisor.nextReviewAt || '')
      supervisor.nextReviewAt = Number.isFinite(explicitNextReview) && explicitNextReview > Date.parse(now) ? supervisor.nextReviewAt : nextSupervisorReviewAt(supervisor, Date.parse(now))
    }
    supervisor.wakeLeaseOwner = undefined
    supervisor.wakeLeaseExpiresAt = undefined
    supervisor.note = normalizeOptionalString(input.note, 5000) || supervisor.note
    supervisor.updatedAt = now
    const receipt = completeSupervisorWakeupReceiptRow(db, supervisor, {
      leaseOwner: wakeLeaseOwner,
      status: success ? 'completed' : 'failed',
      summary: input.note,
      inspectedInputs: input.inspectedInputs,
      changedObjectIds: input.changedObjectIds,
      recommendation: input.recommendation,
      nextAction: input.nextAction,
      cursorEventId: supervisor.lastReviewedEventId || input.cursorEventId || supervisor.lastWakeEventId || 0,
      nextWakeAt: supervisor.nextReviewAt,
    }, now)
    appendWorkEventRow(db, success ? 'roadmap.supervisor.wakeup_completed' : 'roadmap.supervisor.wakeup_failed', supervisor.roadmapId, { supervisorId, cursorEventId: supervisor.lastReviewedEventId, note: input.note, receiptId: receipt?.id, idempotencyKey: receipt?.idempotencyKey, wakeReason: receipt?.wakeReason }, now)
    return supervisor
  })
}

export function applyRoadmapSupervisorResult(supervisorId: string, input: RoadmapSupervisorResultApplyInput, filePath = workStatePath()): RoadmapSupervisorResultApplyResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const supervisor = state.supervisors.find(row => row.supervisorId === supervisorId)
    if (!supervisor) return undefined
    if (supervisor.lastResultHash === input.resultHash) {
      return { applied: false, appliedActions: [], rejectedActions: ['duplicate_result'], changedObjectIds: [], recommendation: 'duplicate_result', nextAction: 'No action; this supervisor result was already applied.' }
    }
    if (!input.turn ||
      input.turn.supervisorId !== supervisor.supervisorId ||
      input.turn.roadmapId !== supervisor.roadmapId ||
      input.turn.leaseOwner !== supervisor.wakeLeaseOwner ||
      input.turn.cursorEventId !== (supervisor.lastWakeEventId || supervisor.lastReviewedEventId || 0)) {
      return { applied: false, appliedActions: [], rejectedActions: ['stale_or_mismatched_turn'], changedObjectIds: [], recommendation: 'stale_or_mismatched_turn', nextAction: 'Ignore this supervisor result and wait for a matching turn.' }
    }
    const roadmap = state.roadmaps.find(row => row.id === supervisor.roadmapId)
    if (!roadmap) return undefined

    const now = new Date().toISOString()
    const appliedActions: string[] = []
    const rejectedActions: string[] = []
    const changedObjectIds = new Set<string>([`supervisor:${supervisorId}`, `roadmap:${roadmap.id}`])
    const actions = input.actions.length ? input.actions : [{ type: 'summary', summary: input.summary }]
    let handledTasks = false
    let handledCompletion = false

    for (const action of actions) {
      if (action.type === 'none' || action.type === 'summary') {
        appliedActions.push(action.type)
      } else if (action.type === 'schedule_next_review') {
        if (!input.nextReviewAt) rejectedActions.push('schedule_next_review:invalid_nextReviewAt')
        else {
          applyRoadmapSupervisorUpdate(state, supervisor, { nextReviewAt: input.nextReviewAt }, now)
          appendWorkEventRow(db, 'roadmap.supervisor.updated', supervisor.roadmapId, { supervisorId, fields: ['nextReviewAt'] }, now)
          appliedActions.push('schedule_next_review')
        }
      } else if (action.type === 'block_roadmap') {
        roadmap.status = 'blocked'
        roadmap.updatedAt = now
        appendWorkEventRow(db, 'roadmap.updated', roadmap.id, { fields: ['status'], qualitySpec: Boolean(roadmap.qualitySpec) }, now)
        appliedActions.push('block_roadmap')
      } else if (action.type === 'propose_completion') {
        if (handledCompletion) rejectedActions.push('propose_completion:duplicate_action')
        else if (!input.completion || input.completion.recommendation === 'not_done') rejectedActions.push('propose_completion:no_ready_completion')
        else {
          handledCompletion = true
          const proposal: RoadmapCompletionProposalRecord = {
            id: `completion_${randomUUID()}`,
            roadmapId: roadmap.id,
            proposedBy: supervisorId,
            sessionId: supervisor.sessionId,
            evidence: normalizeStringList(input.completion.evidence, 2000),
            unresolvedRisks: normalizeStringList(input.completion.risks, 2000),
            recommendation: normalizeOptionalString(input.completion.recommendation, 2000) || 'complete',
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          }
          state.completionProposals.push(proposal)
          appendWorkEventRow(db, 'roadmap.completion.proposed', proposal.id, { roadmapId: roadmap.id, proposedBy: proposal.proposedBy, sessionId: proposal.sessionId, evidence: proposal.evidence.length, unresolvedRisks: proposal.unresolvedRisks.length }, now)
          appendDelegationProgressForRoadmap(db, roadmap.id, 'completion_proposed', proposal.id, {
            proposalId: proposal.id,
            roadmapId: roadmap.id,
            status: proposal.status,
            sessionId: proposal.sessionId,
            summary: `Completion proposed for ${roadmap.title}`,
          }, now)
          const policy = roadmap.qualitySpec?.completionPolicy || 'assistant_proposes_user_approves'
          const blockedReasons = completionAutoBlockers(state, db, roadmap, proposal)
          if (policy === 'auto_when_evidence_complete' && blockedReasons.length === 0) {
            approveRoadmapCompletionProposalInState(state, db, proposal, roadmap, { actor: 'gateway.auto', source: 'completion_policy', note: 'auto_when_evidence_complete' }, now)
          } else if (policy === 'auto_when_evidence_complete') {
            appendWorkEventRow(db, 'roadmap.completion.auto_blocked', proposal.id, { roadmapId: roadmap.id, blockedReasons }, now)
          }
          appliedActions.push('propose_completion')
          changedObjectIds.add(`completion_proposal:${proposal.id}`)
        }
      } else if (action.type === 'create_task') {
        if (handledTasks) rejectedActions.push('create_task:duplicate_action')
        else if (!input.proposedTasks.length) rejectedActions.push('create_task:no_proposed_tasks')
        else {
          handledTasks = true
          if ((supervisor.completionPolicy as any)?.allowDirectTaskCreate === true) {
            for (const task of input.proposedTasks) {
              const created = createWorkTaskInState(state, db, { ...task, roadmapId: roadmap.id }, now)
              changedObjectIds.add(`task:${created.id}`)
            }
            appliedActions.push(`create_task:${input.proposedTasks.length}`)
          } else {
            appendWorkEventRow(db, 'roadmap.supervisor.tasks_proposed', roadmap.id, { supervisorId, resultHash: input.resultHash, tasks: input.proposedTasks.map(task => ({ title: task.title, priority: task.priority || 'MEDIUM' })) }, now)
            appliedActions.push(`propose_task:${input.proposedTasks.length}`)
          }
        }
      } else if (action.type === 'ask_question') {
        appendWorkEventRow(db, 'roadmap.supervisor.questions_requested', roadmap.id, { supervisorId, resultHash: input.resultHash, questions: input.questions, summary: action.summary }, now)
        appliedActions.push(`ask_question:${input.questions.length}`)
      } else if (action.type === 'request_permission') {
        appendWorkEventRow(db, 'roadmap.supervisor.permission_requested', roadmap.id, { supervisorId, resultHash: input.resultHash, summary: action.summary }, now)
        appliedActions.push('request_permission')
      } else {
        rejectedActions.push(`${String(action.type)}:unsupported`)
      }
    }

    applyRoadmapSupervisorUpdate(state, supervisor, { note: input.summary, lastResultHash: input.resultHash, lastResultAt: now, lastResultStatus: input.status, lastResultSummary: input.summary }, now)
    appendWorkEventRow(db, 'roadmap.supervisor.updated', supervisor.roadmapId, { supervisorId, fields: ['note', 'lastResultHash', 'lastResultAt', 'lastResultStatus', 'lastResultSummary'] }, now)
    appendWorkEventRow(db, 'roadmap.supervisor.result_applied', roadmap.id, { supervisorId, resultHash: input.resultHash, status: input.status, summary: input.summary, appliedActions, rejectedActions }, now)
    if (rejectedActions.length) appendWorkEventRow(db, 'roadmap.supervisor.action_rejected', roadmap.id, { supervisorId, resultHash: input.resultHash, rejectedActions }, now)

    const success = input.status !== 'failed'
    const wakeLeaseOwner = input.turn.leaseOwner || supervisor.wakeLeaseOwner
    if (success) {
      supervisor.lastReviewedEventId = Math.max(supervisor.lastReviewedEventId || 0, input.turn.cursorEventId || supervisor.lastWakeEventId || 0)
      supervisor.lastReviewAt = now
      const explicitNextReview = Date.parse(supervisor.nextReviewAt || '')
      supervisor.nextReviewAt = Number.isFinite(explicitNextReview) && explicitNextReview > Date.parse(now) ? supervisor.nextReviewAt : nextSupervisorReviewAt(supervisor, Date.parse(now))
    }
    supervisor.wakeLeaseOwner = undefined
    supervisor.wakeLeaseExpiresAt = undefined
    supervisor.note = normalizeOptionalString(input.summary, 5000) || supervisor.note
    supervisor.updatedAt = now
    const changedIds = [...changedObjectIds]
    const receipt = completeSupervisorWakeupReceiptRow(db, supervisor, {
      leaseOwner: wakeLeaseOwner,
      status: success ? 'completed' : 'failed',
      summary: input.summary,
      inspectedInputs: [`supervisor:${supervisor.supervisorId}`, `roadmap:${supervisor.roadmapId}`, `cursor:${input.turn.cursorEventId}`, `supervisor_result:${input.resultHash}`],
      changedObjectIds: changedIds,
      recommendation: input.recommendation,
      nextAction: input.nextAction,
      cursorEventId: supervisor.lastReviewedEventId || input.turn.cursorEventId || supervisor.lastWakeEventId || 0,
      nextWakeAt: supervisor.nextReviewAt,
    }, now)
    appendWorkEventRow(db, success ? 'roadmap.supervisor.wakeup_completed' : 'roadmap.supervisor.wakeup_failed', supervisor.roadmapId, { supervisorId, cursorEventId: supervisor.lastReviewedEventId, note: input.summary, receiptId: receipt?.id, idempotencyKey: receipt?.idempotencyKey, wakeReason: receipt?.wakeReason }, now)

    return { applied: true, appliedActions, rejectedActions, changedObjectIds: changedIds, recommendation: input.recommendation, nextAction: input.nextAction }
  })
}

export function listSupervisorWakeupReceipts(filter: { supervisorId?: string; roadmapId?: string; status?: SupervisorWakeupReceiptStatus; limit?: number } = {}, filePath = workStatePath()): SupervisorWakeupReceiptRecord[] {
  return withWorkDb(filePath, db => {
    const clauses: string[] = []
    const values: unknown[] = []
    if (filter.supervisorId) {
      clauses.push('supervisor_id = ?')
      values.push(filter.supervisorId)
    }
    if (filter.roadmapId) {
      clauses.push('roadmap_id = ?')
      values.push(filter.roadmapId)
    }
    if (filter.status) {
      clauses.push('status = ?')
      values.push(filter.status)
    }
    const limit = Math.max(1, Math.min(filter.limit || 100, 500))
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = queryRows(db, `SELECT * FROM supervisor_wakeup_receipts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, ...values, limit)
    return rows.map(rowToSupervisorWakeupReceipt).filter(Boolean) as SupervisorWakeupReceiptRecord[]
  })
}

export function listProjectBindings(filter: { alias?: string; roadmapId?: string; sessionId?: string; scope?: ProjectBindingScope; provider?: string; chatId?: string; threadId?: string } = {}, filePath = workStatePath()): ProjectBindingRecord[] {
  return filterProjectBindings(loadWorkState(filePath).projectBindings, filter)
}

function filterProjectBindings(bindings: ProjectBindingRecord[], filter: { alias?: string; roadmapId?: string; sessionId?: string; scope?: ProjectBindingScope; provider?: string; chatId?: string; threadId?: string } = {}): ProjectBindingRecord[] {
  if (filter.alias) bindings = bindings.filter(binding => binding.alias === normalizeProjectAlias(filter.alias!))
  if (filter.roadmapId) bindings = bindings.filter(binding => binding.roadmapId === filter.roadmapId)
  if (filter.sessionId) bindings = bindings.filter(binding => binding.sessionId === filter.sessionId)
  if (filter.scope) bindings = bindings.filter(binding => binding.scope === filter.scope)
  if (filter.provider) bindings = bindings.filter(binding => binding.provider === filter.provider)
  if (filter.chatId) bindings = bindings.filter(binding => binding.chatId === filter.chatId)
  if (filter.threadId !== undefined) bindings = bindings.filter(binding => (binding.threadId || '') === normalizeThreadId(filter.threadId))
  return bindings.slice().sort(compareProjectBindings)
}

export function getProjectBinding(id: string, filePath = workStatePath()): ProjectBindingRecord | undefined {
  return loadWorkState(filePath).projectBindings.find(binding => binding.id === id)
}

export function listRoadmapCompletionProposals(filter: { roadmapId?: string; status?: RoadmapCompletionProposalStatus | 'open' } = {}, filePath = workStatePath()): RoadmapCompletionProposalRecord[] {
  let proposals = loadWorkState(filePath).completionProposals
  if (filter.roadmapId) proposals = proposals.filter(proposal => proposal.roadmapId === filter.roadmapId)
  if (filter.status === 'open') proposals = proposals.filter(proposal => proposal.status === 'pending')
  else if (filter.status) proposals = proposals.filter(proposal => proposal.status === filter.status)
  return proposals.slice().sort(compareRoadmapCompletionProposals)
}

export function getRoadmapCompletionProposal(id: string, filePath = workStatePath()): RoadmapCompletionProposalRecord | undefined {
  return loadWorkState(filePath).completionProposals.find(proposal => proposal.id === id)
}

export function proposeRoadmapCompletion(input: RoadmapCompletionProposalInput, filePath = workStatePath()): RoadmapCompletionProposalDecisionResult {
  return mutateWorkState(filePath, (state, db) => {
    const now = new Date().toISOString()
    const roadmapId = normalizeRequiredString(input.roadmapId, 'roadmapId', 120)
    const roadmap = state.roadmaps.find(row => row.id === roadmapId)
    if (!roadmap) throw new Error(`roadmap not found: ${roadmapId}`)
    if (roadmap.status === 'archived') throw new Error(`roadmap is archived: ${roadmapId}`)
    const proposal: RoadmapCompletionProposalRecord = {
      id: `completion_${randomUUID()}`,
      roadmapId,
      proposedBy: normalizeOptionalString(input.proposedBy, 200),
      sessionId: normalizeOptionalString(input.sessionId, 200),
      evidence: normalizeStringList(input.evidence, 2000),
      unresolvedRisks: normalizeStringList(input.unresolvedRisks, 2000),
      recommendation: normalizeOptionalString(input.recommendation, 2000) || 'complete',
      status: 'pending',
      expiresAt: normalizeOptionalIsoTime(input.expiresAt, 'expiresAt'),
      createdAt: now,
      updatedAt: now,
    }
    state.completionProposals.push(proposal)
    appendWorkEventRow(db, 'roadmap.completion.proposed', proposal.id, { roadmapId, proposedBy: proposal.proposedBy, sessionId: proposal.sessionId, evidence: proposal.evidence.length, unresolvedRisks: proposal.unresolvedRisks.length }, now)
    appendDelegationProgressForRoadmap(db, roadmapId, 'completion_proposed', proposal.id, {
      proposalId: proposal.id,
      roadmapId,
      status: proposal.status,
      sessionId: proposal.sessionId,
      summary: `Completion proposed for ${roadmap.title}`,
    }, now)

    const policy = roadmap.qualitySpec?.completionPolicy || 'assistant_proposes_user_approves'
    const blockedReasons = completionAutoBlockers(state, db, roadmap, proposal)
    if (policy === 'auto_when_evidence_complete' && blockedReasons.length === 0) {
      approveRoadmapCompletionProposalInState(state, db, proposal, roadmap, { actor: 'gateway.auto', source: 'completion_policy', note: 'auto_when_evidence_complete' }, now)
    } else if (policy === 'auto_when_evidence_complete') {
      appendWorkEventRow(db, 'roadmap.completion.auto_blocked', proposal.id, { roadmapId, blockedReasons }, now)
    }
    return { proposal, roadmap, blockedReasons }
  })
}

export function decideRoadmapCompletionProposal(id: string, input: RoadmapCompletionProposalDecisionInput, filePath = workStatePath()): RoadmapCompletionProposalDecisionResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const proposal = state.completionProposals.find(row => row.id === id)
    if (!proposal) return undefined
    const roadmap = state.roadmaps.find(row => row.id === proposal.roadmapId)
    if (!roadmap) return undefined
    if (proposal.status !== 'pending') return { proposal, roadmap, blockedReasons: [] }
    const now = new Date().toISOString()
    const actor = normalizeOptionalString(input.actor, 200) || 'operator'
    const source = normalizeOptionalString(input.source, 200) || 'gateway'
    const note = normalizeOptionalString(input.note, 2000)
    if (input.decision === 'approve') {
      approveRoadmapCompletionProposalInState(state, db, proposal, roadmap, { actor, source, note }, now)
      return { proposal, roadmap, blockedReasons: [] }
    }
    proposal.status = 'rejected'
    proposal.decisionBy = actor
    proposal.decisionNote = note
    proposal.updatedAt = now
    const supervisor = defaultRoadmapSupervisor(state, roadmap.id)
    if (supervisor && supervisor.status === 'active') {
      supervisor.nextReviewAt = now
      supervisor.note = note || 'Completion proposal rejected; review follow-up needed.'
      supervisor.updatedAt = now
    }
    appendWorkEventRow(db, 'roadmap.completion.rejected', proposal.id, { roadmapId: roadmap.id, actor, source, note, nextReviewAt: supervisor?.nextReviewAt }, now)
    appendWorkEventRow(db, 'audit.human_decision', roadmap.id, { actor, source, operation: 'roadmap_completion.reject', target: proposal.id, result: 'ok', note }, now)
    return { proposal, roadmap, blockedReasons: [] }
  })
}

export function upsertProjectBinding(input: ProjectBindingInput, filePath = workStatePath()): ProjectBindingRecord {
  return mutateWorkState(filePath, (state, db) => {
    const now = new Date().toISOString()
    const previous = state.projectBindings.slice()
    const binding = upsertProjectBindingInState(state, input, now)
    for (const stale of previous.filter(row => row.id !== binding.id && !state.projectBindings.some(current => current.id === row.id))) deleteProjectBindingChannelRow(db, stale)
    if (binding.provider && binding.chatId) {
      upsertChannelBindingRow(db, { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId, mode: 'roadmap', roadmapId: binding.roadmapId, title: binding.title || binding.alias }, now)
      appendWorkEventRow(db, 'channel.binding.upserted', binding.sessionId, { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, mode: 'roadmap', roadmapId: binding.roadmapId }, now)
    }
    appendWorkEventRow(db, 'project.binding.upserted', binding.roadmapId, { bindingId: binding.id, alias: binding.alias, scope: binding.scope, sessionId: binding.sessionId, provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId }, now)
    return binding
  })
}

export function updateProjectBinding(id: string, input: ProjectBindingUpdateInput, filePath = workStatePath()): ProjectBindingRecord | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const existing = state.projectBindings.find(binding => binding.id === id)
    if (!existing) return undefined
    const now = new Date().toISOString()
    const scope = input.scope ?? existing.scope
    const channelScoped = scope === 'telegram' || scope === 'whatsapp' || scope === 'discord'
    const binding = upsertProjectBindingInState(state, {
      alias: input.alias ?? existing.alias,
      roadmapId: input.roadmapId ?? existing.roadmapId,
      sessionId: input.sessionId ?? existing.sessionId,
      scope,
      provider: input.provider === null || !channelScoped ? undefined : input.provider ?? existing.provider,
      chatId: input.chatId === null || !channelScoped ? undefined : input.chatId ?? existing.chatId,
      threadId: input.threadId === null || !channelScoped ? undefined : input.threadId ?? existing.threadId,
      title: input.title === null ? undefined : input.title ?? existing.title,
      allowRebind: input.allowRebind ?? true,
      notificationMode: input.notificationMode ?? existing.notificationMode,
      mutedUntil: input.mutedUntil === null ? undefined : input.mutedUntil ?? existing.mutedUntil,
      quietHours: input.quietHours === null ? {} : input.quietHours ?? existing.quietHours,
      lastDigestAt: input.lastDigestAt === null ? undefined : input.lastDigestAt ?? existing.lastDigestAt,
    }, now, id)
    if (projectBindingChannelChanged(existing, binding)) deleteProjectBindingChannelRow(db, existing)
    if (binding.provider && binding.chatId) {
      upsertChannelBindingRow(db, { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId, mode: 'roadmap', roadmapId: binding.roadmapId, title: binding.title || binding.alias }, now)
      appendWorkEventRow(db, 'channel.binding.upserted', binding.sessionId, { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, mode: 'roadmap', roadmapId: binding.roadmapId }, now)
    }
    appendWorkEventRow(db, 'project.binding.updated', binding.roadmapId, { bindingId: binding.id, fields: Object.keys(input) }, now)
    return binding
  })
}

export function deleteProjectBinding(id: string, filePath = workStatePath()): boolean {
  return mutateWorkState(filePath, (state, db) => {
    const existing = state.projectBindings.find(binding => binding.id === id)
    if (!existing) return false
    state.projectBindings = state.projectBindings.filter(binding => binding.id !== id)
    deleteProjectBindingChannelRow(db, existing)
    appendWorkEventRow(db, 'project.binding.deleted', existing.roadmapId, { bindingId: id, alias: existing.alias, scope: existing.scope }, new Date().toISOString())
    return true
  })
}

export function resolveProjectContext(input: { alias?: string; roadmapId?: string; provider?: string; chatId?: string; threadId?: string; sessionId?: string }, filePath = workStatePath()): ProjectContextResolution {
  const state = loadWorkState(filePath)
  const chatMatch = input.provider && input.chatId
    ? state.projectBindings.find(binding => binding.provider === input.provider && binding.chatId === input.chatId && (binding.threadId || '') === normalizeThreadId(input.threadId))
    : undefined
  if (chatMatch) return resolvedProjectContext(state, chatMatch, 'bound chat/thread context')

  if (input.alias) {
    const alias = normalizeProjectAlias(input.alias)
    const matches = state.projectBindings.filter(binding => binding.alias === alias).sort(compareProjectBindings)
    if (matches.length === 1) return resolvedProjectContext(state, matches[0]!, 'explicit alias')
    if (matches.length > 1) return { status: 'ambiguous', reason: `Alias ${alias} matches ${matches.length} project bindings; specify a scope or roadmap ID.`, candidates: matches }
    return { status: 'not_found', reason: `Project alias not found: ${alias}` }
  }

  if (input.sessionId) {
    const matches = state.projectBindings.filter(binding => binding.sessionId === input.sessionId).sort(compareProjectBindings)
    if (matches.length === 1) return resolvedProjectContext(state, matches[0]!, 'explicit session context')
    if (matches.length > 1) return { status: 'ambiguous', reason: `Session ${input.sessionId} has ${matches.length} project bindings; specify an alias or roadmap ID.`, candidates: matches }
    return { status: 'not_found', reason: `Project binding not found for session: ${input.sessionId}` }
  }

  if (input.roadmapId) {
    const roadmap = state.roadmaps.find(row => row.id === input.roadmapId)
    if (!roadmap) return { status: 'not_found', reason: `Roadmap not found: ${input.roadmapId}` }
    const binding = state.projectBindings.filter(row => row.roadmapId === roadmap.id).sort(compareProjectBindings)[0]
    return { status: 'resolved', reason: 'explicit roadmap ID', binding, roadmap, supervisor: defaultRoadmapSupervisor(state, roadmap.id) }
  }

  const activeSupervisors = state.supervisors.filter(supervisor => supervisor.status === 'active').sort(compareRoadmapSupervisors)
  if (activeSupervisors.length === 1) {
    const supervisor = activeSupervisors[0]!
    const roadmap = state.roadmaps.find(row => row.id === supervisor.roadmapId)
    const binding = state.projectBindings.filter(row => row.roadmapId === supervisor.roadmapId).sort(compareProjectBindings)[0]
    return roadmap ? { status: 'resolved', reason: 'single active supervisor session', binding, roadmap, supervisor } : { status: 'not_found', reason: `Supervisor roadmap not found: ${supervisor.roadmapId}` }
  }
  if (activeSupervisors.length > 1) return { status: 'ambiguous', reason: `Multiple active roadmap supervisors exist; specify an alias or roadmap ID.`, candidates: state.projectBindings.filter(binding => activeSupervisors.some(supervisor => supervisor.roadmapId === binding.roadmapId)).sort(compareProjectBindings) }
  return { status: 'not_found', reason: 'No project context could be resolved.' }
}

export function archiveRoadmap(roadmapId: string, input: { note?: string } = {}, filePath = workStatePath()): RoadmapArchiveResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const roadmap = state.roadmaps.find(row => row.id === roadmapId)
    if (!roadmap) return undefined
    const now = new Date().toISOString()
    const note = normalizeOptionalString(input.note, 5000)
    const tasks = state.tasks.filter(task => task.roadmapId === roadmapId)
    const supervisors = state.supervisors.filter(supervisor => supervisor.roadmapId === roadmapId && supervisor.status !== 'archived')
    const abortedSessionIds = new Set<string>()
    roadmap.status = 'archived'
    roadmap.updatedAt = now
    for (const task of tasks) {
      const aborted = abortActiveRunInState(state, db, task, 'archive', note, now)
      if (aborted) abortedSessionIds.add(aborted)
      task.status = 'archived'
      task.currentRunId = undefined
      task.currentStage = undefined
      task.note = note || task.note
      task.updatedAt = now
    }
    for (const supervisor of supervisors) {
      supervisor.status = 'archived'
      supervisor.isDefault = false
      supervisor.note = note || supervisor.note
      supervisor.updatedAt = now
      appendWorkEventRow(db, 'roadmap.supervisor.archived', roadmap.id, { supervisorId: supervisor.supervisorId, reason: 'roadmap_archived' }, now)
    }
    appendWorkEventRow(db, 'roadmap.archived', roadmap.id, { taskIds: tasks.map(task => task.id), supervisorIds: supervisors.map(supervisor => supervisor.supervisorId), abortedSessionIds: [...abortedSessionIds] }, now)
    return { roadmap, tasks, supervisors, abortedSessionIds: [...abortedSessionIds] }
  })
}

export function deleteRoadmap(roadmapId: string, filePath = workStatePath()): RoadmapDeleteResult {
  return mutateWorkState(filePath, (state, db) => {
    const roadmap = state.roadmaps.find(row => row.id === roadmapId)
    if (!roadmap) return { deleted: false, taskIds: [], supervisorIds: [], projectBindingIds: [], completionProposalIds: [], abortedSessionIds: [] }
    const now = new Date().toISOString()
    const tasks = state.tasks.filter(task => task.roadmapId === roadmapId)
    const taskIds = new Set(tasks.map(task => task.id))
    assertNoUnsettledTaskDispatchAcquisitions(db, taskIds)
    const supervisorIds = state.supervisors.filter(supervisor => supervisor.roadmapId === roadmapId).map(supervisor => supervisor.supervisorId)
    const projectBindings = state.projectBindings.filter(binding => binding.roadmapId === roadmapId)
    const projectBindingIds = projectBindings.map(binding => binding.id)
    const completionProposalIds = state.completionProposals.filter(proposal => proposal.roadmapId === roadmapId).map(proposal => proposal.id)
    const abortedSessionIds = activeRunSessionIdsForTasks(state, taskIds)
    state.runs = state.runs.filter(run => !taskIds.has(run.taskId))
    state.dependencies = (state.dependencies || []).filter(dependency => !taskIds.has(dependency.taskId) && !taskIds.has(dependency.dependsOnTaskId))
    // The live window only materializes a task's recent runs, so drop the
    // task's full run history directly in SQL — the per-row sync would only
    // delete the windowed subset and orphan older terminal runs otherwise.
    const deleteRunsForTask = db.prepare('DELETE FROM runs WHERE task_id = ?')
    const deleteRunCountersForTask = db.prepare('DELETE FROM task_run_counters WHERE task_id = ?')
    for (const taskId of taskIds) {
      deleteRunsForTask.run(taskId)
      deleteRunCountersForTask.run(taskId)
    }
    cleanupDeletedTaskReferences(db, taskIds)
    db.prepare('DELETE FROM channel_bindings WHERE roadmap_id = ?').run(roadmapId)
    db.prepare('DELETE FROM human_gates WHERE roadmap_id = ?').run(roadmapId)
    db.prepare('DELETE FROM supervisor_wakeup_receipts WHERE roadmap_id = ?').run(roadmapId)
    updateDelegationReceiptsForDeletion(db, taskIds, {
      roadmapId,
      supervisorIds: new Set(supervisorIds),
      projectBindingIds: new Set(projectBindingIds),
    })
    state.tasks = state.tasks.filter(task => !taskIds.has(task.id))
    state.supervisors = state.supervisors.filter(supervisor => supervisor.roadmapId !== roadmapId)
    state.projectBindings = state.projectBindings.filter(binding => binding.roadmapId !== roadmapId)
    state.completionProposals = state.completionProposals.filter(proposal => proposal.roadmapId !== roadmapId)
    state.roadmaps = state.roadmaps.filter(row => row.id !== roadmapId)
    for (const binding of projectBindings) deleteProjectBindingChannelRow(db, binding)
    appendWorkEventRow(db, 'roadmap.deleted', roadmap.id, { title: roadmap.title, taskIds: [...taskIds], supervisorIds, projectBindingIds, completionProposalIds, abortedSessionIds }, now)
    return { deleted: true, roadmap, taskIds: [...taskIds], supervisorIds, projectBindingIds, completionProposalIds, abortedSessionIds }
  })
}

export function createWorkTask(input: WorkTaskCreateInput, filePath = workStatePath()): WorkTaskRecord {
  return mutateWorkState(filePath, (state, db) => {
    return createWorkTaskInState(state, db, input, new Date().toISOString())
  })
}

export function createWorkTasks(inputs: WorkTaskCreateInput[], defaultRoadmapId?: string, filePath = workStatePath()): WorkTaskRecord[] {
  return mutateWorkState(filePath, (state, db) => {
    const now = new Date().toISOString()
    return normalizeTaskCreateList(inputs).map(input => createWorkTaskInState(state, db, { ...input, roadmapId: input.roadmapId || defaultRoadmapId }, now))
  })
}

export function getWorkTask(id: string, filePath = workStatePath()): WorkTaskView | undefined {
  return listWorkTaskViews(loadWorkState(filePath)).find(task => task.id === id)
}

export function getRun(id: string, filePath = workStatePath()): RunRecord | undefined {
  // Targeted run-detail read: hit the runs table by id/session directly instead
  // of materializing the entire WorkState, so run detail stays O(1) and remains
  // correct regardless of how much run history exists (or how it may be windowed
  // out of the hot state in a future change).
  return withWorkDb(filePath, db => getRunFromDb(db, id))
}

export function getRunFromDb(db: DatabaseSync, id: string): RunRecord | undefined {
  const row = getRow(db, 'SELECT * FROM runs WHERE id = ? OR session_id = ? ORDER BY started_at ASC LIMIT 1', id, id)
  if (!row) return undefined
  return rowToRun(row) ?? undefined
}

/**
 * Task statuses that are terminal for run-cap purposes: a task in one of these
 * can never dispatch another run, so it can never be a live runaway. The
 * stuck-task read excludes these; live/retryable states (`pending`, `running`,
 * `blocked`, `paused`) stay in scope.
 */
export const TERMINAL_WORK_TASK_STATUSES: readonly WorkStatus[] = ['done', 'cancelled', 'archived']

export function updateWorkTask(id: string, input: WorkTaskUpdateInput, filePath = workStatePath()): WorkTaskRecord | undefined {
  return updateWorkTaskWithResult(id, input, filePath)?.task
}

export function updateWorkTaskWithResult(id: string, input: WorkTaskUpdateInput, filePath = workStatePath()): WorkTaskUpdateResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const task = state.tasks.find(row => row.id === id)
    if (!task) return undefined
    validateTaskUpdate(state, task, input)
    const oldRoadmapId = task.roadmapId
    const nextStatus = input.status
    const now = new Date().toISOString()
    const abortedSessionId = nextStatus && shouldAbortActiveRunForTaskStatus(nextStatus)
      ? abortActiveRunInState(state, db, task, nextStatus, input.note, now)
      : undefined
    applyTaskUpdate(task, input)
    recomputeRoadmapStatusInState(state, oldRoadmapId)
    if (task.roadmapId !== oldRoadmapId) recomputeRoadmapStatusInState(state, task.roadmapId)
    appendWorkEventRow(db, 'task.updated', task.id, { fields: Object.keys(input), abortedSessionId }, new Date().toISOString())
    if (task.manualGate) {
      insertHumanGateRow(db, humanGateInputForManualTask(task), new Date().toISOString(), { force: false })
      appendDelegationProgressForTask(db, task, 'gate_opened', {
        manualGate: task.manualGate,
        status: task.status,
        stage: task.currentStage,
        summary: `Delegated work is waiting: ${manualGateReason(task.manualGate)}`,
      }, new Date().toISOString(), task.manualGate)
    }
    return { task, abortedSessionId }
  })
}

export function updateWorkTasks(inputs: WorkTaskBulkUpdateInput[], filePath = workStatePath()): { tasks: WorkTaskRecord[]; abortedSessionIds: string[] } {
  return mutateWorkState(filePath, (state, db) => {
    const updates = normalizeTaskUpdateList(inputs)
    const tasks: WorkTaskRecord[] = []
    const abortedSessionIds = new Set<string>()
    for (const input of updates) {
      const task = state.tasks.find(row => row.id === input.taskId)
      if (!task) throw new Error(`task not found: ${input.taskId}`)
      validateTaskUpdate(state, task, input)
    }
    for (const input of updates) {
      const task = state.tasks.find(row => row.id === input.taskId)!
      const oldRoadmapId = task.roadmapId
      const nextStatus = input.status
      const abortedSessionId = nextStatus && shouldAbortActiveRunForTaskStatus(nextStatus)
        ? abortActiveRunInState(state, db, task, nextStatus, input.note, new Date().toISOString())
        : undefined
      if (abortedSessionId) abortedSessionIds.add(abortedSessionId)
      applyTaskUpdate(task, input)
      recomputeRoadmapStatusInState(state, oldRoadmapId)
      if (task.roadmapId !== oldRoadmapId) recomputeRoadmapStatusInState(state, task.roadmapId)
      appendWorkEventRow(db, 'task.updated.bulk', task.id, { fields: Object.keys(input).filter(key => key !== 'taskId'), abortedSessionId }, new Date().toISOString())
      if (task.manualGate) {
        insertHumanGateRow(db, humanGateInputForManualTask(task), new Date().toISOString(), { force: false })
        appendDelegationProgressForTask(db, task, 'gate_opened', {
          manualGate: task.manualGate,
          status: task.status,
          stage: task.currentStage,
          summary: `Delegated work is waiting: ${manualGateReason(task.manualGate)}`,
        }, new Date().toISOString(), task.manualGate)
      }
      tasks.push(task)
    }
    return { tasks, abortedSessionIds: [...abortedSessionIds] }
  })
}

export function applyWorkTaskAction(id: string, action: WorkTaskAction, input: { stage?: string; note?: string } = {}, filePath = workStatePath()): WorkTaskActionResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const task = state.tasks.find(row => row.id === id)
    if (!task) return undefined
    action = normalizeWorkTaskAction(action)
    const note = normalizeOptionalString(input.note, 5000)
    const stage = input.stage ? normalizeStage(input.stage, 'stage') : undefined
    const now = new Date().toISOString()
    const abortedSessionId = ['pause', 'cancel', 'retry', 'done', 'block'].includes(action)
      ? abortActiveRunInState(state, db, task, action, note, now)
      : undefined
    if ((action === 'resume' || action === 'retry') && stage) assertStageInPipeline(task, stage)

    if (action === 'pause') {
      task.status = 'paused'
      task.currentRunId = undefined
      task.note = note || task.note
    } else if (action === 'resume') {
      task.status = 'pending'
      task.currentRunId = undefined
      task.currentStage = stage || task.currentStage || task.pipeline[0] || 'implement'
      task.earliestStartAt = undefined
      task.note = note || task.note
    } else if (action === 'cancel') {
      task.status = 'cancelled'
      task.currentRunId = undefined
      task.currentStage = undefined
      task.note = note || 'Cancelled by Gateway'
    } else if (action === 'retry') {
      task.status = 'pending'
      task.currentRunId = undefined
      task.currentStage = stage || task.pipeline[0] || 'implement'
      task.earliestStartAt = undefined
      task.note = note || task.note
    } else if (action === 'done') {
      task.status = 'done'
      task.currentRunId = undefined
      task.currentStage = undefined
      task.note = note || task.note
    } else if (action === 'block') {
      task.status = 'blocked'
      task.currentRunId = undefined
      task.currentStage = undefined
      task.note = note || 'Blocked by Gateway'
    }
    task.updatedAt = now
    recomputeRoadmapStatusInState(state, task.roadmapId, now)
    appendWorkEventRow(db, `task.${action}`, task.id, { note, stage, abortedSessionId }, now)
    if (action === 'done') appendDelegationProgressForTask(db, task, 'completed', { note, status: task.status, summary: `Delegated task completed: ${task.title}` }, now)
    else if (action === 'block') appendDelegationProgressForTask(db, task, 'blocked', { note, status: task.status, summary: `Delegated task blocked: ${note || task.note || task.title}` }, now)
    else if (action === 'cancel') appendDelegationProgressForTask(db, task, 'failed', { note, status: task.status, summary: `Delegated task cancelled: ${task.title}` }, now)
    return { task, abortedSessionId }
  })
}

export function listActiveRunControlSnapshots(state: WorkState = loadWorkState(), events: WorkEventRecord[] = [], now = Date.now()): ActiveRunControlSnapshot[] {
  return state.runs
    .filter(run => isActiveRunStatus(run.status))
    .map(run => activeRunControlSnapshot(state, run, now, lastOperatorActionForRun(events, run.id)))
    .filter((snapshot): snapshot is ActiveRunControlSnapshot => Boolean(snapshot))
}

export function applyActiveRunControl(input: ActiveRunControlInput, filePath = workStatePath()): ActiveRunControlResult {
  return mutateWorkState(filePath, (state, db) => {
    const nowMs = input.now || Date.now()
    const now = new Date(nowMs).toISOString()
    const actor = normalizeOptionalString(input.actor, 120) || 'local-operator'
    const source = normalizeOptionalString(input.source, 120) || 'operator-control'
    const action = normalizeActiveRunControlAction(input.action)
    const note = normalizeOptionalString(input.note, 5000)
    const expectedLeaseOwner = normalizeOptionalString(input.expectedLeaseOwner, 200)
    const expectedSchedulerGeneration = normalizeOptionalString(input.expectedSchedulerGeneration, 120)
    // The live window materializes every active run, but a terminal run older
    // than the window is absent. Fall back to a by-id DB lookup so an aged-out
    // terminal run classifies as run_not_active/no_op (as the pre-windowing
    // full-scope read did) instead of the misleading run_not_found; a truly
    // absent id still returns undefined → run_not_found.
    const run = state.runs.find(row => row.id === input.runId) ?? getRunFromDb(db, input.runId)
    const task = run ? state.tasks.find(row => row.id === run.taskId) : undefined
    const before = run ? activeRunControlSnapshot(state, run, nowMs) : undefined

    const denied = (reason: ActiveRunControlReason, outcome: ActiveRunControlOutcome = reason === 'run_not_active' ? 'no_op' : 'denied'): ActiveRunControlResult => {
      appendWorkEventRow(db, 'task.run.operator_controlled', run?.taskId || input.runId, {
        runId: input.runId,
        taskId: run?.taskId,
        action,
        actor,
        source,
        outcome,
        reason,
        leaseOwner: run?.leaseOwner,
        leaseExpiresAt: run?.leaseExpiresAt,
        schedulerGeneration: run?.schedulerGeneration,
      }, now)
      return {
        action,
        outcome,
        reason,
        applied: false,
        run,
        task,
        before,
        restartBehavior: restartBehaviorForAction(action, false),
        nextAction: activeRunControlNextAction(action, reason),
      }
    }

    if (!run) return denied('run_not_found')
    if (!task) return denied('task_not_found')
    if (!isActiveRunStatus(run.status)) return denied('run_not_active', 'no_op')
    if (!isTaskActiveStatus(task.status) || task.currentRunId !== run.id) return denied('task_not_owned_by_run')
    if (!run.leaseOwner || !run.leaseExpiresAt) return denied('lease_missing')
    if (isExpiredLease(run.leaseExpiresAt, nowMs)) return denied('lease_expired')
    if (expectedLeaseOwner && expectedLeaseOwner !== run.leaseOwner) return denied('lease_owner_mismatch')
    if (expectedSchedulerGeneration && expectedSchedulerGeneration !== run.schedulerGeneration) return denied('scheduler_generation_mismatch')

    const abortedSessionId = abortActiveRunInState(state, db, task, `operator.${action}`, note, now)
    const nextStage = action === 'retry' || action === 'restart' ? run.stage || task.currentStage || task.pipeline[0] || 'implement' : undefined
    if (action === 'cancel') {
      task.status = 'cancelled'
      task.currentRunId = undefined
      task.currentStage = undefined
      task.note = note || 'Cancelled by local operator'
    } else if (action === 'stop') {
      task.status = 'blocked'
      task.currentRunId = undefined
      task.currentStage = undefined
      task.note = note || 'Stopped by local operator'
    } else {
      task.status = 'pending'
      task.currentRunId = undefined
      task.currentStage = nextStage
      task.earliestStartAt = undefined
      task.note = note || (action === 'restart'
        ? 'Restart requested by local operator; Gateway will create a new OpenCode session on the next scheduler dispatch.'
        : 'Retry requested by local operator; Gateway requeued durable work for the same stage.')
    }
    task.updatedAt = now
    recomputeRoadmapStatusInState(state, task.roadmapId, now)
    const after = activeRunControlSnapshot(state, run, nowMs, { action, outcome: 'applied', reason: 'applied', actor, source, at: now })
    appendWorkEventRow(db, 'task.run.operator_controlled', task.id, {
      runId: run.id,
      taskId: task.id,
      action,
      actor,
      source,
      outcome: 'applied',
      reason: 'applied',
      note,
      stage: run.stage,
      nextStage,
      sessionId: run.sessionId,
      abortedSessionId,
      taskStatus: task.status,
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
      schedulerGeneration: run.schedulerGeneration,
      restartBehavior: restartBehaviorForAction(action, true),
    }, now)
    if (action === 'cancel') appendDelegationProgressForTask(db, task, 'failed', { note, status: task.status, summary: `Delegated task cancelled: ${task.title}` }, now, run.id)
    if (action === 'stop') appendDelegationProgressForTask(db, task, 'blocked', { note, status: task.status, summary: `Delegated task stopped: ${task.title}` }, now, run.id)
    return {
      action,
      outcome: 'applied',
      reason: 'applied',
      applied: true,
      run,
      task,
      before,
      after,
      abortedSessionId,
      restartBehavior: restartBehaviorForAction(action, true),
      nextAction: activeRunControlNextAction(action, 'applied'),
    }
  })
}

export function archiveWorkTask(id: string, input: { note?: string } = {}, filePath = workStatePath()): WorkTaskArchiveResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const task = state.tasks.find(row => row.id === id)
    if (!task) return undefined
    const now = new Date().toISOString()
    const note = normalizeOptionalString(input.note, 5000)
    const abortedSessionId = abortActiveRunInState(state, db, task, 'archive', note, now)
    task.status = 'archived'
    task.currentRunId = undefined
    task.currentStage = undefined
    task.note = note || task.note
    task.updatedAt = now
    recomputeRoadmapStatusInState(state, task.roadmapId, now)
    appendWorkEventRow(db, 'task.archived', task.id, { note, abortedSessionId }, now)
    return { task, abortedSessionId }
  })
}

export function deleteWorkTask(id: string, filePath = workStatePath()): WorkTaskDeleteResult {
  return mutateWorkState(filePath, (state, db) => {
    const task = state.tasks.find(row => row.id === id)
    if (!task) return { deleted: false }
    assertNoUnsettledTaskDispatchAcquisitions(db, new Set([id]))
    const now = new Date().toISOString()
    const abortedSessionId = activeRunSessionIdsForTasks(state, new Set([id]))[0]
    state.runs = state.runs.filter(run => run.taskId !== id)
    state.dependencies = (state.dependencies || []).filter(dependency => dependency.taskId !== id && dependency.dependsOnTaskId !== id)
    // Drop the task's full run history in SQL: the live window only materializes
    // recent runs, so the per-row sync alone would orphan older terminal runs.
    db.prepare('DELETE FROM runs WHERE task_id = ?').run(id)
    db.prepare('DELETE FROM task_run_counters WHERE task_id = ?').run(id)
    cleanupDeletedTaskReferences(db, new Set([id]))
    updateDelegationReceiptsForDeletion(db, new Set([id]))
    state.tasks = state.tasks.filter(row => row.id !== id)
    recomputeRoadmapStatusInState(state, task.roadmapId, now)
    appendWorkEventRow(db, 'task.deleted', task.id, { title: task.title, abortedSessionId }, now)
    return { deleted: true, task, abortedSessionId }
  })
}

function cleanupDeletedTaskReferences(db: DatabaseSync, taskIds: Set<string>): void {
  const deleteDispatch = db.prepare('DELETE FROM task_dispatch_receipts WHERE task_id = ?')
  const deleteBindings = db.prepare('DELETE FROM channel_bindings WHERE task_id = ?')
  const deleteGates = db.prepare('DELETE FROM human_gates WHERE task_id = ?')
  const clearAdmissions = db.prepare('UPDATE session_admissions SET task_id = NULL WHERE task_id = ?')
  for (const taskId of taskIds) {
    deleteDispatch.run(taskId)
    deleteBindings.run(taskId)
    deleteGates.run(taskId)
    clearAdmissions.run(taskId)
  }
}

function assertNoUnsettledTaskDispatchAcquisitions(db: DatabaseSync, taskIds: Set<string>): void {
  if (!taskIds.size) return
  const read = db.prepare('SELECT status, acquisition_journal_json FROM task_dispatch_receipts WHERE task_id = ?')
  const unsettled: string[] = []
  for (const taskId of taskIds) {
    const rows = read.all(taskId) as Array<{ status?: unknown; acquisition_journal_json?: unknown }>
    if (rows.some(row => row.status !== 'started' && normalizeStoredTaskDispatchAcquisitions(parseJSON(row.acquisition_journal_json, []))
      .some(acquisition => acquisition.status === 'intent' || acquisition.status === 'acquired'))) {
      unsettled.push(taskId)
    }
  }
  if (unsettled.length) {
    throw new Error(`task deletion refused while external acquisitions remain unsettled: ${unsettled.join(', ')}`)
  }
}

function updateDelegationReceiptsForDeletion(
  db: DatabaseSync,
  deletedTaskIds: Set<string>,
  deleted: { roadmapId?: string; supervisorIds?: Set<string>; projectBindingIds?: Set<string> } = {},
): void {
  const rows = queryRows(db, 'SELECT idempotency_key, task_ids_json, roadmap_id, supervisor_id, project_binding_id FROM delegation_receipts')
  const update = db.prepare(`UPDATE delegation_receipts
    SET task_ids_json = ?,
        roadmap_id = CASE WHEN roadmap_id = ? THEN NULL ELSE roadmap_id END,
        supervisor_id = CASE WHEN supervisor_id = ? THEN NULL ELSE supervisor_id END,
        project_binding_id = CASE WHEN project_binding_id = ? THEN NULL ELSE project_binding_id END,
        updated_at = ?
    WHERE idempotency_key = ?`)
  const now = new Date().toISOString()
  for (const row of rows) {
    const taskIds = parseJSON<unknown[]>(row['task_ids_json'], []).map(String)
    const remainingTaskIds = taskIds.filter(taskId => !deletedTaskIds.has(taskId))
    const supervisorId = String(row['supervisor_id'] || '')
    const projectBindingId = String(row['project_binding_id'] || '')
    const roadmapMatches = Boolean(deleted.roadmapId && row['roadmap_id'] === deleted.roadmapId)
    const supervisorMatches = Boolean(supervisorId && deleted.supervisorIds?.has(supervisorId))
    const projectBindingMatches = Boolean(projectBindingId && deleted.projectBindingIds?.has(projectBindingId))
    if (remainingTaskIds.length === taskIds.length && !roadmapMatches && !supervisorMatches && !projectBindingMatches) continue
    update.run(
      JSON.stringify(remainingTaskIds),
      deleted.roadmapId || '',
      supervisorMatches ? supervisorId : '',
      projectBindingMatches ? projectBindingId : '',
      now,
      row['idempotency_key'],
    )
  }
}

export function reserveTaskDispatchStart(input: { taskId: string; stage: string; profile?: string; leaseOwner?: string; leaseMs?: number; idempotencyKey?: string; now?: number }, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const nowMs = input.now || Date.now()
      const now = new Date(nowMs).toISOString()
      const stage = normalizeStage(input.stage, 'stage')
      const idempotencyKey = normalizeOptionalString(input.idempotencyKey, 240)
      if (idempotencyKey) {
        const existing = rowToTaskDispatchReceipt(db.prepare('SELECT * FROM task_dispatch_receipts WHERE idempotency_key = ?').get(idempotencyKey))
        if (existing) {
          db.exec('ROLLBACK')
          return existing
        }
      }
      const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId))
      if (!task || task.status !== 'pending' || task.currentRunId || (task.currentStage || task.pipeline[0] || 'implement') !== stage) {
        db.exec('ROLLBACK')
        return undefined
      }
      const active = rowToTaskDispatchReceipt(db.prepare("SELECT * FROM task_dispatch_receipts WHERE task_id = ? AND stage = ? AND status = 'starting' AND lease_expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1").get(input.taskId, stage, now))
      if (active) {
        db.exec('ROLLBACK')
        return undefined
      }
      const leaseMs = Math.max(60 * 1000, Math.min(input.leaseMs || 60 * 60 * 1000, 24 * 60 * 60 * 1000))
      const receipt: TaskDispatchReceiptRecord = {
        id: `dispatch_${randomUUID()}`,
        taskId: input.taskId,
        stage,
        profile: normalizeOptionalString(input.profile, 120),
        idempotencyKey: idempotencyKey || `dispatch:${input.taskId}:${stage}:${input.leaseOwner || 'scheduler'}:${now}`,
        leaseOwner: normalizeOptionalString(input.leaseOwner, 200) || `scheduler-${process.pid}`,
        leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
        status: 'starting',
        createdAt: now,
        updatedAt: now,
      }
      upsertTaskDispatchReceiptRow(db, receipt)
      appendWorkEventRow(db, 'task.dispatch.starting', input.taskId, { dispatchId: receipt.id, stage, leaseOwner: receipt.leaseOwner, leaseExpiresAt: receipt.leaseExpiresAt }, now)
      db.exec('COMMIT')
      return receipt
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function attachTaskDispatchEnvironment(dispatchId: string, environment: EnvironmentRunRecord, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  return updateTaskDispatchReceipt(dispatchId, filePath, receipt => {
    if (receipt.status !== 'starting') return false
    receipt.environment = environment
    return true
  }, (receipt, db, now) => {
    upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind: 'environment',
      status: 'acquired',
      provider: environment.backend,
      resourceId: environment.leaseId || environment.id,
      resource: environment as unknown as Record<string, unknown>,
    }, now)
  })
}

export function journalTaskDispatchAcquisitionIntent(
  dispatchId: string,
  input: { kind: TaskDispatchAcquisitionKind; provider: string; idempotencyKey?: string; metadata?: Record<string, unknown> },
  filePath = workStatePath(),
): TaskDispatchAcquisitionRecord | undefined {
  let acquisition: TaskDispatchAcquisitionRecord | undefined
  updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'starting') return false
    acquisition = upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind: input.kind,
      status: 'intent',
      provider: normalizeRequiredString(input.provider, 'acquisition.provider', 120),
      idempotencyKey: normalizeOptionalString(input.idempotencyKey, 240) || `${dispatchId}:${input.kind}`,
      metadata: normalizeJsonObject(input.metadata || {}, 'acquisition.metadata'),
    }, now)
    return true
  })
  return acquisition
}

export function attachTaskDispatchSession(dispatchId: string, sessionId: string, filePath = workStatePath()): TaskDispatchAcquisitionRecord | undefined {
  let acquisition: TaskDispatchAcquisitionRecord | undefined
  updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'starting') return false
    receipt.sessionId = normalizeRequiredString(sessionId, 'sessionId', 200)
    acquisition = upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind: 'session',
      status: 'acquired',
      provider: 'opencode',
      resourceId: receipt.sessionId,
      resource: { sessionId: receipt.sessionId },
    }, now)
    return true
  })
  return acquisition
}

export function markTaskDispatchAcquisitionSettled(
  dispatchId: string,
  kind: TaskDispatchAcquisitionKind,
  input: { status: 'released' | 'failed'; error?: string } = { status: 'released' },
  filePath = workStatePath(),
): TaskDispatchAcquisitionRecord | undefined {
  let acquisition: TaskDispatchAcquisitionRecord | undefined
  updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    acquisition = upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind,
      status: input.status,
      provider: kind === 'session' ? 'opencode' : receipt.environment?.backend || 'environment',
      error: normalizeOptionalString(input.error, 1000),
    }, now)
    return true
  })
  return acquisition
}

export function listTaskDispatchAcquisitions(filePath = workStatePath()): TaskDispatchAcquisitionRecord[] {
  return withWorkDb(filePath, db => {
    const rows = queryRows(db, `SELECT id, task_id, stage, lease_owner, status, lease_expires_at, acquisition_journal_json
      FROM task_dispatch_receipts
      WHERE acquisition_journal_json IS NOT NULL AND acquisition_journal_json != '[]'
      ORDER BY created_at ASC, id ASC`)
    return rows.flatMap(row => taskDispatchAcquisitionRows(row))
  })
}

export function markTaskDispatchStarted(dispatchId: string, input: { runId: string; sessionId: string }, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  return updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'starting') return false
    receipt.status = 'started'
    receipt.runId = input.runId
    receipt.sessionId = input.sessionId
    appendWorkEventRow(db, 'task.dispatch.started', receipt.taskId, { dispatchId: receipt.id, runId: input.runId, sessionId: input.sessionId, stage: receipt.stage }, now)
    return true
  })
}

export function markTaskDispatchPromptSubmitted(dispatchId: string, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  return updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'started') return false
    receipt.promptSubmittedAt = receipt.promptSubmittedAt || now
    appendWorkEventRow(db, 'task.dispatch.prompt_submitted', receipt.runId || receipt.taskId, { dispatchId: receipt.id, taskId: receipt.taskId, stage: receipt.stage, sessionId: receipt.sessionId, runId: receipt.runId, promptSubmittedAt: receipt.promptSubmittedAt }, now)
    return true
  })
}

export function markTaskDispatchFailed(dispatchId: string | undefined, reason: string, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  if (!dispatchId) return undefined
  return updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'starting') return false
    receipt.status = 'failed'
    receipt.failureReason = normalizeOptionalString(reason, 1000) || 'dispatch failed'
    appendWorkEventRow(db, 'task.dispatch.failed', receipt.taskId, { dispatchId: receipt.id, stage: receipt.stage, reason: receipt.failureReason }, now)
    return true
  })
}

export function recoverExpiredTaskDispatchStarts(filePath = workStatePath(), now = Date.now()): { recovered: number; dispatchIds: string[] } {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const nowIso = new Date(now).toISOString()
      const expired = listTaskDispatchReceiptsFromDb(db, { status: 'starting' })
        .filter(receipt => Date.parse(receipt.leaseExpiresAt) <= now)
      for (const receipt of expired) {
        let environmentRecovery: Record<string, unknown> | undefined
        if (receipt.environment && receipt.environment.status !== 'released') {
          const before = receipt.environment
          try {
            receipt.environment = environmentControllerForBackend(before.backend).release(before)
            upsertTaskDispatchAcquisitionRow(db, receipt, {
              kind: 'environment',
              status: 'released',
              provider: before.backend,
              resourceId: before.leaseId || before.id,
              resource: receipt.environment as unknown as Record<string, unknown>,
            }, nowIso)
            environmentRecovery = { eventType: 'environment.released', environmentId: receipt.environment.id, status: receipt.environment.status, cleanup: receipt.environment.cleanup.state }
            appendWorkEventRow(db, 'environment.released', receipt.taskId, {
              dispatchId: receipt.id,
              environmentId: receipt.environment.id,
              action: 'release',
              actor: 'scheduler',
              note: 'expired dispatch-start recovery',
              environment: redactEnvironmentRecord(receipt.environment),
            }, nowIso)
          } catch (err: any) {
            receipt.environment = cleanupFailedEnvironmentRun(before, err?.message || String(err))
            upsertTaskDispatchAcquisitionRow(db, receipt, {
              kind: 'environment',
              status: 'failed',
              provider: before.backend,
              resourceId: before.leaseId || before.id,
              resource: receipt.environment as unknown as Record<string, unknown>,
              error: err?.message || String(err),
            }, nowIso)
            environmentRecovery = { eventType: 'environment.cleanup_failed', environmentId: receipt.environment.id, status: receipt.environment.status, cleanup: receipt.environment.cleanup.state }
            appendWorkEventRow(db, 'environment.cleanup_failed', receipt.taskId, {
              dispatchId: receipt.id,
              environmentId: receipt.environment.id,
              action: 'release',
              actor: 'scheduler',
              note: 'expired dispatch-start recovery',
              environment: redactEnvironmentRecord(receipt.environment),
            }, nowIso)
          }
        }
        receipt.status = 'failed'
        receipt.failureReason = 'Dispatch start lease expired before run start.'
        receipt.updatedAt = nowIso
        upsertTaskDispatchReceiptRow(db, receipt)
        appendWorkEventRow(db, 'task.dispatch.start_expired', receipt.taskId, {
          dispatchId: receipt.id,
          stage: receipt.stage,
          profile: receipt.profile,
          leaseOwner: receipt.leaseOwner,
          leaseExpiresAt: receipt.leaseExpiresAt,
          environmentRecovery,
          recovered: true,
        }, nowIso)
      }
      db.exec('COMMIT')
      return { recovered: expired.length, dispatchIds: expired.map(receipt => receipt.id) }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function countActiveTaskDispatchStarts(filter: { stage?: string; profile?: string } = {}, filePath = workStatePath(), now = Date.now()): number {
  return withWorkDb(filePath, db => {
    const clauses = ["status = 'starting'", 'lease_expires_at > ?']
    const params: unknown[] = [new Date(now).toISOString()]
    if (filter.stage) {
      clauses.push('stage = ?')
      params.push(filter.stage)
    }
    if (filter.profile) {
      clauses.push('profile = ?')
      params.push(filter.profile)
    }
    const row = db.prepare(`SELECT COUNT(*) AS count FROM task_dispatch_receipts WHERE ${clauses.join(' AND ')}`).get(...params) as any
    return Number(row?.count || 0)
  })
}

export function listTaskDispatchReceipts(filter: { taskId?: string; status?: TaskDispatchReceiptStatus; stage?: string; profile?: string } = {}, filePath = workStatePath()): TaskDispatchReceiptRecord[] {
  return withWorkDb(filePath, db => listTaskDispatchReceiptsFromDb(db, filter))
}

function listTaskDispatchReceiptsFromDb(db: DatabaseSync, filter: { taskId?: string; status?: TaskDispatchReceiptStatus; stage?: string; profile?: string } = {}): TaskDispatchReceiptRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.taskId) {
    clauses.push('task_id = ?')
    params.push(filter.taskId)
  }
  if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  if (filter.stage) {
    clauses.push('stage = ?')
    params.push(filter.stage)
  }
  if (filter.profile) {
    clauses.push('profile = ?')
    params.push(filter.profile)
  }
  const rows = queryRows(db, `SELECT * FROM task_dispatch_receipts${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC`, ...params)
  return rows.map(rowToTaskDispatchReceipt).filter(Boolean) as TaskDispatchReceiptRecord[]
}

export function startWorkTaskRun(id: string, stage: string, sessionId: string, profile: string, filePath = workStatePath(), lease: { owner?: string; leaseMs?: number; generation?: string } = {}, resolution: RunResolutionInput = {}): WorkTaskRunStartResult | undefined {
  return mutateWorkState(filePath, (state, db) => startWorkTaskRunInState(state, db, id, stage, sessionId, profile, lease, resolution, new Date()))
}

export function startWorkTaskRunFromDispatch(dispatchId: string, id: string, stage: string, sessionId: string, profile: string, filePath = workStatePath(), lease: { owner?: string; leaseMs?: number; generation?: string } = {}, resolution: RunResolutionInput = {}): WorkTaskRunStartResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const nowDate = new Date()
    const now = nowDate.toISOString()
    const receipt = rowToTaskDispatchReceipt(db.prepare('SELECT * FROM task_dispatch_receipts WHERE id = ?').get(dispatchId))
    if (!receipt || receipt.taskId !== id || receipt.stage !== stage || receipt.status !== 'starting') return undefined
    const leaseExpiresAt = Date.parse(receipt.leaseExpiresAt)
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= nowDate.getTime()) return undefined
    if (!lease.owner || receipt.leaseOwner !== lease.owner) return undefined
    if (receipt.profile && receipt.profile !== profile) return undefined

    const started = startWorkTaskRunInState(state, db, id, stage, sessionId, profile, lease, resolution, nowDate)
    if (!started) return undefined

    receipt.status = 'started'
    receipt.runId = started.run.id
    receipt.sessionId = sessionId
    receipt.updatedAt = now
    upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind: 'environment',
      status: 'released',
      provider: receipt.environment?.backend || 'environment',
      resourceId: receipt.environment?.leaseId || receipt.environment?.id,
      resource: receipt.environment as unknown as Record<string, unknown> | undefined,
      metadata: { transferredToRunId: started.run.id },
    }, now)
    upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind: 'session',
      status: 'released',
      provider: 'opencode',
      resourceId: sessionId,
      resource: { sessionId, runId: started.run.id },
      metadata: { transferredToRunId: started.run.id },
    }, now)
    upsertTaskDispatchReceiptRow(db, receipt)
    appendWorkEventRow(db, 'task.dispatch.started', receipt.taskId, { dispatchId: receipt.id, runId: started.run.id, sessionId, stage: receipt.stage }, now)
    return started
  })
}

function startWorkTaskRunInState(state: WorkState, db: DatabaseSync, id: string, stage: string, sessionId: string, profile: string, lease: { owner?: string; leaseMs?: number; generation?: string } = {}, resolution: RunResolutionInput = {}, nowDate = new Date()): WorkTaskRunStartResult | undefined {
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

export function renewWorkTaskRunLease(runId: string, lease: { owner?: string; leaseMs?: number; generation?: string } = {}, filePath = workStatePath()): boolean {
  return mutateWorkState(filePath, (state, db) => {
    const run = state.runs.find(row => row.id === runId)
    if (!run || !isActiveRunStatus(run.status)) return false
    const now = new Date()
    const leaseMs = lease.leaseMs || 60 * 60 * 1000
    const ownerMismatch = Boolean(lease.owner && run.leaseOwner && lease.owner !== run.leaseOwner)
    const generationMismatch = Boolean(lease.generation && run.schedulerGeneration && lease.generation !== run.schedulerGeneration)
    if (ownerMismatch || generationMismatch) {
      appendWorkEventRow(db, 'task.run.lease_renew_denied', run.taskId, {
        runId,
        reason: ownerMismatch ? 'lease_owner_mismatch' : 'scheduler_generation_mismatch',
        leaseOwner: run.leaseOwner,
        requestedLeaseOwner: lease.owner,
        schedulerGeneration: run.schedulerGeneration,
        requestedSchedulerGeneration: lease.generation,
      }, now.toISOString())
      return false
    }
    const expiresAt = Date.parse(run.leaseExpiresAt || '')
    const renewWindowMs = Math.max(60 * 1000, Math.floor(leaseMs / 2))
    if (Number.isFinite(expiresAt) && expiresAt - now.getTime() > renewWindowMs) return true
    run.leaseOwner = lease.owner || run.leaseOwner
    run.schedulerGeneration = lease.generation || run.schedulerGeneration
    run.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString()
    appendWorkEventRow(db, 'task.run.lease_renewed', run.taskId, { runId, leaseOwner: run.leaseOwner, leaseExpiresAt: run.leaseExpiresAt }, now.toISOString())
    return true
  })
}

export function updateWorkTaskRunAttribution(runId: string, attribution: RunAttributionInput = {}, filePath = workStatePath()): boolean {
  return mutateWorkState(filePath, (state, db) => {
    const run = state.runs.find(row => row.id === runId)
    if (!run || !isActiveRunStatus(run.status)) return false
    const before = runAttributionKey(run)
    applyRunAttribution(run, attribution)
    if (runAttributionKey(run) !== before) {
      appendWorkEventRow(db, 'task.run.attribution_updated', run.taskId, { runId, costUsd: run.costUsd, tokens: runTokens(run) }, new Date().toISOString())
    }
    return true
  })
}

export function adoptActiveWorkRunLeases(lease: { owner: string; generation: string; leaseMs?: number; now?: number }, filePath = workStatePath()): { adopted: number; runIds: string[] } {
  if (!lease.owner || !lease.generation) return { adopted: 0, runIds: [] }
  return mutateWorkState(filePath, (state, db) => {
    const now = lease.now || Date.now()
    const nowIso = new Date(now).toISOString()
    const leaseMs = lease.leaseMs || 60 * 60 * 1000
    const runIds: string[] = []
    for (const run of state.runs.filter(run => isActiveRunStatus(run.status))) {
      if (run.leaseOwner === lease.owner && run.schedulerGeneration === lease.generation) continue
      const previousLeaseOwner = run.leaseOwner
      const previousSchedulerGeneration = run.schedulerGeneration
      run.leaseOwner = lease.owner
      run.schedulerGeneration = lease.generation
      const currentExpiresAt = Date.parse(run.leaseExpiresAt || '')
      run.leaseExpiresAt = new Date(Math.max(now + leaseMs, Number.isFinite(currentExpiresAt) ? currentExpiresAt : 0)).toISOString()
      runIds.push(run.id)
      appendWorkEventRow(db, 'task.run.lease_adopted', run.taskId, {
        runId: run.id,
        stage: run.stage,
        previousLeaseOwner,
        previousSchedulerGeneration,
        leaseOwner: run.leaseOwner,
        schedulerGeneration: run.schedulerGeneration,
        leaseExpiresAt: run.leaseExpiresAt,
      }, nowIso)
    }
    return { adopted: runIds.length, runIds }
  })
}

export function recoverExpiredWorkLeases(retryLimit: number, filePath = workStatePath(), now = Date.now()): { recovered: number; blocked: number; runIds: string[] } {
  return mutateWorkState(filePath, (state, db) => {
    void retryLimit
    let recovered = 0
    let blocked = 0
    const runIds: string[] = []
    const nowIso = new Date(now).toISOString()
    for (const run of state.runs.filter(run => isActiveRunStatus(run.status) && isExpiredLease(run.leaseExpiresAt, now))) {
      const task = state.tasks.find(row => row.id === run.taskId)
      if (!task || task.currentRunId !== run.id) continue
      run.status = 'errored'
      run.completedAt = nowIso
      const runtimeMs = Date.parse(nowIso) - Date.parse(run.startedAt)
      run.runtimeMs = Number.isFinite(runtimeMs) && runtimeMs >= 0 ? runtimeMs : undefined
      run.result = { status: 'blocked', summary: 'Recovered expired scheduler lease', feedback: `Lease expired at ${run.leaseExpiresAt || 'unknown time'}`, artifacts: [], raw: 'Recovered expired scheduler lease' }
      run.environment = finalizeEnvironmentRun(run.environment, false)
      task.currentRunId = undefined
      task.status = 'blocked'
      task.currentStage = undefined
      task.note = `Expired scheduler lease for ${run.stage}; old OpenCode session may still be running, so Gateway blocked retry until an operator verifies or aborts it.`
      blocked++
      task.updatedAt = nowIso
      runIds.push(run.id)
      recomputeRoadmapStatusInState(state, task.roadmapId, nowIso)
      appendWorkEventRow(db, 'task.run.lease_expired', task.id, { runId: run.id, stage: run.stage, recovered: false, retrySuppressed: true, terminalSafe: true }, nowIso)
    }
    return { recovered, blocked, runIds }
  })
}

export function recoverOrphanedWorkRuns(activeSessionIds: Set<string>, retryLimit: number, filePath = workStatePath(), now = Date.now()): { recovered: number; blocked: number; runIds: string[] } {
  return mutateWorkState(filePath, (state, db) => recoverRunsInState(state, db, retryLimit, now, run => !activeSessionIds.has(run.sessionId), 'task.run.orphan_recovered', 'Recovered missing OpenCode session'))
}

export function recoverOrphanedWorkRun(runId: string, retryLimit: number, filePath = workStatePath(), now = Date.now()): { recovered: number; blocked: number; runIds: string[] } {
  return mutateWorkState(filePath, (state, db) => recoverRunsInState(state, db, retryLimit, now, run => run.id === runId, 'task.run.orphan_recovered', 'Recovered missing OpenCode session'))
}

export function summarizeWorkLeases(state: WorkState = loadWorkState(), now = Date.now()): WorkLeaseSummary {
  const running = state.runs.filter(run => isActiveRunStatus(run.status))
  const owners: Record<string, number> = {}
  for (const run of running) owners[run.leaseOwner || 'unknown'] = (owners[run.leaseOwner || 'unknown'] || 0) + 1
  return { running: running.length, expired: running.filter(run => isExpiredLease(run.leaseExpiresAt, now)).length, owners }
}

export function listWorkEnvironments(filter: { status?: string; backend?: string; runId?: string } = {}, state: WorkState = loadWorkState()): WorkEnvironmentView[] {
  return state.runs
    .filter(run => run.environment)
    .map(run => environmentViewForRun(run, state.tasks.find(task => task.id === run.taskId))!)
    .filter(row => !filter.status || row.status === filter.status || (filter.status === 'active' && (row.status === 'prepared' || row.status === 'blocked')))
    .filter(row => !filter.backend || row.backend === filter.backend)
    .filter(row => !filter.runId || row.runId === filter.runId)
}

export function getWorkEnvironment(id: string, state: WorkState = loadWorkState()): WorkEnvironmentView | undefined {
  const run = state.runs.find(row => row.environment?.id === id || row.id === id)
  if (!run?.environment) return undefined
  return environmentViewForRun(run, state.tasks.find(task => task.id === run.taskId))
}

export function applyWorkEnvironmentAction(id: string, action: WorkEnvironmentAction, options: { actor?: string; note?: string } = {}, filePath = workStatePath()): { environment: WorkEnvironmentView; run: RunRecord; eventType: string; abortedSessionId?: string } | undefined {
  return mutateWorkState(filePath, (state, db) => {
    let run = state.runs.find(row => row.environment?.id === id || row.id === id)
    if (!run) {
      // Environment cleanup can target an older terminal run outside the live
      // window; hydrate it from SQL and add it to the working set so the per-row
      // sync persists the environment transition.
      const hydrated = findRunRowForEnvironmentOrId(db, id)
      if (hydrated) {
        state.runs.push(hydrated)
        run = hydrated
      }
    }
    if (!run?.environment) return undefined
    const task = state.tasks.find(row => row.id === run.taskId)
    const controller = environmentControllerForBackend(run.environment.backend)
    const before = run.environment
    let eventType = `environment.${action}`
    try {
      if (action === 'retain') {
        run.environment = controller.retain(before)
        eventType = 'environment.retained'
      } else if (action === 'release') {
        run.environment = controller.release(before)
        eventType = 'environment.released'
      } else if (action === 'cleanup') {
        run.environment = controller.cleanup(before)
        eventType = 'environment.cleaned'
      } else if (action === 'abort') {
        run.environment = controller.cleanup(before)
        eventType = 'environment.aborted'
      } else {
        throw new Error(`unsupported environment action: ${action}`)
      }
    } catch (err: any) {
      run.environment = cleanupFailedEnvironmentRun(before, err?.message || String(err))
      eventType = 'environment.cleanup_failed'
    }
    const now = new Date().toISOString()
    const abortedSessionId = action === 'abort' && task && isActiveRunStatus(run.status)
      ? abortActiveRunInState(state, db, task, 'environment.abort', options.note, now)
      : undefined
    if (action === 'abort' && task && abortedSessionId) {
      task.status = 'blocked'
      task.currentRunId = undefined
      task.currentStage = undefined
      task.note = normalizeOptionalString(options.note, 5000) || 'Environment abort requested by Gateway operator.'
      task.updatedAt = now
      recomputeRoadmapStatusInState(state, task.roadmapId, now)
      appendDelegationProgressForTask(db, task, 'blocked', {
        runId: run.id,
        status: task.status,
        summary: `Delegated task blocked by environment abort: ${task.title}`,
      }, now, run.id)
    }
    appendWorkEventRow(db, eventType, run.taskId, { runId: run.id, environmentId: run.environment.id, action, actor: options.actor || 'operator', note: options.note ? redactSensitiveText(options.note) : undefined, abortedSessionId, environment: redactEnvironmentRecord(run.environment) }, now)
    return { environment: environmentViewForRun(run, task)!, run, eventType, abortedSessionId }
  })
}

export function reconcileWorkEnvironments(filePath = workStatePath()): { checked: number; active: number; retained: number; cleanupFailed: number; evidence: string[] } {
  const state = loadWorkState(filePath)
  const environments = state.runs.map(run => run.environment).filter((environment): environment is EnvironmentRunRecord => Boolean(environment))
  const actionable = environments.filter(environment => environment.status === 'prepared' || environment.status === 'blocked' || environment.status === 'retained' || environment.status === 'cleanup_failed')
  const evidence: string[] = []
  const byBackend = new Map<string, EnvironmentRunRecord[]>()
  for (const environment of actionable) {
    const group = byBackend.get(environment.backend) || []
    group.push(environment)
    byBackend.set(environment.backend, group)
  }
  for (const [backend, rows] of byBackend) {
    try {
      const result = environmentControllerForBackend(backend as any).reconcile(rows)
      evidence.push(`${backend}: ${result.evidence.join('; ')}`)
    } catch (err: any) {
      evidence.push(`${backend}: reconciliation failed: ${String(err?.message || err).substring(0, 500)}`)
    }
  }
  const summary = {
    checked: actionable.length,
    active: actionable.filter(environment => environment.status === 'prepared' || environment.status === 'blocked').length,
    retained: actionable.filter(environment => environment.status === 'retained').length,
    cleanupFailed: actionable.filter(environment => environment.status === 'cleanup_failed').length,
    evidence,
  }
  if (summary.retained || summary.cleanupFailed) appendWorkEvent('environment.reconciled', 'environments', { ...summary, evidence: evidence.slice(0, 20) }, filePath)
  return summary
}

function environmentViewForRun(run: RunRecord, task?: WorkTaskRecord): WorkEnvironmentView | undefined {
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

function isExpiredLease(value: string | undefined, now: number): boolean {
  const expiresAt = Date.parse(value || '')
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

function runLeaseExpectationFailure(run: RunRecord, expected: RunLeaseExpectation = {}): ActiveRunControlReason | undefined {
  if (!expected.owner && !expected.generation) return undefined
  if (!run.leaseOwner || !run.leaseExpiresAt) return 'lease_missing'
  const now = expected.now || Date.now()
  if (isExpiredLease(run.leaseExpiresAt, now)) return 'lease_expired'
  if (expected.owner && expected.owner !== run.leaseOwner) return 'lease_owner_mismatch'
  if (expected.generation && expected.generation !== run.schedulerGeneration) return 'scheduler_generation_mismatch'
  return undefined
}

function recoverRunsInState(state: WorkState, db: DatabaseSync, retryLimit: number, now: number, predicate: (run: RunRecord) => boolean, eventType: string, summary: string): { recovered: number; blocked: number; runIds: string[] } {
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

export function completeWorkTaskRun(runId: string, result: StageResult, retryLimit: number, filePath = workStatePath(), attribution: RunAttributionInput = {}, expectedLease: RunLeaseExpectation = {}): WorkTaskRunCompleteResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const run = state.runs.find(row => row.id === runId)
    const task = run ? state.tasks.find(row => row.id === run.taskId) : undefined
    if (!run || !task) return undefined
    if (!isActiveRunStatus(run.status) || !isTaskActiveStatus(task.status) || task.currentRunId !== run.id) return { applied: false, task, run }
    const leaseFailure = runLeaseExpectationFailure(run, expectedLease)
    if (leaseFailure) {
      appendWorkEventRow(db, 'task.run.completion_denied', task.id, {
        runId: run.id,
        stage: run.stage,
        reason: leaseFailure,
        leaseOwner: run.leaseOwner,
        expectedLeaseOwner: expectedLease.owner,
        schedulerGeneration: run.schedulerGeneration,
        expectedSchedulerGeneration: expectedLease.generation,
      }, new Date(expectedLease.now || Date.now()).toISOString())
      return { applied: false, task, run, reason: leaseFailure }
    }

    const now = new Date().toISOString()
    const completedResult = collectRunEnvironmentArtifacts(run, result, filePath)
    finishRunInState(run, completedResult, now, attribution)
    try {
      writeRunArtifactManifest(run, filePath, { now })
    } catch (err: any) {
      appendWorkEventRow(db, 'artifact.manifest.write_failed', task.id, { runId: run.id, stage: run.stage, errorClass: err?.code || err?.name || 'unknown' }, now)
    }
    const decision = applyStageResultInState(state, task, run, completedResult, retryLimit, now)
    appendWorkEventRow(db, 'task.run.completed', task.id, { runId: run.id, stage: run.stage, runStatus: run.status, taskStatus: task.status }, now)
    const taskStatus = decision.taskStatus
    const completedRunStatus = run.status as RunStatus
    if (decision.nextStage) {
      appendDelegationProgressForTask(db, task, 'stage_advanced', { runId: run.id, stage: run.stage, nextStage: decision.nextStage, runStatus: run.status, taskStatus: task.status, summary: `Delegated task advanced to ${decision.nextStage}: ${task.title}` }, now, run.id, decision.nextStage)
    } else if (taskStatus === 'done') {
      appendDelegationProgressForTask(db, task, 'completed', { runId: run.id, stage: run.stage, runStatus: run.status, taskStatus: task.status, summary: `Delegated task completed: ${task.title}` }, now, run.id)
    } else if (taskStatus === 'blocked') {
      appendDelegationProgressForTask(db, task, 'blocked', { runId: run.id, stage: run.stage, runStatus: run.status, taskStatus: task.status, summary: `Delegated task blocked: ${task.note || task.title}` }, now, run.id)
    } else if (completedRunStatus === 'failed') {
      appendDelegationProgressForTask(db, task, 'failed', { runId: run.id, stage: run.stage, runStatus: run.status, taskStatus: task.status, summary: `Delegated task attempt failed: ${completedResult.summary}` }, now, run.id)
    }
    return { applied: true, task, run, decision }
  })
}

export function blockActiveWorkTaskRun(runId: string, note: string, filePath = workStatePath(), result?: StageResult): WorkTaskRunFailResult | undefined {
  return mutateWorkState(filePath, (state, db) => {
    const run = state.runs.find(row => row.id === runId)
    const task = run ? state.tasks.find(row => row.id === run.taskId) : undefined
    if (!run || !task) return undefined
    if (!isActiveRunStatus(run.status) || !isTaskActiveStatus(task.status) || task.currentRunId !== run.id) return { applied: false, task, run }
    const now = new Date().toISOString()
    run.status = 'errored'
    run.completedAt = now
    const runtimeMs = Date.parse(now) - Date.parse(run.startedAt)
    run.runtimeMs = Number.isFinite(runtimeMs) && runtimeMs >= 0 ? runtimeMs : undefined
    run.result = result || { status: 'blocked', summary: note, feedback: note, artifacts: [], raw: note }
    run.environment = finalizeEnvironmentRun(run.environment, false)
    task.status = 'blocked'
    task.currentRunId = undefined
    task.currentStage = undefined
    task.note = note
    task.updatedAt = now
    recomputeRoadmapStatusInState(state, task.roadmapId, now)
    appendWorkEventRow(db, 'task.run.prompt_failed', task.id, { runId: run.id, stage: run.stage, sessionId: run.sessionId, note }, now)
    appendDelegationProgressForTask(db, task, 'failed', { runId: run.id, stage: run.stage, sessionId: run.sessionId, status: task.status, summary: `Delegated task failed: ${note}` }, now, run.id)
    return { applied: true, task, run }
  })
}

export function appendWorkEvent(type: string, subjectId?: string, payload: Record<string, unknown> = {}, filePath = workStatePath()): number {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const id = appendWorkEventRow(db, type, subjectId, payload)
      db.exec('COMMIT')
      return id
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function appendWorkEvents(events: Array<{ type: string; subjectId?: string; payload?: Record<string, unknown> }>, filePath = workStatePath()): number[] {
  if (!events.length) return []
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
    const ids: number[] = []
    for (const event of events) {
      const payload = event.payload || {}
      const result = insert.run(event.type, event.subjectId || null, JSON.stringify(payload), now) as any
      const id = Number(result?.lastInsertRowid || 0)
      ids.push(id)
      const record = { id, type: event.type, subjectId: event.subjectId, payload, createdAt: now }
      appendAuditLedgerRowForWorkEvent(db, record)
      upsertDelegationProgressRouteReceiptFromEvent(db, record)
    }
    pruneWorkEvents(db, now)
    db.exec('COMMIT')
    return ids
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  } finally {
    db.close()
  }
}

export function appendAuditEvent(input: AuditEventInput, filePath = workStatePath()): number {
  return appendWorkEvent('audit.security', input.target, {
    actor: input.actor,
    source: input.source,
    operation: input.operation,
    target: input.target,
    result: input.result,
    details: input.details || {},
  }, filePath)
}

export function listWorkEvents(limit = 100, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDb(filePath, db => listWorkEventsFromDb(db, limit))
}

export function listWorkEventsReadOnly(limit = 100, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDbReadOnly(filePath, db => listWorkEventsFromDb(db, limit))
}

function listWorkEventsFromDb(db: DatabaseSync, limit = 100): WorkEventRecord[] {
  const rows = queryRows(db, 'SELECT * FROM events ORDER BY id DESC LIMIT ?', Math.max(1, Math.min(limit, 500)))
  return rows.reverse().map(rowToEvent)
}

export function listRecentWorkEvents(type: string, subjectId: string, since: Date, limit = 1000, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDb(filePath, db => {
    const rows = db.prepare('SELECT * FROM events WHERE type = ? AND subject_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?')
      .all(type, subjectId, since.toISOString(), Math.max(1, Math.min(limit, 5000))) as any[]
    return rows.map(rowToEvent)
  })
}

export function listWorkEventsByType(type: string, limit = 1000, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDb(filePath, db => {
    const rows = db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?')
      .all(type, Math.max(1, Math.min(limit, WORK_EVENT_TYPE_QUERY_LIMIT))) as any[]
    return rows.reverse().map(rowToEvent)
  })
}

export function listDelegationProgressRouteReceipts(options: {
  dedupeKey?: string
  progressKey?: string
  idempotencyKey?: string
  since?: Date
  limit?: number
} = {}, filePath = workStatePath()): DelegationProgressRouteReceiptRecord[] {
  return withWorkDb(filePath, db => listDelegationProgressRouteReceiptsFromDb(db, options))
}

export function listDelegationProgressRouteReceiptsReadOnly(options: {
  dedupeKey?: string
  progressKey?: string
  idempotencyKey?: string
  since?: Date
  limit?: number
} = {}, filePath = workStatePath()): DelegationProgressRouteReceiptRecord[] {
  return withWorkDbReadOnly(filePath, db => listDelegationProgressRouteReceiptsFromDb(db, options))
}

function listDelegationProgressRouteReceiptsFromDb(db: DatabaseSync, options: {
  dedupeKey?: string
  progressKey?: string
  idempotencyKey?: string
  since?: Date
  limit?: number
} = {}): DelegationProgressRouteReceiptRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.dedupeKey) {
    clauses.push('dedupe_key = ?')
    params.push(options.dedupeKey)
  }
  if (options.progressKey) {
    clauses.push('progress_key = ?')
    params.push(options.progressKey)
  }
  if (options.idempotencyKey) {
    clauses.push('idempotency_key = ?')
    params.push(options.idempotencyKey)
  }
  if (options.since) {
    clauses.push('updated_at >= ?')
    params.push(options.since.toISOString())
  }
  const limit = Math.max(1, Math.min(options.limit || 1000, WORK_EVENT_TYPE_QUERY_LIMIT))
  const rows = db.prepare(`SELECT * FROM delegation_progress_route_receipts${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC, last_event_id DESC LIMIT ?`)
    .all(...params, limit) as any[]
  return rows.map(rowToDelegationProgressRouteReceipt).filter(Boolean) as DelegationProgressRouteReceiptRecord[]
}

export function listAuditLedgerEntries(options: AuditLedgerQueryOptions = {}, filePath = workStatePath()): AuditLedgerRecord[] {
  return withWorkDb(filePath, db => listAuditLedgerEntriesFromDb(db, options))
}

export function listAuditLedgerEntriesReadOnly(options: AuditLedgerQueryOptions = {}, filePath = workStatePath()): AuditLedgerRecord[] {
  return withWorkDbReadOnly(filePath, db => listAuditLedgerEntriesFromDb(db, options))
}

function listAuditLedgerEntriesFromDb(db: DatabaseSync, options: AuditLedgerQueryOptions = {}): AuditLedgerRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.class) {
    clauses.push('class = ?')
    params.push(options.class)
  }
  if (options.sourceEventType) {
    clauses.push('source_event_type = ?')
    params.push(options.sourceEventType)
  }
  if (options.traceId) {
    clauses.push('trace_id = ?')
    params.push(options.traceId)
  }
  if (options.correlationId) {
    clauses.push('correlation_id = ?')
    params.push(options.correlationId)
  }
  if (options.since) {
    clauses.push('occurred_at >= ?')
    params.push(options.since)
  }
  if (options.until) {
    clauses.push('occurred_at <= ?')
    params.push(options.until)
  }
  const limit = Math.max(1, Math.min(options.limit || 100, 1000))
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = queryRows(db, `SELECT * FROM audit_ledger ${where} ORDER BY id DESC LIMIT ?`, ...params, limit)
  return rows.reverse().map(rowToAuditLedger)
}

export function listAllWorkEventsByType(type: string, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDb(filePath, db => {
    const rows = queryRows(db, 'SELECT * FROM events WHERE type = ? ORDER BY id ASC', type)
    return rows.map(rowToEvent)
  })
}



export function clearWorkStateForTest(filePath = workStatePath()): void {
  closeWorkDb(filePath)
  resetWorkDbInitState(filePath)
  try { fs.rmSync(filePath, { force: true }) } catch {}
  try { fs.rmSync(`${filePath}-wal`, { force: true }) } catch {}
  try { fs.rmSync(`${filePath}-shm`, { force: true }) } catch {}
}

/**
 * Test-only: run `fn` inside a real work-db write transaction on `filePath`,
 * routed through the exact open / BEGIN IMMEDIATE / COMMIT / active-handle
 * pinning path internal mutations use. Lets tests trigger a nested cross-path
 * open mid-transaction and assert the LRU never evicts the still-open handle.
 */
export function withWorkDbTransactionForTest(filePath: string, fn: (db: DatabaseSync) => void): void {
  mutateWorkState(filePath, (_state, db) => { fn(db) })
}

function applyTaskUpdate(task: WorkTaskRecord, input: WorkTaskUpdateInput): void {
  if (input.title !== undefined) task.title = normalizeRequiredString(input.title, 'title', 120)
  if (input.description !== undefined) task.description = normalizeRequiredString(input.description, 'description', 10000)
  if (input.roadmapId !== undefined) task.roadmapId = input.roadmapId
  if (input.priority !== undefined) task.priority = normalizePriority(input.priority)
  if (input.agent !== undefined) task.agent = normalizeOptionalIdentifier(input.agent, 'agent') || task.agent
  if (input.agentTeam !== undefined) task.agentTeam = normalizeOptionalAgentTeam(input.agentTeam, 'agentTeam')
  if (input.stageProfiles !== undefined) task.stageProfiles = normalizeStageProfileOverrides(input.stageProfiles, 'stageProfiles')
  if (input.environment !== undefined) task.environment = input.environment === null ? undefined : normalizeEnvironmentSelector(input.environment, 'task.environment')
  if (input.pipeline !== undefined) task.pipeline = normalizeTaskPipeline(input.pipeline, task.pipeline)
  if (input.currentStage !== undefined) task.currentStage = input.currentStage ? normalizeStage(input.currentStage, 'currentStage') : undefined
  else if (input.pipeline !== undefined && task.currentStage && !task.pipeline.includes(task.currentStage)) task.currentStage = task.pipeline[0] || undefined
  if (input.note !== undefined) task.note = normalizeOptionalString(input.note, 5000)
  if (input.earliestStartAt !== undefined) task.earliestStartAt = normalizeOptionalIsoTime(input.earliestStartAt, 'earliestStartAt')
  if (input.deadlineAt !== undefined) task.deadlineAt = normalizeOptionalIsoTime(input.deadlineAt, 'deadlineAt')
  if (input.recurrence !== undefined) task.recurrence = normalizeOptionalString(input.recurrence, 200)
  if (input.manualGate !== undefined) task.manualGate = normalizeManualGate(input.manualGate)
  if (input.slaClass !== undefined) task.slaClass = normalizeOptionalString(input.slaClass, 80)
  if (input.qualitySpec !== undefined) task.qualitySpec = normalizeTaskQualitySpec(input.qualitySpec)
  if (input.status !== undefined) {
    const status = normalizeWorkStatus(input.status)
    task.status = status
    if (!isTaskActiveStatus(status)) task.currentRunId = undefined
    if (isTaskRunOwnershipTerminalStatus(status)) {
      if (status !== 'blocked') task.currentStage = undefined
    }
    if (status === 'pending' && !task.currentStage) task.currentStage = task.pipeline[0] || 'implement'
  }
  task.updatedAt = new Date().toISOString()
}

function createRoadmapInState(state: WorkState, db: DatabaseSync, input: { title: string; priority?: 'HIGH' | 'MEDIUM' | 'LOW'; agentTeam?: string; environment?: EnvironmentSelector; qualitySpec?: RoadmapQualitySpec }, now: string): RoadmapRecord {
  const title = normalizeRequiredString(input.title, 'title', 200)
  const roadmap: RoadmapRecord = {
    id: `roadmap_${randomUUID()}`,
    title,
    status: 'active',
    priority: normalizePriority(input.priority),
    agentTeam: normalizeOptionalAgentTeam(input.agentTeam, 'agentTeam'),
    environment: normalizeEnvironmentSelector(input.environment, 'roadmap.environment'),
    qualitySpec: normalizeRoadmapQualitySpec(input.qualitySpec),
    createdAt: now,
    updatedAt: now,
  }
  state.roadmaps.push(roadmap)
  appendWorkEventRow(db, 'roadmap.created', roadmap.id, { title: roadmap.title, agentTeam: roadmap.agentTeam }, now)
  return roadmap
}

function createWorkTaskInState(state: WorkState, db: DatabaseSync, input: WorkTaskCreateInput, now: string): WorkTaskRecord {
  const pipeline = normalizeTaskPipeline(input.pipeline)
  const roadmapId = input.roadmapId || ensureInboxRoadmap(state, new Date(now)).id
  assertRoadmapAcceptsTasks(state, roadmapId)
  const title = normalizeRequiredString(input.title, 'title', 120)
  // Idempotent externally-triggered creation: when the caller supplies a dedupe
  // key, a repeated create with the same (sourceType, sourceKey) returns the
  // existing task rather than inserting a duplicate. The check runs against the
  // in-transaction WorkState (readWorkState already loaded every task), which is
  // the read-modify-write equivalent of ON CONFLICT(source_type, source_key) DO
  // NOTHING + re-select inside the BEGIN IMMEDIATE window.
  const idempotencyKey = normalizeOptionalString(input.idempotencyKey, 200)
  const sourceType = idempotencyKey ? (normalizeOptionalString(input.sourceType, 80) || 'external') : 'manual'
  const sourceKey = idempotencyKey || undefined
  if (idempotencyKey) {
    const existing = state.tasks.find(row => row.sourceType === sourceType && row.sourceKey === sourceKey)
    if (existing) return existing
  }
  const task: WorkTaskRecord = {
    id: `task_${randomUUID()}`,
    roadmapId,
    title,
    description: normalizeOptionalString(input.description, 10000) || title,
    status: 'pending',
    priority: normalizePriority(input.priority),
    agent: normalizeOptionalIdentifier(input.agent, 'agent') || 'build',
    agentTeam: normalizeOptionalAgentTeam(input.agentTeam, 'agentTeam'),
    stageProfiles: normalizeStageProfileOverrides(input.stageProfiles, 'stageProfiles'),
    environment: normalizeEnvironmentSelector(input.environment, 'task.environment'),
    pipeline,
    currentStage: pipeline[0] || 'implement',
    attempts: {},
    note: normalizeOptionalString(input.note, 5000),
    earliestStartAt: normalizeOptionalIsoTime(input.earliestStartAt, 'earliestStartAt'),
    deadlineAt: normalizeOptionalIsoTime(input.deadlineAt, 'deadlineAt'),
    recurrence: normalizeOptionalString(input.recurrence, 200),
    manualGate: normalizeManualGate(input.manualGate),
    slaClass: normalizeOptionalString(input.slaClass, 80),
    qualitySpec: normalizeTaskQualitySpec(input.qualitySpec),
    sourceType,
    sourceKey,
    createdAt: now,
    updatedAt: now,
  }
  state.tasks.push(task)
  for (const dependsOnTaskId of input.dependsOn || []) addWorkDependencyInState(state, db, { taskId: task.id, dependsOnTaskId }, now)
  recomputeRoadmapStatusInState(state, roadmapId, now)
  appendWorkEventRow(db, 'task.created', task.id, { title: task.title, roadmapId, agentTeam: task.agentTeam, stageProfiles: task.stageProfiles }, now)
  if (task.manualGate) insertHumanGateRow(db, humanGateInputForManualTask(task), now, { force: false })
  return task
}

function createRoadmapSupervisorInState(state: WorkState, input: RoadmapSupervisorCreateInput, now: string): RoadmapSupervisorRecord {
  const roadmapId = normalizeRequiredString(input.roadmapId, 'roadmapId', 120)
  assertRoadmapAcceptsSupervisors(state, roadmapId)
  const status = normalizeRoadmapSupervisorStatus(input.status || 'active')
  if (status === 'archived') throw new Error('cannot create an archived roadmap supervisor')
  const profile = normalizeOptionalIdentifier(input.profile, 'profile') || 'supervisor'
  assertProfileExists(profile)
  const supervisor: RoadmapSupervisorRecord = {
    supervisorId: `supervisor_${randomUUID()}`,
    roadmapId,
    sessionId: normalizeRequiredString(input.sessionId, 'sessionId', 200),
    profile,
    status,
    isDefault: input.isDefault === true,
    cadence: normalizeJsonObject(input.cadence, 'cadence'),
    eventTriggers: normalizeJsonObject(input.eventTriggers, 'eventTriggers'),
    lastReviewedEventId: normalizeOptionalEventId(input.lastReviewedEventId, 'lastReviewedEventId'),
    lastReviewAt: normalizeOptionalIsoTime(input.lastReviewAt, 'lastReviewAt'),
    nextReviewAt: normalizeOptionalIsoTime(input.nextReviewAt, 'nextReviewAt'),
    completionPolicy: normalizeJsonObject(input.completionPolicy, 'completionPolicy'),
    notificationPolicyRef: normalizeOptionalString(input.notificationPolicyRef, 200),
    note: normalizeOptionalString(input.note, 5000),
    createdAt: now,
    updatedAt: now,
  }
  state.supervisors.push(supervisor)
  return supervisor
}

function applyRoadmapSupervisorUpdate(state: WorkState, supervisor: RoadmapSupervisorRecord, input: RoadmapSupervisorUpdateInput, now: string): void {
  const roadmap = state.roadmaps.find(row => row.id === supervisor.roadmapId)
  if (!roadmap) throw new Error(`roadmap not found: ${supervisor.roadmapId}`)
  if (roadmap.status === 'archived' && (supervisor.status !== 'archived' || (input.status !== undefined && input.status !== 'archived'))) throw new Error(`roadmap is archived: ${supervisor.roadmapId}`)
  if (input.sessionId !== undefined) supervisor.sessionId = normalizeRequiredString(input.sessionId, 'sessionId', 200)
  if (input.profile !== undefined) {
    const profile = normalizeOptionalIdentifier(input.profile, 'profile') || 'supervisor'
    assertProfileExists(profile)
    supervisor.profile = profile
  }
  if (input.status !== undefined) {
    const status = normalizeRoadmapSupervisorStatus(input.status)
    if (status === 'archived') throw new Error('use roadmap_supervisor_archive to archive a supervisor')
    supervisor.status = status
  }
  if (input.isDefault !== undefined) supervisor.isDefault = Boolean(input.isDefault)
  if (input.cadence !== undefined) supervisor.cadence = normalizeJsonObject(input.cadence, 'cadence')
  if (input.eventTriggers !== undefined) supervisor.eventTriggers = normalizeJsonObject(input.eventTriggers, 'eventTriggers')
  if (input.lastReviewedEventId !== undefined) supervisor.lastReviewedEventId = normalizeOptionalEventId(input.lastReviewedEventId, 'lastReviewedEventId')
  if (input.lastReviewAt !== undefined) supervisor.lastReviewAt = normalizeOptionalIsoTime(input.lastReviewAt, 'lastReviewAt')
  if (input.nextReviewAt !== undefined) supervisor.nextReviewAt = normalizeOptionalIsoTime(input.nextReviewAt, 'nextReviewAt')
  if (input.completionPolicy !== undefined) supervisor.completionPolicy = normalizeJsonObject(input.completionPolicy, 'completionPolicy')
  if (input.notificationPolicyRef !== undefined) supervisor.notificationPolicyRef = normalizeOptionalString(input.notificationPolicyRef, 200)
  if (input.note !== undefined) supervisor.note = normalizeOptionalString(input.note, 5000)
  if (input.lastResultHash !== undefined) supervisor.lastResultHash = normalizeOptionalString(input.lastResultHash, 200)
  if (input.lastResultAt !== undefined) supervisor.lastResultAt = normalizeOptionalIsoTime(input.lastResultAt, 'lastResultAt')
  if (input.lastResultStatus !== undefined) supervisor.lastResultStatus = normalizeOptionalString(input.lastResultStatus, 80)
  if (input.lastResultSummary !== undefined) supervisor.lastResultSummary = normalizeOptionalString(input.lastResultSummary, 2000)
  supervisor.updatedAt = now
}

function reconcileDefaultSupervisorInState(state: WorkState, roadmapId: string, preferredSupervisorId: string | undefined, now: string): void {
  const active = state.supervisors.filter(supervisor => supervisor.roadmapId === roadmapId && supervisor.status === 'active')
  const preferred = preferredSupervisorId ? active.find(supervisor => supervisor.supervisorId === preferredSupervisorId) : undefined
  const existingDefault = active.filter(supervisor => supervisor.isDefault).sort(compareRoadmapSupervisors)[0]
  const selected = preferred || existingDefault || active.sort(compareRoadmapSupervisors)[0]
  for (const supervisor of state.supervisors.filter(row => row.roadmapId === roadmapId)) {
    const nextDefault = Boolean(selected && supervisor.supervisorId === selected.supervisorId)
    if (supervisor.isDefault !== nextDefault) {
      supervisor.isDefault = nextDefault
      supervisor.updatedAt = now
    }
  }
}

function defaultRoadmapSupervisor(state: WorkState, roadmapId: string): RoadmapSupervisorRecord | undefined {
  return state.supervisors
    .filter(supervisor => supervisor.roadmapId === roadmapId && supervisor.status === 'active')
    .sort(compareRoadmapSupervisors)[0]
}

function compareRoadmapSupervisors(a: RoadmapSupervisorRecord, b: RoadmapSupervisorRecord): number {
  const roadmap = a.roadmapId.localeCompare(b.roadmapId)
  if (roadmap !== 0) return roadmap
  if (a.status === 'active' && b.status !== 'active') return -1
  if (a.status !== 'active' && b.status === 'active') return 1
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
  const created = Date.parse(a.createdAt) - Date.parse(b.createdAt)
  if (Number.isFinite(created) && created !== 0) return created
  return a.supervisorId.localeCompare(b.supervisorId)
}

function supervisorEligibleForWakeup(supervisor: RoadmapSupervisorRecord, nowMs: number): boolean {
  if (supervisor.status !== 'active' || !supervisor.isDefault) return false
  const policy = supervisorWakeTriggerPolicy(supervisor)
  if (policy['enabled'] === false || policy['quiet'] === true || policy['disabled'] === true) return false
  const leaseExpires = Date.parse(supervisor.wakeLeaseExpiresAt || '')
  return !Number.isFinite(leaseExpires) || leaseExpires <= nowMs
}

interface SupervisorWakeupCandidate {
  reason: string
  wakeReason: SupervisorWakeReason
  reasonDetail: string
  events: WorkEventRecord[]
  cursorEventId: number
  windowKey: string
}

function supervisorWakeupReason(state: WorkState, supervisor: RoadmapSupervisorRecord, events: WorkEventRecord[], nowMs: number): SupervisorWakeupCandidate | undefined {
  const policy = supervisorWakeTriggerPolicy(supervisor)
  const cursor = supervisor.lastReviewedEventId || 0
  const matchingEvents = events.filter(event => event.id > cursor && eventTriggersSupervisor(state, supervisor, event, policy))
  const latestEventId = matchingEvents.length ? matchingEvents[matchingEvents.length - 1]!.id : cursor
  if (matchingEvents.length) {
    const latest = matchingEvents[matchingEvents.length - 1]!
    const detail = eventTriggerCategory(latest, state, supervisor) || 'workflow'
    return { reason: `event:${detail}`, wakeReason: supervisorWakeReasonForEvent(latest, detail), reasonDetail: detail, events: matchingEvents, cursorEventId: latestEventId, windowKey: `events:${matchingEvents.map(event => event.id).join(',')}` }
  }

  const pendingProposal = state.completionProposals.find(proposal => proposal.roadmapId === supervisor.roadmapId && proposal.status === 'pending' && Date.parse(proposal.createdAt) > Date.parse(supervisor.lastReviewAt || ''))
  if (pendingProposal && policy['completionProposal'] !== false) return { reason: 'completion_proposal', wakeReason: 'completion_proposal', reasonDetail: pendingProposal.id, events: [], cursorEventId: cursor, windowKey: `completion:${pendingProposal.id}` }

  const nextReview = Date.parse(supervisor.nextReviewAt || '')
  if (policy['cadence'] !== false && Number.isFinite(nextReview) && nextReview <= nowMs) return { reason: 'cadence', wakeReason: 'schedule', reasonDetail: 'nextReviewAt', events: [], cursorEventId: cursor, windowKey: `nextReviewAt:${supervisor.nextReviewAt}` }

  const intervalMs = supervisorCadenceMs(supervisor)
  const lastReview = Date.parse(supervisor.lastReviewAt || supervisor.createdAt)
  if (policy['cadence'] !== false && intervalMs > 0 && Number.isFinite(lastReview) && lastReview + intervalMs <= nowMs) return { reason: 'cadence', wakeReason: 'schedule', reasonDetail: 'cadence.intervalMs', events: [], cursorEventId: cursor, windowKey: `cadence:${lastReview + intervalMs}:${intervalMs}` }
  return undefined
}

function eventTriggersSupervisor(state: WorkState, supervisor: RoadmapSupervisorRecord, event: WorkEventRecord, policy: Record<string, any>): boolean {
  const category = eventTriggerCategory(event, state, supervisor)
  if (!category || policy[category] === false) return false
  if (category === 'criticalAlertActive') return true
  if (category === 'opencodeQuestionPending' || category === 'opencodePermissionPending') return String(event.payload?.['sessionId'] || '') === supervisor.sessionId
  const roadmapId = eventRoadmapId(event, state)
  return roadmapId === supervisor.roadmapId
}

function eventTriggerCategory(event: WorkEventRecord, state: WorkState, supervisor: RoadmapSupervisorRecord): string | undefined {
  const roadmapId = eventRoadmapId(event, state)
  const roadmapTasks = roadmapId === supervisor.roadmapId ? state.tasks.filter(task => task.roadmapId === roadmapId) : []
  if ((event.type === 'task.done' || event.type === 'task.done.manual' || (event.type === 'task.run.completed' && event.payload?.['taskStatus'] === 'done')) && roadmapTasks.length && roadmapTasks.every(task => task.status === 'done')) return 'allRoadmapTasksDone'
  if ((event.type === 'task.done' || event.type === 'task.done.manual') || (event.type === 'task.run.completed' && event.payload?.['taskStatus'] === 'done')) return 'taskDone'
  if (event.type === 'task.block' || event.type === 'task.run.prompt_failed' || event.type === 'human_gate.blocked_task' || (event.type === 'task.run.completed' && event.payload?.['taskStatus'] === 'blocked')) return 'taskBlocked'
  if (event.type === 'task.run.prompt_failed' || event.type === 'task.run.lease_expired' || (event.type === 'task.run.completed' && ['failed', 'errored', 'blocked'].includes(String(event.payload?.['runStatus'] || '')))) return 'runFailed'
  if (event.type === 'human_gate.created' || event.type === 'human_gate.escalated') return 'humanGatePending'
  if (event.type === 'opencode.request.notified' && event.payload?.['kind'] === 'question') return 'opencodeQuestionPending'
  if (event.type === 'opencode.request.notified' && event.payload?.['kind'] === 'permission') return 'opencodePermissionPending'
  if (event.type === 'alert.detected' && event.payload?.['severity'] === 'critical') return 'criticalAlertActive'
  if (event.type === 'roadmap.completion.proposed' || event.type === 'roadmap.completion.rejected') return 'completionProposal'
  if (event.type === 'roadmap.supervisor.review_requested') return 'manualPoke'
  if (event.type === 'delegation.progress' || event.type === 'delegation.completed') return 'delegatedProgress'
  if (event.type === 'delegation.blocked' || event.type === 'delegation.failed') return 'delegatedProgress'
  if (event.type === 'channel.mention' || event.type === 'channel.inbound_mention') return 'channelMention'
  return undefined
}

function supervisorWakeReasonForEvent(event: WorkEventRecord, detail: string): SupervisorWakeReason {
  if (detail === 'allRoadmapTasksDone' || detail === 'taskDone') return 'issue_completed'
  if (detail === 'taskBlocked') return event.type === 'task.run.lease_expired' ? 'stale_run' : 'blocked_work'
  if (detail === 'runFailed') return event.type === 'task.run.lease_expired' ? 'stale_run' : 'failure_alert'
  if (detail === 'humanGatePending' || detail === 'opencodeQuestionPending' || detail === 'opencodePermissionPending') return 'gate_requested'
  if (detail === 'criticalAlertActive') return 'failure_alert'
  if (detail === 'completionProposal') return 'completion_proposal'
  if (detail === 'manualPoke') return 'manual_poke'
  if (detail === 'delegatedProgress') return 'delegated_progress'
  if (detail === 'channelMention') return 'channel_mention'
  return 'delegated_progress'
}

function supervisorWakeupIdempotencyKey(supervisor: RoadmapSupervisorRecord, wakeup: SupervisorWakeupCandidate): string {
  return artifactHash(['supervisor-wakeup-v1', supervisor.supervisorId, supervisor.roadmapId, wakeup.wakeReason, wakeup.windowKey, wakeup.cursorEventId].join('\n')).slice(0, 32)
}

function upsertSupervisorWakeupReceiptRow(db: DatabaseSync, supervisor: RoadmapSupervisorRecord, wakeup: SupervisorWakeupCandidate, lease: { idempotencyKey: string; leaseOwner: string; leaseExpiresAt: string }, now: string): SupervisorWakeupReceiptRecord {
  const triggerEventIds = wakeup.events.map(event => event.id)
  const inspectedInputs = inspectedInputsForWakeup(supervisor, wakeup)
  const existing = db.prepare('SELECT * FROM supervisor_wakeup_receipts WHERE idempotency_key = ?').get(lease.idempotencyKey) as any
  const id = existing?.id ? String(existing.id) : `supervisor_wakeup_${randomUUID()}`
  if (existing?.id) {
    db.prepare(`UPDATE supervisor_wakeup_receipts
      SET supervisor_id = ?, roadmap_id = ?, wake_reason = ?, reason_detail = ?, window_key = ?, cursor_event_id = ?, trigger_event_ids_json = ?, lease_owner = ?, lease_expires_at = ?, status = 'leased', inspected_inputs_json = ?, completed_at = NULL, updated_at = ?
      WHERE id = ?`)
      .run(supervisor.supervisorId, supervisor.roadmapId, wakeup.wakeReason, wakeup.reasonDetail, wakeup.windowKey, wakeup.cursorEventId, JSON.stringify(triggerEventIds), lease.leaseOwner, lease.leaseExpiresAt, JSON.stringify(inspectedInputs), now, id)
  } else {
    db.prepare(`INSERT INTO supervisor_wakeup_receipts (
      id, supervisor_id, roadmap_id, wake_reason, reason_detail, idempotency_key, window_key, cursor_event_id, trigger_event_ids_json, lease_owner, lease_expires_at, status, summary, inspected_inputs_json, changed_object_ids_json, recommendation, next_action, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'leased', NULL, ?, '[]', NULL, NULL, ?, ?)`)
      .run(id, supervisor.supervisorId, supervisor.roadmapId, wakeup.wakeReason, wakeup.reasonDetail, lease.idempotencyKey, wakeup.windowKey, wakeup.cursorEventId, JSON.stringify(triggerEventIds), lease.leaseOwner, lease.leaseExpiresAt, JSON.stringify(inspectedInputs), now, now)
  }
  const row = db.prepare('SELECT * FROM supervisor_wakeup_receipts WHERE id = ?').get(id) as any
  return rowToSupervisorWakeupReceipt(row)!
}

function completeSupervisorWakeupReceiptRow(db: DatabaseSync, supervisor: RoadmapSupervisorRecord, input: { leaseOwner?: string; status: SupervisorWakeupReceiptStatus; summary?: string; inspectedInputs?: string[]; changedObjectIds?: string[]; recommendation?: string; nextAction?: string; cursorEventId: number; nextWakeAt?: string }, now: string): SupervisorWakeupReceiptRecord | undefined {
  const leaseOwner = input.leaseOwner || supervisor.wakeLeaseOwner
  const row = leaseOwner
    ? db.prepare("SELECT * FROM supervisor_wakeup_receipts WHERE supervisor_id = ? AND lease_owner = ? AND status = 'leased' ORDER BY created_at DESC, id DESC LIMIT 1").get(supervisor.supervisorId, leaseOwner) as any
    : db.prepare("SELECT * FROM supervisor_wakeup_receipts WHERE supervisor_id = ? AND status = 'leased' ORDER BY created_at DESC, id DESC LIMIT 1").get(supervisor.supervisorId) as any
  if (!row?.id) return undefined
  const summary = normalizeOptionalString(input.summary, 2000)
  const inspectedInputs = uniqueResultStrings([
    ...normalizeStringList(parseJSON(row.inspected_inputs_json, []), 500),
    ...normalizeStringList(input.inspectedInputs || [], 500),
  ])
  const changedObjectIds = uniqueResultStrings(normalizeStringList(input.changedObjectIds || [], 500))
  const recommendation = normalizeOptionalString(input.recommendation, 2000)
  const nextAction = normalizeOptionalString(input.nextAction, 2000)
  db.prepare(`UPDATE supervisor_wakeup_receipts
    SET status = ?, summary = ?, inspected_inputs_json = ?, changed_object_ids_json = ?, recommendation = ?, next_action = ?, cursor_event_id = ?, next_wake_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ?`)
    .run(input.status, summary || null, JSON.stringify(inspectedInputs), JSON.stringify(changedObjectIds), recommendation || null, nextAction || null, input.cursorEventId, input.nextWakeAt || null, now, now, row.id)
  const updated = db.prepare('SELECT * FROM supervisor_wakeup_receipts WHERE id = ?').get(row.id) as any
  return rowToSupervisorWakeupReceipt(updated) || undefined
}

function inspectedInputsForWakeup(supervisor: RoadmapSupervisorRecord, wakeup: SupervisorWakeupCandidate): string[] {
  return uniqueResultStrings([
    `supervisor:${supervisor.supervisorId}`,
    `roadmap:${supervisor.roadmapId}`,
    `cursor:${wakeup.cursorEventId}`,
    `window:${wakeup.windowKey}`,
    ...wakeup.events.map(event => `event:${event.id}:${event.type}`),
  ])
}

function eventRoadmapId(event: WorkEventRecord, state: WorkState): string | undefined {
  if (typeof event.payload?.['roadmapId'] === 'string') return event.payload['roadmapId']
  if (typeof event.subjectId === 'string' && state.roadmaps.some(roadmap => roadmap.id === event.subjectId)) return event.subjectId
  const taskId = typeof event.subjectId === 'string' ? event.subjectId : typeof event.payload?.['taskId'] === 'string' ? event.payload['taskId'] : undefined
  return taskId ? state.tasks.find(task => task.id === taskId)?.roadmapId : undefined
}

function supervisorWakeTriggerPolicy(supervisor: RoadmapSupervisorRecord): Record<string, any> {
  return {
    taskDone: true,
    taskBlocked: true,
    runFailed: true,
    humanGatePending: true,
    opencodeQuestionPending: true,
    opencodePermissionPending: true,
    criticalAlertActive: true,
    allRoadmapTasksDone: true,
    completionProposal: true,
    manualPoke: true,
    delegatedProgress: true,
    channelMention: true,
    cadence: true,
    ...supervisor.eventTriggers,
  }
}

function supervisorCadenceMs(supervisor: RoadmapSupervisorRecord): number {
  const raw = Number((supervisor.cadence as any)?.intervalMs || 0)
  return Number.isFinite(raw) && raw > 0 ? Math.max(60 * 1000, Math.min(raw, 30 * 24 * 60 * 60 * 1000)) : 0
}

function nextSupervisorReviewAt(supervisor: RoadmapSupervisorRecord, nowMs: number): string | undefined {
  const intervalMs = supervisorCadenceMs(supervisor)
  return intervalMs > 0 ? new Date(nowMs + intervalMs).toISOString() : undefined
}

function upsertProjectBindingInState(state: WorkState, input: ProjectBindingInput, now: string, bindingId?: string): ProjectBindingRecord {
  const alias = normalizeProjectAlias(input.alias)
  const scope = normalizeProjectBindingScope(input.scope, input.provider)
  const provider = normalizeProjectBindingProvider(input.provider, scope)
  const chatId = normalizeProjectBindingChatId(input.chatId, scope)
  const threadId = normalizeThreadId(input.threadId)
  const roadmapId = normalizeRequiredString(input.roadmapId, 'roadmapId', 120)
  const sessionId = normalizeRequiredString(input.sessionId, 'sessionId', 200)
  const allowRebind = input.allowRebind === true
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap) throw new Error(`roadmap not found: ${roadmapId}`)
  if (roadmap.status === 'archived') throw new Error(`roadmap is archived: ${roadmapId}`)

  const aliasConflict = state.projectBindings.find(binding => binding.id !== bindingId && binding.alias === alias && binding.scope === scope)
  const surfaceKey = scope === 'global' ? undefined : projectBindingSurfaceKey({ scope, provider, chatId, threadId, sessionId } as ProjectBindingRecord)
  const surfaceConflict = surfaceKey ? state.projectBindings.find(binding => binding.id !== bindingId && projectBindingSurfaceKey(binding) === surfaceKey) : undefined
  for (const conflict of [aliasConflict, surfaceConflict].filter(Boolean) as ProjectBindingRecord[]) {
    if (!allowRebind && !sameProjectBindingTarget(conflict, { alias, roadmapId, sessionId, scope, provider, chatId, threadId })) {
      if (conflict === aliasConflict) throw new Error(`project alias already bound for ${scope}: ${alias}`)
      throw new Error(`project surface already bound: ${projectBindingSurfaceKey(conflict)}`)
    }
  }

  const existing = bindingId ? state.projectBindings.find(binding => binding.id === bindingId) : undefined
  if (bindingId && !existing) throw new Error(`project binding not found: ${bindingId}`)
  const reusable = existing || (allowRebind ? aliasConflict || surfaceConflict : aliasConflict)
  const conflicts = new Set([aliasConflict, surfaceConflict].filter(Boolean).map(binding => binding!.id))
  if (reusable) conflicts.delete(reusable.id)
  if (conflicts.size) state.projectBindings = state.projectBindings.filter(binding => !conflicts.has(binding.id))

  const record: ProjectBindingRecord = {
    id: reusable?.id || `project_binding_${randomUUID()}`,
    alias,
    roadmapId,
    sessionId,
    scope,
    provider,
    chatId,
    threadId: threadId || undefined,
    title: normalizeOptionalString(input.title, 200) || roadmap.title,
    notificationMode: normalizeProjectNotificationMode(input.notificationMode || reusable?.notificationMode),
    mutedUntil: normalizeOptionalIsoTime(input.mutedUntil ?? reusable?.mutedUntil, 'mutedUntil'),
    quietHours: normalizeJsonObject(input.quietHours ?? reusable?.quietHours, 'quietHours'),
    lastDigestAt: normalizeOptionalIsoTime(input.lastDigestAt ?? reusable?.lastDigestAt, 'lastDigestAt'),
    createdAt: reusable?.createdAt || now,
    updatedAt: now,
  }
  if (reusable) {
    const index = state.projectBindings.findIndex(binding => binding.id === reusable.id)
    state.projectBindings[index] = record
  } else {
    state.projectBindings.push(record)
  }
  return record
}

function resolvedProjectContext(state: WorkState, binding: ProjectBindingRecord, reason: string): ProjectContextResolution {
  const roadmap = state.roadmaps.find(row => row.id === binding.roadmapId)
  if (!roadmap) return { status: 'not_found', reason: `Roadmap not found for binding ${binding.id}: ${binding.roadmapId}`, binding }
  return { status: 'resolved', reason, binding, roadmap, supervisor: defaultRoadmapSupervisor(state, roadmap.id) }
}

function normalizeProjectBindingScope(value: unknown, provider?: string): ProjectBindingScope {
  if (value === undefined || value === null || value === '') {
    if (provider === 'telegram' || provider === 'whatsapp' || provider === 'discord') return provider
    return 'global'
  }
  if (value === 'global' || value === 'opencode' || value === 'telegram' || value === 'whatsapp' || value === 'discord') return value
  throw new Error(`project binding scope must be global, opencode, telegram, whatsapp, or discord: ${String(value)}`)
}

function normalizeProjectBindingProvider(value: unknown, scope: ProjectBindingScope): string | undefined {
  if (scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') {
    const provider = normalizeRequiredString(value || scope, 'provider', 40)
    if (provider !== scope) throw new Error(`provider must match project binding scope: ${scope}`)
    return provider
  }
  if (value !== undefined && value !== null && value !== '') throw new Error(`provider is only valid for channel project bindings`)
  return undefined
}

function normalizeProjectNotificationMode(value: unknown): ProjectNotificationMode {
  if (value === undefined || value === null || value === '') return 'immediate'
  if (value === 'immediate' || value === 'digest' || value === 'muted') return value
  throw new Error(`project notification mode must be immediate, digest, or muted: ${String(value)}`)
}


function normalizeProjectBindingChatId(value: unknown, scope: ProjectBindingScope): string | undefined {
  if (scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') return normalizeRequiredString(value, 'chatId', 200)
  if (value !== undefined && value !== null && value !== '') throw new Error('chatId is only valid for channel project bindings')
  return undefined
}

function projectBindingSurfaceKey(input: Pick<ProjectBindingRecord, 'scope' | 'provider' | 'chatId' | 'threadId' | 'sessionId'>): string {
  if (input.scope === 'telegram' || input.scope === 'whatsapp' || input.scope === 'discord') return `${input.scope}:${input.provider || ''}:${input.chatId || ''}:${normalizeThreadId(input.threadId)}`
  if (input.scope === 'opencode') return `opencode:${input.sessionId}`
  return `global:${input.scope}`
}

function sameProjectBindingTarget(binding: ProjectBindingRecord, input: Pick<ProjectBindingRecord, 'alias' | 'roadmapId' | 'sessionId' | 'scope' | 'provider' | 'chatId' | 'threadId'>): boolean {
  return binding.alias === input.alias && binding.roadmapId === input.roadmapId && binding.sessionId === input.sessionId && binding.scope === input.scope && (binding.provider || '') === (input.provider || '') && (binding.chatId || '') === (input.chatId || '') && (binding.threadId || '') === normalizeThreadId(input.threadId)
}

function projectBindingChannelChanged(previous: ProjectBindingRecord, next: ProjectBindingRecord): boolean {
  return Boolean(previous.provider && previous.chatId && ((previous.provider || '') !== (next.provider || '') || (previous.chatId || '') !== (next.chatId || '') || normalizeThreadId(previous.threadId) !== normalizeThreadId(next.threadId)))
}

function deleteProjectBindingChannelRow(db: DatabaseSync, binding: ProjectBindingRecord): void {
  if (!binding.provider || !binding.chatId) return
  // The channel key may have been independently rebound after this project row
  // was mirrored. Delete only the exact mirror generation we created; a newer
  // chat/task/roadmap binding at the same provider target must survive.
  db.prepare(`DELETE FROM channel_bindings
    WHERE provider = ? AND chat_id = ? AND thread_id = ?
      AND mode = 'roadmap' AND roadmap_id = ? AND session_id = ?`)
    .run(binding.provider, binding.chatId, normalizeThreadId(binding.threadId), binding.roadmapId, binding.sessionId)
}

function approveRoadmapCompletionProposalInState(_state: WorkState, db: DatabaseSync, proposal: RoadmapCompletionProposalRecord, roadmap: RoadmapRecord, decision: { actor: string; source: string; note?: string }, now: string): void {
  proposal.status = 'approved'
  proposal.decisionBy = decision.actor
  proposal.decisionNote = decision.note
  proposal.updatedAt = now
  roadmap.status = 'done'
  roadmap.updatedAt = now
  appendWorkEventRow(db, 'roadmap.completion.approved', proposal.id, { roadmapId: roadmap.id, actor: decision.actor, source: decision.source, note: decision.note }, now)
  appendWorkEventRow(db, 'audit.human_decision', roadmap.id, { actor: decision.actor, source: decision.source, operation: 'roadmap_completion.approve', target: proposal.id, result: 'ok', note: decision.note }, now)
}

function completionAutoBlockers(state: WorkState, db: DatabaseSync, roadmap: RoadmapRecord, proposal: RoadmapCompletionProposalRecord): string[] {
  const blockers: string[] = []
  if (state.tasks.some(task => task.roadmapId === roadmap.id && task.status === 'blocked')) blockers.push('blocked tasks exist')
  const gates = queryRows(db, "SELECT * FROM human_gates WHERE roadmap_id = ? AND status IN ('pending', 'escalated')", roadmap.id).map(rowToHumanGate).filter(Boolean) as HumanGateRecord[]
  if (gates.length) blockers.push('open required gates exist')
  const criticalAlerts = queryRows(db, "SELECT * FROM alerts WHERE severity = 'critical' AND status IN ('active', 'acknowledged')").map(rowToAlert).filter(Boolean) as AlertRecord[]
  if (criticalAlerts.length) blockers.push('active critical alerts exist')
  const required = [...(roadmap.qualitySpec?.evidenceRequirements || []), ...(roadmap.qualitySpec?.requiredArtifacts || [])]
  if (required.length) {
    const evidenceText = proposal.evidence.join('\n').toLowerCase()
    const missing = required.filter(item => !evidenceText.includes(item.toLowerCase()))
    if (missing.length) blockers.push(`missing required evidence: ${missing.join(', ')}`)
  }
  if (proposal.unresolvedRisks.length) blockers.push('unresolved risks exist')
  return blockers
}

function compareProjectBindings(a: ProjectBindingRecord, b: ProjectBindingRecord): number {
  const scope = scopeRank(a.scope) - scopeRank(b.scope)
  if (scope !== 0) return scope
  const alias = a.alias.localeCompare(b.alias)
  if (alias !== 0) return alias
  const created = Date.parse(a.createdAt) - Date.parse(b.createdAt)
  if (Number.isFinite(created) && created !== 0) return created
  return a.id.localeCompare(b.id)
}

function compareRoadmapCompletionProposals(a: RoadmapCompletionProposalRecord, b: RoadmapCompletionProposalRecord): number {
  const status = completionProposalStatusRank(a.status) - completionProposalStatusRank(b.status)
  if (status !== 0) return status
  const created = Date.parse(b.createdAt) - Date.parse(a.createdAt)
  if (Number.isFinite(created) && created !== 0) return created
  return a.id.localeCompare(b.id)
}

function completionProposalStatusRank(status: RoadmapCompletionProposalStatus): number {
  return status === 'pending' ? 0 : status === 'approved' ? 1 : status === 'rejected' ? 2 : 3
}

function scopeRank(scope: ProjectBindingScope): number {
  if (scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') return 0
  if (scope === 'opencode') return 1
  return 2
}

export function upsertChannelBindingRow(db: DatabaseSync, input: { provider: string; chatId: string; threadId?: string; sessionId: string; mode?: ChannelBindingMode; roadmapId?: string; taskId?: string; title?: string; createdAt?: string }, now: string): void {
  db.prepare(`INSERT INTO channel_bindings (
    provider, chat_id, thread_id, session_id, mode, roadmap_id, task_id, title, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider, chat_id, thread_id) DO UPDATE SET
    session_id = excluded.session_id,
    mode = excluded.mode,
    roadmap_id = excluded.roadmap_id,
    task_id = excluded.task_id,
    title = excluded.title,
    updated_at = excluded.updated_at`)
    .run(input.provider, input.chatId, normalizeThreadId(input.threadId), input.sessionId, input.mode || 'chat', input.roadmapId || null, input.taskId || null, input.title || null, input.createdAt || now, now)
}

function validateTaskUpdate(state: WorkState, task: WorkTaskRecord, input: WorkTaskUpdateInput): void {
  if (input.status !== undefined && normalizeWorkStatus(input.status) === 'running') throw new Error('running status is reserved for scheduler run dispatch')
  const roadmapId = input.roadmapId ?? task.roadmapId
  assertRoadmapAcceptsTasks(state, roadmapId)
  const pipeline = input.pipeline !== undefined ? normalizeTaskPipeline(input.pipeline, task.pipeline) : task.pipeline
  const currentStage = input.currentStage !== undefined ? input.currentStage ? normalizeStage(input.currentStage, 'currentStage') : undefined : task.currentStage
  if (input.currentStage !== undefined && currentStage && !pipeline.includes(currentStage)) throw new Error(`currentStage must be in pipeline: ${currentStage}`)
  if (input.currentStage === undefined && task.status === 'running' && currentStage && !pipeline.includes(currentStage)) throw new Error(`currentStage must be in pipeline: ${currentStage}`)
  if (input.earliestStartAt !== undefined) normalizeOptionalIsoTime(input.earliestStartAt, 'earliestStartAt')
  if (input.deadlineAt !== undefined) normalizeOptionalIsoTime(input.deadlineAt, 'deadlineAt')
  if (input.manualGate !== undefined) normalizeManualGate(input.manualGate)
  if (input.agentTeam !== undefined) normalizeOptionalAgentTeam(input.agentTeam, 'agentTeam')
  if (input.stageProfiles !== undefined) normalizeStageProfileOverrides(input.stageProfiles, 'stageProfiles')
  if (input.qualitySpec !== undefined) normalizeTaskQualitySpec(input.qualitySpec)
}

function addWorkDependencyInState(state: WorkState, db: DatabaseSync, input: WorkDependencyInput, now: string): WorkDependencyRecord {
  state.dependencies ||= []
  const taskId = normalizeRequiredString(input.taskId, 'taskId', 120)
  const dependsOnTaskId = normalizeRequiredString(input.dependsOnTaskId, 'dependsOnTaskId', 120)
  const type = normalizeDependencyType(input.type)
  if (taskId === dependsOnTaskId) throw new Error('task cannot depend on itself')
  if (!state.tasks.some(task => task.id === taskId)) throw new Error(`task not found: ${taskId}`)
  if (!state.tasks.some(task => task.id === dependsOnTaskId)) throw new Error(`dependency task not found: ${dependsOnTaskId}`)
  const existing = state.dependencies.find(dep => dep.taskId === taskId && dep.dependsOnTaskId === dependsOnTaskId && dep.type === type)
  if (existing) return existing
  assertNoDependencyCycle(state, { taskId, dependsOnTaskId, type, createdAt: now })
  const record = { taskId, dependsOnTaskId, type, createdAt: now }
  state.dependencies.push(record)
  appendWorkEventRow(db, 'task.dependency.created', taskId, { dependsOnTaskId, type }, now)
  return record
}

function assertRoadmapAcceptsTasks(state: WorkState, roadmapId: string): void {
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap) throw new Error(`roadmap not found: ${roadmapId}`)
  if (roadmap.status === 'archived') throw new Error(`roadmap is archived: ${roadmapId}`)
}

function assertRoadmapAcceptsSupervisors(state: WorkState, roadmapId: string, options: { allowArchivedSupervisor?: boolean } = {}): void {
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap) throw new Error(`roadmap not found: ${roadmapId}`)
  if (!options.allowArchivedSupervisor && roadmap.status === 'archived') throw new Error(`roadmap is archived: ${roadmapId}`)
}

function assertProfileExists(profile: string): void {
  if (!getConfig().profiles[profile]) throw new Error(`profile not found: ${profile}`)
}

function assertAgentTeamExists(agentTeam: string): void {
  if (!getConfig().agentTeams[agentTeam]) throw new Error(`agent team not found: ${agentTeam}`)
}

function normalizeOptionalAgentTeam(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const agentTeam = normalizeStage(value, label)
  assertAgentTeamExists(agentTeam)
  return agentTeam
}

function normalizeStageProfileOverrides(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const profiles: Record<string, string> = {}
  for (const [stage, rawProfile] of Object.entries(value as Record<string, unknown>)) {
    const normalizedStage = stage === 'default' ? 'default' : normalizeStage(stage, `${label}.${stage}`)
    const profile = normalizeOptionalIdentifier(rawProfile, `${label}.${stage}`)
    if (!profile) throw new Error(`${label}.${stage} is required`)
    assertProfileExists(profile)
    profiles[normalizedStage] = profile
  }
  return Object.keys(profiles).length ? profiles : undefined
}

function assertStageInPipeline(task: WorkTaskRecord, stage: string): void {
  if (!task.pipeline.includes(stage)) throw new Error(`stage must be in pipeline: ${stage}`)
}

function normalizeTaskPipeline(input?: string[], fallback = defaultPipeline()): string[] {
  const source = Array.isArray(input) && input.length > 0 ? input : fallback
  const candidates = source
    .map((stage, index) => {
      if (typeof stage !== 'string') throw new Error(`pipeline stage at index ${index} must be a string`)
      return stage.trim()
    })
    .filter(Boolean)
  const pipeline = [...new Set(candidates)]
  if (pipeline.length === 0) throw new Error('pipeline must include at least one stage')
  for (const stage of pipeline) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(stage)) throw new Error(`pipeline contains invalid stage: ${stage}`)
  }
  return pipeline
}

function normalizeTaskCreateList(inputs: unknown): WorkTaskCreateInput[] {
  if (!Array.isArray(inputs)) throw new Error('tasks must be an array')
  return inputs.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`task at index ${index} must be an object`)
    return input as WorkTaskCreateInput
  })
}

function normalizeTaskUpdateList(inputs: unknown): WorkTaskBulkUpdateInput[] {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('updates must include at least one task update')
  return inputs.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`update at index ${index} must be an object`)
    const update = input as WorkTaskBulkUpdateInput
    if (typeof update.taskId !== 'string' || !update.taskId.trim()) throw new Error(`update at index ${index} requires taskId`)
    return update
  })
}

function normalizeRoadmapStatus(value: unknown): RoadmapStatus {
  if (value === 'active' || value === 'done' || value === 'blocked' || value === 'archived') return value
  throw new Error(`roadmap status must be active, done, blocked, or archived: ${String(value)}`)
}

function normalizeRoadmapSupervisorStatus(value: unknown): RoadmapSupervisorStatus {
  if (value === 'active' || value === 'paused' || value === 'blocked' || value === 'completed' || value === 'archived') return value
  throw new Error(`roadmap supervisor status must be active, paused, blocked, completed, or archived: ${String(value)}`)
}

function normalizeWorkStatus(value: unknown): WorkStatus {
  if (value === 'pending' || value === 'running' || value === 'done' || value === 'blocked' || value === 'paused' || value === 'cancelled' || value === 'archived') return value
  throw new Error(`task status must be pending, running, done, blocked, paused, cancelled, or archived: ${String(value)}`)
}

function normalizeWorkTaskAction(value: unknown): WorkTaskAction {
  if (value === 'pause' || value === 'resume' || value === 'cancel' || value === 'retry' || value === 'done' || value === 'block') return value
  throw new Error(`task action must be pause, resume, cancel, retry, done, or block: ${String(value)}`)
}

function normalizeDependencyType(value: unknown): WorkDependencyType {
  if (value === undefined || value === null || value === '') return 'blocks'
  if (value === 'blocks' || value === 'blocked_by' || value === 'parent' || value === 'child' || value === 'related' || value === 'duplicate') return value
  throw new Error(`dependency type must be blocks, blocked_by, parent, child, related, or duplicate: ${String(value)}`)
}

function normalizeManualGate(value: unknown): ManualGate | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'approval_required' || value === 'credentials_required' || value === 'external_dependency' || value === 'waiting_for_user') return value
  throw new Error(`manualGate must be approval_required, credentials_required, external_dependency, or waiting_for_user: ${String(value)}`)
}


function blockingDependenciesForTask(taskId: string, state: WorkState, indexes?: Pick<WorkTaskReadinessIndexes, 'dependenciesByTask'>): WorkDependencyRecord[] {
  const dependencies = indexes?.dependenciesByTask?.get(taskId) || state.dependencies || []
  return dependencies.filter(dep => dep.taskId === taskId && (dep.type === 'blocks' || dep.type === 'blocked_by' || dep.type === 'parent'))
}

function manualGateReason(gate: ManualGate): string {
  if (gate === 'approval_required') return 'Waiting for operator approval'
  if (gate === 'credentials_required') return 'Waiting for credentials'
  if (gate === 'external_dependency') return 'Waiting for an external dependency'
  return 'Waiting for user input'
}

function humanGateInputForManualTask(task: WorkTaskRecord): HumanGateInput {
  const manualGate = task.manualGate || 'waiting_for_user'
  return {
    type: humanGateTypeForManualGate(manualGate),
    roadmapId: task.roadmapId,
    taskId: task.id,
    stage: task.currentStage || task.pipeline[0] || 'implement',
    reason: manualGateReason(manualGate),
    requestedBy: 'gateway.manual_gate',
    scopeKey: `manual:${task.id}:${manualGate}`,
    details: { manualGate },
  }
}

function humanGateTypeForManualGate(gate: ManualGate): HumanGateType {
  if (gate === 'approval_required') return 'task_start'
  if (gate === 'credentials_required') return 'credential_use'
  if (gate === 'external_dependency') return 'external_side_effect'
  return 'manual'
}

export function insertHumanGateRow(db: DatabaseSync, input: HumanGateInput, now: string, options: { force: boolean }): HumanGateRecord | undefined {
  const type = normalizeHumanGateType(input.type)
  const taskId = normalizeOptionalString(input.taskId, 120)
  const roadmapId = normalizeOptionalString(input.roadmapId, 120)
  const runId = normalizeOptionalString(input.runId, 120)
  const stage = input.stage ? normalizeStage(input.stage, 'stage') : undefined
  const reason = normalizeRequiredString(input.reason, 'reason', 1000)
  const requestedBy = normalizeOptionalString(input.requestedBy, 120) || 'gateway'
  const timeoutAction = normalizeHumanGateTimeoutAction(input.timeoutAction || getConfig().humanLoop.timeoutAction)
  const expiresAt = normalizeOptionalIsoTime(input.expiresAt, 'expiresAt') || defaultHumanGateExpiresAt(taskId, now)
  const scopeKey = normalizeOptionalString(input.scopeKey, 300) || defaultHumanGateScopeKey({ type, taskId, roadmapId, runId, stage })
  const details = input.details && typeof input.details === 'object' && !Array.isArray(input.details) ? input.details : {}

  if (!options.force && scopeKey) {
    const approved = rowToHumanGate(db.prepare("SELECT * FROM human_gates WHERE scope_key = ? AND status = 'approved' ORDER BY updated_at DESC LIMIT 1").get(scopeKey))
    if (approved) return undefined
    const existingOpen = rowToHumanGate(db.prepare("SELECT * FROM human_gates WHERE scope_key = ? AND status IN ('pending', 'escalated') ORDER BY requested_at ASC LIMIT 1").get(scopeKey))
    if (existingOpen) return existingOpen
  }

  const id = `gate_${randomUUID()}`
  db.prepare(`INSERT INTO human_gates (
    id, type, status, roadmap_id, task_id, run_id, stage, reason, requested_by, requested_at, updated_at,
    expires_at, timeout_action, scope_key, details_json
  ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    type,
    roadmapId || null,
    taskId || null,
    runId || null,
    stage || null,
    reason,
    requestedBy,
    now,
    now,
    expiresAt || null,
    timeoutAction,
    scopeKey || null,
    JSON.stringify(details),
  )
  appendWorkEventRow(db, 'human_gate.created', taskId || roadmapId || id, { gateId: id, type, stage, reason, expiresAt, timeoutAction }, now)
  return rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id))!
}

function defaultHumanGateExpiresAt(taskId: string | undefined, now: string): string | undefined {
  const config = getConfig().humanLoop
  if (!config.enabled) return undefined
  void taskId
  return new Date(Date.parse(now) + config.defaultTimeoutMs).toISOString()
}

function defaultHumanGateScopeKey(input: { type: HumanGateType; taskId?: string; roadmapId?: string; runId?: string; stage?: string }): string | undefined {
  if (input.runId) return `${input.type}:run:${input.runId}`
  if (input.taskId) return `${input.type}:task:${input.taskId}:${input.stage || ''}`
  if (input.roadmapId) return `${input.type}:roadmap:${input.roadmapId}:${input.stage || ''}`
  return undefined
}

function normalizeHumanGateType(value: unknown): HumanGateType {
  if (value === 'task_start' || value === 'stage_transition' || value === 'external_side_effect' || value === 'budget_exception' || value === 'destructive_action' || value === 'credential_use' || value === 'manual') return value
  throw new Error(`human gate type must be task_start, stage_transition, external_side_effect, budget_exception, destructive_action, credential_use, or manual: ${String(value)}`)
}

export function normalizeHumanGateDecision(value: unknown): HumanGateDecision {
  if (value === 'approve' || value === 'reject') return value
  throw new Error(`human gate decision must be approve or reject: ${String(value)}`)
}

export function normalizeHumanGateScope(value: unknown): HumanGateScope {
  if (value === undefined || value === null || value === '') return 'once'
  if (value === 'once' || value === 'always') return value
  throw new Error(`human gate scope must be once or always: ${String(value)}`)
}

function normalizeHumanGateTimeoutAction(value: unknown): HumanGateTimeoutAction {
  if (value === 'remind' || value === 'escalate' || value === 'pause' || value === 'block') return value
  throw new Error(`human gate timeout action must be remind, escalate, pause, or block: ${String(value)}`)
}


function compareTaskReadiness(a: WorkTaskView, b: WorkTaskView): number {
  const readiness = readinessRank(a.readiness?.status) - readinessRank(b.readiness?.status)
  if (readiness !== 0) return readiness
  const priority = priorityRank(a.priority) - priorityRank(b.priority)
  if (priority !== 0) return priority
  const aDeadline = Date.parse(a.deadlineAt || '')
  const bDeadline = Date.parse(b.deadlineAt || '')
  if (Number.isFinite(aDeadline) || Number.isFinite(bDeadline)) return (Number.isFinite(aDeadline) ? aDeadline : Number.MAX_SAFE_INTEGER) - (Number.isFinite(bDeadline) ? bDeadline : Number.MAX_SAFE_INTEGER)
  return Date.parse(a.createdAt) - Date.parse(b.createdAt)
}

function readinessRank(status: WorkTaskReadinessStatus | undefined): number {
  if (status === 'runnable') return 0
  if (status === 'running') return 1
  if (status === 'blocked' || status === 'waiting') return 2
  if (status === 'scheduled') return 3
  if (status === 'paused') return 4
  return 5
}

function assertNoDependencyCycle(state: WorkState, proposed: WorkDependencyRecord): void {
  if (!isBlockingDependency(proposed)) return
  const edges = [...(state.dependencies || []).filter(isBlockingDependency), proposed]
  const visit = (taskId: string, seen: Set<string>): boolean => {
    if (taskId === proposed.taskId) return true
    if (seen.has(taskId)) return false
    seen.add(taskId)
    return edges.filter(dep => dep.taskId === taskId).some(dep => visit(dep.dependsOnTaskId, seen))
  }
  if (visit(proposed.dependsOnTaskId, new Set())) throw new Error('dependency would create a cycle')
}

function isBlockingDependency(dep: WorkDependencyRecord): boolean {
  return dep.type === 'blocks' || dep.type === 'blocked_by' || dep.type === 'parent'
}

export function mutateWorkState<T>(filePath: string, fn: (state: WorkState, db: DatabaseSync) => T): T {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  const dbPath = path.resolve(filePath)
  // Pin this handle for the whole transaction so a nested cross-path open under
  // the cache cap can't evict/close it out from under the BEGIN IMMEDIATE.
  markWorkDbActive(dbPath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const state = readWorkState(db, { runsScope: 'live' })
      // Capture per-row fingerprints of the pre-mutation state instead of
      // deep-cloning and re-serializing the whole state twice: readWorkState
      // output is already normalized, so serializing each row once here yields
      // exactly the strings the post-mutation diff compares against. Unchanged
      // rows are never rewritten (guarded by the DELETE-trigger test).
      const before = captureWorkStateFingerprints(state)
      const result = fn(state, db)
      syncWorkStateRows(db, before, state)
      db.exec('COMMIT')
      return result
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    unmarkWorkDbActive(dbPath)
    db.close()
  }
}

import { appendWorkEventRow, appendAuditLedgerRowForWorkEvent, upsertDelegationProgressRouteReceiptFromEvent, rowToDelegationProgressRouteReceipt } from './work-store/event-append.js'
export { appendWorkEventRow } from './work-store/event-append.js'

function findDelegationReceiptInDb(db: DatabaseSync, idempotencyKey: string): DelegatedWorkReceipt | undefined {
  const receiptRow = db.prepare('SELECT * FROM delegation_receipts WHERE idempotency_key = ?').get(idempotencyKey) as any
  return receiptRow?.idempotency_key ? rowToDelegationReceipt(receiptRow) : undefined
}

function upsertDelegationReceiptRow(db: DatabaseSync, receipt: DelegatedWorkReceipt, now: string): void {
  db.prepare(`INSERT INTO delegation_receipts (
    idempotency_key, target_type, task_ids_json, roadmap_id, supervisor_id, project_binding_id,
    parent_session_id, links_json, next_scheduler_action, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(idempotency_key) DO UPDATE SET
    target_type = excluded.target_type,
    task_ids_json = excluded.task_ids_json,
    roadmap_id = excluded.roadmap_id,
    supervisor_id = excluded.supervisor_id,
    project_binding_id = excluded.project_binding_id,
    parent_session_id = excluded.parent_session_id,
    links_json = excluded.links_json,
    next_scheduler_action = excluded.next_scheduler_action,
    updated_at = excluded.updated_at`)
    .run(
      receipt.idempotencyKey,
      receipt.targetType,
      JSON.stringify(receipt.taskIds),
      receipt.roadmapId || null,
      receipt.supervisorId || null,
      receipt.projectBindingId || null,
      receipt.parentSessionId || null,
      JSON.stringify(receipt.links || {}),
      receipt.nextSchedulerAction,
      now,
      now,
    )
}

function appendDelegationProgressForTask(db: DatabaseSync, task: WorkTaskRecord, progress: DelegatedWorkProgressKind, details: Record<string, unknown>, now: string, ...keyParts: Array<string | undefined>): void {
  for (const context of delegationContextsForTask(db, task)) {
    appendDelegationProgressRow(db, context['idempotencyKey'], progress, task.id, {
      ...context,
      ...details,
      taskId: task.id,
      roadmapId: task.roadmapId,
      links: { ...context['links'], task: `/tasks/${task.id}`, roadmap: `/roadmaps/${task.roadmapId}` },
      progressKey: delegationProgressKey(context['idempotencyKey'], progress, task.id, ...keyParts),
    }, now)
  }
}

function appendDelegationProgressForRoadmap(db: DatabaseSync, roadmapId: string, progress: DelegatedWorkProgressKind, subjectId: string, details: Record<string, unknown>, now: string): void {
  for (const context of delegationContextsForRoadmap(db, roadmapId)) {
    appendDelegationProgressRow(db, context['idempotencyKey'], progress, subjectId, {
      ...context,
      ...details,
      roadmapId,
      links: { ...context['links'], roadmap: `/roadmaps/${roadmapId}` },
      progressKey: delegationProgressKey(context['idempotencyKey'], progress, subjectId),
    }, now)
  }
}

function appendDelegationProgressRow(db: DatabaseSync, idempotencyKey: string, progress: DelegatedWorkProgressKind, subjectId: string | undefined, payload: Record<string, unknown>, now: string): void {
  const progressKey = typeof payload['progressKey'] === 'string' ? payload['progressKey'] : delegationProgressKey(idempotencyKey, progress, subjectId)
  if (!reserveDelegationProgressReceipt(db, progressKey, idempotencyKey, progress, subjectId, now)) return
  const eventId = appendWorkEventRow(db, 'delegation.progress', idempotencyKey, {
    ...payload,
    idempotencyKey,
    progress,
    progressKey,
    subjectId,
  }, now)
  db.prepare('UPDATE delegation_progress_receipts SET event_id = ? WHERE progress_key = ?').run(eventId, progressKey)
}

function delegationContextsForTask(db: DatabaseSync, task: WorkTaskRecord): Array<Record<string, any>> {
  return delegationContexts(db, delegationPayloadLike(task.id)).filter(context => {
    const taskIds = Array.isArray(context['taskIds']) ? context['taskIds'] : []
    return taskIds.includes(task.id)
  })
}

function delegationContextsForRoadmap(db: DatabaseSync, roadmapId: string): Array<Record<string, any>> {
  return delegationContexts(db, delegationPayloadLike(roadmapId)).filter(context => context['roadmapId'] === roadmapId)
}

/**
 * SQL LIKE prefilter for delegation payload scans. Delegation events are
 * durable (never pruned), so per-transition context lookups must not JSON
 * parse every payload ever recorded. The LIKE match runs inside SQLite as a
 * cheap substring scan and may over-match; callers always re-verify on the
 * parsed payload, so the prefilter only needs to never under-match a payload
 * whose JSON contains the quoted id.
 */
function delegationPayloadLike(id: string): string {
  return `%${JSON.stringify(String(id))}%`
}

function delegationContexts(db: DatabaseSync, payloadLike: string): Array<Record<string, any>> {
  const rows = db.prepare("SELECT payload_json FROM events WHERE type = 'delegation.mapped' AND payload_json LIKE ? ORDER BY id ASC").all(payloadLike) as any[]
  if (!rows.length) return []
  const contexts: Array<Record<string, any>> = []
  const keys = new Set<string>()
  for (const row of rows) {
    const payload = parseJSON<Record<string, any>>(row.payload_json, {})
    const idempotencyKey = typeof payload['idempotencyKey'] === 'string' ? payload['idempotencyKey'] : ''
    if (!idempotencyKey) continue
    keys.add(idempotencyKey)
    contexts.push({ ...payload, idempotencyKey })
  }

  const accepted = new Map<string, Record<string, unknown>>()
  for (const key of keys) {
    const acceptedRows = db.prepare("SELECT payload_json FROM events WHERE type = 'delegation.accepted' AND payload_json LIKE ? ORDER BY id ASC").all(delegationPayloadLike(key)) as any[]
    for (const row of acceptedRows) {
      const payload = parseJSON<Record<string, unknown>>(row.payload_json, {})
      if (payload['idempotencyKey'] === key) accepted.set(key, payload)
    }
  }

  return contexts.map(payload => {
    const acceptedPayload = accepted.get(payload['idempotencyKey']) || {}
    return {
      ...payload,
      parentSessionId: typeof payload['parentSessionId'] === 'string' ? payload['parentSessionId'] : acceptedPayload['parentSessionId'],
      notificationTarget: payload['notificationTarget'] || acceptedPayload['notificationTarget'],
      objective: payload['objective'] || acceptedPayload['objective'],
    }
  })
}

function reserveDelegationProgressReceipt(db: DatabaseSync, progressKey: string, idempotencyKey: string, progress: DelegatedWorkProgressKind, subjectId: string | undefined, now: string): boolean {
  const result = db.prepare(`INSERT OR IGNORE INTO delegation_progress_receipts (
    progress_key, idempotency_key, progress, subject_id, event_id, created_at
  ) VALUES (?, ?, ?, ?, NULL, ?)`).run(progressKey, idempotencyKey, progress, subjectId || null, now) as any
  return Number(result?.changes || 0) > 0
}

function delegationProgressKey(...parts: Array<string | undefined>): string {
  return createHash('sha256').update(parts.filter(Boolean).join('\n')).digest('hex').slice(0, 32)
}

function receiptLinks(roadmap: RoadmapRecord | undefined, tasks: WorkTaskRecord[], supervisor: RoadmapSupervisorRecord | undefined, binding: ProjectBindingRecord | undefined): Record<string, string> {
  const links: Record<string, string> = {}
  if (roadmap) links['roadmap'] = `/roadmaps/${roadmap.id}`
  if (tasks.length === 1) links['task'] = `/tasks/${tasks[0]!.id}`
  if (tasks.length > 1) links['tasks'] = `/tasks?roadmapId=${roadmap?.id || ''}`
  if (supervisor) links['supervisor'] = `/roadmap-supervisors/${supervisor.supervisorId}`
  if (binding) links['projectBinding'] = `/project-bindings/${binding.id}`
  return links
}

function nextDelegationSchedulerAction(tasks: WorkTaskRecord[], supervisor?: RoadmapSupervisorRecord): string {
  if (tasks.some(task => task.manualGate)) return 'await_human_gate'
  if (tasks.some(task => task.earliestStartAt && Date.parse(task.earliestStartAt) > Date.now())) return 'scheduled_for_earliest_start'
  if (tasks.length) return 'dispatch_when_scheduler_runs'
  if (supervisor) return 'roadmap_supervisor_review_when_due'
  return 'none'
}


function normalizeActiveRunControlAction(action: ActiveRunControlAction): ActiveRunControlAction {
  if (action === 'cancel' || action === 'stop' || action === 'retry' || action === 'restart') return action
  throw new Error(`active run control action must be cancel, stop, retry, or restart: ${String(action)}`)
}

function activeRunControlSnapshot(state: WorkState, run: RunRecord, now: number, lastOperatorAction?: ActiveRunControlSnapshot['lastOperatorAction']): ActiveRunControlSnapshot | undefined {
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

function lastOperatorActionForRun(events: WorkEventRecord[], runId: string): ActiveRunControlSnapshot['lastOperatorAction'] | undefined {
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

function restartBehaviorForAction(action: ActiveRunControlAction, applied: boolean): ActiveRunControlResult['restartBehavior'] {
  if (!applied) return 'not_applicable'
  if (action === 'restart') return 'new_opencode_session_on_next_scheduler_dispatch'
  if (action === 'retry') return 'durable_requeue_only'
  return 'not_applicable'
}

function activeRunControlNextAction(action: ActiveRunControlAction, reason: ActiveRunControlReason): string {
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

function activeRunSessionIdsForTasks(state: WorkState, taskIds: Set<string>): string[] {
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

function finishRunInState(run: RunRecord, result: StageResult, now: string, attribution: RunAttributionInput = {}): void {
  run.status = result.status === 'pass' ? 'passed' : result.status === 'blocked' ? 'blocked' : 'failed'
  run.completedAt = now
  applyRunAttribution(run, attribution)
  const runtimeMs = Date.parse(now) - Date.parse(run.startedAt)
  run.runtimeMs = Number.isFinite(runtimeMs) && runtimeMs >= 0 ? runtimeMs : undefined
  run.result = result
  run.environment = finalizeEnvironmentRun(run.environment, result.status === 'pass')
}

function collectRunEnvironmentArtifacts(run: RunRecord, result: StageResult, filePath: string): StageResult {
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

function persistFileArtifactRefs(runId: string, refs: string[], filePath: string): string[] {
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

function fileArtifactPath(ref: string): string | undefined {
  if (!ref.startsWith('file:')) return undefined
  const value = ref.slice('file:'.length)
  return value ? path.resolve(value) : undefined
}

function rewriteCapturedMetadata(target: string, copied: Map<string, string>): void {
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

function artifactHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function uniqueResultStrings(values: unknown[]): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function applyRunAttribution(run: RunRecord, attribution: RunAttributionInput = {}): void {
  run.costUsd = normalizeMetric(attribution.costUsd)
  run.inputTokens = normalizeMetric(attribution.inputTokens)
  run.outputTokens = normalizeMetric(attribution.outputTokens)
  run.reasoningTokens = normalizeMetric(attribution.reasoningTokens)
  run.cacheReadTokens = normalizeMetric(attribution.cacheReadTokens)
  run.cacheWriteTokens = normalizeMetric(attribution.cacheWriteTokens)
}

function runAttributionKey(run: RunRecord): string {
  return [run.costUsd || 0, run.inputTokens || 0, run.outputTokens || 0, run.reasoningTokens || 0, run.cacheReadTokens || 0, run.cacheWriteTokens || 0].join(':')
}

function runTokens(run: RunRecord): number {
  return Number(run.inputTokens || 0) + Number(run.outputTokens || 0) + Number(run.reasoningTokens || 0) + Number(run.cacheReadTokens || 0) + Number(run.cacheWriteTokens || 0)
}

function normalizeMetric(value: unknown): number | undefined {
  const number = Number(value || 0)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function applyStageResultInState(state: WorkState, task: WorkTaskRecord, run: RunRecord, result: StageResult, retryLimit: number, now: string): WorkflowDecision {
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

export function recomputeRoadmapStatusInState(state: WorkState, roadmapId: string, now = new Date().toISOString()): RoadmapRecord | undefined {
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap || roadmap.status === 'archived') return roadmap
  const tasks = state.tasks.filter(task => task.roadmapId === roadmapId && task.status !== 'archived')
  if (tasks.length > 0 && tasks.every(task => task.status === 'done')) roadmap.status = 'done'
  else if (tasks.some(task => task.status === 'blocked')) roadmap.status = 'blocked'
  else roadmap.status = 'active'
  roadmap.updatedAt = now
  return roadmap
}

/**
 * Bounded count of recent terminal runs materialized into the live (mutation)
 * WorkState window. The read/mutate hot paths only ever operate on active runs
 * and `currentRunId` runs; this recent slice is a correctness safety margin.
 * All older terminal runs stay durable in SQLite and remain fully queryable via
 * `loadWorkState` (full scope) and the targeted `getRunsForTask` /
 * `getRunCostTokenTotals` reads. Bounded + index-served (idx_runs_started_at)
 * so live materialization stays flat regardless of cumulative run history.
 */
const LIVE_RECENT_TERMINAL_RUNS = 500

/**
 * Read scope for {@link readWorkState}.
 * - `all` materializes every run (durable, complete history) and backs the
 *   public `loadWorkState` reads that historical/all-time consumers depend on.
 * - `live` windows the runs table down to only what the scheduler /
 *   state-machine / completion logic can touch during a mutation, making
 *   materialization latency flat regardless of cumulative run history.
 */
type ReadWorkStateOptions = { runsScope?: 'all' | 'live' }

function readWorkState(db: DatabaseSync, options: ReadWorkStateOptions = {}): WorkState {
  const savedAt = String(getRow(db, "SELECT value FROM meta WHERE key = 'savedAt'")?.['value'] || new Date().toISOString())
  const roadmaps = queryRows(db, 'SELECT * FROM roadmaps ORDER BY created_at ASC').map(rowToRoadmap).filter(Boolean) as RoadmapRecord[]
  const supervisors = queryRows(db, 'SELECT * FROM roadmap_supervisors ORDER BY roadmap_id ASC, created_at ASC').map(rowToRoadmapSupervisor).filter(Boolean) as RoadmapSupervisorRecord[]
  const projectBindings = queryRows(db, 'SELECT * FROM project_bindings ORDER BY alias ASC, created_at ASC').map(rowToProjectBinding).filter(Boolean) as ProjectBindingRecord[]
  const completionProposals = queryRows(db, 'SELECT * FROM roadmap_completion_proposals ORDER BY created_at DESC').map(rowToRoadmapCompletionProposal).filter(Boolean) as RoadmapCompletionProposalRecord[]
  const tasks = queryRows(db, 'SELECT * FROM tasks ORDER BY created_at ASC').map(rowToTask).filter(Boolean) as WorkTaskRecord[]
  const runs = readWorkStateRuns(db, options.runsScope || 'all')
  const dependencies = queryRows(db, 'SELECT * FROM work_dependencies ORDER BY created_at ASC').map(rowToDependency).filter(Boolean) as WorkDependencyRecord[]
  return tagWorkStateMaterialization(
    normalizeState({ version: 1, savedAt, roadmaps, supervisors, projectBindings, completionProposals, tasks, runs, dependencies }),
    options.runsScope || 'all',
  )
}

function tagWorkStateMaterialization(state: WorkState, runsScope: 'all' | 'live'): WorkState {
  Object.defineProperty(state, WORK_STATE_MATERIALIZATION, {
    value: { runsScope },
    enumerable: false,
    configurable: false,
  })
  return state
}

function readWorkStateRuns(db: DatabaseSync, scope: 'all' | 'live'): RunRecord[] {
  if (scope !== 'live') {
    return queryRows(db, 'SELECT * FROM runs ORDER BY started_at ASC').map(rowToRun).filter(Boolean) as RunRecord[]
  }
  // Live window: every run the mutation hot path can legitimately touch.
  //  (a) all non-terminal (running) runs — active dispatch/lease/completion,
  //  (b) every run referenced by a task's currentRunId — retry/complete/abort,
  //  (c) a bounded recency slice of terminal runs — safety margin only.
  // Every clause is index-served (idx_runs_status, PK, idx_runs_started_at) so
  // SQLite unions three small index probes instead of scanning the table, and
  // only the bounded result set is JSON-materialized in JS — flat regardless of
  // how many terminal runs have accumulated.
  const rows = queryRows(
    db,
    `SELECT * FROM runs
       WHERE status = 'running'
          OR id IN (SELECT current_run_id FROM tasks WHERE current_run_id IS NOT NULL)
          OR id IN (SELECT id FROM runs WHERE status != 'running' ORDER BY started_at DESC LIMIT ?)
       ORDER BY started_at ASC`,
    LIVE_RECENT_TERMINAL_RUNS,
  )
  return rows.map(rowToRun).filter(Boolean) as RunRecord[]
}

/**
 * Look up a run for a mutation whose target may be an older terminal run that
 * the live window did not materialize (e.g. environment cleanup of a retained
 * run months after it finished). Returns undefined when no run matches.
 */
function findRunRowForEnvironmentOrId(db: DatabaseSync, id: string): RunRecord | undefined {
  // Fast path: the target may itself be a run id.
  const byId = getRow(db, 'SELECT * FROM runs WHERE id = ? LIMIT 1', id)
  if (byId) {
    const run = rowToRun(byId) ?? undefined
    if (run?.id === id) return run
  }
  // Otherwise the target is an environment id. The LIKE over environment_json is
  // only a cheap prefilter, so it must be paired with an exact re-verification:
  // a substring collision (a nested metadata value, an artifact path, or another
  // env ref that happens to contain the id) would otherwise hydrate the WRONG
  // run and apply retain/release/cleanup/abort to it. Escape LIKE metacharacters
  // (\ % _) so they match literally, and only accept a run whose
  // environment.id === id exactly (mirroring the in-window `environment?.id === id`).
  const like = `%"id":"${id.replace(/[\\%_]/g, match => `\\${match}`)}"%`
  const rows = queryRows(
    db,
    `SELECT * FROM runs
       WHERE environment_json LIKE ? ESCAPE '\\'
       ORDER BY started_at DESC`,
    like,
  )
  for (const row of rows) {
    const run = rowToRun(row) ?? undefined
    if (run?.environment?.id === id) return run
  }
  return undefined
}

function writeWorkState(db: DatabaseSync, state: WorkState): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    writeWorkStateRows(db, state)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

function writeWorkStateRows(db: DatabaseSync, state: WorkState): void {
  const normalized = normalizeState(state)
  normalized.savedAt = new Date().toISOString()
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('savedAt', normalized.savedAt)
  db.exec('DELETE FROM runs; DELETE FROM work_dependencies; DELETE FROM tasks; DELETE FROM roadmap_completion_proposals; DELETE FROM project_bindings; DELETE FROM roadmap_supervisors; DELETE FROM roadmaps;')
  const insertRoadmap = db.prepare('INSERT INTO roadmaps (id, title, status, priority, source, agent_team, environment_json, quality_spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const roadmap of normalized.roadmaps) {
    insertRoadmap.run(roadmap.id, roadmap.title, roadmap.status, roadmap.priority, 'manual', roadmap.agentTeam || null, roadmap.environment ? JSON.stringify(roadmap.environment) : null, roadmap.qualitySpec ? JSON.stringify(roadmap.qualitySpec) : null, roadmap.createdAt, roadmap.updatedAt)
  }
  const insertSupervisor = db.prepare(`INSERT INTO roadmap_supervisors (
    supervisor_id, roadmap_id, session_id, profile, status, is_default, cadence_json, event_triggers_json,
    last_reviewed_event_id, last_review_at, next_review_at, completion_policy_json, notification_policy_ref, note,
    wake_lease_owner, wake_lease_expires_at, last_wake_at, last_wake_reason, last_wake_event_id,
    last_result_hash, last_result_at, last_result_status, last_result_summary, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const supervisor of normalized.supervisors) {
    insertSupervisor.run(
      supervisor.supervisorId,
      supervisor.roadmapId,
      supervisor.sessionId,
      supervisor.profile,
      supervisor.status,
      supervisor.isDefault ? 1 : 0,
      JSON.stringify(supervisor.cadence || {}),
      JSON.stringify(supervisor.eventTriggers || {}),
      supervisor.lastReviewedEventId ?? null,
      supervisor.lastReviewAt || null,
      supervisor.nextReviewAt || null,
      JSON.stringify(supervisor.completionPolicy || {}),
      supervisor.notificationPolicyRef || null,
      supervisor.note || null,
      supervisor.wakeLeaseOwner || null,
      supervisor.wakeLeaseExpiresAt || null,
      supervisor.lastWakeAt || null,
      supervisor.lastWakeReason || null,
      supervisor.lastWakeEventId ?? null,
      supervisor.lastResultHash || null,
      supervisor.lastResultAt || null,
      supervisor.lastResultStatus || null,
      supervisor.lastResultSummary || null,
      supervisor.createdAt,
      supervisor.updatedAt,
    )
  }
  const insertProjectBinding = db.prepare(`INSERT INTO project_bindings (
    id, alias, roadmap_id, session_id, scope, provider, chat_id, thread_id, title,
    notification_mode, muted_until, quiet_hours_json, last_digest_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const binding of normalized.projectBindings) {
    insertProjectBinding.run(binding.id, binding.alias, binding.roadmapId, binding.sessionId, binding.scope, binding.provider || null, binding.chatId || null, normalizeThreadId(binding.threadId), binding.title || null, binding.notificationMode || 'immediate', binding.mutedUntil || null, JSON.stringify(binding.quietHours || {}), binding.lastDigestAt || null, binding.createdAt, binding.updatedAt)
  }
  const insertCompletionProposal = db.prepare(`INSERT INTO roadmap_completion_proposals (
    id, roadmap_id, proposed_by, session_id, evidence_json, unresolved_risks_json, recommendation, status, decision_by, decision_note, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const proposal of normalized.completionProposals) {
    insertCompletionProposal.run(proposal.id, proposal.roadmapId, proposal.proposedBy || null, proposal.sessionId || null, JSON.stringify(proposal.evidence), JSON.stringify(proposal.unresolvedRisks), proposal.recommendation, proposal.status, proposal.decisionBy || null, proposal.decisionNote || null, proposal.expiresAt || null, proposal.createdAt, proposal.updatedAt)
  }
  const insertTask = db.prepare(`INSERT INTO tasks (
    id, roadmap_id, title, description, status, priority, agent, agent_team, stage_profiles_json, environment_json, pipeline_json, current_stage, current_run_id,
    attempts_json, note, earliest_start_at, deadline_at, recurrence, manual_gate, sla_class, quality_spec_json, source_type, source_key, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const task of normalized.tasks) {
    insertTask.run(
      task.id,
      task.roadmapId,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.agent,
      task.agentTeam || null,
      task.stageProfiles ? JSON.stringify(task.stageProfiles) : null,
      task.environment ? JSON.stringify(task.environment) : null,
      JSON.stringify(task.pipeline),
      task.currentStage || null,
      task.currentRunId || null,
      JSON.stringify(task.attempts || {}),
      task.note || null,
      task.earliestStartAt || null,
      task.deadlineAt || null,
      task.recurrence || null,
      task.manualGate || null,
      task.slaClass || null,
      task.qualitySpec ? JSON.stringify(task.qualitySpec) : null,
      task.sourceType || 'manual',
      task.sourceKey || `manual:${task.id}`,
      task.createdAt,
      task.updatedAt,
    )
  }
  db.exec('DELETE FROM task_run_counters WHERE task_id NOT IN (SELECT id FROM tasks)')
  const insertRun = db.prepare(`INSERT INTO runs (
    id, task_id, stage, session_id, profile, agent_team, agent_team_version, resolved_profile, resolved_agent, environment_json, runtime_profile_json, status, attempt, started_at, completed_at, lease_owner, lease_expires_at, scheduler_generation,
    cost_usd, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, runtime_ms, result_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const run of normalized.runs) {
    insertRun.run(
      run.id,
      run.taskId,
      run.stage,
      run.sessionId,
      run.profile,
      run.agentTeam || null,
      run.agentTeamVersion || null,
      run.resolvedProfile || null,
      run.resolvedAgent || null,
      run.environment ? JSON.stringify(run.environment) : null,
      run.runtimeProfile ? JSON.stringify(run.runtimeProfile) : null,
      run.status,
      run.attempt,
      run.startedAt,
      run.completedAt || null,
      run.leaseOwner || null,
      run.leaseExpiresAt || null,
      run.schedulerGeneration || null,
      run.costUsd ?? null,
      run.inputTokens ?? null,
      run.outputTokens ?? null,
      run.reasoningTokens ?? null,
      run.cacheReadTokens ?? null,
      run.cacheWriteTokens ?? null,
      run.runtimeMs ?? null,
      run.result ? JSON.stringify(run.result) : null,
    )
  }
  const insertDependency = db.prepare(`INSERT INTO work_dependencies (task_id, depends_on_task_id, type, created_at) VALUES (?, ?, ?, ?)`)
  for (const dependency of normalized.dependencies || []) {
    insertDependency.run(dependency.taskId, dependency.dependsOnTaskId, dependency.type, dependency.createdAt)
  }
}

interface WorkStateRowFingerprints {
  runs: Map<string, string>
  dependencies: Map<string, string>
  tasks: Map<string, string>
  completionProposals: Map<string, string>
  projectBindings: Map<string, string>
  supervisors: Map<string, string>
  roadmaps: Map<string, string>
}

function captureWorkStateFingerprints(state: WorkState): WorkStateRowFingerprints {
  return {
    runs: fingerprintRowsByKey(state.runs, run => run.id),
    dependencies: fingerprintRowsByKey(state.dependencies || [], dependencyKey),
    tasks: fingerprintRowsByKey(state.tasks, task => task.id),
    completionProposals: fingerprintRowsByKey(state.completionProposals, proposal => proposal.id),
    projectBindings: fingerprintRowsByKey(state.projectBindings, binding => binding.id),
    supervisors: fingerprintRowsByKey(state.supervisors, supervisor => supervisor.supervisorId),
    roadmaps: fingerprintRowsByKey(state.roadmaps, roadmap => roadmap.id),
  }
}

function fingerprintRowsByKey<T>(rows: T[], keyFor: (row: T) => string): Map<string, string> {
  return new Map(rows.map(row => [keyFor(row), stableRowFingerprint(row)]))
}

function syncWorkStateRows(db: DatabaseSync, before: WorkStateRowFingerprints, nextState: WorkState): void {
  const next = normalizeState(nextState)
  next.savedAt = new Date().toISOString()
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('savedAt', next.savedAt)

  syncRows(
    before.runs,
    next.runs,
    run => run.id,
    id => db.prepare('DELETE FROM runs WHERE id = ?').run(id),
    run => upsertRunRow(db, run),
  )
  syncRows(
    before.dependencies,
    next.dependencies || [],
    dependencyKey,
    key => {
      const [taskId, dependsOnTaskId, type] = key.split('\u0000')
      db.prepare('DELETE FROM work_dependencies WHERE task_id = ? AND depends_on_task_id = ? AND type = ?').run(taskId, dependsOnTaskId, type)
    },
    dependency => upsertDependencyRow(db, dependency),
  )
  syncRows(
    before.tasks,
    next.tasks,
    task => task.id,
    id => db.prepare('DELETE FROM tasks WHERE id = ?').run(id),
    task => upsertTaskRow(db, task),
  )
  syncRows(
    before.completionProposals,
    next.completionProposals,
    proposal => proposal.id,
    id => db.prepare('DELETE FROM roadmap_completion_proposals WHERE id = ?').run(id),
    proposal => upsertCompletionProposalRow(db, proposal),
  )
  syncRows(
    before.projectBindings,
    next.projectBindings,
    binding => binding.id,
    id => db.prepare('DELETE FROM project_bindings WHERE id = ?').run(id),
    binding => upsertProjectBindingStateRow(db, binding),
  )
  syncRows(
    before.supervisors,
    next.supervisors,
    supervisor => supervisor.supervisorId,
    id => db.prepare('DELETE FROM roadmap_supervisors WHERE supervisor_id = ?').run(id),
    supervisor => upsertRoadmapSupervisorStateRow(db, supervisor),
  )
  syncRows(
    before.roadmaps,
    next.roadmaps,
    roadmap => roadmap.id,
    id => db.prepare('DELETE FROM roadmaps WHERE id = ?').run(id),
    roadmap => upsertRoadmapStateRow(db, roadmap),
  )
}

function syncRows<T>(beforeFingerprints: Map<string, string>, nextRows: T[], keyFor: (row: T) => string, deleteRow: (key: string) => void, upsertRow: (row: T) => void): void {
  const nextKeys = new Set(nextRows.map(row => keyFor(row)))
  for (const key of beforeFingerprints.keys()) {
    if (!nextKeys.has(key)) deleteRow(key)
  }
  for (const row of nextRows) {
    const key = keyFor(row)
    if (beforeFingerprints.get(key) !== stableRowFingerprint(row)) upsertRow(row)
  }
}

function stableRowFingerprint(row: unknown): string {
  return JSON.stringify(row)
}

function dependencyKey(dependency: WorkDependencyRecord): string {
  return [dependency.taskId, dependency.dependsOnTaskId, dependency.type].join('\u0000')
}

function upsertRoadmapStateRow(db: DatabaseSync, roadmap: RoadmapRecord): void {
  db.prepare(`INSERT INTO roadmaps (
    id, title, status, priority, source, agent_team, environment_json, quality_spec_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    status = excluded.status,
    priority = excluded.priority,
    source = excluded.source,
    agent_team = excluded.agent_team,
    environment_json = excluded.environment_json,
    quality_spec_json = excluded.quality_spec_json,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    roadmap.id,
    roadmap.title,
    roadmap.status,
    roadmap.priority,
    'manual',
    roadmap.agentTeam || null,
    roadmap.environment ? JSON.stringify(roadmap.environment) : null,
    roadmap.qualitySpec ? JSON.stringify(roadmap.qualitySpec) : null,
    roadmap.createdAt,
    roadmap.updatedAt,
  )
}

function upsertRoadmapSupervisorStateRow(db: DatabaseSync, supervisor: RoadmapSupervisorRecord): void {
  db.prepare(`INSERT INTO roadmap_supervisors (
    supervisor_id, roadmap_id, session_id, profile, status, is_default, cadence_json, event_triggers_json,
    last_reviewed_event_id, last_review_at, next_review_at, completion_policy_json, notification_policy_ref, note,
    wake_lease_owner, wake_lease_expires_at, last_wake_at, last_wake_reason, last_wake_event_id,
    last_result_hash, last_result_at, last_result_status, last_result_summary, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(supervisor_id) DO UPDATE SET
    roadmap_id = excluded.roadmap_id,
    session_id = excluded.session_id,
    profile = excluded.profile,
    status = excluded.status,
    is_default = excluded.is_default,
    cadence_json = excluded.cadence_json,
    event_triggers_json = excluded.event_triggers_json,
    last_reviewed_event_id = excluded.last_reviewed_event_id,
    last_review_at = excluded.last_review_at,
    next_review_at = excluded.next_review_at,
    completion_policy_json = excluded.completion_policy_json,
    notification_policy_ref = excluded.notification_policy_ref,
    note = excluded.note,
    wake_lease_owner = excluded.wake_lease_owner,
    wake_lease_expires_at = excluded.wake_lease_expires_at,
    last_wake_at = excluded.last_wake_at,
    last_wake_reason = excluded.last_wake_reason,
    last_wake_event_id = excluded.last_wake_event_id,
    last_result_hash = excluded.last_result_hash,
    last_result_at = excluded.last_result_at,
    last_result_status = excluded.last_result_status,
    last_result_summary = excluded.last_result_summary,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    supervisor.supervisorId,
    supervisor.roadmapId,
    supervisor.sessionId,
    supervisor.profile,
    supervisor.status,
    supervisor.isDefault ? 1 : 0,
    JSON.stringify(supervisor.cadence || {}),
    JSON.stringify(supervisor.eventTriggers || {}),
    supervisor.lastReviewedEventId ?? null,
    supervisor.lastReviewAt || null,
    supervisor.nextReviewAt || null,
    JSON.stringify(supervisor.completionPolicy || {}),
    supervisor.notificationPolicyRef || null,
    supervisor.note || null,
    supervisor.wakeLeaseOwner || null,
    supervisor.wakeLeaseExpiresAt || null,
    supervisor.lastWakeAt || null,
    supervisor.lastWakeReason || null,
    supervisor.lastWakeEventId ?? null,
    supervisor.lastResultHash || null,
    supervisor.lastResultAt || null,
    supervisor.lastResultStatus || null,
    supervisor.lastResultSummary || null,
    supervisor.createdAt,
    supervisor.updatedAt,
  )
}

function upsertProjectBindingStateRow(db: DatabaseSync, binding: ProjectBindingRecord): void {
  db.prepare(`INSERT INTO project_bindings (
    id, alias, roadmap_id, session_id, scope, provider, chat_id, thread_id, title,
    notification_mode, muted_until, quiet_hours_json, last_digest_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    alias = excluded.alias,
    roadmap_id = excluded.roadmap_id,
    session_id = excluded.session_id,
    scope = excluded.scope,
    provider = excluded.provider,
    chat_id = excluded.chat_id,
    thread_id = excluded.thread_id,
    title = excluded.title,
    notification_mode = excluded.notification_mode,
    muted_until = excluded.muted_until,
    quiet_hours_json = excluded.quiet_hours_json,
    last_digest_at = excluded.last_digest_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    binding.id,
    binding.alias,
    binding.roadmapId,
    binding.sessionId,
    binding.scope,
    binding.provider || null,
    binding.chatId || null,
    normalizeThreadId(binding.threadId),
    binding.title || null,
    binding.notificationMode || 'immediate',
    binding.mutedUntil || null,
    JSON.stringify(binding.quietHours || {}),
    binding.lastDigestAt || null,
    binding.createdAt,
    binding.updatedAt,
  )
}

function upsertCompletionProposalRow(db: DatabaseSync, proposal: RoadmapCompletionProposalRecord): void {
  db.prepare(`INSERT INTO roadmap_completion_proposals (
    id, roadmap_id, proposed_by, session_id, evidence_json, unresolved_risks_json, recommendation, status,
    decision_by, decision_note, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    roadmap_id = excluded.roadmap_id,
    proposed_by = excluded.proposed_by,
    session_id = excluded.session_id,
    evidence_json = excluded.evidence_json,
    unresolved_risks_json = excluded.unresolved_risks_json,
    recommendation = excluded.recommendation,
    status = excluded.status,
    decision_by = excluded.decision_by,
    decision_note = excluded.decision_note,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    proposal.id,
    proposal.roadmapId,
    proposal.proposedBy || null,
    proposal.sessionId || null,
    JSON.stringify(proposal.evidence),
    JSON.stringify(proposal.unresolvedRisks),
    proposal.recommendation,
    proposal.status,
    proposal.decisionBy || null,
    proposal.decisionNote || null,
    proposal.expiresAt || null,
    proposal.createdAt,
    proposal.updatedAt,
  )
}

function upsertTaskRow(db: DatabaseSync, task: WorkTaskRecord): void {
  db.prepare(`INSERT INTO tasks (
    id, roadmap_id, title, description, status, priority, agent, agent_team, stage_profiles_json, environment_json, pipeline_json,
    current_stage, current_run_id, attempts_json, note, earliest_start_at, deadline_at, recurrence, manual_gate, sla_class,
    quality_spec_json, source_type, source_key, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    roadmap_id = excluded.roadmap_id,
    title = excluded.title,
    description = excluded.description,
    status = excluded.status,
    priority = excluded.priority,
    agent = excluded.agent,
    agent_team = excluded.agent_team,
    stage_profiles_json = excluded.stage_profiles_json,
    environment_json = excluded.environment_json,
    pipeline_json = excluded.pipeline_json,
    current_stage = excluded.current_stage,
    current_run_id = excluded.current_run_id,
    attempts_json = excluded.attempts_json,
    note = excluded.note,
    earliest_start_at = excluded.earliest_start_at,
    deadline_at = excluded.deadline_at,
    recurrence = excluded.recurrence,
    manual_gate = excluded.manual_gate,
    sla_class = excluded.sla_class,
    quality_spec_json = excluded.quality_spec_json,
    source_type = excluded.source_type,
    source_key = excluded.source_key,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    task.id,
    task.roadmapId,
    task.title,
    task.description,
    task.status,
    task.priority,
    task.agent,
    task.agentTeam || null,
    task.stageProfiles ? JSON.stringify(task.stageProfiles) : null,
    task.environment ? JSON.stringify(task.environment) : null,
    JSON.stringify(task.pipeline),
    task.currentStage || null,
    task.currentRunId || null,
    JSON.stringify(task.attempts || {}),
    task.note || null,
    task.earliestStartAt || null,
    task.deadlineAt || null,
    task.recurrence || null,
    task.manualGate || null,
    task.slaClass || null,
    task.qualitySpec ? JSON.stringify(task.qualitySpec) : null,
    task.sourceType || 'manual',
    task.sourceKey || `manual:${task.id}`,
    task.createdAt,
    task.updatedAt,
  )
}

function upsertRunRow(db: DatabaseSync, run: RunRecord): void {
  db.prepare(`INSERT INTO runs (
    id, task_id, stage, session_id, profile, agent_team, agent_team_version, resolved_profile, resolved_agent, environment_json, runtime_profile_json,
    status, attempt, started_at, completed_at, lease_owner, lease_expires_at, scheduler_generation, cost_usd, input_tokens,
    output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, runtime_ms, result_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    task_id = excluded.task_id,
    stage = excluded.stage,
    session_id = excluded.session_id,
    profile = excluded.profile,
    agent_team = excluded.agent_team,
    agent_team_version = excluded.agent_team_version,
    resolved_profile = excluded.resolved_profile,
    resolved_agent = excluded.resolved_agent,
    environment_json = excluded.environment_json,
    runtime_profile_json = excluded.runtime_profile_json,
    status = excluded.status,
    attempt = excluded.attempt,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    lease_owner = excluded.lease_owner,
    lease_expires_at = excluded.lease_expires_at,
    scheduler_generation = excluded.scheduler_generation,
    cost_usd = excluded.cost_usd,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    reasoning_tokens = excluded.reasoning_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    runtime_ms = excluded.runtime_ms,
    result_json = excluded.result_json`).run(
    run.id,
    run.taskId,
    run.stage,
    run.sessionId,
    run.profile,
    run.agentTeam || null,
    run.agentTeamVersion || null,
    run.resolvedProfile || null,
    run.resolvedAgent || null,
    run.environment ? JSON.stringify(run.environment) : null,
    run.runtimeProfile ? JSON.stringify(run.runtimeProfile) : null,
    run.status,
    run.attempt,
    run.startedAt,
    run.completedAt || null,
    run.leaseOwner || null,
    run.leaseExpiresAt || null,
    run.schedulerGeneration || null,
    run.costUsd ?? null,
    run.inputTokens ?? null,
    run.outputTokens ?? null,
    run.reasoningTokens ?? null,
    run.cacheReadTokens ?? null,
    run.cacheWriteTokens ?? null,
    run.runtimeMs ?? null,
    run.result ? JSON.stringify(run.result) : null,
  )
}

function upsertDependencyRow(db: DatabaseSync, dependency: WorkDependencyRecord): void {
  db.prepare(`INSERT INTO work_dependencies (task_id, depends_on_task_id, type, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id, depends_on_task_id, type) DO UPDATE SET created_at = excluded.created_at`)
    .run(dependency.taskId, dependency.dependsOnTaskId, dependency.type, dependency.createdAt)
}

function updateTaskDispatchReceipt(
  dispatchId: string,
  filePath: string,
  fn: (receipt: TaskDispatchReceiptRecord, db: DatabaseSync, now: string) => boolean,
  afterChange?: (receipt: TaskDispatchReceiptRecord, db: DatabaseSync, now: string) => void,
): TaskDispatchReceiptRecord | undefined {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const receipt = rowToTaskDispatchReceipt(db.prepare('SELECT * FROM task_dispatch_receipts WHERE id = ?').get(dispatchId))
      if (!receipt) {
        db.exec('ROLLBACK')
        return undefined
      }
      const now = new Date().toISOString()
      const changed = fn(receipt, db, now)
      if (!changed) {
        db.exec('ROLLBACK')
        return undefined
      }
      afterChange?.(receipt, db, now)
      receipt.updatedAt = now
      upsertTaskDispatchReceiptRow(db, receipt)
      db.exec('COMMIT')
      return receipt
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

interface StoredTaskDispatchAcquisition {
  kind: TaskDispatchAcquisitionKind
  status: TaskDispatchAcquisitionStatus
  provider: string
  idempotencyKey: string
  resourceId?: string
  resource?: Record<string, unknown>
  metadata: Record<string, unknown>
  leadershipScope?: string
  leaderId?: string
  fencingToken?: string
  createdAt: string
  updatedAt: string
  error?: string
}

function upsertTaskDispatchAcquisitionRow(
  db: DatabaseSync,
  receipt: TaskDispatchReceiptRecord,
  input: {
    kind: TaskDispatchAcquisitionKind
    status: TaskDispatchAcquisitionStatus
    provider: string
    idempotencyKey?: string
    resourceId?: string
    resource?: Record<string, unknown>
    metadata?: Record<string, unknown>
    error?: string
  },
  now: string,
): TaskDispatchAcquisitionRecord {
  const raw = db.prepare('SELECT acquisition_journal_json FROM task_dispatch_receipts WHERE id = ?').get(receipt.id) as { acquisition_journal_json?: unknown } | undefined
  const journal = normalizeStoredTaskDispatchAcquisitions(parseJSON(raw?.acquisition_journal_json, []))
  const index = journal.findIndex(row => row.kind === input.kind)
  const previous = index >= 0 ? journal[index] : undefined
  const epoch = currentWorkDbLeadershipEpoch()
  const preserveAcquired = input.status === 'intent' && previous && previous.status !== 'failed' && previous.status !== 'released'
  const next: StoredTaskDispatchAcquisition = preserveAcquired
    ? { ...previous, updatedAt: now }
    : {
        kind: input.kind,
        status: input.status,
        provider: input.provider || previous?.provider || 'unknown',
        idempotencyKey: input.idempotencyKey || previous?.idempotencyKey || `${receipt.id}:${input.kind}`,
        resourceId: input.resourceId || previous?.resourceId,
        resource: input.resource || previous?.resource,
        metadata: { ...(previous?.metadata || {}), ...(input.metadata || {}) },
        leadershipScope: previous?.leadershipScope || epoch?.scope,
        leaderId: previous?.leaderId || epoch?.leaderId,
        fencingToken: previous?.fencingToken || epoch?.fencingToken,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        error: input.error || (input.status === 'acquired' || input.status === 'released' ? undefined : previous?.error),
      }
  if (index >= 0) journal[index] = next
  else journal.push(next)
  db.prepare('UPDATE task_dispatch_receipts SET acquisition_journal_json = ? WHERE id = ?').run(JSON.stringify(journal), receipt.id)
  return taskDispatchAcquisitionRecord(receipt, next)
}

function normalizeStoredTaskDispatchAcquisitions(value: unknown): StoredTaskDispatchAcquisition[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(raw => {
    const row = raw as Partial<StoredTaskDispatchAcquisition> | null
    if (
      (row?.kind !== 'environment' && row?.kind !== 'session') ||
      (row.status !== 'intent' && row.status !== 'acquired' && row.status !== 'released' && row.status !== 'failed') ||
      typeof row.provider !== 'string' ||
      typeof row.idempotencyKey !== 'string' ||
      typeof row.createdAt !== 'string' ||
      typeof row.updatedAt !== 'string'
    ) return []
    return [{
      kind: row.kind,
      status: row.status,
      provider: row.provider,
      idempotencyKey: row.idempotencyKey,
      resourceId: typeof row.resourceId === 'string' ? row.resourceId : undefined,
      resource: row.resource && typeof row.resource === 'object' && !Array.isArray(row.resource) ? row.resource : undefined,
      metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {},
      leadershipScope: typeof row.leadershipScope === 'string' ? row.leadershipScope : undefined,
      leaderId: typeof row.leaderId === 'string' ? row.leaderId : undefined,
      fencingToken: typeof row.fencingToken === 'string' ? row.fencingToken : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      error: typeof row.error === 'string' ? row.error : undefined,
    }]
  })
}

function taskDispatchAcquisitionRows(row: Record<string, unknown>): TaskDispatchAcquisitionRecord[] {
  const receipt: TaskDispatchReceiptRecord = {
    id: String(row['id'] || ''),
    taskId: String(row['task_id'] || ''),
    stage: String(row['stage'] || ''),
    idempotencyKey: '',
    leaseOwner: String(row['lease_owner'] || ''),
    leaseExpiresAt: String(row['lease_expires_at'] || ''),
    status: row['status'] === 'started' || row['status'] === 'failed' ? row['status'] : 'starting',
    createdAt: '',
    updatedAt: '',
  }
  return normalizeStoredTaskDispatchAcquisitions(parseJSON(row['acquisition_journal_json'], []))
    .map(acquisition => taskDispatchAcquisitionRecord(receipt, acquisition))
}

function taskDispatchAcquisitionRecord(receipt: TaskDispatchReceiptRecord, acquisition: StoredTaskDispatchAcquisition): TaskDispatchAcquisitionRecord {
  return {
    dispatchId: receipt.id,
    taskId: receipt.taskId,
    stage: receipt.stage,
    leaseOwner: receipt.leaseOwner,
    kind: acquisition.kind,
    status: acquisition.status,
    provider: acquisition.provider,
    idempotencyKey: acquisition.idempotencyKey,
    resourceId: acquisition.resourceId,
    resource: acquisition.resource,
    metadata: acquisition.metadata,
    leadershipScope: acquisition.leadershipScope,
    leaderId: acquisition.leaderId,
    fencingToken: acquisition.fencingToken,
    leaseExpiresAt: receipt.leaseExpiresAt,
    dispatchStatus: receipt.status,
    createdAt: acquisition.createdAt,
    updatedAt: acquisition.updatedAt,
    error: acquisition.error,
  }
}

function upsertTaskDispatchReceiptRow(db: DatabaseSync, receipt: TaskDispatchReceiptRecord): void {
  db.prepare(`INSERT INTO task_dispatch_receipts (
    id, task_id, stage, profile, idempotency_key, lease_owner, lease_expires_at, status,
    run_id, session_id, environment_json, prompt_submitted_at, failure_reason, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    task_id = excluded.task_id,
    stage = excluded.stage,
    profile = excluded.profile,
    idempotency_key = excluded.idempotency_key,
    lease_owner = excluded.lease_owner,
    lease_expires_at = excluded.lease_expires_at,
    status = excluded.status,
    run_id = excluded.run_id,
    session_id = excluded.session_id,
    environment_json = excluded.environment_json,
    prompt_submitted_at = excluded.prompt_submitted_at,
    failure_reason = excluded.failure_reason,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    receipt.id,
    receipt.taskId,
    receipt.stage,
    receipt.profile || null,
    receipt.idempotencyKey,
    receipt.leaseOwner,
    receipt.leaseExpiresAt,
    receipt.status,
    receipt.runId || null,
    receipt.sessionId || null,
    receipt.environment ? JSON.stringify(receipt.environment) : null,
    receipt.promptSubmittedAt || null,
    receipt.failureReason || null,
    receipt.createdAt,
    receipt.updatedAt,
  )
}

function emptyState(): WorkState {
  return { version: 1, savedAt: new Date().toISOString(), roadmaps: [], supervisors: [], projectBindings: [], completionProposals: [], tasks: [], runs: [], dependencies: [] }
}

function normalizeState(value: any): WorkState {
  const state = emptyState()
  state.savedAt = typeof value?.savedAt === 'string' ? value.savedAt : state.savedAt
  state.roadmaps = Array.isArray(value?.roadmaps) ? value.roadmaps.filter(isRoadmapRecord).map((roadmap: RoadmapRecord) => ({ ...roadmap, qualitySpec: normalizeRoadmapQualitySpec(roadmap.qualitySpec) })) : []
  const roadmapIds = new Set(state.roadmaps.map(roadmap => roadmap.id))
  state.supervisors = Array.isArray(value?.supervisors) ? value.supervisors.filter(isRoadmapSupervisorRecord).filter((supervisor: RoadmapSupervisorRecord) => roadmapIds.has(supervisor.roadmapId)) : []
  state.projectBindings = Array.isArray(value?.projectBindings) ? value.projectBindings.filter(isProjectBindingRecord).filter((binding: ProjectBindingRecord) => roadmapIds.has(binding.roadmapId)).map(normalizeProjectBindingRecord) : []
  state.completionProposals = Array.isArray(value?.completionProposals) ? value.completionProposals.filter(isRoadmapCompletionProposalRecord).filter((proposal: RoadmapCompletionProposalRecord) => roadmapIds.has(proposal.roadmapId)) : []
  state.tasks = Array.isArray(value?.tasks) ? value.tasks.filter(isTaskRecord) : []
  state.runs = Array.isArray(value?.runs) ? value.runs.filter(isRunRecord) : []
  const taskIds = new Set(state.tasks.map(task => task.id))
  state.dependencies = Array.isArray(value?.dependencies)
    ? value.dependencies.filter(isDependencyRecord).filter((dep: WorkDependencyRecord) => taskIds.has(dep.taskId) && taskIds.has(dep.dependsOnTaskId))
    : []
  for (const roadmapId of roadmapIds) reconcileDefaultSupervisorInState(state, roadmapId, undefined, new Date().toISOString())
  return state
}

function ensureInboxRoadmap(state: WorkState, now: Date): RoadmapRecord {
  const existing = state.roadmaps.find(roadmap => roadmap.id === INBOX_ROADMAP_ID)
  if (existing) return existing
  const roadmap: RoadmapRecord = {
    id: INBOX_ROADMAP_ID,
    title: 'Task Inbox',
    status: 'active',
    priority: 'MEDIUM',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
  state.roadmaps.push(roadmap)
  return roadmap
}

function priorityRank(priority: string): number {
  return priority === 'HIGH' ? 0 : priority === 'MEDIUM' ? 1 : 2
}
