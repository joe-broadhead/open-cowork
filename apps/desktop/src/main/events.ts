import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { trackPermission } from './ipc-handlers'
import { log } from './logger'
import {
  normalizeMcpStatusEntries,
  normalizeMessagePart,
  normalizeRuntimeEventEnvelope,
  normalizeSessionInfo,
  normalizeTodoItems,
  readRecord,
  readRecordArray,
  readRecordValue,
  readStringValue,
} from './opencode-adapter.ts'
import { resolveDisplayCost } from './pricing'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'
import { getEffectiveSettings, loadSettings } from './settings'
import { touchSessionRecord, updateSessionRecord } from './session-registry'
import { shortSessionId } from './log-sanitizer'
import { sessionEngine } from './session-engine'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from './session-status-reconciler.ts'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  normalizeAgentName,
  toIsoTimestamp,
} from './task-run-utils'

type TaskStatus = 'queued' | 'running' | 'complete' | 'error'

type TaskRunMeta = {
  id: string
  rootSessionId: string
  title: string
  agent: string | null
  childSessionId: string | null
  status: TaskStatus
}

const parentSessions = new Set<string>()
const sessionLineage = new Map<string, string>()
const taskRuns = new Map<string, TaskRunMeta>()
const childSessionToTaskRunId = new Map<string, string>()
const pendingTaskRunsByRoot = new Map<string, string[]>()
const queuedChildSessionsByRoot = new Map<string, string[]>()
const pendingSubmittedPromptBySession = new Map<string, string>()
const MAX_PENDING_TEXT_EVENTS = 500

type PendingTextEvent = {
  mode: 'append' | 'replace'
  rootSessionId: string
  actualSessionId: string | null
  taskRunId: string | null
  messageId: string
  partId: string | null
  content: string
}

function registerSession(sessionId?: string | null, parentId?: string | null) {
  if (!sessionId) return
  if (!parentId) {
    if (!sessionLineage.has(sessionId)) {
      sessionLineage.set(sessionId, sessionId)
    }
    return
  }
  sessionLineage.set(sessionId, parentId)
}

function resolveRootSession(sessionId?: string | null) {
  if (!sessionId) return sessionId ?? undefined

  let current = sessionId
  const seen = new Set<string>()

  while (true) {
    const next = sessionLineage.get(current)
    if (!next) return current
    if (next === current) return current
    if (seen.has(current)) return current
    seen.add(current)
    current = next
  }
}

function pushQueue(map: Map<string, string[]>, rootSessionId: string, value: string) {
  const current = map.get(rootSessionId) || []
  if (!current.includes(value)) {
    current.push(value)
    map.set(rootSessionId, current)
  }
}

function shiftQueue(map: Map<string, string[]>, rootSessionId: string) {
  const current = map.get(rootSessionId) || []
  const value = current.shift()
  if (current.length > 0) map.set(rootSessionId, current)
  else map.delete(rootSessionId)
  return value
}

function findFallbackTaskRun(rootSessionId: string, agent?: string | null) {
  const candidates = Array.from(taskRuns.values()).filter((taskRun) => {
    return taskRun.rootSessionId === rootSessionId
      && taskRun.id.startsWith('child:')
      && (taskRun.status === 'queued' || taskRun.status === 'running')
      && (!agent || taskRun.agent === agent || !taskRun.agent)
  })

  return candidates.length === 1 ? candidates[0] : null
}

