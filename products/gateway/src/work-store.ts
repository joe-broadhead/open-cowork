import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { getConfig, type HumanGateTimeoutAction } from './config.js'
import { cleanupFailedEnvironmentRun, environmentControllerForBackend, finalizeEnvironmentRun, normalizeEnvironmentSelector, redactEnvironmentRecord, type EnvironmentRunRecord, type EnvironmentSelector } from './environments.js'
import { type RunStatus, type StageResult, type WorkStatus } from './workflow.js'
import { closeWorkDb, queryRows, resetWorkDbInitState, withWorkDb, workStatePath } from './work-store/db.js'
import { normalizeRoadmapQualitySpec, rowToHumanGate, rowToSupervisorWakeupReceipt, rowToTaskDispatchReceipt } from './work-store/row-mappers.js'
import { normalizeOptionalIsoTime, normalizeOptionalString, normalizePriority, normalizeProjectAlias, normalizeRequiredString, normalizeStage, normalizeStringList, normalizeThreadId } from './work-store/validators.js'
import { redactSensitiveText } from './security.js'
import { isActiveRunStatus, isTaskActiveStatus, shouldAbortActiveRunForTaskStatus } from './runtime-state-machine.js'
import { writeRunArtifactManifest } from './artifacts.js'

export type { WorkStoreSchemaInspection } from './work-store/schema.js'
export { closeWorkDb, currentWorkDbLeadershipEpoch, disposeWorkStore, getRow, isStaleWorkDbLeadershipError, openWorkDb, parseJSON, queryRows, recoverInterruptedStorageRestore, resetWorkDbInitState, restrictSqliteDbPermissions, setWorkDbLeadershipEpochProvider, storageRestoreJournalPath, withWorkDb, withWorkDbLeadershipEpoch, withWorkDbReadOnly, workStatePath, writeStorageRestoreJournal } from './work-store/db.js'
export type { SqliteRow, StorageRestoreJournal, StorageRestoreJournalEntry, StorageRestoreRecoveryResult, WorkDbLeadershipEpoch } from './work-store/db.js'
export { listWorkStoreRepositoryDomains, validateWorkStoreMutationContracts } from './work-store/repositories.js'
export type { WorkStoreMutationCompatibilityContract, WorkStoreMutationContractValidation, WorkStoreMutationEntryPoint, WorkStoreRepositoryDomain, WorkStoreRepositoryDomainId, WorkStoreTransactionOwner } from './work-store/repositories.js'
export type { AuditLedgerQueryOptions } from './audit-ledger.js'

export * from './work-store/types.js'
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
  upsertChannelBindingRow,
} from './work-store/channel-bindings.js'
import { upsertChannelBindingRow } from './work-store/channel-bindings.js'
import { appendWorkEventRow } from './work-store/event-append.js'
import {
  applyRoadmapSupervisorUpdate,
  compareRoadmapSupervisors,
  createRoadmapSupervisorInState,
  defaultRoadmapSupervisor,
  reconcileDefaultSupervisorInState,
} from './work-store/supervisor-helpers.js'
import {
  approveRoadmapCompletionProposalInState,
  compareProjectBindings,
  compareRoadmapCompletionProposals,
  completionAutoBlockers,
  deleteProjectBindingChannelRow,
  projectBindingChannelChanged,
  resolvedProjectContext,
  upsertProjectBindingInState,
  filterProjectBindings,
} from './work-store/project-binding-helpers.js'

import {
  insertHumanGateRow,
  normalizeHumanGateDecision,
  normalizeHumanGateScope,
  humanGateInputForManualTask,
  manualGateReason,
} from './work-store/human-gates.js'
export {
  listHumanGates,
  listHumanGatesReadOnly,
  getHumanGate,
  createHumanGate,
  ensureHumanGate,
  insertHumanGateRow,
  normalizeHumanGateDecision,
  normalizeHumanGateScope,
} from './work-store/human-gates.js'
import {
  listWorkTaskViews,
  applyTaskUpdate,
  createRoadmapInState,
  createWorkTaskInState,
  validateTaskUpdate,
  addWorkDependencyInState,
  assertStageInPipeline,
  normalizeOptionalAgentTeam,
  normalizeTaskCreateList,
  normalizeTaskUpdateList,
  normalizeRoadmapStatus,
  normalizeWorkTaskAction,
  recomputeRoadmapStatusInState,
} from './work-store/task-helpers.js'

