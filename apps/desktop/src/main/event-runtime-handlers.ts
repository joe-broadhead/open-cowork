import type { BrowserWindow } from 'electron'
import { trackPermission } from './permission-tracker.ts'
import { log } from './logger.ts'
import {
  normalizeSessionInfo,
  normalizeTodoItems,
} from './opencode-adapter.ts'
import {
  asRecord,
  readRecordArray,
  readRecordValue,
  readString,
} from './normalizer-utils.ts'
import {
  extractRuntimeErrorMessage,
  normalizePermissionEvent,
  readRuntimeSessionId,
} from './runtime-event-normalizers.ts'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import { dropSessionFromDispatcherQueues, publishNotification } from './session-event-dispatcher.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { touchSessionRecord, updateSessionRecord } from './session-registry.ts'
import { sessionEngine } from './session-engine.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from './session-status-reconciler.ts'
import {
  handleWorkflowSessionError,
  handleWorkflowSessionIdle,
} from './workflow/workflow-service.ts'
import {
  ensureTaskRunForChild,
  forgetSubmittedPrompt,
  getTaskRun,
  getTaskRunIdForChild,
  isTrackedParentSession,
  queueOrBindChildSession,
  registerSession,
  removeParentSessionState,
  removeSessionState,
  resolveRootSession,
  untrackParentSession,
  updateTaskRun,
} from './event-task-state.ts'
import { emitTaskRun } from './event-task-run-dispatch.ts'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  normalizeAgentName,
  toIsoTimestamp,
} from './task-run-utils.ts'
import type { PermissionRequest } from '@open-cowork/shared'

type DispatchRuntimeEvent = (win: BrowserWindow, event: RuntimeSessionEvent) => void
const IDLE_EVENT_DEDUPE_MS = 2_000
const MAX_RECENT_IDLE_EVENTS = 1_000
const recentIdleEventAtBySession = new Map<string, number>()
const INTENTIONALLY_IGNORED_RUNTIME_EVENTS = new Set([
  'server.connected',
  'server.heartbeat',
  'session.diff',
  'session.next.model.switched',
])

function runRuntimeSideEffect(scope: string, task: () => void | Promise<unknown>) {
  void Promise.resolve().then(task).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    log('error', `${scope} failed: ${message}`)
  })
}

function dispatchSyntheticIdle(win: BrowserWindow, sessionId: string, dispatchRuntimeEvent: DispatchRuntimeEvent) {
  dispatchRuntimeEvent(win, {
    type: 'history_refresh',
    sessionId,
    data: { type: 'history_refresh' },
  })
  dispatchRuntimeEvent(win, {
    type: 'done',
    sessionId,
    data: {
      type: 'done',
      synthetic: true,
    },
  })
}

function readEventSessionId(properties: Record<string, unknown> | null | undefined) {
  return readString(readRecordValue(properties, 'sessionID'))
    || readString(readRecordValue(properties, 'sessionId'))
}

function shouldProcessIdleEvent(actualSessionId: string) {
  const now = Date.now()
  const previous = recentIdleEventAtBySession.get(actualSessionId) || 0
  recentIdleEventAtBySession.set(actualSessionId, now)
  if (recentIdleEventAtBySession.size > MAX_RECENT_IDLE_EVENTS) {
    for (const [sessionId, idleAt] of recentIdleEventAtBySession.entries()) {
      if (now - idleAt > IDLE_EVENT_DEDUPE_MS) recentIdleEventAtBySession.delete(sessionId)
    }
  }
  return now - previous > IDLE_EVENT_DEDUPE_MS
}

function clearRecentIdleEvent(actualSessionId: string | null | undefined) {
  if (actualSessionId) recentIdleEventAtBySession.delete(actualSessionId)
}

function handleIdleTransition(input: {
  win: BrowserWindow
  actualSessionId: string | null | undefined
  dispatchRuntimeEvent: DispatchRuntimeEvent
}) {
  const { win, actualSessionId, dispatchRuntimeEvent } = input
  const rootSessionId = resolveRootSession(actualSessionId)
  if (!rootSessionId || !actualSessionId) return true
  if (!shouldProcessIdleEvent(actualSessionId)) return true

  log('session', `Idle: ${shortSessionId(actualSessionId)}${rootSessionId !== actualSessionId ? ` => ${shortSessionId(rootSessionId)}` : ''}`)
  if (rootSessionId === actualSessionId) {
    forgetSubmittedPrompt(rootSessionId)
    stopSessionStatusReconciliation(rootSessionId)
    touchSessionRecord(rootSessionId)
    dispatchRuntimeEvent(win, {
      type: 'history_refresh',
      sessionId: rootSessionId,
      data: { type: 'history_refresh' },
    })
    dispatchRuntimeEvent(win, {
      type: 'done',
      sessionId: rootSessionId,
      data: { type: 'done' },
    })
    if (isTrackedParentSession(rootSessionId)) {
      untrackParentSession(rootSessionId)
    }
    runRuntimeSideEffect('workflow idle handling', () => handleWorkflowSessionIdle(rootSessionId))
  } else {
    const taskRun = ensureTaskRunForChild(rootSessionId, actualSessionId)
    if (taskRun) {
      const updated = updateTaskRun(taskRun.id, { status: 'complete' })
      if (updated) emitTaskRun(win, updated)
    }
  }
  return true
}

