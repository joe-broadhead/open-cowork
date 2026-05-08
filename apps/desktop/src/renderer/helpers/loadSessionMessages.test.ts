import { describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../test/setup'
import { useSessionStore } from '../stores/session'
import { switchToSession } from './loadSessionMessages'

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

    expect(activate).toHaveBeenCalledWith('session-1', undefined)
    expect(useSessionStore.getState().currentSessionId).toBe('session-1')
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load this thread. Try reopening it.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('activation ipc failed'),
      view: 'chat',
    }))
  })
})
