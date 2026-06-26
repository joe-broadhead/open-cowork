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
      onNavigate={vi.fn()}
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
        onNavigate={vi.fn()}
      />,
    )

    // Time-of-day greeting ("Good morning/afternoon/evening.") rendered at 44px with
    // the time word in accent; assert on the stable "Good" lead, not the hour-dependent word.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Good /)
    expect(screen.getByText('Open Cowork · Choose a lead coworker, @mention specialists, and review the work in one place')).toBeTruthy()
    expect(screen.getByPlaceholderText('Ask anything, or @mention a coworker')).toBeTruthy()
    await waitFor(() => expect(window.coworkApi.app.builtinAgents).toHaveBeenCalledTimes(1))
  })

  it('renders downstream-configured Home copy without changing the launchpad shell', async () => {
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
        onNavigate={vi.fn()}
      />,
    )

    expect(screen.getByText('What should Acme Cowork work on today?')).toBeTruthy()
    expect(screen.getByText('Ask a question or delegate to an approved agent.')).toBeTruthy()
    expect(screen.getByPlaceholderText('Ask Acme Cowork anything')).toBeTruthy()
    expect(await screen.findByText('Start with a handoff')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Your team/i })).toBeTruthy()
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
        onOpenThread={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: /Claude Sonnet 4/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: /Build.*default/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Plan/i }))

    await user.type(screen.getByPlaceholderText('Ask anything, or @mention a coworker'), 'Draft a release note')
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
        onOpenThread={vi.fn()}
        onNavigate={vi.fn()}
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
        onNavigate={vi.fn()}
      />,
    )

    const composer = screen.getByPlaceholderText('Ask anything, or @mention a coworker')
    await waitFor(() => expect(window.coworkApi.app.builtinAgents).toHaveBeenCalled())
    await user.type(composer, '@research Map the market')
    await user.keyboard('{Enter}')

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
        onOpenThread={vi.fn()}
        onNavigate={vi.fn()}
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
        onOpenThread={vi.fn()}
        onNavigate={vi.fn()}
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

  it('prefills the Home composer from first-run example prompt cards', async () => {
    const user = userEvent.setup()
    installHomeRuntime()

    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={createStartThreadMock()}
        onOpenThread={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Plan a release/i }))

    expect(screen.getByPlaceholderText('Ask anything, or @mention a coworker')).toHaveValue('Draft a release plan for the next milestone.')
    expect(useSessionStore.getState().agentMode).toBe('plan')
    expect(screen.getByText('Start with a handoff')).toBeTruthy()
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
      useWorkspaceSupportStore.setState((state) => ({
        supportByWorkspace: { ...state.supportByWorkspace, 'cloud:test': cloudPromptSupport },
        loadedByWorkspace: { ...state.loadedByWorkspace, 'cloud:test': true },
        loadingByWorkspace: { ...state.loadingByWorkspace, 'cloud:test': false },
        errorByWorkspace: { ...state.errorByWorkspace, 'cloud:test': null },
      }))
    })

    renderHome({ onStartThread })

    await waitFor(() => expect(window.coworkApi.workspace.policy).toHaveBeenCalledWith('cloud:test'))
    expect(await screen.findByText('1 coworkers · manage')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Plan a release/i }))
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
      useWorkspaceSupportStore.setState((state) => ({
        supportByWorkspace: { ...state.supportByWorkspace, 'cloud:pending-policy': cloudPromptSupport },
        loadedByWorkspace: { ...state.loadedByWorkspace, 'cloud:pending-policy': true },
        loadingByWorkspace: { ...state.loadingByWorkspace, 'cloud:pending-policy': false },
        errorByWorkspace: { ...state.errorByWorkspace, 'cloud:pending-policy': null },
      }))
    })

    renderHome()

    await waitFor(() => expect(window.coworkApi.workspace.policy).toHaveBeenCalledWith('cloud:pending-policy'))
    expect(screen.queryByRole('button', { name: /Plan a release/i })).toBeNull()
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

    expect(await screen.findByRole('button', { name: /Plan a release/i })).toBeTruthy()
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
      useWorkspaceSupportStore.setState((state) => ({
        supportByWorkspace: { ...state.supportByWorkspace, 'cloud:test': cloudPromptSupport },
        loadedByWorkspace: { ...state.loadedByWorkspace, 'cloud:test': true },
        loadingByWorkspace: { ...state.loadingByWorkspace, 'cloud:test': false },
        errorByWorkspace: { ...state.errorByWorkspace, 'cloud:test': null },
      }))
    })

    renderHome({ onStartThread })

    await waitFor(() => expect(window.coworkApi.workspace.policy).toHaveBeenCalledWith('cloud:test'))
    expect(await screen.findByText('1 coworkers · manage')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Plan a release/i })).toBeNull()
    expect(await screen.findByRole('button', { name: /Profile default/i })).toBeDisabled()
    expect(screen.getAllByText('No primary lead in this profile')).toHaveLength(4)

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
        onNavigate={vi.fn()}
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

  it('renders assign-to controls and routes suggestions through the selected lead', async () => {
    const user = userEvent.setup()
    const onStartThread = createStartThreadMock()
    installHomeRuntime()

    renderHome({ onStartThread })

    await user.click(await screen.findByRole('button', { name: /Build.*default/i }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Cleo/i }))
    expect(useSessionStore.getState().agentMode).toBe('chief-of-staff')

    await user.click(screen.getByRole('button', { name: /Create a workflow/i }))
    const composer = screen.getByPlaceholderText('Ask anything, or @mention a coworker')
    expect(composer).toHaveValue('Help me turn a repeated task into a saved workflow.')
    await waitFor(() => expect(document.activeElement).toBe(composer))

    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(onStartThread).toHaveBeenCalledWith('Help me turn a repeated task into a saved workflow.', [], 'chief-of-staff')
    })
  })

  it('renders live launchpad feed columns and deep-links rows', async () => {
    const user = userEvent.setup()
    const onOpenThread = vi.fn()
    const onNavigate = vi.fn()
    installHomeRuntime({
      launchpad: {
        feed: vi.fn(async () => ({
          generatedAt: '2026-01-02T00:00:00.000Z',
          inProgress: [{
            id: 'task-1',
            kind: 'task',
            title: 'Implement launchpad parity',
            projectId: 'project-1',
            projectTitle: 'Studio redesign',
            taskId: 'task-1',
            taskTitle: 'Implement launchpad parity',
            sessionId: 'session-task',
            runId: 'run-1',
            assigneeAgent: 'build',
            status: 'running',
            priority: 'high',
            when: '2026-01-02T10:00:00.000Z',
            updatedAt: '2026-01-02T10:00:00.000Z',
          }],
          waitingOnYou: [{
            id: 'permission:session-review:approval-1',
            kind: 'permission',
            status: 'pending',
            title: 'Approve test command',
            projectId: 'project-1',
            projectTitle: 'Studio redesign',
            taskId: 'task-2',
            taskTitle: 'Review launchpad',
            sessionId: 'session-review',
            runId: 'run-2',
            assigneeAgent: 'review',
            when: '2026-01-02T10:10:00.000Z',
            updatedAt: '2026-01-02T10:10:00.000Z',
          }],
          freshArtifacts: [{
            id: 'artifact:session-artifact:artifact-1',
            artifactId: 'artifact-1',
            kind: 'document',
            status: 'draft',
            title: 'launchpad-spec.md',
            projectId: 'project-1',
            projectTitle: 'Studio redesign',
            taskId: 'task-3',
            taskTitle: 'Document launchpad',
            sessionId: 'session-artifact',
            runId: 'run-3',
            assigneeAgent: 'build',
            authorAgentId: 'build',
            when: '2026-01-02T10:20:00.000Z',
            createdAt: '2026-01-02T10:20:00.000Z',
            updatedAt: '2026-01-02T10:20:00.000Z',
          }],
          totals: { inProgress: 1, waitingOnYou: 1, freshArtifacts: 1 },
          truncated: { inProgress: false, waitingOnYou: false, freshArtifacts: false },
        })),
      },
    })

    renderHome({ onOpenThread, onNavigate })

    expect(await screen.findByText('Implement launchpad parity')).toBeTruthy()
    expect(screen.getByText('Approve test command')).toBeTruthy()
    expect(screen.getByText('launchpad-spec.md')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /Implement launchpad parity/i }))
    expect(onOpenThread).toHaveBeenCalledWith('session-task')

    await user.click(screen.getByRole('button', { name: /Approve test command/i }))
    expect(onOpenThread).toHaveBeenCalledWith('session-review')

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    await user.click(screen.getByRole('button', { name: /launchpad-spec\.md/i }))
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'open-cowork:open-resource',
    }))
    dispatchSpy.mockRestore()
  })

  it('refreshes the launchpad feed when existing session metadata changes', async () => {
    const feed = vi.fn(async () => ({
      generatedAt: '2026-01-02T10:00:00.000Z',
      inProgress: [],
      waitingOnYou: [],
      freshArtifacts: [],
      totals: { inProgress: 0, waitingOnYou: 0, freshArtifacts: 0 },
      truncated: { inProgress: false, waitingOnYou: false, freshArtifacts: false },
    }))
    installHomeRuntime({ launchpad: { feed } })

    renderHome()
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1))

    act(() => {
      useSessionStore.getState().setSessions([{
        id: 'session-existing',
        title: 'Existing work',
        createdAt: '2026-01-02T10:00:00.000Z',
        updatedAt: '2026-01-02T10:05:00.000Z',
      }])
    })

    await waitFor(() => expect(feed).toHaveBeenCalledTimes(2))

    act(() => {
      useSessionStore.getState().setSessions([{
        id: 'session-existing',
        title: 'Existing work',
        createdAt: '2026-01-02T10:00:00.000Z',
        updatedAt: '2026-01-02T10:10:00.000Z',
      }])
    })

    await waitFor(() => expect(feed).toHaveBeenCalledTimes(3))
  })

  it('opens the source thread for privacy-preserving local artifact ids', async () => {
    const user = userEvent.setup()
    const onOpenThread = vi.fn(async () => undefined)
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    installHomeRuntime({
      launchpad: {
        feed: vi.fn(async () => ({
          generatedAt: '2026-01-02T10:30:00.000Z',
          inProgress: [],
          waitingOnYou: [],
          freshArtifacts: [{
            id: 'artifact:session-artifact:local-artifact-private',
            artifactId: 'local-artifact-private',
            kind: 'document',
            status: 'draft',
            title: 'private-artifact.md',
            projectId: 'project-1',
            projectTitle: 'Studio redesign',
            taskId: 'task-3',
            taskTitle: 'Document launchpad',
            sessionId: 'session-artifact',
            runId: 'run-3',
            assigneeAgent: 'build',
            authorAgentId: 'build',
            when: '2026-01-02T10:20:00.000Z',
            createdAt: '2026-01-02T10:20:00.000Z',
            updatedAt: '2026-01-02T10:20:00.000Z',
          }],
          totals: { inProgress: 0, waitingOnYou: 0, freshArtifacts: 1 },
          truncated: { inProgress: false, waitingOnYou: false, freshArtifacts: false },
        })),
      },
    })

    renderHome({ onOpenThread })

    await user.click(await screen.findByRole('button', { name: /private-artifact\.md/i }))
    expect(onOpenThread).toHaveBeenCalledWith('session-artifact')
    expect(dispatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'open-cowork:open-resource',
    }))
    dispatchSpy.mockRestore()
  })

  it('counts the full team even when the avatar strip is capped', async () => {
    const allowedAgents = ['build', 'plan', 'chief-of-staff', ...Array.from({ length: 6 }, (_, index) => `custom-agent-${index + 1}`)]
    const cloudPromptSupport: WorkspaceApiSupport[] = [{
      api: 'sessions.prompt',
      status: 'supported',
      verdict: { allowed: true, reason: null },
    }]
    installHomeRuntime({
      app: {
        builtinAgents: vi.fn(async () => []),
      },
      workspace: {
        policy: vi.fn(async () => ({
          features: {},
          allowedAgents,
          allowedTools: null,
          allowedMcps: null,
          localFiles: 'disabled',
          localStdioMcps: 'disabled',
          machineRuntimeConfig: 'disabled',
        })),
        support: vi.fn(async () => cloudPromptSupport),
      },
      agents: {
        list: vi.fn(async () => Array.from({ length: 6 }, (_, index) => ({
          name: `custom-agent-${index + 1}`,
          description: 'Specialist coworker',
          enabled: true,
          valid: true,
        }))),
      },
    })
    act(() => {
      useSessionStore.getState().setActiveWorkspace('cloud:team-count')
      useWorkspaceSupportStore.setState((state) => ({
        supportByWorkspace: { ...state.supportByWorkspace, 'cloud:team-count': cloudPromptSupport },
        loadedByWorkspace: { ...state.loadedByWorkspace, 'cloud:team-count': true },
        loadingByWorkspace: { ...state.loadingByWorkspace, 'cloud:team-count': false },
        errorByWorkspace: { ...state.errorByWorkspace, 'cloud:team-count': null },
      }))
    })

    renderHome()

    expect(await screen.findByText('9 coworkers · manage')).toBeTruthy()
  })

  it('routes the team strip into the Team surface', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    installHomeRuntime()

    renderHome({ onNavigate })

    await user.click(await screen.findByRole('button', { name: /Your team/i }))
    expect(onNavigate).toHaveBeenCalledWith('team')
  })
})
