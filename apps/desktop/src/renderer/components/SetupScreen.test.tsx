import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveAppSettings, ProviderDescriptor } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { installRendererTestCoworkApi } from '../test/setup'
import { SetupScreen } from './SetupScreen'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const providers: ProviderDescriptor[] = [
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
]

const providersWithCopilot: ProviderDescriptor[] = [
  ...providers,
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    description: 'OpenCode-native Copilot login',
    connected: false,
    credentials: [],
    models: [],
  },
]

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
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSessionStore()
})

describe('SetupScreen', () => {
  it('defaults to local setup and keeps deployment topology behind disclosure', async () => {
    const user = userEvent.setup()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => ({ apiKey: 'sk-or-scoped' })),
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={vi.fn()}
      />,
    )

    expect(await screen.findByText('Running on this Mac')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Deploy Gateway/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Gateway/)).not.toBeInTheDocument()
    expect(screen.queryByText('desktop-only')).not.toBeInTheDocument()
    expect(screen.queryByText(/pnpm/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Learn more' })).toHaveAttribute(
      'href',
      expect.stringContaining('https://github.com/joe-broadhead/open-cowork/blob/master/docs/desktop-app.md'),
    )

    await user.click(screen.getByRole('button', { name: /Set up a team or server deployment/ }))

    expect(screen.getByRole('button', { name: /Deploy Gateway/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Deploy Gateway/ }))
    expect(screen.getByText('gateway-only')).toBeInTheDocument()
    expect(screen.getByText('pnpm standalone-gateway:setup')).toBeInTheDocument()
  })

  it('loads selected-provider credentials through the scoped credential IPC', async () => {
    const get = vi.fn(async () => settings())
    const getProviderCredentials = vi.fn(async () => ({ apiKey: 'sk-or-scoped' }))
    installRendererTestCoworkApi({
      settings: {
        get,
        getProviderCredentials,
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={vi.fn()}
      />,
    )

    const apiKeyInput = await screen.findByPlaceholderText('sk-or-...')
    await waitFor(() => expect(apiKeyInput).toHaveValue('sk-or-scoped'))
    expect(get).toHaveBeenCalledTimes(1)
    expect(getProviderCredentials).toHaveBeenCalledWith('openrouter', {
      workspaceId: 'local',
      purpose: 'credential_editor',
    })
  })

  it('surfaces initial setup settings load failures through the chat error channel and diagnostics', async () => {
    const get = vi.fn(async () => {
      throw new Error('settings unavailable')
    })
    const reportRendererError = vi.fn()
    const api = installRendererTestCoworkApi({
      diagnostics: {
        reportRendererError,
      },
      settings: {
        get,
        getProviderCredentials: vi.fn(async () => ({})),
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load setup settings. Please try again.')
    })
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('settings unavailable'),
      view: 'setup',
    }))
  })

  it('surfaces selected-provider credential load failures and tolerates diagnostics failures', async () => {
    installRendererTestCoworkApi({
      diagnostics: {
        reportRendererError: vi.fn(() => {
          throw new Error('diagnostics unavailable')
        }),
      },
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => {
          throw new Error('credentials unavailable')
        }),
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load provider credentials. Please try again.')
    })
  })

  it('does not overwrite setup credential edits when scoped credential loading resolves late', async () => {
    const credentialLoad = deferred<Record<string, string>>()
    const user = userEvent.setup()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(() => credentialLoad.promise),
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={vi.fn()}
      />,
    )

    const apiKeyInput = await screen.findByPlaceholderText('sk-or-...')
    await user.type(apiKeyInput, 'sk-or-user-edit')

    credentialLoad.resolve({ apiKey: 'sk-or-from-disk', teamId: 'team-from-disk' })

    await waitFor(() => expect(screen.getByPlaceholderText('team-...')).toHaveValue('team-from-disk'))
    expect(apiKeyInput).toHaveValue('sk-or-user-edit')
  })

  it('restarts with saved setup choices before testing the connection', async () => {
    const user = userEvent.setup()
    const set = vi.fn(async () => settings())
    const restart = vi.fn(async () => ({
      phase: 'ready' as const,
      message: 'Runtime is ready.',
      ready: true,
      error: null,
      updatedAt: new Date().toISOString(),
    }))
    const testConnection = vi.fn(async (providerId: string, modelId: string) => ({ ok: true, providerId, modelId }))
    const awaitInitialization = vi.fn(async () => ({
      phase: 'ready' as const,
      message: 'Runtime is ready.',
      ready: true,
      error: null,
      updatedAt: new Date().toISOString(),
    }))
    const onComplete = vi.fn()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings({ runtimeToolingBridgeEnabled: true })),
        getProviderCredentials: vi.fn(async () => ({ apiKey: 'sk-or-scoped' })),
        set,
      },
      runtime: {
        awaitInitialization,
        restart,
      },
      provider: {
        testConnection,
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={onComplete}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Set up a team or server deployment/ }))
    const bridgeToggle = await screen.findByRole('checkbox', { name: /Reuse developer tools from this Mac/ })
    expect(bridgeToggle).toBeChecked()

    await user.click(bridgeToggle)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByText(/Connection tested/)).toBeInTheDocument())
    expect(screen.queryByText('Runtime is ready.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Get Started' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(awaitInitialization).not.toHaveBeenCalled()
    expect(testConnection).toHaveBeenCalledWith('openrouter', 'anthropic/claude-sonnet-4')
    expect(restart).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      runtimeToolingBridgeEnabled: false,
      providerCredentials: {
        openrouter: expect.objectContaining({ apiKey: 'sk-or-scoped' }),
      },
    }))
  })

  it('blocks provider validation when saved setup choices fail to restart the runtime', async () => {
    const user = userEvent.setup()
    const restart = vi.fn(async () => ({
      ready: false,
      error: 'Runtime config rejected provider options',
      updatedAt: new Date().toISOString(),
    }))
    const testConnection = vi.fn(async (providerId: string, modelId: string) => ({ ok: true, providerId, modelId }))
    const onComplete = vi.fn()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => ({})),
        set: vi.fn(async () => settings()),
      },
      runtime: {
        restart,
      },
      provider: {
        testConnection,
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={onComplete}
      />,
    )

    const apiKeyInput = await screen.findByPlaceholderText('sk-or-...')
    await user.type(apiKeyInput, 'runtime-config-placeholder')
    const testButton = await screen.findByRole('button', { name: 'Test connection' })
    await waitFor(() => expect(testButton).not.toBeDisabled())
    await user.click(testButton)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Runtime config rejected provider options'))
    expect(restart).toHaveBeenCalledTimes(1)
    expect(testConnection).not.toHaveBeenCalled()
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Runtime config rejected provider options')
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('keeps setup open and surfaces provider validation failures', async () => {
    const user = userEvent.setup()
    const testConnection = vi.fn(async () => {
      throw new Error('Provider rejected the API key')
    })
    const onComplete = vi.fn()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => ({})),
        set: vi.fn(async () => settings()),
      },
      provider: {
        testConnection,
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={onComplete}
      />,
    )

    const apiKeyInput = await screen.findByPlaceholderText('sk-or-...')
    await user.type(apiKeyInput, 'sk-or-bad')
    const testButton = await screen.findByRole('button', { name: 'Test connection' })
    await waitFor(() => expect(testButton).not.toBeDisabled())
    await user.click(testButton)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Provider rejected the API key'))
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Provider rejected the API key')
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('uses model catalog defaults after credentialless provider auth', async () => {
    const user = userEvent.setup()
    const set = vi.fn(async (updates: Partial<EffectiveAppSettings>) => settings({
      ...updates,
      effectiveProviderId: updates.selectedProviderId || 'github-copilot',
      effectiveModel: updates.selectedModelId || null,
    }))
    const restart = vi.fn(async () => ({ ready: true, error: null }))
    const onComplete = vi.fn()
    installRendererTestCoworkApi({
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
          defaultModel: 'gpt-5.4',
          models: { 'gpt-5.4': {} },
        }]),
        testConnection: vi.fn(async (providerId: string, modelId: string) => ({ ok: true, providerId, modelId })),
      },
      settings: {
        get: vi.fn(async () => settings({
          selectedProviderId: 'github-copilot',
          selectedModelId: null,
          effectiveProviderId: 'github-copilot',
          effectiveModel: null,
        })),
        getProviderCredentials: vi.fn(async () => ({})),
        set,
      },
      runtime: {
        restart,
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providersWithCopilot}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={onComplete}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub Copilot' }))

    await waitFor(() => expect(set).toHaveBeenCalledWith(expect.objectContaining({
      selectedProviderId: 'github-copilot',
      selectedModelId: '',
      providerCredentials: {
        'github-copilot': {},
      },
    })))
    await user.click(screen.getByRole('button', { name: "I've finished signing in" }))
    await waitFor(() => expect(screen.getByPlaceholderText('Model ID')).toHaveValue('gpt-5.4'))

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByText(/Connection tested/)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Get Started' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedProviderId: 'github-copilot',
      selectedModelId: 'gpt-5.4',
      providerCredentials: {
        'github-copilot': {},
      },
    }))
    expect(restart).toHaveBeenCalledTimes(2)
  })
})
