import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { AgentCatalog, BuiltInAgentDetail, CustomAgentConfig, CustomAgentSummary, PublicAppConfig } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { AgentBuilderPage } from './AgentBuilderPage'

// The canonical <Select> renders a custom listbox: a trigger <button> named
// "<label>: <selectedLabel>" that opens a role="listbox" of role="option"
// buttons. It does not respond to userEvent.selectOptions, so pick an option by
// opening the trigger and clicking it. `scope` lets callers limit the trigger
// lookup to a specific permission group.
async function pickFromSelect(
  user: ReturnType<typeof userEvent.setup>,
  labelPrefix: string,
  optionName: string | RegExp,
  scope: { getByRole: typeof screen.getByRole } = screen,
) {
  await user.click(scope.getByRole('button', { name: new RegExp(`^${labelPrefix}:`) }))
  await user.click(scope.getByRole('option', { name: optionName }))
}

const catalog: AgentCatalog = {
  reservedNames: ['build'],
  colors: ['accent', 'success', 'warning', 'info', 'primary', 'secondary'],
  skills: [
    {
      name: 'research-kit',
      label: 'Research Kit',
      description: 'Collects source material and summaries.',
      source: 'builtin',
      origin: 'open-cowork',
      toolIds: ['chart-maker'],
    },
  ],
  tools: [
    {
      id: 'chart-maker',
      name: 'Chart Maker',
      icon: 'chart',
      description: 'Creates report charts.',
      supportsWrite: true,
      source: 'builtin',
      patterns: ['mcp__charts__*'],
    },
  ],
}

const baseAppConfig: PublicAppConfig = {
  branding: {
    appId: 'com.opencowork.desktop',
    name: 'Open Cowork',
    dataDirName: 'Open Cowork',
    helpUrl: 'https://github.com/joe-broadhead/open-cowork',
  },
  permissions: { bash: 'allow', fileWrite: 'allow', task: 'allow', web: 'allow', webSearch: true },
  providers: {
    defaultProvider: null,
    defaultModel: null,
    available: [],
  },
  auth: { mode: 'none', enabled: false },
  agentStarterTemplates: [],
}

function renderBuilder(props: Partial<ComponentProps<typeof AgentBuilderPage>> = {}) {
  const create = vi.fn(async (_payload: CustomAgentConfig) => true)
  const update = vi.fn(async (_target: unknown, _payload: CustomAgentConfig) => true)
  installRendererTestCoworkApi({
    agents: {
      create,
      update,
    },
  })

  const callbacks = {
    onCancel: vi.fn(),
    onSaved: vi.fn(),
    onOpenCapabilities: vi.fn(),
  }

  render(
    <AgentBuilderPage
      target={{ kind: 'new' }}
      catalog={catalog}
      existingCustomNames={[]}
      projectDirectory="/workspace/acme"
      {...callbacks}
      {...props}
    />,
  )

  return {
    create,
    update,
    ...callbacks,
  }
}

function builtInAgent(overrides: Partial<BuiltInAgentDetail> = {}): BuiltInAgentDetail {
  return {
    name: 'explore',
    label: 'Explore',
    source: 'opencode',
    mode: 'subagent',
    hidden: false,
    disabled: false,
    color: 'info',
    description: 'Read-only exploration specialist.',
    instructions: '',
    skills: [],
    toolAccess: [],
    nativeToolIds: ['websearch'],
    configuredToolIds: [],
    model: null,
    variant: null,
    temperature: null,
    top_p: null,
    steps: null,
    options: null,
    ...overrides,
  }
}

