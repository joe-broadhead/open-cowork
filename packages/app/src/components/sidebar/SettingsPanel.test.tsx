import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SMALL_MODEL_USE_MAIN, type EffectiveAppSettings, type PublicAppConfig } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { WORKSPACE_SUPPORT_APIS, useWorkspaceSupportStore } from '../../stores/workspace-support'
import { SettingsPanel } from './SettingsPanel'

function settings(overrides: Partial<EffectiveAppSettings> = {}): EffectiveAppSettings {
  return {
    selectedProviderId: 'openrouter',
    selectedModelId: 'anthropic/claude-sonnet-4',
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission: 'deny',
    fileWritePermission: 'deny',
    webPermission: 'allow',
    webSearchEnabled: true,
    taskPermission: 'allow',
    externalDirectoryPermission: 'allow',
    mcpPermission: 'allow',
    requireApprovalBeforeSending: true,
    notificationVoiceReplies: true,
    notificationSmartSuggestions: true,
    notificationDailyDigest: false,
    notificationSounds: true,
    privacyKeepConversationHistory: true,
    privacyShareAnonymizedUsage: false,
    runtimeToolingBridgeEnabled: true,
    windowZoomFactor: 1,
    workflowLaunchAtLogin: false,
    workflowRunInBackground: false,
    workflowDesktopNotifications: true,
    workflowQuietHoursStart: null,
    workflowQuietHoursEnd: null,
    effectiveProviderId: 'openrouter',
    effectiveModel: 'anthropic/claude-sonnet-4',
    ...overrides,
  }
}

const config: PublicAppConfig = {
  branding: {
    name: 'Open Cowork',
    appId: 'com.opencowork.desktop',
    dataDirName: 'Open Cowork',
    helpUrl: 'https://github.com/joe-broadhead/open-cowork',
  },
  auth: {
    mode: 'none',
    enabled: false,
  },
  providers: {
    defaultProvider: 'openrouter',
    defaultModel: 'anthropic/claude-sonnet-4',
    available: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        description: 'OpenRouter models',
        connected: false,
        credentials: [
          {
            key: 'apiKey',
            label: 'API key',
            description: 'OpenRouter API key',
            placeholder: 'sk-or-...',
            secret: true,
            required: true,
          },
          {
            key: 'teamId',
            label: 'Team ID',
            description: 'Optional team identifier',
            placeholder: 'team-...',
            secret: false,
            required: false,
          },
        ],
        models: [
          { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
        ],
        defaultModel: 'anthropic/claude-sonnet-4',
      },
    ],
  },
  permissions: {
    bash: 'allow',
    fileWrite: 'allow',
    task: 'allow',
    web: 'allow',
    webSearch: true,
  },
  agentStarterTemplates: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({
    activeWorkspaceId: 'local',
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
  useWorkspaceSupportStore.setState({
    supportByWorkspace: {},
    loadedByWorkspace: {},
    loadingByWorkspace: {},
    errorByWorkspace: {},
  })
})

