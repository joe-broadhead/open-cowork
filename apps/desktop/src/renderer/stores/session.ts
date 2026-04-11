import { create } from 'zustand'

let seq = 0
function nextSeq() { return ++seq }

export interface MessageAttachment {
  mime: string
  url: string
  filename: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: MessageAttachment[]
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

type HistoryItem = {
  type?: string
  id: string
  role?: string
  content?: string
  messageId?: string
  timestamp: string
  taskRunId?: string
  taskRun?: {
    title: string
    agent: string | null
    status: TaskRun['status']
    sourceSessionId: string | null
  }
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
}

interface SessionViewState {
  messages: Message[]
  toolCalls: ToolCall[]
  taskRuns: TaskRun[]
  pendingApprovals: PendingApproval[]
  errors: SessionError[]
  todos: TodoItem[]
  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number
  activeAgent: string | null
  lastItemWasTool: boolean
  hydrated: boolean
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
  hydrateSessionFromItems: (sessionId: string, items: HistoryItem[], force?: boolean) => void

  messages: Message[]
  addMessage: (sessionId: string, message: Omit<Message, 'order'>) => void
  appendToLastAssistant: (sessionId: string, content: string) => void
  clearMessages: () => void

  toolCalls: ToolCall[]
  addToolCall: (sessionId: string, call: Omit<ToolCall, 'order'>) => void
  updateToolCall: (sessionId: string, id: string, update: Partial<ToolCall>) => void

  taskRuns: TaskRun[]
  upsertTaskRun: (sessionId: string, taskRun: Omit<TaskRun, 'content' | 'transcript' | 'toolCalls' | 'todos' | 'error' | 'sessionCost' | 'sessionTokens' | 'order'> & Partial<Pick<TaskRun, 'content' | 'transcript' | 'toolCalls' | 'todos' | 'error' | 'sessionCost' | 'sessionTokens' | 'order'>>) => void
  appendTaskText: (sessionId: string, taskRunId: string, content: string, messageId?: string) => void
  updateTaskToolCall: (sessionId: string, taskRunId: string, id: string, update: Partial<ToolCall>) => void
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

  agentMode: 'cowork' | 'plan'
  setAgentMode: (mode: 'cowork' | 'plan') => void

  todos: TodoItem[]
  setTodos: (sessionId: string, todos: TodoItem[]) => void

  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number
  totalCost: number
  addCost: (sessionId: string, cost: number, tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) => void
  resetSessionCost: () => void
  resetLastInputTokens: (sessionId: string) => void

  sidebarCollapsed: boolean
  toggleSidebar: () => void
  isGenerating: boolean
  setIsGenerating: (v: boolean) => void
  activeAgent: string | null
  setActiveAgent: (sessionId: string, name: string | null) => void

