import type {
  CompactionNotice,
  ExecutionPlanItem,
  MessageAttachment,
  PendingApproval,
  PendingQuestion,
  SessionError,
  SessionTokens,
  SessionView,
  TaskRun,
  TodoItem,
  ToolCall,
} from '@open-cowork/shared'

import {
  cloneCompactionNotice,
  finishCompactionNotice,
  hasPendingCompactions,
} from './session-view-compaction.ts'
import {
  buildMessageSegments,
  buildMessages,
  createEmptyMessageState,
  importMessage,
  isLivePlaceholderMessageId,
  mergeMissingUserMessages,
  nextHasRealMessageOfRole,
  renderMessageSegments,
  withMessageText,
  type MessageEntity,
  type MessagePartEntity,
  type MessageStateShape,
} from './session-view-messages.ts'
import { nextSeq, observeSeq, nowTs } from './session-view-sequence.ts'
import {
  deriveExecutionPlan,
  ensureTaskRunTimingsForView,
  renderTaskTranscript,
  upsertTaskRunList,
  withTaskRun,
  withTaskTranscript,
} from './session-view-task-runs.ts'
import { cloneTokens, EMPTY_SESSION_TOKENS } from './session-view-tokens.ts'
import { preferNewerStreamingText } from './session-view-text.ts'

export { beginCompactionNotice, cloneCompactionNotice, finishCompactionNotice } from './session-view-compaction.ts'
export {
  LIVE_USER_MESSAGE_SUFFIX_PUBLIC,
  LIVE_USER_SEGMENT_SUFFIX_PUBLIC,
  buildMessages,
  importMessage,
  withMessageText,
} from './session-view-messages.ts'
export { nextSeq, nowTs } from './session-view-sequence.ts'
export {
  createEmptyTaskRun,
  upsertTaskRunList,
  withTaskRun,
  withTaskTranscript,
} from './session-view-task-runs.ts'
export { mergeStreamingText } from './session-view-text.ts'
export { cloneTokens, EMPTY_SESSION_TOKENS } from './session-view-tokens.ts'

export const MAX_WARM_SESSION_DETAILS = 12

export type HistoryItem = {
  type?: string
  id: string
  role?: string
  content?: string
  messageId?: string
  partId?: string
  timestamp: string
  providerId?: string | null
  modelId?: string | null
  taskRunId?: string
  taskRun?: {
    title: string
    agent: string | null
    status: TaskRun['status']
    sourceSessionId: string | null
    parentSessionId?: string | null
    startedAt?: string | null
    finishedAt?: string | null
  }
  todos?: TodoItem[]
  tool?: {
    name: string
    input: Record<string, unknown>
    status: string
    output?: unknown
    attachments?: MessageAttachment[]
    agent?: string | null
    sourceSessionId?: string | null
  }
  cost?: {
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
  }
  compaction?: {
    status: 'compacting' | 'compacted'
    auto: boolean
    overflow: boolean
    sourceSessionId?: string | null
  }
}

export interface SessionViewState {
  messageIds: string[]
  messageById: Record<string, MessageEntity>
  messagePartsById: Record<string, MessagePartEntity>
  toolCalls: ToolCall[]
  taskRuns: TaskRun[]
  compactions: CompactionNotice[]
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  errors: SessionError[]
  todos: TodoItem[]
  executionPlan: ExecutionPlanItem[]
  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number
  contextState: 'idle' | 'measured' | 'compacting' | 'compacted'
  compactionCount: number
  lastCompactedAt: string | null
  activeAgent: string | null
  lastItemWasTool: boolean
  hydrated: boolean
  revision: number
  lastViewedAt: number
  lastEventAt: number
}

function syncSessionSequence(state: SessionViewState) {
  for (const messageId of state.messageIds) {
    const message = state.messageById[messageId]
    if (!message) continue
    observeSeq(message.order)
    for (const segmentId of message.segmentIds) {
      observeSeq(state.messagePartsById[segmentId]?.order)
    }
  }

  for (const tool of state.toolCalls) {
    observeSeq(tool.order)
  }

  for (const taskRun of state.taskRuns) {
    observeSeq(taskRun.order)
    for (const segment of taskRun.transcript) observeSeq(segment.order)
    for (const tool of taskRun.toolCalls) observeSeq(tool.order)
    for (const notice of taskRun.compactions) observeSeq(notice.order)
  }

  for (const notice of state.compactions) observeSeq(notice.order)
  for (const approval of state.pendingApprovals) observeSeq(approval.order)
  for (const error of state.errors) observeSeq(error.order)
}

