import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { EffectiveAppSettings, ProviderDescriptor } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../test/setup'
import { SetupScreen } from './SetupScreen'

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
})
