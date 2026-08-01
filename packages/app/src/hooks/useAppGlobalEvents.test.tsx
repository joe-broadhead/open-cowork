import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppView } from '../app-types'
import { useSessionStore } from '../stores/session'
import { installRendererTestCoworkApi } from '../test/setup'
import { useAppGlobalEvents } from './useAppGlobalEvents'
import { registerVoicePttToggleHandler } from './voice-ptt-hotkey'

type MenuActionCallback = (action: 'new-thread' | 'command-palette' | 'search' | 'toggle-sidebar' | 'export' | `project-switch:${number}`) => void

function resetSessionStore() {
  useSessionStore.setState({
    activeWorkspaceId: 'local',
    sessionsByWorkspace: { local: [] },
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
  switchByIndex?: ReturnType<typeof vi.fn>
  reportRendererError?: ReturnType<typeof vi.fn>
  onMenuAction?: (callback: MenuActionCallback) => void
  voicePttShortcut?: string
  settingsGet?: () => Promise<{ voicePttShortcut?: string }>
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
    projects: {
      switchByIndex: options.switchByIndex || vi.fn(async () => null),
    },
    settings: {
      get: vi.fn(options.settingsGet || (async () => ({ voicePttShortcut: options.voicePttShortcut }))) as never,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function Harness({ view = 'chat', voiceEnabled = true }: { view?: AppView; voiceEnabled?: boolean }) {
  useAppGlobalEvents({
    runtimeReady: true,
    voiceEnabled,
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

  it('upserts project shortcut sessions instead of duplicating existing ids', async () => {
    let menuAction: MenuActionCallback | null = null
    const switchByIndex = vi.fn(async () => ({
      id: 'session-1',
      title: 'Session 1',
      directory: '/tmp/project',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:01:00.000Z',
    }))
    installGlobalEventsApi({
      switchByIndex,
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
    callback('project-switch:1')

    await waitFor(() => {
      expect(switchByIndex).toHaveBeenCalledWith(1)
      expect(useSessionStore.getState().currentSessionId).toBe('session-1')
    })
    expect(useSessionStore.getState().sessions.filter((session) => session.id === 'session-1')).toHaveLength(1)
  })

  it.each([
    'cloud:test',
    'paired-desktop:device-1',
  ])('does not run a Desktop Local project shortcut or contaminate the active %s cache', async (workspaceId) => {
    let menuAction: MenuActionCallback | null = null
    const switchByIndex = vi.fn(async () => ({
      id: 'local-project-session',
      title: 'Local project session',
      directory: '/tmp/local-project',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:01:00.000Z',
    }))
    useSessionStore.getState().setActiveWorkspace(workspaceId)
    useSessionStore.getState().setSessions([{
      id: 'remote-session',
      title: 'Remote session',
      directory: null,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    }], workspaceId)
    installGlobalEventsApi({
      switchByIndex,
      onMenuAction: (callback) => {
        menuAction = callback
      },
    })
    render(<Harness />)

    await waitFor(() => expect(menuAction).not.toBeNull())
    const callback = menuAction as MenuActionCallback | null
    if (!callback) throw new Error('menu action callback was not registered')
    await act(async () => {
      callback('project-switch:1')
      await Promise.resolve()
    })

    expect(switchByIndex).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessionsByWorkspace[workspaceId]?.map((session) => session.id)).toEqual(['remote-session'])
    expect(useSessionStore.getState().sessionsByWorkspace.local?.map((session) => session.id)).toEqual(['session-1'])
  })

  it('uses the saved Voice shortcut after restart and accepts a same-session settings update', async () => {
    const toggle = vi.fn()
    const unregister = registerVoicePttToggleHandler(toggle)
    const api = installGlobalEventsApi({ voicePttShortcut: 'CmdOrCtrl+Alt+V' })
    render(<Harness />)

    await waitFor(() => expect(api.settings.get).toHaveBeenCalled())
    await waitFor(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'v',
        ctrlKey: true,
        altKey: true,
      }))
      expect(toggle).toHaveBeenCalledTimes(1)
    })

    window.dispatchEvent(new CustomEvent('open-cowork:voice-shortcut-changed', {
      detail: { shortcut: 'CmdOrCtrl+Shift+U' },
    }))
    await waitFor(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'u',
        ctrlKey: true,
        shiftKey: true,
      }))
      expect(toggle).toHaveBeenCalledTimes(2)
    })
    unregister()
  })

  it('leaves the saved Voice accelerator available to the product when Voice is off', async () => {
    const toggle = vi.fn()
    const unregister = registerVoicePttToggleHandler(toggle)
    const api = installGlobalEventsApi({ voicePttShortcut: 'CmdOrCtrl+Alt+V' })
    render(<Harness voiceEnabled={false} />)

    const keydown = new KeyboardEvent('keydown', {
      key: 'v',
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    })
    window.dispatchEvent(keydown)

    expect(keydown.defaultPrevented).toBe(false)
    expect(toggle).not.toHaveBeenCalled()
    expect(api.settings.get).not.toHaveBeenCalled()
    unregister()
  })

  it('does not claim a legacy Shift-only Voice shortcut while typing', async () => {
    const toggle = vi.fn()
    const unregister = registerVoicePttToggleHandler(toggle)
    const api = installGlobalEventsApi({ voicePttShortcut: 'Shift+A' })
    render(<Harness />)

    await waitFor(() => expect(api.settings.get).toHaveBeenCalled())
    const keydown = new KeyboardEvent('keydown', {
      key: 'A',
      shiftKey: true,
      cancelable: true,
    })
    window.dispatchEvent(keydown)

    expect(keydown.defaultPrevented).toBe(false)
    expect(toggle).not.toHaveBeenCalled()
    unregister()
  })

  it('keeps a shortcut-change event authoritative over a late initial settings read', async () => {
    const initialSettings = deferred<{ voicePttShortcut: string }>()
    const settingsGet = vi.fn(() => initialSettings.promise)
    const toggle = vi.fn()
    const unregister = registerVoicePttToggleHandler(toggle)
    installGlobalEventsApi({ settingsGet })
    render(<Harness />)

    await waitFor(() => expect(settingsGet).toHaveBeenCalledTimes(1))
    act(() => {
      window.dispatchEvent(new CustomEvent('open-cowork:voice-shortcut-changed', {
        detail: { shortcut: 'CmdOrCtrl+Shift+U' },
      }))
    })
    await act(async () => {
      initialSettings.resolve({ voicePttShortcut: 'CmdOrCtrl+Alt+V' })
      await initialSettings.promise
    })

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'u',
        ctrlKey: true,
        shiftKey: true,
      }))
    })
    expect(toggle).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'v',
        ctrlKey: true,
        altKey: true,
      }))
    })
    expect(toggle).toHaveBeenCalledTimes(1)
    unregister()
  })
})
