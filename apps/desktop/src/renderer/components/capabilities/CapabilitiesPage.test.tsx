import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  CustomMcpConfig,
  CustomSkillConfig,
  RuntimeToolDescriptor,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { CapabilitiesPage } from './CapabilitiesPage'
import { FLEET_REGISTRY_FEATURE_GATE_KEY } from '../fleet/fleet-registry-model'

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

function renderCapabilitiesPage(overrides: {
  tools?: CapabilityTool[]
  skills?: CapabilitySkill[]
  customMcps?: CustomMcpConfig[]
  customSkills?: CustomSkillConfig[]
  integrationCredentials?: Record<string, string>
  integrationCredentialsError?: Error
  settingsGetError?: Error
  reportRendererError?: ReturnType<typeof vi.fn>
} = {}) {
  useSessionStore.setState({
    currentSessionId: 'session-1',
    globalErrors: [],
    sessions: [
      {
        id: 'session-1',
        title: 'Dashboard work',
        directory: '/work/project',
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:00.000Z',
      },
    ],
  })

  const tools = vi.fn(async () => overrides.tools ?? [chartTool, shellTool])
  const tool = vi.fn(async (id: string) => {
    const availableTools = overrides.tools ?? [chartTool, shellTool]
    return availableTools.find((entry) => entry.id === id) ?? chartTool
  })
  const skills = vi.fn(async () => overrides.skills ?? [researchSkill])
  const skillBundleFile = vi.fn(async () => 'Reference note')
  const listMcps = vi.fn(async () => overrides.customMcps ?? [customMcp])
  const listSkills = vi.fn(async () => overrides.customSkills ?? [customSkill])
  const listRuntimeTools = vi.fn(async () => runtimeTools)
  const get = vi.fn(async () => {
    if (overrides.settingsGetError) throw overrides.settingsGetError
    return {
      selectedProviderId: null,
      selectedModelId: null,
      providerCredentials: {},
      integrationCredentials: {
        charts: overrides.integrationCredentials ?? { apiKey: 'ck-stored' },
      },
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
      operationalMaxAutonomy: 'supervised',
      operationalWriteMaxParallel: 1,
      operationalMaxRunDurationMinutes: 120,
      operationalMaxCostUsd: null,
      operationalMaxRetries: 10,
      improvementProposalsEnabled: true,
      improvementProposalsDisabledAgents: {},
      improvementProposalsDisabledProjects: {},
      improvementProposalsDisabledCrews: {},
      effectiveProviderId: null,
      effectiveModel: null,
    }
  })
  const getIntegrationCredentials = vi.fn(async () => {
    if (overrides.integrationCredentialsError) throw overrides.integrationCredentialsError
    return overrides.integrationCredentials ?? { apiKey: 'ck-stored' }
  })
  const set = vi.fn(async (updates) => ({ ...(await get()), ...updates }))
  const unsubscribeRuntimeReady = vi.fn()
  const runtimeReady = vi.fn(() => unsubscribeRuntimeReady)
  const reportRendererError = overrides.reportRendererError || vi.fn()

  installRendererTestCoworkApi({
    capabilities: {
      tools,
      tool,
      skills,
      skillBundle: vi.fn(async () => skillBundle),
      skillBundleFile,
    },
    custom: {
      listMcps,
      listSkills,
      removeMcp: vi.fn(async () => true),
      removeSkill: vi.fn(async () => true),
    },
    tools: {
      list: listRuntimeTools,
    },
    settings: {
      get,
      getIntegrationCredentials,
      set,
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
  }
  const view = render(<CapabilitiesPage {...props} />)

  return {
    tools,
    tool,
    skills,
    skillBundleFile,
    listMcps,
    listSkills,
    listRuntimeTools,
    getIntegrationCredentials,
    reportRendererError,
    settingsSet: set,
    runtimeReady,
    unsubscribeRuntimeReady,
    unmount: view.unmount,
    ...props,
  }
}

describe('CapabilitiesPage', () => {
  it('loads scoped tool and skill inventories, filters them, and cleans up runtime listeners', async () => {
    const user = userEvent.setup()
    const api = renderCapabilitiesPage()

    expect(await screen.findByRole('heading', { name: 'Capabilities' })).toBeInTheDocument()
    expect(screen.getAllByText('Chart MCP').length).toBeGreaterThan(0)
    expect(screen.getByText('Shell tools')).toBeInTheDocument()
    expect(api.tools).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(api.skills).toHaveBeenCalledWith({ directory: '/work/project' })
    expect(api.listMcps).toHaveBeenCalledWith({ directory: '/work/project' })
    expect(api.listSkills).toHaveBeenCalledWith({ directory: '/work/project' })
    expect(api.runtimeReady).toHaveBeenCalledTimes(1)

    const toolSearch = screen.getByPlaceholderText('Search tools, skills, linked capabilities, or agents…')
    await user.type(toolSearch, 'report')
    expect(screen.getAllByText('Chart MCP').length).toBeGreaterThan(0)
    expect(screen.queryByText('Shell tools')).not.toBeInTheDocument()

    await user.clear(toolSearch)
    await user.click(screen.getByRole('button', { name: 'Skills' }))
    expect(await screen.findByPlaceholderText('Search skills, descriptions, or agents…')).toBeInTheDocument()
    expect(screen.getByText('Research Skill')).toBeInTheDocument()

    api.unmount()
    expect(api.unsubscribeRuntimeReady).toHaveBeenCalledTimes(1)
  })

  it('renders the gated capability registry table and opens dependency drill-downs', async () => {
    window.localStorage.setItem(FLEET_REGISTRY_FEATURE_GATE_KEY, 'true')
    const user = userEvent.setup()
    renderCapabilitiesPage()

    expect(await screen.findByRole('heading', { name: 'Capabilities' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'table' }))
    expect(screen.getByRole('table', { name: 'Capability registry table' })).toBeInTheDocument()

    await user.click(screen.getByLabelText('Select Chart MCP'))
    const drillDown = screen.getByRole('button', { name: 'Open dependency drill-down' })
    expect(drillDown).toBeEnabled()
    await user.click(drillDown)

    expect(await screen.findByRole('heading', { name: 'Chart MCP' })).toBeInTheDocument()
  })

  it('surfaces tool-skill relationships in the map and opens linked details', async () => {
    const user = userEvent.setup()
    renderCapabilitiesPage()

    expect(await screen.findByText('Capability map')).toBeInTheDocument()
    expect(screen.getByText('Research Skill')).toBeInTheDocument()
    expect(screen.getByText('1 linked')).toBeInTheDocument()

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

    const search = await screen.findByPlaceholderText('Search tools, skills, linked capabilities, or agents…')
    await user.type(search, 'collects sources')
    expect(screen.getAllByText('Chart MCP').length).toBeGreaterThan(0)
    expect(screen.getByText('Research Skill')).toBeInTheDocument()
    expect(screen.queryByText('Shell tools')).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'shell')
    expect(screen.getByText('Shell tools')).toBeInTheDocument()
    expect(screen.queryByText('Research Skill')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Skills' }))
    const skillSearch = await screen.findByPlaceholderText('Search skills, descriptions, or agents…')
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
    expect(api.getIntegrationCredentials).toHaveBeenCalledWith('charts')
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

    await user.click(screen.getByRole('button', { name: 'Create agent' }))
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
    expect(authMethod).toHaveValue('api_key')
    expect(screen.getByText('Static API credentials')).toBeInTheDocument()
    expect(screen.getByLabelText(/Charts API key/)).toHaveValue('••••••••')
    expect(screen.queryByLabelText(/SSO email/)).not.toBeInTheDocument()

    await user.selectOptions(authMethod, 'sso')

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

    await user.click(await screen.findByRole('button', { name: 'Skills' }))
    await user.click(await screen.findByRole('button', { name: /Research Skill/ }))

    expect(await screen.findByRole('heading', { name: 'Research Skill' })).toBeInTheDocument()
    expect(screen.getByText('Use research workflow.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Chart MCP' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'README.md' }))
    expect(api.skillBundleFile).toHaveBeenCalledWith('research', 'README.md', { directory: '/work/project' })
    expect(await screen.findByText('Reference note')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create agent' }))
    expect(api.onCreateAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'research-agent',
      toolIds: ['charts'],
      skillNames: ['research'],
    }))
  })
})
