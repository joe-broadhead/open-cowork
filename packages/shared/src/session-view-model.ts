import type {
  CompactionNotice,
  ExecutionPlanItem,
  MessageAttachment,
  PendingApproval,
  PendingQuestion,
  SessionArtifact,
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
} from './session-view-compaction.js'
import {
  buildMessages,
  createEmptyMessageState,
  importMessage,
  mergeMissingUserMessages,
  withMessageReasoning,
  withMessageText,
  type MessageEntity,
  type MessagePartEntity,
  type MessageStateShape,
} from './session-view-messages.js'
import { nextOrderFrom, nowMsFromTiming, type SessionViewTiming } from './session-view-order.js'
import {
  deriveExecutionPlan,
  ensureTaskRunTimingsForView,
  upsertTaskRunList,
  withTaskReasoning,
  withTaskRun,
  withTaskTranscript,
} from './session-view-task-runs.js'
import { cloneTokens, EMPTY_SESSION_TOKENS } from './session-view-tokens.js'
import { mergeStreamingStateFromExisting } from './session-view-streaming-state.js'

export { beginCompactionNotice, cloneCompactionNotice, finishCompactionNotice } from './session-view-compaction.js'
export {
  buildMessages,
  hasMessageTextSegment,
  hasSplitMessageTextSegment,
  importMessage,
  withMessageReasoning,
  withMessageText,
} from './session-view-messages.js'
export {
  createEmptyTaskRun,
  upsertTaskRunList,
  withTaskReasoning,
  withTaskRun,
  withTaskTranscript,
} from './session-view-task-runs.js'
export { maxSessionViewOrder } from './session-view-sync.js'
export { mergeStreamingText } from './session-view-text.js'
export { cloneTokens, EMPTY_SESSION_TOKENS } from './session-view-tokens.js'

export const MAX_WARM_SESSION_DETAILS = 12