function handleAgentSwitchedEvent(input: {
  win: BrowserWindow
  properties: Record<string, unknown> | null | undefined
  dispatchRuntimeEvent: DispatchRuntimeEvent
}) {
  const { win, properties, dispatchRuntimeEvent } = input
  const actualSessionId = readEventSessionId(properties)
  const rootSessionId = resolveRootSession(actualSessionId)
  const agentName = normalizeAgentName(readString(readRecordValue(properties, 'agent')))
    || readString(readRecordValue(properties, 'agent'))
    || null
  if (!rootSessionId || !actualSessionId || !agentName) return true

  if (actualSessionId === rootSessionId) {
    dispatchRuntimeEvent(win, {
      type: 'agent',
      sessionId: rootSessionId,
      data: { type: 'agent', name: agentName },
    })
    return true
  }

  const taskRun = ensureTaskRunForChild(rootSessionId, actualSessionId, agentName)
  if (!taskRun) return true
  const updated = updateTaskRun(taskRun.id, {
    agent: agentName,
    title: chooseTaskTitle(
      agentName,
      !isPlaceholderTaskTitle(taskRun.title, taskRun.agent || agentName) ? taskRun.title : null,
    ),
    status: taskRun.status === 'queued' ? 'running' : taskRun.status,
  })
  if (updated) emitTaskRun(win, updated)
  return true
}

export function removeParentSession(sessionId: string) {
  stopSessionStatusReconciliation(sessionId)
  removeParentSessionState(sessionId)
  sessionEngine.removeSession(sessionId)
}

export function resetRuntimeEventStateForTests() {
  recentIdleEventAtBySession.clear()
}

