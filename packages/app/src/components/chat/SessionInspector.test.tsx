import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionArtifact, SessionView, TaskRun, ToolCall } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { sessionWorkspaceKey } from '../../stores/session-workspace-keys'
import { unavailableWorkspaceSupport, useWorkspaceSupportStore } from '../../stores/workspace-support'
import { installRendererTestCoworkApi } from '../../test/setup'
import { COMPOSER_COMPOSE_EVENT } from './composer-events'
import { SessionInspector } from './SessionInspector'

vi.mock('./TodoListView', () => ({
  TodoListView: ({ todos }: { todos: Array<{ content: string }> }) => (
    <ul data-testid="todo-list">
      {todos.map((todo) => <li key={todo.content}>{todo.content}</li>)}
    </ul>
  ),
}))

const emptyTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function createTaskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'task-1',
    title: 'Review findings',
    agent: 'reviewer',
    status: 'complete',
    sourceSessionId: 'child-session',
    parentSessionId: null,
    content: '',
    transcript: [],
    toolCalls: [],
    compactions: [],
    todos: [],
    error: null,
    sessionCost: 0,
    sessionTokens: emptyTokens,
    order: 1,
    ...overrides,
  }
}

function createToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'write',
    input: {},
    status: 'complete',
    order: 1,
    ...overrides,
  }
}

function createView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        content: 'Please review the release.',
        providerId: null,
        modelId: null,
        timestamp: '2026-05-07T02:00:00.000Z',
        order: 1,
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: 'Release notes look good.',
        providerId: 'openai',
        modelId: 'gpt-4.1',
        timestamp: '2026-05-07T02:01:00.000Z',
        order: 2,
      },
    ],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0.0432,
    sessionTokens: {
      input: 9000,
      output: 300,
      reasoning: 120,
      cacheRead: 200,
      cacheWrite: 50,
    },
    lastInputTokens: 9000,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 1,
    lastEventAt: Date.now(),
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
    ...overrides,
  }
}

function resetStore(options: {
  view?: SessionView
  directory?: string | null
  artifacts?: SessionArtifact[]
} = {}) {
  useSessionStore.setState({
    activeWorkspaceId: 'local',
    sessions: [
      {
        id: 'session-1',
        title: 'Release thread',
        directory: options.directory ?? null,
        createdAt: '2026-05-07T01:00:00.000Z',
        updatedAt: '2026-05-07T02:05:00.000Z',
      },
    ],
    currentSessionId: 'session-1',
    currentView: options.view ?? createView(),
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {
      'session-1': options.artifacts ?? [],
    },
  })
}

