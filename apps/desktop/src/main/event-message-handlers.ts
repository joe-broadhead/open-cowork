import { chooseTaskTitle, extractAgentName, isPlaceholderTaskTitle, normalizeAgentName } from '@open-cowork/runtime-host/task-run-utils'
import type { RuntimeSessionEvent } from '@open-cowork/runtime-host/session-event-dispatcher'
import { nextSessionScopedFallbackId } from '@open-cowork/runtime-host/runtime-fallback-ids'
import { normalizeMessagePart, normalizeSessionInfo } from '@open-cowork/runtime-host'
import { asRecord, deriveToolStatus, readRecordValue, readString } from '@open-cowork/shared'
import type { BrowserWindow } from 'electron'
import { resolveDisplayCost } from './pricing.ts'
import {
  aliasTaskRunId,
  bindTaskRunToChild,
  ensureTaskRunForChild,
  findFallbackTaskRun,
  getTaskRun,
  getTaskRunIdForChild,
  registerSession,
  registerTaskRun,
  resolveTaskRunId,
  resolveRootSession,
  updateTaskRun,
  consumePendingPromptEcho,
} from './event-task-state.ts'
import { emitTaskRun } from './event-task-run-dispatch.ts'
import { log } from './logger.ts'
const MAX_PENDING_TEXT_EVENTS_PER_SESSION = 500
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
type NormalizedMessagePart = NonNullable<ReturnType<typeof normalizeMessagePart>>

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

function pendingTextEventCount(scopedPending: Map<string, PendingTextEvent[]>) {
  let total = 0
  for (const pending of scopedPending.values()) total += pending.length
  return total
}

function dropOldestPendingTextEvent(
  state: SessionScopedMessageState,
  sessionScope: string,
  scopedPending: Map<string, PendingTextEvent[]>,
) {
  const oldestMessageId = scopedPending.keys().next().value
  if (!oldestMessageId) return 0
  const pending = scopedPending.get(oldestMessageId) || []
  if (pending.length <= 1) {
    deletePendingTextEvents(state, sessionScope, scopedPending, oldestMessageId)
    return pending.length
  }
  scopedPending.set(oldestMessageId, pending.slice(1))
  state.totalPendingTextEvents = Math.max(0, state.totalPendingTextEvents - 1)
  return 1
}

