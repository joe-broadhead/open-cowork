import type { BrowserWindow } from 'electron'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'
import {
  normalizeMessagePart,
  normalizeSessionInfo,
  readRecordValue,
  readStringValue,
} from './opencode-adapter.ts'
import { resolveDisplayCost } from './pricing.ts'
import {
  ensureTaskRunForChild,
  findFallbackTaskRun,
  getTaskRunIdForChild,
  registerSession,
  registerTaskRun,
  resolveRootSession,
  type TaskRunMeta,
  updateTaskRun,
  consumePendingPromptEcho,
} from './event-task-state.ts'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  normalizeAgentName,
} from './task-run-utils.ts'

const MAX_PENDING_TEXT_EVENTS = 500

export type PendingTextEvent = {
  mode: 'append' | 'replace'
  rootSessionId: string
  actualSessionId: string | null
  taskRunId: string | null
  messageId: string
  partId: string | null
  content: string
}

type DispatchRuntimeEvent = (win: BrowserWindow, event: RuntimeSessionEvent) => void

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
  dispatchRuntimeEvent: DispatchRuntimeEvent,
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

export function flushPendingTextEvents(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  pendingTextEvents: Map<string, PendingTextEvent[]>,
  messageId: string,
  role: 'user' | 'assistant',
) {
  const pending = pendingTextEvents.get(messageId)
  if (!pending || pending.length === 0) return
  pendingTextEvents.delete(messageId)
  if (role === 'user') return
  for (const event of pending) {
    dispatchTextPatch(win, dispatchRuntimeEvent, {
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

export function handleMessageUpdatedEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageRoles: Map<string, 'user' | 'assistant'>,
  pendingTextEventsByMessageId: Map<string, PendingTextEvent[]>,
) {
  const info = normalizeSessionInfo(readRecordValue(properties, 'info'))
  if (info?.id && (info.role === 'user' || info.role === 'assistant')) {
    messageRoles.set(info.id, info.role)
    flushPendingTextEvents(win, dispatchRuntimeEvent, pendingTextEventsByMessageId, info.id, info.role)
  }
  if (info?.sessionID) {
    registerSession(info.sessionID)
  }
}

export function handleMessagePartDeltaEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageRoles: Map<string, 'user' | 'assistant'>,
  pendingTextEventsByMessageId: Map<string, PendingTextEvent[]>,
) {
  const messageId = readStringValue(readRecordValue(properties, 'messageID'))
    || readStringValue(readRecordValue(properties, 'messageId'))
    || null
  const actualSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
    || readStringValue(readRecordValue(properties, 'sessionId'))
    || null
  const sessionId = resolveRootSession(actualSessionId)
  const rawDelta = readStringValue(readRecordValue(properties, 'delta'))
  const delta = !messageId && rawDelta && sessionId
    ? consumePendingPromptEcho(sessionId, rawDelta)
    : rawDelta
  if (!delta || !sessionId) return

  const taskRunId = actualSessionId && actualSessionId !== sessionId
    ? (getTaskRunIdForChild(actualSessionId)
      || ensureTaskRunForChild(sessionId, actualSessionId)?.id
      || null)
    : null

  if (messageId) {
    const role = messageRoles.get(messageId)
    if (role === 'user') return
    if (!role) {
      pushPendingTextEvent(pendingTextEventsByMessageId, messageId, {
        mode: 'append',
        rootSessionId: sessionId,
        actualSessionId,
        taskRunId,
        messageId,
        partId: readStringValue(readRecordValue(properties, 'partID')) || readStringValue(readRecordValue(properties, 'partId')) || null,
        content: delta,
      })
      return
    }
  }

  dispatchTextPatch(win, dispatchRuntimeEvent, {
    rootSessionId: sessionId,
    actualSessionId,
    taskRunId,
    messageId,
    partId: readStringValue(readRecordValue(properties, 'partID')) || readStringValue(readRecordValue(properties, 'partId')) || null,
    content: delta,
    mode: 'append',
  })
}

export function handleMessagePartUpdatedEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageRoles: Map<string, 'user' | 'assistant'>,
  pendingTextEventsByMessageId: Map<string, PendingTextEvent[]>,
  cachedModelId: string,
) {
  const part = normalizeMessagePart(readRecordValue(properties, 'part'))
  if (!part) return

  const messageId = readStringValue(readRecordValue(properties, 'messageID'))
    || readStringValue(readRecordValue(properties, 'messageId'))
    || null
  const partId = readStringValue(readRecordValue(properties, 'partID'))
    || readStringValue(readRecordValue(properties, 'partId'))
    || part.id
    || null
  const actualSessionId = readStringValue(readRecordValue(properties, 'sessionID'))
    || readStringValue(readRecordValue(properties, 'sessionId'))
    || null
  const messageRole = messageId ? messageRoles.get(messageId) : undefined
  if (messageRole === 'user') return

  const rootSessionId = resolveRootSession(actualSessionId)
  if (!rootSessionId) return

  if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
    const content = !messageId
      ? consumePendingPromptEcho(rootSessionId, part.text)
      : part.text
    if (!content) return
    const taskRunId = actualSessionId && actualSessionId !== rootSessionId
      ? (getTaskRunIdForChild(actualSessionId)
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
      return
    }

    dispatchTextPatch(win, dispatchRuntimeEvent, {
      rootSessionId,
      actualSessionId,
      taskRunId,
      messageId,
      partId,
      content,
      mode: 'replace',
    })
    return
  }

  if (part.type === 'step-finish' && (part.cost !== undefined || part.tokens)) {
    const tokens = part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const cost = resolveDisplayCost(cachedModelId, part.cost ?? undefined, tokens)
    const taskRunId = actualSessionId && actualSessionId !== rootSessionId
      ? (getTaskRunIdForChild(actualSessionId)
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
    return
  }

  if (part.type === 'agent') {
    const agentName = normalizeAgentName(part.agent || part.name || '')
      || part.agent
      || part.name
      || ''
    if (!agentName) return

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
    return
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
    return
  }

  if (part.type === 'compaction') {
    const taskRunId = actualSessionId && actualSessionId !== rootSessionId
      ? (getTaskRunIdForChild(actualSessionId)
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
    return
  }

  if (part.type === 'reasoning' || part.type === 'step-start'
    || part.type === 'snapshot' || part.type === 'agent'
    || part.type === 'retry' || part.type === 'patch' || part.type === 'text') {
    return
  }

  if (part.type === 'tool') {
    const state = part.state
    const statusValue = state.status || ''
    const isComplete = statusValue === 'completed' || statusValue === 'complete' || state.output !== undefined
    const isError = statusValue === 'error'
    const status = isComplete ? 'complete' : isError ? 'error' : 'running'
    const title = part.title || state.title || ''
    const metadata = Object.keys(part.metadata).length > 0 ? part.metadata : state.metadata

    if (part.tool === 'question') return
    if (part.tool === 'task' && actualSessionId === rootSessionId) return

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
}
