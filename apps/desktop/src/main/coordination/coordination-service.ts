import { createHash } from 'node:crypto'
type RendererWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}
import type {
  CoordinationChiefOfStaffPlanInput,
  CoordinationChiefOfStaffPlanResult,
  CoordinationChiefOfStaffTaskDraft,
  CoordinationProject,
  CoordinationProjectInput,
  CoordinationProjectUpdateInput,
  CoordinationTask,
  CoordinationTaskAssignInput,
  CoordinationTaskColumn,
  CoordinationTaskInput,
  CoordinationTaskMoveInput,
  CoordinationTaskPriority,
  CoordinationTaskUpdateInput,
  CoordinationTaskWorkLinkInput,
  CoordinationTarget,
  CoordinationWatch,
  CoordinationWatchEvent,
  CoordinationWatchEventType,
  CoordinationWatchInput,
  CoordinationWatchStatus,
  CoordinationWatchUpdateInput,
  SessionInfo,
} from '@open-cowork/shared'
import {
  assignCoordinationTask as assignTaskState,
  createCoordinationWatch as createWatchState,
  createCoordinationProject as createProjectState,
  createCoordinationTask as createTaskState,
  deleteCoordinationWatch as deleteWatchState,
  getCoordinationProject,
  getCoordinationTask,
  getCoordinationWatch,
  linkCoordinationTaskWork,
  listCoordinationBoard as listBoardState,
  listMatchingCoordinationWatches as listMatchingWatchesState,
  listCoordinationProjects as listProjectsState,
  listCoordinationTasks as listTasksState,
  listCoordinationWatches as listWatchesState,
  moveCoordinationTask as moveTaskState,
  updateCoordinationProject as updateProjectState,
  updateCoordinationTask as updateTaskState,
  updateCoordinationWatch as updateWatchState,
} from './coordination-store.ts'
import {
  coordinationWatchRecipientCanReceive,
  isCoordinationTaskColumn,
  isCoordinationTaskPriority,
} from '@open-cowork/shared'
import { getSessionRecord, toRendererSession } from '../session-registry.ts'
import { addRuntimeSessionEventObserver, type RuntimeSessionEvent } from '../session-event-dispatcher.ts'
import { log } from '../logger.ts'

let getMainWindow: (() => RendererWindow | null) | null = null
let removeRuntimeEventObserver: (() => boolean) | null = null

const CHIEF_OF_STAFF_AGENT_ID = 'chief-of-staff'
const CHIEF_OF_STAFF_DISPLAY_NAME = 'Cleo'
const MAX_CLEO_PLAN_TASKS = 20
const MAX_CLEO_TITLE_BYTES = 240
const MAX_CLEO_SPEC_BYTES = 32 * 1024
const MAX_CLEO_AGENT_ID_BYTES = 256
const MAX_CLEO_EXTERNAL_REF_BYTES = 512
const CLEO_SELF_AGENT_IDS = new Set(['cleo', CHIEF_OF_STAFF_AGENT_ID, 'executive-assistant'])
const READ_ONLY_AGENT_IDS = new Set(['explore', 'plan'])

export type CoordinationWatchDeliveryInput = {
  workspaceId: string
  deliveryId: string
  agentId: string
  channelBindingId: string
  sessionBindingId?: string | null
  provider: string
  target: Record<string, unknown>
  eventType: CoordinationWatchEventType
  payload: Record<string, unknown>
}

export type CoordinationWatchDeliveryAdapter = {
  createChannelDelivery?: (input: CoordinationWatchDeliveryInput) => Promise<unknown> | unknown
}

type CoordinationWatchDeliveryResult = {
  watchId: string
  eventType: CoordinationWatchEventType
  delivered: boolean
  skippedReason?: 'no_delivery_adapter' | 'recipient_role' | 'delivery_failed'
  error?: string
}

let watchDeliveryAdapter: CoordinationWatchDeliveryAdapter | null = null

function publishCoordinationUpdated() {
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send('coordination:updated')
}

