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
  name: 'build',
  label: 'Build',
  source: 'open-cowork',
  mode: 'primary',
  hidden: false,
  disabled: false,
  color: 'success',
  description: 'Implements scoped changes.',
  instructions: 'Build carefully.',
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

const runtimeAgent: RuntimeAgentDescriptor = {
  name: 'plugin-helper',
  description: 'Registered by an SDK plugin.',
  model: null,
  color: 'info',
  disabled: false,
}

function renderAgentsPage(overrides: {
  customAgents?: CustomAgentSummary[]
  builtInAgents?: BuiltInAgentDetail[]
  runtimeAgents?: RuntimeAgentDescriptor[]
} = {}) {
  const list = vi.fn(async () => overrides.customAgents ?? [customAgent])
  const listCatalog = vi.fn(async () => catalog)
  const runtime = vi.fn(async () => overrides.runtimeAgents ?? [runtimeAgent])
  const builtinAgents = vi.fn(async () => overrides.builtInAgents ?? [builtInAgent])
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

    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeInTheDocument()
    expect(screen.getByText('market-analyst')).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('plugin-helper')).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith(undefined)
    expect(api.listCatalog).toHaveBeenCalledWith(undefined)
    expect(api.builtinAgents).toHaveBeenCalledTimes(1)
    expect(api.runtimeReady).toHaveBeenCalledTimes(1)

    await user.type(screen.getByPlaceholderText('Search agents, skills, tools, or instructions…'), 'chart')
    expect(screen.getByText('market-analyst')).toBeInTheDocument()
    expect(screen.queryByText('plugin-helper')).not.toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Search agents, skills, tools, or instructions…'))
    await user.click(screen.getByRole('button', { name: 'Built-in' }))
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.queryByText('market-analyst')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'all' }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('market-analyst')).toBeInTheDocument()
  })

  it('opens the starter picker before creating a new agent and cleans up runtime listeners', async () => {
    const user = userEvent.setup()
    const api = renderAgentsPage()

    await screen.findByText('market-analyst')
    await user.click(screen.getByRole('button', { name: 'New agent' }))
    expect(screen.getByRole('heading', { name: 'Start a new agent' })).toBeInTheDocument()
    expect(api.onClearDraft).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Start from blank/ }))
    expect(await screen.findByRole('button', { name: 'Create agent' })).toBeDisabled()

    api.unmount()
    expect(api.unsubscribeRuntimeReady).toHaveBeenCalledTimes(1)
  })
})