export function createEmptySessionViewState(overrides: Partial<SessionViewState> = {}): SessionViewState {
  return {
    ...createEmptyMessageState(),
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens: cloneTokens(EMPTY_SESSION_TOKENS),
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    hydrated: false,
    revision: 0,
    lastViewedAt: nowTs(),
    lastEventAt: 0,
    ...overrides,
  }
}

export function getOrCreateSessionState(sessionStateById: Record<string, SessionViewState>, sessionId: string) {
  return sessionStateById[sessionId] ?? createEmptySessionViewState()
}

export function pruneSessionDetailCache(
  sessionStateById: Record<string, SessionViewState>,
  currentSessionId: string | null,
  busySessions: Set<string>,
) {
  const keep = new Set<string>()
  if (currentSessionId) keep.add(currentSessionId)
  for (const sessionId of busySessions) keep.add(sessionId)

  const warmCandidates = Object.entries(sessionStateById)
    .filter(([, state]) => state.hydrated)
    .filter(([sessionId]) => !keep.has(sessionId))
    .sort((a, b) => b[1].lastViewedAt - a[1].lastViewedAt)

  for (const [sessionId] of warmCandidates.slice(0, MAX_WARM_SESSION_DETAILS)) {
    keep.add(sessionId)
  }

  let changed = false
  const next = { ...sessionStateById }
  for (const [sessionId, state] of Object.entries(sessionStateById)) {
    if (keep.has(sessionId) || !state.hydrated) continue
    next[sessionId] = createEmptySessionViewState({
      hydrated: false,
      revision: state.revision,
      lastViewedAt: state.lastViewedAt,
      lastEventAt: state.lastEventAt,
    })
    changed = true
  }

  return changed ? next : sessionStateById
}

export function deriveVisibleSessionPatch(
  state: SessionViewState,
  currentSessionId: string | null,
  busySessions: Set<string>,
  awaitingPermissionSessions: Set<string>,
): SessionView {
  const messages = buildMessages(state.messageIds, state.messageById, state.messagePartsById)
  const isBusy = currentSessionId ? busySessions.has(currentSessionId) : false
  const isAwaitingPermission = currentSessionId ? awaitingPermissionSessions.has(currentSessionId) : false
  const isAwaitingQuestion = state.pendingQuestions.length > 0
  const taskRuns = ensureTaskRunTimingsForView(state.taskRuns, state.lastEventAt)
  const executionPlan = deriveExecutionPlan(taskRuns, isBusy)

  return {
    messages,
    toolCalls: state.toolCalls,
    taskRuns,
    compactions: state.compactions,
    pendingApprovals: state.pendingApprovals,
    pendingQuestions: state.pendingQuestions,
    errors: state.errors,
    todos: state.todos,
    executionPlan,
    sessionCost: state.sessionCost,
    sessionTokens: cloneTokens(state.sessionTokens),
    lastInputTokens: state.lastInputTokens,
    contextState: state.contextState,
    compactionCount: state.compactionCount,
    lastCompactedAt: state.lastCompactedAt,
    activeAgent: state.activeAgent,
    lastItemWasTool: state.lastItemWasTool,
    revision: state.revision,
    lastEventAt: state.lastEventAt,
    isGenerating: isBusy && !isAwaitingPermission && !isAwaitingQuestion,
    isAwaitingPermission,
    isAwaitingQuestion,
  }
}