export function configureCoordinationService(options: {
  getMainWindow: () => RendererWindow | null
  watchDeliveryAdapter?: CoordinationWatchDeliveryAdapter | null
}) {
  getMainWindow = options.getMainWindow
  if (Object.prototype.hasOwnProperty.call(options, 'watchDeliveryAdapter')) {
    watchDeliveryAdapter = options.watchDeliveryAdapter || null
  }
  if (!removeRuntimeEventObserver) {
    removeRuntimeEventObserver = addRuntimeSessionEventObserver(observeRuntimeWatchEvent)
  }
}

export function configureCoordinationWatchDeliveryAdapter(adapter: CoordinationWatchDeliveryAdapter | null) {
  watchDeliveryAdapter = adapter
}

export function listCoordinationBoard(options: { workspaceId?: string | null; limit?: number } = {}) {
  return listBoardState(options)
}

export function listCoordinationProjects(options: { workspaceId?: string | null; limit?: number } = {}) {
  return listProjectsState(options)
}

export function listCoordinationTasks(options: { workspaceId?: string | null; projectId?: string | null; limit?: number } = {}) {
  return listTasksState(options)
}

export function listCoordinationWatches(options: {
  workspaceId?: string | null
  target?: CoordinationTarget | null
  status?: CoordinationWatchStatus | null
  limit?: number
} = {}) {
  return listWatchesState(options)
}

export function createCoordinationProject(input: CoordinationProjectInput) {
  const project = createProjectState(input)
  publishCoordinationUpdated()
  return project
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function normalizedText(value: unknown, label: string, options: { required?: boolean; maxBytes?: number } = {}) {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${label} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) {
    if (options.required) throw new Error(`${label} is required.`)
    return null
  }
  const maxBytes = options.maxBytes || MAX_CLEO_SPEC_BYTES
  if (byteLength(trimmed) > maxBytes) throw new Error(`${label} is too large.`)
  return trimmed
}

