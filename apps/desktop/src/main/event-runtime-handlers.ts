import type { BrowserWindow } from 'electron'
import { trackPermission } from './permission-tracker.ts'
import { log } from './logger.ts'
import {
  normalizeSessionInfo,
  normalizeTodoItems,
  asRecord,
  readRecordArray,
  readRecordValue,
  readString,
} from './opencode-adapter.ts'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import { dispatchRuntimeSessionEvent, dropSessionFromDispatcherQueues } from './session-event-dispatcher.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { touchSessionRecord, updateSessionRecord } from './session-registry.ts'
import { sessionEngine } from './session-engine.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from './session-status-reconciler.ts'
import {
  ensureTaskRunForChild,
  forgetSubmittedPrompt,
  getImmediateParentSession,
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
  type TaskRunMeta,
} from './event-task-state.ts'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  toIsoTimestamp,
} from './task-run-utils.ts'

type DispatchRuntimeEvent = (win: BrowserWindow, event: RuntimeSessionEvent) => void

function readFirstString(record: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = readString(readRecordValue(record, key))
    if (value) return value
  }
  return null
}

function readRuntimeSessionId(properties: Record<string, unknown> | null | undefined) {
  return readFirstString(properties, ['sessionID', 'sessionId'])
}

function extractRuntimeErrorMessage(
  properties: Record<string, unknown> | null | undefined,
  error: Record<string, unknown> | null | undefined,
) {
  const nestedError = asRecord(readRecordValue(error, 'error'))
  const data = asRecord(readRecordValue(error, 'data'))
  const nestedData = asRecord(readRecordValue(nestedError, 'data'))
  const response = asRecord(readRecordValue(error, 'response'))
  const responseBody = asRecord(readRecordValue(response, 'body'))

  const resolved = readFirstString(error, ['message'])
    || readFirstString(nestedError, ['message'])
    || readFirstString(data, ['message', 'error'])
    || readFirstString(nestedData, ['message', 'error'])
    || readFirstString(responseBody, ['message', 'error'])
    || readFirstString(properties, ['message'])
    || readFirstString(error, ['name', 'type', 'code'])
    || readFirstString(nestedError, ['name', 'type', 'status', 'code'])
  if (resolved) return resolved

  // Fall back to stringifying the payload so a runtime-surfaced error with
  // an unfamiliar shape still reaches the user with actionable detail.
  // "An error occurred" on its own is not useful when debugging which of
  // 300+ OpenRouter models failed.
  try {
    const payload = error && Object.keys(error).length > 0
      ? error
      : properties && Object.keys(properties).length > 0
        ? properties
        : null
    if (payload) {
      const serialized = JSON.stringify(payload)
      if (serialized && serialized !== '{}') return serialized
    }
  } catch {
    // ignore serialization errors
  }
  return 'An error occurred'
}

function emitTaskRun(win: BrowserWindow, taskRun: TaskRunMeta) {
  // Thread the immediate parent session so the renderer can reconstruct
  // a two-level tree (root task → sub-sub-agent spawned by one of the
  // root's tasks). The child session's lineage was registered in the
  // `session.created` handler via `registerSession(sessionId, parentID)`.
  const parentSessionId = taskRun.childSessionId
    ? getImmediateParentSession(taskRun.childSessionId)
    : taskRun.parentSessionId
  dispatchRuntimeSessionEvent(win, {
    type: 'task_run',
    sessionId: taskRun.rootSessionId,
    data: {
      type: 'task_run',
      id: taskRun.id,
      title: taskRun.title,
      agent: taskRun.agent,
      status: taskRun.status,
      sourceSessionId: taskRun.childSessionId,
      parentSessionId,
    },
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

export function removeParentSession(sessionId: string) {
  stopSessionStatusReconciliation(sessionId)
  removeParentSessionState(sessionId)
  sessionEngine.removeSession(sessionId)
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
    case 'permission.updated': {
      const permissionType = readString(readRecordValue(properties, 'type')) || 'permission'
      const permissionId = readString(readRecordValue(properties, 'id'))
      const permissionSessionId = readString(readRecordValue(properties, 'sessionID'))
      log('permission', `Updated ${permissionType} ${shortSessionId(permissionSessionId)} id=${permissionId}`)
      if (permissionId && permissionSessionId) {
        trackPermission(permissionId, permissionSessionId)
      }

      const rootSessionId = resolveRootSession(permissionSessionId)
      if (!rootSessionId) return true

      const taskRunId = permissionSessionId && permissionSessionId !== rootSessionId
        ? (getTaskRunIdForChild(permissionSessionId)
          || ensureTaskRunForChild(rootSessionId, permissionSessionId)?.id)
        : null
      const taskRun = getTaskRun(taskRunId)

      dispatchRuntimeEvent(win, {
        type: 'approval',
        sessionId: rootSessionId,
        data: {
          type: 'approval',
          id: permissionId || undefined,
          taskRunId,
          tool: readString(readRecordValue(properties, 'title')) || permissionType,
          input: asRecord(readRecordValue(properties, 'metadata')),
          description: taskRun
            ? `${taskRun.title}: ${readString(readRecordValue(properties, 'title')) || `Permission requested for ${permissionType}`}`
            : (readString(readRecordValue(properties, 'title')) || `Permission requested for ${permissionType}`),
          sourceSessionId: permissionSessionId,
        },
      })
      return true
    }

    case 'question.asked': {
      const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      const questionId = readString(readRecordValue(properties, 'id'))
      if (!rootSessionId || !questionId) return true

      stopSessionStatusReconciliation(rootSessionId)
      dispatchRuntimeEvent(win, {
        type: 'question_asked',
        sessionId: rootSessionId,
        data: {
          type: 'question_asked',
          id: questionId,
          questions: readRecordArray(properties, 'questions').map((entry) => {
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
          }),
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

    case 'session.status': {
      const status = asRecord(readRecordValue(properties, 'status'))
      const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      if (!rootSessionId || !actualSessionId) return true

      if (readString(readRecordValue(status, 'type')) === 'busy') {
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
        } else {
          const taskRun = ensureTaskRunForChild(rootSessionId, actualSessionId)
          if (taskRun) {
            const updated = updateTaskRun(taskRun.id, { status: 'complete' })
            if (updated) emitTaskRun(win, updated)
          }
        }
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
          const taskRun = queueOrBindChildSession(info.parentID, info.id)
          if (taskRun) {
            const inferredAgent = extractAgentName(info.title) || taskRun.agent
            const updated = updateTaskRun(taskRun.id, {
              agent: inferredAgent,
              title: chooseTaskTitle(
                inferredAgent,
                !isPlaceholderTaskTitle(taskRun.title, taskRun.agent || inferredAgent) ? taskRun.title : null,
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
          const taskRun = ensureTaskRunForChild(rootSessionId, info.id, inferredAgent || undefined)
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
        updateSessionRecord(info.id, patch)
        win.webContents.send('session:updated', {
          id: info.id,
          title: info.title || null,
          parentSessionId: info.parentID,
          changeSummary: info.summary,
          revertedMessageId: info.revertedMessageId,
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

    case 'session.error': {
      const actualSessionId = readRuntimeSessionId(properties)
      const rootSessionId = resolveRootSession(actualSessionId)
      const error = asRecord(readRecordValue(properties, 'error'))
      if (!rootSessionId) return true

      forgetSubmittedPrompt(rootSessionId)
      touchSessionRecord(rootSessionId)
      stopSessionStatusReconciliation(rootSessionId)
      const message = extractRuntimeErrorMessage(properties, error)
      log('error', `Session error: ${message}`)

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
      return true
    }

    default:
      return false
  }
}