function mergeStreamingStateFromExisting(next: SessionViewState, existing: SessionViewState) {
  let messageState: MessageStateShape = {
    messageIds: next.messageIds,
    messageById: next.messageById,
    messagePartsById: next.messagePartsById,
  }

  for (const messageId of existing.messageIds) {
    const existingMessage = existing.messageById[messageId]
    if (!existingMessage) continue
    const nextMessage = messageState.messageById[messageId]
    if (!nextMessage) {
      // If the existing message is a live placeholder and `next` already has
      // a real message of the same role, the placeholder was absorbed during
      // history application — re-importing it would create a duplicate bubble.
      // Skip. The real message is the truth.
      if (
        isLivePlaceholderMessageId(existingMessage.id, existingMessage.role)
        && nextHasRealMessageOfRole(messageState, existingMessage.role)
      ) {
        continue
      }
      const segments = buildMessageSegments(existingMessage, existing.messagePartsById)
      if (segments.length === 0) continue
      messageState = importMessage(messageState, {
        id: existingMessage.id,
        role: existingMessage.role,
        attachments: existingMessage.attachments,
        segments,
        content: renderMessageSegments(segments),
        order: existingMessage.order,
      })
      continue
    }

    const messageById = { ...messageState.messageById }
    const messagePartsById = { ...messageState.messagePartsById }
    const segmentIds = nextMessage.segmentIds.slice()

    for (const segmentId of existingMessage.segmentIds) {
      const existingSegment = existing.messagePartsById[segmentId]
      if (!existingSegment) continue
      const nextSegment = messagePartsById[segmentId]
      if (!nextSegment) {
        segmentIds.push(segmentId)
        messagePartsById[segmentId] = { ...existingSegment }
        continue
      }
      const content = preferNewerStreamingText(nextSegment.content, existingSegment.content)
      if (content !== nextSegment.content) {
        messagePartsById[segmentId] = {
          ...nextSegment,
          content,
        }
      }
    }

    messageById[messageId] = {
      ...nextMessage,
      attachments: nextMessage.attachments ?? existingMessage.attachments,
      segmentIds,
    }
    messageState = {
      messageIds: messageState.messageIds,
      messageById,
      messagePartsById,
    }
  }

  next.messageIds = messageState.messageIds
  next.messageById = messageState.messageById
  next.messagePartsById = messageState.messagePartsById

  const nextTaskRuns = next.taskRuns.map((taskRun) => ({
    ...taskRun,
    transcript: taskRun.transcript.map((segment) => ({ ...segment })),
  }))

  for (const existingTaskRun of existing.taskRuns) {
    const nextIndex = nextTaskRuns.findIndex((taskRun) => taskRun.id === existingTaskRun.id)
    if (nextIndex === -1) {
      if (existingTaskRun.transcript.length === 0 && !existingTaskRun.content) continue
      nextTaskRuns.push({
        ...existingTaskRun,
        toolCalls: existingTaskRun.toolCalls.map((tool) => ({ ...tool })),
        compactions: existingTaskRun.compactions.map(cloneCompactionNotice),
        transcript: existingTaskRun.transcript.map((segment) => ({ ...segment })),
        todos: existingTaskRun.todos.map((todo) => ({ ...todo })),
        sessionTokens: cloneTokens(existingTaskRun.sessionTokens),
      })
      continue
    }

    const nextTaskRun = nextTaskRuns[nextIndex]
    const transcript = nextTaskRun.transcript.slice()
    for (const existingSegment of existingTaskRun.transcript) {
      const segmentIndex = transcript.findIndex((segment) => segment.id === existingSegment.id)
      if (segmentIndex === -1) {
        transcript.push({ ...existingSegment })
        continue
      }
      const currentSegment = transcript[segmentIndex]
      const content = preferNewerStreamingText(currentSegment.content, existingSegment.content)
      if (content !== currentSegment.content) {
        transcript[segmentIndex] = {
          ...currentSegment,
          content,
        }
      }
    }

    // Preserve live-streamed timing. If the existing task had a startedAt
    // (we observed it running) but the hydrated next task lost it — because
    // the history projector emits task_run events without timing metadata —
    // carry the existing values forward. Otherwise the clock would silently
    // disappear the moment a running task completes and the hydration path
    // rebuilds its record.
    nextTaskRuns[nextIndex] = {
      ...nextTaskRun,
      transcript,
      content: renderTaskTranscript(transcript),
      startedAt: nextTaskRun.startedAt ?? existingTaskRun.startedAt ?? null,
      finishedAt: nextTaskRun.finishedAt ?? existingTaskRun.finishedAt ?? null,
    }
  }

  next.taskRuns = nextTaskRuns
}