function uniqueAgents(values: unknown[]) {
  const seen = new Set<string>()
  const agents: string[] = []
  for (const value of values) {
    const agent = normalizedText(value, 'Cleo assignee agent', { maxBytes: MAX_CLEO_AGENT_ID_BYTES })
    if (!agent) continue
    const normalized = agent.toLowerCase()
    if (CLEO_SELF_AGENT_IDS.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    agents.push(agent)
  }
  return agents
}

function candidateAgentsForPlan(project: CoordinationProject, input: CoordinationChiefOfStaffPlanInput) {
  const explicit = Array.isArray(input.assigneeAgents) ? input.assigneeAgents : []
  const candidates = uniqueAgents([...explicit, ...project.team])
  return candidates.length > 0 ? candidates : ['explore', 'general']
}

function writableAgentFromCandidates(candidates: string[], fallbackIndex = 0) {
  const rotated = candidates.slice(fallbackIndex).concat(candidates.slice(0, fallbackIndex))
  return rotated.find((agent) => !READ_ONLY_AGENT_IDS.has(agent.toLowerCase())) || 'general'
}

function agentMatching(candidates: string[], patterns: RegExp[], fallbackIndex = 0) {
  return candidates.find((agent) => patterns.some((pattern) => pattern.test(agent)))
    || candidates[Math.min(fallbackIndex, candidates.length - 1)]
    || 'general'
}

function executionAgentMatching(candidates: string[], patterns: RegExp[]) {
  return candidates.find((agent) => {
    if (READ_ONLY_AGENT_IDS.has(agent.toLowerCase())) return false
    return patterns.some((pattern) => pattern.test(agent))
  }) || 'general'
}

function objectiveForPlan(project: CoordinationProject, input: CoordinationChiefOfStaffPlanInput) {
  return normalizedText(input.objective, 'Cleo objective', { maxBytes: MAX_CLEO_SPEC_BYTES }) || project.objective
}

function titleFromSpec(spec: string, index: number) {
  const firstLine = spec.split('\n').map((line) => line.trim()).find(Boolean) || `Task ${index + 1}`
  const cleaned = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim() || `Task ${index + 1}`
  const shortened = cleaned.length > 80 ? `${cleaned.slice(0, 77).trimEnd()}...` : cleaned
  if (byteLength(shortened) <= MAX_CLEO_TITLE_BYTES) return shortened

  let result = ''
  for (const char of shortened) {
    if (byteLength(`${result}${char}...`) > MAX_CLEO_TITLE_BYTES) break
    result += char
  }
  const trimmed = result.trimEnd()
  return trimmed ? `${trimmed}...` : `Task ${index + 1}`
}

function normalizePlanPriority(value: unknown): CoordinationTaskPriority {
  if (value === undefined || value === null) return 'med'
  if (!isCoordinationTaskPriority(value)) throw new Error('Cleo task priority is invalid.')
  return value
}

function normalizePlanColumn(value: unknown): CoordinationTaskColumn {
  if (value === undefined || value === null) return 'planning'
  if (!isCoordinationTaskColumn(value)) throw new Error('Cleo task column is invalid.')
  return value
}

function defaultCleoTaskDrafts(objective: string, candidates: string[]): CoordinationChiefOfStaffTaskDraft[] {
  const discoveryAgent = agentMatching(candidates, [/explore/i, /research/i, /analyst/i])
  const executionAgent = executionAgentMatching(candidates, [/build/i, /builder/i, /engineer/i, /general/i])
  const reviewAgent = executionAgentMatching(candidates, [/review/i, /qa/i, /test/i, /general/i])
  return [
    {
      title: 'Clarify scope and success criteria',
      spec: [
        `Objective: ${objective}`,
        '',
        'Produce the project brief the team will execute against: success criteria, constraints, assumptions, known risks, and the first questions that must be answered before implementation starts.',
        '',
        'Acceptance: the brief is specific enough for a coworker to begin work without rereading the original objective.',
      ].join('\n'),
      assigneeAgent: discoveryAgent,
      priority: 'high',
      column: 'planning',
    },
    {
      title: 'Map the execution path',
      spec: [
        `Objective: ${objective}`,
        '',
        'Break the work into concrete implementation slices, identify dependencies between slices, and call out the narrowest first slice that proves the direction.',
        '',
        'Acceptance: the plan names the order of work, handoff points, validation needs, and any blocked decisions.',
      ].join('\n'),
      assigneeAgent: discoveryAgent,
      priority: 'med',
      column: 'planning',
    },
    {
      title: 'Build the first implementation slice',
      spec: [
        `Objective: ${objective}`,
        '',
        'Implement the first useful slice from the execution plan using the existing OpenCode runtime, repository patterns, and product boundaries. Keep unrelated refactors out of scope.',
        '',
        'Acceptance: the slice is usable, covered by focused validation, and ready for human review.',
      ].join('\n'),
      assigneeAgent: executionAgent,
      priority: 'high',
      column: 'planning',
    },
    {
      title: 'Verify and prepare the handoff',
      spec: [
        `Objective: ${objective}`,
        '',
        'Review the completed slice against the project objective, collect evidence from tests or manual checks, and summarize remaining follow-up tasks.',
        '',
        'Acceptance: the reviewer can decide whether to move the task to done, request changes, or create the next set of implementation tasks.',
      ].join('\n'),
      assigneeAgent: reviewAgent,
      priority: 'med',
      column: 'planning',
    },
  ]
}

function taskExternalRef(projectId: string, objective: string, index: number, title: string) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ projectId, objective, index, title }))
    .digest('hex')
    .slice(0, 16)
  return `${CHIEF_OF_STAFF_AGENT_ID}:${digest}:${index + 1}`
}

