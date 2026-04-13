import { create } from 'zustand'

let seq = 0
function nextSeq() { return ++seq }
function nowTs() { return Date.now() }

const MAX_WARM_SESSION_DETAILS = 12

export interface MessageAttachment {
  mime: string
  url: string
  filename: string
}

export interface MessageSegment {
  id: string
  content: string
  order: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: MessageAttachment[]
  segments?: MessageSegment[]
  order: number
}

interface MessageEntity {
  id: string
  role: 'user' | 'assistant'
  attachments?: MessageAttachment[]
  segmentIds: string[]
  order: number
}

interface MessagePartEntity {
  id: string
  content: string
  order: number
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'complete' | 'error'
  output?: unknown
  attachments?: Array<{ mime: string; url: string; filename?: string }>
  agent?: string | null
  sourceSessionId?: string | null
  order: number
}

export interface CompactionNotice {
  id: string
  status: 'compacting' | 'compacted'
  auto: boolean
  overflow: boolean
  sourceSessionId?: string | null
  order: number
}

export interface TaskTranscriptSegment {
  id: string
  content: string
  order: number
}

export interface TaskRun {
  id: string
  title: string
  agent: string | null
  status: 'queued' | 'running' | 'complete' | 'error'
  sourceSessionId: string | null
  content: string
  transcript: TaskTranscriptSegment[]
  toolCalls: ToolCall[]
  compactions: CompactionNotice[]
  todos: TodoItem[]
  error: string | null
  sessionCost: number
  sessionTokens: SessionTokens
  order: number
}

export interface PendingApproval {
  id: string
  sessionId: string
  taskRunId?: string | null
  tool: string
  input: Record<string, unknown>
  description: string
  order: number
}

export interface SessionError {
  id: string
  sessionId: string | null
  message: string
  order: number
}

export interface Session {
  id: string
  title?: string
  directory?: string | null
  createdAt: string
  updatedAt: string
}

export interface McpConnection {
  name: string
  connected: boolean
  rawStatus?: string
}

type SessionTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type TodoItem = { content: string; status: string; priority: string; id?: string }
export type ExecutionPlanItem = { content: string; status: string; priority: string; id?: string }

