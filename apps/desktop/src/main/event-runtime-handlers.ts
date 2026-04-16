import type { BrowserWindow } from 'electron'
import { trackPermission } from './permission-tracker.ts'
import { log } from './logger.ts'
import {
  normalizeSessionInfo,
  normalizeTodoItems,
  readRecord,
  readRecordArray,
  readRecordValue,
  readStringValue,
} from './opencode-adapter.ts'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { touchSessionRecord, updateSessionRecord } from './session-registry.ts'
import { sessionEngine } from './session-engine.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from './session-status-reconciler.ts'
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
  type TaskRunMeta,
} from './event-task-state.ts'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  toIsoTimestamp,
} from './task-run-utils.ts'

type DispatchRuntimeEvent = (win: BrowserWindow, event: RuntimeSessionEvent) => void

function emitTaskRun(win: BrowserWindow, taskRun: TaskRunMeta) {
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
      const permissionType = readStringValue(readRecordValue(properties, 'type')) || 'permission'
      const permissionId = readStringValue(readRecordValue(properties, 'id'))
      const permissionSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
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
          tool: readStringValue(readRecordValue(properties, 'title')) || permissionType,
          input: readRecord(readRecordValue(properties, 'metadata')),
          description: taskRun
            ? `${taskRun.title}: ${readStringValue(readRecordValue(properties, 'title')) || `Permission requested for ${permissionType}`}`
            : (readStringValue(readRecordValue(properties, 'title')) || `Permission requested for ${permissionType}`),
          sourceSessionId: permissionSessionId,
        },
      })
      return true
    }

    case 'question.asked': {
      const actualSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      const questionId = readStringValue(readRecordValue(properties, 'id'))
      if (!rootSessionId || !questionId) return true

      stopSessionStatusReconciliation(rootSessionId)
      dispatchRuntimeEvent(win, {
        type: 'question_asked',
        sessionId: rootSessionId,
        data: {
          type: 'question_asked',
          id: questionId,
          questions: readRecordArray(properties, 'questions').map((entry) => {
            const record = readRecord(entry)
            return {
              header: readStringValue(readRecordValue(record, 'header')) || '',
              question: readStringValue(readRecordValue(record, 'question')) || '',
              options: readRecordArray(record, 'options').map((option) => ({
                label: readStringValue(readRecordValue(option, 'label')) || '',
                description: readStringValue(readRecordValue(option, 'description')) || '',
              })),
              multiple: Boolean(record.multiple),
              custom: readRecordValue(record, 'custom') !== false,
            }
          }),
          tool: readRecordValue(properties, 'tool')
            ? {
                messageId: readStringValue(readRecordValue(readRecordValue(properties, 'tool'), 'messageID')) || '',
                callId: readStringValue(readRecordValue(readRecordValue(properties, 'tool'), 'callID')) || '',
              }
            : undefined,
          sourceSessionId: actualSessionId,
        },
      })
      return true
    }

    case 'question.replied':
    case 'question.rejected': {
      const actualSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      const requestId = readStringValue(readRecordValue(properties, 'requestID'))
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
      const status = readRecord(readRecordValue(properties, 'status'))
      const actualSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      if (!rootSessionId || !actualSessionId) return true

      if (readStringValue(readRecordValue(status, 'type')) === 'busy') {
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

      if (readStringValue(readRecordValue(status, 'type')) === 'idle') {
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
      const actualSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
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
          const taskRun = queueOrBindChildSession(rootSessionId, info.id)
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
          if (taskRun) {
            const updated = updateTaskRun(taskRun.id, {
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
      }
      if (info?.id && info?.title && !info?.parentID) {
        updateSessionRecord(info.id, {
          title: info.title,
          updatedAt: toIsoTimestamp(info.time.updated || info.time.created),
        })
        win.webContents.send('session:updated', {
          id: info.id,
          title: info.title,
        })
      }
      return true
    }

    case 'session.deleted': {
      const info = normalizeSessionInfo(readRecordValue(properties, 'info'))
      if (!info?.id) return true
      removeSessionState(info.id, info.parentID)
      sessionEngine.removeSession(info.id)
      return true
    }

    case 'todo.updated': {
      const actualSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
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
      const actualSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
      const rootSessionId = resolveRootSession(actualSessionId)
      const error = readRecord(readRecordValue(properties, 'error'))
      if (!rootSessionId) return true

      forgetSubmittedPrompt(rootSessionId)
      touchSessionRecord(rootSessionId)
      stopSessionStatusReconciliation(rootSessionId)
      const message = readStringValue(readRecordValue(error, 'message')) || 'An error occurred'
      log('error', `Session error: ${readStringValue(readRecordValue(error, 'message')) || readStringValue(readRecordValue(error, 'type')) || 'Unknown session error'}`)

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
