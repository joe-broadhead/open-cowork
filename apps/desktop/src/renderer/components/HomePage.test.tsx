import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuiltInAgentDetail } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { installRendererTestCoworkApi } from '../test/setup'
import type { Attachment } from './chat/chat-input-types'
import { HomePage } from './HomePage'

const researchAgent: BuiltInAgentDetail = {
  name: 'research',
  label: 'Research',
  source: 'open-cowork',
  mode: 'subagent',
  hidden: false,
  disabled: false,
  color: 'info',
  description: 'Researches a focused question.',
  instructions: 'Research thoroughly.',
  skills: [],
  toolAccess: [],
  nativeToolIds: [],
  configuredToolIds: [],
}

const providerConfig = {
  branding: {
    appId: 'com.opencowork.desktop',
    name: 'Open Cowork',
    dataDirName: 'Open Cowork',
    helpUrl: 'https://github.com/joe-broadhead/open-cowork',
  },
  permissions: { bash: 'allow' as const, fileWrite: 'allow' as const },
  providers: {
    defaultProvider: 'openrouter',
    defaultModel: 'anthropic/claude-sonnet-4',
    available: [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        credentials: [],
        models: [
          { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', featured: true },
          { id: 'openai/gpt-4.1', name: 'GPT-4.1', featured: false },
        ],
      },
    ],
  },
  auth: { mode: 'none' as const, enabled: false },
  agentStarterTemplates: [],
}

function installHomeRuntime(overrides: Parameters<typeof installRendererTestCoworkApi>[0] = {}) {
  return installRendererTestCoworkApi({
    app: {
      config: vi.fn(async () => providerConfig),
      builtinAgents: vi.fn(async () => [researchAgent]),
      ...(overrides.app || {}),
    },
    settings: {
      get: vi.fn(async () => ({
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
      })),
      set: vi.fn(async (updates) => ({
        selectedProviderId: 'openrouter',
        selectedModelId: typeof updates.selectedModelId === 'string' ? updates.selectedModelId : 'anthropic/claude-sonnet-4',
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
        effectiveModel: typeof updates.selectedModelId === 'string' ? updates.selectedModelId : 'anthropic/claude-sonnet-4',
      })),
      ...(overrides.settings || {}),
    },
    ...(Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== 'app' && key !== 'settings'),
    ) as Parameters<typeof installRendererTestCoworkApi>[0]),
  })
}

function createStartThreadMock() {
  return vi.fn(async (_text: string, _attachments?: Attachment[], _agent?: string, _options?: unknown) => undefined)
}

describe('HomePage', () => {
  beforeEach(() => {
    useSessionStore.getState().setAgentMode('build')
  })

  it('keeps upstream Home copy as the default', async () => {
    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={createStartThreadMock()}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    expect(screen.getByText('What shall we cowork on today?')).toBeTruthy()
    expect(screen.getByText('Open Cowork · Ask anything, or @mention an agent')).toBeTruthy()
    expect(screen.getByPlaceholderText('Ask anything, or @mention an agent')).toBeTruthy()
    await waitFor(() => expect(window.coworkApi.app.builtinAgents).toHaveBeenCalledTimes(1))
  })

  it('renders downstream-configured Home copy without changing agent suggestions', async () => {
    vi.mocked(window.coworkApi.app.builtinAgents).mockResolvedValue([researchAgent])

    render(
      <HomePage
        brandName="Acme Cowork"
        homeBranding={{
          greeting: 'What should {{brand}} work on today?',
          subtitle: 'Ask a question or delegate to an approved agent.',
          composerPlaceholder: 'Ask {{brand}} anything',
          suggestionLabel: 'Start with',
          statusReadyLabel: 'Online',
        }}
        onStartThread={createStartThreadMock()}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    expect(screen.getByText('What should Acme Cowork work on today?')).toBeTruthy()
    expect(screen.getByText('Ask a question or delegate to an approved agent.')).toBeTruthy()
    expect(screen.getByPlaceholderText('Ask Acme Cowork anything')).toBeTruthy()
    expect(await screen.findByText('Start with')).toBeTruthy()
    expect(screen.getByText('@Research')).toBeTruthy()
    expect(screen.getByText('Online')).toBeTruthy()
  })

  it('exposes the same model, mode, and attachment controls as the in-thread composer', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime()

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={onStartThread}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: /Claude Sonnet 4/ })).toBeTruthy()
    expect(screen.getByTitle('Attach file')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Build' }))
    expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy()

    await user.type(screen.getByPlaceholderText('Ask anything, or @mention an agent'), 'Draft a release note')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith('Draft a release note', [], 'plan')
    })
  })

  it('saves Home model selections through the shared settings path', async () => {
    const user = userEvent.setup()
    installHomeRuntime()

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={createStartThreadMock()}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    await user.click(await screen.findByRole('button', { name: /Claude Sonnet 4/ }))
    await user.click(await screen.findByRole('option', { name: /GPT-4.1/ }))

    await waitFor(() => {
      expect(window.coworkApi.settings.set).toHaveBeenCalledWith({ selectedModelId: 'openai/gpt-4.1' })
    })
  })

  it('turns Home agent suggestions into native prompt agent routing', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime()

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={onStartThread}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    await user.click(await screen.findByRole('button', { name: '@Research' }))
    const composer = screen.getByPlaceholderText('Ask anything, or @mention an agent')
    await waitFor(() => expect(composer).toHaveValue('@research '))
    fireEvent.change(composer, { target: { value: '@research Map the market' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith('Map the market', [], 'research')
    })
  })

  it('forwards selected reasoning variants through the Home composer prompt options', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime({
      app: {
        config: vi.fn(async () => ({
          ...providerConfig,
          providers: {
            ...providerConfig.providers,
            available: [{
              ...providerConfig.providers.available[0],
              models: [
                {
                  id: 'anthropic/claude-sonnet-4',
                  name: 'Claude Sonnet 4',
                  featured: true,
                  reasoning: true,
                  variants: ['low', 'xhigh'],
                },
              ],
            }],
          },
        })),
      },
    })

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={onStartThread}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    await user.click(await screen.findByRole('button', { name: /Think Auto/i }))
    await user.click(await screen.findByRole('option', { name: /XHigh/i }))
    expect(screen.getByRole('button', { name: /Think XHigh/i })).toBeTruthy()

    await user.type(screen.getByPlaceholderText('Ask anything, or @mention an agent'), 'Analyze this with more reasoning')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith(
        'Analyze this with more reasoning',
        [],
        'build',
        { variant: 'xhigh' },
      )
    })
  })

  it('forwards Home file attachments through the standard prompt attachment payload', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime()

    const { container } = render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={onStartThread}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    const input = container.querySelector('input[type="file"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    const file = new File(['Launch checklist'], 'checklist.txt', { type: 'text/plain' })
    await user.upload(input as HTMLInputElement, file)
    expect(await screen.findByText('checklist.txt')).toBeTruthy()

    await user.type(screen.getByPlaceholderText('Ask anything, or @mention an agent'), 'Review this')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      const [, attachments, agent] = onStartThread.mock.calls[0]
      const attachment = attachments?.[0]
      expect(attachments ?? []).toHaveLength(1)
      expect(attachment).toMatchObject({
        filename: 'checklist.txt',
        mime: 'text/plain',
      })
      expect(attachment?.url).toContain('data:text/plain')
      expect(agent).toBe('build')
    })
  })
})