describe('AgentBuilderPage', () => {
  it('creates a project-scoped custom agent from the four-step hire wizard', async () => {
    const user = userEvent.setup()
    const { create, onSaved } = renderBuilder()

    expect(screen.getByRole('button', { name: 'Hire coworker' })).toBeDisabled()
    expect(screen.getByText('Complete these before saving')).toBeInTheDocument()
    expect(screen.getByText('Selected capabilities')).toBeInTheDocument()
    expect(screen.queryByText(/loadout/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Role' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Abilities' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Brain' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Permissions' })).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('agent-id'), 'market-analyst')
    await user.type(
      screen.getByPlaceholderText('What is this coworker specialised to do?'),
      'Prepares market analysis briefings.',
    )
    await user.click(screen.getByRole('button', { name: 'Abilities' }))
    await user.click(screen.getAllByRole('button', { name: /Research Kit/ })[0]!)
    await user.click(screen.getByRole('button', { name: 'Add tools' }))

    await user.click(screen.getByRole('button', { name: 'Role' }))
    await user.type(
      screen.getByPlaceholderText(/Examples:/),
      'Summarize market changes with concise evidence.',
    )

    await user.click(screen.getByRole('radio', { name: 'Project' }))
    await user.click(screen.getAllByRole('button', { name: 'Hire coworker' })[0]!)

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'market-analyst',
      description: 'Prepares market analysis briefings.',
      instructions: 'Summarize market changes with concise evidence.',
      skillNames: ['research-kit'],
      toolIds: ['chart-maker'],
      scope: 'project',
      directory: '/workspace/acme',
      mode: 'subagent',
    }))
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('permissionOverrides')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('renders built-in OpenCode agents as read-only and augments native tools for preview', async () => {
    const user = userEvent.setup()
    const { create, update } = renderBuilder({
      target: {
        kind: 'builtin',
        agent: builtInAgent(),
      },
    })

    expect(screen.getByText('Built-in - tune via the builtInAgents config block')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create coworker' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Instructions' }))
    expect(screen.getByText(/uses OpenCode's native built-in prompt/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Capabilities' }))
    expect(screen.getAllByText('Web Search').length).toBeGreaterThan(0)
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('does not add default permission overrides when saving a legacy custom agent', async () => {
    const user = userEvent.setup()
    const legacyAgent: CustomAgentSummary = {
      scope: 'machine',
      directory: null,
      name: 'legacy-agent',
      description: 'Legacy custom agent.',
      instructions: 'Keep existing runtime permissions.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'accent',
      avatar: null,
      deniedToolPatterns: [],
      mode: 'subagent',
      model: null,
      variant: null,
      temperature: null,
      top_p: null,
      steps: null,
      options: null,
      permissionOverrides: [],
      writeAccess: false,
      valid: true,
      issues: [],
    }
    const { update } = renderBuilder({
      target: { kind: 'custom', agent: legacyAgent },
    })

    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[0]!)

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty('permissionOverrides')
  })

  it('preserves partial custom-agent permission overrides on unrelated edits', async () => {
    const user = userEvent.setup()
    const agent: CustomAgentSummary = {
      scope: 'machine',
      directory: null,
      name: 'partial-agent',
      description: 'Partial custom agent.',
      instructions: 'Keep partial runtime permissions.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'accent',
      avatar: null,
      deniedToolPatterns: [],
      mode: 'subagent',
      model: null,
      variant: null,
      temperature: null,
      top_p: null,
      steps: null,
      options: null,
      permissionOverrides: [{ key: 'web', action: 'allow' }],
      writeAccess: false,
      valid: true,
      issues: [],
    }
    const { update } = renderBuilder({
      target: { kind: 'custom', agent },
    })

    await user.clear(screen.getByPlaceholderText('What is this coworker specialised to do?'))
    await user.type(screen.getByPlaceholderText('What is this coworker specialised to do?'), 'Updated description.')
    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[0]!)

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      description: 'Updated description.',
      permissionOverrides: [{ key: 'web', action: 'allow' }],
    })
  })

  it('only persists explicitly edited permission rows for partial custom-agent overrides', async () => {
    const user = userEvent.setup()
    const agent: CustomAgentSummary = {
      scope: 'machine',
      directory: null,
      name: 'partial-agent',
      description: 'Partial custom agent.',
      instructions: 'Keep partial runtime permissions.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'accent',
      avatar: null,
      deniedToolPatterns: [],
      mode: 'subagent',
      model: null,
      variant: null,
      temperature: null,
      top_p: null,
      steps: null,
      options: null,
      permissionOverrides: [{ key: 'web', action: 'allow' }],
      writeAccess: false,
      valid: true,
      issues: [],
    }
    const { update } = renderBuilder({
      target: { kind: 'custom', agent },
    })

    await user.click(screen.getByRole('button', { name: 'Permissions' }))
    const taskGroup = screen.getByRole('group', { name: 'Delegate work permission' })
    await user.click(within(taskGroup).getByRole('radio', { name: 'Allow' }))
    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[0]!)

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[1].permissionOverrides).toEqual([
      { key: 'web', action: 'allow' },
      { key: 'task', action: 'allow' },
    ])
  })

  it('persists an empty override array when clearing the last saved permission override', async () => {
    const user = userEvent.setup()
    const agent: CustomAgentSummary = {
      scope: 'machine',
      directory: null,
      name: 'partial-agent',
      description: 'Partial custom agent.',
      instructions: 'Clear saved runtime permissions.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'accent',
      avatar: null,
      deniedToolPatterns: [],
      mode: 'subagent',
      model: null,
      variant: null,
      temperature: null,
      top_p: null,
      steps: null,
      options: null,
      permissionOverrides: [{ key: 'web', action: 'allow' }],
      writeAccess: false,
      valid: true,
      issues: [],
    }
    const { update } = renderBuilder({
      target: { kind: 'custom', agent },
    })

    await user.click(screen.getByRole('button', { name: 'Permissions' }))
    const webGroup = screen.getByRole('group', { name: 'Web access permission' })
    await user.click(within(webGroup).getByRole('button', { name: 'Use inherited access' }))
    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[0]!)

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[1].permissionOverrides).toEqual([])
  })

  it('uses refreshed model metadata in the summary capability profile', async () => {
    const user = userEvent.setup()
    const refreshProviderCatalog = vi.fn(async () => [{
      id: 'mercury/ultra',
      name: 'Mercury Ultra',
      featured: true,
      limit: { context: 1_000_000 },
    }])
    renderBuilder({
      appConfig: {
        ...baseAppConfig,
        providers: {
          defaultProvider: 'openrouter',
          defaultModel: null,
          available: [{
            id: 'openrouter',
            name: 'OpenRouter',
            description: 'Aggregated model catalog.',
            credentials: [],
            connected: true,
            models: [],
          }],
        },
      },
    })
    window.coworkApi.app.refreshProviderCatalog = refreshProviderCatalog

    await user.click(screen.getByRole('button', { name: 'Brain' }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(refreshProviderCatalog).toHaveBeenCalledWith('openrouter'))

    await pickFromSelect(user, 'Model', /Mercury Ultra/)

    expect(screen.getByText('Mercury Ultra')).toBeInTheDocument()
    expect(screen.getAllByText('1M ctx').length).toBeGreaterThanOrEqual(1)
  })

  it('edits lead/specialist mode and specific permission rules', async () => {
    const user = userEvent.setup()
    const { create } = renderBuilder()

    await user.click(screen.getByRole('button', { name: /Writer/ }))
    await user.type(screen.getByPlaceholderText('agent-id'), 'writer-lead')
    await user.type(
      screen.getByPlaceholderText('What is this coworker specialised to do?'),
      'Drafts stakeholder updates.',
    )
    const saveAndTestButton = screen.getByRole('button', { name: 'Save & Test' })
    expect(saveAndTestButton).toBeDisabled()
    expect(saveAndTestButton).toHaveAttribute(
      'title',
      'Lead coworkers start chats directly and cannot be tested through an @mention.',
    )

    await user.click(screen.getByRole('button', { name: 'Brain' }))
    expect(screen.getByText('Lead conversations')).toBeInTheDocument()
    expect(screen.getByText('Specialist coworker')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.getByText('allow · read')).toBeInTheDocument()
    expect(screen.getByText('webfetch + websearch')).toBeInTheDocument()
    expect(screen.getByText('edit + write + apply_patch')).toBeInTheDocument()

    const webGroup = screen.getByRole('group', { name: 'Web access permission' })
    expect(within(webGroup).queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument()
    expect(within(webGroup).getByText(/URL and domain-specific web rules are not saved/)).toBeInTheDocument()

    const bashGroup = screen.getByRole('group', { name: 'Run commands permission' })
    await user.click(within(bashGroup).getByRole('radio', { name: 'Deny' }))
    await user.click(within(bashGroup).getByRole('button', { name: 'Add rule' }))
    await user.type(within(bashGroup).getByPlaceholderText('git *, pnpm test, rm *'), 'pnpm test')
    await pickFromSelect(user, 'Run commands rule action', 'allow', within(bashGroup))

    await user.click(screen.getAllByRole('button', { name: 'Hire coworker' })[0]!)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'writer-lead',
      mode: 'primary',
      permissionOverrides: expect.arrayContaining([
        expect.objectContaining({
          key: 'bash',
          action: 'deny',
          rules: [expect.objectContaining({ pattern: 'pnpm test', action: 'allow' })],
        }),
      ]),
    }))
  }, 15_000)

  it('starts first-time specific permission rules from a denied wildcard', async () => {
    const user = userEvent.setup()
    const { create } = renderBuilder()

    await user.click(screen.getByRole('button', { name: /Writer/ }))
    await user.type(screen.getByPlaceholderText('agent-id'), 'rule-limited-writer')
    await user.type(
      screen.getByPlaceholderText('What is this coworker specialised to do?'),
      'Runs only the approved command.',
    )

    await user.click(screen.getByRole('button', { name: 'Permissions' }))
    const bashGroup = screen.getByRole('group', { name: 'Run commands permission' })
    await user.click(within(bashGroup).getByRole('button', { name: 'Add rule' }))
    await user.type(within(bashGroup).getByPlaceholderText('git *, pnpm test, rm *'), 'pnpm test')
    await pickFromSelect(user, 'Run commands rule action', 'allow', within(bashGroup))

    await user.click(screen.getAllByRole('button', { name: 'Hire coworker' })[0]!)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      permissionOverrides: expect.arrayContaining([
        expect.objectContaining({
          key: 'bash',
          action: 'deny',
          rules: [expect.objectContaining({ pattern: 'pnpm test', action: 'allow' })],
        }),
      ]),
    }))
  })

  it('blocks saving blank specific permission rule patterns', async () => {
    const user = userEvent.setup()
    const { create } = renderBuilder()

    await user.click(screen.getByRole('button', { name: /Writer/ }))
    await user.type(screen.getByPlaceholderText('agent-id'), 'blank-rule-writer')
    await user.type(
      screen.getByPlaceholderText('What is this coworker specialised to do?'),
      'Tests permission validation.',
    )

    await user.click(screen.getByRole('button', { name: 'Permissions' }))
    const bashGroup = screen.getByRole('group', { name: 'Run commands permission' })
    await user.click(within(bashGroup).getByRole('button', { name: 'Add rule' }))

    expect(screen.getAllByText('Run commands permission rule pattern is required.').length).toBeGreaterThanOrEqual(1)
    for (const button of screen.getAllByRole('button', { name: 'Hire coworker' })) {
      expect(button).toBeDisabled()
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('blocks saving invalid MCP permission rule patterns', async () => {
    const user = userEvent.setup()
    const { create } = renderBuilder()

    await user.click(screen.getByRole('button', { name: /Writer/ }))
    await user.type(screen.getByPlaceholderText('agent-id'), 'invalid-mcp-rule-writer')
    await user.type(
      screen.getByPlaceholderText('What is this coworker specialised to do?'),
      'Tests MCP permission validation.',
    )

    await user.click(screen.getByRole('button', { name: 'Permissions' }))
    const mcpGroup = screen.getByRole('group', { name: 'MCP tools permission' })
    await user.click(within(mcpGroup).getByRole('button', { name: 'Add rule' }))
    await user.type(
      within(mcpGroup).getByPlaceholderText('mcp__github__pull_request_read'),
      'bash',
    )

    expect(
      screen.getAllByText('MCP tools permission rule pattern must be an MCP tool pattern like mcp__server__tool or server_tool.').length,
    ).toBeGreaterThanOrEqual(1)
    for (const button of screen.getAllByRole('button', { name: 'Hire coworker' })) {
      expect(button).toBeDisabled()
    }
    expect(create).not.toHaveBeenCalled()
  })
})
