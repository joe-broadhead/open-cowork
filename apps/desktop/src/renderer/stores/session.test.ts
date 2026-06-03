import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionArtifact, SessionView } from '@open-cowork/shared'
import type { Session } from './session'
import {
  createEmptySessionViewState,
  deriveVisibleSessionPatch,
  type SessionViewState,
} from '../../lib/session-view-model'
import { useSessionStore } from './session'
import { sessionWorkspaceKey } from './session-workspace-keys'

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

  it('keeps same-id session state separate across workspaces', () => {
    const store = useSessionStore.getState()

    store.setSessions([session('shared', 'Local shared')])
    store.setCurrentSession('shared')
    useSessionStore.getState().setSessionView('shared', view({ sessionCost: 1 }))
    expect(useSessionStore.getState().currentView.sessionCost).toBe(1)

    useSessionStore.getState().setActiveWorkspace('cloud:acme')
    useSessionStore.getState().setSessions([session('shared', 'Cloud shared')])
    useSessionStore.getState().setCurrentSession('shared')
    useSessionStore.getState().setSessionView('shared', view({
      isAwaitingQuestion: true,
      sessionCost: 2,
    }))

    const cloudState = useSessionStore.getState()
    expect(cloudState.sessions[0]?.title).toBe('Cloud shared')
    expect(cloudState.currentView.sessionCost).toBe(2)
    expect(cloudState.awaitingQuestionSessions.has(sessionWorkspaceKey('cloud:acme', 'shared'))).toBe(true)
    expect(cloudState.awaitingQuestionSessions.has('shared')).toBe(false)

    useSessionStore.getState().setActiveWorkspace('local')
    useSessionStore.getState().setCurrentSession('shared')

    const localState = useSessionStore.getState()
    expect(localState.sessions[0]?.title).toBe('Local shared')
    expect(localState.currentView.sessionCost).toBe(1)
    expect(localState.currentView.isAwaitingQuestion).toBe(false)
  })

  it('routes metadata and deletes to exact workspace buckets', () => {
    const store = useSessionStore.getState()

    store.setSessions([session('shared', 'Local shared')])
    useSessionStore.getState().setActiveWorkspace('cloud:acme')
    useSessionStore.getState().setSessions([session('shared', 'Cloud shared')])

    useSessionStore.getState().applySessionMetadata({
      id: 'shared',
      title: 'Local renamed',
    }, 'local')
    expect(useSessionStore.getState().sessions[0]?.title).toBe('Cloud shared')

    useSessionStore.getState().setActiveWorkspace('local')
    expect(useSessionStore.getState().sessions[0]?.title).toBe('Local renamed')

    useSessionStore.getState().removeSession('shared', 'cloud:acme')
    expect(useSessionStore.getState().sessions.map((entry) => entry.id)).toEqual(['shared'])

    useSessionStore.getState().setActiveWorkspace('cloud:acme')
    expect(useSessionStore.getState().sessions).toEqual([])
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

  it('applies streamed patch batches with one store notification', () => {
    const store = useSessionStore.getState()
    store.setCurrentSession('ses_1')

    let notifications = 0
    const unsubscribe = useSessionStore.subscribe(() => {
      notifications += 1
    })

    useSessionStore.getState().applySessionPatches([
      {
        type: 'message_text',
        sessionId: 'ses_1',
        messageId: 'msg_1',
        segmentId: 'seg_1',
        content: 'Hello',
        mode: 'append',
        role: 'assistant',
        eventAt: 10,
      },
      {
        type: 'message_text',
        sessionId: 'ses_1',
        messageId: 'msg_1',
        segmentId: 'seg_1',
        content: ' world',
        mode: 'append',
        role: 'assistant',
        eventAt: 20,
      },
      {
        type: 'task_text',
        sessionId: 'ses_1',
        taskRunId: 'task_1',
        segmentId: 'task_seg',
        content: 'Working',
        mode: 'append',
        eventAt: 30,
      },
    ])
    unsubscribe()

    const state = useSessionStore.getState()
    expect(notifications).toBe(1)
    expect(state.currentView.messages[0]?.content).toBe('Hello world')
    expect(state.currentView.taskRuns[0]?.transcript[0]?.content).toBe('Working')
    expect(state.currentView.lastEventAt).toBe(30)
  })

  it('applies streamed patch batches by main-process event time', () => {
    const store = useSessionStore.getState()
    store.setCurrentSession('ses_1')

    useSessionStore.getState().applySessionPatches([
      {
        type: 'message_text',
        sessionId: 'ses_1',
        messageId: 'msg_1',
        segmentId: 'seg_1',
        content: ' world',
        mode: 'append',
        role: 'assistant',
        eventAt: 20,
      },
      {
        type: 'message_text',
        sessionId: 'ses_1',
        messageId: 'msg_1',
        segmentId: 'seg_1',
        content: 'Hello',
        mode: 'append',
        role: 'assistant',
        eventAt: 10,
      },
    ])

    const state = useSessionStore.getState()
    expect(state.currentView.messages[0]?.content).toBe('Hello world')
    expect(state.currentView.lastEventAt).toBe(20)
  })

  it('keeps streamed text after existing tools in later timeline segments', () => {
    const store = useSessionStore.getState()
    store.setCurrentSession('ses_1')
    store.setSessionView('ses_1', view({
      messages: [{
        id: 'msg_1',
        role: 'assistant',
        content: 'Before tool.',
        segments: [{ id: 'seg_1', content: 'Before tool.', order: 1 }],
        order: 1,
      }],
      toolCalls: [{
        id: 'tool_1',
        name: 'read',
        input: {},
        status: 'complete',
        order: 2,
      }],
      taskRuns: [{
        id: 'task_1',
        title: 'Research',
        agent: 'research',
        status: 'running',
        sourceSessionId: 'child_1',
        parentSessionId: null,
        content: 'Before task tool.',
        transcript: [{ id: 'task_seg', content: 'Before task tool.', order: 1 }],
        toolCalls: [{
          id: 'task_tool_1',
          name: 'read',
          input: {},
          status: 'complete',
          order: 2,
        }],
        compactions: [],
        todos: [],
        error: null,
        sessionCost: 0,
        sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        order: 3,
      }],
    }))

    useSessionStore.getState().applySessionPatches([
      {
        type: 'message_text',
        sessionId: 'ses_1',
        messageId: 'msg_1',
        segmentId: 'seg_1',
        content: 'After tool.',
        mode: 'append',
        role: 'assistant',
        eventAt: 10,
      },
      {
        type: 'task_text',
        sessionId: 'ses_1',
        taskRunId: 'task_1',
        segmentId: 'task_seg',
        content: 'After task tool.',
        mode: 'append',
        eventAt: 20,
      },
    ])

    const state = useSessionStore.getState()
    expect(state.currentView.messages[0]?.segments).toHaveLength(2)
    expect(state.currentView.messages[0]?.segments?.[1]?.content).toBe('After tool.')
    expect(state.currentView.messages[0]?.segments?.[1]?.order).toBeGreaterThan(
      state.currentView.toolCalls[0]?.order ?? 0,
    )
    expect(state.currentView.taskRuns[0]?.transcript).toHaveLength(2)
    expect(state.currentView.taskRuns[0]?.transcript[1]?.content).toBe('After task tool.')
    expect(state.currentView.taskRuns[0]?.transcript[1]?.order).toBeGreaterThan(
      state.currentView.taskRuns[0]?.toolCalls[0]?.order ?? 0,
    )
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
    useSessionStore.getState().dismissGlobalError('00000000-0000-4000-8000-000000000000')
    expect(useSessionStore.getState().globalErrors).toEqual([])
    expect(state.sidebarCollapsed).toBe(true)
    expect(state.chartArtifactsBySession.ses_1).toEqual([{ ...artifact, id: 'artifact-2' }])
  })
})
