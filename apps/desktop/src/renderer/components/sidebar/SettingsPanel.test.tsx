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
    enableBash: false,
    enableFileWrite: false,
    runtimeToolingBridgeEnabled: true,
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
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Settings saved, but provider credentials could not be reloaded. Please reopen Settings.')
    })
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('reload unavailable'),
      view: 'settings',
    }))
  })

  it('persists explicit developer permission modes', async () => {
    const settingsSet = vi.mocked(window.coworkApi.settings.set)
    const user = userEvent.setup()

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Permissions/ }))

    await user.click(within(screen.getByRole('tablist', { name: 'Shell commands' })).getByRole('tab', { name: 'Allow' }))
    await user.click(within(screen.getByRole('tablist', { name: 'File editing' })).getByRole('tab', { name: 'Allow' }))

    await user.click(screen.getByRole('button', { name: /Advanced/ }))
    const toolingBridge = await screen.findByRole('switch', { name: 'Developer config bridge' })
    expect(toolingBridge).toHaveAttribute('aria-checked', 'true')

    await user.click(toolingBridge)
    expect(toolingBridge).toHaveAttribute('aria-checked', 'false')

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toMatchObject({
      bashPermission: 'allow',
      fileWritePermission: 'allow',
      enableBash: true,
      enableFileWrite: true,
      runtimeToolingBridgeEnabled: false,
    })
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
    await user.type(screen.getByLabelText('Model ID'), 'deepseek/deepseek-v4-flash:free')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toMatchObject({
      selectedSmallModelId: 'deepseek/deepseek-v4-flash:free',
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
          ? { ...provider, smallModel: 'deepseek/deepseek-v4-flash:free' }
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
    await user.click(screen.getByRole('button', { name: /Automations/ }))

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