import {
  assertNoUnsettledTaskDispatchAcquisitions,
  cleanupDeletedTaskReferences,
  upsertTaskDispatchAcquisitionRow,
  upsertTaskDispatchReceiptRow,
} from './work-store/task-dispatch.js'
export {
  reserveTaskDispatchStart,
  attachTaskDispatchEnvironment,
  journalTaskDispatchAcquisitionIntent,
  attachTaskDispatchSession,
  markTaskDispatchAcquisitionSettled,
  listTaskDispatchAcquisitions,
  markTaskDispatchStarted,
  markTaskDispatchPromptSubmitted,
  markTaskDispatchFailed,
  recoverExpiredTaskDispatchStarts,
  countActiveTaskDispatchStarts,
  listTaskDispatchReceipts,
} from './work-store/task-dispatch.js'

import {
  findDelegationReceiptInDb,
  appendDelegationProgressForTask,
  appendDelegationProgressForRoadmap,
  updateDelegationReceiptsForDeletion,
} from './work-store/delegation-helpers.js'
import {
  environmentViewForRun,
  isExpiredLease,
  runLeaseExpectationFailure,
  recoverRunsInState,
  normalizeActiveRunControlAction,
  activeRunControlSnapshot,
  lastOperatorActionForRun,
  restartBehaviorForAction,
  activeRunControlNextAction,
  abortActiveRunInState,
  activeRunSessionIdsForTasks,
  finishRunInState,
  collectRunEnvironmentArtifacts,
  applyRunAttribution,
  runAttributionKey,
  runTokens,
  applyStageResultInState,
  startWorkTaskRunInState,
} from './work-store/run-helpers.js'
export { abortActiveRunInState } from './work-store/run-helpers.js'

import {
  loadWorkState,
  getRunFromDb,
  mutateWorkState,
  findRunRowForEnvironmentOrId,
} from './work-store/state-io.js'
export {
  emptyWorkState,
  loadWorkState,
  loadWorkStateReadOnly,
  saveWorkState,
  getRunFromDb,
  mutateWorkState,
  type LoadWorkStateOptions,
} from './work-store/state-io.js'
import {
  appendWorkEvent,
} from './work-store/event-queries.js'
export {
  appendWorkEvent,
  appendWorkEvents,
  appendAuditEvent,
  listWorkEvents,
  listWorkEventsReadOnly,
  listRecentWorkEvents,
  listWorkEventsByType,
  listDelegationProgressRouteReceipts,
  listDelegationProgressRouteReceiptsReadOnly,
  listAuditLedgerEntries,
  listAuditLedgerEntriesReadOnly,
  listAllWorkEventsByType,
} from './work-store/event-queries.js'
export {
  createRun,
  listWorkTaskViews,
  calculateTaskReadiness,
  recomputeRoadmapStatusInState,
} from './work-store/task-helpers.js'
export { appendWorkEventRow } from './work-store/event-append.js'
export { getWorkTaskReadiness, listWorkDependencies, summarizeWorkTasks } from './work-store/work-queries.js'

import {
  OPEN_HUMAN_GATE_STATUSES,
} from './work-store/types.js'
import type {
  ActiveRunControlInput,
  ActiveRunControlOutcome,
  ActiveRunControlReason,
  ActiveRunControlResult,
  ActiveRunControlSnapshot,
  DelegatedWorkReceipt,
  HumanGateDecisionInput,
  HumanGateDecisionResult,
  HumanGateStatus,
  ProjectBindingInput,
  ProjectBindingRecord,
  ProjectBindingScope,
  ProjectBindingUpdateInput,
  ProjectContextResolution,
  RoadmapArchiveResult,
  RoadmapCompletionProposalDecisionInput,
  RoadmapCompletionProposalDecisionResult,
  RoadmapCompletionProposalInput,
  RoadmapCompletionProposalRecord,
  RoadmapCompletionProposalStatus,
  RoadmapDeleteResult,
  RoadmapQualitySpec,
  RoadmapRecord,
  RoadmapSupervisorCreateInput,
  RoadmapSupervisorRecord,
  RoadmapSupervisorStatus,
  RoadmapSupervisorUpdateInput,
  RoadmapUpdateInput,
  RunAttributionInput,
  RunLeaseExpectation,
  RunRecord,
  RunResolutionInput,
  SupervisorWakeupReceiptRecord,
  SupervisorWakeupReceiptStatus,
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
  WorkTaskRecord,
  WorkTaskRunCompleteResult,
  WorkTaskRunFailResult,
  WorkTaskRunStartResult,
  WorkTaskUpdateInput,
  WorkTaskUpdateResult,
  WorkTaskView,
} from './work-store/types.js'






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

export {
  planInitiative,
  createSupervisedProject,
  createDelegatedWork,
  acquireDueRoadmapSupervisorWakeups,
  completeRoadmapSupervisorWakeup,
  applyRoadmapSupervisorResult,
  type PlanInitiativeDependency,
  type PlanInitiativeInput,
  type PlanInitiativeResult,
} from './work-store/project-orchestration.js'

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
