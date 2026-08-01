import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDisabledRuntimeToolingBridgeConsent,
  type EffectiveAppSettings,
  type ProviderDescriptor,
} from '@open-cowork/shared'
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
    notificationVoiceReplies: true,
    notificationSmartSuggestions: true,
    notificationDailyDigest: false,
    notificationSounds: true,
    privacyShareAnonymizedUsage: false,
    runtimeToolingBridge: createDisabledRuntimeToolingBridgeConsent(),
    windowZoomFactor: 1,
    workflowLaunchAtLogin: false,
    workflowRunInBackground: false,
    workflowDesktopNotifications: true,
    workflowQuietHoursStart: null,
    workflowQuietHoursEnd: null,
    effectiveProviderId: 'openrouter',
    effectiveModel: 'anthropic/claude-sonnet-4',
    setupComplete: false,
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
    expect(screen.queryByText('pnpm standalone-gateway:setup')).not.toBeInTheDocument()
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
    const set = vi.fn()
      .mockResolvedValueOnce(settings({ setupComplete: false }))
      .mockResolvedValue(settings({ setupComplete: true }))
    const restart = vi.fn(async () => ({
      phase: 'ready' as const,
      message: 'Runtime is ready.',
      ready: true,
      error: null,
      updatedAt: new Date().toISOString(),
    }))
    const status = vi.fn(async () => ({
      phase: 'ready' as const,
      message: 'Runtime is ready.',
      ready: true,
      running: true,
      sessions: 0,
      uptimeMs: 0,
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
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => ({ apiKey: 'sk-or-scoped' })),
        set,
      },
      runtime: {
        awaitInitialization,
        restart,
        status,
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

    const bridgeToggle = await screen.findByRole('switch', { name: 'Allow Git configuration' })
    expect(bridgeToggle).toHaveAttribute('aria-checked', 'false')
    const bridgeDescriptionIds = (bridgeToggle.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter(Boolean)
    expect(bridgeDescriptionIds).toHaveLength(3)
    const bridgeDescription = bridgeDescriptionIds
      .map((descriptionId) => document.getElementById(descriptionId)?.textContent || '')
      .join(' ')
    expect(bridgeDescription).toContain('Git config, ignore, and commit-message files')
    expect(bridgeDescription).toContain('Use your Git identity')
    expect(bridgeDescription).toContain('~/.gitconfig')
    expect(bridgeDescription).toContain('~/.config/git/config')
    expect(bridgeDescription).toContain('Read and change (linked host file)')
    const sshToggle = screen.getByRole('switch', { name: 'Allow SSH' })
    const sshDescription = (sshToggle.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .map((descriptionId) => document.getElementById(descriptionId)?.textContent || '')
      .join(' ')
    expect(sshDescription).toContain('$SSH_AUTH_SOCK')
    expect(sshDescription).toContain('managed runtime environment')
    expect(sshDescription).toContain('SSH agent broker access')

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByText(/Connection tested/)).toBeInTheDocument())
    await user.click(bridgeToggle)
    expect(screen.getByText(/connection permissions changed/i)).toBeInTheDocument()
    expect(screen.queryByText(/Connection tested/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
    expect(screen.queryByText('Runtime is ready.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByText(/Connection tested/)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Get Started' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(awaitInitialization).not.toHaveBeenCalled()
    expect(testConnection).toHaveBeenCalledTimes(2)
    expect(testConnection).toHaveBeenCalledWith('openrouter', 'anthropic/claude-sonnet-4')
    // The first unvalidated selection needs an explicit restart. On retest,
    // settings:set has already applied the validated consent change, so setup
    // reads status instead of restarting the runtime a second time.
    expect(restart).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledWith({ purpose: 'setup_connection_validation' })
    expect(status).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      runtimeToolingBridge: expect.objectContaining({
        version: 1,
        categories: expect.objectContaining({
          sourceControl: true,
          ssh: false,
        }),
      }),
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
    expect(restart).toHaveBeenCalledWith({ purpose: 'setup_connection_validation' })
    expect(testConnection).not.toHaveBeenCalled()
    expect(useSessionStore.getState().globalErrors).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
    expect(screen.getByText('Test the connection before continuing.')).toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('keeps setup open and surfaces provider validation failures', async () => {
    const user = userEvent.setup()
    const testConnection = vi.fn(async () => {
      throw new Error("Error invoking remote method 'provider:test-connection': SafeSetupConnectionError: Provider rejected the API key")
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
    expect(useSessionStore.getState().globalErrors).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
    expect(screen.getByText('Test the connection before continuing.')).toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('uses model catalog defaults after credentialless provider auth', async () => {
    const user = userEvent.setup()
    let setupComplete = false
    const set = vi.fn(async (updates: Partial<EffectiveAppSettings>) => settings({
      ...updates,
      effectiveProviderId: updates.selectedProviderId || 'github-copilot',
      effectiveModel: updates.selectedModelId || null,
      setupComplete,
    }))
    const restart = vi.fn(async () => ({ ready: true, error: null }))
    const testConnection = vi.fn(async (providerId: string, modelId: string) => {
      setupComplete = true
      return { ok: true, providerId, modelId }
    })
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
        testConnection,
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
    // Auth preparation and validation each restart once; completion does not.
    expect(restart).toHaveBeenCalledTimes(2)
  })

  it('revokes credentialless provider readiness immediately when native login is removed', async () => {
    const user = userEvent.setup()
    let setupComplete = false
    const connectedProviders = providersWithCopilot.map((provider) => (
      provider.id === 'github-copilot' ? { ...provider, connected: true } : provider
    ))
    installRendererTestCoworkApi({
      provider: {
        authMethods: vi.fn(async () => ({
          'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot' }],
        })),
        logout: vi.fn(async () => true),
        testConnection: vi.fn(async (providerId: string, modelId: string) => {
          setupComplete = true
          return { ok: true, providerId, modelId }
        }),
      },
      settings: {
        get: vi.fn(async () => settings({
          selectedProviderId: 'github-copilot',
          selectedModelId: 'gpt-5.4',
          effectiveProviderId: 'github-copilot',
          effectiveModel: 'gpt-5.4',
        })),
        getProviderCredentials: vi.fn(async () => ({})),
        set: vi.fn(async (updates: Partial<EffectiveAppSettings>) => settings({
          ...updates,
          effectiveProviderId: 'github-copilot',
          effectiveModel: 'gpt-5.4',
          setupComplete,
        })),
      },
      runtime: {
        restart: vi.fn(async () => ({ ready: true, error: null })),
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={connectedProviders}
        defaultProviderId="github-copilot"
        defaultModelId="gpt-5.4"
        onComplete={vi.fn()}
      />,
    )

    const testButton = await screen.findByRole('button', { name: 'Test connection' })
    await waitFor(() => expect(testButton).not.toBeDisabled())
    await user.click(testButton)
    await screen.findByText(/Connection tested/)
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Get Started' })).not.toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Forget login' }))

    await waitFor(() => expect(window.coworkApi.provider.logout).toHaveBeenCalledWith('github-copilot'))
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
    expect(screen.getByText('Not ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
  })

  it('requires sign-in or an entered optional credential before an OAuth-capable provider is ready to test', async () => {
    const optionalCredentialProvider: ProviderDescriptor = {
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI models',
      connected: false,
      credentials: [{
        key: 'apiKey',
        label: 'API key',
        description: 'Optional when using OpenAI sign-in',
        placeholder: 'sk-...',
        secret: true,
        required: false,
      }],
      models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
      defaultModel: 'gpt-5.4',
    }
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings({
          selectedProviderId: 'openai',
          selectedModelId: 'gpt-5.4',
          effectiveProviderId: 'openai',
          effectiveModel: 'gpt-5.4',
        })),
        getProviderCredentials: vi.fn(async () => ({})),
      },
      provider: {
        authMethods: vi.fn(async () => ({
          openai: [{ type: 'oauth', label: 'OpenAI' }],
        })),
      },
    })

    render(
      <SetupScreen
        brandName="Open Cowork"
        providers={[optionalCredentialProvider]}
        defaultProviderId="openai"
        defaultModelId="gpt-5.4"
        onComplete={vi.fn()}
      />,
    )

    const testButton = await screen.findByRole('button', { name: 'Test connection' })
    expect(testButton).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
    expect(screen.getAllByText('Sign in to OpenAI or enter API key before testing the connection.')).toHaveLength(2)
    expect(screen.getByLabelText('Connect a provider: Not complete')).toBeInTheDocument()
    expect(screen.getByLabelText('Choose model: Not complete')).toBeInTheDocument()
  })

  it('does not claim readiness or allow Get Started until the current provider credentials and model validate', async () => {
    const user = userEvent.setup()
    let setupComplete = false
    const set = vi.fn(async (updates: Partial<EffectiveAppSettings>) => settings({ ...updates, setupComplete }))
    const restart = vi.fn(async () => ({ ready: true, error: null }))
    const testConnection = vi.fn(async () => {
      setupComplete = true
      return { ok: true }
    })
    const onComplete = vi.fn()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => ({ apiKey: 'sk-or-ready' })),
        set,
      },
      runtime: { restart },
      provider: { testConnection },
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

    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
    expect(screen.getByText('Test the connection before continuing.')).toBeInTheDocument()
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Connection tested/)
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Get Started' })).not.toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Get Started' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(testConnection).toHaveBeenCalledWith('openrouter', 'anthropic/claude-sonnet-4')
    expect(set).toHaveBeenCalled()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('does not mark provider or model progress complete before required access exists', async () => {
    const user = userEvent.setup()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings()),
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

    expect(await screen.findByLabelText('Connect a provider: Not complete')).toBeInTheDocument()
    expect(screen.getByLabelText('Choose model: Not complete')).toBeInTheDocument()
    expect(screen.getByLabelText('Start chatting: Not complete')).toBeInTheDocument()

    await user.type(await screen.findByPlaceholderText('sk-or-...'), 'sk-or-present')

    expect(screen.getByLabelText('Connect a provider: Complete')).toBeInTheDocument()
    expect(screen.getByLabelText('Choose model: Complete')).toBeInTheDocument()
    expect(screen.getByLabelText('Start chatting: Not complete')).toBeInTheDocument()
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
  })

  it('keeps setup open when durable validation is invalidated after the live connection test', async () => {
    const user = userEvent.setup()
    const set = vi.fn()
      .mockResolvedValueOnce(settings({ setupComplete: false }))
      .mockResolvedValueOnce(settings({ setupComplete: false }))
    const onComplete = vi.fn()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings()),
        getProviderCredentials: vi.fn(async () => ({ apiKey: 'sk-or-ready' })),
        set,
      },
      runtime: {
        restart: vi.fn(async () => ({ ready: true, error: null })),
      },
      provider: {
        testConnection: vi.fn(async (providerId: string, modelId: string) => ({ ok: true, providerId, modelId })),
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
    await user.clear(apiKeyInput)
    await user.type(apiKeyInput, 'sk-or-ready')
    const testButton = await screen.findByRole('button', { name: 'Test connection' })
    await waitFor(() => expect(testButton).not.toBeDisabled())
    await user.click(testButton)
    await screen.findByText(/Connection tested/)
    await user.click(screen.getByRole('button', { name: 'Get Started' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/test the connection again/i))
    expect(onComplete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeDisabled()
  })

  it('explains each missing setup step and exposes a truthful catalog-loading state', async () => {
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings({
          selectedProviderId: null,
          selectedModelId: null,
          effectiveProviderId: null,
          effectiveModel: null,
        })),
      },
    })

    const { rerender } = render(
      <SetupScreen
        brandName="Open Cowork"
        providers={[]}
        defaultProviderId={null}
        defaultModelId={null}
        onComplete={vi.fn()}
      />,
    )

    expect(await screen.findByRole('status', { name: 'Loading model catalog' })).toBeInTheDocument()
    expect(screen.getAllByText('Wait for the model catalog to load.')).toHaveLength(2)

    rerender(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={vi.fn()}
      />,
    )

    expect(await screen.findAllByText('Enter API key before testing the connection.')).toHaveLength(2)
  })
})