export type HistoryItem = {
  type?: string
  id: string
  role?: string
  content?: string
  messageId?: string
  partId?: string
  timestamp: string
  taskRunId?: string
  taskRun?: {
    title: string
    agent: string | null
    status: TaskRun['status']
    sourceSessionId: string | null
  }
  todos?: TodoItem[]
  tool?: {
    name: string
    input: Record<string, unknown>
    status: string
    output?: unknown
    attachments?: Array<{ mime: string; url: string; filename?: string }>
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

interface SessionStore {
  sessions: Session[]
  currentSessionId: string | null
  setSessions: (sessions: Session[]) => void
  setCurrentSession: (id: string | null) => void
  addSession: (session: Session) => void
  renameSession: (id: string, title: string) => void
  removeSession: (id: string) => void
  isSessionHydrated: (id: string) => boolean
  getSessionRevision: (id: string) => number
  hydrateSessionFromItems: (sessionId: string, items: HistoryItem[], force?: boolean) => void

  messages: Message[]
  addMessage: (sessionId: string, message: Omit<Message, 'order'>) => void
  appendMessageText: (
    sessionId: string,
    messageId: string,
    content: string,
    segmentId?: string,
    role?: 'user' | 'assistant',
    options?: { replace?: boolean },
  ) => void
  clearMessages: () => void

  toolCalls: ToolCall[]
  addToolCall: (sessionId: string, call: Omit<ToolCall, 'order'>) => void
  updateToolCall: (sessionId: string, id: string, update: Partial<ToolCall>) => void

  taskRuns: TaskRun[]
  upsertTaskRun: (sessionId: string, taskRun: Omit<TaskRun, 'content' | 'transcript' | 'toolCalls' | 'todos' | 'error' | 'sessionCost' | 'sessionTokens' | 'order'> & Partial<Pick<TaskRun, 'content' | 'transcript' | 'toolCalls' | 'todos' | 'error' | 'sessionCost' | 'sessionTokens' | 'order'>>) => void
  appendTaskText: (
    sessionId: string,
    taskRunId: string,
    content: string,
    messageId?: string,
    options?: { replace?: boolean; boundary?: boolean },
  ) => void
  updateTaskToolCall: (sessionId: string, taskRunId: string, id: string, update: Partial<ToolCall>) => void
  beginCompaction: (sessionId: string, input: { id?: string; taskRunId?: string | null; sourceSessionId?: string | null; auto?: boolean; overflow?: boolean }) => void
  finishCompaction: (sessionId: string, input: { id?: string; taskRunId?: string | null; sourceSessionId?: string | null; auto?: boolean; overflow?: boolean; completedAt?: string | null }) => void
  setTaskTodos: (sessionId: string, taskRunId: string, todos: TodoItem[]) => void
  addTaskCost: (sessionId: string, taskRunId: string, cost: number, tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) => void
  addTaskError: (sessionId: string, taskRunId: string, message: string) => void

  pendingApprovals: PendingApproval[]
  addApproval: (approval: Omit<PendingApproval, 'order'>) => void
  removeApproval: (id: string) => void

  errors: SessionError[]
  addError: (sessionId: string | null, message: string) => void

  mcpConnections: McpConnection[]
  setMcpConnections: (connections: McpConnection[]) => void

  agentMode: 'assistant' | 'plan'
  setAgentMode: (mode: 'assistant' | 'plan') => void

  todos: TodoItem[]
  executionPlan: ExecutionPlanItem[]
  setTodos: (sessionId: string, todos: TodoItem[]) => void

  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number
  compactions: CompactionNotice[]
  contextState: 'idle' | 'measured' | 'compacting' | 'compacted'
  compactionCount: number
  lastCompactedAt: string | null
  totalCost: number
  addCost: (sessionId: string, cost: number, tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) => void
  resetSessionCost: () => void
  resetLastInputTokens: (sessionId: string) => void

  sidebarCollapsed: boolean
  toggleSidebar: () => void
  isGenerating: boolean
  isAwaitingPermission: boolean
  setIsGenerating: (v: boolean) => void
  activeAgent: string | null
  setActiveAgent: (sessionId: string, name: string | null) => void

  busySessions: Set<string>
  awaitingPermissionSessions: Set<string>
  addBusy: (id: string) => void
  removeBusy: (id: string) => void
  setAwaitingPermission: (id: string, value: boolean) => void

  lastItemWasTool: boolean

  sessionStateById: Record<string, SessionViewState>
}

const EMPTY_SESSION_TOKENS: SessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function cloneTokens(tokens: SessionTokens): SessionTokens {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
  }
}

function cloneCompactionNotice(notice: CompactionNotice): CompactionNotice {
  return {
    id: notice.id,
    status: notice.status,
    auto: notice.auto,
    overflow: notice.overflow,
    sourceSessionId: notice.sourceSessionId || null,
    order: notice.order,
  }
}

function completedCompactionCount(compactions: CompactionNotice[]) {
  return compactions.filter((notice) => notice.status === 'compacted').length
}

function hasPendingCompactions(taskRuns: TaskRun[], compactions: CompactionNotice[]) {
  return compactions.some((notice) => notice.status === 'compacting')
    || taskRuns.some((taskRun) => taskRun.compactions.some((notice) => notice.status === 'compacting'))
}

function beginCompactionNotice(
  notices: CompactionNotice[],
  input: { id?: string; sourceSessionId?: string | null; auto?: boolean; overflow?: boolean },
) {
  const id = input.id || crypto.randomUUID()
  const existing = notices.find((notice) => notice.id === id)
  if (existing) {
    return notices.map((notice) => notice.id === id
      ? {
          ...notice,
          status: 'compacting',
          auto: input.auto ?? notice.auto,
          overflow: input.overflow ?? notice.overflow,
          sourceSessionId: input.sourceSessionId ?? notice.sourceSessionId ?? null,
        }
      : notice)
  }

  return [
    ...notices,
    {
      id,
      status: 'compacting',
      auto: input.auto ?? true,
      overflow: input.overflow ?? false,
      sourceSessionId: input.sourceSessionId ?? null,
      order: nextSeq(),
    },
  ]
}

function finishCompactionNotice(
  notices: CompactionNotice[],
  input: { id?: string; sourceSessionId?: string | null; auto?: boolean; overflow?: boolean },
) {
  if (input.id) {
    const existing = notices.find((notice) => notice.id === input.id)
    if (existing) {
      return notices.map((notice) => notice.id === input.id
        ? {
            ...notice,
            status: 'compacted',
            auto: input.auto ?? notice.auto,
            overflow: input.overflow ?? notice.overflow,
            sourceSessionId: input.sourceSessionId ?? notice.sourceSessionId ?? null,
          }
        : notice)
    }
  }

  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index]
    if (notice.status !== 'compacting') continue
    if (input.sourceSessionId && notice.sourceSessionId && notice.sourceSessionId !== input.sourceSessionId) continue
    return notices.map((entry, entryIndex) => entryIndex === index
      ? {
          ...entry,
          status: 'compacted',
          auto: input.auto ?? entry.auto,
          overflow: input.overflow ?? entry.overflow,
          sourceSessionId: input.sourceSessionId ?? entry.sourceSessionId ?? null,
        }
      : entry)
  }

  return [
    ...notices,
    {
      id: input.id || crypto.randomUUID(),
      status: 'compacted',
      auto: input.auto ?? true,
      overflow: input.overflow ?? false,
      sourceSessionId: input.sourceSessionId ?? null,
      order: nextSeq(),
    },
  ]
}

function createEmptyTaskRun(input: {
  id: string
  title?: string
  agent?: string | null
  status?: TaskRun['status']
  sourceSessionId?: string | null
  content?: string
  transcript?: TaskTranscriptSegment[]
  toolCalls?: ToolCall[]
  compactions?: CompactionNotice[]
  todos?: TodoItem[]
  error?: string | null
  sessionCost?: number
  sessionTokens?: SessionTokens
  order?: number
}): TaskRun {
  const transcript = input.transcript
    ? input.transcript
    : input.content
      ? [{ id: `${input.id}:initial`, content: input.content, order: nextSeq() }]
      : []

  return {
    id: input.id,
    title: input.title || 'Sub-Agent',
    agent: input.agent || null,
    status: input.status || 'queued',
    sourceSessionId: input.sourceSessionId || null,
    content: input.content || renderTaskTranscript(transcript),
    transcript,
    toolCalls: input.toolCalls || [],
    compactions: (input.compactions || []).map(cloneCompactionNotice),
    todos: input.todos || [],
    error: input.error || null,
    sessionCost: input.sessionCost || 0,
    sessionTokens: cloneTokens(input.sessionTokens || EMPTY_SESSION_TOKENS),
    order: input.order ?? nextSeq(),
  }
}

