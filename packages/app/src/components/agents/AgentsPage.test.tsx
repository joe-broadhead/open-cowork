import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  workspaceApiSupportContextForAuthority,
  type WorkspaceApiSupport,
  type AgentCatalog,
  type BuiltInAgentDetail,
  type CustomAgentSummary,
  type RuntimeAgentDescriptor,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { useWorkspaceSupportStore } from '../../stores/workspace-support'
import { AgentsPage } from './AgentsPage'

const featureValueTelemetry = vi.hoisted(() => ({
  recordFeatureValueActivation: vi.fn(),
  recordFeatureValueDiscovery: vi.fn(),
}))

vi.mock('../../helpers/feature-value-telemetry', () => featureValueTelemetry)

const localSupport = useWorkspaceSupportStore.getState().supportByWorkspace[LOCAL_WORKSPACE_ID] || []

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function renderAgentsPage(overrides: {
  customAgents?: CustomAgentSummary[]
  builtInAgents?: BuiltInAgentDetail[]
  runtimeAgents?: RuntimeAgentDescriptor[]
  customAgentsError?: Error
  catalogError?: Error
} = {}) {
  const list = vi.fn(async () => {
    if (overrides.customAgentsError) throw overrides.customAgentsError
    return overrides.customAgents ?? [customAgent]
  })
  const listCatalog = vi.fn(async () => {
    if (overrides.catalogError) throw overrides.catalogError
    return catalog
  })
  const runtime = vi.fn(async () => overrides.runtimeAgents ?? [runtimeAgent])
  const builtinAgents = vi.fn(async () => overrides.builtInAgents ?? [builtInAgent, openCodeAgent])
  const create = vi.fn(async () => true)
  const update = vi.fn(async () => true)
  const remove = vi.fn(async () => true)
  const unsubscribeRuntimeReady = vi.fn()
  let runtimeReadyHandler: (() => void) | null = null
  const runtimeReady = vi.fn((handler: () => void) => {
    runtimeReadyHandler = handler
    return unsubscribeRuntimeReady
  })

  installRendererTestCoworkApi({
    agents: {
      list,
      catalog: listCatalog,
      runtime,
      create,
      update,
      remove,
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
    create,
    update,
    remove,
    builtinAgents,
    runtimeReady,
    unsubscribeRuntimeReady,
    triggerRuntimeReady: () => runtimeReadyHandler?.(),
    unmount: view.unmount,
    ...props,
  }
}

describe('AgentsPage', () => {
  beforeEach(() => {
    featureValueTelemetry.recordFeatureValueActivation.mockClear()
    featureValueTelemetry.recordFeatureValueDiscovery.mockClear()
    useSessionStore.setState({ activeWorkspaceId: LOCAL_WORKSPACE_ID })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { [LOCAL_WORKSPACE_ID]: localSupport },
      loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
  })

  it('discovers custom Team authoring when the Local create affordance is available', async () => {
    renderAgentsPage()

    expect(await screen.findByRole('button', { name: 'New coworker' })).toBeEnabled()
    await waitFor(() => expect(featureValueTelemetry.recordFeatureValueDiscovery).toHaveBeenCalledWith('custom-team'))
    expect(featureValueTelemetry.recordFeatureValueDiscovery).toHaveBeenCalledTimes(1)
  })

  it('does not discover custom Team authoring in a Cloud workspace', async () => {
    const workspaceId = 'cloud:test'
    const support: WorkspaceApiSupport[] = [{
      api: 'machineRuntimeConfig',
      status: 'supported',
      verdict: { allowed: true, reason: null },
      context: workspaceApiSupportContextForAuthority('cloud_worker', {
        surface: 'desktop_cloud',
        onlineState: 'online',
        status: 'supported',
      }),
    }]
    useSessionStore.setState({ activeWorkspaceId: workspaceId })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { [LOCAL_WORKSPACE_ID]: localSupport, [workspaceId]: support },
      loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true, [workspaceId]: true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })

    const api = renderAgentsPage()

    expect(await screen.findByRole('button', { name: 'New coworker' })).toBeDisabled()
    expect(api.list).toHaveBeenCalledWith({ directory: undefined, workspaceId })
    expect(api.listCatalog).toHaveBeenCalledWith({ directory: undefined, workspaceId })
    expect(featureValueTelemetry.recordFeatureValueDiscovery).not.toHaveBeenCalledWith('custom-team')
  })

  it('keeps a Cloud coworker roster read-only without touching Local runtime or mutation paths', async () => {
    const user = userEvent.setup()
    const workspaceId = 'cloud:read-only-roster'
    const support: WorkspaceApiSupport[] = [{
      api: 'machineRuntimeConfig',
      status: 'supported',
      verdict: { allowed: true, reason: null },
      context: workspaceApiSupportContextForAuthority('cloud_worker', {
        surface: 'desktop_cloud',
        onlineState: 'online',
        status: 'supported',
      }),
    }]
    useSessionStore.setState({ activeWorkspaceId: workspaceId })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { [LOCAL_WORKSPACE_ID]: localSupport, [workspaceId]: support },
      loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true, [workspaceId]: true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })

    const api = renderAgentsPage()

    const customName = await screen.findByText('market-analyst')
    const customCard = customName.closest('.group')
    expect(customCard).not.toBeNull()
    expect(api.runtime).not.toHaveBeenCalled()
    expect(within(customCard as HTMLElement).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(within(customCard as HTMLElement).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(within(customCard as HTMLElement).queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
    expect(within(customCard as HTMLElement).queryByRole('button', { name: 'Start chat' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
    expect(screen.queryByText('Integration-provided coworkers')).not.toBeInTheDocument()

    await user.click(customName)
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(api.create).not.toHaveBeenCalled()
    expect(api.update).not.toHaveBeenCalled()
    expect(api.remove).not.toHaveBeenCalled()
    expect(api.onTestAgent).not.toHaveBeenCalled()
    expect(api.onStartAgentChat).not.toHaveBeenCalled()
  })

  it('does not discover custom Team authoring in a read-only Paired workspace', async () => {
    const workspaceId = 'paired-desktop:test'
    const readOnlySupport: WorkspaceApiSupport[] = [{
      api: 'machineRuntimeConfig',
      status: 'read_only',
      verdict: { allowed: true, reason: 'Paired machine config is readable but not editable here.' },
      context: workspaceApiSupportContextForAuthority('desktop_paired', {
        surface: 'desktop_paired',
        onlineState: 'online',
        status: 'read_only',
      }),
    }]
    useSessionStore.setState({ activeWorkspaceId: workspaceId })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { [LOCAL_WORKSPACE_ID]: localSupport, [workspaceId]: readOnlySupport },
      loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true, [workspaceId]: true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })

    renderAgentsPage()

    expect(await screen.findByRole('button', { name: 'New coworker' })).toBeDisabled()
    expect(featureValueTelemetry.recordFeatureValueDiscovery).not.toHaveBeenCalledWith('custom-team')
  })

  it('clears the roster and ignores a superseded refresh when the workspace changes', async () => {
    const stale = deferred<CustomAgentSummary[]>()
    const currentAgent = { ...customAgent, name: 'current-workspace-agent' }
    const api = renderAgentsPage()
    expect(await screen.findByText('market-analyst')).toBeInTheDocument()

    api.list.mockReturnValueOnce(stale.promise)
    act(() => api.triggerRuntimeReady())

    api.list.mockResolvedValueOnce([currentAgent])
    act(() => {
      useSessionStore.setState({
        activeWorkspaceId: 'cloud:second',
        currentSessionId: null,
        sessions: [],
      })
    })

    expect(screen.queryByText('market-analyst')).not.toBeInTheDocument()
    expect(await screen.findByText('current-workspace-agent')).toBeInTheDocument()

    await act(async () => {
      stale.resolve([{ ...customAgent, name: 'stale-first-workspace-agent' }])
      await stale.promise
    })
    expect(screen.queryByText('stale-first-workspace-agent')).not.toBeInTheDocument()
    expect(screen.getByText('current-workspace-agent')).toBeInTheDocument()
  })

  it('loads custom, built-in, and runtime agents, then opens a custom agent in the builder', async () => {
    const user = userEvent.setup()
    const api = renderAgentsPage()

    expect(await screen.findByRole('heading', { name: 'Coworkers' })).toBeInTheDocument()
    expect(await screen.findByText('market-analyst')).toBeInTheDocument()
    expect(screen.getByText('Workflow Designer')).toBeInTheDocument()
    expect(screen.queryByText('Top-level')).not.toBeInTheDocument()
    expect(screen.queryByText('Sub-agent')).not.toBeInTheDocument()
    expect(screen.queryByText('Internal')).not.toBeInTheDocument()
    expect(screen.getByText('Build')).not.toBeVisible()
    expect(screen.getByText('plugin-helper')).not.toBeVisible()
    expect(screen.getByText('Build a coworker roster with clear roles, skills, tools, and chat assignments.')).toBeVisible()
    expect(screen.queryByText(/Compose OpenCode agents/i)).not.toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['All', 'Custom', 'Built-in'])
    expect(api.list).toHaveBeenCalledWith(undefined)
    expect(api.listCatalog).toHaveBeenCalledWith(undefined)
    expect(api.builtinAgents).toHaveBeenCalledTimes(1)
    expect(api.runtimeReady).toHaveBeenCalledTimes(1)

    await user.click(screen.getByText('Advanced coworker details'))
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('plugin-helper')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Search coworkers, skills, tools, or instructions...'), 'chart')
    expect(screen.getByText('market-analyst')).toBeInTheDocument()
    expect(screen.queryByText('plugin-helper')).not.toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Search coworkers, skills, tools, or instructions...'))
    await user.click(screen.getByRole('radio', { name: 'Built-in' }))
    expect(screen.getByText('Workflow Designer')).toBeInTheDocument()
    expect(screen.queryByText('market-analyst')).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'All' }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('market-analyst')).toBeInTheDocument()
  })

  it('applies Custom and Built-in filters to every coworker source and reports complete counts', async () => {
    const user = userEvent.setup()
    renderAgentsPage()

    expect(await screen.findByText('4 coworkers match')).toBeInTheDocument()
    expect(screen.getByText('1 custom')).toBeInTheDocument()
    expect(screen.getByText('1 built-in')).toBeInTheDocument()
    expect(screen.getByText('2 advanced')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Custom' }))
    expect(screen.getByText('1 coworker matches')).toBeInTheDocument()
    expect(screen.getByText('market-analyst')).toBeInTheDocument()
    expect(screen.queryByText('Advanced coworker details')).not.toBeInTheDocument()
    expect(screen.queryByText('Build')).not.toBeInTheDocument()
    expect(screen.queryByText('plugin-helper')).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Built-in' }))
    expect(screen.getByText('3 coworkers match')).toBeInTheDocument()
    expect(screen.getByText('1 built-in')).toBeInTheDocument()
    expect(screen.getByText('2 advanced')).toBeInTheDocument()
    expect(screen.queryByText('market-analyst')).not.toBeInTheDocument()
    await user.click(screen.getByText('Advanced coworker details'))
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('plugin-helper')).toBeInTheDocument()
  })

  it('shows a recoverable error instead of empty coworker sections when loading fails', async () => {
    renderAgentsPage({ catalogError: new Error('catalog unavailable') })

    expect(await screen.findByText('Couldn’t load coworkers')).toBeInTheDocument()
    expect(screen.getByText('catalog unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No custom coworkers yet. Create one to package a repeatable role, instructions, skills, and tools.')).not.toBeInTheDocument()
  })

  it('keeps stale coworkers visible when a runtime refresh fails', async () => {
    const api = renderAgentsPage()

    expect(await screen.findByText('market-analyst')).toBeInTheDocument()
    api.list.mockRejectedValueOnce(new Error('refresh unavailable'))
    api.triggerRuntimeReady()

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t refresh coworkers.')
    expect(screen.getByText('market-analyst')).toBeInTheDocument()
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
    const card = screen.getByText('market-analyst').closest('.group')
    expect(card).not.toBeNull()
    await user.click(within(card as HTMLElement).getByRole('button', { name: 'Test' }))

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
    const card = screen.getByText('market-analyst').closest('.group')
    expect(card).not.toBeNull()
    await user.click(within(card as HTMLElement).getByRole('button', { name: 'Test' }))

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
    expect(screen.getByText('Editing: Editable')).toBeInTheDocument()
    expect(screen.getByText('Tool access: Standard')).toBeInTheDocument()
  })

  it('keeps empty custom guidance compact, reports filtered counts, and lists useful built-ins first', async () => {
    const user = userEvent.setup()
    renderAgentsPage({ customAgents: [], runtimeAgents: [] })

    const builtIn = await screen.findByText('Workflow Designer')
    const empty = screen.getByText(/No custom coworkers yet/)
    expect(builtIn.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('2 coworkers match')).toBeInTheDocument()
    expect(empty.closest('[role="status"]')).not.toBeNull()

    await user.type(screen.getByPlaceholderText('Search coworkers, skills, tools, or instructions...'), 'no-such-coworker')
    expect(screen.getByText('0 coworkers match')).toBeInTheDocument()
    expect(screen.getByText('No built-in coworkers matched your search.')).toBeInTheDocument()
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
