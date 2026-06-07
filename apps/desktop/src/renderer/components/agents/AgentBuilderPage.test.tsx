import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { AgentCatalog, BuiltInAgentDetail, CustomAgentConfig, PublicAppConfig } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { AgentBuilderPage } from './AgentBuilderPage'

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
  permissions: { bash: 'allow', fileWrite: 'allow' },
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
  it('creates a project-scoped custom agent from the builder form and workbench tabs', async () => {
    const user = userEvent.setup()
    const { create, onSaved } = renderBuilder()

    expect(screen.getByRole('button', { name: 'Create coworker' })).toBeDisabled()
    expect(screen.getByText('Complete these before saving')).toBeInTheDocument()
    expect(screen.getByText('Selected capabilities')).toBeInTheDocument()
    expect(screen.queryByText(/loadout/i)).not.toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('agent-id'), 'market-analyst')
    await user.type(
      screen.getByPlaceholderText('What is this agent specialised to do?'),
      'Prepares market analysis briefings.',
    )
    await user.click(screen.getByRole('button', { name: 'Capabilities' }))
    await user.click(screen.getAllByRole('button', { name: /Research Kit/ })[0]!)
    await user.click(screen.getByRole('button', { name: 'Add tools' }))

    await user.click(screen.getByRole('button', { name: 'Instructions' }))
    await user.type(
      screen.getByPlaceholderText(/Examples:/),
      'Summarize market changes with concise evidence.',
    )

    await user.click(screen.getByRole('button', { name: 'Project' }))
    await user.click(screen.getByRole('button', { name: 'Create coworker' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'market-analyst',
      description: 'Prepares market analysis briefings.',
      instructions: 'Summarize market changes with concise evidence.',
      skillNames: ['research-kit'],
      toolIds: ['chart-maker'],
      scope: 'project',
      directory: '/workspace/acme',
    }))
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

    await user.click(screen.getByRole('button', { name: 'Model & behavior' }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(refreshProviderCatalog).toHaveBeenCalledWith('openrouter'))

    await user.selectOptions(screen.getByLabelText('Model'), 'mercury/ultra')

    expect(screen.getByText('Mercury Ultra')).toBeInTheDocument()
    expect(screen.getAllByText('1M ctx').length).toBeGreaterThanOrEqual(1)
  })
})
