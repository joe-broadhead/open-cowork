import type { BrowserWindow } from 'electron'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'
import {
  normalizeMessagePart,
  normalizeSessionInfo,
} from './opencode-adapter.ts'
import { readRecordValue, readString } from './normalizer-utils.ts'
import { resolveDisplayCost } from './pricing.ts'
import {
  ensureTaskRunForChild,
  findFallbackTaskRun,
  getImmediateParentSession,
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
const MAX_TOTAL_PENDING_TEXT_EVENTS = 10_000
const MAX_MESSAGE_ROLES_PER_SESSION = 2_000
const MAX_TOTAL_MESSAGE_ROLES = 10_000
const MISSING_SESSION_SCOPE_PREFIX = 'missing-session'

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

export type SessionScopedMessageState = {
  messageRolesBySession: Map<string, Map<string, 'user' | 'assistant'>>
  pendingTextEventsBySession: Map<string, Map<string, PendingTextEvent[]>>
  totalPendingTextEvents: number
  totalMessageRoles: number
}

export function createSessionScopedMessageState(): SessionScopedMessageState {
  return {
    messageRolesBySession: new Map(),
    pendingTextEventsBySession: new Map(),
    totalPendingTextEvents: 0,
    totalMessageRoles: 0,
  }
}

function messageSessionScope(sessionId: string | null | undefined, messageId: string) {
  return sessionId || `${MISSING_SESSION_SCOPE_PREFIX}:${messageId}`
}

function getOrCreateSessionMap<T>(state: Map<string, Map<string, T>>, sessionScope: string) {
  const existing = state.get(sessionScope)
  if (existing) return existing
  const created = new Map<string, T>()
  state.set(sessionScope, created)
  return created
}

function getMessageRole(
  state: SessionScopedMessageState,
  sessionId: string | null | undefined,
  messageId: string,
) {
  return state.messageRolesBySession.get(messageSessionScope(sessionId, messageId))?.get(messageId)
}

function deleteMessageRole(
  state: SessionScopedMessageState,
  sessionScope: string,
  scopedRoles: Map<string, 'user' | 'assistant'>,
  messageId: string,
) {
  if (scopedRoles.delete(messageId)) state.totalMessageRoles = Math.max(0, state.totalMessageRoles - 1)
  if (scopedRoles.size === 0) state.messageRolesBySession.delete(sessionScope)
}

function enforceMessageRoleBounds(state: SessionScopedMessageState) {
  while (state.totalMessageRoles > MAX_TOTAL_MESSAGE_ROLES) {
    const oldestScope = state.messageRolesBySession.keys().next().value
    if (!oldestScope) {
      state.totalMessageRoles = 0
      break
    }

    const scopedRoles = state.messageRolesBySession.get(oldestScope)
    const oldestMessageId = scopedRoles?.keys().next().value
    if (!scopedRoles || !oldestMessageId) {
      state.messageRolesBySession.delete(oldestScope)
      continue
    }

    deleteMessageRole(state, oldestScope, scopedRoles, oldestMessageId)
  }
}

function setMessageRole(
  state: SessionScopedMessageState,
  sessionId: string | null | undefined,
  messageId: string,
  role: 'user' | 'assistant',
) {
  const sessionScope = messageSessionScope(sessionId, messageId)
  const scopedRoles = getOrCreateSessionMap(state.messageRolesBySession, sessionScope)
  const alreadyTracked = scopedRoles.has(messageId)
  scopedRoles.set(messageId, role)
  if (!alreadyTracked) state.totalMessageRoles += 1
  while (scopedRoles.size > MAX_MESSAGE_ROLES_PER_SESSION) {
    const oldest = scopedRoles.keys().next().value
    if (!oldest) break
    deleteMessageRole(state, sessionScope, scopedRoles, oldest)
  }
  enforceMessageRoleBounds(state)
}

function deletePendingTextEvents(
  state: SessionScopedMessageState,
  sessionScope: string,
  scopedPending: Map<string, PendingTextEvent[]>,
  messageId: string,
) {
  const pending = scopedPending.get(messageId)
  if (pending) {
    state.totalPendingTextEvents = Math.max(0, state.totalPendingTextEvents - pending.length)
  }
  scopedPending.delete(messageId)
  if (scopedPending.size === 0) state.pendingTextEventsBySession.delete(sessionScope)
}

function enforcePendingTextEventBounds(state: SessionScopedMessageState) {
  while (state.totalPendingTextEvents > MAX_TOTAL_PENDING_TEXT_EVENTS) {
    const oldestScope = state.pendingTextEventsBySession.keys().next().value
    if (!oldestScope) {
      state.totalPendingTextEvents = 0
      break
    }

    const scopedPending = state.pendingTextEventsBySession.get(oldestScope)
    const oldestMessageId = scopedPending?.keys().next().value
    if (!scopedPending || !oldestMessageId) {
      state.pendingTextEventsBySession.delete(oldestScope)
      continue
    }

    deletePendingTextEvents(state, oldestScope, scopedPending, oldestMessageId)
  }
}

function pushPendingTextEvent(
  state: SessionScopedMessageState,
  sessionId: string | null | undefined,
  messageId: string,
  event: PendingTextEvent,
) {
  const sessionScope = messageSessionScope(sessionId, messageId)
  const scopedPending = getOrCreateSessionMap(
    state.pendingTextEventsBySession,
    sessionScope,
  )
  const current = scopedPending.get(messageId) || []
  current.push(event)
  state.totalPendingTextEvents += 1
  scopedPending.set(messageId, current)
  while (scopedPending.size > MAX_PENDING_TEXT_EVENTS) {
    const oldest = scopedPending.keys().next().value
    if (!oldest) break
    deletePendingTextEvents(state, sessionScope, scopedPending, oldest)
  }
  enforcePendingTextEventBounds(state)
}

export function sweepSessionScopedMessageState(state: SessionScopedMessageState) {
  for (const [scope, roles] of state.messageRolesBySession.entries()) {
    while (roles.size > MAX_MESSAGE_ROLES_PER_SESSION) {
      const oldest = roles.keys().next().value
      if (!oldest) break
      deleteMessageRole(state, scope, roles, oldest)
    }
    if (roles.size === 0) state.messageRolesBySession.delete(scope)
  }

  enforceMessageRoleBounds(state)
  enforcePendingTextEventBounds(state)
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
      startedAt: taskRun.startedAt ?? null,
      finishedAt: taskRun.finishedAt ?? null,
    },
  })
}

