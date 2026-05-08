import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveAppSettings, PublicAppConfig } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { SettingsPanel } from './SettingsPanel'

function settings(overrides: Partial<EffectiveAppSettings> = {}): EffectiveAppSettings {
  return {
    selectedProviderId: 'openrouter',
    selectedModelId: 'anthropic/claude-sonnet-4',
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
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
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
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

  it('persists the developer config bridge permission toggle', async () => {
    const settingsSet = vi.mocked(window.coworkApi.settings.set)
    const user = userEvent.setup()

    render(<SettingsPanel onClose={vi.fn()} />)

    await screen.findByText('Settings')
    await user.click(screen.getByRole('button', { name: /Permissions/ }))

    const toolingBridge = await screen.findByRole('switch', { name: 'Developer config bridge' })
    expect(toolingBridge).toHaveAttribute('aria-checked', 'true')

    await user.click(toolingBridge)
    expect(toolingBridge).toHaveAttribute('aria-checked', 'false')

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(settingsSet.mock.calls[0]?.[0]).toMatchObject({
      enableBash: false,
      enableFileWrite: false,
      runtimeToolingBridgeEnabled: false,
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
    await user.click(screen.getByRole('button', { name: /Models/ }))
    const apiKeyInput = await screen.findByPlaceholderText('sk-or-...')
    await user.type(apiKeyInput, 'sk-or-user-edit')

    credentialLoad.resolve({ apiKey: 'sk-or-from-disk', teamId: 'team-from-disk' })

    await waitFor(() => expect(screen.getByPlaceholderText('team-...')).toHaveValue('team-from-disk'))
    expect(apiKeyInput).toHaveValue('sk-or-user-edit')
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
    await user.click(screen.getByRole('button', { name: /Models/ }))

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
