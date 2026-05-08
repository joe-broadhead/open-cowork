import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppView } from '../app-types'
import { useSessionStore } from '../stores/session'
import { installRendererTestCoworkApi } from '../test/setup'
import { useAppGlobalEvents } from './useAppGlobalEvents'

type MenuActionCallback = (action: 'new-thread' | 'command-palette' | 'search' | 'toggle-sidebar' | 'export') => void

function resetSessionStore() {
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
  useSessionStore.getState().setSessions([
    {
      id: 'session-1',
      title: 'Session 1',
      directory: '/tmp/project',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    },
  ])
  useSessionStore.getState().setCurrentSession('session-1')
}

function installGlobalEventsApi(options: {
  revert?: ReturnType<typeof vi.fn>
  unrevert?: ReturnType<typeof vi.fn>
  exportSession?: ReturnType<typeof vi.fn>
  reportRendererError?: ReturnType<typeof vi.fn>
  onMenuAction?: (callback: MenuActionCallback) => void
} = {}) {
  return installRendererTestCoworkApi({
    diagnostics: {
      reportRendererError: options.reportRendererError || vi.fn(),
    },
    session: {
      activate: vi.fn(async () => ({
        messages: [],
        toolCalls: [],
        taskRuns: [],
        compactions: [],
        pendingApprovals: [],
        pendingQuestions: [],
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
        revision: 0,
        lastEventAt: 0,
        isGenerating: false,
        isAwaitingPermission: false,
        isAwaitingQuestion: false,
      })),
      revert: options.revert || vi.fn(async () => true),
      unrevert: options.unrevert || vi.fn(async () => true),
      export: options.exportSession || vi.fn(async () => null),
    },
    on: {
      menuAction: vi.fn((callback: MenuActionCallback) => {
        options.onMenuAction?.(callback)
        return vi.fn()
      }),
      menuNavigate: vi.fn(() => vi.fn()),
    },
  })
}

function Harness({ view = 'chat' }: { view?: AppView }) {
  useAppGlobalEvents({
    runtimeReady: true,
    view,
    currentSessionId: 'session-1',
    toggleSidebar: vi.fn(),
    createAndActivateSession: vi.fn(async () => null),
    openSidebarSearch: vi.fn(),
    openSidebarSettings: vi.fn(),
    setView: vi.fn(),
    setAuthenticated: vi.fn(),
    setShowCommandPalette: vi.fn(),
  })
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSessionStore()
})

describe('useAppGlobalEvents', () => {
  it('surfaces failed keyboard session reverts through the chat error channel and diagnostics', async () => {
    const revert = vi.fn(async () => {
      throw new Error('runtime rejected revert')
    })
    const reportRendererError = vi.fn()
    const api = installGlobalEventsApi({ revert, reportRendererError })
    render(<Harness />)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))

    await waitFor(() => {
      expect(revert).toHaveBeenCalledWith('session-1')
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not revert this session. Please try again.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('runtime rejected revert'),
      view: 'global-actions',
    }))
  })

  it('surfaces false unrevert responses and keeps diagnostics best-effort', async () => {
    const unrevert = vi.fn(async () => false)
    installGlobalEventsApi({
      unrevert,
      reportRendererError: vi.fn(() => {
        throw new Error('diagnostics unavailable')
      }),
    })
    render(<Harness />)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', shiftKey: true, metaKey: true }))

    await waitFor(() => {
      expect(unrevert).toHaveBeenCalledWith('session-1')
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not unrevert this session. Please try again.')
  })

  it('surfaces failed menu exports through the chat error channel and diagnostics', async () => {
    let menuAction: MenuActionCallback | null = null
    const exportSession = vi.fn(async () => {
      throw new Error('export failed')
    })
    const reportRendererError = vi.fn()
    const api = installGlobalEventsApi({
      exportSession,
      reportRendererError,
      onMenuAction: (callback) => {
        menuAction = callback
      },
    })
    render(<Harness />)

    await waitFor(() => {
      expect(menuAction).not.toBeNull()
    })
    const callback = menuAction as MenuActionCallback | null
    if (!callback) throw new Error('menu action callback was not registered')
    callback('export')

    await waitFor(() => {
      expect(exportSession).toHaveBeenCalledWith('session-1')
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not export this thread. Please try again.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('export failed'),
      view: 'global-actions',
    }))
  })
})
