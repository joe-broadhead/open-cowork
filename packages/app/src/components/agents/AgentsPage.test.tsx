import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentCatalog,
  BuiltInAgentDetail,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { AgentsPage } from './AgentsPage'

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

const customAgent: CustomAgentSummary = {
  scope: 'machine',
  directory: null,
  name: 'market-analyst',
  description: 'Prepares market analysis briefings.',
  instructions: 'Summarize market changes.',
  skillNames: ['research-kit'],
  toolIds: ['chart-maker'],
  enabled: true,
  color: 'accent',
  avatar: null,
  model: null,
  variant: null,
  temperature: null,
  top_p: null,
  steps: null,
  options: null,
  deniedToolPatterns: [],
  writeAccess: true,
  valid: true,
  issues: [],
}

const builtInAgent: BuiltInAgentDetail = {
  name: 'workflow-designer',
  label: 'Workflow Designer',
  source: 'open-cowork',
  mode: 'subagent',
  hidden: false,
  disabled: false,
  color: 'success',
  description: 'Turns setup threads into workflows.',
  instructions: 'Design workflows carefully.',
  skills: ['research-kit'],
  toolAccess: ['chart-maker'],
  nativeToolIds: [],
  configuredToolIds: ['chart-maker'],
  model: null,
  variant: null,
  temperature: null,
  top_p: null,
  steps: null,
  options: null,
}

const openCodeAgent: BuiltInAgentDetail = {
  name: 'build',
  label: 'Build',
  source: 'opencode',
  mode: 'primary',
  hidden: false,
  disabled: false,
  color: 'primary',
  description: 'Implements scoped changes.',
  instructions: 'Build carefully.',
  skills: [],
  toolAccess: ['read', 'write'],
  nativeToolIds: ['read', 'write'],
  configuredToolIds: [],
  model: null,
  variant: null,
  temperature: null,
  top_p: null,
  steps: null,
  options: null,
}

const runtimeAgent: RuntimeAgentDescriptor = {
  name: 'plugin-helper',
  description: 'Registered by an SDK plugin.',
  model: null,
  color: 'info',
  disabled: false,
  toolIds: ['websearch'],
  toolCount: 1,
  writeAccess: false,
  steps: 20,
}

function renderAgentsPage(overrides: {
  customAgents?: CustomAgentSummary[]
  builtInAgents?: BuiltInAgentDetail[]
  runtimeAgents?: RuntimeAgentDescriptor[]
} = {}) {
  const list = vi.fn(async () => overrides.customAgents ?? [customAgent])
  const listCatalog = vi.fn(async () => catalog)
  const runtime = vi.fn(async () => overrides.runtimeAgents ?? [runtimeAgent])
  const builtinAgents = vi.fn(async () => overrides.builtInAgents ?? [builtInAgent, openCodeAgent])
  const unsubscribeRuntimeReady = vi.fn()
  const runtimeReady = vi.fn(() => unsubscribeRuntimeReady)

  installRendererTestCoworkApi({
    agents: {
      list,
      catalog: listCatalog,
      runtime,
      create: vi.fn(async () => true),
      update: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    },
    app: {
      builtinAgents,
    },
    dialog: {
      openJson: vi.fn(async () => null),
      saveText: vi.fn(async () => null),
    },
    on: {
      runtimeReady,
    },
  })

  const props = {
    onClose: vi.fn(),
    onOpenCapabilities: vi.fn(),
    onTestAgent: vi.fn(),
    onStartAgentChat: vi.fn(),
    onClearDraft: vi.fn(),
  }
  const view = render(<AgentsPage {...props} />)

  return {
    list,
    listCatalog,
    runtime,
    builtinAgents,
    runtimeReady,
    unsubscribeRuntimeReady,
    unmount: view.unmount,
    ...props,
  }
}