export function handleRuntimeSideEffectEvent(input: {
  win: BrowserWindow
  type: string
  properties: Record<string, unknown> | null | undefined
  dispatchRuntimeEvent: DispatchRuntimeEvent
  getMainWindow: () => BrowserWindow | null
}): boolean {
  const { win, type, properties, dispatchRuntimeEvent, getMainWindow } = input

  switch (type) {
    case 'permission.asked':
    case 'permission.updated': {
      const normalized = normalizePermissionEvent(properties)
      const permissionType = normalized.permissionType
      const permissionId = normalized.id
      const permissionSessionId = normalized.sessionId
      log('permission', `Received ${permissionType} permission ${shortSessionId(permissionSessionId)} id=${permissionId}`)
      if (permissionId && permissionSessionId) {
        trackPermission(permissionId, permissionSessionId)
      }

      const rootSessionId = resolveRootSession(permissionSessionId)
      if (!rootSessionId) return true
      if (!permissionId) {
        log('permission', `Ignoring ${permissionType} permission without request id for ${shortSessionId(permissionSessionId)}`)
        return true
      }

      const taskRunId = permissionSessionId && permissionSessionId !== rootSessionId
        ? (getTaskRunIdForChild(permissionSessionId)
          || ensureTaskRunForChild(rootSessionId, permissionSessionId)?.id)
        : null
      const taskRun = getTaskRun(taskRunId)
      const title = normalized.title
      const approval: PermissionRequest = {
        id: permissionId,
        sessionId: rootSessionId,
        taskRunId,
        tool: title,
        input: normalized.input,
        description: taskRun
          ? `${taskRun.title}: ${title || `Permission requested for ${permissionType}`}`
          : (title || `Permission requested for ${permissionType}`),
      }

      dispatchRuntimeEvent(win, {
        type: 'approval',
        sessionId: rootSessionId,
        data: {
          type: 'approval',
          id: approval.id,
          taskRunId,
          tool: approval.tool,
          input: approval.input,
          description: approval.description,
          sourceSessionId: permissionSessionId,
        },
      })
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('permission:request', approval)
      }
      return true
    }

    case 'question.asked': {
      const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      const questionId = readString(readRecordValue(properties, 'id'))
      if (!rootSessionId || !questionId) return true
      const questions = readRecordArray(properties, 'questions').map((entry) => {
        const record = asRecord(entry)
        return {
          header: readString(readRecordValue(record, 'header')) || '',
          question: readString(readRecordValue(record, 'question')) || '',
          options: readRecordArray(record, 'options').map((option) => ({
            label: readString(readRecordValue(option, 'label')) || '',
            description: readString(readRecordValue(option, 'description')) || '',
          })),
          multiple: Boolean(record.multiple),
          custom: readRecordValue(record, 'custom') !== false,
        }
      })

      stopSessionStatusReconciliation(rootSessionId)
      dispatchRuntimeEvent(win, {
        type: 'question_asked',
        sessionId: rootSessionId,
        data: {
          type: 'question_asked',
          id: questionId,
          questions,
          tool: readRecordValue(properties, 'tool')
            ? {
                messageId: readString(readRecordValue(readRecordValue(properties, 'tool'), 'messageID')) || '',
                callId: readString(readRecordValue(readRecordValue(properties, 'tool'), 'callID')) || '',
              }
            : undefined,
          sourceSessionId: actualSessionId,
        },
      })
      return true
    }

    case 'question.replied':
    case 'question.rejected': {
      const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      const requestId = readString(readRecordValue(properties, 'requestID'))
      if (!rootSessionId || !requestId) return true

      dispatchRuntimeEvent(win, {
        type: 'question_resolved',
        sessionId: rootSessionId,
        data: {
          type: 'question_resolved',
          id: requestId,
          sourceSessionId: actualSessionId,
        },
      })
      startSessionStatusReconciliation(rootSessionId, {
        getMainWindow,
        onIdle: (reconciledWin: BrowserWindow | null, reconciledSessionId: string) => {
          if (!reconciledWin || reconciledWin.isDestroyed()) return
          dispatchSyntheticIdle(reconciledWin, reconciledSessionId, dispatchRuntimeEvent)
        },
      })
      return true
    }

    case 'session.next.agent.switched':
      return handleAgentSwitchedEvent({ win, properties, dispatchRuntimeEvent })

    case 'session.idle':
      return handleIdleTransition({
        win,
        actualSessionId: readEventSessionId(properties),
        dispatchRuntimeEvent,
      })

    case 'session.status': {
      const status = asRecord(readRecordValue(properties, 'status'))
      const actualSessionId = readEventSessionId(properties)
      const rootSessionId = resolveRootSession(actualSessionId)
      if (!rootSessionId || !actualSessionId) return true

      if (readString(readRecordValue(status, 'type')) === 'busy') {
        clearRecentIdleEvent(actualSessionId)
        if (rootSessionId === actualSessionId) {
          touchSessionRecord(rootSessionId)
          dispatchRuntimeEvent(win, {
            type: 'busy',
            sessionId: rootSessionId,
            data: { type: 'busy' },
          })
        } else {
          const taskRun = ensureTaskRunForChild(rootSessionId, actualSessionId)
          if (taskRun) {
            const updated = updateTaskRun(taskRun.id, { status: 'running' })
            if (updated) emitTaskRun(win, updated)
          }
        }
      }

      if (readString(readRecordValue(status, 'type')) === 'idle') {
        handleIdleTransition({
          win,
          actualSessionId,
          dispatchRuntimeEvent,
        })
      }
      return true
    }

    case 'session.compacted': {
      const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      if (!rootSessionId) return true
      const taskRunId = actualSessionId && actualSessionId !== rootSessionId
        ? (getTaskRunIdForChild(actualSessionId)
          || ensureTaskRunForChild(rootSessionId, actualSessionId)?.id)
        : null
      log('session', `Compacted: ${shortSessionId(actualSessionId)}${rootSessionId !== actualSessionId ? ` => ${shortSessionId(rootSessionId)}` : ''}`)
      dispatchRuntimeEvent(win, {
        type: 'compacted',
        sessionId: rootSessionId,
        data: {
          type: 'compacted',
          status: 'compacted',
          taskRunId,
          sourceSessionId: actualSessionId,
          completedAt: new Date().toISOString(),
        },
      })
      return true
    }

    case 'session.created': {
      const info = normalizeSessionInfo(readRecordValue(properties, 'info'))
      if (!info?.id) return true
      registerSession(info.id, info.parentID)
      if (info.parentID) {
        const rootSessionId = resolveRootSession(info.parentID)
        if (rootSessionId) {
          const inferredAgent = extractAgentName(info.title)
          const taskRun = queueOrBindChildSession(info.parentID, info.id)
          if (taskRun) {
            const resolvedAgent = inferredAgent || taskRun.agent
            const updated = updateTaskRun(taskRun.id, {
              agent: resolvedAgent,
              title: chooseTaskTitle(
                resolvedAgent,
                !isPlaceholderTaskTitle(taskRun.title, taskRun.agent || resolvedAgent) ? taskRun.title : null,
                info.title,
              ),
            })
            emitTaskRun(win, updated || taskRun)
          }
        }
      }
      return true
    }

    case 'session.updated': {
      const info = normalizeSessionInfo(readRecordValue(properties, 'info'))
      if (info?.id) {
        registerSession(info.id, info.parentID)
      }
      if (info?.id && info?.parentID) {
        const rootSessionId = resolveRootSession(info.parentID)
        if (rootSessionId) {
          const inferredAgent = extractAgentName(info.title)
          const taskRun = queueOrBindChildSession(info.parentID, info.id)
            || ensureTaskRunForChild(rootSessionId, info.id, inferredAgent || undefined)
          if (!taskRun) return true
          const updated = updateTaskRun(taskRun.id, {
            parentSessionId: info.parentID,
            agent: inferredAgent || taskRun.agent,
            title: chooseTaskTitle(
              inferredAgent || taskRun.agent,
              !isPlaceholderTaskTitle(taskRun.title, taskRun.agent || inferredAgent) ? taskRun.title : null,
              info.title,
            ),
          })
          if (updated) emitTaskRun(win, updated)
        }
      }
      if (info?.id && !info?.parentID) {
        // Mirror SDK-owned session fields into the registry so the renderer
        // sidebar can show diff / revert chips without a separate refresh.
        const patch: Parameters<typeof updateSessionRecord>[1] = {
          updatedAt: toIsoTimestamp(info.time.updated || info.time.created),
          changeSummary: info.summary,
          revertedMessageId: info.revertedMessageId,
        }
        if (info.title) patch.title = info.title
        if (info.parentID) patch.parentSessionId = info.parentID
        const updated = updateSessionRecord(info.id, patch)
        win.webContents.send('session:updated', {
          id: info.id,
          title: info.title || null,
          parentSessionId: info.parentID,
          changeSummary: info.summary,
          revertedMessageId: info.revertedMessageId,
          composerModelId: updated?.composerModelId,
          composerReasoningVariant: updated?.composerReasoningVariant,
        })
      }
      return true
    }

    case 'session.deleted': {
      const info = normalizeSessionInfo(readRecordValue(properties, 'info'))
      if (!info?.id) return true
      removeSessionState(info.id, info.parentID)
      sessionEngine.removeSession(info.id)
      dropSessionFromDispatcherQueues(info.id)
      // Tell the renderer so the sidebar drops the row even when the
      // deletion was triggered outside of Cowork (SDK-side cleanup, another
      // client sharing the same OpenCode server, etc). Only broadcast for
      // top-level sessions — child / sub-agent deletions are internal.
      if (!info.parentID) {
        win.webContents.send('session:deleted', { id: info.id })
      }
      return true
    }

    case 'todo.updated': {
      const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      const todos = normalizeTodoItems(readRecordArray(properties, 'todos'))
      if (!rootSessionId || todos.length === 0) return true

      const taskRunId = actualSessionId && actualSessionId !== rootSessionId
        ? (getTaskRunIdForChild(actualSessionId)
          || ensureTaskRunForChild(rootSessionId, actualSessionId)?.id)
        : null

      dispatchRuntimeEvent(win, {
        type: 'todos',
        sessionId: rootSessionId,
        data: { type: 'todos', todos, taskRunId },
      })
      return true
    }

    case 'file.edited': {
      if (readRecordValue(properties, 'file')) {
        log('file', 'Edited file in session')
      }
      return true
    }

    case 'session.error':
    case 'session.failure': {
      const actualSessionId = readRuntimeSessionId(properties)
      const rootSessionId = resolveRootSession(actualSessionId)
      const error = asRecord(readRecordValue(properties, 'error'))
      const failure = asRecord(readRecordValue(properties, 'failure'))
      const errorPayload = Object.keys(error).length > 0 ? error : failure
      if (!rootSessionId) return true

      forgetSubmittedPrompt(rootSessionId)
      touchSessionRecord(rootSessionId)
      stopSessionStatusReconciliation(rootSessionId)
      const message = extractRuntimeErrorMessage(properties, errorPayload)
      log('error', `Session ${type === 'session.failure' ? 'failure' : 'error'}: ${message}`)

      const taskRunId = actualSessionId && actualSessionId !== rootSessionId
        ? (getTaskRunIdForChild(actualSessionId)
          || ensureTaskRunForChild(rootSessionId, actualSessionId)?.id)
        : null
      if (taskRunId) {
        const updated = updateTaskRun(taskRunId, { status: 'error' })
        if (updated) emitTaskRun(win, updated)
      }

      dispatchRuntimeEvent(win, {
        type: 'error',
        sessionId: rootSessionId,
        data: { type: 'error', message, taskRunId, sourceSessionId: actualSessionId },
      })
      publishNotification(win, { type: 'error', sessionId: rootSessionId, message })
      runRuntimeSideEffect('workflow session error handling', () => handleWorkflowSessionError(rootSessionId, message))
      return true
    }

    default:
      if (INTENTIONALLY_IGNORED_RUNTIME_EVENTS.has(type)) return true
      return false
  }
}
