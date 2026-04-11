import { create } from 'zustand'

// Global sequence counter — items are displayed in the order they arrive
let seq = 0
function nextSeq() { return ++seq }

export interface MessageAttachment {
  mime: string
  url: string // data URL for images, or filename for files
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
  order: number
}

export interface PendingApproval {
  id: string
  sessionId: string
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
}

type SessionTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

type TodoItem = { content: string; status: string; priority: string; id?: string }

type HistoryItem = {
  type?: string
  id: string
  role?: string
  content?: string
  timestamp: string
  tool?: {
    name: string
    input: Record<string, unknown>
    status: string
    output?: unknown
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
  pendingApprovals: PendingApproval[]
  addApproval: (approval: Omit<PendingApproval, 'order'>) => void
  removeApproval: (id: string) => void

  errors: SessionError[]
  addError: (sessionId: string | null, message: string) => void

  mcpConnections: McpConnection[]
  setMcpConnections: (connections: McpConnection[]) => void

  // Agent mode
  agentMode: 'build' | 'plan'
  setAgentMode: (mode: 'build' | 'plan') => void

  // Todos from agent
  todos: TodoItem[]
  setTodos: (sessionId: string, todos: TodoItem[]) => void

  // Cost tracking
  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number // latest turn's input count = current context usage
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

  // Per-session busy tracking (for sidebar indicators)
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

function createEmptySessionViewState(overrides: Partial<SessionViewState> = {}): SessionViewState {
  return {
    messages: [],
    toolCalls: [],
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
    if (item.type === 'tool' && item.tool) {
      next.toolCalls.push({
        id: item.id,
        name: item.tool.name,
        input: item.tool.input,
        status: item.tool.status as 'running' | 'complete' | 'error',
        output: item.tool.output,
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

  agentMode: 'build',
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