  busySessions: Set<string>
  addBusy: (id: string) => void
  removeBusy: (id: string) => void

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

function createEmptyTaskRun(input: {
  id: string
  title?: string
  agent?: string | null
  status?: TaskRun['status']
  sourceSessionId?: string | null
  content?: string
  transcript?: TaskTranscriptSegment[]
  toolCalls?: ToolCall[]
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

  if (!boundary || separated) {
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

function appendTaskTranscriptSegment(
  transcript: TaskTranscriptSegment[],
  segmentId: string,
  incoming: string,
  options?: { boundary?: boolean },
) {
  if (!incoming) return transcript

  const existing = transcript.find((segment) => segment.id === segmentId)
  if (!existing) {
    return [...transcript, { id: segmentId, content: incoming, order: nextSeq() }]
  }

  return transcript.map((segment) => segment.id === segmentId
    ? {
        ...segment,
        content: appendTaskTranscript(segment.content, incoming, options),
      }
    : segment)
}

function withTaskTranscript(
  taskRun: TaskRun,
  segmentId: string,
  incoming: string,
  options?: { boundary?: boolean },
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

function createEmptySessionViewState(overrides: Partial<SessionViewState> = {}): SessionViewState {
  return {
    messages: [],
    toolCalls: [],
    taskRuns: [],
    pendingApprovals: [],
    errors: [],
    todos: [],
    sessionCost: 0,
    sessionTokens: cloneTokens(EMPTY_SESSION_TOKENS),
    lastInputTokens: 0,
    activeAgent: null,
    lastItemWasTool: false,
    hydrated: false,
    ...overrides,
  }
}

function getOrCreateSessionState(sessionStateById: Record<string, SessionViewState>, sessionId: string) {
  return sessionStateById[sessionId] ?? createEmptySessionViewState()
}

function snapshotVisibleState(state: SessionStore, hydrated: boolean): SessionViewState {
  return {
    messages: state.messages,
    toolCalls: state.toolCalls,
    taskRuns: state.taskRuns,
    pendingApprovals: state.currentSessionId
      ? state.pendingApprovals.filter((approval) => approval.sessionId === state.currentSessionId)
      : [],
    errors: state.currentSessionId
      ? state.errors.filter((error) => error.sessionId === state.currentSessionId)
      : [],
    todos: state.todos,
    sessionCost: state.sessionCost,
    sessionTokens: cloneTokens(state.sessionTokens),
    lastInputTokens: state.lastInputTokens,
    activeAgent: state.activeAgent,
    lastItemWasTool: state.lastItemWasTool,
    hydrated,
  }
}

function visiblePatch(state: SessionViewState, currentSessionId: string | null, busySessions: Set<string>) {
  return {
    messages: state.messages,
    toolCalls: state.toolCalls,
    taskRuns: state.taskRuns,
    pendingApprovals: state.pendingApprovals,
    errors: state.errors,
    todos: state.todos,
    sessionCost: state.sessionCost,
    sessionTokens: cloneTokens(state.sessionTokens),
    lastInputTokens: state.lastInputTokens,
    activeAgent: state.activeAgent,
    lastItemWasTool: state.lastItemWasTool,
    isGenerating: currentSessionId ? busySessions.has(currentSessionId) : false,
  }
}

function buildSessionStateFromItems(items: HistoryItem[], existing?: SessionViewState) {
  const next = createEmptySessionViewState({
    hydrated: true,
    pendingApprovals: existing?.pendingApprovals || [],
    errors: existing?.errors || [],
    todos: existing?.todos || [],
    activeAgent: existing?.activeAgent || null,
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

    if (item.type === 'task_text' && item.taskRunId) {
      next.taskRuns = withTaskRun(next.taskRuns, item.taskRunId, (taskRun) => ({
        ...withTaskTranscript(taskRun, item.messageId || item.id, item.content || ''),
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
      next.lastInputTokens = item.cost.tokens.input > 0 ? item.cost.tokens.input : next.lastInputTokens
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
      next.sessionTokens = {
        input: next.sessionTokens.input + item.cost.tokens.input,
        output: next.sessionTokens.output + item.cost.tokens.output,
        reasoning: next.sessionTokens.reasoning + item.cost.tokens.reasoning,
        cacheRead: next.sessionTokens.cacheRead + item.cost.tokens.cache.read,
        cacheWrite: next.sessionTokens.cacheWrite + item.cost.tokens.cache.write,
      }
      continue
    }

    next.messages.push({
      id: item.id,
      role: (item.role || 'assistant') as 'user' | 'assistant',
      content: item.content || '',
      order: nextSeq(),
    })
    next.lastItemWasTool = false
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
  const next = updater(current)
  sessionStateById[sessionId] = next

  const patch: Partial<SessionStore> = { sessionStateById }
  if (state.currentSessionId === sessionId) {
    Object.assign(patch, visiblePatch(next, sessionId, state.busySessions))
  }
  return patch
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (id) => set((state) => {
    const sessionStateById = { ...state.sessionStateById }

    if (state.currentSessionId) {
      const existing = sessionStateById[state.currentSessionId]
      sessionStateById[state.currentSessionId] = snapshotVisibleState(state, existing?.hydrated ?? false)
    }

    if (!id) {
      const empty = createEmptySessionViewState()
      return {
        sessionStateById,
        currentSessionId: null,
        ...visiblePatch(empty, null, state.busySessions),
      }
    }

    const next = getOrCreateSessionState(sessionStateById, id)
    sessionStateById[id] = next

    return {
      sessionStateById,
      currentSessionId: id,
      ...visiblePatch(next, id, state.busySessions),
    }
  }),
  addSession: (session) => set((state) => ({
    sessions: [session, ...state.sessions],
    sessionStateById: state.sessionStateById[session.id]
      ? state.sessionStateById
      : { ...state.sessionStateById, [session.id]: createEmptySessionViewState() },
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
        ...visiblePatch(empty, null, state.busySessions),
      })
    }

    return patch
  }),
  isSessionHydrated: (id) => !!get().sessionStateById[id]?.hydrated,
  hydrateSessionFromItems: (sessionId, items, force = false) => set((state) => {
    const existing = state.sessionStateById[sessionId]
    if (existing?.hydrated && !force) {
      return {}
    }

    const next = buildSessionStateFromItems(items, existing)
    const sessionStateById = { ...state.sessionStateById, [sessionId]: next }
    const patch: Partial<SessionStore> = { sessionStateById }
    if (state.currentSessionId === sessionId) {
      Object.assign(patch, visiblePatch(next, sessionId, state.busySessions))
    }
    return patch
  }),

  messages: [],
  addMessage: (sessionId, message) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      messages: [...current.messages, { ...message, order: nextSeq() }],
      lastItemWasTool: false,
    })),
  ),
  appendToLastAssistant: (sessionId, content) => set((state) =>
    updateSessionState(state, sessionId, (current) => {
      const messages = [...current.messages]
      const last = messages[messages.length - 1]

      if (current.lastItemWasTool || !last || last.role !== 'assistant') {
        messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          order: nextSeq(),
        })
      } else {
        messages[messages.length - 1] = { ...last, content: last.content + content }
      }

      return {
        ...current,
        messages,
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
  appendTaskText: (sessionId, taskRunId, content, messageId) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      taskRuns: withTaskRun(current.taskRuns, taskRunId, (taskRun) => ({
        ...withTaskTranscript(taskRun, messageId || `${taskRunId}:live`, content),
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
      lastInputTokens: tokens.input > 0 ? tokens.input : current.lastInputTokens,
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
    updateSessionState(state, approval.sessionId, (current) => ({
      ...current,
      pendingApprovals: [...current.pendingApprovals, { ...approval, order: nextSeq() }],
    })),
  ),
  removeApproval: (id) => set((state) => {
    const sessionStateById = { ...state.sessionStateById }
    for (const [sessionId, sessionState] of Object.entries(sessionStateById)) {
      sessionStateById[sessionId] = {
        ...sessionState,
        pendingApprovals: sessionState.pendingApprovals.filter((approval) => approval.id !== id),
      }
    }

    const patch: Partial<SessionStore> = { sessionStateById }
    if (state.currentSessionId) {
      const current = getOrCreateSessionState(sessionStateById, state.currentSessionId)
      Object.assign(patch, visiblePatch(current, state.currentSessionId, state.busySessions))
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

  mcpConnections: [
    { name: 'Nova', connected: false },
    { name: 'Workspace', connected: false },
  ],
  setMcpConnections: (connections) => set({ mcpConnections: connections }),

  agentMode: 'cowork',
  setAgentMode: (mode) => set({ agentMode: mode }),

  todos: [],
  setTodos: (sessionId, todos) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      todos,
    })),
  ),

  sessionCost: 0,
  sessionTokens: cloneTokens(EMPTY_SESSION_TOKENS),
  lastInputTokens: 0,
  totalCost: 0,
  addCost: (sessionId, cost, tokens) => set((state) => {
    const totalCost = state.totalCost + cost
    const patch = updateSessionState(state, sessionId, (current) => ({
      ...current,
      sessionCost: current.sessionCost + cost,
      lastInputTokens: tokens.input > 0 ? tokens.input : current.lastInputTokens,
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
    }))
  }),
  resetLastInputTokens: (sessionId) => set((state) =>
    updateSessionState(state, sessionId, (current) => ({
      ...current,
      lastInputTokens: 0,
    })),
  ),

  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  isGenerating: false,
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
  addBusy: (id) => set((state) => {
    const busySessions = new Set(state.busySessions)
    busySessions.add(id)

    const patch: Partial<SessionStore> = { busySessions }
    if (state.currentSessionId === id) {
      const current = getOrCreateSessionState(state.sessionStateById, id)
      Object.assign(patch, visiblePatch(current, id, busySessions))
    }
    return patch
  }),
  removeBusy: (id) => set((state) => {
    const busySessions = new Set(state.busySessions)
    busySessions.delete(id)

    const patch = updateSessionState(state, id, (current) => ({
      ...current,
      activeAgent: null,
    })) as Partial<SessionStore>

    patch.busySessions = busySessions
    if (state.currentSessionId === id) {
      const current = getOrCreateSessionState(
        (patch.sessionStateById as Record<string, SessionViewState>) || state.sessionStateById,
        id,
      )
      Object.assign(patch, visiblePatch(current, id, busySessions))
    }
    return patch
  }),

  lastItemWasTool: false,

  sessionStateById: {},
}))
