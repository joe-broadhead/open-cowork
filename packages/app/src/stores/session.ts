import { buildSessionStateFromView, createEmptySessionViewState, deriveVisibleSessionPatch, getOrCreateSessionState, pruneSessionDetailCache, type SessionViewState } from '@open-cowork/shared'
import { create } from 'zustand'
import type {
  McpStatus,
  SessionArtifact,
  SessionChangeSummary,
  SessionInfo,
  SessionPatch,
  SessionError,
  SessionView,
  PermissionRequest,
} from '@open-cowork/shared'
import {
  applySessionPatchToState,
  deriveBatchedSessionView,
  orderSessionPatches,
  sessionViewTiming,
  sumSessionCosts,
  updateSessionState,
} from './session-view-reducer.ts'
import {
  activeSessionWorkspaceKey,
  LOCAL_WORKSPACE_ID,
  normalizeWorkspaceId,
  parseSessionWorkspaceKey,
  sessionWorkspaceKey,
} from './session-workspace-keys.ts'
import { permissionSignature, type RunawaySample } from '../components/chat/permission-approval-model.ts'

// How many recent permission signatures we retain per store for runaway
// ("doom-loop") detection. Bounded so a long-running session can't grow the
// buffer without limit; a burst that repeats far more than this is still
// clearly a loop.
const RECENT_APPROVAL_LIMIT = 60

export type {
  CompactionNotice,
  ExecutionPlanItem,
  Message,
  MessageAttachment,
  MessageSegment,
  PendingApproval,
  ReasoningSegment,
  SessionError,
  SessionTokens,
  TaskRun,
  TaskTranscriptSegment,
  ToolCall,
  TodoItem,
} from '@open-cowork/shared'
export type { HistoryItem, SessionViewState } from '@open-cowork/shared'

export type Session = SessionInfo
export type PrimaryAgentMode = 'build' | 'plan' | 'chief-of-staff'

type SessionMetadataPatch = {
  id: string
  title: string | null
  parentSessionId?: string | null
  changeSummary?: SessionChangeSummary | null
  revertedMessageId?: string | null
  composerAgentName?: string | null
  composerModelId?: string | null
  composerReasoningVariant?: string | null
}

function applySessionMetadataPatch(session: Session, patch: SessionMetadataPatch): Session {
  if (session.id !== patch.id) return session
  const next: Session = { ...session }
  if (patch.title !== null && patch.title !== undefined) next.title = patch.title
  // parentSessionId is stable once set. SDK refresh events occasionally
  // arrive with parentID=null; guard against erasing a real fork linkage.
  if (patch.parentSessionId) next.parentSessionId = patch.parentSessionId
  if (patch.changeSummary !== undefined) next.changeSummary = patch.changeSummary
  if (patch.revertedMessageId !== undefined) next.revertedMessageId = patch.revertedMessageId
  if (patch.composerAgentName !== undefined) next.composerAgentName = patch.composerAgentName
  if (patch.composerModelId !== undefined) next.composerModelId = patch.composerModelId
  if (patch.composerReasoningVariant !== undefined) next.composerReasoningVariant = patch.composerReasoningVariant
  return next
}

export interface McpConnection {
  name: string
  connected: boolean
  rawStatus?: string
  error?: string
}

export interface SessionStore {
  activeWorkspaceId: string
  sessionsByWorkspace: Record<string, Session[]>
  sessions: Session[]
  currentSessionId: string | null
  currentView: SessionView
  globalErrors: SessionError[]
  // Rolling history of recent permission-request signatures + timestamps,
  // used by the approval surface to detect runaway ("doom-loop") requests
  // even after each individual request has been resolved.
  recentApprovals: RunawaySample[]
  setActiveWorkspace: (workspaceId: string) => void
  setSessions: (sessions: Session[]) => void
  setCurrentSession: (id: string | null) => void
  addSession: (session: Session) => void
  renameSession: (id: string, title: string) => void
  setSessionComposerPreferences: (id: string, preferences: {
    agentName?: string | null
    modelId?: string | null
    reasoningVariant?: string | null
  }) => void
  applySessionMetadata: (patch: SessionMetadataPatch, workspaceId?: string | null) => void
  removeSession: (id: string, workspaceId?: string | null) => void
  setSessionView: (sessionId: string, view: SessionView, workspaceId?: string | null) => void
  applySessionPatch: (patch: SessionPatch) => void
  applySessionPatches: (patches: SessionPatch[]) => void
  addPendingApproval: (approval: PermissionRequest) => void

