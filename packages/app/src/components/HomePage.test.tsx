import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { BuiltInAgentDetail, WorkspaceApiSupport } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { useWorkspaceSupportStore } from '../stores/workspace-support'
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
  permissions: { bash: 'allow' as const, fileWrite: 'allow' as const, task: 'allow' as const, web: 'allow' as const, webSearch: true },
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
        workflowLaunchAtLogin: false,
        workflowRunInBackground: false,
        workflowDesktopNotifications: true,
        workflowQuietHoursStart: null,
        workflowQuietHoursEnd: null,
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
        workflowLaunchAtLogin: false,
        workflowRunInBackground: false,
        workflowDesktopNotifications: true,
        workflowQuietHoursStart: null,
        workflowQuietHoursEnd: null,
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

function renderHome(overrides: Partial<ComponentProps<typeof HomePage>> = {}) {
  return render(
    <HomePage
      brandName="Open Cowork"
      onStartThread={createStartThreadMock()}
      onOpenThread={vi.fn()}
      {...overrides}
    />,
  )
}

describe('HomePage', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useSessionStore.getState().setActiveWorkspace('local')
    useSessionStore.getState().setSessions([])
    useSessionStore.getState().setCurrentSession(null)
    useSessionStore.getState().setAgentMode('build')
    useSessionStore.setState({ globalErrors: [] })
  })

  it('keeps Studio Home copy as the default', async () => {
    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={createStartThreadMock()}
        onOpenThread={vi.fn()}
      />,
    )

    // Time-of-day greeting ("Good morning/afternoon/evening.") rendered at 44px with
    // the time word in accent; assert on the stable "Good" lead, not the hour-dependent word.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Good /)
    expect(screen.getByText('Open Cowork · Start a conversation or resume recent work')).toBeTruthy()
    expect(screen.getByPlaceholderText('Ask anything, or @mention a coworker')).toBeTruthy()
    await waitFor(() => expect(window.coworkApi.app.builtinAgents).toHaveBeenCalledTimes(1))
  })

  it('renders downstream-configured Home copy without rebuilding a dashboard', async () => {
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
        onOpenThread={vi.fn()}
      />,
    )

    expect(screen.getByText('What should Acme Cowork work on today?')).toBeTruthy()
    expect(screen.getByText('Ask a question or delegate to an approved agent.')).toBeTruthy()
    expect(screen.getByPlaceholderText('Ask Acme Cowork anything')).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Recent work' })).toBeTruthy()
    expect(screen.queryByText('Online')).toBeNull()
    expect(screen.queryByText('Your team')).toBeNull()
    expect(screen.queryByText('Review Snapshot')).toBeNull()
  })

  it('exposes the same model, mode, and attachment controls as the in-thread composer', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime()

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={onStartThread}
        onOpenThread={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: /Claude Sonnet 4/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: /Build.*default/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Plan/i }))

    await user.type(screen.getByPlaceholderText('Ask anything, or @mention a coworker'), 'Draft a release note')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith(
        'Draft a release note',
        [],
        'plan',
        { modelId: 'anthropic/claude-sonnet-4' },
      )
    })
  })

  it('saves Home model selections through the shared settings path', async () => {
    const user = userEvent.setup()
    installHomeRuntime()

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={createStartThreadMock()}
        onOpenThread={vi.fn()}
      />,
    )

    await user.click(await screen.findByRole('button', { name: /Claude Sonnet 4/ }))
    await user.click(await screen.findByRole('option', { name: /GPT-4.1/ }))

    await waitFor(() => {
      expect(window.coworkApi.settings.set).toHaveBeenCalledWith({ selectedModelId: 'openai/gpt-4.1' })
    })
  })

  it('turns typed Home coworker mentions into native prompt agent routing', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime()

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={onStartThread}
        onOpenThread={vi.fn()}
      />,
    )

    const composer = screen.getByPlaceholderText('Ask anything, or @mention a coworker')
    await waitFor(() => expect(window.coworkApi.app.builtinAgents).toHaveBeenCalled())
    await user.type(composer, '@research Map the market')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith(
        'Map the market',
        [],
        'research',
        { modelId: 'anthropic/claude-sonnet-4' },
      )
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
        onOpenThread={vi.fn()}
      />,
    )

    await user.click(await screen.findByRole('button', { name: /Think Auto/i }))
    expect(await screen.findByText('Keep reasoning concise for simple edits and quick replies.')).toBeTruthy()
    expect(await screen.findByText('Use maximum effort for risky, multi-step, or deeply coupled changes.')).toBeTruthy()
    await user.click(await screen.findByRole('option', { name: /XHigh/i }))
    expect(screen.getByRole('button', { name: /Think XHigh/i })).toBeTruthy()

    await user.type(screen.getByPlaceholderText('Ask anything, or @mention a coworker'), 'Analyze this with more reasoning')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith(
        'Analyze this with more reasoning',
        [],
        'build',
        { modelId: 'anthropic/claude-sonnet-4', variant: 'xhigh' },
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
        onOpenThread={vi.fn()}
      />,
    )

    const input = container.querySelector('input[type="file"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    const file = new File(['Launch checklist'], 'checklist.txt', { type: 'text/plain' })
    await user.upload(input as HTMLInputElement, file)
    expect(await screen.findByText('checklist.txt')).toBeTruthy()

    await user.type(screen.getByPlaceholderText('Ask anything, or @mention a coworker'), 'Review this')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      const [, attachments, agent] = onStartThread.mock.calls[0]!
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

  it('prefills and focuses the Home composer from the single empty-state starter', async () => {
    const user = userEvent.setup()
    installHomeRuntime()

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={createStartThreadMock()}
        onOpenThread={vi.fn()}
      />,
    )

    const starter = await screen.findByRole('button', { name: 'Try a starter' })
    await user.click(starter)

    const composer = screen.getByPlaceholderText('Ask anything, or @mention a coworker')
    expect(composer).toHaveValue('Draft a release plan for the next milestone.')
    await waitFor(() => expect(document.activeElement).toBe(composer))
    expect(useSessionStore.getState().agentMode).toBe('plan')
    expect(screen.getAllByRole('button', { name: 'Try a starter' })).toHaveLength(1)
  })

  it('falls back starter suggestions to an allowed cloud primary agent', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    const cloudPromptSupport: WorkspaceApiSupport[] = [{
      api: 'sessions.prompt',
      status: 'supported',
      verdict: { allowed: true, reason: null },
    }]
    installHomeRuntime({
      workspace: {
        policy: vi.fn(async () => ({
          features: {},
          allowedAgents: ['build'],
          allowedTools: null,
          allowedMcps: null,
          localFiles: 'disabled',
          localStdioMcps: 'disabled',
          machineRuntimeConfig: 'disabled',
        })),
        support: vi.fn(async () => cloudPromptSupport),
      },
    })
    act(() => {
      useSessionStore.getState().setActiveWorkspace('cloud:test')
      useSessionStore.getState().setSessions([])
      useWorkspaceSupportStore.setState((state) => ({
        supportByWorkspace: { ...state.supportByWorkspace, 'cloud:test': cloudPromptSupport },
        loadedByWorkspace: { ...state.loadedByWorkspace, 'cloud:test': true },
        loadingByWorkspace: { ...state.loadingByWorkspace, 'cloud:test': false },
        errorByWorkspace: { ...state.errorByWorkspace, 'cloud:test': null },
      }))
    })

    renderHome({ onStartThread })

    await waitFor(() => expect(window.coworkApi.workspace.policy).toHaveBeenCalledWith('cloud:test'))
    await user.click(await screen.findByRole('button', { name: 'Try a starter' }))
    expect(screen.getByPlaceholderText('Ask anything, or @mention a coworker')).toHaveValue('Draft a release plan for the next milestone.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith(
        'Draft a release plan for the next milestone.',
        [],
        'build',
        { workspaceId: 'cloud:test' },
      )
    })
  })

  it('keeps cloud Home starters disabled until the agent policy loads', async () => {
    let resolvePolicy!: (policy: {
      features: Record<string, never>
      allowedAgents: string[]
      allowedTools: null
      allowedMcps: null
      localFiles: 'disabled'
      localStdioMcps: 'disabled'
      machineRuntimeConfig: 'disabled'
    }) => void
    const policyPromise = new Promise<Parameters<typeof resolvePolicy>[0]>((resolve) => {
      resolvePolicy = resolve
    })
    const cloudPromptSupport: WorkspaceApiSupport[] = [{
      api: 'sessions.prompt',
      status: 'supported',
      verdict: { allowed: true, reason: null },
    }]
    installHomeRuntime({
      workspace: {
        policy: vi.fn(() => policyPromise),
        support: vi.fn(async () => cloudPromptSupport),
      },
    })
    act(() => {
      useSessionStore.getState().setActiveWorkspace('cloud:pending-policy')
      useSessionStore.getState().setSessions([])
      useWorkspaceSupportStore.setState((state) => ({
        supportByWorkspace: { ...state.supportByWorkspace, 'cloud:pending-policy': cloudPromptSupport },
        loadedByWorkspace: { ...state.loadedByWorkspace, 'cloud:pending-policy': true },
        loadingByWorkspace: { ...state.loadingByWorkspace, 'cloud:pending-policy': false },
        errorByWorkspace: { ...state.errorByWorkspace, 'cloud:pending-policy': null },
      }))
    })

    renderHome()

    await waitFor(() => expect(window.coworkApi.workspace.policy).toHaveBeenCalledWith('cloud:pending-policy'))
    expect(screen.queryByRole('button', { name: 'Try a starter' })).toBeNull()
    expect(screen.getByRole('button', { name: /Profile default/i })).toBeDisabled()

    await act(async () => {
      resolvePolicy({
        features: {},
        allowedAgents: ['build'],
        allowedTools: null,
        allowedMcps: null,
        localFiles: 'disabled',
        localStdioMcps: 'disabled',
        machineRuntimeConfig: 'disabled',
      })
      await policyPromise
    })

    expect(await screen.findByRole('button', { name: 'Try a starter' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Build.*default/i })).toBeEnabled()
  })

  it('uses the first allowed cloud specialist when no primary lead is allowed', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    const cloudPromptSupport: WorkspaceApiSupport[] = [{
      api: 'sessions.prompt',
      status: 'supported',
      verdict: { allowed: true, reason: null },
    }]
    installHomeRuntime({
      workspace: {
        policy: vi.fn(async () => ({
          features: {},
          allowedAgents: ['data-analyst'],
          allowedTools: null,
          allowedMcps: null,
          localFiles: 'disabled',
          localStdioMcps: 'disabled',
          machineRuntimeConfig: 'disabled',
        })),
        support: vi.fn(async () => cloudPromptSupport),
      },
    })
    act(() => {
      useSessionStore.getState().setActiveWorkspace('cloud:test')
      useSessionStore.getState().setSessions([])
      useWorkspaceSupportStore.setState((state) => ({
        supportByWorkspace: { ...state.supportByWorkspace, 'cloud:test': cloudPromptSupport },
        loadedByWorkspace: { ...state.loadedByWorkspace, 'cloud:test': true },
        loadingByWorkspace: { ...state.loadingByWorkspace, 'cloud:test': false },
        errorByWorkspace: { ...state.errorByWorkspace, 'cloud:test': null },
      }))
    })

    renderHome({ onStartThread })

    await waitFor(() => expect(window.coworkApi.workspace.policy).toHaveBeenCalledWith('cloud:test'))
    expect(screen.queryByRole('button', { name: 'Try a starter' })).toBeNull()
    expect(await screen.findByRole('button', { name: /Profile default/i })).toBeDisabled()

    await user.type(screen.getByPlaceholderText('Ask anything, or @mention a coworker'), 'Summarize workspace health')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith(
        'Summarize workspace health',
        [],
        'data-analyst',
        { workspaceId: 'cloud:test' },
      )
    })
  })

  it('blocks direct mentions outside the cloud profile allowlist', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    const cloudPromptSupport: WorkspaceApiSupport[] = [{
      api: 'sessions.prompt',
      status: 'supported',
      verdict: { allowed: true, reason: null },
    }]
    installHomeRuntime({
      workspace: {
        policy: vi.fn(async () => ({
          features: {},
          allowedAgents: ['build'],
          allowedTools: null,
          allowedMcps: null,
          localFiles: 'disabled',
          localStdioMcps: 'disabled',
          machineRuntimeConfig: 'disabled',
        })),
        support: vi.fn(async () => cloudPromptSupport),
      },
    })
    act(() => {
      useSessionStore.getState().setActiveWorkspace('cloud:test')
      useSessionStore.getState().setSessions([])
      useWorkspaceSupportStore.setState((state) => ({
        supportByWorkspace: { ...state.supportByWorkspace, 'cloud:test': cloudPromptSupport },
        loadedByWorkspace: { ...state.loadedByWorkspace, 'cloud:test': true },
        loadingByWorkspace: { ...state.loadingByWorkspace, 'cloud:test': false },
        errorByWorkspace: { ...state.errorByWorkspace, 'cloud:test': null },
      }))
    })

    renderHome({ onStartThread })

    await waitFor(() => expect(window.coworkApi.workspace.policy).toHaveBeenCalledWith('cloud:test'))
    await user.type(screen.getByPlaceholderText('Ask anything, or @mention a coworker'), '@research Map the market')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(onStartThread).not.toHaveBeenCalled()
    expect(useSessionStore.getState().globalErrors.at(-1)?.message).toBe('That coworker is not allowed by this cloud profile.')
  })

  it('sends the explicit image-only default prompt from Home', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime()

    const { container } = render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={onStartThread}
        onOpenThread={vi.fn()}
      />,
    )

    const input = container.querySelector('input[type="file"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    const file = new File(['fake image'], 'screenshot.png', { type: 'image/png' })
    await user.upload(input as HTMLInputElement, file)

    expect(await screen.findByText("Will ask: 'Describe this image'")).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      const [text, attachments, agent] = onStartThread.mock.calls[0]!
      expect(text).toBe('Describe this image.')
      expect(attachments ?? []).toHaveLength(1)
      expect(agent).toBe('build')
    })
  })

  it('preserves assign-to controls and keyboard session start behavior', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime()

    renderHome({ onStartThread })

    await user.click(await screen.findByRole('button', { name: /Build.*default/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Cleo/i }))
    expect(useSessionStore.getState().agentMode).toBe('chief-of-staff')

    const composer = screen.getByPlaceholderText('Ask anything, or @mention a coworker')
    await user.type(composer, 'Help me turn a repeated task into a saved workflow.')
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith(
        'Help me turn a repeated task into a saved workflow.',
        [],
        'chief-of-staff',
        { modelId: 'anthropic/claude-sonnet-4' },
      )
    })
  })

  it('renders explicit loading and error states and retries through the app session loader', async () => {
    const user = userEvent.setup()
    const onReloadSessions = vi.fn(async () => undefined)
    useSessionStore.setState({
      sessionListStatusByWorkspace: { local: 'loading' },
      sessionListErrorByWorkspace: { local: null },
    })

    const { rerender } = renderHome({ onReloadSessions })

    expect(screen.getByRole('status', { name: 'Loading recent work' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try a starter' })).not.toBeInTheDocument()

    act(() => {
      useSessionStore.getState().setSessionListError('Session service is offline.')
    })
    rerender(
      <HomePage
        brandName="Open Cowork"
        onStartThread={createStartThreadMock()}
        onOpenThread={vi.fn()}
        onReloadSessions={onReloadSessions}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Session service is offline.')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onReloadSessions).toHaveBeenCalledTimes(1)
  })

  it('sorts, bounds, and resumes recent conversations while excluding workflow runs', async () => {
    const user = userEvent.setup()
    const onOpenThread = vi.fn(async () => undefined)
    useSessionStore.getState().setSessions([
      { id: 'old', title: 'Older work', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T01:00:00.000Z' },
      { id: 'new', title: 'Most recent work', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T02:00:00.000Z' },
      { id: 'middle', title: 'Middle work', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T01:00:00.000Z' },
      { id: 'fourth', title: 'Fourth work', createdAt: '2025-12-31T00:00:00.000Z', updatedAt: '2025-12-31T01:00:00.000Z' },
      { id: 'fifth', title: 'Fifth work', createdAt: '2025-12-30T00:00:00.000Z', updatedAt: '2025-12-30T01:00:00.000Z' },
      { id: 'run', title: 'Workflow run', kind: 'workflow_run', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T01:00:00.000Z' },
    ])

    renderHome({ onOpenThread })

    const resumeButtons = screen.getAllByRole('button', { name: /^Resume / })
    expect(resumeButtons).toHaveLength(4)
    expect(resumeButtons[0]).toHaveAccessibleName('Resume Most recent work')
    expect(screen.queryByText('Workflow run')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try a starter' })).not.toBeInTheDocument()

    resumeButtons[0]?.focus()
    await user.keyboard('{Enter}')
    expect(onOpenThread).toHaveBeenCalledWith('new')
  })

  it('keeps the composer before one compact empty-state treatment', () => {
    installHomeRuntime()

    renderHome()

    const composer = screen.getByPlaceholderText('Ask anything, or @mention a coworker')
    const recentHeading = screen.getByRole('heading', { name: 'Recent work' })
    expect(composer.compareDocumentPosition(recentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Start your first conversation')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Try a starter' })).toHaveLength(1)
    expect(screen.queryByText('In motion')).not.toBeInTheDocument()
    expect(screen.queryByText('Your team')).not.toBeInTheDocument()
    expect(screen.queryByText('Review Snapshot')).not.toBeInTheDocument()
  })
})
