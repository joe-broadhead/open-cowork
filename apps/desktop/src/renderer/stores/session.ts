import { create } from 'zustand'
import type {
  McpStatus,
  SessionArtifact,
  SessionChangeSummary,
  SessionPatch,
  SessionError,
  SessionView,
  PermissionRequest,
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
  kind?: 'interactive' | 'automation'
  automationId?: string | null
  runId?: string | null
  parentSessionId?: string | null
  changeSummary?: SessionChangeSummary | null
  revertedMessageId?: string | null
}

export interface McpConnection {
  name: string
  connected: boolean
  rawStatus?: string
  error?: string
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
  applySessionMetadata: (patch: {
    id: string
    title: string | null
    parentSessionId?: string | null
    changeSummary?: SessionChangeSummary | null
    revertedMessageId?: string | null
  }) => void
  removeSession: (id: string) => void
  setSessionView: (sessionId: string, view: SessionView) => void
  applySessionPatch: (patch: SessionPatch) => void
  addPendingApproval: (approval: PermissionRequest) => void

  addGlobalError: (message: string) => void

  mcpConnections: McpConnection[]
  setMcpConnections: (connections: McpStatus[]) => void

  agentMode: 'build' | 'plan'
  setAgentMode: (mode: 'build' | 'plan') => void

  totalCost: number

  sidebarCollapsed: boolean
  toggleSidebar: () => void

  busySessions: Set<string>
  awaitingPermissionSessions: Set<string>
  awaitingQuestionSessions: Set<string>

  sessionStateById: Record<string, SessionViewState>

  // Chart PNG artifacts are captured client-side and persisted via the
  // `chart:save-artifact` IPC, so they don't come back through the
  // session-patch stream like file-edit artifacts do. We keep the
  // returned SessionArtifact records in a per-session map so the
  // Artifacts sidebar (and any other session-wide artifact UI) can
  // merge them alongside the tool-derived list.
  chartArtifactsBySession: Record<string, SessionArtifact[]>
  registerChartArtifact: (sessionId: string, artifact: SessionArtifact) => void
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
  applySessionMetadata: (patch) => set((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== patch.id) return session
      const next: Session = { ...session }
      if (patch.title !== null && patch.title !== undefined) next.title = patch.title
      // parentSessionId is stable once set. SDK refresh events occasionally
      // arrive with parentID=null; guard against erasing a real fork linkage.
      if (patch.parentSessionId) next.parentSessionId = patch.parentSessionId
      if (patch.changeSummary !== undefined) next.changeSummary = patch.changeSummary
      if (patch.revertedMessageId !== undefined) next.revertedMessageId = patch.revertedMessageId
      return next
    }),
  })),
  removeSession: (id) => set((state) => {
    const sessionStateById = { ...state.sessionStateById }
    delete sessionStateById[id]
    const chartArtifactsBySession = { ...state.chartArtifactsBySession }
    delete chartArtifactsBySession[id]

    // Drop the id from the status Sets too — otherwise a session that was
    // busy / awaiting-permission / awaiting-question at delete time leaves
    // a stale entry that leaks memory and could mis-color a future row if
    // an id ever collides.
    const nextBusy = state.busySessions.has(id)
      ? new Set(Array.from(state.busySessions).filter((sid) => sid !== id))
      : state.busySessions
    const nextAwaitingPermission = state.awaitingPermissionSessions.has(id)
      ? new Set(Array.from(state.awaitingPermissionSessions).filter((sid) => sid !== id))
      : state.awaitingPermissionSessions
    const nextAwaitingQuestion = state.awaitingQuestionSessions.has(id)
      ? new Set(Array.from(state.awaitingQuestionSessions).filter((sid) => sid !== id))
      : state.awaitingQuestionSessions

    const patch: Partial<SessionStore> = {
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionStateById,
      totalCost: sumSessionCosts(sessionStateById),
      busySessions: nextBusy,
      awaitingPermissionSessions: nextAwaitingPermission,
      awaitingQuestionSessions: nextAwaitingQuestion,
      chartArtifactsBySession,
    }

    if (state.currentSessionId === id) {
      Object.assign(patch, {
        currentSessionId: null,
        currentView: deriveVisibleSessionPatch(
          createEmptySessionViewState(),
          null,
          nextBusy,
          nextAwaitingPermission,
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
    const awaitingQuestionSessions = new Set(state.awaitingQuestionSessions)
    if (view.isAwaitingQuestion) awaitingQuestionSessions.add(sessionId)
    else awaitingQuestionSessions.delete(sessionId)

    const sessionStateById = pruneSessionDetailCache(
      { ...state.sessionStateById, [sessionId]: next },
      state.currentSessionId,
      busySessions,
    )

    const patch: Partial<SessionStore> = {
      sessionStateById,
      busySessions,
      awaitingPermissionSessions,
      awaitingQuestionSessions,
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
  addPendingApproval: (approval) => set((state) => {
    const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
    awaitingPermissionSessions.add(approval.sessionId)
    const busySessions = new Set(state.busySessions)
    busySessions.add(approval.sessionId)

    const patch = updateSessionState(
      {
        ...state,
        awaitingPermissionSessions,
        busySessions,
      },
      approval.sessionId,
      (current) => ({
        ...current,
        pendingApprovals: [
          ...current.pendingApprovals.filter((entry) => entry.id !== approval.id),
          {
            ...approval,
            order: nowTs(),
          },
        ],
      }),
      { eventAt: state.sessionStateById[approval.sessionId]?.lastEventAt ?? 0 },
    )

    return {
      ...patch,
      awaitingPermissionSessions,
      busySessions,
    }
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
      error: connection.error,
    })),
  }),

  agentMode: 'build',
  setAgentMode: (mode) => set({ agentMode: mode }),
  totalCost: 0,

  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  busySessions: new Set<string>(),
  awaitingPermissionSessions: new Set<string>(),
  awaitingQuestionSessions: new Set<string>(),

  sessionStateById: {},

  chartArtifactsBySession: {},
  registerChartArtifact: (sessionId, artifact) => set((state) => {
    const current = state.chartArtifactsBySession[sessionId] || []
    // De-dupe on filePath so repeat captures (HMR, re-render) replace
    // the older record in place rather than stacking duplicates.
    const next = [...current.filter((entry) => entry.filePath !== artifact.filePath), artifact]
    return {
      chartArtifactsBySession: {
        ...state.chartArtifactsBySession,
        [sessionId]: next,
      },
    }
  }),
}))
