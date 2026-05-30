import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../../stores/session'
import { WORKSPACE_SUPPORT_APIS, useWorkspaceSupportStore } from '../../stores/workspace-support'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ChatInput } from './ChatInput'

const HISTORY_KEY = 'open-cowork-prompt-history'

function seedCurrentSession() {
  useWorkspaceSupportStore.setState({
    supportByWorkspace: {},
    loadedByWorkspace: {},
    loadingByWorkspace: {},
    errorByWorkspace: {},
  })
  useSessionStore.setState({
    activeWorkspaceId: 'local',
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
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    },
  ])
  useSessionStore.getState().setCurrentSession('session-1')
}

function seedCloudSession() {
  useSessionStore.setState({
    activeWorkspaceId: 'cloud:test',
    sessionsByWorkspace: {
      'cloud:test': [{
        id: 'session-1',
        title: 'Cloud session',
        directory: null,
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      }],
    },
    sessions: [{
      id: 'session-1',
      title: 'Cloud session',
      directory: null,
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    }],
    currentSessionId: 'session-1',
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
  useWorkspaceSupportStore.setState({
    supportByWorkspace: {
      'cloud:test': WORKSPACE_SUPPORT_APIS.map((api) => {
        if (api === 'localFiles' || api === 'machineRuntimeConfig' || api === 'artifacts.reveal') {
          return {
            api,
            status: 'not_supported',
            verdict: {
              allowed: false,
              reason: api === 'localFiles'
                ? 'Cloud workspaces do not implicitly upload local files.'
                : 'This cloud profile manages runtime configuration.',
            },
          }
        }
        return { api, status: 'supported', verdict: { allowed: true, reason: null } }
      }),
    },
    loadedByWorkspace: { 'cloud:test': true },
    loadingByWorkspace: {},
    errorByWorkspace: {},
  })
}

function installModelRuntime() {
  return installRendererTestCoworkApi({
    app: {
      config: vi.fn(async () => ({
        appId: 'com.opencowork.desktop',
        name: 'Open Cowork',
        helpUrl: 'https://github.com/joe-broadhead/open-cowork',
        defaultModel: 'model-a',
        providers: {
          available: [{
            id: 'openrouter',
            models: [
              { id: 'model-a', name: 'Model A', featured: true, reasoning: true, variants: ['low', 'xhigh'] },
              { id: 'model-b', name: 'Model B', featured: false, reasoning: true, variants: ['low', 'xhigh'] },
            ],
          }],
        },
        auth: { mode: 'none' },
      })),
    },
    settings: {
      get: vi.fn(async () => ({
        selectedProviderId: 'openrouter',
        selectedModelId: 'model-a',
        providerCredentials: {},
        integrationCredentials: {},
        integrationEnabled: {},
        bashPermission: 'deny',
        fileWritePermission: 'deny',
        enableBash: false,
        enableFileWrite: false,
        runtimeToolingBridgeEnabled: true,
        workflowLaunchAtLogin: false,
        workflowRunInBackground: false,
        workflowDesktopNotifications: true,
        workflowQuietHoursStart: null,
        workflowQuietHoursEnd: null,
        effectiveProviderId: 'openrouter',
        effectiveModel: 'model-a',
      })),
      set: vi.fn(async () => {
        throw new Error('chat model changes must stay session-scoped')
      }),
    },
    on: {
      runtimeReady: vi.fn(() => () => undefined),
    },
  })
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('ChatInput', () => {
  it('resizes the textarea when navigating prompt history', async () => {
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => ({
          appId: 'com.opencowork.desktop',
          name: 'Open Cowork',
          helpUrl: 'https://github.com/joe-broadhead/open-cowork',
          defaultModel: null,
          providers: { available: [] },
          auth: { mode: 'none' },
        })),
      },
      on: {
        runtimeReady: vi.fn(() => () => undefined),
      },
    })
    const longPrompt = ['first line', 'second line', 'third line', 'fourth line'].join('\n')
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify([longPrompt]))
    seedCurrentSession()

    render(<ChatInput />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    textarea.style.fontSize = '20px'
    textarea.style.lineHeight = '30px'
    let scrollHeight = 300
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })

    textarea.setSelectionRange(0, 0)
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    await waitFor(() => expect(textarea).toHaveValue(longPrompt))
    await waitFor(() => expect(textarea.style.height).toBe('240px'))
    expect(textarea.style.maxHeight).toBe('8lh')

    scrollHeight = 48
    textarea.setSelectionRange(longPrompt.length, longPrompt.length)
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })

    await waitFor(() => expect(textarea).toHaveValue(''))
    await waitFor(() => expect(textarea.style.height).toBe('48px'))
  })

  it('surfaces prompt IPC failures through the chat error channel and diagnostics', async () => {
    const prompt = vi.fn(async () => {
      throw new Error('provider offline')
    })
    const reportRendererError = vi.fn()
    const api = installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => ({
          appId: 'com.opencowork.desktop',
          name: 'Open Cowork',
          helpUrl: 'https://github.com/joe-broadhead/open-cowork',
          defaultModel: null,
          providers: { available: [] },
          auth: { mode: 'none' },
        })),
      },
      diagnostics: {
        reportRendererError,
      },
      on: {
        runtimeReady: vi.fn(() => () => undefined),
      },
      session: {
        prompt,
      },
    })
    seedCurrentSession()

    render(<ChatInput />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Summarize this' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(prompt).toHaveBeenCalledWith(
      'session-1',
      'Summarize this',
      undefined,
      'build',
    ))
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not send the prompt. Please try again.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('provider offline'),
      view: 'chat',
    }))
  })

  it('surfaces chat settings load failures through the chat error channel and diagnostics', async () => {
    const get = vi.fn(async () => {
      throw new Error('settings offline')
    })
    const reportRendererError = vi.fn()
    const api = installRendererTestCoworkApi({
      diagnostics: {
        reportRendererError,
      },
      on: {
        runtimeReady: vi.fn(() => () => undefined),
      },
      settings: {
        get,
      },
    })
    seedCurrentSession()

    render(<ChatInput />)

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load chat settings. The composer may show stale model options.')
    })
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('settings offline'),
      view: 'chat',
    }))
  })

  it('restores model and reasoning selections per session', async () => {
    const user = userEvent.setup()
    const api = installModelRuntime()
    useSessionStore.setState({
      globalErrors: [],
      busySessions: new Set(),
      awaitingPermissionSessions: new Set(),
      awaitingQuestionSessions: new Set(),
      sessionStateById: {},
      chartArtifactsBySession: {},
    })
    useSessionStore.getState().setSessions([
      {
        id: 'session-a',
        title: 'Session A',
        directory: '/tmp/project-a',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        composerModelId: 'model-b',
        composerReasoningVariant: 'xhigh',
      },
      {
        id: 'session-b',
        title: 'Session B',
        directory: '/tmp/project-b',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        composerModelId: 'model-a',
        composerReasoningVariant: null,
      },
    ])
    useSessionStore.getState().setCurrentSession('session-a')

    render(<ChatInput />)

    expect(await screen.findByRole('button', { name: /Model B/ })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Think XHigh/ })).toBeTruthy()

    useSessionStore.getState().setCurrentSession('session-b')
    expect(await screen.findByRole('button', { name: /Model A/ })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Think Auto/ })).toBeTruthy()

    useSessionStore.getState().setCurrentSession('session-a')
    expect(await screen.findByRole('button', { name: /Model B/ })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Think XHigh/ })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /Model B/ }))
    await user.click(await screen.findByRole('option', { name: /Model A/ }))

    await waitFor(() => {
      expect(api.session.setComposerPreferences).toHaveBeenCalledWith('session-a', { modelId: 'model-a' })
    })
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  it('gates cloud composer controls and sends prompts with workspace scope', async () => {
    const api = installModelRuntime()
    seedCloudSession()

    render(<ChatInput />)

    expect(await screen.findByRole('button', { name: /Model A/ })).toBeDisabled()
    expect(screen.getByTitle('Cloud workspaces do not implicitly upload local files.')).toBeDisabled()

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Continue in cloud' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(api.session.prompt).toHaveBeenCalledWith(
        'session-1',
        'Continue in cloud',
        undefined,
        'build',
        { workspaceId: 'cloud:test' },
      )
    })
    expect(api.session.setComposerPreferences).not.toHaveBeenCalled()
  })

  it('does not let a stale failed composer save roll back the latest reasoning choice', async () => {
    const user = userEvent.setup()
    const api = installModelRuntime()
    const firstSave = createDeferred<null>()
    vi.mocked(api.session.setComposerPreferences)
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(async () => null)
    seedCurrentSession()

    render(<ChatInput />)

    await user.click(await screen.findByRole('button', { name: /Think Auto/ }))
    await user.click(await screen.findByRole('option', { name: /Low/ }))

    expect(useSessionStore.getState().sessions[0]?.composerReasoningVariant).toBe('low')

    await user.click(await screen.findByRole('button', { name: /Think Low/ }))
    await user.click(await screen.findByRole('option', { name: /XHigh/ }))

    await waitFor(() => {
      expect(api.session.setComposerPreferences).toHaveBeenCalledWith('session-1', { reasoningVariant: 'xhigh' })
    })

    firstSave.reject(new Error('older save failed'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Think XHigh/ })).toBeTruthy()
    })
    expect(useSessionStore.getState().sessions[0]?.composerReasoningVariant).toBe('xhigh')
    expect(useSessionStore.getState().globalErrors).toHaveLength(0)
  })
})
