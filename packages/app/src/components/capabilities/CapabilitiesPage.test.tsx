import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  BuiltInAgentDetail,
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  CustomMcpConfig,
  CustomAgentSummary,
  CustomSkillConfig,
  RuntimeToolDescriptor,
  WorkflowListPayload,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { CapabilitiesPage } from './CapabilitiesPage'
import { CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY } from './capabilities-page-support'

// The canonical <Select> renders a custom listbox: a trigger <button> named
// "<label>: <selectedLabel>" that opens a role="listbox" of role="option"
// buttons. It does not respond to userEvent.selectOptions, so pick an option by
// opening the trigger and clicking the matching option.
async function pickFromSelect(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  optionName: string | RegExp,
) {
  await user.click(trigger)
  await user.click(await screen.findByRole('option', { name: optionName }))
}

const chartTool: CapabilityTool = {
  id: 'charts',
  name: 'Chart MCP',
  icon: 'chart',
  description: 'Creates charts and report visuals.',
  kind: 'mcp',
  source: 'custom',
  origin: 'custom',
  scope: 'project',
  namespace: 'charts',
  patterns: ['mcp__charts__*'],
  availableTools: [
    { id: 'mcp__charts__bar', description: 'Render a bar chart.' },
  ],
  agentNames: ['chart-agent'],
  credentials: [
    {
      key: 'apiKey',
      label: 'Charts API key',
      description: 'Token for the chart service.',
      placeholder: 'ck-...',
      secret: true,
      required: true,
    },
  ],
  integrationId: 'charts',
  authMode: 'api_token',
}

const shellTool: CapabilityTool = {
  id: 'shell',
  name: 'Shell tools',
  description: 'Runs local shell commands.',
  kind: 'built-in',
  source: 'builtin',
  origin: 'open-cowork',
  patterns: ['bash'],
  availableTools: [{ id: 'bash', description: 'Run bash commands.' }],
  agentNames: [],
}

const researchSkill: CapabilitySkill = {
  name: 'research',
  label: 'Research Skill',
  description: 'Collects sources and extracts findings.',
  source: 'builtin',
  origin: 'open-cowork',
  scope: 'project',
  location: '/work/project/.opencode/skills/research/SKILL.md',
  toolIds: ['charts'],
  agentNames: ['research-agent'],
}

const customMcp: CustomMcpConfig = {
  scope: 'project',
  directory: '/work/project',
  name: 'charts',
  label: 'Charts',
  description: 'Custom charts MCP',
  type: 'stdio',
  command: 'node',
  args: ['charts.js'],
}

const customSkill: CustomSkillConfig = {
  scope: 'project',
  directory: '/work/project',
  name: 'research',
  content: '---\ntools: [charts]\n---\nUse research workflow.',
  files: [{ path: 'README.md', content: 'Reference note' }],
  toolIds: ['charts'],
}

const runtimeTools: RuntimeToolDescriptor[] = [
  { id: 'mcp__charts__line', description: 'Render a line chart.' },
  { id: 'bash', description: 'Run bash commands.' },
]

const skillBundle: CapabilitySkillBundle = {
  name: 'research',
  source: 'builtin',
  origin: 'open-cowork',
  scope: 'project',
  location: '/work/project/.opencode/skills/research/SKILL.md',
  content: '---\ntools: [charts]\n---\nUse research workflow.',
  files: [{ path: 'README.md' }],
}

const relationshipAgent: CustomAgentSummary = {
  scope: 'project',
  directory: '/work/project',
  name: 'reporter',
  description: 'Reporting specialist.',
  instructions: 'Build recurring reports.',
  skillNames: ['research'],
  toolIds: ['charts'],
  enabled: true,
  color: 'primary',
  writeAccess: true,
  valid: true,
  issues: [],
}

const relationshipWorkflowList: WorkflowListPayload = {
  workflows: [{
    id: 'workflow-daily-report',
    title: 'Daily Report',
    instructions: 'Publish the daily report.',
    agentName: 'reporter',
    skillNames: ['research'],
    toolIds: ['charts'],
    status: 'active',
    projectDirectory: '/work/project',
    draftSessionId: null,
    triggers: [{ id: 'daily', type: 'schedule', enabled: true, schedule: { type: 'daily', timezone: 'UTC', runAtHour: 9, runAtMinute: 0 } }],
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
    nextRunAt: null,
    lastRunAt: null,
    latestRunId: null,
    latestRunStatus: null,
    latestRunSessionId: null,
    latestRunSummary: null,
    webhookUrl: null,
    steps: [{ id: 'step-1', title: 'Publish report', detail: 'Generate and share the daily report.' }],
  }],
  runs: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}

