/**
 * Task / roadmap / dependency in-state helpers (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts (keeps dependency graph acyclic).
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { getConfig } from '../config.js'
import { normalizeEnvironmentSelector, type EnvironmentSelector } from '../environments.js'
import { defaultPipeline, normalizeTaskQualitySpec, type WorkStatus } from '../workflow.js'
import { isActiveRunStatus, isTaskActiveStatus, isTaskRunOwnershipTerminalStatus } from '../runtime-state-machine.js'
import { normalizeRoadmapQualitySpec } from './row-mappers.js'
import {
  normalizeOptionalIdentifier,
  normalizeOptionalIsoTime,
  normalizeOptionalString,
  normalizePriority,
  normalizeRequiredString,
  normalizeStage,
} from './validators.js'
import {
  INBOX_ROADMAP_ID,
  type ManualGate,
  type RoadmapQualitySpec,
  type RoadmapRecord,
  type RoadmapStatus,
  type RunRecord,
  type RunResolutionInput,
  type WorkDependencyInput,
  type WorkDependencyRecord,
  type WorkDependencyType,
  type WorkState,
  type WorkTaskAction,
  type WorkTaskBulkUpdateInput,
  type WorkTaskCreateInput,
  type WorkTaskReadiness,
  type WorkTaskReadinessStatus,
  type WorkTaskRecord,
  type WorkTaskUpdateInput,
  type WorkTaskView,
} from './types.js'
import { appendWorkEventRow } from './event-append.js'
import { humanGateInputForManualTask, insertHumanGateRow, manualGateReason } from './human-gates.js'

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

export interface WorkTaskReadinessIndexes {
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

export function applyTaskUpdate(task: WorkTaskRecord, input: WorkTaskUpdateInput): void {
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

export function createRoadmapInState(state: WorkState, db: DatabaseSync, input: { title: string; priority?: 'HIGH' | 'MEDIUM' | 'LOW'; agentTeam?: string; environment?: EnvironmentSelector; qualitySpec?: RoadmapQualitySpec }, now: string): RoadmapRecord {
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

export function createWorkTaskInState(state: WorkState, db: DatabaseSync, input: WorkTaskCreateInput, now: string): WorkTaskRecord {
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

export function validateTaskUpdate(state: WorkState, task: WorkTaskRecord, input: WorkTaskUpdateInput): void {
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

export function addWorkDependencyInState(state: WorkState, db: DatabaseSync, input: WorkDependencyInput, now: string): WorkDependencyRecord {
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

export function assertRoadmapAcceptsTasks(state: WorkState, roadmapId: string): void {
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap) throw new Error(`roadmap not found: ${roadmapId}`)
  if (roadmap.status === 'archived') throw new Error(`roadmap is archived: ${roadmapId}`)
}


function assertProfileExists(profile: string): void {
  if (!getConfig().profiles[profile]) throw new Error(`profile not found: ${profile}`)
}

function assertAgentTeamExists(agentTeam: string): void {
  if (!getConfig().agentTeams[agentTeam]) throw new Error(`agent team not found: ${agentTeam}`)
}

export function normalizeOptionalAgentTeam(value: unknown, label: string): string | undefined {
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

export function assertStageInPipeline(task: WorkTaskRecord, stage: string): void {
  if (!task.pipeline.includes(stage)) throw new Error(`stage must be in pipeline: ${stage}`)
}

export function normalizeTaskPipeline(input?: string[], fallback = defaultPipeline()): string[] {
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

export function normalizeTaskCreateList(inputs: unknown): WorkTaskCreateInput[] {
  if (!Array.isArray(inputs)) throw new Error('tasks must be an array')
  return inputs.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`task at index ${index} must be an object`)
    return input as WorkTaskCreateInput
  })
}

export function normalizeTaskUpdateList(inputs: unknown): WorkTaskBulkUpdateInput[] {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('updates must include at least one task update')
  return inputs.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`update at index ${index} must be an object`)
    const update = input as WorkTaskBulkUpdateInput
    if (typeof update.taskId !== 'string' || !update.taskId.trim()) throw new Error(`update at index ${index} requires taskId`)
    return update
  })
}

export function normalizeRoadmapStatus(value: unknown): RoadmapStatus {
  if (value === 'active' || value === 'done' || value === 'blocked' || value === 'archived') return value
  throw new Error(`roadmap status must be active, done, blocked, or archived: ${String(value)}`)
}


export function normalizeWorkStatus(value: unknown): WorkStatus {
  if (value === 'pending' || value === 'running' || value === 'done' || value === 'blocked' || value === 'paused' || value === 'cancelled' || value === 'archived') return value
  throw new Error(`task status must be pending, running, done, blocked, paused, cancelled, or archived: ${String(value)}`)
}

export function normalizeWorkTaskAction(value: unknown): WorkTaskAction {
  if (value === 'pause' || value === 'resume' || value === 'cancel' || value === 'retry' || value === 'done' || value === 'block') return value
  throw new Error(`task action must be pause, resume, cancel, retry, done, or block: ${String(value)}`)
}

export function normalizeDependencyType(value: unknown): WorkDependencyType {
  if (value === undefined || value === null || value === '') return 'blocks'
  if (value === 'blocks' || value === 'blocked_by' || value === 'parent' || value === 'child' || value === 'related' || value === 'duplicate') return value
  throw new Error(`dependency type must be blocks, blocked_by, parent, child, related, or duplicate: ${String(value)}`)
}

export function normalizeManualGate(value: unknown): ManualGate | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'approval_required' || value === 'credentials_required' || value === 'external_dependency' || value === 'waiting_for_user') return value
  throw new Error(`manualGate must be approval_required, credentials_required, external_dependency, or waiting_for_user: ${String(value)}`)
}


function blockingDependenciesForTask(taskId: string, state: WorkState, indexes?: Pick<WorkTaskReadinessIndexes, 'dependenciesByTask'>): WorkDependencyRecord[] {
  const dependencies = indexes?.dependenciesByTask?.get(taskId) || state.dependencies || []
  return dependencies.filter(dep => dep.taskId === taskId && (dep.type === 'blocks' || dep.type === 'blocked_by' || dep.type === 'parent'))
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

export function ensureInboxRoadmap(state: WorkState, now: Date): RoadmapRecord {
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

export function priorityRank(priority: string): number {
  return priority === 'HIGH' ? 0 : priority === 'MEDIUM' ? 1 : 2
}
