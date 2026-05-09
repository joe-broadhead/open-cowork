import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionArtifact, SessionView } from '@open-cowork/shared'
import type { Session } from './session'
import {
  createEmptySessionViewState,
  deriveVisibleSessionPatch,
  type SessionViewState,
} from '../../lib/session-view-model'
import { useSessionStore } from './session'

function resetStore() {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
}

function session(id: string, title = id): Session {
  return {
    id,
    title,
    directory: '/repo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function view(overrides: Partial<SessionView> = {}): SessionView {
  const state = createEmptySessionViewState(overrides as Partial<SessionViewState>)
  const busySessions = overrides.isGenerating || overrides.isAwaitingPermission || overrides.isAwaitingQuestion
    ? new Set(['ses_1'])
    : new Set<string>()
  const awaitingPermissionSessions = overrides.isAwaitingPermission ? new Set(['ses_1']) : new Set<string>()
  return {
    ...deriveVisibleSessionPatch(state, 'ses_1', busySessions, awaitingPermissionSessions),
    ...overrides,
  }
}

describe('useSessionStore', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000')
    resetStore()
  })

  it('manages session list metadata without erasing stable parent links', () => {
    const store = useSessionStore.getState()

    store.setSessions([session('one', 'One')])
    useSessionStore.getState().addSession(session('two', 'Two'))
    useSessionStore.getState().renameSession('one', 'Renamed')
    useSessionStore.getState().applySessionMetadata({
      id: 'two',
      title: 'Fork',
      parentSessionId: 'parent',
      changeSummary: { additions: 2, deletions: 1, files: 1 },
      revertedMessageId: 'msg_1',
    })
    useSessionStore.getState().applySessionMetadata({
      id: 'two',
      title: null,
      parentSessionId: null,
      changeSummary: null,
      revertedMessageId: null,
    })

    expect(useSessionStore.getState().sessions).toEqual([
      {
        ...session('two', 'Fork'),
        parentSessionId: 'parent',
        changeSummary: null,
        revertedMessageId: null,
      },
      session('one', 'Renamed'),
    ])
  })

  it('projects full session views into busy and awaiting indexes', () => {
    const store = useSessionStore.getState()

    store.setCurrentSession('ses_1')
    useSessionStore.getState().setSessionView('ses_1', view({
      isGenerating: true,
      isAwaitingPermission: true,
      sessionCost: 1.25,
    }))

    expect(useSessionStore.getState().busySessions.has('ses_1')).toBe(true)
    expect(useSessionStore.getState().awaitingPermissionSessions.has('ses_1')).toBe(true)
    expect(useSessionStore.getState().totalCost).toBe(1.25)
    expect(useSessionStore.getState().currentView.isAwaitingPermission).toBe(true)

    useSessionStore.getState().setSessionView('ses_1', view({
      isGenerating: true,
      isAwaitingPermission: false,
      sessionCost: 2,
    }))

    expect(useSessionStore.getState().currentView.isGenerating).toBe(true)

    useSessionStore.getState().setSessionView('ses_1', view({
      isGenerating: false,
      isAwaitingPermission: false,
      sessionCost: 2,
    }))

    expect(useSessionStore.getState().busySessions.has('ses_1')).toBe(false)
    expect(useSessionStore.getState().awaitingPermissionSessions.has('ses_1')).toBe(false)
    expect(useSessionStore.getState().totalCost).toBe(2)
  })

  it('applies message and task text patches to the visible session', () => {
    const store = useSessionStore.getState()
    store.setCurrentSession('ses_1')

    useSessionStore.getState().applySessionPatch({
      type: 'message_text',
      sessionId: 'ses_1',
      messageId: 'msg_1',
      segmentId: 'seg_1',
      content: 'Hello',
      mode: 'append',
      role: 'assistant',
      eventAt: 10,
    })
    useSessionStore.getState().applySessionPatch({
      type: 'message_text',
      sessionId: 'ses_1',
      messageId: 'msg_1',
      segmentId: 'seg_1',
      content: 'Hello world',
      mode: 'replace',
      role: 'assistant',
      eventAt: 20,
    })
    useSessionStore.getState().applySessionPatch({
      type: 'task_text',
      sessionId: 'ses_1',
      taskRunId: 'task_1',
      segmentId: 'task_seg',
      content: 'Working',
      mode: 'append',
      eventAt: 30,
    })

    const state = useSessionStore.getState()
    expect(state.currentView.messages[0]?.content).toBe('Hello world')
    expect(state.currentView.taskRuns[0]?.id).toBe('task_1')
    expect(state.currentView.taskRuns[0]?.transcript[0]?.content).toBe('Working')
    expect(state.currentView.lastItemWasTool).toBe(true)
  })

  it('deduplicates pending approvals and sets awaiting state', () => {
    const approval = {
      id: 'approval_1',
      sessionId: 'ses_1',
      tool: 'bash',
      input: { command: 'pwd' },
      description: 'Run pwd',
    }

    useSessionStore.getState().setCurrentSession('ses_1')
    useSessionStore.getState().addPendingApproval(approval)
    useSessionStore.getState().addPendingApproval({ ...approval, description: 'Run pwd again' })

    const state = useSessionStore.getState()
    expect(state.awaitingPermissionSessions.has('ses_1')).toBe(true)
    expect(state.busySessions.has('ses_1')).toBe(true)
    expect(state.currentView.pendingApprovals).toHaveLength(1)
    expect(state.currentView.pendingApprovals[0]?.description).toBe('Run pwd again')
  })

  it('removes session state, status indexes, and chart artifacts together', () => {
    const artifact: SessionArtifact = {
      id: 'artifact-1',
      toolId: 'tool-1',
      toolName: 'chart',
      filename: 'chart.png',
      filePath: '/tmp/chart.png',
      order: 0,
      mime: 'image/png',
    }

    useSessionStore.getState().setSessions([session('ses_1')])
    useSessionStore.getState().setCurrentSession('ses_1')
    useSessionStore.getState().setSessionView('ses_1', view({ isAwaitingQuestion: true }))
    useSessionStore.getState().registerChartArtifact('ses_1', artifact)
    useSessionStore.getState().removeSession('ses_1')

    const state = useSessionStore.getState()
    expect(state.sessions).toEqual([])
    expect(state.currentSessionId).toBeNull()
    expect(state.sessionStateById.ses_1).toBeUndefined()
    expect(state.awaitingQuestionSessions.has('ses_1')).toBe(false)
    expect(state.chartArtifactsBySession.ses_1).toBeUndefined()
  })

  it('maps MCP status, tracks global errors, toggles sidebar, and dedupes chart artifacts', () => {
    const artifact: SessionArtifact = {
      id: 'artifact-1',
      toolId: 'tool-1',
      toolName: 'chart',
      filename: 'chart.png',
      filePath: '/tmp/chart.png',
      order: 0,
      mime: 'image/png',
    }

    useSessionStore.getState().setMcpConnections([
      { name: 'charts', connected: true },
      { name: 'github', connected: false, rawStatus: 'auth_required', error: 'login' },
    ])
    useSessionStore.getState().addGlobalError('Boom')
    useSessionStore.getState().toggleSidebar()
    useSessionStore.getState().registerChartArtifact('ses_1', artifact)
    useSessionStore.getState().registerChartArtifact('ses_1', { ...artifact, id: 'artifact-2' })

    const state = useSessionStore.getState()
    expect(state.mcpConnections).toEqual([
      { name: 'charts', connected: true, rawStatus: undefined, error: undefined },
      { name: 'github', connected: false, rawStatus: 'auth_required', error: 'login' },
    ])
    expect(state.globalErrors).toEqual([{
      id: '00000000-0000-4000-8000-000000000000',
      sessionId: null,
      message: 'Boom',
      order: expect.any(Number),
    }])
    expect(state.sidebarCollapsed).toBe(true)
    expect(state.chartArtifactsBySession.ses_1).toEqual([{ ...artifact, id: 'artifact-2' }])
  })
})