  addGlobalError: (message: string) => void
  dismissGlobalError: (id: string) => void

  mcpConnections: McpConnection[]
  setMcpConnections: (connections: McpStatus[]) => void

  agentMode: PrimaryAgentMode
  setAgentMode: (mode: PrimaryAgentMode) => void
  sessionPrimaryAgents: Record<string, string>
  setSessionPrimaryAgent: (sessionId: string, agentName: string | null, workspaceId?: string | null) => void

  reasoningVariant: string | null
  setReasoningVariant: (variant: string | null) => void

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

// `sessions` mirrors `sessionsByWorkspace[activeWorkspaceId]` as a single source of truth. Every
// mutation of a workspace's session list must go through this helper so the mirror can never
// desync — previously each mutator wrote the same transform twice by hand, and a forgotten second
// copy silently desynced the sidebar from the workspace cache (#919).
function applyToWorkspace(
  state: SessionStore,
  workspaceId: string | null | undefined,
  updater: (sessions: Session[]) => Session[],
): Pick<SessionStore, 'sessions' | 'sessionsByWorkspace'> {
  const activeWorkspaceId = normalizeWorkspaceId(state.activeWorkspaceId)
  const targetWorkspaceId = normalizeWorkspaceId(workspaceId ?? activeWorkspaceId)
  const targetIsActive = targetWorkspaceId === activeWorkspaceId
  const currentSessions = targetIsActive ? state.sessions : (state.sessionsByWorkspace[targetWorkspaceId] || [])
  const nextSessions = updater(currentSessions)
  return {
    sessions: targetIsActive ? nextSessions : state.sessions,
    sessionsByWorkspace: { ...state.sessionsByWorkspace, [targetWorkspaceId]: nextSessions },
  }
}

export const useSessionStore = create<SessionStore>((set) => ({
  activeWorkspaceId: LOCAL_WORKSPACE_ID,
  sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: [] },
  sessions: [],
  currentSessionId: null,
  currentView: deriveVisibleSessionPatch(createEmptySessionViewState({}, sessionViewTiming()), null, new Set<string>(), new Set<string>(), sessionViewTiming()),
  globalErrors: [],
  recentApprovals: [],
  setActiveWorkspace: (workspaceId) => set((state) => {
    const nextWorkspaceId = normalizeWorkspaceId(workspaceId)
    if (nextWorkspaceId === normalizeWorkspaceId(state.activeWorkspaceId)) return {}
    const timing = sessionViewTiming()
    // Drop busy entries for the workspace we are leaving. A busy (generating) session re-emits
    // events, so its entry re-populates on switch-back; clearing it meanwhile lets the detail cache
    // it pins (pruneSessionDetailCache keys on busySessions) be reclaimed rather than accumulating
    // across every switch. Only active-workspace keys are ever read (ThreadList).
    //
    // The awaiting-permission/question sets are deliberately NOT pruned: those are quiescent states
    // that emit no further events while waiting, so a pruned badge would never recover on switch-back
    // and the user would lose the only sidebar signal that a session needs input. They hold just
    // keys (no pinned state), so retaining them costs negligible memory.
    const busySessions = new Set<string>()
    for (const key of state.busySessions) {
      if (parseSessionWorkspaceKey(key).workspaceId === nextWorkspaceId) busySessions.add(key)
    }
    return {
      activeWorkspaceId: nextWorkspaceId,
      sessions: state.sessionsByWorkspace[nextWorkspaceId] || [],
      currentSessionId: null,
      busySessions,
      currentView: deriveVisibleSessionPatch(
        createEmptySessionViewState({}, timing),
        null,
        busySessions,
        state.awaitingPermissionSessions,
        timing,
      ),
    }
  }),
  setSessions: (sessions) => set((state) => applyToWorkspace(state, state.activeWorkspaceId, () => sessions)),
  setCurrentSession: (id) => set((state) => {
    let sessionStateById = { ...state.sessionStateById }
    if (!id) {
      return {
        sessionStateById,
        currentSessionId: null,
        currentView: deriveVisibleSessionPatch(
          createEmptySessionViewState({}, sessionViewTiming()),
          null,
          state.busySessions,
          state.awaitingPermissionSessions,
          sessionViewTiming(),
        ),
      }
    }

    const timing = sessionViewTiming()
    const sessionKey = activeSessionWorkspaceKey(state, id)
    const next = getOrCreateSessionState(sessionStateById, sessionKey, timing)
    sessionStateById[sessionKey] = {
      ...next,
      lastViewedAt: timing.nowMs,
    }
    sessionStateById = pruneSessionDetailCache(sessionStateById, sessionKey, state.busySessions)

    return {
      sessionStateById,
      currentSessionId: id,
      currentView: deriveVisibleSessionPatch(
        sessionStateById[sessionKey]!,
        sessionKey,
        state.busySessions,
        state.awaitingPermissionSessions,
        timing,
      ),
    }
  }),
  addSession: (session) => set((state) => applyToWorkspace(state, state.activeWorkspaceId, (sessions) => [session, ...sessions])),
  renameSession: (id, title) => set((state) => applyToWorkspace(state, state.activeWorkspaceId, (sessions) => (
    sessions.map((session) => (session.id === id ? { ...session, title } : session))
  ))),
  setSessionComposerPreferences: (id, preferences) => set((state) => applyToWorkspace(state, state.activeWorkspaceId, (sessions) => (
    sessions.map((session) => {
      if (session.id !== id) return session
      return {
        ...session,
        ...(Object.prototype.hasOwnProperty.call(preferences, 'agentName')
          ? { composerAgentName: preferences.agentName ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(preferences, 'modelId')
          ? { composerModelId: preferences.modelId ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(preferences, 'reasoningVariant')
          ? { composerReasoningVariant: preferences.reasoningVariant ?? null }
          : {}),
      }
    })
  ))),
  applySessionMetadata: (patch, workspaceId) => set((state) => applyToWorkspace(state, workspaceId, (sessions) => (
    sessions.map((session) => applySessionMetadataPatch(session, patch))
  ))),
  removeSession: (id, workspaceId) => set((state) => {
    const activeWorkspaceId = normalizeWorkspaceId(state.activeWorkspaceId)
    const targetWorkspaceId = normalizeWorkspaceId(workspaceId ?? activeWorkspaceId)
    const targetIsActive = targetWorkspaceId === activeWorkspaceId
    const sessionKey = sessionWorkspaceKey(targetWorkspaceId, id)
    const sessionStateById = { ...state.sessionStateById }
    delete sessionStateById[sessionKey]
    const chartArtifactsBySession = { ...state.chartArtifactsBySession }
    delete chartArtifactsBySession[sessionKey]
    const sessionPrimaryAgents = { ...state.sessionPrimaryAgents }
    delete sessionPrimaryAgents[sessionKey]

    // Drop the id from the status Sets too — otherwise a session that was
    // busy / awaiting-permission / awaiting-question at delete time leaves
    // a stale entry that leaks memory and could mis-color a future row if
    // an id ever collides.
    const nextBusy = state.busySessions.has(sessionKey)
      ? new Set(Array.from(state.busySessions).filter((sid) => sid !== sessionKey))
      : state.busySessions
    const nextAwaitingPermission = state.awaitingPermissionSessions.has(sessionKey)
      ? new Set(Array.from(state.awaitingPermissionSessions).filter((sid) => sid !== sessionKey))
      : state.awaitingPermissionSessions
    const nextAwaitingQuestion = state.awaitingQuestionSessions.has(sessionKey)
      ? new Set(Array.from(state.awaitingQuestionSessions).filter((sid) => sid !== sessionKey))
      : state.awaitingQuestionSessions
    const patch: Partial<SessionStore> = {
      ...applyToWorkspace(state, targetWorkspaceId, (sessions) => sessions.filter((session) => session.id !== id)),
      sessionStateById,
      totalCost: sumSessionCosts(sessionStateById),
      busySessions: nextBusy,
      awaitingPermissionSessions: nextAwaitingPermission,
      awaitingQuestionSessions: nextAwaitingQuestion,
      chartArtifactsBySession,
      sessionPrimaryAgents,
    }

    if (targetIsActive && state.currentSessionId === id) {
      Object.assign(patch, {
        currentSessionId: null,
        currentView: deriveVisibleSessionPatch(
          createEmptySessionViewState({}, sessionViewTiming()),
          null,
          nextBusy,
          nextAwaitingPermission,
          sessionViewTiming(),
        ),
      })
    }

    return patch
  }),
  setSessionView: (sessionId, view, workspaceId) => set((state) => {
    if (workspaceId && normalizeWorkspaceId(workspaceId) !== normalizeWorkspaceId(state.activeWorkspaceId)) return {}
    const sessionKey = workspaceId
      ? sessionWorkspaceKey(workspaceId, sessionId)
      : activeSessionWorkspaceKey(state, sessionId)
    const currentSessionKey = state.currentSessionId ? activeSessionWorkspaceKey(state, state.currentSessionId) : null
    const existing = state.sessionStateById[sessionKey]
    const timing = sessionViewTiming()
    const next = buildSessionStateFromView(view, existing, timing)
    const busySessions = new Set(state.busySessions)
    if (view.isGenerating || view.isAwaitingPermission || view.isAwaitingQuestion) busySessions.add(sessionKey)
    else busySessions.delete(sessionKey)
    const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
    if (view.isAwaitingPermission) awaitingPermissionSessions.add(sessionKey)
    else awaitingPermissionSessions.delete(sessionKey)
    const awaitingQuestionSessions = new Set(state.awaitingQuestionSessions)
    if (view.isAwaitingQuestion) awaitingQuestionSessions.add(sessionKey)
    else awaitingQuestionSessions.delete(sessionKey)

    const sessionStateById = pruneSessionDetailCache(
      { ...state.sessionStateById, [sessionKey]: next },
      currentSessionKey,
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
        sessionStateById[sessionKey]!,
        sessionKey,
        busySessions,
        awaitingPermissionSessions,
        timing,
      )
    }
    return patch
  }),
  applySessionPatch: (patch) => set((state) => {
    if (patch.workspaceId && normalizeWorkspaceId(patch.workspaceId) !== normalizeWorkspaceId(state.activeWorkspaceId)) return {}
    return applySessionPatchToState(state, patch)
  }),
  applySessionPatches: (patches) => {
    if (patches.length === 0) return

    set((state) => {
      let nextState = state
      let touched = false
      let currentSessionAffected = false

      // Fold every patch into sessionStateById with the view-derive deferred, then derive
      // the visible view + totalCost EXACTLY ONCE after the loop (PERF-3). Previously each
      // patch re-derived the full visible view (O(K·M)) and only the last survived.
      for (const patch of orderSessionPatches(patches).filter((candidate) => (
        !candidate.workspaceId || normalizeWorkspaceId(candidate.workspaceId) === normalizeWorkspaceId(state.activeWorkspaceId)
      ))) {
        const partial = applySessionPatchToState(nextState, patch, { deferDerive: true })
        nextState = {
          ...nextState,
          ...partial,
        }
        touched = true
        if (patch.sessionId === state.currentSessionId) currentSessionAffected = true
      }

      if (!touched) return {}
      return deriveBatchedSessionView(nextState, currentSessionAffected)
    })
  },
  addPendingApproval: (approval) => set((state) => {
    if (approval.workspaceId && normalizeWorkspaceId(approval.workspaceId) !== normalizeWorkspaceId(state.activeWorkspaceId)) return {}
    const sessionKey = approval.workspaceId
      ? sessionWorkspaceKey(approval.workspaceId, approval.sessionId)
      : activeSessionWorkspaceKey(state, approval.sessionId)
    const awaitingPermissionSessions = new Set(state.awaitingPermissionSessions)
    awaitingPermissionSessions.add(sessionKey)
    const busySessions = new Set(state.busySessions)
    busySessions.add(sessionKey)

    const approvalAt = sessionViewTiming().nowMs
    const recentApprovals = [
      ...state.recentApprovals.filter((entry) => entry.id !== approval.id),
      { id: approval.id, signature: permissionSignature(approval), at: approvalAt },
    ].slice(-RECENT_APPROVAL_LIMIT)

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
            order: sessionViewTiming().nowMs,
          },
        ],
      }),
      { eventAt: state.sessionStateById[sessionKey]?.lastEventAt ?? 0 },
    )

