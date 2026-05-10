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
    enableBash: false,
    enableFileWrite: false,
    runtimeToolingBridgeEnabled: true,
    automationLaunchAtLogin: false,
    automationRunInBackground: false,
    automationDesktopNotifications: true,
    automationQuietHoursStart: null,
    automationQuietHoursEnd: null,
    defaultAutomationAutonomyPolicy: 'review-first',
    defaultAutomationExecutionMode: 'scoped_execution',
    improvementProposalsEnabled: true,
    improvementProposalsDisabledAgents: {},
    improvementProposalsDisabledProjects: {},
    improvementProposalsDisabledCrews: {},
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
    expect(getProviderCredentials).toHaveBeenCalledWith('openrouter')
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

  it('discloses and persists the developer config bridge choice during first-run setup', async () => {
    const user = userEvent.setup()
    const set = vi.fn(async () => settings())
    const restart = vi.fn(async () => ({ ready: true, error: null }))
    const onComplete = vi.fn()
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => settings({ runtimeToolingBridgeEnabled: true })),
        getProviderCredentials: vi.fn(async () => ({ apiKey: 'sk-or-scoped' })),
        set,
      },
      runtime: {
        restart,
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

    const bridgeToggle = await screen.findByRole('checkbox', { name: /Developer config bridge/ })
    expect(bridgeToggle).toBeChecked()

    await user.click(bridgeToggle)
    await user.click(screen.getByRole('button', { name: 'Get Started' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
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
})