function normalizeCleoTaskInputs(
  project: CoordinationProject,
  input: CoordinationChiefOfStaffPlanInput,
  objective: string,
): CoordinationTaskInput[] {
  const candidates = candidateAgentsForPlan(project, input)
  const rawTasks = input.tasks === undefined || input.tasks === null
    ? defaultCleoTaskDrafts(objective, candidates)
    : input.tasks
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new Error('Cleo plan tasks must be a non-empty array.')
  if (rawTasks.length > MAX_CLEO_PLAN_TASKS) throw new Error('Cleo plan contains too many tasks.')
  return rawTasks.map((draft, index) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Cleo task draft must be an object.')
    const record = draft as CoordinationChiefOfStaffTaskDraft
    const spec = normalizedText(record.spec, 'Cleo task spec', { required: true, maxBytes: MAX_CLEO_SPEC_BYTES })!
    const title = normalizedText(record.title, 'Cleo task title', { maxBytes: MAX_CLEO_TITLE_BYTES }) || titleFromSpec(spec, index)
    const requestedAssignee = normalizedText(record.assigneeAgent, 'Cleo task assignee agent', { maxBytes: MAX_CLEO_AGENT_ID_BYTES })
    const assigneeAgent = requestedAssignee && !CLEO_SELF_AGENT_IDS.has(requestedAssignee.toLowerCase())
      ? requestedAssignee
      : writableAgentFromCandidates(candidates, index)
    const externalRef = taskExternalRef(project.id, objective, index, title)
    assertCleoTaskInputReady({ title, spec, assigneeAgent, externalRef })
    return {
      projectId: project.id,
      workspaceId: project.workspaceId,
      title,
      spec,
      priority: normalizePlanPriority(record.priority),
      column: normalizePlanColumn(record.column),
      assigneeAgent,
      externalRef,
    }
  })
}

function assertCleoTaskInputReady(input: {
  title: string
  spec: string
  assigneeAgent: string
  externalRef: string
}) {
  if (byteLength(input.title) > MAX_CLEO_TITLE_BYTES) throw new Error('Cleo task title is too large.')
  if (byteLength(input.spec) > MAX_CLEO_SPEC_BYTES) throw new Error('Cleo task spec is too large.')
  if (byteLength(input.assigneeAgent) > MAX_CLEO_AGENT_ID_BYTES) throw new Error('Cleo task assignee agent is too large.')
  if (byteLength(input.externalRef) > MAX_CLEO_EXTERNAL_REF_BYTES) throw new Error('Cleo task external ref is too large.')
}

export function planCoordinationProjectWithCleo(input: CoordinationChiefOfStaffPlanInput): CoordinationChiefOfStaffPlanResult | null {
  const projectId = normalizedText(input.projectId, 'Project id', { required: true, maxBytes: 512 })!
  const project = getCoordinationProject(projectId)
  if (!project) return null
  const workspaceId = normalizedText(input.workspaceId, 'Workspace id', { maxBytes: 512 }) || project.workspaceId
  if (workspaceId !== project.workspaceId) throw new Error('Cleo plan workspace must match its project workspace.')
  const objective = objectiveForPlan(project, input)
  const taskInputs = normalizeCleoTaskInputs(project, input, objective)
  const tasks = taskInputs.map((taskInput) => createTaskState(taskInput))
  publishCoordinationUpdated()
  return {
    plannerAgent: CHIEF_OF_STAFF_AGENT_ID,
    displayName: CHIEF_OF_STAFF_DISPLAY_NAME,
    objective,
    project,
    tasks,
  }
}

export function updateCoordinationProject(projectId: string, input: CoordinationProjectUpdateInput) {
  const project = updateProjectState(projectId, input)
  if (project) publishCoordinationUpdated()
  return project
}

export function createCoordinationTask(input: CoordinationTaskInput) {
  const task = createTaskState(input)
  publishCoordinationUpdated()
  return task
}

function dispatchTaskColumnWatchEvents(before: CoordinationTask | null, task: CoordinationTask) {
  if (before && before.column !== task.column) {
    dispatchCoordinationWatchEvent({
      eventType: 'task.moved',
      workspaceId: task.workspaceId,
      target: { kind: 'task', id: task.id },
      relatedTargets: [{ kind: 'project', id: task.projectId }],
      title: 'Task moved',
      message: `${task.title} moved to ${task.column}.`,
      metadata: { taskId: task.id, projectId: task.projectId, previousColumn: before.column, column: task.column },
    })
  }
  if (task.column === 'review' && before?.column !== 'review') {
    dispatchCoordinationWatchEvent({
      eventType: 'task.review_ready',
      workspaceId: task.workspaceId,
      target: { kind: 'task', id: task.id },
      relatedTargets: [{ kind: 'project', id: task.projectId }],
      title: 'Task ready for review',
      message: task.title,
      metadata: { taskId: task.id, projectId: task.projectId, column: task.column, status: task.status },
    })
  }
}