    return {
      ...patch,
      awaitingPermissionSessions,
      busySessions,
      recentApprovals,
    }
  }),

  addGlobalError: (message) => set((state) => ({
    globalErrors: [...state.globalErrors, { id: crypto.randomUUID(), sessionId: null, message, order: sessionViewTiming().nowMs }],
  })),
  dismissGlobalError: (id) => set((state) => ({
    globalErrors: state.globalErrors.filter((error) => error.id !== id),
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
  sessionPrimaryAgents: {},
  setSessionPrimaryAgent: (sessionId, agentName, workspaceId) => set((state) => {
    const activeWorkspaceId = normalizeWorkspaceId(state.activeWorkspaceId)
    const targetWorkspaceId = normalizeWorkspaceId(workspaceId ?? activeWorkspaceId)
    const sessionKey = workspaceId
      ? sessionWorkspaceKey(workspaceId, sessionId)
      : activeSessionWorkspaceKey(state, sessionId)
    const sessionPrimaryAgents = { ...state.sessionPrimaryAgents }
    const trimmed = agentName?.trim()
    if (trimmed) sessionPrimaryAgents[sessionKey] = trimmed
    else delete sessionPrimaryAgents[sessionKey]
    return {
      ...applyToWorkspace(state, targetWorkspaceId, (sessions) => sessions.map((session) => (
        session.id === sessionId ? { ...session, composerAgentName: trimmed || null } : session
      ))),
      sessionPrimaryAgents,
    }
  }),
  reasoningVariant: null,
  setReasoningVariant: (variant) => set({ reasoningVariant: variant }),
  totalCost: 0,

  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  busySessions: new Set<string>(),
  awaitingPermissionSessions: new Set<string>(),
  awaitingQuestionSessions: new Set<string>(),

  sessionStateById: {},

  chartArtifactsBySession: {},
  registerChartArtifact: (sessionId, artifact) => set((state) => {
    const sessionKey = activeSessionWorkspaceKey(state, sessionId)
    const current = state.chartArtifactsBySession[sessionKey] || []
    // De-dupe on filePath so repeat captures (HMR, re-render) replace
    // the older record in place rather than stacking duplicates.
    const next = [...current.filter((entry) => entry.filePath !== artifact.filePath), artifact]
    return {
      chartArtifactsBySession: {
        ...state.chartArtifactsBySession,
        [sessionKey]: next,
      },
    }
  }),
}))
