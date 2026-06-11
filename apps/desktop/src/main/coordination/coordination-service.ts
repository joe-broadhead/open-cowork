import { createHash } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type {
  CoordinationProjectInput,
  CoordinationProjectUpdateInput,
  CoordinationTask,
  CoordinationTaskAssignInput,
  CoordinationTaskInput,
  CoordinationTaskMoveInput,
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
} from '@open-cowork/shared'
import { getSessionRecord, toRendererSession } from '../session-registry.ts'
import { addRuntimeSessionEventObserver, type RuntimeSessionEvent } from '../session-event-dispatcher.ts'
import { log } from '../logger.ts'

let getMainWindow: (() => BrowserWindow | null) | null = null
let removeRuntimeEventObserver: (() => boolean) | null = null

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
  getMainWindow: () => BrowserWindow | null
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