function installInspectorApi() {
  return installRendererTestCoworkApi({
    artifact: {
      readAttachment: vi.fn(async () => ({
        filename: 'chart.png',
        mime: 'image/png',
        url: 'data:image/png;base64,abc',
        chart: {
          format: 'vega-lite',
          spec: { mark: 'bar' },
          title: 'Revenue',
        },
      })),
      reveal: vi.fn(async () => true),
      open: vi.fn(async () => '/tmp/chart.png'),
      export: vi.fn(async () => '/tmp/chart.png'),
    },
    model: {
      info: vi.fn(async () => ({
        pricing: {},
        contextLimits: {
          'openai/gpt-4.1': 10000,
        },
      })),
    },
    session: {
      summarize: vi.fn(async () => ({ ok: true })),
    },
    settings: {
      get: vi.fn(async () => ({
        selectedProviderId: 'openai',
        selectedModelId: 'gpt-4.1',
        providerCredentials: {},
        integrationCredentials: {},
        integrationEnabled: {},
        bashPermission: 'deny',
        fileWritePermission: 'deny',
        runtimeToolingBridgeEnabled: true,
        workflowLaunchAtLogin: false,
        workflowRunInBackground: false,
        workflowDesktopNotifications: true,
        workflowQuietHoursStart: null,
        workflowQuietHoursEnd: null,
        effectiveProviderId: 'openai',
        effectiveModel: 'gpt-4.1',
      })),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
  useWorkspaceSupportStore.setState({
    supportByWorkspace: {},
    loadedByWorkspace: {},
    loadingByWorkspace: {},
    errorByWorkspace: {},
  })
  installInspectorApi()
})

describe('SessionInspector', () => {
  it('renders context stats and requests SDK-backed summarization', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const api = installInspectorApi()

    render(<SessionInspector onClose={onClose} />)

    expect(screen.getByRole('button', { name: 'Context' })).toBeInTheDocument()
    expect(screen.getByText('Session')).toBeInTheDocument()
    await screen.findByText('90% of 10.0K')
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    expect(screen.getAllByText('gpt-4.1')[0]).toBeInTheDocument()
    expect(screen.getByText('9,420')).toBeInTheDocument()
    expect(screen.getByText('$0.04')).toBeInTheDocument()
    expect(screen.getByText('Context is close to the auto-compaction threshold — you can pre-empt it now.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Summarize now' }))
    await waitFor(() => expect(api.session.summarize).toHaveBeenCalledWith('session-1'))
    expect(screen.getByRole('button', { name: 'Compaction requested' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows raw messages and expands individual message content', async () => {
    const user = userEvent.setup()

    render(<SessionInspector onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Messages' }))
    expect(screen.getByText('Raw Messages')).toBeInTheDocument()
    await user.click(screen.getByText('msg-assistant'))

    expect(screen.getByText('Release notes look good.')).toBeInTheDocument()
    expect(screen.getAllByText('Hide')).toHaveLength(2)
  })

  it('renders execution, session, and sub-agent todos with empty-state fallback avoided', async () => {
    const user = userEvent.setup()
    resetStore({
      view: createView({
        executionPlan: [
          { id: 'plan-1', content: 'Draft release checklist', status: 'in_progress', priority: 'high' },
        ],
        todos: [
          { id: 'todo-1', content: 'Update changelog', status: 'pending', priority: 'medium' },
        ],
        taskRuns: [
          createTaskRun({
            title: 'Security Review',
            todos: [
              { id: 'task-todo-1', content: 'Check IPC boundaries', status: 'completed', priority: 'high' },
            ],
          }),
        ],
      }),
    })
    installInspectorApi()

    render(<SessionInspector onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Todos' }))
    expect(screen.getByText('Coworker plan')).toBeInTheDocument()
    expect(screen.getByText('Session todos')).toBeInTheDocument()
    expect(screen.getByText('Specialist todos')).toBeInTheDocument()
    expect(screen.getByText('Draft release checklist')).toBeInTheDocument()
    expect(screen.getByText('Update changelog')).toBeInTheDocument()
    expect(screen.getByText('Check IPC boundaries')).toBeInTheDocument()
    expect(screen.queryByText('No todos yet.')).not.toBeInTheDocument()
  })

  it('keeps project file artifacts in the Review diff while hiding unsafe artifact actions', () => {
    resetStore({
      directory: '/Users/alice/project',
      view: createView({
        toolCalls: [
          createToolCall({
            id: 'write-project-file',
            input: { filePath: '/Users/alice/project/report.txt', content: 'hello' },
            order: 8,
          }),
        ],
      }),
    })
    installInspectorApi()

    render(<SessionInspector onClose={vi.fn()} />)

    expect(screen.getByText('/Users/alice/project/report.txt')).toBeInTheDocument()
    expect(screen.getByText('Artifacts ready')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Artifacts' })).not.toBeInTheDocument()
  })

  it('surfaces artifacts, previews chart files, and wires send/rerender/reveal/export actions', async () => {
    const user = userEvent.setup()
    const chartArtifact: SessionArtifact = {
      id: 'chart-artifact',
      toolId: 'tool-chart',
      toolName: 'chart',
      filePath: '/tmp/chart.png',
      filename: 'chart.png',
      order: 10,
      mime: 'image/png',
      chart: {
        format: 'vega-lite',
        spec: { mark: 'bar' },
        title: 'Revenue',
      },
    }
    resetStore({ artifacts: [chartArtifact] })
    const api = installInspectorApi()
    const composerEvents: CustomEvent[] = []
    const onComposerEvent = ((event: Event) => {
      composerEvents.push(event as CustomEvent)
    }) as EventListener
    window.addEventListener(COMPOSER_COMPOSE_EVENT, onComposerEvent)

    render(<SessionInspector onClose={vi.fn()} />)

    await user.click(screen.getByText('Artifacts'))
    expect(screen.getByText('Sandbox Artifacts')).toBeInTheDocument()
    expect(screen.getByText('chart.png')).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'chart.png' })).toHaveAttribute('src', 'data:image/png;base64,abc')

    await user.click(screen.getByText('Open'))
    expect(api.artifact.open).toHaveBeenCalledWith({
      sessionId: 'session-1',
      filePath: '/tmp/chart.png',
      suggestedName: 'chart.png',
    })

    await user.click(screen.getByText('Send to thread'))
    await waitFor(() => expect(composerEvents[0]?.detail.attachments[0].filename).toBe('chart.png'))

    await user.click(screen.getByText('Rerender'))
    await waitFor(() => expect(composerEvents[1]?.detail.text).toContain('Please recreate or refine the attached chart'))

    await user.click(screen.getByText('Reveal'))
    expect(api.artifact.reveal).toHaveBeenCalledWith({ sessionId: 'session-1', filePath: '/tmp/chart.png' })

    await user.click(screen.getByText('Export'))
    expect(api.artifact.export).toHaveBeenCalledWith({
      sessionId: 'session-1',
      filePath: '/tmp/chart.png',
      suggestedName: 'chart.png',
    })
    window.removeEventListener(COMPOSER_COMPOSE_EVENT, onComposerEvent)
  })

  it('fails closed for artifact actions when workspace support cannot load', async () => {
    const user = userEvent.setup()
    const chartArtifact: SessionArtifact = {
      id: 'chart-artifact',
      toolId: 'tool-chart',
      toolName: 'chart',
      filePath: '/tmp/chart.png',
      filename: 'chart.png',
      order: 10,
      mime: 'image/png',
      chart: {
        format: 'vega-lite',
        spec: { mark: 'bar' },
        title: 'Revenue',
      },
    }
    useSessionStore.setState({
      activeWorkspaceId: 'cloud:test',
      chartArtifactsBySession: {
        [sessionWorkspaceKey('cloud:test', 'session-1')]: [chartArtifact],
      },
    })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { 'cloud:test': unavailableWorkspaceSupport('support failed') },
      loadedByWorkspace: { 'cloud:test': true },
      loadingByWorkspace: {},
      errorByWorkspace: { 'cloud:test': 'support failed' },
    })
    const api = installInspectorApi()

    render(<SessionInspector onClose={vi.fn()} />)

    await user.click(screen.getByText('Artifacts'))
    expect(await screen.findByText('chart.png')).toBeInTheDocument()
    expect(screen.getByText('Preview disabled')).toBeInTheDocument()
    expect(screen.getByText('Open').closest('button')).toBeDisabled()
    expect(screen.getByText('Send to thread').closest('button')).toBeDisabled()
    expect(screen.getByText('Rerender').closest('button')).toBeDisabled()
    expect(screen.getByText('Export').closest('button')).toBeDisabled()
    expect(screen.getByText('Reveal disabled')).toHaveAttribute('title', 'support failed')
    expect(api.artifact.readAttachment).not.toHaveBeenCalled()
    expect(api.artifact.open).not.toHaveBeenCalled()
    expect(api.artifact.export).not.toHaveBeenCalled()
  })
})
