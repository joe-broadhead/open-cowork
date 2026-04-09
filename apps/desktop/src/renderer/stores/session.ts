import { create } from 'zustand'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'complete' | 'error'
  output?: unknown
  timestamp: string
}

export interface PendingApproval {
  id: string
  tool: string
  input: Record<string, unknown>
  description: string
  timestamp: string
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
  // Sessions
  sessions: Session[]
  currentSessionId: string | null
  setSessions: (sessions: Session[]) => void
  setCurrentSession: (id: string | null) => void
  addSession: (session: Session) => void

  // Messages
  messages: Message[]
  addMessage: (message: Message) => void
  appendToLastAssistant: (content: string) => void
  clearMessages: () => void

  // Tool calls
  toolCalls: ToolCall[]
  addToolCall: (call: ToolCall) => void
  updateToolCall: (id: string, update: Partial<ToolCall>) => void
  clearToolCalls: () => void

  // Approvals
  pendingApprovals: PendingApproval[]
  addApproval: (approval: PendingApproval) => void
  removeApproval: (id: string) => void

  // MCP status
  mcpConnections: McpConnection[]
  setMcpConnections: (connections: McpConnection[]) => void

  // UI state
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  isGenerating: boolean
  setIsGenerating: (v: boolean) => void
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  currentSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (id) => set({ currentSessionId: id, messages: [], toolCalls: [] }),
  addSession: (session) => set((s) => ({ sessions: [session, ...s.sessions] })),

  messages: [],
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  appendToLastAssistant: (content) =>
    set((s) => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + content }
      } else {
        msgs.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
        })
      }
      return { messages: msgs }
    }),
  clearMessages: () => set({ messages: [], toolCalls: [] }),

  toolCalls: [],
  addToolCall: (call) => set((s) => ({ toolCalls: [...s.toolCalls, call] })),
  updateToolCall: (id, update) =>
    set((s) => ({
      toolCalls: s.toolCalls.map((tc) => (tc.id === id ? { ...tc, ...update } : tc)),
    })),
  clearToolCalls: () => set({ toolCalls: [] }),

  pendingApprovals: [],
  addApproval: (approval) => set((s) => ({ pendingApprovals: [...s.pendingApprovals, approval] })),
  removeApproval: (id) =>
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((a) => a.id !== id) })),

  mcpConnections: [
    { name: 'Nova', connected: false },
    { name: 'Workspace', connected: false },
  ],
  setMcpConnections: (connections) => set({ mcpConnections: connections }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  isGenerating: false,
  setIsGenerating: (v) => set({ isGenerating: v }),
}))
