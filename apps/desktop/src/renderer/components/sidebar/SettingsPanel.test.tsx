import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { EffectiveAppSettings, PublicAppConfig } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
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

describe('SettingsPanel', () => {
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
})