function bindTaskRunToChild(taskRunId: string, childSessionId: string) {
  const existingTaskRunId = childSessionToTaskRunId.get(childSessionId)
  if (existingTaskRunId && existingTaskRunId !== taskRunId) {
    const existingTaskRun = taskRuns.get(existingTaskRunId)
    const incomingTaskRun = taskRuns.get(taskRunId)

    if (existingTaskRun && incomingTaskRun) {
      const mergedAgent = incomingTaskRun.agent || existingTaskRun.agent
      const mergedTaskRun: TaskRunMeta = {
        ...existingTaskRun,
        rootSessionId: incomingTaskRun.rootSessionId || existingTaskRun.rootSessionId,
        title: chooseTaskTitle(
          mergedAgent,
          !isPlaceholderTaskTitle(existingTaskRun.title, existingTaskRun.agent) ? existingTaskRun.title : null,
          incomingTaskRun.title,
        ),
        agent: mergedAgent,
        childSessionId,
        status: incomingTaskRun.status === 'error'
          ? 'error'
          : incomingTaskRun.status === 'complete'
            ? 'complete'
            : incomingTaskRun.status === 'running'
              ? 'running'
              : existingTaskRun.status,
      }

      taskRuns.set(existingTaskRunId, mergedTaskRun)
      taskRuns.delete(taskRunId)
      childSessionToTaskRunId.set(childSessionId, existingTaskRunId)
      return mergedTaskRun
    }
  }

  const taskRun = taskRuns.get(taskRunId)
  if (!taskRun) return null
  taskRun.childSessionId = childSessionId
  childSessionToTaskRunId.set(childSessionId, taskRunId)
  return taskRun
}

function registerTaskRun(taskRun: TaskRunMeta) {
  taskRuns.set(taskRun.id, taskRun)

  const queuedChild = shiftQueue(queuedChildSessionsByRoot, taskRun.rootSessionId)
  if (queuedChild) {
    bindTaskRunToChild(taskRun.id, queuedChild)
    return taskRuns.get(taskRun.id) || taskRun
  }

  if (!taskRun.childSessionId) {
    pushQueue(pendingTaskRunsByRoot, taskRun.rootSessionId, taskRun.id)
  }

  return taskRuns.get(taskRun.id) || taskRun
}

function queueOrBindChildSession(rootSessionId: string, childSessionId: string) {
  const pendingTaskRunId = shiftQueue(pendingTaskRunsByRoot, rootSessionId)
  if (pendingTaskRunId) {
    return bindTaskRunToChild(pendingTaskRunId, childSessionId)
  }

  pushQueue(queuedChildSessionsByRoot, rootSessionId, childSessionId)
  return null
}

function ensureTaskRunForChild(rootSessionId: string, childSessionId: string, agent?: string | null) {
  const existingTaskRunId = childSessionToTaskRunId.get(childSessionId)
  if (existingTaskRunId) return taskRuns.get(existingTaskRunId) || null

  const fallback: TaskRunMeta = {
    id: `child:${childSessionId}`,
    rootSessionId,
    title: chooseTaskTitle(agent),
    agent: agent || null,
    childSessionId,
    status: 'queued',
  }
  taskRuns.set(fallback.id, fallback)
  childSessionToTaskRunId.set(childSessionId, fallback.id)
  return fallback
}

function updateTaskRun(taskRunId: string, patch: Partial<TaskRunMeta>) {
  const existing = taskRuns.get(taskRunId)
  if (!existing) return null
  const next = { ...existing, ...patch }
  taskRuns.set(taskRunId, next)
  if (next.childSessionId) {
    childSessionToTaskRunId.set(next.childSessionId, next.id)
  }
  return next
}

function removeTaskSession(sessionId: string) {
  const taskRunId = childSessionToTaskRunId.get(sessionId)
  if (taskRunId) {
    childSessionToTaskRunId.delete(sessionId)
    const taskRun = taskRuns.get(taskRunId)
    if (taskRun) {
      taskRuns.set(taskRunId, { ...taskRun, childSessionId: null })
    }
  }
}

