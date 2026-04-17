import type {
  CompactionNotice,
  ExecutionPlanItem,
  Message,
  MessageAttachment,
  MessageSegment,
  PendingApproval,
  PendingQuestion,
  SessionError,
  SessionTokens,
  SessionView,
  TaskRun,
  TaskTranscriptSegment,
  TodoItem,
  ToolCall,
} from '@open-cowork/shared'

let seq = 0

const LIVE_ASSISTANT_MESSAGE_SUFFIX = ':assistant:live'
const LIVE_ASSISTANT_SEGMENT_SUFFIX = ':segment:live'
const LIVE_USER_MESSAGE_SUFFIX = ':user:live'
const LIVE_USER_SEGMENT_SUFFIX = ':user:segment:live'

export const LIVE_USER_MESSAGE_SUFFIX_PUBLIC = LIVE_USER_MESSAGE_SUFFIX
export const LIVE_USER_SEGMENT_SUFFIX_PUBLIC = LIVE_USER_SEGMENT_SUFFIX

export function nextSeq() {
  return ++seq
}

function observeSeq(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  seq = Math.max(seq, value)
}

export function nowTs() {
  return Date.now()
}

export const MAX_WARM_SESSION_DETAILS = 12

export const EMPTY_SESSION_TOKENS: SessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

interface MessageEntity {
  id: string
  role: 'user' | 'assistant'
  attachments?: MessageAttachment[]
  timestamp?: string | null
  providerId?: string | null
  modelId?: string | null
  segmentIds: string[]
  order: number
}

interface MessagePartEntity {
  id: string
  content: string
  order: number
}

type MessageStateShape = Pick<SessionViewState, 'messageIds' | 'messageById' | 'messagePartsById'>

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

export function cloneTokens(tokens: SessionTokens): SessionTokens {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
  }
}

export function cloneCompactionNotice(notice: CompactionNotice): CompactionNotice {
  return {
    id: notice.id,
    status: notice.status,
    auto: notice.auto,
    overflow: notice.overflow,
    sourceSessionId: notice.sourceSessionId || null,
    order: notice.order,
  }
}

function hasPendingCompactions(taskRuns: TaskRun[], compactions: CompactionNotice[]) {
  return compactions.some((notice) => notice.status === 'compacting')
    || taskRuns.some((taskRun) => taskRun.compactions.some((notice) => notice.status === 'compacting'))
}