export function flushPendingTextEvents(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  state: SessionScopedMessageState,
  sessionId: string | null | undefined,
  messageId: string,
  role: 'user' | 'assistant',
) {
  const scopedPending = state.pendingTextEventsBySession.get(messageSessionScope(sessionId, messageId))
  const pending = scopedPending?.get(messageId)
  if (!scopedPending || !pending || pending.length === 0) return
  const sessionScope = messageSessionScope(sessionId, messageId)
  deletePendingTextEvents(state, sessionScope, scopedPending, messageId)
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
  messageState: SessionScopedMessageState,
) {
  const info = normalizeSessionInfo(readRecordValue(properties, 'info'))
  if (info?.id && (info.role === 'user' || info.role === 'assistant')) {
    setMessageRole(messageState, info.sessionID || null, info.id, info.role)
    flushPendingTextEvents(win, dispatchRuntimeEvent, messageState, info.sessionID || null, info.id, info.role)
  }
  if (info?.sessionID) {
    registerSession(info.sessionID)
  }
}

export function handleMessagePartDeltaEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageState: SessionScopedMessageState,
) {
  const messageId = readString(readRecordValue(properties, 'messageID'))
    || readString(readRecordValue(properties, 'messageId'))
    || null
  const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
    || readString(readRecordValue(properties, 'sessionId'))
    || null
  const sessionId = resolveRootSession(actualSessionId)
  const rawDelta = readString(readRecordValue(properties, 'delta'))
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
    const role = getMessageRole(messageState, actualSessionId, messageId)
    if (role === 'user') return
    if (!role) {
      pushPendingTextEvent(messageState, actualSessionId, messageId, {
        mode: 'append',
        rootSessionId: sessionId,
        actualSessionId,
        taskRunId,
        messageId,
        partId: readString(readRecordValue(properties, 'partID')) || readString(readRecordValue(properties, 'partId')) || null,
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
    partId: readString(readRecordValue(properties, 'partID')) || readString(readRecordValue(properties, 'partId')) || null,
    content: delta,
    mode: 'append',
  })
}

export function handleMessagePartUpdatedEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageState: SessionScopedMessageState,
  cachedModelId: string,
) {
  const part = normalizeMessagePart(readRecordValue(properties, 'part'))
  if (!part) return

  const messageId = readString(readRecordValue(properties, 'messageID'))
    || readString(readRecordValue(properties, 'messageId'))
    || null
  const partId = readString(readRecordValue(properties, 'partID'))
    || readString(readRecordValue(properties, 'partId'))
    || part.id
    || null
  const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
    || readString(readRecordValue(properties, 'sessionId'))
    || null
  const messageRole = messageId ? getMessageRole(messageState, actualSessionId, messageId) : undefined
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
      pushPendingTextEvent(messageState, actualSessionId, messageId, {
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
    const parentSessionId = actualSessionId || rootSessionId
    const agentName = normalizeAgentName(part.agent)
      || extractAgentName(
        part.description,
        part.title,
        part.prompt,
        part.raw,
      )
      || null
    const fallback = findFallbackTaskRun(rootSessionId, parentSessionId)
    const taskRunId = fallback?.id || part.id
    const taskRun = registerTaskRun({
      id: taskRunId || `pending:${crypto.randomUUID()}`,
      rootSessionId,
      parentSessionId,
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
          // A failed tool call inside a child session is transcript state,
          // not a terminal task-run state. OpenCode can keep the subagent
          // working after a tool error, so only session-level error/idle
          // events should clamp the task timer.
          status: status === 'complete' ? taskRun.status : 'running',
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