function sweepStaleEntries(messageRoles: Map<string, 'user' | 'assistant'>) {
  for (const [childSessionId, taskRunId] of childSessionToTaskRunId.entries()) {
    const taskRun = taskRuns.get(taskRunId)
    if (!taskRun || taskRun.childSessionId !== childSessionId) {
      childSessionToTaskRunId.delete(childSessionId)
    }
  }

  for (const [rootSessionId] of pendingTaskRunsByRoot.entries()) {
    if (!parentSessions.has(rootSessionId)) {
      pendingTaskRunsByRoot.delete(rootSessionId)
    }
  }

  for (const [rootSessionId] of queuedChildSessionsByRoot.entries()) {
    if (!parentSessions.has(rootSessionId)) {
      queuedChildSessionsByRoot.delete(rootSessionId)
    }
  }

  while (messageRoles.size > 2000) {
    const oldest = messageRoles.keys().next().value
    if (!oldest) break
    messageRoles.delete(oldest)
  }
}

function pushPendingTextEvent(
  pendingTextEvents: Map<string, PendingTextEvent[]>,
  messageId: string,
  event: PendingTextEvent,
) {
  const current = pendingTextEvents.get(messageId) || []
  current.push(event)
  pendingTextEvents.set(messageId, current)
  while (pendingTextEvents.size > MAX_PENDING_TEXT_EVENTS) {
    const oldest = pendingTextEvents.keys().next().value
    if (!oldest) break
    pendingTextEvents.delete(oldest)
  }
}

function dispatchTextPatch(
  win: BrowserWindow,
  input: {
    rootSessionId: string
    actualSessionId: string | null
    taskRunId: string | null
    messageId: string | null
    partId: string | null
    content: string
    mode: 'append' | 'replace'
  },
) {
  dispatchRuntimeEvent(win, {
    type: 'text',
    sessionId: input.rootSessionId,
    data: {
      type: 'text',
      mode: input.mode,
      content: input.content,
      taskRunId: input.taskRunId,
      sourceSessionId: input.actualSessionId,
      messageId: input.messageId,
      partId: input.partId,
    },
  })
}

function flushPendingTextEvents(
  win: BrowserWindow,
  pendingTextEvents: Map<string, PendingTextEvent[]>,
  messageId: string,
  role: 'user' | 'assistant',
) {
  const pending = pendingTextEvents.get(messageId)
  if (!pending || pending.length === 0) return
  pendingTextEvents.delete(messageId)
  if (role === 'user') return
  for (const event of pending) {
    dispatchTextPatch(win, {
      rootSessionId: event.rootSessionId,
      actualSessionId: event.actualSessionId,
      taskRunId: event.taskRunId,
      messageId: event.messageId,
      partId: event.partId,
      content: event.content,
      mode: event.mode,
    })
  }
}

function consumePendingPromptEcho(sessionId: string, content: string) {
  const pending = pendingSubmittedPromptBySession.get(sessionId)
  if (!pending || !content) return content
  if (content === pending) {
    pendingSubmittedPromptBySession.delete(sessionId)
    return ''
  }
  if (pending.startsWith(content)) {
    pendingSubmittedPromptBySession.set(sessionId, pending.slice(content.length))
    return ''
  }
  if (content.startsWith(pending)) {
    pendingSubmittedPromptBySession.delete(sessionId)
    return content.slice(pending.length)
  }
  return content
}