describe('AgentsPage', () => {
  it('loads custom, built-in, and runtime agents, then opens a custom agent in the builder', async () => {
    const user = userEvent.setup()
    const api = renderAgentsPage()

    expect(await screen.findByRole('heading', { name: 'Coworkers' })).toBeInTheDocument()
    expect(screen.getByText('market-analyst')).toBeInTheDocument()
    expect(screen.getByText('Workflow Designer')).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('plugin-helper')).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith(undefined)
    expect(api.listCatalog).toHaveBeenCalledWith(undefined)
    expect(api.builtinAgents).toHaveBeenCalledTimes(1)
    expect(api.runtimeReady).toHaveBeenCalledTimes(1)

    await user.type(screen.getByPlaceholderText('Search coworkers, skills, tools, or instructions...'), 'chart')
    expect(screen.getByText('market-analyst')).toBeInTheDocument()
    expect(screen.queryByText('plugin-helper')).not.toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Search coworkers, skills, tools, or instructions...'))
    await user.click(screen.getByRole('tab', { name: 'Built-in' }))
    expect(screen.getByText('Workflow Designer')).toBeInTheDocument()
    expect(screen.queryByText('Build')).not.toBeInTheDocument()
    expect(screen.queryByText('market-analyst')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'OpenCode' }))
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.queryByText('Workflow Designer')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'All' }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('market-analyst')).toBeInTheDocument()
  })

  it('opens the builder with starter choices before creating a new agent and cleans up runtime listeners', async () => {
    const user = userEvent.setup()
    const api = renderAgentsPage()

    await screen.findByText('market-analyst')
    await user.click(screen.getByRole('button', { name: 'New coworker' }))
    expect(screen.getByRole('heading', { name: 'Start a new coworker' })).toBeInTheDocument()
    expect(api.onClearDraft).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Start from blank/ }))
    expect(await screen.findByRole('button', { name: 'Hire coworker' })).toBeDisabled()

    api.unmount()
    expect(api.unsubscribeRuntimeReady).toHaveBeenCalledTimes(1)
  })

  it('routes enabled custom agents into the saved-agent test flow', async () => {
    const user = userEvent.setup()
    const api = renderAgentsPage()

    await screen.findByText('market-analyst')
    await user.click(screen.getAllByRole('button', { name: 'Test' })[0]!)

    expect(api.onTestAgent).toHaveBeenCalledWith('market-analyst', null)
  })

  it('tests project-scoped custom agents in their project runtime context', async () => {
    const user = userEvent.setup()
    const api = renderAgentsPage({
      customAgents: [{
        ...customAgent,
        scope: 'project',
        directory: '/workspace/acme',
      }],
    })

    await screen.findByText('market-analyst')
    await user.click(screen.getAllByRole('button', { name: 'Test' })[0]!)

    expect(api.onTestAgent).toHaveBeenCalledWith('market-analyst', '/workspace/acme')
  })

  it('starts primary custom agents as lead coworker chats instead of delegated tests', async () => {
    const user = userEvent.setup()
    const api = renderAgentsPage({
      customAgents: [{
        ...customAgent,
        mode: 'primary',
      }],
      builtInAgents: [],
      runtimeAgents: [],
    })

    expect(await screen.findByText('market-analyst')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start chat' }))
    expect(api.onStartAgentChat).toHaveBeenCalledWith('market-analyst', null)
    expect(api.onTestAgent).not.toHaveBeenCalled()
  })

  it('shows permission override write access in custom coworker scope chips', async () => {
    renderAgentsPage({
      customAgents: [{
        ...customAgent,
        name: 'override-writer',
        skillNames: [],
        toolIds: [],
        permissionOverrides: [{ key: 'bash', action: 'allow' }],
        writeAccess: true,
      }],
      builtInAgents: [],
      runtimeAgents: [],
    })

    expect(await screen.findByText('override-writer')).toBeInTheDocument()
    expect(screen.getByText('Standard')).toBeInTheDocument()
  })

  it('keeps large inventories in the normal card sections', async () => {
    const manyAgents = Array.from({ length: 24 }, (_, index) => ({
      ...customAgent,
      name: `agent-${index + 1}`,
      description: `Agent ${index + 1}`,
    }))

    renderAgentsPage({
      customAgents: manyAgents,
      builtInAgents: [],
      runtimeAgents: [],
    })

    expect(await screen.findByText('Custom coworkers')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('agent-1')).toBeInTheDocument()
  })
})
