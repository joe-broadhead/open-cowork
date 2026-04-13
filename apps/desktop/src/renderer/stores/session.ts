import { create } from 'zustand'
import type {
  McpStatus,
  SessionPatch,
  SessionError,
  SessionView,
} from '@open-cowork/shared'
import {
  buildSessionStateFromView,
  createEmptySessionViewState,
  deriveVisibleSessionPatch,
  getOrCreateSessionState,
  nowTs,
  pruneSessionDetailCache,
  withMessageText,
  withTaskRun,
  withTaskTranscript,
  type HistoryItem,
  type SessionViewState,
} from '../../lib/session-view-model.ts'

export type {
  CompactionNotice,
  ExecutionPlanItem,
  Message,
  MessageAttachment,
  MessageSegment,
  PendingApproval,
  SessionError,
  SessionTokens,
  TaskRun,
  TaskTranscriptSegment,
  ToolCall,
  TodoItem,
} from '@open-cowork/shared'
export type { HistoryItem, SessionViewState } from '../../lib/session-view-model.ts'

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

interface SessionStore {
  sessions: Session[]
  currentSessionId: string | null
  currentView: SessionView
  globalErrors: SessionError[]
  setSessions: (sessions: Session[]) => void
  setCurrentSession: (id: string | null) => void
  addSession: (session: Session) => void
  renameSession: (id: string, title: string) => void
  removeSession: (id: string) => void
  setSessionView: (sessionId: string, view: SessionView) => void
  applySessionPatch: (patch: SessionPatch) => void

  addGlobalError: (message: string) => void

  mcpConnections: McpConnection[]
  setMcpConnections: (connections: McpStatus[]) => void

  agentMode: 'assistant' | 'plan'
  setAgentMode: (mode: 'assistant' | 'plan') => void

  totalCost: number

  sidebarCollapsed: boolean
  toggleSidebar: () => void

  busySessions: Set<string>
  awaitingPermissionSessions: Set<string>

  sessionStateById: Record<string, SessionViewState>
}

function sumSessionCosts(sessionStateById: Record<string, SessionViewState>) {
  return Object.values(sessionStateById)
    .reduce((sum, sessionState) => sum + (sessionState.sessionCost || 0), 0)
}

function updateSessionState(
  state: SessionStore,
  sessionId: string,
  updater: (current: SessionViewState) => SessionViewState,
  options?: { eventAt?: number },
) {
  const sessionStateById = { ...state.sessionStateById }
  const current = getOrCreateSessionState(sessionStateById, sessionId)
  const updated = updater(current)
  const next = {
    ...updated,
    revision: current.revision + 1,
    lastEventAt: options?.eventAt ?? nowTs(),
  }
  sessionStateById[sessionId] = next
  const prunedSessionStateById = pruneSessionDetailCache(sessionStateById, state.currentSessionId, state.busySessions)

  const patch: Partial<SessionStore> = {
    sessionStateById: prunedSessionStateById,
    totalCost: sumSessionCosts(prunedSessionStateById),
  }
  if (state.currentSessionId === sessionId) {
    const visibleState = prunedSessionStateById[sessionId] || next
    patch.currentView = deriveVisibleSessionPatch(
      visibleState,
      sessionId,
      state.busySessions,
      state.awaitingPermissionSessions,
    )
  }
  return patch
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  currentSessionId: null,
  currentView: deriveVisibleSessionPatch(createEmptySessionViewState(), null, new Set<string>(), new Set<string>()),
  globalErrors: [],
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (id) => set((state) => {
    let sessionStateById = { ...state.sessionStateById }
    if (!id) {
      return {
        sessionStateById,
        currentSessionId: null,
        currentView: deriveVisibleSessionPatch(
          createEmptySessionViewState(),
          null,
          state.busySessions,
          state.awaitingPermissionSessions,
        ),
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
      currentView: deriveVisibleSessionPatch(
        sessionStateById[id],
        id,
        state.busySessions,
        state.awaitingPermissionSessions,
      ),
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
      totalCost: sumSessionCosts(sessionStateById),
    }

    if (state.currentSessionId === id) {
      Object.assign(patch, {
        currentSessionId: null,
        currentView: deriveVisibleSessionPatch(
          createEmptySessionViewState(),
          null,
          state.busySessions,
          state.awaitingPermissionSessions,
        ),
      })
    }

    return patch
  }),
  setSessionView: (sessionId, view) => set((state) => {
    const existing = state.sessionStateById[sessionId]
    const next = buildSessionStateFromView(view, existing)
    const busySessions = new Set(state.busySessions)
    if (view.isGenerating || view.isAwaitingPermission || view.isAwaitingQuestion) busySessions.add(sessionId)
    else busySessions.delete(sessionId)
    const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
    if (view.isAwaitingPermission) awaitingPermissionSessions.add(sessionId)
    else awaitingPermissionSessions.delete(sessionId)

    const sessionStateById = pruneSessionDetailCache(
      { ...state.sessionStateById, [sessionId]: next },
      state.currentSessionId,
      busySessions,
    )

    const patch: Partial<SessionStore> = {
      sessionStateById,
      busySessions,
      awaitingPermissionSessions,
      totalCost: sumSessionCosts(sessionStateById),
    }
    if (state.currentSessionId === sessionId) {
      patch.currentView = deriveVisibleSessionPatch(
        sessionStateById[sessionId],
        sessionId,
        busySessions,
        awaitingPermissionSessions,
      )
    }
    return patch
  }),
  applySessionPatch: (patch) => set((state) => {
    if (patch.type === 'task_text') {
      return updateSessionState(
        state,
        patch.sessionId,
        (current) => ({
          ...current,
          taskRuns: withTaskRun(current.taskRuns, patch.taskRunId, (taskRun) => ({
            ...withTaskTranscript(taskRun, patch.segmentId, patch.content, {
              replace: patch.mode === 'replace',
            }),
          })),
          lastItemWasTool: true,
        }),
        { eventAt: patch.eventAt },
      )
    }

    return updateSessionState(
      state,
      patch.sessionId,
      (current) => ({
        ...current,
        ...withMessageText(current, {
          messageId: patch.messageId,
          role: patch.role || 'assistant',
          content: patch.content,
          segmentId: patch.segmentId,
          attachments: patch.attachments,
          replace: patch.mode === 'replace',
        }),
        lastItemWasTool: false,
      }),
      { eventAt: patch.eventAt },
    )
  }),

  addGlobalError: (message) => set((state) => ({
    globalErrors: [...state.globalErrors, { id: crypto.randomUUID(), sessionId: null, message, order: nowTs() }],
  })),

  mcpConnections: [],
  setMcpConnections: (connections) => set({
    mcpConnections: connections.map((connection) => ({
      name: connection.name,
      connected: connection.connected,
      rawStatus: connection.rawStatus,
    })),
  }),

  agentMode: 'assistant',
  setAgentMode: (mode) => set({ agentMode: mode }),
  totalCost: 0,

  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  busySessions: new Set<string>(),
  awaitingPermissionSessions: new Set<string>(),

  sessionStateById: {},
}))