function appendTaskTranscript(existing: string, incoming: string, options?: { boundary?: boolean }) {
  if (!incoming) return existing
  if (!existing) return incoming

  const boundary = options?.boundary
    || /^(#{1,6}\s|[-*]\s|\d+\.\s|>|\n)/.test(incoming)
  const separated = existing.endsWith('\n') || incoming.startsWith('\n')

  if (!boundary) {
    return mergeStreamingText(existing, incoming)
  }

  if (!boundary || separated) {
    return `${existing}${incoming}`
  }

  return `${existing}\n\n${incoming}`
}

function mergeStreamingText(existing: string, incoming: string) {
  if (!existing) return incoming
  if (!incoming) return existing
  if (incoming === existing) return existing
  if (incoming.startsWith(existing)) return incoming
  if (existing.endsWith(incoming)) return existing

  const maxOverlap = Math.min(existing.length, incoming.length)
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return `${existing}${incoming.slice(overlap)}`
    }
  }

  return `${existing}${incoming}`
}

function sortTaskTranscript(transcript: TaskTranscriptSegment[]) {
  return transcript.slice().sort((a, b) => a.order - b.order)
}

function renderTaskTranscript(transcript: TaskTranscriptSegment[]) {
  return sortTaskTranscript(transcript)
    .map((segment) => segment.content)
    .filter(Boolean)
    .join('\n\n')
}

function sortMessageSegments(segments: MessageSegment[]) {
  return segments.slice().sort((a, b) => a.order - b.order)
}

function renderMessageSegments(segments: MessageSegment[]) {
  return sortMessageSegments(segments)
    .map((segment) => segment.content)
    .filter(Boolean)
    .join('')
}

type MessageStateShape = Pick<SessionViewState, 'messageIds' | 'messageById' | 'messagePartsById'>

function buildMessageSegments(
  message: MessageEntity,
  messagePartsById: Record<string, MessagePartEntity>,
): MessageSegment[] {
  return message.segmentIds
    .map((segmentId) => messagePartsById[segmentId])
    .filter((segment): segment is MessagePartEntity => Boolean(segment))
    .sort((a, b) => a.order - b.order)
    .map((segment) => ({
      id: segment.id,
      content: segment.content,
      order: segment.order,
    }))
}

export function buildMessages(
  messageIds: string[],
  messageById: Record<string, MessageEntity>,
  messagePartsById: Record<string, MessagePartEntity>,
): Message[] {
  return messageIds
    .map((messageId) => {
      const message = messageById[messageId]
      if (!message) return null
      const segments = buildMessageSegments(message, messagePartsById)
      return {
        id: message.id,
        role: message.role,
        attachments: message.attachments,
        segments,
        content: renderMessageSegments(segments),
        order: message.order,
      }
    })
    .filter((message): message is Message => Boolean(message))
    .sort((a, b) => a.order - b.order)
}

function createEmptyMessageState(): MessageStateShape {
  return {
    messageIds: [],
    messageById: {},
    messagePartsById: {},
  }
}

function importMessage(
  state: MessageStateShape,
  message: Message,
) {
  const messageIds = state.messageIds.includes(message.id)
    ? state.messageIds.slice()
    : [...state.messageIds, message.id]
  const messageById = {
    ...state.messageById,
    [message.id]: {
      id: message.id,
      role: message.role,
      attachments: message.attachments,
      segmentIds: (message.segments && message.segments.length > 0)
        ? message.segments.map((segment) => segment.id)
        : (message.content ? [`${message.id}:initial`] : []),
      order: message.order,
    },
  }
  const messagePartsById = { ...state.messagePartsById }
  const sourceSegments = message.segments && message.segments.length > 0
    ? message.segments
    : (message.content
      ? [{ id: `${message.id}:initial`, content: message.content, order: message.order }]
      : [])

  for (const segment of sourceSegments) {
    messagePartsById[segment.id] = {
      id: segment.id,
      content: segment.content,
      order: segment.order,
    }
  }

  messageIds.sort((left, right) => (messageById[left]?.order || 0) - (messageById[right]?.order || 0))

  return {
    messageIds,
    messageById,
    messagePartsById,
  }
}

function withMessageText(
  state: MessageStateShape,
  input: {
    messageId: string
    role: 'user' | 'assistant'
    content: string
    segmentId: string
    attachments?: MessageAttachment[]
    replace?: boolean
  },
) {
  const messageIds = state.messageIds.slice()
  const messageById = { ...state.messageById }
  const messagePartsById = { ...state.messagePartsById }

  const existingMessage = messageById[input.messageId]
  if (!existingMessage) {
    messageById[input.messageId] = {
      id: input.messageId,
      role: input.role,
      attachments: input.attachments,
      segmentIds: input.content ? [input.segmentId] : [],
      order: nextSeq(),
    }
    messageIds.push(input.messageId)
    if (input.content) {
      messagePartsById[input.segmentId] = {
        id: input.segmentId,
        content: input.content,
        order: nextSeq(),
      }
    }
    return {
      messageIds,
      messageById,
      messagePartsById,
    }
  }

  const segmentIds = existingMessage.segmentIds.slice()
  const existingSegment = messagePartsById[input.segmentId]
  if (!existingSegment) {
    if (input.content) {
      segmentIds.push(input.segmentId)
      messagePartsById[input.segmentId] = {
        id: input.segmentId,
        content: input.content,
        order: nextSeq(),
      }
    }
  } else {
    messagePartsById[input.segmentId] = {
      ...existingSegment,
      content: input.replace ? input.content : mergeStreamingText(existingSegment.content, input.content),
    }
  }

  messageById[input.messageId] = {
    ...existingMessage,
    role: input.role,
    attachments: input.attachments ?? existingMessage.attachments,
    segmentIds,
  }

  return {
    messageIds,
    messageById,
    messagePartsById,
  }
}