describe('SettingsPanel', () => {
  it('surfaces initial settings load failures through the chat error channel and diagnostics', async () => {
    const reportRendererError = vi.fn()
    installRendererTestCoworkApi({
      diagnostics: {
        reportRendererError,
      },
      settings: {
        get: vi.fn(async () => {
          throw new Error('settings unavailable')
        }),
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load settings. Please try again.')
    })
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('settings unavailable'),
      view: 'settings',
    }))
  })

  it('surfaces provider credential load failures through the chat error channel and diagnostics', async () => {
    const reportRendererError = vi.fn()
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => config),
      },
      diagnostics: {
        reportRendererError,
      },
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => {
          throw new Error('keychain unavailable')
        }),
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load provider credentials. Please try again.')
    })
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('keychain unavailable'),
      view: 'settings',
    }))
  })

  it('surfaces provider credential reload failures after saving settings', async () => {
    const user = userEvent.setup()
    const reportRendererError = vi.fn()
    const getProviderCredentials = vi.fn()
      .mockResolvedValueOnce({ apiKey: 'sk-or-initial' })
      .mockRejectedValueOnce(new Error('reload unavailable'))
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => config),
      },
      diagnostics: {
        reportRendererError,
      },
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials,
        set: vi.fn(async (updates: Partial<EffectiveAppSettings>) => settings(updates)),
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await waitFor(() => expect(getProviderCredentials).toHaveBeenCalledTimes(1))
    // Save only persists when there are unsaved edits, so make one first.
    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    await user.click(screen.getByRole('switch', { name: 'Voice replies' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Settings saved, but provider credentials could not be reloaded. Please reopen Settings.')
    })
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('reload unavailable'),
      view: 'settings',
    }))
  })

  it('persists explicit Studio permission modes and review gates', async () => {
    const settingsSet = vi.mocked(window.coworkApi.settings.set)
    const user = userEvent.setup()

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Permissions/ }))

    await user.click(within(screen.getByRole('radiogroup', { name: 'Shell commands' })).getByRole('radio', { name: 'Allow' }))
    await user.click(within(screen.getByRole('radiogroup', { name: 'File editing' })).getByRole('radio', { name: 'Allow' }))
    await user.click(within(screen.getByRole('radiogroup', { name: 'Open web pages' })).getByRole('radio', { name: 'Ask' }))
    await user.click(screen.getByRole('switch', { name: 'Web search' }))
    await user.click(within(screen.getByRole('radiogroup', { name: 'Delegate to coworkers' })).getByRole('radio', { name: 'Ask' }))
    await user.click(within(screen.getByRole('radiogroup', { name: 'Managed external directories' })).getByRole('radio', { name: 'Ask' }))
    await user.click(within(screen.getByRole('radiogroup', { name: 'MCP tools' })).getByRole('radio', { name: 'Off' }))
    expect(screen.getByText('External-send review will be controlled here when Gateway delivery policy enforcement is wired. Existing provider and tool approval policies remain in force.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Advanced/ }))
    // JOE-876: RuntimeConfigPanel is collapsed by default — expand progressive disclosure first.
    await user.click(await screen.findByRole('button', { name: 'Show advanced' }))
    const toolingBridge = await screen.findByRole('switch', { name: 'Developer config bridge' })
    expect(toolingBridge).toHaveAttribute('aria-checked', 'true')

    await user.click(toolingBridge)
    expect(toolingBridge).toHaveAttribute('aria-checked', 'false')

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toMatchObject({
      bashPermission: 'allow',
      fileWritePermission: 'allow',
      webPermission: 'ask',
      webSearchEnabled: false,
      taskPermission: 'ask',
      externalDirectoryPermission: 'ask',
      mcpPermission: 'deny',
      runtimeToolingBridgeEnabled: false,
    })
  })

  it('persists notification and privacy preferences', async () => {
    const settingsSet = vi.mocked(window.coworkApi.settings.set)
    const user = userEvent.setup()

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    await user.click(screen.getByRole('switch', { name: 'Voice replies' }))
    await user.click(screen.getByRole('switch', { name: 'Daily digest' }))
    await user.click(screen.getByRole('button', { name: /Privacy/ }))
    expect(screen.getByText('Session retention stays managed by OpenCode runtime history and explicit storage cleanup until a verified retention policy is available.')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Help improve the product' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toMatchObject({
      notificationVoiceReplies: false,
      notificationDailyDigest: true,
      privacyShareAnonymizedUsage: true,
    })
  })

  it('keeps the Save button idle until there are unsaved edits and returns to idle after saving', async () => {
    const settingsSet = vi.mocked(window.coworkApi.settings.set)
    const user = userEvent.setup()

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')

    // Clean state: the Save button is disabled and explains why.
    const cleanSave = screen.getByRole('button', { name: 'Save Changes' })
    expect(cleanSave).toBeDisabled()
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument()

    // An edit makes it dirty and enables Save.
    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    await user.click(screen.getByRole('switch', { name: 'Daily digest' }))
    const dirtySave = screen.getByRole('button', { name: 'Save Changes' })
    expect(dirtySave).toBeEnabled()

    await user.click(dirtySave)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))

    // After a successful save it flashes "Saved", then settles back to idle/disabled.
    await screen.findByRole('button', { name: 'Saved' })
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled(),
      { timeout: 3000 },
    )
  })

  it('guards close with a discard confirmation when there are unsaved edits', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(<SettingsPanel onClose={onClose} />)

    await screen.findByText('Settings')

    // No edits yet: closing goes straight through.
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    onClose.mockClear()

    // Make an edit, then attempt to close: a discard confirmation intercepts.
    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    await user.click(screen.getByRole('switch', { name: 'Daily digest' }))
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument()

    // Keep editing dismisses the prompt without closing, and the edit survives —
    // the panel is still dirty so Save stays enabled.
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()

    // Re-open the prompt and confirm the discard: now it actually closes.
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('persists an explicit OpenCode small model choice', async () => {
    const settingsSet = vi.mocked(window.coworkApi.settings.set)
    const user = userEvent.setup()
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => config),
      },
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => ({})),
        set: settingsSet,
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Advanced/ }))
    await user.type(screen.getByLabelText('Model ID'), 'qwen/qwen3-coder-flash')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toMatchObject({
      selectedSmallModelId: 'qwen/qwen3-coder-flash',
    })
  })

  it('keeps the small model linked to the main model when requested', async () => {
    const settingsSet = vi.mocked(window.coworkApi.settings.set)
    const user = userEvent.setup()
    const configWithProviderSmallModel: PublicAppConfig = {
      ...config,
      providers: {
        ...config.providers,
        available: config.providers.available.map((provider) => provider.id === 'openrouter'
          ? { ...provider, smallModel: 'qwen/qwen3-coder-flash' }
          : provider),
      },
    }
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => configWithProviderSmallModel),
      },
      settings: {
        get: vi.fn(async () => settings({
          selectedSmallModelId: 'openrouter/old-small',
          effectiveSmallModel: 'openrouter/old-small',
        })),
        getProviderCredentials: vi.fn(async () => ({})),
        set: settingsSet,
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Advanced/ }))
    await user.click(screen.getByRole('button', { name: 'Use main model' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toMatchObject({
      selectedSmallModelId: SMALL_MODEL_USE_MAIN,
    })
  })

  it('does not expose autonomous learning controls in workflow settings', async () => {
    const user = userEvent.setup()

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Playbooks/ }))

    expect(screen.queryByRole('switch', { name: 'Improvement proposals' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Scheduled consolidation' })).not.toBeInTheDocument()
  })

  it('limits cloud settings to portable policy-managed fields', async () => {
    const user = userEvent.setup()
    const settingsSet = vi.fn(async (updates: Partial<EffectiveAppSettings>) => settings(updates))
    const getProviderCredentials = vi.fn(async () => ({ apiKey: 'should-not-load' }))
    useSessionStore.setState({ activeWorkspaceId: 'cloud:test' })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: {
        'cloud:test': WORKSPACE_SUPPORT_APIS.map((api) => ({
          api,
          status: api === 'settings.portable' ? 'supported' : 'not_supported',
          verdict: {
            allowed: api === 'settings.portable',
            reason: api === 'settings.portable' ? null : 'Blocked by cloud policy.',
          },
        })),
      },
      loadedByWorkspace: { 'cloud:test': true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => config),
      },
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials,
        set: settingsSet,
      },
      artifact: {
        storageStats: vi.fn(async () => {
          throw new Error('local storage must not load for cloud settings')
        }),
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Model/ }))

    expect(screen.getByText('Cloud profile runtime')).toBeInTheDocument()
    expect(screen.queryByText('Permissions')).not.toBeInTheDocument()
    expect(screen.queryByText('Storage')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('sk-or-...')).not.toBeInTheDocument()
    expect(getProviderCredentials).not.toHaveBeenCalled()

    // Save only persists when there are unsaved edits, so toggle a portable
    // preference first; the assertion below confirms only that change rides along.
    await user.click(screen.getByRole('button', { name: /Notifications/ }))
    await user.click(screen.getByRole('switch', { name: 'Daily digest' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toEqual({
      workspaceId: 'cloud:test',
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      selectedSmallModelId: null,
      workflowDesktopNotifications: true,
      workflowQuietHoursStart: null,
      workflowQuietHoursEnd: null,
      notificationVoiceReplies: true,
      notificationSmartSuggestions: true,
      notificationDailyDigest: true,
      notificationSounds: true,
      privacyShareAnonymizedUsage: false,
    })
  })

  it('does not overwrite credential edits when scoped provider credentials resolve late', async () => {
    const credentialLoad = deferred<Record<string, string>>()
    const user = userEvent.setup()
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => config),
      },
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(() => credentialLoad.promise),
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Model/ }))
    const apiKeyInput = await screen.findByPlaceholderText('sk-or-...')
    await user.type(apiKeyInput, 'sk-or-user-edit')

    credentialLoad.resolve({ apiKey: 'sk-or-from-disk', teamId: 'team-from-disk' })

    await waitFor(() => expect(screen.getByPlaceholderText('team-...')).toHaveValue('team-from-disk'))
    expect(apiKeyInput).toHaveValue('sk-or-user-edit')
  })

  it('restarts runtime before credentialless OpenCode-native provider auth and adopts the live default model', async () => {
    const user = userEvent.setup()
    const copilotProvider = {
      id: 'github-copilot',
      name: 'GitHub Copilot',
      description: 'OpenCode-native Copilot login',
      connected: false,
      credentials: [],
      models: [],
    }
    const configWithCopilot: PublicAppConfig = {
      ...config,
      providers: {
        ...config.providers,
        available: [...config.providers.available, copilotProvider],
      },
    }
    const refreshedConfig: PublicAppConfig = {
      ...configWithCopilot,
      providers: {
        ...configWithCopilot.providers,
        available: configWithCopilot.providers.available.map((provider) => provider.id === 'github-copilot'
          ? {
              ...provider,
              connected: true,
              defaultModel: 'gpt-5.4',
              models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
            }
          : provider),
      },
    }
    const settingsSet = vi.fn(async (updates: Partial<EffectiveAppSettings>) => settings({
      ...updates,
      effectiveProviderId: updates.selectedProviderId || 'github-copilot',
      effectiveModel: updates.selectedModelId || null,
    }))
    const runtimeRestart = vi.fn(async () => ({ ready: true, running: true, sessions: 0, uptimeMs: 0 }))
    installRendererTestCoworkApi({
      app: {
        config: vi.fn()
          .mockResolvedValueOnce(configWithCopilot)
          .mockResolvedValue(refreshedConfig),
      },
      provider: {
        authMethods: vi.fn(async () => ({
          'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot' }],
        })),
        authorize: vi.fn(async () => ({
          url: 'https://github.com/login/device',
          method: 'auto',
          instructions: 'Enter code ABCD 1234 at https://github.com/login/device',
        })),
        callback: vi.fn(async () => true),
        list: vi.fn(async () => [{
          id: 'github-copilot',
          name: 'GitHub Copilot',
          connected: true,
        }]),
      },
      runtime: {
        restart: runtimeRestart,
      },
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => ({})),
        set: settingsSet,
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Model/ }))
    await user.click(screen.getByRole('button', { name: /GitHub Copilot/ }))
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub Copilot' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({
      selectedProviderId: 'github-copilot',
      selectedModelId: '',
    })))
    expect(runtimeRestart).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: "I've finished signing in" }))
    await screen.findByRole('button', { name: /GPT-5\.4/ })
  })

  it('does not bind masked credential sentinels to editable inputs', async () => {
    const credentialLoad = deferred<Record<string, string>>()
    const user = userEvent.setup()
    const settingsSet = vi.fn(async (updates: Partial<EffectiveAppSettings>) => settings(updates))
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => config),
      },
      settings: {
        get: vi.fn(async () => settings({
          providerCredentials: {
            openrouter: {
              apiKey: '••••••••',
              teamId: '••••••••',
            },
          },
        })),
        getProviderCredentials: vi.fn(() => credentialLoad.promise),
        set: settingsSet,
      },
    })

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Model/ }))

    const apiKeyInput = await screen.findByPlaceholderText('sk-or-...')
    expect(apiKeyInput).toHaveValue('')

    await user.type(apiKeyInput, 'sk-or-replacement')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0].providerCredentials).toEqual({
      openrouter: {
        apiKey: 'sk-or-replacement',
      },
    })
  })
})