export function beginCompactionNotice(
  notices: CompactionNotice[],
  input: { id?: string; sourceSessionId?: string | null; auto?: boolean; overflow?: boolean },
): CompactionNotice[] {
  const id = input.id || crypto.randomUUID()
  const existing = notices.find((notice) => notice.id === id)
  if (existing) {
    return notices.map((notice) => notice.id === id
      ? {
          ...notice,
          status: 'compacting' as const,
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
      status: 'compacting' as const,
      auto: input.auto ?? true,
      overflow: input.overflow ?? false,
      sourceSessionId: input.sourceSessionId ?? null,
      order: nextSeq(),
    },
  ]
}

export function finishCompactionNotice(
  notices: CompactionNotice[],
  input: { id?: string; sourceSessionId?: string | null; auto?: boolean; overflow?: boolean },
): CompactionNotice[] {
  if (input.id) {
    const existing = notices.find((notice) => notice.id === input.id)
    if (existing) {
      return notices.map((notice) => notice.id === input.id
        ? {
            ...notice,
            status: 'compacted' as const,
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
          status: 'compacted' as const,
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
      status: 'compacted' as const,
      auto: input.auto ?? true,
      overflow: input.overflow ?? false,
      sourceSessionId: input.sourceSessionId ?? null,
      order: nextSeq(),
    },
  ]
}

export function mergeStreamingText(existing: string, incoming: string) {
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

function livePlaceholderMessageSuffix(role: 'user' | 'assistant') {
  return role === 'assistant' ? LIVE_ASSISTANT_MESSAGE_SUFFIX : LIVE_USER_MESSAGE_SUFFIX
}

function livePlaceholderSegmentSuffix(role: 'user' | 'assistant') {
  return role === 'assistant' ? LIVE_ASSISTANT_SEGMENT_SUFFIX : LIVE_USER_SEGMENT_SUFFIX
}

function isLivePlaceholderMessageId(messageId: string, role: 'user' | 'assistant') {
  return messageId.endsWith(livePlaceholderMessageSuffix(role))
}

function isLivePlaceholderSegmentId(segmentId: string, role: 'user' | 'assistant') {
  return segmentId.endsWith(livePlaceholderSegmentSuffix(role))
}

// Retained for the assistant-specific latest-message-id lookup below.
function isLiveAssistantMessageId(messageId: string) {
  return isLivePlaceholderMessageId(messageId, 'assistant')
}

function resolveIncomingLiveMessageId(
  state: MessageStateShape,
  input: { messageId: string; role: 'user' | 'assistant' },
) {
  // Only assistant-role placeholders get merged into the latest real assistant
  // message. User-role placeholders are always distinct per prompt and are
  // absorbed separately by moveLivePlaceholderStateToMessage below.
  if (input.role !== 'assistant' || !isLiveAssistantMessageId(input.messageId)) {
    return input.messageId
  }

  const latestMessageId = state.messageIds.at(-1)
  if (!latestMessageId) return input.messageId

  const latestMessage = state.messageById[latestMessageId]
  if (!latestMessage || latestMessage.role !== 'assistant') return input.messageId
  if (isLiveAssistantMessageId(latestMessage.id)) return input.messageId
  return latestMessage.id
}

function moveLivePlaceholderStateToMessage(
  state: MessageStateShape,
  input: {
    messageId: string
    segmentId: string
    role: 'user' | 'assistant'
    attachments?: MessageAttachment[]
    timestamp?: string | null
    providerId?: string | null
    modelId?: string | null
  },
) {
  if (isLivePlaceholderMessageId(input.messageId, input.role)) {
    return state
  }

  const liveMessageId = state.messageIds.find((messageId) => {
    const message = state.messageById[messageId]
    return Boolean(
      message
      && message.role === input.role
      && isLivePlaceholderMessageId(message.id, input.role)
      && message.id !== input.messageId,
    )
  })

  if (!liveMessageId) return state

  const liveMessage = state.messageById[liveMessageId]
  if (!liveMessage) return state

  const messageIds = state.messageIds
    .map((messageId) => (messageId === liveMessageId ? input.messageId : messageId))
    .filter((messageId, index, all) => all.indexOf(messageId) === index)
  const messageById = { ...state.messageById }
  const messagePartsById = { ...state.messagePartsById }
  const liveSegmentIds = liveMessage.segmentIds.slice()

  if (liveSegmentIds.length === 1 && isLivePlaceholderSegmentId(liveSegmentIds[0], input.role) && liveSegmentIds[0] !== input.segmentId) {
    const liveSegment = messagePartsById[liveSegmentIds[0]]
    if (liveSegment) {
      const targetSegment = messagePartsById[input.segmentId]
      messagePartsById[input.segmentId] = targetSegment
        ? {
            ...targetSegment,
            order: Math.min(targetSegment.order, liveSegment.order),
            content: preferNewerStreamingText(targetSegment.content, liveSegment.content),
          }
        : {
            ...liveSegment,
            id: input.segmentId,
          }
      delete messagePartsById[liveSegmentIds[0]]
      liveSegmentIds[0] = input.segmentId
    }
  }

  const existingTarget = messageById[input.messageId]
  if (existingTarget) {
    const segmentIds = existingTarget.segmentIds.slice()
    for (const segmentId of liveSegmentIds) {
      const liveSegment = messagePartsById[segmentId]
      if (!liveSegment) continue
      const targetSegment = messagePartsById[segmentId]
      if (targetSegment && targetSegment !== liveSegment) {
        messagePartsById[segmentId] = {
          ...targetSegment,
          order: Math.min(targetSegment.order, liveSegment.order),
          content: preferNewerStreamingText(targetSegment.content, liveSegment.content),
        }
      } else if (!targetSegment) {
        messagePartsById[segmentId] = { ...liveSegment }
      }
      if (!segmentIds.includes(segmentId)) segmentIds.push(segmentId)
    }

    messageById[input.messageId] = {
      ...existingTarget,
      attachments: existingTarget.attachments ?? input.attachments ?? liveMessage.attachments,
      timestamp: existingTarget.timestamp ?? input.timestamp ?? liveMessage.timestamp ?? null,
      providerId: existingTarget.providerId ?? input.providerId ?? liveMessage.providerId ?? null,
      modelId: existingTarget.modelId ?? input.modelId ?? liveMessage.modelId ?? null,
      segmentIds,
      order: Math.min(existingTarget.order, liveMessage.order),
    }
  } else {
    messageById[input.messageId] = {
      ...liveMessage,
      id: input.messageId,
      attachments: input.attachments ?? liveMessage.attachments,
      timestamp: input.timestamp ?? liveMessage.timestamp ?? null,
      providerId: input.providerId ?? liveMessage.providerId ?? null,
      modelId: input.modelId ?? liveMessage.modelId ?? null,
      segmentIds: liveSegmentIds,
    }
  }

  delete messageById[liveMessageId]

  return {
    messageIds,
    messageById,
    messagePartsById,
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

  if (separated) {
    return `${existing}${incoming}`
  }

  return `${existing}\n\n${incoming}`
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
  let alreadySorted = true
  for (let index = 1; index < segments.length; index += 1) {
    if ((segments[index - 1]?.order || 0) > (segments[index]?.order || 0)) {
      alreadySorted = false
      break
    }
  }
  if (alreadySorted) return segments
  return segments.slice().sort((a, b) => a.order - b.order)
}

function renderMessageSegments(segments: MessageSegment[]) {
  return sortMessageSegments(segments)
    .map((segment) => segment.content)
    .filter(Boolean)
    .join('')
}

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
  const messages: Message[] = []
  for (const messageId of messageIds) {
    const message = messageById[messageId]
    if (!message) continue
    const segments = buildMessageSegments(message, messagePartsById)
    messages.push({
      id: message.id,
      role: message.role,
      attachments: message.attachments,
      segments,
      content: renderMessageSegments(segments),
      timestamp: message.timestamp || null,
      providerId: message.providerId || null,
      modelId: message.modelId || null,
      order: message.order,
    })
  }
  return messages
}

function createEmptyMessageState(): MessageStateShape {
  return {
    messageIds: [],
    messageById: {},
    messagePartsById: {},
  }
}

export function importMessage(
  state: MessageStateShape,
  message: Message,
) {
  observeSeq(message.order)
  const messageIds = state.messageIds.includes(message.id)
    ? state.messageIds.slice()
    : [...state.messageIds, message.id]
  const messageById = {
    ...state.messageById,
    [message.id]: {
      id: message.id,
      role: message.role,
      attachments: message.attachments,
      timestamp: message.timestamp || null,
      providerId: message.providerId || null,
      modelId: message.modelId || null,
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
    observeSeq(segment.order)
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

export function withMessageText(
  state: MessageStateShape,
  input: {
    messageId: string
    role: 'user' | 'assistant'
    content: string
    segmentId: string
    attachments?: MessageAttachment[]
    timestamp?: string | null
    providerId?: string | null
    modelId?: string | null
    replace?: boolean
  },
) {
  const resolvedMessageId = resolveIncomingLiveMessageId(state, input)
  const normalizedInput = {
    ...input,
    messageId: resolvedMessageId,
  }
  const reconciledState = moveLivePlaceholderStateToMessage(state, normalizedInput)

  const messageIds = reconciledState.messageIds.slice()
  const messageById = { ...reconciledState.messageById }
  const messagePartsById = { ...reconciledState.messagePartsById }

  const existingMessage = messageById[normalizedInput.messageId]
  if (!existingMessage) {
    messageById[normalizedInput.messageId] = {
      id: normalizedInput.messageId,
      role: normalizedInput.role,
      attachments: normalizedInput.attachments,
      timestamp: normalizedInput.timestamp || new Date(nowTs()).toISOString(),
      providerId: normalizedInput.providerId || null,
      modelId: normalizedInput.modelId || null,
      segmentIds: normalizedInput.content ? [normalizedInput.segmentId] : [],
      order: nextSeq(),
    }
    messageIds.push(normalizedInput.messageId)
    if (normalizedInput.content) {
      messagePartsById[normalizedInput.segmentId] = {
        id: normalizedInput.segmentId,
        content: normalizedInput.content,
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
  const existingSegment = messagePartsById[normalizedInput.segmentId]
  if (!existingSegment) {
    if (normalizedInput.content) {
      segmentIds.push(normalizedInput.segmentId)
      messagePartsById[normalizedInput.segmentId] = {
        id: normalizedInput.segmentId,
        content: normalizedInput.content,
        order: nextSeq(),
      }
    }
  } else {
    messagePartsById[normalizedInput.segmentId] = {
      ...existingSegment,
      content: normalizedInput.replace
        ? normalizedInput.content
        : mergeStreamingText(existingSegment.content, normalizedInput.content),
    }
  }

  messageById[normalizedInput.messageId] = {
    ...existingMessage,
    role: normalizedInput.role,
    attachments: normalizedInput.attachments ?? existingMessage.attachments,
    timestamp: normalizedInput.timestamp ?? existingMessage.timestamp ?? null,
    providerId: normalizedInput.providerId ?? existingMessage.providerId ?? null,
    modelId: normalizedInput.modelId ?? existingMessage.modelId ?? null,
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

export function withTaskTranscript(
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

export function createEmptyTaskRun(input: {
  id: string
  title?: string
  agent?: string | null
  status?: TaskRun['status']
  sourceSessionId?: string | null
  parentSessionId?: string | null
  content?: string
  transcript?: TaskTranscriptSegment[]
  toolCalls?: ToolCall[]
  compactions?: CompactionNotice[]
  todos?: TodoItem[]
  error?: string | null
  sessionCost?: number
  sessionTokens?: SessionTokens
  order?: number
  startedAt?: string | null
  finishedAt?: string | null
}): TaskRun {
  const transcript = input.transcript
    ? input.transcript
    : input.content
      ? [{ id: `${input.id}:initial`, content: input.content, order: nextSeq() }]
      : []
  observeSeq(input.order)
  for (const segment of transcript) observeSeq(segment.order)
  for (const tool of input.toolCalls || []) observeSeq(tool.order)
  for (const notice of input.compactions || []) observeSeq(notice.order)

  const status = input.status || 'queued'
  const nowIso = new Date(nowTs()).toISOString()

  return {
    id: input.id,
    title: input.title || 'Sub-Agent',
    agent: input.agent || null,
    status,
    sourceSessionId: input.sourceSessionId || null,
    parentSessionId: input.parentSessionId ?? null,
    content: input.content || renderTaskTranscript(transcript),
    transcript,
    toolCalls: input.toolCalls || [],
    compactions: (input.compactions || []).map(cloneCompactionNotice),
    todos: input.todos || [],
    error: input.error || null,
    sessionCost: input.sessionCost || 0,
    sessionTokens: cloneTokens(input.sessionTokens || EMPTY_SESSION_TOKENS),
    order: input.order ?? nextSeq(),
    startedAt: input.startedAt ?? (status === 'running' ? nowIso : null),
    finishedAt: input.finishedAt ?? (status === 'complete' || status === 'error' ? nowIso : null),
  }
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

export function upsertTaskRunList(taskRuns: TaskRun[], input: {
  id: string
  title?: string
  agent?: string | null
  status?: TaskRun['status']
  sourceSessionId?: string | null
  parentSessionId?: string | null
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

  return taskRuns.map((taskRun) => {
    if (taskRun.id !== input.id) return taskRun
    const incoming = input as TaskRun & { startedAt?: string | null; finishedAt?: string | null }
    const nextStatus = input.status !== undefined ? input.status : taskRun.status
    const nowIso = new Date(nowTs()).toISOString()
    // Precedence: explicit caller-provided timestamp → existing task timestamp
    // → derived from status transition. This keeps the clock stable across
    // snapshots and lets callers override when they know better.
    const startedAt = incoming.startedAt
      ?? taskRun.startedAt
      ?? (nextStatus === 'running' ? nowIso : null)
    const finishedAt = incoming.finishedAt
      ?? taskRun.finishedAt
      ?? ((nextStatus === 'complete' || nextStatus === 'error') ? nowIso : null)
    return {
      ...taskRun,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
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
      startedAt,
      finishedAt,
    }
  })
}

export function withTaskRun(taskRuns: TaskRun[], taskRunId: string, updater: (taskRun: TaskRun) => TaskRun) {
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

// Defensive backfill: guarantee every task run has a startedAt so the
// renderer's ElapsedClock always has an anchor.
// - Running tasks without startedAt get the state's lastEventAt (the most
//   recent activity we observed for this session).
// - Terminal tasks (complete / error) that somehow landed without
//   startedAt but have finishedAt use finishedAt as startedAt so the
//   finished clock still renders ("ran 0s") instead of silently vanishing.
function ensureTaskRunTimingsForView(taskRuns: TaskRun[], lastEventAt: number): TaskRun[] {
  let patched = false
  const runningAnchor = lastEventAt > 0 ? new Date(lastEventAt).toISOString() : new Date(nowTs()).toISOString()
  const next = taskRuns.map((taskRun) => {
    if (taskRun.startedAt) return taskRun
    if (taskRun.status === 'running') {
      patched = true
      return { ...taskRun, startedAt: runningAnchor }
    }
    if ((taskRun.status === 'complete' || taskRun.status === 'error') && taskRun.finishedAt) {
      patched = true
      return { ...taskRun, startedAt: taskRun.finishedAt }
    }
    return taskRun
  })
  return patched ? next : taskRuns
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

function preferNewerStreamingText(snapshotContent: string, existingContent: string) {
  if (!existingContent) return snapshotContent
  if (!snapshotContent) return existingContent
  if (snapshotContent === existingContent) return snapshotContent
  if (snapshotContent.startsWith(existingContent)) return snapshotContent
  if (existingContent.startsWith(snapshotContent)) return existingContent
  return existingContent
}

function nextHasRealMessageOfRole(next: MessageStateShape, role: 'user' | 'assistant') {
  for (const id of next.messageIds) {
    const message = next.messageById[id]
    if (!message) continue
    if (message.role !== role) continue
    if (!isLivePlaceholderMessageId(id, role)) return true
  }
  return false
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