function mergeMissingUserMessages(next: MessageStateShape, existing: MessageStateShape) {
  const nextMessages = buildMessages(next.messageIds, next.messageById, next.messagePartsById)
  const existingMessages = buildMessages(existing.messageIds, existing.messageById, existing.messagePartsById)
  const nextHasUser = nextMessages.some((message) => message.role === 'user')
  if (nextHasUser) return next

  const existingUsers = existingMessages
    .filter((message) => message.role === 'user' && message.content.trim().length > 0)
    .filter((message) => !nextMessages.some((nextMessage) => nextMessage.id === message.id))

  if (existingUsers.length === 0) return next

  let merged = next
  for (const message of existingUsers) {
    merged = importMessage(merged, message)
  }
  return merged
}

function appendTaskTranscriptSegment(
  transcript: TaskTranscriptSegment[],
  segmentId: string,
  incoming: string,
  options?: { boundary?: boolean; replace?: boolean },
) {
  if (!incoming) return transcript

  const existing = transcript.find((segment) => segment.id === segmentId)
  if (!existing) {
    return [...transcript, { id: segmentId, content: incoming, order: nextSeq() }]
  }

  return transcript.map((segment) => segment.id === segmentId
    ? {
        ...segment,
        content: options?.replace ? incoming : appendTaskTranscript(segment.content, incoming, options),
      }
    : segment)
}

function withTaskTranscript(
  taskRun: TaskRun,
  segmentId: string,
  incoming: string,
  options?: { boundary?: boolean; replace?: boolean },
) {
  const transcript = appendTaskTranscriptSegment(taskRun.transcript, segmentId, incoming, options)
  return {
    ...taskRun,
    transcript,
    content: renderTaskTranscript(transcript),
  }
}

function upsertTaskRunList(taskRuns: TaskRun[], input: {
  id: string
  title?: string
  agent?: string | null
  status?: TaskRun['status']
  sourceSessionId?: string | null
  content?: string
  transcript?: TaskTranscriptSegment[]
  toolCalls?: ToolCall[]
  compactions?: CompactionNotice[]
  todos?: TodoItem[]
  error?: string | null
  sessionCost?: number
  sessionTokens?: SessionTokens
  order?: number
}) {
  const existing = taskRuns.find((taskRun) => taskRun.id === input.id)
  if (!existing) {
    return [...taskRuns, createEmptyTaskRun(input)]
  }

  return taskRuns.map((taskRun) => taskRun.id === input.id
    ? {
        ...taskRun,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.transcript !== undefined
          ? {
              transcript: input.transcript,
              content: input.content !== undefined ? input.content : renderTaskTranscript(input.transcript),
            }
          : {}),
        ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
        ...(input.compactions !== undefined ? { compactions: input.compactions.map(cloneCompactionNotice) } : {}),
        ...(input.todos !== undefined ? { todos: input.todos } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.sessionCost !== undefined ? { sessionCost: input.sessionCost } : {}),
        ...(input.sessionTokens !== undefined ? { sessionTokens: cloneTokens(input.sessionTokens) } : {}),
      }
    : taskRun)
}

function withTaskRun(taskRuns: TaskRun[], taskRunId: string, updater: (taskRun: TaskRun) => TaskRun) {
  const existing = taskRuns.find((taskRun) => taskRun.id === taskRunId) || createEmptyTaskRun({ id: taskRunId })
  const next = updater(existing)
  return upsertTaskRunList(taskRuns, next)
}

function deriveExecutionPlan(taskRuns: TaskRun[], busy: boolean): ExecutionPlanItem[] {
  if (taskRuns.length === 0) return []

  const orderedTaskRuns = taskRuns.slice().sort((a, b) => a.order - b.order)
  const anyError = orderedTaskRuns.some((taskRun) => taskRun.status === 'error')
  const allComplete = orderedTaskRuns.every((taskRun) => taskRun.status === 'complete')

  const synthStatus = anyError
    ? 'blocked'
    : allComplete
      ? (busy ? 'in_progress' : 'completed')
      : 'pending'

  return [
    {
      id: 'execution:launch',
      content: `Launch ${orderedTaskRuns.length} sub-agent branch${orderedTaskRuns.length === 1 ? '' : 'es'}`,
      status: 'completed',
      priority: 'high',
    },
    ...orderedTaskRuns.map((taskRun) => ({
      id: `execution:${taskRun.id}`,
      content: taskRun.title,
      status: taskRun.status === 'complete'
        ? 'completed'
        : taskRun.status === 'error'
          ? 'blocked'
          : taskRun.status === 'queued'
            ? 'pending'
            : 'in_progress',
      priority: 'medium',
    })),
    {
      id: 'execution:synthesize',
      content: 'Synthesize the final answer',
      status: synthStatus,
      priority: 'high',
    },
  ]
}