export function updateCoordinationTask(taskId: string, input: CoordinationTaskUpdateInput) {
  const before = getCoordinationTask(taskId)
  const task = updateTaskState(taskId, input)
  if (task) {
    publishCoordinationUpdated()
    dispatchTaskColumnWatchEvents(before, task)
  }
  return task
}

export function moveCoordinationTask(taskId: string, input: CoordinationTaskMoveInput) {
  const before = getCoordinationTask(taskId)
  const task = moveTaskState(taskId, input.column)
  if (task) {
    publishCoordinationUpdated()
    dispatchTaskColumnWatchEvents(before, task)
  }
  return task
}

export function assignCoordinationTask(taskId: string, input: CoordinationTaskAssignInput) {
  const task = assignTaskState(taskId, input.assigneeAgent)
  if (task) publishCoordinationUpdated()
  return task
}

export function linkCoordinationTaskToSession(taskId: string, input: CoordinationTaskWorkLinkInput) {
  const record = getSessionRecord(input.assignedSessionId)
  if (!record) throw new Error('Assigned OpenCode session was not found.')
  const before = getCoordinationTask(taskId)
  const task = linkCoordinationTaskWork(taskId, {
    ...input,
    assignedRunId: input.assignedRunId ?? record.runId,
  })
  if (task) {
    publishCoordinationUpdated()
    dispatchTaskColumnWatchEvents(before, task)
  }
  return task
}

export function linkCoordinationTaskToValidatedWork(taskId: string, input: CoordinationTaskWorkLinkInput) {
  const before = getCoordinationTask(taskId)
  const task = linkCoordinationTaskWork(taskId, input)
  if (task) {
    publishCoordinationUpdated()
    dispatchTaskColumnWatchEvents(before, task)
  }
  return task
}

export function createCoordinationWatch(input: CoordinationWatchInput) {
  const watch = createWatchState(input)
  publishCoordinationUpdated()
  return watch
}

export function updateCoordinationWatch(watchId: string, input: CoordinationWatchUpdateInput) {
  const watch = updateWatchState(watchId, input)
  if (watch) publishCoordinationUpdated()
  return watch
}

export function pauseCoordinationWatch(watchId: string) {
  return updateCoordinationWatch(watchId, { status: 'paused' })
}

export function resumeCoordinationWatch(watchId: string) {
  return updateCoordinationWatch(watchId, { status: 'active' })
}

export function deleteCoordinationWatch(watchId: string) {
  const deleted = deleteWatchState(watchId)
  if (deleted) publishCoordinationUpdated()
  return deleted
}

export function getCoordinationTaskWorkTarget(taskId: string): SessionInfo | null {
  const task = getCoordinationTask(taskId)
  if (!task?.assignedSessionId) return null
  const record = getSessionRecord(task.assignedSessionId)
  return record ? toRendererSession(record) : null
}

export function getCoordinationProjectDetail(projectId: string) {
  return getCoordinationProject(projectId)
}

export function getCoordinationTaskDetail(taskId: string) {
  return getCoordinationTask(taskId)
}

export function getCoordinationWatchDetail(watchId: string) {
  return getCoordinationWatch(watchId)
}

function relatedTargets(event: CoordinationWatchEvent) {
  return [event.target, ...(event.relatedTargets || [])]
}

function watchMatchesEvent(watch: CoordinationWatch, event: CoordinationWatchEvent) {
  if (!watch.events.includes(event.eventType)) return false
  if (!coordinationWatchRecipientCanReceive(watch.recipient?.role, event.eventType)) return false
  return relatedTargets(event).some((target) => target.kind === watch.target.kind && target.id === watch.target.id)
}

function watchPayload(watch: CoordinationWatch, event: CoordinationWatchEvent): Record<string, unknown> {
  return {
    watchId: watch.id,
    eventType: event.eventType,
    target: event.target,
    relatedTargets: event.relatedTargets || [],
    title: event.title || null,
    message: event.message || null,
    severity: event.severity || 'info',
    occurredAt: event.occurredAt || new Date().toISOString(),
    metadata: event.metadata || {},
  }
}