export function buildSessionStateFromItems(
  items: HistoryItem[],
  existing?: SessionViewState,
  options?: { preserveStreamingState?: boolean },
) {
  const next = createEmptySessionViewState({
    hydrated: true,
    pendingApprovals: existing?.pendingApprovals || [],
    pendingQuestions: existing?.pendingQuestions || [],
    errors: existing?.errors || [],
    todos: existing?.todos || [],
    executionPlan: existing?.executionPlan || [],
    activeAgent: existing?.activeAgent || null,
    revision: (existing?.revision || 0) + 1,
    lastViewedAt: nowTs(),
    lastEventAt: existing?.lastEventAt || 0,
  })

  for (const item of items) {
    if (item.type === 'task_run' && item.taskRun) {
      next.taskRuns = upsertTaskRunList(next.taskRuns, {
        id: item.id,
        title: item.taskRun.title,
        agent: item.taskRun.agent,
        status: item.taskRun.status,
        sourceSessionId: item.taskRun.sourceSessionId,
        parentSessionId: item.taskRun.parentSessionId,
        startedAt: item.taskRun.startedAt,
        finishedAt: item.taskRun.finishedAt,
      })
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'todos' && item.todos) {
      next.todos = item.todos
      continue
    }

    if (item.type === 'task_todos' && item.taskRunId && item.todos) {
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => ({
        ...taskRun,
        todos: item.todos || [],
      }))
      continue
    }

    if (item.type === 'task_compaction' && item.taskRunId && item.compaction) {
      const compaction = item.compaction
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => ({
        ...taskRun,
        compactions: finishCompactionNotice(taskRun.compactions, {
          id: item.id,
          auto: compaction.auto,
          overflow: compaction.overflow,
          sourceSessionId: compaction.sourceSessionId || taskRun.sourceSessionId,
        }),
      }))
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'task_text' && item.taskRunId) {
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => ({
        ...withTaskTranscript(taskRun, item.partId || item.messageId || item.id, item.content || '', { replace: true }),
      }))
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'task_tool' && item.taskRunId && item.tool) {
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => {
        const existingTool = taskRun.toolCalls.find((tool) => tool.id === item.id)
        const toolCall: ToolCall = {
          id: item.id,
          name: item.tool?.name || 'tool',
          input: item.tool?.input || {},
          status: (item.tool?.status as ToolCall['status']) || 'running',
          output: item.tool?.output,
          attachments: item.tool?.attachments,
          agent: item.tool?.agent || taskRun.agent,
          sourceSessionId: item.tool?.sourceSessionId || taskRun.sourceSessionId,
          order: existingTool?.order ?? nextSeq(),
        }

        return {
          ...taskRun,
          toolCalls: existingTool
            ? taskRun.toolCalls.map((tool) => tool.id === item.id ? { ...tool, ...toolCall } : tool)
            : [...taskRun.toolCalls, toolCall],
        }
      })
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'task_cost' && item.taskRunId && item.cost) {
      next.sessionCost += item.cost.cost
      next.sessionTokens = {
        input: next.sessionTokens.input + item.cost.tokens.input,
        output: next.sessionTokens.output + item.cost.tokens.output,
        reasoning: next.sessionTokens.reasoning + item.cost.tokens.reasoning,
        cacheRead: next.sessionTokens.cacheRead + item.cost.tokens.cache.read,
        cacheWrite: next.sessionTokens.cacheWrite + item.cost.tokens.cache.write,
      }
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => ({
        ...taskRun,
        sessionCost: taskRun.sessionCost + item.cost!.cost,
        sessionTokens: {
          input: taskRun.sessionTokens.input + item.cost!.tokens.input,
          output: taskRun.sessionTokens.output + item.cost!.tokens.output,
          reasoning: taskRun.sessionTokens.reasoning + item.cost!.tokens.reasoning,
          cacheRead: taskRun.sessionTokens.cacheRead + item.cost!.tokens.cache.read,
          cacheWrite: taskRun.sessionTokens.cacheWrite + item.cost!.tokens.cache.write,
        },
      }))
      continue
    }

    if (item.type === 'compaction' && item.compaction) {
      next.compactions = finishCompactionNotice(next.compactions, {
        id: item.id,
        auto: item.compaction.auto,
        overflow: item.compaction.overflow,
        sourceSessionId: item.compaction.sourceSessionId || null,
      })
      next.contextState = item.compaction.status
      next.compactionCount += item.compaction.status === 'compacted' ? 1 : 0
      next.lastCompactedAt = item.timestamp || next.lastCompactedAt
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'tool' && item.tool) {
      next.toolCalls.push({
        id: item.id,
        name: item.tool.name,
        input: item.tool.input,
        status: item.tool.status as ToolCall['status'],
        output: item.tool.output,
        attachments: item.tool.attachments,
        agent: item.tool.agent,
        sourceSessionId: item.tool.sourceSessionId,
        order: nextSeq(),
      })
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'cost' && item.cost) {
      next.sessionCost += item.cost.cost
      next.lastInputTokens = item.cost.tokens.input > 0 ? item.cost.tokens.input : next.lastInputTokens
      if (item.cost.tokens.input > 0) {
        next.contextState = 'measured'
      }
      next.sessionTokens = {
        input: next.sessionTokens.input + item.cost.tokens.input,
        output: next.sessionTokens.output + item.cost.tokens.output,
        reasoning: next.sessionTokens.reasoning + item.cost.tokens.reasoning,
        cacheRead: next.sessionTokens.cacheRead + item.cost.tokens.cache.read,
        cacheWrite: next.sessionTokens.cacheWrite + item.cost.tokens.cache.write,
      }
      continue
    }

    Object.assign(next, withMessageText(next, {
      messageId: item.messageId || item.id,
      role: (item.role || 'assistant') as 'user' | 'assistant',
      content: item.content || '',
      segmentId: item.partId || item.id,
      timestamp: item.timestamp,
      providerId: item.providerId || null,
      modelId: item.modelId || null,
      replace: true,
    }))
    next.lastItemWasTool = false
  }

  if (existing?.messageIds.length) {
    Object.assign(next, mergeMissingUserMessages(next, existing))
  }
  if (options?.preserveStreamingState && existing) {
    mergeStreamingStateFromExisting(next, existing)
  }

  return next
}