function enforcePendingTextEventBounds(state: SessionScopedMessageState) {
  let dropped = 0
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

    const before = state.totalPendingTextEvents
    deletePendingTextEvents(state, oldestScope, scopedPending, oldestMessageId)
    dropped += Math.max(0, before - state.totalPendingTextEvents)
  }
  return dropped
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
  const next = [...current, event]
  state.totalPendingTextEvents += 1
  scopedPending.set(messageId, next)
  let sessionDropped = 0
  while (pendingTextEventCount(scopedPending) > MAX_PENDING_TEXT_EVENTS_PER_SESSION) {
    const count = dropOldestPendingTextEvent(state, sessionScope, scopedPending)
    if (count === 0) break
    sessionDropped += count
  }
  if (sessionDropped > 0) {
    log('events', `Dropped ${sessionDropped} buffered text event${sessionDropped === 1 ? '' : 's'} while enforcing pending text bounds for ${sessionScope}`)
  }
  const globalDropped = enforcePendingTextEventBounds(state)
  if (globalDropped > 0) {
    log('events', `Dropped ${globalDropped} oldest buffered text event${globalDropped === 1 ? '' : 's'} while enforcing global pending text bounds`)
  }
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
  let dropped = 0
  for (const [scope, pending] of state.pendingTextEventsBySession.entries()) {
    while (pendingTextEventCount(pending) > MAX_PENDING_TEXT_EVENTS_PER_SESSION) {
      const count = dropOldestPendingTextEvent(state, scope, pending)
      if (count === 0) break
      dropped += count
    }
    if (pending.size === 0) state.pendingTextEventsBySession.delete(scope)
  }
  dropped += enforcePendingTextEventBounds(state)
  if (dropped > 0) {
    log('events', `Dropped ${dropped} buffered text event${dropped === 1 ? '' : 's'} while sweeping pending text bounds`)
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

function dispatchReasoningPatch(
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
    type: 'reasoning',
    sessionId: input.rootSessionId,
    data: {
      type: 'reasoning',
      mode: input.mode,
      content: input.content,
      taskRunId: input.taskRunId,
      sourceSessionId: input.actualSessionId,
      messageId: input.messageId,
      partId: input.partId,
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
  const rawPart = asRecord(readRecordValue(properties, 'part'))
  const messageId = readString(readRecordValue(properties, 'messageID'))
    || readString(readRecordValue(properties, 'messageId'))
    || readString(readRecordValue(rawPart, 'messageID'))
    || readString(readRecordValue(rawPart, 'messageId'))
    || null
  const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
    || readString(readRecordValue(properties, 'sessionId'))
    || readString(readRecordValue(rawPart, 'sessionID'))
    || readString(readRecordValue(rawPart, 'sessionId'))
    || null
  const partId = readString(readRecordValue(properties, 'partID'))
    || readString(readRecordValue(properties, 'partId'))
    || readString(readRecordValue(rawPart, 'id'))
    || null
  const sessionId = resolveRootSession(actualSessionId)
  const rawDelta = readString(readRecordValue(properties, 'delta'))
  const partType = readString(readRecordValue(properties, 'type'))
    || readString(readRecordValue(readRecordValue(properties, 'part'), 'type'))
  const delta = partType !== 'reasoning' && !messageId && rawDelta && sessionId
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
    if (!role && partType !== 'reasoning') {
      pushPendingTextEvent(messageState, actualSessionId, messageId, {
        mode: 'append',
        rootSessionId: sessionId,
        actualSessionId,
        taskRunId,
        messageId,
        partId,
        content: delta,
      })
      return
    }
  }

  if (partType === 'reasoning') {
    dispatchReasoningPatch(win, dispatchRuntimeEvent, {
      rootSessionId: sessionId,
      actualSessionId,
      taskRunId,
      messageId,
      partId,
      content: delta,
      mode: 'append',
    })
    return
  }

  dispatchTextPatch(win, dispatchRuntimeEvent, {
    rootSessionId: sessionId,
    actualSessionId,
    taskRunId,
    messageId,
    partId,
    content: delta,
    mode: 'append',
  })
}

type MessagePartUpdatedContext = {
  win: BrowserWindow
  dispatchRuntimeEvent: DispatchRuntimeEvent
  messageState: SessionScopedMessageState
  cachedModelId: string
  part: NormalizedMessagePart
  messageId: string | null
  partId: string | null
  actualSessionId: string | null
  messageRole: 'user' | 'assistant' | undefined
  rootSessionId: string
}

function resolveUpdatedPartContext(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageState: SessionScopedMessageState,
  cachedModelId: string,
): MessagePartUpdatedContext | null {
  const rawPart = asRecord(readRecordValue(properties, 'part'))
  const part = normalizeMessagePart(rawPart)
  if (!part) return null

  const messageId = readString(readRecordValue(properties, 'messageID'))
    || readString(readRecordValue(properties, 'messageId'))
    || readString(readRecordValue(rawPart, 'messageID'))
    || readString(readRecordValue(rawPart, 'messageId'))
    || null
  const partId = readString(readRecordValue(properties, 'partID'))
    || readString(readRecordValue(properties, 'partId'))
    || readString(readRecordValue(rawPart, 'partID'))
    || readString(readRecordValue(rawPart, 'partId'))
    || readString(readRecordValue(rawPart, 'id'))
    || part.id
    || null
  const actualSessionId = readString(readRecordValue(properties, 'sessionID'))
    || readString(readRecordValue(properties, 'sessionId'))
    || readString(readRecordValue(rawPart, 'sessionID'))
    || readString(readRecordValue(rawPart, 'sessionId'))
    || null
  const messageRole = messageId ? getMessageRole(messageState, actualSessionId, messageId) : undefined
  if (messageRole === 'user') return null

  const rootSessionId = resolveRootSession(actualSessionId)
  if (!rootSessionId) return null

  return {
    win,
    dispatchRuntimeEvent,
    messageState,
    cachedModelId,
    part,
    messageId,
    partId,
    actualSessionId,
    messageRole,
    rootSessionId,
  }
}

function resolveUpdatedPartTaskRunId(ctx: MessagePartUpdatedContext) {
  return ctx.actualSessionId && ctx.actualSessionId !== ctx.rootSessionId
    ? (getTaskRunIdForChild(ctx.actualSessionId)
      || ensureTaskRunForChild(ctx.rootSessionId, ctx.actualSessionId)?.id
      || null)
    : null
}

function handleUpdatedTextPart(ctx: MessagePartUpdatedContext) {
  if (ctx.part.type !== 'text' || typeof ctx.part.text !== 'string' || ctx.part.text.length === 0) return false
  const content = !ctx.messageId
    ? consumePendingPromptEcho(ctx.rootSessionId, ctx.part.text)
    : ctx.part.text
  if (!content) return true
  const taskRunId = resolveUpdatedPartTaskRunId(ctx)

  if (ctx.messageId && !ctx.messageRole) {
    pushPendingTextEvent(ctx.messageState, ctx.actualSessionId, ctx.messageId, {
      mode: 'replace',
      rootSessionId: ctx.rootSessionId,
      actualSessionId: ctx.actualSessionId,
      taskRunId,
      messageId: ctx.messageId,
      partId: ctx.partId,
      content,
    })
    return true
  }

  dispatchTextPatch(ctx.win, ctx.dispatchRuntimeEvent, {
    rootSessionId: ctx.rootSessionId,
    actualSessionId: ctx.actualSessionId,
    taskRunId,
    messageId: ctx.messageId,
    partId: ctx.partId,
    content,
    mode: 'replace',
  })
  return true
}

function handleUpdatedReasoningPart(ctx: MessagePartUpdatedContext) {
  if (ctx.part.type !== 'reasoning' || typeof ctx.part.text !== 'string' || ctx.part.text.length === 0) return false
  dispatchReasoningPatch(ctx.win, ctx.dispatchRuntimeEvent, {
    rootSessionId: ctx.rootSessionId,
    actualSessionId: ctx.actualSessionId,
    taskRunId: resolveUpdatedPartTaskRunId(ctx),
    messageId: ctx.messageId,
    partId: ctx.partId,
    content: ctx.part.text,
    mode: 'replace',
  })
  return true
}

function handleUpdatedStepFinishPart(ctx: MessagePartUpdatedContext) {
  if (ctx.part.type !== 'step-finish' || (ctx.part.cost === undefined && !ctx.part.tokens)) return false
  const tokens = ctx.part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const cost = resolveDisplayCost(ctx.cachedModelId, ctx.part.cost ?? undefined, tokens)
  const costEventId = [
    ctx.actualSessionId || ctx.rootSessionId,
    ctx.messageId || 'message',
    ctx.part.id || 'step-finish',
  ].join(':')
  ctx.dispatchRuntimeEvent(ctx.win, {
    type: 'cost',
    sessionId: ctx.rootSessionId,
    data: {
      type: 'cost',
      id: costEventId,
      cost,
      tokens,
      taskRunId: resolveUpdatedPartTaskRunId(ctx),
      sourceSessionId: ctx.actualSessionId,
    },
  })
  return true
}

function handleUpdatedAgentPart(ctx: MessagePartUpdatedContext) {
  if (ctx.part.type !== 'agent') return false
  const agentName = normalizeAgentName(ctx.part.agent || ctx.part.name || '')
    || ctx.part.agent
    || ctx.part.name
    || ''
  if (!agentName) return true

  if (ctx.actualSessionId && ctx.actualSessionId !== ctx.rootSessionId) {
    const taskRun = ensureTaskRunForChild(ctx.rootSessionId, ctx.actualSessionId, agentName)
    if (taskRun) {
      const updated = updateTaskRun(taskRun.id, {
        agent: agentName,
        title: chooseTaskTitle(
          agentName,
          !isPlaceholderTaskTitle(taskRun.title, taskRun.agent || agentName) ? taskRun.title : null,
        ),
        status: taskRun.status === 'queued' ? 'running' : taskRun.status,
      })
      if (updated) emitTaskRun(ctx.win, updated)
    }
  } else {
    ctx.dispatchRuntimeEvent(ctx.win, {
      type: 'agent',
      sessionId: ctx.rootSessionId,
      data: { type: 'agent', name: agentName },
    })
  }
  return true
}

function handleUpdatedSubtaskPart(ctx: MessagePartUpdatedContext) {
  if (ctx.part.type !== 'subtask') return false
  const parentSessionId = ctx.actualSessionId || ctx.rootSessionId
  const agentName = normalizeAgentName(ctx.part.agent)
    || extractAgentName(
      ctx.part.description,
      ctx.part.title,
    )
    || null
  const fallback = findFallbackTaskRun(ctx.rootSessionId, parentSessionId)
  if (fallback) {
    log(
      'session',
      `Recovered child task lineage from fallback task run ${fallback.id} for parent session ${parentSessionId} in root session ${ctx.rootSessionId}`,
    )
  }
  const taskRunId = fallback?.id || ctx.part.id
  const taskRun = registerTaskRun({
    id: taskRunId || `pending:${crypto.randomUUID()}`,
    rootSessionId: ctx.rootSessionId,
    parentSessionId,
    title: chooseTaskTitle(
      agentName,
      ctx.part.description,
      ctx.part.title,
      ctx.part.prompt,
      ctx.part.raw,
    ),
    agent: agentName,
    childSessionId: fallback?.childSessionId || null,
    status: fallback?.status || 'queued',
  })
  emitTaskRun(ctx.win, taskRun)
  return true
}

function handleUpdatedCompactionPart(ctx: MessagePartUpdatedContext) {
  if (ctx.part.type !== 'compaction') return false
  ctx.dispatchRuntimeEvent(ctx.win, {
    type: 'compaction',
    sessionId: ctx.rootSessionId,
    data: {
      type: 'compaction',
      id: ctx.part.id || undefined,
      status: 'compacting',
      auto: !!ctx.part.auto,
      overflow: !!ctx.part.overflow,
      taskRunId: resolveUpdatedPartTaskRunId(ctx),
      sourceSessionId: ctx.actualSessionId,
    },
  })
  return true
}

function resolveTaskToolDescriptor(
  ctx: MessagePartUpdatedContext,
  metadata: Record<string, unknown>,
  title: string,
) {
  const state = ctx.part.state
  const metadataAgent = typeof metadata.agent === 'string' ? metadata.agent : null
  const inputAgent = readString(readRecordValue(state.input, 'agent'))
    || readString(readRecordValue(state.input, 'subagent_type'))
    || readString(readRecordValue(state.input, 'subagentType'))
  const argsAgent = readString(readRecordValue(state.args, 'agent'))
    || readString(readRecordValue(state.args, 'subagent_type'))
    || readString(readRecordValue(state.args, 'subagentType'))
  const inputDescription = readString(readRecordValue(state.input, 'description'))
  const argsDescription = readString(readRecordValue(state.args, 'description'))
  const inputTitle = readString(readRecordValue(state.input, 'title'))
  const argsTitle = readString(readRecordValue(state.args, 'title'))
  const inputPrompt = readString(readRecordValue(state.input, 'prompt'))
  const argsPrompt = readString(readRecordValue(state.args, 'prompt'))
  const titleCandidates = [
    ctx.part.description,
    inputDescription,
    argsDescription,
    title,
    state.title,
    inputTitle,
    argsTitle,
    inputPrompt,
    argsPrompt,
    ctx.part.prompt,
    state.raw,
    ctx.part.raw,
  ]
  const agentCandidates = [
    ctx.part.description,
    inputDescription,
    argsDescription,
    title,
    state.title,
    inputTitle,
    argsTitle,
  ]
  const agentName = normalizeAgentName(ctx.part.agent)
    || normalizeAgentName(inputAgent)
    || normalizeAgentName(argsAgent)
    || normalizeAgentName(metadataAgent)
    || extractAgentName(...agentCandidates)
    || null

  return {
    agentName,
    titleCandidates,
  }
}

function readTaskToolSessionId(metadata: Record<string, unknown>) {
  return readString(readRecordValue(metadata, 'sessionId'))
    || readString(readRecordValue(metadata, 'sessionID'))
    || readString(readRecordValue(metadata, 'session_id'))
}

function readTaskToolParentSessionId(metadata: Record<string, unknown>) {
  return readString(readRecordValue(metadata, 'parentSessionId'))
    || readString(readRecordValue(metadata, 'parentSessionID'))
    || readString(readRecordValue(metadata, 'parent_session_id'))
}

function handleUpdatedTaskToolPart(
  ctx: MessagePartUpdatedContext,
  input: {
    isComplete: boolean
    isError: boolean
    metadata: Record<string, unknown>
    title: string
  },
) {
  if (ctx.part.tool !== 'task') return false
  const parentSessionId = ctx.actualSessionId || ctx.rootSessionId
  const childSessionId = readTaskToolSessionId(input.metadata)
  const taskParentSessionId = readTaskToolParentSessionId(input.metadata) || parentSessionId
  const providerTaskRunId = ctx.part.callId || ctx.part.id || `${parentSessionId}:task:${crypto.randomUUID()}`
  let taskRunId = resolveTaskRunId(providerTaskRunId) || providerTaskRunId
  let existingTaskRun = getTaskRun(providerTaskRunId)
  if (!existingTaskRun && taskRunId !== providerTaskRunId) existingTaskRun = getTaskRun(taskRunId)
  let existingChildTaskRunId = childSessionId ? getTaskRunIdForChild(childSessionId) : null
  let childTaskRunBeforeBind = existingTaskRun?.childSessionId
    ? existingTaskRun
    : existingChildTaskRunId
      ? getTaskRun(existingChildTaskRunId)
      : null

  if (childSessionId) {
    registerSession(childSessionId, taskParentSessionId)
    if (existingTaskRun) {
      const bound = bindTaskRunToChild(providerTaskRunId, childSessionId)
      taskRunId = bound?.id || providerTaskRunId
      existingTaskRun = bound || getTaskRun(taskRunId)
    } else {
      existingChildTaskRunId = existingChildTaskRunId || getTaskRunIdForChild(childSessionId)
      taskRunId = existingChildTaskRunId || `child:${childSessionId}`
      existingTaskRun = getTaskRun(taskRunId)
      childTaskRunBeforeBind = existingTaskRun?.childSessionId ? existingTaskRun : null
    }
  }
  const { agentName, titleCandidates } = resolveTaskToolDescriptor(ctx, input.metadata, input.title)
  const childOwnedTaskRun = childTaskRunBeforeBind || (existingTaskRun?.childSessionId ? existingTaskRun : null)
  const preservedChildStatus = childOwnedTaskRun?.status && childOwnedTaskRun.status !== 'queued'
    ? childOwnedTaskRun.status
    : null
  const hasChildOwnedTaskRun = Boolean(childSessionId || childOwnedTaskRun)
  const taskStatus = input.isError
    ? 'error'
    : hasChildOwnedTaskRun
      ? preservedChildStatus || 'running'
      : input.isComplete
        ? 'complete'
        : 'queued'

  const taskRun = existingTaskRun
    ? updateTaskRun(taskRunId, {
        agent: agentName || existingTaskRun.agent,
        title: chooseTaskTitle(
          agentName || existingTaskRun.agent,
          !isPlaceholderTaskTitle(existingTaskRun.title, existingTaskRun.agent || agentName) ? existingTaskRun.title : null,
          ...titleCandidates,
        ),
        status: taskStatus,
      })
    : registerTaskRun({
        id: taskRunId,
        rootSessionId: ctx.rootSessionId,
        parentSessionId: taskParentSessionId,
        title: chooseTaskTitle(agentName, ...titleCandidates),
        agent: agentName,
        childSessionId: childSessionId || null,
        status: taskStatus,
      })
  if (taskRun?.childSessionId && taskRun.id !== providerTaskRunId) {
    aliasTaskRunId(providerTaskRunId, taskRun.id)
  }
  if (taskRun) emitTaskRun(ctx.win, taskRun)
  return true
}

function handleUpdatedToolPart(ctx: MessagePartUpdatedContext) {
  if (ctx.part.type !== 'tool') return false
  const state = ctx.part.state
  const statusValue = state.status || ''
  const status = deriveToolStatus({
    hasOutput: state.output !== undefined,
    hasError: statusValue === 'error' || state.error !== undefined,
    statusHint: typeof statusValue === 'string' ? statusValue : undefined,
  })
  const isError = status === 'error'
  const isComplete = status === 'complete'
  const title = ctx.part.title || state.title || ''
  const metadata = {
    ...state.metadata,
    ...ctx.part.metadata,
  }

  if (ctx.part.tool === 'question') return true
  if (handleUpdatedTaskToolPart(ctx, { isComplete, isError, metadata, title })) return true

  let taskRunId: string | null = null
  if (ctx.actualSessionId && ctx.actualSessionId !== ctx.rootSessionId) {
    const metadataAgent = typeof metadata.agent === 'string' ? metadata.agent : null
    const inferredAgent = normalizeAgentName(metadataAgent)
      || extractAgentName(
        title,
        state.title,
      )
      || null
    const taskRun = ensureTaskRunForChild(ctx.rootSessionId, ctx.actualSessionId, inferredAgent)
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
      if (updated) emitTaskRun(ctx.win, updated)
    }
  }

  const displayName = ctx.part.tool === 'task' && title ? title : ctx.part.tool
  let toolInput = Object.keys(state.input).length > 0 ? state.input : state.args
  if (ctx.part.tool === 'task' && state.raw && !Object.keys(toolInput).length) {
    toolInput = { prompt: state.raw }
  }
  const attachments = state.attachments.length > 0 ? state.attachments : ctx.part.attachments

  ctx.dispatchRuntimeEvent(ctx.win, {
    type: 'tool_call',
    sessionId: ctx.rootSessionId,
    data: {
      type: 'tool_call',
      id: ctx.part.callId || ctx.part.id || nextSessionScopedFallbackId(ctx.rootSessionId, 'tool'),
      name: displayName,
      input: toolInput,
      status,
      output: state.output ?? state.result,
      agent: normalizeAgentName(typeof metadata.agent === 'string' ? metadata.agent : null)
        || extractAgentName(title, state.title)
        || null,
      attachments: attachments.length > 0 ? attachments : undefined,
      taskRunId,
      sourceSessionId: ctx.actualSessionId,
    },
  })
  return true
}

function ignoreUpdatedPart(part: NormalizedMessagePart) {
  return part.type === 'step-start'
    || part.type === 'snapshot'
    || part.type === 'retry'
    || part.type === 'patch'
}

export function handleMessagePartUpdatedEvent(
  win: BrowserWindow,
  dispatchRuntimeEvent: DispatchRuntimeEvent,
  properties: Record<string, unknown> | null | undefined,
  messageState: SessionScopedMessageState,
  cachedModelId: string,
) {
  const ctx = resolveUpdatedPartContext(win, dispatchRuntimeEvent, properties, messageState, cachedModelId)
  if (!ctx || ignoreUpdatedPart(ctx.part)) return
  handleUpdatedTextPart(ctx)
    || handleUpdatedReasoningPart(ctx)
    || handleUpdatedStepFinishPart(ctx)
    || handleUpdatedAgentPart(ctx)
    || handleUpdatedSubtaskPart(ctx)
    || handleUpdatedCompactionPart(ctx)
    || handleUpdatedToolPart(ctx)
}