function renderCapabilitiesPage(overrides: {
  tools?: CapabilityTool[]
  toolsError?: Error
  skills?: CapabilitySkill[]
  skillsError?: Error
  customMcps?: CustomMcpConfig[]
  customSkills?: CustomSkillConfig[]
  integrationCredentials?: Record<string, string>
  integrationEnabled?: Record<string, boolean>
  integrationCredentialsError?: Error
  settingsGetError?: Error
  mcpPreflight?: ReturnType<typeof vi.fn>
  reportRendererError?: ReturnType<typeof vi.fn>
  customAgents?: CustomAgentSummary[]
  builtInAgents?: BuiltInAgentDetail[]
  workflows?: WorkflowListPayload
  initialTarget?: { kind: 'tool' | 'skill'; id: string } | null
  onInitialTargetHandled?: () => void
  activeWorkspaceId?: string
} = {}) {
  const activeWorkspaceId = overrides.activeWorkspaceId ?? LOCAL_WORKSPACE_ID
  const isLocalWorkspace = activeWorkspaceId === LOCAL_WORKSPACE_ID
  useSessionStore.setState({
    activeWorkspaceId,
    currentSessionId: isLocalWorkspace ? 'session-1' : null,
    globalErrors: [],
    sessions: isLocalWorkspace ? [
      {
        id: 'session-1',
        title: 'Dashboard work',
        directory: '/work/project',
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:00.000Z',
      },
    ] : [],
  })

  const tools = vi.fn(async () => {
    if (overrides.toolsError) throw overrides.toolsError
    return overrides.tools ?? [chartTool, shellTool]
  })
  const tool = vi.fn(async (id: string) => {
    const availableTools = overrides.tools ?? [chartTool, shellTool]
    return availableTools.find((entry) => entry.id === id) ?? chartTool
  })
  const skills = vi.fn(async () => {
    if (overrides.skillsError) throw overrides.skillsError
    return overrides.skills ?? [researchSkill]
  })
  const skillBundleFile = vi.fn(async () => 'Reference note')
  const listMcps = vi.fn(async () => overrides.customMcps ?? [customMcp])
  const listSkills = vi.fn(async () => overrides.customSkills ?? [customSkill])
  const listRuntimeTools = vi.fn(async () => runtimeTools)
  const listAgents = vi.fn(async () => overrides.customAgents ?? [])
  const builtinAgents = vi.fn(async () => overrides.builtInAgents ?? [])
  const listWorkflows = vi.fn(async () => overrides.workflows ?? { workflows: [], runs: [] })
  const getSkillBundle = vi.fn(async () => skillBundle)
  let settingsSnapshot = {
    selectedProviderId: null,
    selectedModelId: null,
    providerCredentials: {},
    integrationCredentials: {
      charts: overrides.integrationCredentials ?? { apiKey: 'ck-stored' },
    },
    integrationEnabled: overrides.integrationEnabled ?? {},
    bashPermission: 'deny',
    fileWritePermission: 'deny',
    workflowLaunchAtLogin: false,
    workflowRunInBackground: false,
    workflowDesktopNotifications: true,
    workflowQuietHoursStart: null,
    workflowQuietHoursEnd: null,
    effectiveProviderId: null,
    effectiveModel: null,
  }
  const get = vi.fn(async () => {
    if (overrides.settingsGetError) throw overrides.settingsGetError
    return settingsSnapshot
  })
  const getIntegrationCredentials = vi.fn(async () => {
    if (overrides.integrationCredentialsError) throw overrides.integrationCredentialsError
    return settingsSnapshot.integrationCredentials.charts ?? {}
  })
  const set = vi.fn(async (updates) => {
    settingsSnapshot = {
      ...settingsSnapshot,
      ...updates,
      integrationCredentials: {
        ...settingsSnapshot.integrationCredentials,
        ...updates.integrationCredentials,
      },
      integrationEnabled: {
        ...settingsSnapshot.integrationEnabled,
        ...updates.integrationEnabled,
      },
    }
    return settingsSnapshot
  })
  const mcpPreflight = overrides.mcpPreflight || vi.fn(async (name: string) => ({
    ok: true,
    status: 'ok',
    mcpName: name,
    message: `${name} connected and exposed 1 MCP method.`,
    methodCount: 1,
  }))
  const unsubscribeRuntimeReady = vi.fn()
  let runtimeReadyHandler: (() => void) | null = null
  const runtimeReady = vi.fn((handler: () => void) => {
    runtimeReadyHandler = handler
    return unsubscribeRuntimeReady
  })
  const reportRendererError = overrides.reportRendererError || vi.fn()
  const removeMcp = vi.fn(async () => true)
  const removeSkill = vi.fn(async () => true)
  installRendererTestCoworkApi({
    app: {
      builtinAgents,
    },
    agents: {
      list: listAgents,
    },
    workflows: {
      list: listWorkflows,
    },
    capabilities: {
      tools,
      tool,
      skills,
      skillBundle: getSkillBundle,
      skillBundleFile,
    },
    custom: {
      listMcps,
      listSkills,
      removeMcp,
      removeSkill,
    },
    tools: {
      list: listRuntimeTools,
    },
    settings: {
      get,
      getIntegrationCredentials,
      set,
    },
    mcp: {
      preflight: mcpPreflight,
    },
    diagnostics: {
      reportRendererError,
    },
    on: {
      runtimeReady,
    },
  })

  const props = {
    onClose: vi.fn(),
    onCreateAgent: vi.fn(),
    initialTarget: overrides.initialTarget ?? null,
    onInitialTargetHandled: overrides.onInitialTargetHandled,
  }
  const view = render(<CapabilitiesPage {...props} />)

  return {
    tools,
    tool,
    skills,
    getSkillBundle,
    skillBundleFile,
    listMcps,
    listSkills,
    removeMcp,
    removeSkill,
    listRuntimeTools,
    listAgents,
    builtinAgents,
    listWorkflows,
    getIntegrationCredentials,
    reportRendererError,
    settingsSet: set,
    mcpPreflight,
    runtimeReady,
    triggerRuntimeReady: () => runtimeReadyHandler?.(),
    unsubscribeRuntimeReady,
    unmount: view.unmount,
    ...props,
  }
}