function deliveryIdForWatchEvent(watch: CoordinationWatch, event: CoordinationWatchEvent) {
  const timestampScopedEvent = event.eventType === 'task.moved'
    || event.eventType === 'task.review_ready'
    || event.eventType === 'run.finished'
    || event.eventType === 'daily_summary'
  const eventKey = {
    watchId: watch.id,
    eventType: event.eventType,
    target: event.target,
    relatedTargets: event.relatedTargets || [],
    metadata: event.metadata || {},
    occurredAt: timestampScopedEvent ? event.occurredAt || null : null,
  }
  const digest = createHash('sha256').update(JSON.stringify(eventKey)).digest('hex').slice(0, 40)
  return `watch:${event.eventType}:${digest}`
}

export async function emitCoordinationWatchEvent(event: CoordinationWatchEvent): Promise<CoordinationWatchDeliveryResult[]> {
  const workspaceId = event.workspaceId?.trim() || 'local'
  const watches = listMatchingWatchesState({
    workspaceId,
    eventType: event.eventType,
    targets: relatedTargets(event),
  })
  const matches = watches.filter((watch) => watchMatchesEvent(watch, event))
  const results: CoordinationWatchDeliveryResult[] = []
  for (const watch of matches) {
    if (!watchDeliveryAdapter?.createChannelDelivery) {
      results.push({ watchId: watch.id, eventType: event.eventType, delivered: false, skippedReason: 'no_delivery_adapter' })
      continue
    }
    try {
      await watchDeliveryAdapter.createChannelDelivery({
        workspaceId: watch.workspaceId,
        deliveryId: deliveryIdForWatchEvent(watch, event),
        agentId: watch.channel.agentId,
        channelBindingId: watch.channel.channelBindingId,
        sessionBindingId: watch.channel.sessionBindingId || null,
        provider: watch.channel.provider,
        target: watch.channel.target,
        eventType: event.eventType,
        payload: watchPayload(watch, event),
      })
      results.push({ watchId: watch.id, eventType: event.eventType, delivered: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('coordination', `Watch delivery failed watch=${watch.id} event=${event.eventType}: ${message}`)
      results.push({ watchId: watch.id, eventType: event.eventType, delivered: false, skippedReason: 'delivery_failed', error: message })
    }
  }
  return results
}

function dispatchCoordinationWatchEvent(event: CoordinationWatchEvent) {
  void emitCoordinationWatchEvent({
    ...event,
    occurredAt: event.occurredAt || new Date().toISOString(),
  }).catch((error: unknown) => {
    log('coordination', `Watch event dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function sessionTargets(sessionId: string): CoordinationTarget[] {
  return [
    { kind: 'session', id: sessionId },
    { kind: 'conversation', id: sessionId },
  ]
}

function observeRuntimeWatchEvent(event: RuntimeSessionEvent) {
  const type = String(event.data?.type || event.type || '')
  const sessionId = event.sessionId?.trim()
  if (!sessionId) return
  const workspaceId = event.workspaceId || 'local'
  const targets = sessionTargets(sessionId)
  if (type === 'done') {
    dispatchCoordinationWatchEvent({
      eventType: 'run.finished',
      workspaceId,
      target: targets[0]!,
      relatedTargets: targets.slice(1),
      title: 'Run finished',
      message: 'OpenCode finished processing the run.',
      severity: 'success',
      metadata: { sessionId, synthetic: Boolean(event.data?.synthetic) },
    })
    return
  }
  if (type === 'approval' || type === 'question_asked') {
    dispatchCoordinationWatchEvent({
      eventType: 'needs_input',
      workspaceId,
      target: targets[1]!,
      relatedTargets: targets,
      title: type === 'approval' ? 'Approval needed' : 'Question needs an answer',
      message: typeof event.data?.description === 'string' ? event.data.description : null,
      severity: 'warning',
      metadata: {
        sessionId,
        requestId: event.data?.id || null,
        taskRunId: event.data?.taskRunId || null,
        kind: type,
      },
    })
  }
}
