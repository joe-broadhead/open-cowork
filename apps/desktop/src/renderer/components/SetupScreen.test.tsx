import { render, screen, waitFor } from '@testing-library/react'
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
})