function emitTaskRun(win: BrowserWindow, taskRun: TaskRunMeta) {
  dispatchRuntimeEvent(win, {
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

function dispatchRuntimeEvent(win: BrowserWindow, event: RuntimeSessionEvent) {
  dispatchRuntimeSessionEvent(win, event)
}

function dispatchSyntheticIdle(win: BrowserWindow, sessionId: string) {
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

export function trackParentSession(sessionId: string) {
  parentSessions.add(sessionId)
  sessionLineage.set(sessionId, sessionId)
}

export function rememberSubmittedPrompt(sessionId: string, text: string) {
  if (!sessionId || !text) return
  pendingSubmittedPromptBySession.set(sessionId, text)
}

export function removeParentSession(sessionId: string) {
  parentSessions.delete(sessionId)
  sessionLineage.delete(sessionId)
  stopSessionStatusReconciliation(sessionId)
  pendingTaskRunsByRoot.delete(sessionId)
  queuedChildSessionsByRoot.delete(sessionId)
  pendingSubmittedPromptBySession.delete(sessionId)
  for (const [taskRunId, taskRun] of taskRuns.entries()) {
    if (taskRun.rootSessionId === sessionId) {
      taskRuns.delete(taskRunId)
      if (taskRun.childSessionId) {
        childSessionToTaskRunId.delete(taskRun.childSessionId)
      }
    }
  }
  sessionEngine.removeSession(sessionId)
}

export async function subscribeToEvents(
  client: OpencodeClient,
  getMainWindow: () => BrowserWindow | null,
) {
  log('events', 'Subscribing to SSE event stream')
  const result = await client.event.subscribe()
  const stream = result.stream
  log('events', 'SSE stream connected')

  const cachedModelId = getEffectiveSettings().effectiveModel || loadSettings().selectedModelId || ''
  const messageRoles = new Map<string, 'user' | 'assistant'>()
  const pendingTextEventsByMessageId = new Map<string, PendingTextEvent[]>()
  const sweepInterval = setInterval(() => {
    sweepStaleEntries(messageRoles)
  }, 5 * 60 * 1000)

  try {
    for await (const event of stream) {
      const win = getMainWindow()
      if (!win) continue

      const data = normalizeRuntimeEventEnvelope(event)
      if (!data) continue

      try {
        switch (data.type) {
      case 'message.updated': {
        const info = normalizeSessionInfo(readRecordValue(data.properties, 'info'))
        if (info?.id && (info.role === 'user' || info.role === 'assistant')) {
          messageRoles.set(info.id, info.role)
          flushPendingTextEvents(win, pendingTextEventsByMessageId, info.id, info.role)
        }
        if (info?.sessionID) {
          registerSession(info.sessionID)
        }
        break
      }

      case 'message.part.delta': {
        const props = data.properties
        const messageId = readStringValue(readRecordValue(props, 'messageID'))
          || readStringValue(readRecordValue(props, 'messageId'))
          || null
        const actualSessionId = readStringValue(readRecordValue(props, 'sessionID'))
          || readStringValue(readRecordValue(props, 'sessionId'))
          || null
        const sessionId = resolveRootSession(actualSessionId)
        const rawDelta = readStringValue(readRecordValue(props, 'delta'))
        const delta = !messageId && rawDelta && sessionId
          ? consumePendingPromptEcho(sessionId, rawDelta)
          : rawDelta
        if (!delta || !sessionId) break

        const taskRunId = actualSessionId && actualSessionId !== sessionId
          ? (childSessionToTaskRunId.get(actualSessionId)
            || ensureTaskRunForChild(sessionId, actualSessionId)?.id
            || null)
          : null

        if (messageId) {
          const role = messageRoles.get(messageId)
          if (role === 'user') break
          if (!role) {
            pushPendingTextEvent(pendingTextEventsByMessageId, messageId, {
              mode: 'append',
              rootSessionId: sessionId,
              actualSessionId,
              taskRunId,
              messageId,
              partId: readStringValue(readRecordValue(props, 'partID')) || readStringValue(readRecordValue(props, 'partId')) || null,
              content: delta,
            })
            break
          }
        }

        dispatchTextPatch(win, {
          rootSessionId: sessionId,
          actualSessionId,
          taskRunId,
          messageId,
          partId: readStringValue(readRecordValue(props, 'partID')) || readStringValue(readRecordValue(props, 'partId')) || null,
          content: delta,
          mode: 'append',
        })
        break
      }

      case 'message.part.updated': {
        const props = data.properties
        const part = normalizeMessagePart(readRecordValue(props, 'part'))
        if (!part) break

        const messageId = readStringValue(readRecordValue(props, 'messageID'))
          || readStringValue(readRecordValue(props, 'messageId'))
          || null
        const partId = readStringValue(readRecordValue(props, 'partID'))
          || readStringValue(readRecordValue(props, 'partId'))
          || part.id
          || null
        const actualSessionId = readStringValue(readRecordValue(props, 'sessionID'))
          || readStringValue(readRecordValue(props, 'sessionId'))
          || null
        const messageRole = messageId ? messageRoles.get(messageId) : undefined
        if (messageRole === 'user') break

        const rootSessionId = resolveRootSession(actualSessionId)
        if (!rootSessionId) break

        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          const content = !messageId
            ? consumePendingPromptEcho(rootSessionId, part.text)
            : part.text
          if (!content) break
          const taskRunId = actualSessionId && actualSessionId !== rootSessionId
            ? (childSessionToTaskRunId.get(actualSessionId)
              || ensureTaskRunForChild(rootSessionId, actualSessionId)?.id
              || null)
            : null

          if (messageId && !messageRole) {
            pushPendingTextEvent(pendingTextEventsByMessageId, messageId, {
              mode: 'replace',
              rootSessionId,
              actualSessionId,
              taskRunId,
              messageId,
              partId,
              content,
            })
            break
          }

          dispatchTextPatch(win, {
            rootSessionId,
            actualSessionId,
            taskRunId,
            messageId,
            partId,
            content,
            mode: 'replace',
          })
          break
        }

        if (part.type === 'step-finish' && (part.cost !== undefined || part.tokens)) {
          const tokens = part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          const cost = resolveDisplayCost(cachedModelId, part.cost ?? undefined, tokens)
          const taskRunId = actualSessionId && actualSessionId !== rootSessionId
            ? (childSessionToTaskRunId.get(actualSessionId)
              || ensureTaskRunForChild(rootSessionId, actualSessionId)?.id)
            : null
          const costEventId = [
            actualSessionId || rootSessionId,
            messageId || 'message',
            part.id || 'step-finish',
          ].join(':')
          dispatchRuntimeEvent(win, {
            type: 'cost',
            sessionId: rootSessionId,
            data: {
              type: 'cost',
              id: costEventId,
              cost,
              tokens: part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              taskRunId,
              sourceSessionId: actualSessionId,
            },
          })
          break
        }

        if (part.type === 'agent') {
          const agentName = normalizeAgentName(part.agent || part.name || '')
            || part.agent
            || part.name
            || ''
          if (!agentName) break

          if (actualSessionId && actualSessionId !== rootSessionId) {
            const taskRun = ensureTaskRunForChild(rootSessionId, actualSessionId, agentName)
            if (taskRun) {
              const updated = updateTaskRun(taskRun.id, {
                agent: agentName,
                title: chooseTaskTitle(
                  agentName,
                  !isPlaceholderTaskTitle(taskRun.title, taskRun.agent || agentName) ? taskRun.title : null,
                ),
                status: taskRun.status === 'queued' ? 'running' : taskRun.status,
              })
              if (updated) emitTaskRun(win, updated)
            }
          } else {
            dispatchRuntimeEvent(win, {
              type: 'agent',
              sessionId: rootSessionId,
              data: { type: 'agent', name: agentName },
            })
          }
        }

        if (part.type === 'subtask') {
          const agentName = normalizeAgentName(part.agent)
            || extractAgentName(
              part.description,
              part.title,
              part.prompt,
              part.raw,
            )
            || null
          const fallback = findFallbackTaskRun(rootSessionId, agentName)
          const taskRunId = fallback?.id || part.id
          const taskRun = registerTaskRun({
            id: taskRunId || `pending:${crypto.randomUUID()}`,
            rootSessionId,
            title: chooseTaskTitle(
              agentName,
              part.description,
              part.title,
              part.prompt,
              part.raw,
            ),
            agent: agentName,
            childSessionId: fallback?.childSessionId || null,
            status: fallback?.status || 'queued',
          })
          emitTaskRun(win, taskRun)
          break
        }

        if (part.type === 'compaction') {
          const taskRunId = actualSessionId && actualSessionId !== rootSessionId
            ? (childSessionToTaskRunId.get(actualSessionId)
              || ensureTaskRunForChild(rootSessionId, actualSessionId)?.id)
            : null
          dispatchRuntimeEvent(win, {
            type: 'compaction',
            sessionId: rootSessionId,
            data: {
              type: 'compaction',
              id: part.id || undefined,
              status: 'compacting',
              auto: !!part.auto,
              overflow: !!part.overflow,
              taskRunId,
              sourceSessionId: actualSessionId,
            },
          })
          break
        }

        if (part.type === 'reasoning' || part.type === 'step-start'
          || part.type === 'snapshot' || part.type === 'agent'
          || part.type === 'retry' || part.type === 'patch' || part.type === 'text') {
          break
        }

        if (part.type === 'tool') {
          const state = part.state
          const statusValue = state.status || ''
          const isComplete = statusValue === 'completed' || statusValue === 'complete' || state.output !== undefined
          const isError = statusValue === 'error'
          const status = isComplete ? 'complete' : isError ? 'error' : 'running'
          const title = part.title || state.title || ''
          const metadata = Object.keys(part.metadata).length > 0 ? part.metadata : state.metadata

          if (part.tool === 'question') break

          if (part.tool === 'task' && actualSessionId === rootSessionId) {
            break
          }

          let taskRunId: string | null = null
          if (actualSessionId && actualSessionId !== rootSessionId) {
            const metadataAgent = typeof metadata.agent === 'string' ? metadata.agent : null
            const inferredAgent = normalizeAgentName(metadataAgent)
              || extractAgentName(
                title,
                state.title,
                state.raw,
                typeof state.input?.prompt === 'string' ? state.input.prompt : null,
                typeof state.args?.prompt === 'string' ? state.args.prompt : null,
              )
              || null
            const taskRun = ensureTaskRunForChild(rootSessionId, actualSessionId, inferredAgent)
            taskRunId = taskRun?.id || null
            if (taskRun) {
              const updated = updateTaskRun(taskRun.id, {
                agent: inferredAgent || taskRun.agent,
                status: status === 'error' ? 'error' : status === 'complete' ? taskRun.status : 'running',
                title: chooseTaskTitle(
                  inferredAgent || taskRun.agent,
                  !isPlaceholderTaskTitle(taskRun.title, taskRun.agent || inferredAgent) ? taskRun.title : null,
                  title,
                  state.title,
                  state.raw,
                  typeof state.input?.prompt === 'string' ? state.input.prompt : null,
                  typeof state.args?.prompt === 'string' ? state.args.prompt : null,
                ),
              })
              if (updated) emitTaskRun(win, updated)
            }
          }

          const displayName = part.tool === 'task' && title ? title : part.tool
          let toolInput = Object.keys(state.input).length > 0 ? state.input : state.args
          if (part.tool === 'task' && state.raw && !Object.keys(toolInput).length) {
            toolInput = { prompt: state.raw }
          }
          const attachments = state.attachments.length > 0 ? state.attachments : part.attachments

          dispatchRuntimeEvent(win, {
            type: 'tool_call',
            sessionId: rootSessionId,
            data: {
              type: 'tool_call',
              id: part.callId || part.id || `${rootSessionId}:tool:${Date.now()}`,
              name: displayName,
              input: toolInput,
              status,
              output: state.output ?? state.result,
              agent: normalizeAgentName(typeof metadata.agent === 'string' ? metadata.agent : null)
                || extractAgentName(title, state.title, state.raw)
                || null,
              attachments: attachments.length > 0 ? attachments : undefined,
              taskRunId,
              sourceSessionId: actualSessionId,
            },
          })
        }
        break
      }

      case 'permission.updated': {
        const perm = data.properties
        if (!perm) break
        const permissionType = readStringValue(readRecordValue(perm, 'type')) || 'permission'
        const permissionId = readStringValue(readRecordValue(perm, 'id'))
        const permissionSessionId = readStringValue(readRecordValue(perm, 'sessionID'))
        log('permission', `Updated ${permissionType} ${shortSessionId(permissionSessionId)} id=${permissionId}`)
        if (permissionId && permissionSessionId) {
          trackPermission(permissionId, permissionSessionId)
        }

        const rootSessionId = resolveRootSession(permissionSessionId)
        if (!rootSessionId) break

        const taskRunId = permissionSessionId && permissionSessionId !== rootSessionId
          ? (childSessionToTaskRunId.get(permissionSessionId || '')
            || ensureTaskRunForChild(rootSessionId, permissionSessionId)?.id)
          : null
        const taskRun = taskRunId ? taskRuns.get(taskRunId) : null

        dispatchRuntimeEvent(win, {
          type: 'approval',
          sessionId: rootSessionId,
          data: {
            type: 'approval',
            id: permissionId || undefined,
            taskRunId,
            tool: readStringValue(readRecordValue(perm, 'title')) || permissionType,
            input: readRecord(readRecordValue(perm, 'metadata')),
            description: taskRun
              ? `${taskRun.title}: ${readStringValue(readRecordValue(perm, 'title')) || `Permission requested for ${permissionType}`}`
              : (readStringValue(readRecordValue(perm, 'title')) || `Permission requested for ${permissionType}`),
            sourceSessionId: permissionSessionId,
          },
        })
        break
      }

      case 'question.asked': {
        const question = data.properties
        const actualSessionId = readStringValue(readRecordValue(question, 'sessionID'))
        const rootSessionId = resolveRootSession(actualSessionId)
        const questionId = readStringValue(readRecordValue(question, 'id'))
        if (!rootSessionId || !questionId) break

        stopSessionStatusReconciliation(rootSessionId)
        dispatchRuntimeEvent(win, {
          type: 'question_asked',
          sessionId: rootSessionId,
          data: {
            type: 'question_asked',
            id: questionId,
            questions: readRecordArray(question, 'questions')
              .map((entry) => {
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
            tool: readRecordValue(question, 'tool')
              ? {
                  messageId: readStringValue(readRecordValue(readRecordValue(question, 'tool'), 'messageID')) || '',
                  callId: readStringValue(readRecordValue(readRecordValue(question, 'tool'), 'callID')) || '',
                }
              : undefined,
            sourceSessionId: actualSessionId,
          },
        })
        break
      }

      case 'question.replied':
      case 'question.rejected': {
        const question = data.properties
        const actualSessionId = readStringValue(readRecordValue(question, 'sessionID'))
        const rootSessionId = resolveRootSession(actualSessionId)
        const requestId = readStringValue(readRecordValue(question, 'requestID'))
        if (!rootSessionId || !requestId) break

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
            dispatchSyntheticIdle(reconciledWin, reconciledSessionId)
          },
        })
        break
      }

      case 'session.status': {
        const status = readRecord(readRecordValue(data.properties, 'status'))
        const actualSessionId = readStringValue(readRecordValue(data.properties, 'sessionID'))
        const rootSessionId = resolveRootSession(actualSessionId)
        if (!rootSessionId || !actualSessionId) break

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
            pendingSubmittedPromptBySession.delete(rootSessionId)
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
            if (parentSessions.has(rootSessionId)) {
              parentSessions.delete(rootSessionId)
            }
          } else {
            const taskRun = ensureTaskRunForChild(rootSessionId, actualSessionId)
            if (taskRun) {
              const updated = updateTaskRun(taskRun.id, { status: 'complete' })
              if (updated) emitTaskRun(win, updated)
            }
          }
        }
        break
      }

      case 'session.compacted': {
        const actualSessionId = readStringValue(readRecordValue(data.properties, 'sessionID'))
        const rootSessionId = resolveRootSession(actualSessionId)
        if (!rootSessionId) break
        const taskRunId = actualSessionId && actualSessionId !== rootSessionId
          ? (childSessionToTaskRunId.get(actualSessionId)
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
        break
      }

      case 'session.created': {
        const info = normalizeSessionInfo(readRecordValue(data.properties, 'info'))
        if (!info?.id) break
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
        break
      }

      case 'session.updated': {
        const info = normalizeSessionInfo(readRecordValue(data.properties, 'info'))
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
        break
      }

      case 'session.deleted': {
        const info = normalizeSessionInfo(readRecordValue(data.properties, 'info'))
        if (!info?.id) break
        removeTaskSession(info.id)
        sessionEngine.removeSession(info.id)
        sessionLineage.delete(info.id)
        pendingSubmittedPromptBySession.delete(info.id)
        if (!info.parentID) {
          parentSessions.delete(info.id)
          pendingTaskRunsByRoot.delete(info.id)
          queuedChildSessionsByRoot.delete(info.id)
        }
        break
      }

      case 'todo.updated': {
        const props = data.properties
        const actualSessionId = readStringValue(readRecordValue(props, 'sessionID'))
        const rootSessionId = resolveRootSession(actualSessionId)
        const todos = normalizeTodoItems(readRecordArray(props, 'todos'))
        if (!rootSessionId || todos.length === 0) break

        const taskRunId = actualSessionId && actualSessionId !== rootSessionId
          ? (childSessionToTaskRunId.get(actualSessionId)
            || ensureTaskRunForChild(rootSessionId, actualSessionId)?.id)
          : null

        dispatchRuntimeEvent(win, {
          type: 'todos',
          sessionId: rootSessionId,
          data: { type: 'todos', todos, taskRunId },
        })
        break
      }

      case 'file.edited': {
        if (readRecordValue(data.properties, 'file')) {
          log('file', 'Edited file in session')
        }
        break
      }

      case 'session.error': {
        const actualSessionId = readStringValue(readRecordValue(data.properties, 'sessionID'))
        const rootSessionId = resolveRootSession(actualSessionId)
        const error = readRecord(readRecordValue(data.properties, 'error'))
        if (!rootSessionId) break

        pendingSubmittedPromptBySession.delete(rootSessionId)
        touchSessionRecord(rootSessionId)
        stopSessionStatusReconciliation(rootSessionId)
        const message = readStringValue(readRecordValue(error, 'message')) || 'An error occurred'
        log('error', `Session error: ${readStringValue(readRecordValue(error, 'message')) || readStringValue(readRecordValue(error, 'type')) || 'Unknown session error'}`)

        const taskRunId = actualSessionId && actualSessionId !== rootSessionId
          ? (childSessionToTaskRunId.get(actualSessionId)
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
        break
      }
        }
      } catch (err) {
        log('error', `Failed to process SSE event ${data.type}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } finally {
    clearInterval(sweepInterval)
  }

  log('events', 'SSE stream ended — triggering reconnect')
  throw new Error('SSE stream ended unexpectedly')
}

export async function getMcpStatus(client: OpencodeClient) {
  try {
    const result = await client.mcp.status()
    const entries = normalizeMcpStatusEntries(result.data)
    if (entries.length === 0) {
      log('mcp', 'mcp.status() returned no data')
      return []
    }
    const connected = entries.filter(e => e.connected).length
    log('mcp', `Status: ${connected}/${entries.length} connected (${entries.filter(e => !e.connected).map(e => `${e.name}=${e.rawStatus}`).join(', ')})`)
    return entries
  } catch (err) {
    log('error', `mcp.status() failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
