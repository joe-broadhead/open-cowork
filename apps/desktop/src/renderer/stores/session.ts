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
  order: number
}

export interface PendingApproval {
  id: string
  tool: string
  input: Record<string, unknown>
  description: string
  order: number
}

export interface Session {
  id: string
  title?: string
  createdAt: string
  updatedAt: string
}

export interface McpConnection {
  name: string
  connected: boolean
}

interface SessionStore {
  sessions: Session[]
  currentSessionId: string | null
  setSessions: (sessions: Session[]) => void
  setCurrentSession: (id: string | null) => void
  addSession: (session: Session) => void
  renameSession: (id: string, title: string) => void
  removeSession: (id: string) => void

  messages: Message[]
  addMessage: (message: Omit<Message, 'order'>) => void
  appendToLastAssistant: (content: string) => void
  clearMessages: () => void

  toolCalls: ToolCall[]
  addToolCall: (call: Omit<ToolCall, 'order'>) => void
  updateToolCall: (id: string, update: Partial<ToolCall>) => void
  clearToolCalls: () => void

  pendingApprovals: PendingApproval[]
  addApproval: (approval: Omit<PendingApproval, 'order'>) => void
  removeApproval: (id: string) => void

  errors: Array<{ id: string; message: string; order: number }>
  addError: (message: string) => void

  mcpConnections: McpConnection[]
  setMcpConnections: (connections: McpConnection[]) => void

  // Agent mode
  agentMode: 'build' | 'plan'
  setAgentMode: (mode: 'build' | 'plan') => void

  // Cost tracking
  sessionCost: number
  sessionTokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  totalCost: number
  addCost: (cost: number, tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) => void
  resetSessionCost: () => void

  sidebarCollapsed: boolean
  toggleSidebar: () => void
  isGenerating: boolean
  setIsGenerating: (v: boolean) => void

  lastItemWasTool: boolean
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  currentSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (id) => set({ currentSessionId: id, messages: [], toolCalls: [], lastItemWasTool: false, sessionCost: 0, sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
  addSession: (session) => set((s) => ({ sessions: [session, ...s.sessions] })),
  renameSession: (id, title) => set((s) => ({
    sessions: s.sessions.map(sess => sess.id === id ? { ...sess, title } : sess),
  })),
  removeSession: (id) => set((s) => ({
    sessions: s.sessions.filter(sess => sess.id !== id),
    ...(s.currentSessionId === id ? { currentSessionId: null, messages: [], toolCalls: [] } : {}),
  })),

  messages: [],
  addMessage: (message) => set((s) => ({
    messages: [...s.messages, { ...message, order: nextSeq() }],
    lastItemWasTool: false,
  })),
  appendToLastAssistant: (content) =>
    set((s) => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]

      // If the last thing was a tool call, start a NEW assistant message
      // so the text appears after the tool call in the timeline
      if (s.lastItemWasTool || !last || last.role !== 'assistant') {
        msgs.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          order: nextSeq(),
        })
      } else {
        msgs[msgs.length - 1] = { ...last, content: last.content + content }
      }
      return { messages: msgs, lastItemWasTool: false }
    }),
  clearMessages: () => set({ messages: [], toolCalls: [], lastItemWasTool: false }),

  toolCalls: [],
  addToolCall: (call) => set((s) => ({
    toolCalls: [...s.toolCalls, { ...call, order: nextSeq() }],
    lastItemWasTool: true,
  })),
  updateToolCall: (id, update) =>
    set((s) => ({
      toolCalls: s.toolCalls.map((tc) => (tc.id === id ? { ...tc, ...update } : tc)),
    })),
  clearToolCalls: () => set({ toolCalls: [] }),

  pendingApprovals: [],
  addApproval: (approval) => set((s) => ({
    pendingApprovals: [...s.pendingApprovals, { ...approval, order: nextSeq() }],
  })),
  removeApproval: (id) =>
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((a) => a.id !== id) })),

  errors: [],
  addError: (message) => set((s) => ({
    errors: [...s.errors, { id: crypto.randomUUID(), message, order: nextSeq() }],
  })),

  mcpConnections: [
    { name: 'Nova', connected: false },
    { name: 'Workspace', connected: false },
  ],
  setMcpConnections: (connections) => set({ mcpConnections: connections }),

  agentMode: 'build',
  setAgentMode: (mode) => set({ agentMode: mode }),

  sessionCost: 0,
  sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  totalCost: 0,
  addCost: (cost, tokens) => set((s) => ({
    sessionCost: s.sessionCost + cost,
    totalCost: s.totalCost + cost,
    sessionTokens: {
      input: s.sessionTokens.input + tokens.input,
      output: s.sessionTokens.output + tokens.output,
      reasoning: s.sessionTokens.reasoning + tokens.reasoning,
      cacheRead: s.sessionTokens.cacheRead + tokens.cache.read,
      cacheWrite: s.sessionTokens.cacheWrite + tokens.cache.write,
    },
  })),
  resetSessionCost: () => set({ sessionCost: 0, sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  isGenerating: false,
  setIsGenerating: (v) => set({ isGenerating: v }),

  lastItemWasTool: false,
}))