export type HistoryItem = {
  type?: string
  id: string
  role?: string
  content?: string
  messageId?: string
  partId?: string
  timestamp: string
  sequence?: number
  providerId?: string | null
  modelId?: string | null
  taskRunId?: string
  taskRun?: {
    title: string
    agent: string | null
    status: TaskRun['status']
    error?: string | null
    sourceSessionId: string | null
    parentSessionId?: string | null
    startedAt?: string | null
    finishedAt?: string | null
  }
  error?: {
    message: string
    sessionId: string | null
    taskRunId?: string | null
  }
  todos?: TodoItem[]
  tool?: {
    name: string
    input: Record<string, unknown>
    status: string
    output?: unknown
    attachments?: MessageAttachment[]
    outputPaths?: string[]
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

function historyItemOrder(item: HistoryItem) {
  return typeof item.sequence === 'number' && Number.isFinite(item.sequence)
    ? item.sequence
    : undefined
}

function historyItemTiming(
  item: HistoryItem,
  options?: { preserveStreamingState?: boolean } & SessionViewTiming,
) {
  const order = historyItemOrder(item)
  return order === undefined
    ? options
    : {
        ...options,
        order,
        segmentOrder: order,
      }
}

export interface SessionViewState {
  messageIds: string[]
  messageById: Record<string, MessageEntity>
  messagePartsById: Record<string, MessagePartEntity>
  messageReasoningById: Record<string, MessagePartEntity>
  toolCalls: ToolCall[]
  taskRuns: TaskRun[]
  compactions: CompactionNotice[]
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  artifacts: SessionArtifact[]
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

export function createEmptySessionViewState(
  overrides: Partial<SessionViewState> = {},
  timing?: SessionViewTiming,
): SessionViewState {
  return {
    ...createEmptyMessageState(),
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
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
    lastViewedAt: nowMsFromTiming(timing),
    lastEventAt: 0,
    ...overrides,
  }
}

export function getOrCreateSessionState(
  sessionStateById: Record<string, SessionViewState>,
  sessionId: string,
  timing?: SessionViewTiming,
) {
  return sessionStateById[sessionId] ?? createEmptySessionViewState({}, timing)
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
  timing?: SessionViewTiming,
): SessionView {
  const messages = buildMessages(state.messageIds, state.messageById, state.messagePartsById, state.messageReasoningById)
  const isBusy = currentSessionId ? busySessions.has(currentSessionId) : false
  const isAwaitingPermission = currentSessionId ? awaitingPermissionSessions.has(currentSessionId) : false
  const isAwaitingQuestion = state.pendingQuestions.length > 0
  const taskRuns = ensureTaskRunTimingsForView(state.taskRuns, state.lastEventAt, timing)
  const executionPlan = deriveExecutionPlan(taskRuns, isBusy)

  return {
    messages,
    toolCalls: state.toolCalls,
    taskRuns,
    compactions: state.compactions,
    pendingApprovals: state.pendingApprovals,
    pendingQuestions: state.pendingQuestions,
    ...(state.artifacts.length > 0 ? { artifacts: state.artifacts } : {}),
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

export function buildSessionStateFromItems(
  items: HistoryItem[],
  existing?: SessionViewState,
  options?: { preserveStreamingState?: boolean } & SessionViewTiming,
) {
  const next = createEmptySessionViewState({
    hydrated: true,
    pendingApprovals: existing?.pendingApprovals || [],
    pendingQuestions: existing?.pendingQuestions || [],
    artifacts: existing?.artifacts || [],
    errors: existing?.errors || [],
    todos: existing?.todos || [],
    executionPlan: existing?.executionPlan || [],
    activeAgent: existing?.activeAgent || null,
    revision: (existing?.revision || 0) + 1,
    lastViewedAt: nowMsFromTiming(options),
    lastEventAt: existing?.lastEventAt || 0,
  }, options)

  for (const item of items) {
    const itemOrder = historyItemOrder(item)
    const itemTiming = historyItemTiming(item, options)

    if (item.type === 'task_run' && item.taskRun) {
      next.taskRuns = upsertTaskRunList(next.taskRuns, {
        id: item.id,
        title: item.taskRun.title,
        agent: item.taskRun.agent,
        status: item.taskRun.status,
        error: item.taskRun.error,
        sourceSessionId: item.taskRun.sourceSessionId,
        parentSessionId: item.taskRun.parentSessionId,
        startedAt: item.taskRun.startedAt,
        finishedAt: item.taskRun.finishedAt,
        order: itemOrder,
      }, itemTiming)
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'error' && item.error) {
      const sessionError: SessionError = {
        id: item.id,
        sessionId: item.error.sessionId,
        message: item.error.message,
        order: itemOrder ?? nextOrderFrom(next.errors),
      }
      next.errors = [
        ...next.errors.filter((error) => (
          error.id !== sessionError.id
          && (error.sessionId !== sessionError.sessionId || error.message !== sessionError.message)
        )),
        sessionError,
      ]
      const taskRunId = item.error.taskRunId || item.taskRunId
      if (taskRunId) {
        next.taskRuns = withTaskRun(next.taskRuns, taskRunId, (taskRun) => ({
          ...taskRun,
          status: 'error',
          error: sessionError.message,
        }), itemTiming)
      }
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
      }), itemTiming)
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
      }), itemTiming)
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'task_text' && item.taskRunId) {
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => ({
        ...withTaskTranscript(taskRun, item.partId || item.messageId || item.id, item.content || '', {
          replace: true,
          order: itemOrder,
        }),
      }), itemTiming)
      next.lastItemWasTool = true
      continue
    }

    if (item.type === 'task_reasoning' && item.taskRunId) {
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => ({
        ...withTaskReasoning(taskRun, item.partId || item.messageId || item.id, item.content || '', {
          replace: true,
          order: itemOrder,
        }),
      }), itemTiming)
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
          outputPaths: item.tool?.outputPaths,
          agent: item.tool?.agent || taskRun.agent,
          sourceSessionId: item.tool?.sourceSessionId || taskRun.sourceSessionId,
          order: existingTool?.order ?? itemOrder ?? nextOrderFrom(next.toolCalls, taskRun.toolCalls),
        }

        return {
          ...taskRun,
          toolCalls: existingTool
            ? taskRun.toolCalls.map((tool) => tool.id === item.id ? { ...tool, ...toolCall } : tool)
            : [...taskRun.toolCalls, toolCall],
        }
      }, itemTiming)
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
      }), itemTiming)
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
      next.toolCalls = [...next.toolCalls, {
        id: item.id,
        name: item.tool.name,
        input: item.tool.input,
        status: item.tool.status as ToolCall['status'],
        output: item.tool.output,
        attachments: item.tool.attachments,
        outputPaths: item.tool.outputPaths,
        agent: item.tool.agent,
        sourceSessionId: item.tool.sourceSessionId,
        order: itemOrder ?? nextOrderFrom(next.toolCalls),
      }]
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

    if (item.type === 'message_reasoning') {
      Object.assign(next, withMessageReasoning(next, {
        messageId: item.messageId || item.id,
        content: item.content || '',
        segmentId: item.partId || item.id,
        timestamp: item.timestamp,
        replace: true,
      }, itemTiming))
      next.lastItemWasTool = false
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
    }, itemTiming))
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

export function buildSessionStateFromView(view: SessionView, existing?: SessionViewState, timing?: SessionViewTiming) {
  const next = createEmptySessionViewState({
    hydrated: true,
    pendingApprovals: view.pendingApprovals || [],
    pendingQuestions: view.pendingQuestions || [],
    artifacts: view.artifacts || [],
    errors: view.errors || [],
    todos: view.todos || [],
    executionPlan: view.executionPlan || [],
    activeAgent: view.activeAgent || null,
    revision: view.revision ?? ((existing?.revision || 0) + 1),
    lastViewedAt: nowMsFromTiming(timing),
    lastEventAt: view.lastEventAt ?? existing?.lastEventAt ?? 0,
    sessionCost: view.sessionCost || 0,
    sessionTokens: cloneTokens(view.sessionTokens || EMPTY_SESSION_TOKENS),
    lastInputTokens: view.lastInputTokens || 0,
    contextState: view.contextState || 'idle',
    compactionCount: view.compactionCount || 0,
    lastCompactedAt: view.lastCompactedAt || null,
    lastItemWasTool: view.lastItemWasTool || false,
  }, timing)

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
    ...(taskRun.reasoning && taskRun.reasoning.length > 0
      ? { reasoning: taskRun.reasoning.map((segment) => ({ ...segment })) }
      : {}),
    todos: taskRun.todos.map((todo) => ({ ...todo })),
    sessionTokens: cloneTokens(taskRun.sessionTokens),
  }))
  next.compactions = (view.compactions || []).map(cloneCompactionNotice)
  if (existing && existing.lastEventAt > next.lastEventAt) {
    mergeStreamingStateFromExisting(next, existing)
  }
  return next
}