describe('CapabilitiesPage', () => {
  it('keeps a non-local workspace catalog browsable without exposing Local configuration actions', async () => {
    const user = userEvent.setup()
    const api = renderCapabilitiesPage({ activeWorkspaceId: 'cloud:second' })

    expect(await screen.findByRole('heading', { name: 'Tools & Skills' })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(
      'This workspace shows a read-only catalog. Configure tools and skills in Desktop Local.',
    )
    expect(api.tools).toHaveBeenCalledWith({ sessionId: undefined, workspaceId: 'cloud:second' })
    expect(api.skills).toHaveBeenCalledWith({ directory: undefined, workspaceId: 'cloud:second' })
    expect(screen.getAllByText('Chart MCP').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Add connection' })).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced developer tools')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open tool Chart MCP' }))

    expect(await screen.findByRole('heading', { name: 'Chart MCP' })).toBeInTheDocument()
    expect(api.tool).toHaveBeenCalledWith('charts', { sessionId: undefined, workspaceId: 'cloud:second' })
    expect(screen.getByText('mcp__charts__line')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create coworker' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit tool' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove tool' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Charts API key')).not.toBeInTheDocument()
    expect(api.getIntegrationCredentials).not.toHaveBeenCalled()
    expect(api.settingsSet).not.toHaveBeenCalled()
    expect(api.removeMcp).not.toHaveBeenCalled()
    expect(api.onCreateAgent).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Tools & Skills' }))
    await user.click(screen.getByRole('radio', { name: 'Skills' }))
    await user.click(await screen.findByRole('button', { name: /Details for Research Skill/ }))

    expect(await screen.findByRole('heading', { name: 'Research Skill' })).toBeInTheDocument()
    expect(api.getSkillBundle).toHaveBeenCalledWith('research', { directory: undefined, workspaceId: 'cloud:second' })
    expect(screen.queryByRole('button', { name: 'Create coworker' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit skill' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove skill' })).not.toBeInTheDocument()
    expect(api.removeSkill).not.toHaveBeenCalled()
    expect(api.onCreateAgent).not.toHaveBeenCalled()
  })

  it('reloads catalogs with an explicit workspace scope when the active workspace changes', async () => {
    const api = renderCapabilitiesPage()
    expect((await screen.findAllByText('Chart MCP')).length).toBeGreaterThan(0)

    act(() => {
      useSessionStore.setState({
        activeWorkspaceId: 'cloud:second',
        currentSessionId: null,
        sessions: [],
      })
    })

    await waitFor(() => {
      expect(api.tools).toHaveBeenLastCalledWith({ sessionId: undefined, workspaceId: 'cloud:second' })
      expect(api.skills).toHaveBeenLastCalledWith({ directory: undefined, workspaceId: 'cloud:second' })
      expect(api.listMcps).toHaveBeenLastCalledWith({ directory: undefined, workspaceId: 'cloud:second' })
      expect(api.listSkills).toHaveBeenLastCalledWith({ directory: undefined, workspaceId: 'cloud:second' })
    })
  })

  it('loads scoped tool and skill inventories, filters them, and cleans up runtime listeners', async () => {
    const user = userEvent.setup()
    const api = renderCapabilitiesPage()

    expect(await screen.findByRole('heading', { name: 'Tools & Skills' })).toBeInTheDocument()
    expect(screen.getByText('Workspace catalog')).toBeInTheDocument()
    expect(screen.getByText('Inspect and configure the tools and skills available in this workspace.')).toBeInTheDocument()
    expect(screen.getAllByText('Chart MCP').length).toBeGreaterThan(0)
    expect(screen.getByText('Shell tools')).toBeInTheDocument()
    expect(screen.getByText('Available tools').parentElement).toHaveTextContent('2')
    expect(screen.getByText('Available skills').parentElement).toHaveTextContent('1')
    expect(api.tools).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(api.skills).toHaveBeenCalledWith({ directory: '/work/project' })
    expect(api.listMcps).toHaveBeenCalledWith({ directory: '/work/project' })
    expect(api.listSkills).toHaveBeenCalledWith({ directory: '/work/project' })
    expect(api.runtimeReady).toHaveBeenCalledTimes(1)
    expect(api.listAgents).not.toHaveBeenCalled()
    expect(api.builtinAgents).not.toHaveBeenCalled()
    expect(api.listWorkflows).not.toHaveBeenCalled()
    expect(screen.queryByRole('radio', { name: 'Relationships' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open tool Chart MCP' })).toHaveTextContent('1 coworker')

    const toolSearch = screen.getByPlaceholderText('Search tools, skills, linked capabilities, or coworkers...')
    await user.type(toolSearch, 'report')
    expect(screen.getAllByText('Chart MCP').length).toBeGreaterThan(0)
    expect(screen.queryByText('Shell tools')).not.toBeInTheDocument()

    await user.clear(toolSearch)
    await user.click(screen.getByRole('radio', { name: 'Skills' }))
    expect(await screen.findByPlaceholderText('Search skills, descriptions, or coworkers...')).toBeInTheDocument()
    expect(screen.getByText('Research Skill')).toBeInTheDocument()

    api.unmount()
    expect(api.unsubscribeRuntimeReady).toHaveBeenCalledTimes(1)
  })

  it('puts the discovered catalog before the closed developer linker', async () => {
    renderCapabilitiesPage()

    const catalogItem = (await screen.findAllByText('Chart MCP'))[0]!
    const advanced = screen.getByText('Advanced developer tools')
    expect(catalogItem.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText('Link local durable Gateway / Wiki CLIs')).not.toBeInTheDocument()
    await userEvent.click(advanced)
    const linker = await screen.findByText('Link local durable Gateway / Wiki CLIs')
    expect(linker).toBeVisible()
  })

  it('keeps full tool instructions out of the default accessibility tree until Details opens', async () => {
    const operatorTail = 'Operator-only sentinel instructions must stay behind Details.'
    renderCapabilitiesPage({
      tools: [{
        ...chartTool,
        description: `Creates charts for reports. ${operatorTail.repeat(6)}`,
      }, shellTool],
    })

    const card = await screen.findByRole('button', { name: 'Open tool Chart MCP' })
    expect(within(card).getByText('Creates charts for reports.')).toBeInTheDocument()
    expect(screen.queryByText(/Operator-only sentinel instructions/)).not.toBeInTheDocument()

    await userEvent.click(card)
    expect(await screen.findByRole('heading', { name: 'Chart MCP' })).toBeInTheDocument()
    expect(screen.getByText(/Operator-only sentinel instructions/)).toBeInTheDocument()
  })

  it('keeps successful catalog sources visible when discovery is partial', async () => {
    renderCapabilitiesPage({ skillsError: new Error('skills unavailable') })

    expect((await screen.findAllByText('Chart MCP')).length).toBeGreaterThan(0)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Catalog partially loaded.')
    expect(alert).toHaveTextContent('skills')
    expect(screen.getByText('Available tools').parentElement).toHaveTextContent('2')
    expect(screen.getByText('Available skills').parentElement).toHaveTextContent('0')
    expect(screen.queryByText('Couldn’t load capabilities')).not.toBeInTheDocument()
  })

  it('shows a recoverable total-error state when the tool and skill catalog sources fail', async () => {
    const user = userEvent.setup()
    const api = renderCapabilitiesPage({
      toolsError: new Error('tools unavailable'),
      skillsError: new Error('skills unavailable'),
      customMcps: [],
      customSkills: [],
    })

    expect(await screen.findByText('Couldn’t load capabilities')).toBeInTheDocument()
    expect(screen.getByText('Check that the runtime is running, then reload. Your custom tools and skills are still saved.')).toBeInTheDocument()
    expect(screen.queryByText(/No tools discovered yet/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => {
      expect(api.tools).toHaveBeenCalledTimes(2)
      expect(api.skills).toHaveBeenCalledTimes(2)
    })
  })

  it('clears failed sources and ignores superseded catalog generations', async () => {
    const api = renderCapabilitiesPage()
    expect((await screen.findAllByText('Chart MCP')).length).toBeGreaterThan(0)
    expect(screen.getByText('Research Skill')).toBeInTheDocument()

    const olderTools = deferred<CapabilityTool[]>()
    const olderSkills = deferred<CapabilitySkill[]>()
    api.tools.mockReturnValueOnce(olderTools.promise)
    api.skills.mockReturnValueOnce(olderSkills.promise)
    act(() => api.triggerRuntimeReady())

    await waitFor(() => {
      expect(screen.queryByText('Chart MCP')).not.toBeInTheDocument()
      expect(document.querySelectorAll('.ui-skeleton')).toHaveLength(6)
    })

    const currentTool: CapabilityTool = {
      ...chartTool,
      id: 'current-tool',
      name: 'Current generation tool',
      namespace: 'current-tool',
    }
    const staleTool: CapabilityTool = {
      ...chartTool,
      id: 'stale-tool',
      name: 'Stale generation tool',
      namespace: 'stale-tool',
    }
    const staleSkill: CapabilitySkill = {
      ...researchSkill,
      name: 'stale-skill',
      label: 'Stale generation skill',
    }
    const currentSkills = deferred<CapabilitySkill[]>()
    api.tools.mockResolvedValueOnce([currentTool])
    api.skills.mockReturnValueOnce(currentSkills.promise)
    act(() => api.triggerRuntimeReady())

    await act(async () => {
      olderTools.resolve([staleTool])
      olderSkills.resolve([staleSkill])
      await Promise.all([olderTools.promise, olderSkills.promise])
    })
    await waitFor(() => {
      expect(screen.queryByText('Stale generation tool')).not.toBeInTheDocument()
      expect(screen.queryByText('Stale generation skill')).not.toBeInTheDocument()
      expect(document.querySelectorAll('.ui-skeleton')).toHaveLength(6)
    })

    await act(async () => {
      currentSkills.reject(new Error('current skills unavailable'))
      await currentSkills.promise.catch(() => undefined)
    })

    expect((await screen.findAllByText('Current generation tool')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Chart MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('Research Skill')).not.toBeInTheDocument()
    expect(screen.queryByText('Stale generation tool')).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('skills')
  })

  it('opens exact tool navigation targets in the detail view', async () => {
    const onInitialTargetHandled = vi.fn()
    const api = renderCapabilitiesPage({
      initialTarget: { kind: 'tool', id: 'charts' },
      onInitialTargetHandled,
    })

    expect(await screen.findByRole('heading', { name: 'Chart MCP' })).toBeInTheDocument()
    await waitFor(() => {
      expect(api.tool).toHaveBeenCalledWith('charts', { sessionId: 'session-1' })
      expect(onInitialTargetHandled).toHaveBeenCalledTimes(1)
    })
  })

  it('opens exact skill navigation targets in the detail view', async () => {
    const onInitialTargetHandled = vi.fn()
    const api = renderCapabilitiesPage({
      initialTarget: { kind: 'skill', id: 'research' },
      onInitialTargetHandled,
    })

    expect(await screen.findByRole('heading', { name: 'Research Skill' })).toBeInTheDocument()
    await waitFor(() => {
      expect(api.getSkillBundle).toHaveBeenCalledWith('research', { directory: '/work/project' })
      expect(onInitialTargetHandled).toHaveBeenCalledTimes(1)
    })
  })

  it('ignores a superseded tool detail response after navigating to another tool', async () => {
    const user = userEvent.setup()
    const firstTool = { ...chartTool, id: 'first-tool', name: 'First tool', namespace: 'first' }
    const secondTool = { ...chartTool, id: 'second-tool', name: 'Second tool', namespace: 'second' }
    const staleDetail = deferred<CapabilityTool>()
    const api = renderCapabilitiesPage({ tools: [firstTool, secondTool] })
    api.tool.mockReturnValueOnce(staleDetail.promise).mockResolvedValueOnce(secondTool)

    await user.click(await screen.findByRole('button', { name: 'Open tool First tool' }))
    expect(await screen.findByRole('heading', { name: 'First tool' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Tools & Skills' }))
    await user.click(screen.getByRole('button', { name: 'Open tool Second tool' }))
    expect(await screen.findByRole('heading', { name: 'Second tool' })).toBeInTheDocument()

    await act(async () => {
      staleDetail.resolve(firstTool)
      await staleDetail.promise
    })
    expect(screen.getByRole('heading', { name: 'Second tool' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'First tool' })).not.toBeInTheDocument()
  })

  it('renders the gated relationship graph, consumer matrix, and remediation entry points', async () => {
    window.localStorage.setItem(CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY, 'true')
    const user = userEvent.setup()
    const api = renderCapabilitiesPage({
      tools: [{ ...chartTool, credentialReady: false }, shellTool],
      customAgents: [relationshipAgent],
      workflows: {
        ...relationshipWorkflowList,
        workflows: [
          ...relationshipWorkflowList.workflows,
          {
            ...relationshipWorkflowList.workflows[0]!,
            id: 'workflow-daily-report-copy',
          },
        ],
      },
    })

    expect(await screen.findByRole('heading', { name: 'Tools & Skills' })).toBeInTheDocument()
    await waitFor(() => {
      expect(api.listAgents).toHaveBeenCalledWith({ directory: '/work/project' })
      expect(api.listWorkflows).toHaveBeenCalledTimes(1)
    })

    await user.click(screen.getByRole('radio', { name: 'Relationships' }))

    const consumerMatrix = await screen.findByRole('table', { name: 'Consumer access matrix' })
    const capabilityMatrix = screen.getByRole('table', { name: 'Tool and skill access matrix' })
    expect(screen.getByText('Dependency graph')).toBeInTheDocument()
    expect(within(consumerMatrix).getAllByText('Playbook: Daily Report')).toHaveLength(2)
    expect(within(capabilityMatrix).getAllByText('Chart MCP').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Credential missing').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Copy consumers' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Copy consumers' }))
    await waitFor(() => {
      expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Playbook: Daily Report'))
    })

    const search = screen.getByPlaceholderText('Search capabilities, coworkers, playbooks, risks, credentials, or policies...')
    await user.type(search, 'daily report')
    expect(screen.getAllByText('Playbook: Daily Report').length).toBeGreaterThan(0)
    expect(screen.queryByText('Shell tools')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open tool' }))
    expect(await screen.findByRole('heading', { name: 'Chart MCP' })).toBeInTheDocument()
  })

  it('surfaces tool-skill relationships in the map and opens linked details', async () => {
    const user = userEvent.setup()
    renderCapabilitiesPage()

    // The map renders as a gallery of tool cards, each with a "Depends on" rail
    // of skill chips that surfaces the tool -> skill linkage.
    expect((await screen.findAllByText('Depends on')).length).toBeGreaterThan(0)
    expect(screen.getByText('Research Skill')).toBeInTheDocument()
    // The chart tool's one linked skill is surfaced as a rail chip whose tier
    // section reports a single group.
    expect(screen.getAllByText('1 group').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: /Research Skill/ }))
    expect(await screen.findByRole('heading', { name: 'Research Skill' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Chart MCP' }))
    expect(await screen.findByRole('heading', { name: 'Chart MCP' })).toBeInTheDocument()
    expect(screen.getByText('Linked skills')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Research Skill' })).toBeInTheDocument()
  })

  it('searches tools by linked skill text and skills by linked tool text', async () => {
    const user = userEvent.setup()
    renderCapabilitiesPage()

    const search = await screen.findByPlaceholderText('Search tools, skills, linked capabilities, or coworkers...')
    await user.type(search, 'collects sources')
    expect(screen.getAllByText('Chart MCP').length).toBeGreaterThan(0)
    expect(screen.getByText('Research Skill')).toBeInTheDocument()
    expect(screen.queryByText('Shell tools')).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'shell')
    expect(screen.getByText('Shell tools')).toBeInTheDocument()
    expect(screen.queryByText('Research Skill')).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Skills' }))
    const skillSearch = await screen.findByPlaceholderText('Search skills, descriptions, or coworkers...')
    await user.clear(skillSearch)
    await user.type(skillSearch, 'chart mcp')
    expect(screen.getByText('Research Skill')).toBeInTheDocument()
  })

  it('opens a tool detail, saves scoped integration credentials, and seeds agent creation', async () => {
    const user = userEvent.setup()
    const api = renderCapabilitiesPage()

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))

    expect(await screen.findByRole('heading', { name: 'Chart MCP' })).toBeInTheDocument()
    expect(api.tool).toHaveBeenCalledWith('charts', { sessionId: 'session-1' })
    expect(api.getIntegrationCredentials).toHaveBeenCalledWith('charts', {
      workspaceId: 'local',
      purpose: 'credential_editor',
    })
    expect(screen.getByText('mcp__charts__line')).toBeInTheDocument()

    const apiKeyInput = screen.getByLabelText(/Charts API key/)
    await user.click(apiKeyInput)
    await user.type(apiKeyInput, 'ck-new')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith({
        integrationCredentials: {
          charts: { apiKey: 'ck-new' },
        },
      })
    })

    await user.click(screen.getByRole('button', { name: 'Create coworker' }))
    expect(api.onCreateAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'charts-agent',
      toolIds: ['charts'],
      skillNames: [],
    }))
  })

  it('shows stored non-secret credentials while keeping secret values masked until edited', async () => {
    const user = userEvent.setup()
    const mixedCredentialTool: CapabilityTool = {
      ...chartTool,
      credentials: [
        ...(chartTool.credentials ?? []),
        {
          key: 'username',
          label: 'Username',
          description: 'Account username for chart API access.',
          placeholder: 'name@example.com',
          secret: false,
        },
        {
          key: 'accountRegion',
          label: 'Account region',
          description: 'Region slug used by the chart API.',
          placeholder: 'us',
          secret: false,
        },
      ],
    }
    renderCapabilitiesPage({
      tools: [mixedCredentialTool, shellTool],
      integrationCredentials: {
        apiKey: 'ck-stored',
        username: 'alice@example.com',
        accountRegion: 'eu',
      },
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))

    const apiKeyInput = await screen.findByLabelText(/Charts API key/)
    const usernameInput = screen.getByLabelText(/Username/)
    const accountRegionInput = screen.getByLabelText(/Account region/)

    expect(apiKeyInput).toHaveAttribute('type', 'password')
    expect(apiKeyInput).toHaveValue('••••••••')
    expect(usernameInput).toHaveAttribute('type', 'text')
    expect(usernameInput).toHaveValue('alice@example.com')
    expect(accountRegionInput).toHaveAttribute('type', 'text')
    expect(accountRegionInput).toHaveValue('eu')

    await user.click(usernameInput)
    expect(usernameInput).toHaveValue('alice@example.com')

    await user.click(apiKeyInput)
    expect(apiKeyInput).toHaveValue('')
  })

  it('renders select credentials and conditionally shows dependent credential fields without clearing hidden values', async () => {
    const user = userEvent.setup()
    const multiAuthTool: CapabilityTool = {
      ...chartTool,
      credentials: [
        {
          key: 'authMethod',
          label: 'Authentication method',
          description: 'How to authenticate with the chart service.',
          type: 'select',
          options: [
            { label: 'API key', value: 'api_key', hint: 'Static API credentials' },
            { label: 'SSO', value: 'sso', hint: 'Browser-based sign in' },
          ],
          secret: false,
          required: true,
        },
        {
          key: 'apiKey',
          label: 'Charts API key',
          description: 'Token for the chart service.',
          secret: true,
          required: true,
          when: { key: 'authMethod', op: 'eq', value: 'api_key' },
        },
        {
          key: 'ssoUser',
          label: 'SSO email',
          description: 'Email address for single sign-on.',
          secret: false,
          required: true,
          when: { key: 'authMethod', op: 'eq', value: 'sso' },
        },
      ],
    }
    const api = renderCapabilitiesPage({
      tools: [multiAuthTool, shellTool],
      integrationCredentials: {
        authMethod: 'api_key',
        apiKey: 'ck-stored',
        ssoUser: 'alice@example.com',
      },
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))

    const authMethod = await screen.findByLabelText(/Authentication method/)
    expect(authMethod).toHaveAccessibleName('Authentication method: API key')
    expect(screen.getByText('Static API credentials')).toBeInTheDocument()
    expect(screen.getByLabelText(/Charts API key/)).toHaveValue('••••••••')
    expect(screen.queryByLabelText(/SSO email/)).not.toBeInTheDocument()

    await pickFromSelect(user, authMethod, 'SSO')

    expect(screen.queryByLabelText(/Charts API key/)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/SSO email/)).toHaveValue('alice@example.com')
    expect(screen.getByText('Browser-based sign in')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith({
        integrationCredentials: {
          charts: { authMethod: 'sso' },
        },
      })
    })
  })

  it('preflights API-token MCP credentials after saving', async () => {
    const user = userEvent.setup()
    const mcpPreflight = vi.fn(async (name: string) => ({
      ok: false,
      status: 'auth_rejected',
      mcpName: name,
      message: 'charts rejected the saved token with HTTP 401. Check that the token is valid and not revoked.',
      httpStatus: 401,
      responseBody: 'Bad credentials',
      helpText: 'Authorize the token for SSO and required repositories.',
    }))
    const api = renderCapabilitiesPage({
      mcpPreflight,
      integrationCredentials: {},
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))
    const apiKeyInput = await screen.findByLabelText(/Charts API key/)
    await user.type(apiKeyInput, 'ck-new')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith({
        integrationCredentials: {
          charts: { apiKey: 'ck-new' },
        },
      })
    })
    await waitFor(() => {
      expect(api.mcpPreflight).toHaveBeenCalledWith('charts')
    })
    expect(screen.getByRole('alert')).toHaveTextContent('charts rejected the saved token')
    expect(screen.getByRole('alert')).toHaveTextContent('Authorize the token for SSO')
    expect(screen.getByRole('alert')).toHaveTextContent('Response: Bad credentials')
  })

  it('skips automatic API-token preflight when the integration is explicitly disabled', async () => {
    const user = userEvent.setup()
    const disabledTool: CapabilityTool = {
      ...chartTool,
      enabled: false,
    }
    const mcpPreflight = vi.fn(async (name: string) => ({
      ok: false,
      status: 'invalid_config',
      mcpName: name,
      message: `${name} is not ready to connect.`,
    }))
    const api = renderCapabilitiesPage({
      tools: [disabledTool, shellTool],
      mcpPreflight,
      integrationCredentials: {},
      integrationEnabled: { charts: false },
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))
    const apiKeyInput = await screen.findByLabelText(/Charts API key/)
    await user.type(apiKeyInput, 'ck-disabled')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith({
        integrationCredentials: {
          charts: { apiKey: 'ck-disabled' },
        },
      })
    })
    await waitFor(() => {
      expect(api.getIntegrationCredentials).toHaveBeenCalledTimes(2)
    })
    expect(mcpPreflight).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('preflights after enabling an API-token MCP before saving credentials', async () => {
    const user = userEvent.setup()
    const disabledTool: CapabilityTool = {
      ...chartTool,
      enabled: false,
    }
    const mcpPreflight = vi.fn(async (name: string) => ({
      ok: true,
      status: 'ok',
      mcpName: name,
      message: `${name} connected and exposed 1 MCP method.`,
      methodCount: 1,
    }))
    const api = renderCapabilitiesPage({
      tools: [disabledTool, shellTool],
      mcpPreflight,
      integrationCredentials: {},
      integrationEnabled: { charts: false },
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))
    await user.click(screen.getByRole('switch', { name: 'Enable' }))
    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith({
        integrationEnabled: { charts: true },
      })
    })

    const apiKeyInput = await screen.findByLabelText(/Charts API key/)
    await user.type(apiKeyInput, 'ck-enabled')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith({
        integrationCredentials: {
          charts: { apiKey: 'ck-enabled' },
        },
      })
    })
    await waitFor(() => {
      expect(api.mcpPreflight).toHaveBeenCalledWith('charts')
    })
    expect(screen.getByRole('status')).toHaveTextContent('charts connected')
  })

  it('shows non-applicable API-token preflight results as non-error status', async () => {
    const user = userEvent.setup()
    const mcpPreflight = vi.fn(async (name: string) => ({
      ok: false,
      status: 'not_applicable',
      mcpName: name,
      message: `${name} does not use remote API-token authentication.`,
    }))
    renderCapabilitiesPage({
      mcpPreflight,
      integrationCredentials: {},
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))
    const apiKeyInput = await screen.findByLabelText(/Charts API key/)
    await user.type(apiKeyInput, 'ck-local')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mcpPreflight).toHaveBeenCalledWith('charts')
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('charts does not use remote API-token authentication.')
  })

  it('renders radio credential options and saves the selected value', async () => {
    const user = userEvent.setup()
    const radioTool: CapabilityTool = {
      ...chartTool,
      credentials: [
        {
          key: 'runtimeMode',
          label: 'Runtime mode',
          description: 'Where the integration should run.',
          type: 'radio',
          options: [
            { label: 'Local', value: 'local', hint: 'Run the bundled stdio server' },
            { label: 'Remote', value: 'remote', hint: 'Connect to a hosted MCP server' },
          ],
          required: true,
        },
      ],
    }
    const api = renderCapabilitiesPage({
      tools: [radioTool, shellTool],
      integrationCredentials: { runtimeMode: 'local' },
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))

    const local = await screen.findByRole('radio', { name: /Local/ })
    const remote = screen.getByRole('radio', { name: /Remote/ })
    expect(local).toBeChecked()
    expect(remote).not.toBeChecked()

    await user.click(remote)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith({
        integrationCredentials: {
          charts: { runtimeMode: 'remote' },
        },
      })
    })
  })

  it('surfaces stored integration credential load failures through the chat error channel and diagnostics', async () => {
    const user = userEvent.setup()
    const api = renderCapabilitiesPage({
      integrationCredentialsError: new Error('keychain unavailable'),
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load stored integration credentials. Please try again.')
    })
    expect(api.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('keychain unavailable'),
      view: 'capabilities',
    }))
  })

  it('surfaces integration readiness failures and tolerates diagnostics failures', async () => {
    const user = userEvent.setup()
    const reportRendererError = vi.fn(() => {
      throw new Error('diagnostics unavailable')
    })
    renderCapabilitiesPage({
      settingsGetError: new Error('settings unavailable'),
      reportRendererError,
    })

    await user.click(await screen.findByRole('button', { name: /Chart MCP/ }))

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not verify integration credential readiness. Please try again.')
    })
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('settings unavailable'),
      view: 'capabilities',
    }))
  })

  it('opens a skill bundle, lazy-loads bundle files, and creates a skill-backed agent seed', async () => {
    const user = userEvent.setup()
    const api = renderCapabilitiesPage()

    await user.click(await screen.findByRole('radio', { name: 'Skills' }))
    await user.click(await screen.findByRole('button', { name: /Research Skill/ }))

    expect(await screen.findByRole('heading', { name: 'Research Skill' })).toBeInTheDocument()
    expect(screen.getByText('Use research workflow.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Chart MCP' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'README.md' }))
    expect(api.skillBundleFile).toHaveBeenCalledWith('research', 'README.md', { directory: '/work/project' })
    expect(await screen.findByText('Reference note')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create coworker' }))
    expect(api.onCreateAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'research-agent',
      toolIds: ['charts'],
      skillNames: ['research'],
    }))
  })
})