export function refreshContextState(current: SessionViewState) {
  return hasPendingCompactions(current.taskRuns, current.compactions)
    ? 'compacting'
    : current.compactionCount > 0
      ? 'compacted'
      : current.contextState
}

export function buildSessionStateFromView(view: SessionView, existing?: SessionViewState) {
  const next = createEmptySessionViewState({
    hydrated: true,
    pendingApprovals: view.pendingApprovals || [],
    pendingQuestions: view.pendingQuestions || [],
    errors: view.errors || [],
    todos: view.todos || [],
    executionPlan: view.executionPlan || [],
    activeAgent: view.activeAgent || null,
    revision: view.revision ?? ((existing?.revision || 0) + 1),
    lastViewedAt: nowTs(),
    lastEventAt: view.lastEventAt ?? existing?.lastEventAt ?? 0,
    sessionCost: view.sessionCost || 0,
    sessionTokens: cloneTokens(view.sessionTokens || EMPTY_SESSION_TOKENS),
    lastInputTokens: view.lastInputTokens || 0,
    contextState: view.contextState || 'idle',
    compactionCount: view.compactionCount || 0,
    lastCompactedAt: view.lastCompactedAt || null,
    lastItemWasTool: view.lastItemWasTool || false,
  })

  let messageState: MessageStateShape = next
  for (const message of view.messages || []) {
    messageState = importMessage(messageState, message)
  }

  Object.assign(next, messageState)
  next.toolCalls = (view.toolCalls || []).map((tool) => ({ ...tool }))
  next.taskRuns = (view.taskRuns || []).map((taskRun) => ({
    ...taskRun,
    toolCalls: taskRun.toolCalls.map((tool) => ({ ...tool })),
    compactions: taskRun.compactions.map(cloneCompactionNotice),
    transcript: taskRun.transcript.map((segment) => ({ ...segment })),
    todos: taskRun.todos.map((todo) => ({ ...todo })),
    sessionTokens: cloneTokens(taskRun.sessionTokens),
  }))
  next.compactions = (view.compactions || []).map(cloneCompactionNotice)
  if (existing && existing.lastEventAt > next.lastEventAt) {
    mergeStreamingStateFromExisting(next, existing)
  }
  syncSessionSequence(next)
  return next
}
