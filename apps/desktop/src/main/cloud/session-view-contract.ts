import type {
  Message,
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
import type {
  CloudSessionMessage,
  CloudSessionProjectionView,
  CloudSessionView,
} from './session-service.ts'

const EMPTY_TOKENS: SessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function isCloudSessionMessage(value: unknown): value is CloudSessionMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<CloudSessionMessage>
  return typeof record.id === 'string'
    && (record.role === 'user' || record.role === 'assistant' || record.role === 'system')
    && typeof record.content === 'string'
}

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ToolCall>
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && (record.status === 'running' || record.status === 'complete' || record.status === 'error')
}

function isTaskRun(value: unknown): value is TaskRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<TaskRun>
  return typeof record.id === 'string'
    && typeof record.title === 'string'
    && (record.status === 'queued' || record.status === 'running' || record.status === 'complete' || record.status === 'error')
}

function isPendingApproval(value: unknown): value is PendingApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<PendingApproval>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.tool === 'string'
}

function isPendingQuestion(value: unknown): value is PendingQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<PendingQuestion>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && Array.isArray(record.questions)
}

function isTodoItem(value: unknown): value is TodoItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<TodoItem>
  return typeof record.content === 'string'
}

function isSessionError(value: unknown): value is SessionError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<SessionError>
  return typeof record.id === 'string' && typeof record.message === 'string'
}

function isSessionArtifact(value: unknown): value is SessionArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<SessionArtifact>
  return typeof record.id === 'string'
    && typeof record.filePath === 'string'
    && typeof record.filename === 'string'
}

function readSessionTokens(value: unknown): SessionTokens {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_TOKENS }
  const record = value as Partial<SessionTokens>
  return {
    input: typeof record.input === 'number' ? record.input : 0,
    output: typeof record.output === 'number' ? record.output : 0,
    reasoning: typeof record.reasoning === 'number' ? record.reasoning : 0,
    cacheRead: typeof record.cacheRead === 'number' ? record.cacheRead : 0,
    cacheWrite: typeof record.cacheWrite === 'number' ? record.cacheWrite : 0,
  }
}

export function readCloudSessionProjection(view: CloudSessionView): CloudSessionProjectionView | null {
  const raw = view.projection?.view
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Partial<CloudSessionProjectionView>
  if (typeof record.sessionId !== 'string') return null
  if (!Array.isArray(record.messages)) return null
  return {
    sessionId: record.sessionId,
    title: typeof record.title === 'string' && record.title.trim() ? record.title : view.session.title || 'New session',
    status: record.status === 'running' || record.status === 'closed' || record.status === 'errored' ? record.status : 'idle',
    profileName: typeof record.profileName === 'string' && record.profileName ? record.profileName : view.session.profileName,
    isGenerating: Boolean(record.isGenerating),
    messages: record.messages.filter(isCloudSessionMessage),
    toolCalls: Array.isArray(record.toolCalls) ? record.toolCalls.filter(isToolCall) : [],
    taskRuns: Array.isArray(record.taskRuns) ? record.taskRuns.filter(isTaskRun) : [],
    pendingApprovals: Array.isArray(record.pendingApprovals) ? record.pendingApprovals.filter(isPendingApproval) : [],
    pendingQuestions: Array.isArray(record.pendingQuestions) ? record.pendingQuestions.filter(isPendingQuestion) : [],
    artifacts: Array.isArray(record.artifacts) ? record.artifacts.filter(isSessionArtifact) : [],
    todos: Array.isArray(record.todos) ? record.todos.filter(isTodoItem) : [],
    errors: Array.isArray(record.errors) ? record.errors.filter(isSessionError) : [],
    sessionCost: typeof record.sessionCost === 'number' ? record.sessionCost : 0,
    sessionTokens: readSessionTokens(record.sessionTokens),
    lastInputTokens: typeof record.lastInputTokens === 'number' ? record.lastInputTokens : 0,
    lastError: typeof record.lastError === 'string' && record.lastError ? record.lastError : null,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : view.session.updatedAt,
  }
}

function toMessage(message: CloudSessionMessage, order: number): Message | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.createdAt,
    order,
  }
}

export function emptySessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    messages: [],
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
    sessionTokens: { ...EMPTY_TOKENS },
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 0,
    lastEventAt: 0,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
    ...overrides,
  }
}

export function cloudSessionViewToSessionView(view: CloudSessionView): SessionView {
  const projection = readCloudSessionProjection(view)
  if (!projection) return emptySessionView()
  const messages = projection.messages
    .map((message, index) => toMessage(message, index + 1))
    .filter((message): message is Message => Boolean(message))
  return emptySessionView({
    messages,
    toolCalls: projection.toolCalls,
    taskRuns: projection.taskRuns,
    pendingApprovals: projection.pendingApprovals,
    pendingQuestions: projection.pendingQuestions,
    artifacts: projection.artifacts,
    todos: projection.todos,
    errors: projection.errors.length > 0
      ? projection.errors
      : projection.lastError
        ? [{
            id: `${projection.sessionId}:cloud-error`,
            sessionId: projection.sessionId,
            message: projection.lastError,
            order: messages.length + 1,
          }]
        : [],
    sessionCost: projection.sessionCost,
    sessionTokens: projection.sessionTokens,
    lastInputTokens: projection.lastInputTokens,
    revision: view.projection?.sequence || 0,
    lastEventAt: view.projection?.sequence || 0,
    isGenerating: projection.isGenerating && projection.pendingApprovals.length === 0 && projection.pendingQuestions.length === 0,
    isAwaitingPermission: projection.pendingApprovals.length > 0,
    isAwaitingQuestion: projection.pendingQuestions.length > 0,
  })
}