export function createEmptySessionViewState(overrides: Partial<SessionViewState> = {}): SessionViewState {
  return {
    ...createEmptyMessageState(),
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
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

function getOrCreateSessionState(sessionStateById: Record<string, SessionViewState>, sessionId: string) {
  return sessionStateById[sessionId] ?? createEmptySessionViewState()
}

function snapshotVisibleState(state: SessionStore, existing: SessionViewState | undefined, hydrated: boolean): SessionViewState {
  return {
    messageIds: existing?.messageIds || [],
    messageById: existing?.messageById || {},
    messagePartsById: existing?.messagePartsById || {},
    toolCalls: state.toolCalls,
    taskRuns: state.taskRuns,
    compactions: state.compactions,
    pendingApprovals: state.currentSessionId
      ? state.pendingApprovals.filter((approval) => approval.sessionId === state.currentSessionId)
      : [],
    errors: state.currentSessionId
      ? state.errors.filter((error) => error.sessionId === state.currentSessionId)
      : [],
    todos: existing?.todos || state.todos,
    executionPlan: existing?.executionPlan || state.executionPlan,
    sessionCost: state.sessionCost,
    sessionTokens: cloneTokens(state.sessionTokens),
    lastInputTokens: state.lastInputTokens,
    contextState: state.contextState,
    compactionCount: state.compactionCount,
    lastCompactedAt: state.lastCompactedAt,
    activeAgent: state.activeAgent,
    lastItemWasTool: state.lastItemWasTool,
    hydrated,
    revision: existing?.revision || 0,
    lastViewedAt: existing?.lastViewedAt || nowTs(),
    lastEventAt: existing?.lastEventAt || 0,
  }
}

function pruneSessionDetailCache(
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
) {
  const messages = buildMessages(state.messageIds, state.messageById, state.messagePartsById)
  const isBusy = currentSessionId ? busySessions.has(currentSessionId) : false
  const isAwaitingPermission = currentSessionId ? awaitingPermissionSessions.has(currentSessionId) : false
  const executionPlan = deriveExecutionPlan(state.taskRuns, isBusy)

  return {
    messages,
    toolCalls: state.toolCalls,
    taskRuns: state.taskRuns,
    compactions: state.compactions,
    pendingApprovals: state.pendingApprovals,
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
    isGenerating: isBusy && !isAwaitingPermission,
    isAwaitingPermission,
  }
}

export function buildSessionStateFromItems(items: HistoryItem[], existing?: SessionViewState) {
  const next = createEmptySessionViewState({
    hydrated: true,
    pendingApprovals: existing?.pendingApprovals || [],
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
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => ({
        ...taskRun,
        compactions: finishCompactionNotice(taskRun.compactions, {
          id: item.id,
          auto: item.compaction.auto,
          overflow: item.compaction.overflow,
          sourceSessionId: item.compaction.sourceSessionId || taskRun.sourceSessionId,
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
      replace: true,
    }))
    next.lastItemWasTool = false
  }

  if (existing?.messageIds.length) {
    Object.assign(next, mergeMissingUserMessages(next, existing))
  }

  return next
}

function updateSessionState(
  state: SessionStore,
  sessionId: string,
  updater: (current: SessionViewState) => SessionViewState,
) {
  const sessionStateById = { ...state.sessionStateById }
  const current = getOrCreateSessionState(sessionStateById, sessionId)
  const updated = updater(current)
  const next = {
    ...updated,
    revision: current.revision + 1,
    lastEventAt: nowTs(),
  }
  sessionStateById[sessionId] = next
  const prunedSessionStateById = pruneSessionDetailCache(sessionStateById, state.currentSessionId, state.busySessions)

  const patch: Partial<SessionStore> = { sessionStateById: prunedSessionStateById }
  if (state.currentSessionId === sessionId) {
    const visibleState = prunedSessionStateById[sessionId] || next
    Object.assign(patch, deriveVisibleSessionPatch(visibleState, sessionId, state.busySessions, state.awaitingPermissionSessions))
  }
  return patch
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (id) => set((state) => {
    let sessionStateById = { ...state.sessionStateById }

    if (state.currentSessionId) {
      const existing = sessionStateById[state.currentSessionId]
      sessionStateById[state.currentSessionId] = snapshotVisibleState(state, existing, existing?.hydrated ?? false)
    }

    if (!id) {
      const empty = createEmptySessionViewState()
      return {
        sessionStateById,
        currentSessionId: null,
        ...deriveVisibleSessionPatch(empty, null, state.busySessions, state.awaitingPermissionSessions),
      }
    }

    const next = getOrCreateSessionState(sessionStateById, id)
    sessionStateById[id] = {
      ...next,
      lastViewedAt: nowTs(),
    }
    sessionStateById = pruneSessionDetailCache(sessionStateById, id, state.busySessions)

    return {
      sessionStateById,
      currentSessionId: id,
      ...deriveVisibleSessionPatch(sessionStateById[id], id, state.busySessions, state.awaitingPermissionSessions),
    }
  }),
  addSession: (session) => set((state) => ({
    sessions: [session, ...state.sessions],
  })),
  renameSession: (id, title) => set((state) => ({
    sessions: state.sessions.map((session) => (session.id === id ? { ...session, title } : session)),
  })),
  removeSession: (id) => set((state) => {
    const sessionStateById = { ...state.sessionStateById }
    delete sessionStateById[id]

    const patch: Partial<SessionStore> = {
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionStateById,
    }

    if (state.currentSessionId === id) {
      const empty = createEmptySessionViewState()
      Object.assign(patch, {
        currentSessionId: null,
        ...deriveVisibleSessionPatch(empty, null, state.busySessions, state.awaitingPermissionSessions),
      })
    }

    return patch
  }),
  isSessionHydrated: (id) => !!get().sessionStateById[id]?.hydrated,
  getSessionRevision: (id) => get().sessionStateById[id]?.revision || 0,
  hydrateSessionFromItems: (sessionId, items, force = false) => set((state) => {
    const existing = state.sessionStateById[sessionId]
    if (existing?.hydrated && !force) {
      return {}
    }

    const next = buildSessionStateFromItems(items, existing)
    const sessionStateById = pruneSessionDetailCache(
      { ...state.sessionStateById, [sessionId]: next },
      state.currentSessionId,
      state.busySessions,
    )
    const patch: Partial<SessionStore> = { sessionStateById }
    if (state.currentSessionId === sessionId) {
      Object.assign(patch, deriveVisibleSessionPatch(sessionStateById[sessionId], sessionId, state.busySessions, state.awaitingPermissionSessions))
    }
    return patch
  }),

  messages: [],
  addMessage: (sessionId, message) => set((state) =>
    updateSessionState(state, sessionId, (current) => {
      const order = nextSeq()
      return {
        ...current,
        ...importMessage({
          messageIds: current.messageIds,
          messageById: current.messageById,
          messagePartsById: current.messagePartsById,
        }, {
          ...message,
          segments: message.content
            ? [{ id: `${message.id}:initial`, content: message.content, order: nextSeq() }]
            : [],
          order,
        }),
        lastItemWasTool: false,
      }
    }),
  ),
  appendMessageText: (sessionId, messageId, content, segmentId, role = 'assistant', options) => set((state) =>
    updateSessionState(state, sessionId, (current) => {
      return {
        ...current,
        ...withMessageText(current, {
          messageId,
          role,
          content,
          segmentId: segmentId || messageId,
          replace: options?.replace,
        }),
        lastItemWasTool: false,
      }
    }),
  ),
  clearMessages: () => set((state) => {
    if (!state.currentSessionId) return {}
    return updateSessionState(state, state.currentSessionId, (current) =>
      createEmptySessionViewState({ hydrated: current.hydrated }),
    )
  }),

  toolCalls: [],
  addToolCall: (sessionId, call) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      toolCalls: [...current.toolCalls, { ...call, order: nextSeq() }],
      lastItemWasTool: true,
    })),
  ),
  updateToolCall: (sessionId, id, update) => set((state) =>
    updateSessionState(state, sessionId, (current) => {
      const existing = current.toolCalls.find((tool) => tool.id === id)
      if (!existing) {
        return {
          ...current,
          toolCalls: [
            ...current.toolCalls,
            {
              id,
              name: (update.name as string) || 'tool',
              input: (update.input as Record<string, unknown>) || {},
              status: (update.status as ToolCall['status']) || 'running',
              output: update.output,
              attachments: update.attachments,
              agent: update.agent,
              sourceSessionId: update.sourceSessionId,
              order: nextSeq(),
            },
          ],
          lastItemWasTool: true,
        }
      }

      return {
        ...current,
        toolCalls: current.toolCalls.map((tool) => (tool.id === id ? { ...tool, ...update } : tool)),
      }
    }),
  ),

  taskRuns: [],
  upsertTaskRun: (sessionId, taskRun) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      taskRuns: upsertTaskRunList(current.taskRuns, taskRun),
      lastItemWasTool: true,
    })),
  ),
  appendTaskText: (sessionId, taskRunId, content, messageId, options) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      taskRuns: withTaskRun(current.taskRuns, taskRunId, (taskRun) => ({
        ...withTaskTranscript(taskRun, messageId || `${taskRunId}:live`, content, options),
      })),
      lastItemWasTool: true,
    })),
  ),
  updateTaskToolCall: (sessionId, taskRunId, id, update) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      taskRuns: withTaskRun(current.taskRuns, taskRunId, (taskRun) => {
        const existing = taskRun.toolCalls.find((tool) => tool.id === id)
        if (!existing) {
          return {
            ...taskRun,
            toolCalls: [
              ...taskRun.toolCalls,
              {
                id,
                name: (update.name as string) || 'tool',
                input: (update.input as Record<string, unknown>) || {},
                status: (update.status as ToolCall['status']) || 'running',
                output: update.output,
                attachments: update.attachments,
                agent: update.agent || taskRun.agent,
                sourceSessionId: update.sourceSessionId || taskRun.sourceSessionId,
                order: nextSeq(),
              },
            ],
          }
        }

        return {
          ...taskRun,
          toolCalls: taskRun.toolCalls.map((tool) => tool.id === id ? { ...tool, ...update } : tool),
        }
      }),
      lastItemWasTool: true,
    })),
  ),
  beginCompaction: (sessionId, input) => set((state) =>
    updateSessionState(state, sessionId, (current) => {
      const nextTaskRuns = input.taskRunId
        ? withTaskRun(current.taskRuns, input.taskRunId, (taskRun) => ({
            ...taskRun,
            compactions: beginCompactionNotice(taskRun.compactions, {
              id: input.id,
              auto: input.auto,
              overflow: input.overflow,
              sourceSessionId: input.sourceSessionId || taskRun.sourceSessionId,
            }),
          }))
        : current.taskRuns

      const nextCompactions = input.taskRunId
        ? current.compactions
        : beginCompactionNotice(current.compactions, {
            id: input.id,
            auto: input.auto,
            overflow: input.overflow,
            sourceSessionId: input.sourceSessionId || null,
          })

      return {
        ...current,
        taskRuns: nextTaskRuns,
        compactions: nextCompactions,
        contextState: input.taskRunId ? current.contextState : 'compacting',
        lastItemWasTool: true,
      }
    }),
  ),
  finishCompaction: (sessionId, input) => set((state) =>
    updateSessionState(state, sessionId, (current) => {
      const nextTaskRuns = input.taskRunId
        ? withTaskRun(current.taskRuns, input.taskRunId, (taskRun) => ({
            ...taskRun,
            compactions: finishCompactionNotice(taskRun.compactions, {
              id: input.id,
              auto: input.auto,
              overflow: input.overflow,
              sourceSessionId: input.sourceSessionId || taskRun.sourceSessionId,
            }),
          }))
        : current.taskRuns

      const nextCompactions = input.taskRunId
        ? current.compactions
        : finishCompactionNotice(current.compactions, {
            id: input.id,
            auto: input.auto,
            overflow: input.overflow,
            sourceSessionId: input.sourceSessionId || null,
          })
      const nextContextState = hasPendingCompactions(nextTaskRuns, nextCompactions)
        ? 'compacting'
        : 'compacted'

      return {
        ...current,
        taskRuns: nextTaskRuns,
        compactions: nextCompactions,
        contextState: input.taskRunId ? current.contextState : nextContextState,
        compactionCount: input.taskRunId ? current.compactionCount : current.compactionCount + 1,
        lastCompactedAt: input.taskRunId ? current.lastCompactedAt : (input.completedAt || new Date().toISOString()),
        lastItemWasTool: true,
      }
    }),
  ),
  setTaskTodos: (sessionId, taskRunId, todos) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      taskRuns: withTaskRun(current.taskRuns, taskRunId, (taskRun) => ({
        ...taskRun,
        todos,
      })),
    })),
  ),
  addTaskCost: (sessionId, taskRunId, cost, tokens) => set((state) => {
    const totalCost = state.totalCost + cost
    const patch = updateSessionState(state, sessionId, (current) => ({
      ...current,
      sessionCost: current.sessionCost + cost,
      sessionTokens: {
        input: current.sessionTokens.input + tokens.input,
        output: current.sessionTokens.output + tokens.output,
        reasoning: current.sessionTokens.reasoning + tokens.reasoning,
        cacheRead: current.sessionTokens.cacheRead + tokens.cache.read,
        cacheWrite: current.sessionTokens.cacheWrite + tokens.cache.write,
      },
      taskRuns: withTaskRun(current.taskRuns, taskRunId, (taskRun) => ({
        ...taskRun,
        sessionCost: taskRun.sessionCost + cost,
        sessionTokens: {
          input: taskRun.sessionTokens.input + tokens.input,
          output: taskRun.sessionTokens.output + tokens.output,
          reasoning: taskRun.sessionTokens.reasoning + tokens.reasoning,
          cacheRead: taskRun.sessionTokens.cacheRead + tokens.cache.read,
          cacheWrite: taskRun.sessionTokens.cacheWrite + tokens.cache.write,
        },
      })),
    })) as Partial<SessionStore>

    return {
      ...patch,
      totalCost,
    }
  }),
  addTaskError: (sessionId, taskRunId, message) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      taskRuns: withTaskRun(current.taskRuns, taskRunId, (taskRun) => ({
        ...taskRun,
        error: message,
        status: 'error',
      })),
    })),
  ),

  pendingApprovals: [],
  addApproval: (approval) => set((state) =>
    {
      const patch = updateSessionState(state, approval.sessionId, (current) => ({
        ...current,
        pendingApprovals: [...current.pendingApprovals, { ...approval, order: nextSeq() }],
      })) as Partial<SessionStore>

      const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
      awaitingPermissionSessions.add(approval.sessionId)
      patch.awaitingPermissionSessions = awaitingPermissionSessions
      if (state.currentSessionId === approval.sessionId) {
        const current = getOrCreateSessionState(
          (patch.sessionStateById as Record<string, SessionViewState>) || state.sessionStateById,
          approval.sessionId,
        )
      Object.assign(patch, deriveVisibleSessionPatch(current, approval.sessionId, state.busySessions, awaitingPermissionSessions))
      }
      return patch
    },
  ),
  removeApproval: (id) => set((state) => {
    const sessionStateById = { ...state.sessionStateById }
    const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
    for (const [sessionId, sessionState] of Object.entries(sessionStateById)) {
      const nextApprovals = sessionState.pendingApprovals.filter((approval) => approval.id !== id)
      sessionStateById[sessionId] = {
        ...sessionState,
        pendingApprovals: nextApprovals,
      }
      if (nextApprovals.length === 0) {
        awaitingPermissionSessions.delete(sessionId)
      }
    }

    const patch: Partial<SessionStore> = { sessionStateById, awaitingPermissionSessions }
    if (state.currentSessionId) {
      const current = getOrCreateSessionState(sessionStateById, state.currentSessionId)
      Object.assign(patch, deriveVisibleSessionPatch(current, state.currentSessionId, state.busySessions, awaitingPermissionSessions))
    }
    return patch
  }),

  errors: [],
  addError: (sessionId, message) => {
    if (!sessionId) {
      set((state) => ({
        errors: [...state.errors, { id: crypto.randomUUID(), sessionId: null, message, order: nextSeq() }],
      }))
      return
    }

    set((state) =>
      updateSessionState(state, sessionId, (current) => ({
        ...current,
        errors: [...current.errors, { id: crypto.randomUUID(), sessionId, message, order: nextSeq() }],
      })),
    )
  },

  mcpConnections: [],
  setMcpConnections: (connections) => set({ mcpConnections: connections }),

  agentMode: 'assistant',
  setAgentMode: (mode) => set({ agentMode: mode }),

  todos: [],
  executionPlan: [],
  setTodos: (sessionId, todos) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      todos,
    })),
  ),

  sessionCost: 0,
  sessionTokens: cloneTokens(EMPTY_SESSION_TOKENS),
  lastInputTokens: 0,
  compactions: [],
  contextState: 'idle',
  compactionCount: 0,
  lastCompactedAt: null,
  totalCost: 0,
  addCost: (sessionId, cost, tokens) => set((state) => {
    const totalCost = state.totalCost + cost
    const patch = updateSessionState(state, sessionId, (current) => ({
      ...current,
      sessionCost: current.sessionCost + cost,
      lastInputTokens: tokens.input > 0 ? tokens.input : current.lastInputTokens,
      contextState: tokens.input > 0 ? 'measured' : current.contextState,
      sessionTokens: {
        input: current.sessionTokens.input + tokens.input,
        output: current.sessionTokens.output + tokens.output,
        reasoning: current.sessionTokens.reasoning + tokens.reasoning,
        cacheRead: current.sessionTokens.cacheRead + tokens.cache.read,
        cacheWrite: current.sessionTokens.cacheWrite + tokens.cache.write,
      },
    })) as Partial<SessionStore>

    return {
      ...patch,
      totalCost,
    }
  }),
  resetSessionCost: () => set((state) => {
    if (!state.currentSessionId) return {}
    return updateSessionState(state, state.currentSessionId, (current) => ({
      ...current,
      sessionCost: 0,
      sessionTokens: cloneTokens(EMPTY_SESSION_TOKENS),
      lastInputTokens: 0,
      contextState: 'idle',
      compactionCount: 0,
      lastCompactedAt: null,
      compactions: [],
    }))
  }),
  resetLastInputTokens: (sessionId) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      lastInputTokens: 0,
      contextState: 'idle',
    })),
  ),

  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  isGenerating: false,
  isAwaitingPermission: false,
  setIsGenerating: (value) => set((state) => {
    if (!state.currentSessionId) {
      return { isGenerating: value, ...(value ? {} : { activeAgent: null }) }
    }

    const patch = updateSessionState(state, state.currentSessionId, (current) => ({
      ...current,
      activeAgent: value ? current.activeAgent : null,
    })) as Partial<SessionStore>

    return {
      ...patch,
      isGenerating: value,
      ...(value ? {} : { activeAgent: null }),
    }
  }),
  activeAgent: null,
  setActiveAgent: (sessionId, name) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      activeAgent: name,
    })),
  ),

  busySessions: new Set<string>(),
  awaitingPermissionSessions: new Set<string>(),
  addBusy: (id) => set((state) => {
    const busySessions = new Set(state.busySessions)
    busySessions.add(id)
    const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
    awaitingPermissionSessions.delete(id)

    const patch: Partial<SessionStore> = { busySessions, awaitingPermissionSessions }
    if (state.currentSessionId === id) {
      const current = getOrCreateSessionState(state.sessionStateById, id)
      Object.assign(patch, deriveVisibleSessionPatch(current, id, busySessions, awaitingPermissionSessions))
    }
    return patch
  }),
  removeBusy: (id) => set((state) => {
    const busySessions = new Set(state.busySessions)
    busySessions.delete(id)
    const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
    awaitingPermissionSessions.delete(id)

    const patch = updateSessionState(state, id, (current) => ({
      ...current,
      activeAgent: null,
    })) as Partial<SessionStore>

    patch.busySessions = busySessions
    patch.awaitingPermissionSessions = awaitingPermissionSessions
    if (state.currentSessionId === id) {
      const current = getOrCreateSessionState(
        (patch.sessionStateById as Record<string, SessionViewState>) || state.sessionStateById,
        id,
      )
      Object.assign(patch, deriveVisibleSessionPatch(current, id, busySessions, awaitingPermissionSessions))
    }
    return patch
  }),
  setAwaitingPermission: (id, value) => set((state) => {
    const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
    if (value) awaitingPermissionSessions.add(id)
    else awaitingPermissionSessions.delete(id)

    const patch: Partial<SessionStore> = { awaitingPermissionSessions }
    if (state.currentSessionId === id) {
      const current = getOrCreateSessionState(state.sessionStateById, id)
      Object.assign(patch, deriveVisibleSessionPatch(current, id, state.busySessions, awaitingPermissionSessions))
    }
    return patch
  }),

  lastItemWasTool: false,

  sessionStateById: {},
}))
