/**
 * Project / initiative / delegation orchestration (LOC façade split).
 * Leaf relative to work-store.ts — large multi-entity write transactions live here.
 */
import { randomUUID } from 'node:crypto'
import type { EnvironmentSelector } from '../environments.js'
import { queryRows, workStatePath } from './db.js'
import { upsertChannelBindingRow } from './channel-bindings.js'
import {
  appendDelegationProgressForRoadmap,
  appendDelegationProgressRow,
  delegationProgressKey,
  findDelegationReceiptInDb,
  nextDelegationSchedulerAction,
  receiptLinks,
  supervisedProjectResultFromReceipt,
  upsertDelegationReceiptRow,
} from './delegation-helpers.js'
import { appendWorkEventRow } from './event-append.js'
import { manualGateReason } from './human-gates.js'
import {
  approveRoadmapCompletionProposalInState,
  completionAutoBlockers,
  deleteProjectBindingChannelRow,
  upsertProjectBindingInState,
} from './project-binding-helpers.js'
import { rowToEvent } from './row-mappers.js'
import { mutateWorkState } from './state-io.js'
import {
  applyRoadmapSupervisorUpdate,
  compareRoadmapSupervisors,
  completeSupervisorWakeupReceiptRow,
  createRoadmapSupervisorInState,
  nextSupervisorReviewAt,
  reconcileDefaultSupervisorInState,
  supervisorEligibleForWakeup,
  supervisorWakeupIdempotencyKey,
  supervisorWakeupReason,
  upsertSupervisorWakeupReceiptRow,
} from './supervisor-helpers.js'
import {
  addWorkDependencyInState,
  assertRoadmapAcceptsTasks,
  createRoadmapInState,
  createWorkTaskInState,
  normalizeTaskCreateList,
  recomputeRoadmapStatusInState,
} from './task-helpers.js'
import type {
  DelegatedWorkMutationInput,
  DelegatedWorkReceipt,
  ProjectBindingRecord,
  RoadmapCompletionProposalRecord,
  RoadmapQualitySpec,
  RoadmapRecord,
  RoadmapSupervisorCreateInput,
  RoadmapSupervisorRecord,
  RoadmapSupervisorResultApplyInput,
  RoadmapSupervisorResultApplyResult,
  RoadmapSupervisorWakeupRecord,
  SupervisedProjectCreateInput,
  SupervisedProjectCreateResult,
  WorkDependencyRecord,
  WorkDependencyType,
  WorkTaskCreateInput,
  WorkTaskRecord,
} from './types.js'
import { normalizeOptionalString, normalizeStringList } from './validators.js'

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

