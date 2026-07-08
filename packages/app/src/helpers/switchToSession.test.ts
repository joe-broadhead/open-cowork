import { describe, expect, it, vi } from 'vitest'
import type { SessionView } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../test/setup'
import { useSessionStore } from '../stores/session'
import { LOCAL_WORKSPACE_ID, sessionWorkspaceKey } from '../stores/session-workspace-keys'
import { switchToSession } from './switchToSession'

function resetSessionStore() {
  useSessionStore.setState({
    sessions: [
      {
        id: 'session-1',
        title: 'Session 1',
        directory: '/tmp/project',
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z',
      },
    ],
    activeWorkspaceId: LOCAL_WORKSPACE_ID,
    sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: [] },
    currentSessionId: null,
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
}

describe('switchToSession', () => {
  it('surfaces activation failures through the chat error channel and diagnostics', async () => {
    const activate = vi.fn(async () => {
      throw new Error('activation ipc failed')
    })
    const reportRendererError = vi.fn()
    const api = installRendererTestCoworkApi({
      diagnostics: {
        reportRendererError,
      },
      session: {
        activate,
      },
    })
    resetSessionStore()

    await switchToSession('session-1')

    expect(activate).toHaveBeenCalledWith('session-1', { workspaceId: LOCAL_WORKSPACE_ID })
    expect(useSessionStore.getState().currentSessionId).toBe('session-1')
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load this thread. Try reopening it.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('activation ipc failed'),
      view: 'chat',
    }))
  })

  it('does not hydrate a session view after the active workspace changes', async () => {
    let resolveActivate: (view: SessionView) => void = () => {
      throw new Error('activate promise resolver was not initialized')
    }
    const activate = vi.fn(() => new Promise<SessionView>((resolve) => {
      resolveActivate = resolve
    }))
    installRendererTestCoworkApi({
      session: {
        activate,
      },
    })
    resetSessionStore()
    useSessionStore.getState().setActiveWorkspace('cloud:one')

    const loading = switchToSession('same-session-id')
    useSessionStore.getState().setActiveWorkspace('cloud:two')
    resolveActivate({
      messages: [{
        id: 'stale',
        role: 'assistant',
        content: 'stale cloud view',
        timestamp: '2026-05-08T00:00:00.000Z',
        order: 1,
        segments: [{ id: 'stale:text', content: 'stale cloud view', order: 1 }],
      }],
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
      sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      lastInputTokens: 0,
      contextState: 'idle',
      compactionCount: 0,
      lastCompactedAt: null,
      activeAgent: null,
      lastItemWasTool: false,
      revision: 1,
      lastEventAt: 1,
      isGenerating: false,
      isAwaitingPermission: false,
      isAwaitingQuestion: false,
    })
    await loading

    expect(activate).toHaveBeenCalledWith('same-session-id', { workspaceId: 'cloud:one' })
    expect(useSessionStore.getState().activeWorkspaceId).toBe('cloud:two')
    expect(useSessionStore.getState().sessionStateById[sessionWorkspaceKey('cloud:two', 'same-session-id')]).toBeUndefined()
    expect(useSessionStore.getState().sessionStateById[sessionWorkspaceKey('cloud:one', 'same-session-id')]?.hydrated).toBe(false)
    expect(useSessionStore.getState().sessionStateById[sessionWorkspaceKey('cloud:one', 'same-session-id')]?.messageIds).toEqual([])
  })
})
