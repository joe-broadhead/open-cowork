import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CoordinationBoardPayload,
  Message,
  PendingApproval,
  PendingQuestion,
  SessionView,
  TaskRun,
  ToolCall,
} from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { loadSessionMessages } from '../../helpers/loadSessionMessages'
import { ChatView } from './ChatView'

vi.mock('../../helpers/loadSessionMessages', () => ({
  loadSessionMessages: vi.fn(async () => undefined),
}))

vi.mock('./MessageBubble', () => ({
  MessageBubble: ({ message, streaming }: { message: Message; streaming?: boolean }) => (
    <article data-testid={`message-${message.id}`}>
      {message.role}: {message.content}
      {streaming ? ' streaming' : ''}
    </article>
  ),
}))

vi.mock('./ToolTrace', () => ({
  ToolTrace: ({ tools }: { tools: ToolCall[] }) => (
    <section data-testid="tool-trace">
      {tools.map((tool) => <span key={tool.id} data-tool-call-id={tool.id}>{tool.name}</span>)}
    </section>
  ),
}))

vi.mock('./ApprovalCard', () => ({
  ApprovalCard: ({
    approval,
    onOpenSource,
  }: {
    approval: PendingApproval
    onOpenSource?: () => void
  }) => (
    <section data-testid="approval-card">
      Approval {approval.id}: {approval.tool}
      {onOpenSource ? <button type="button" onClick={onOpenSource}>Open source {approval.id}</button> : null}
    </section>
  ),
}))

vi.mock('./ThinkingIndicator', () => ({
  ThinkingIndicator: () => <div data-testid="thinking-indicator">Thinking</div>,
}))

vi.mock('./TaskDrillIn', () => ({
  TaskDrillIn: ({
    rootTask,
    navigationTaskRuns = [],
    pendingQuestions = [],
    onNavigateTask,
    onOpenQuestion,
    onClose,
  }: {
    rootTask: TaskRun
    navigationTaskRuns?: TaskRun[]
    pendingQuestions?: PendingQuestion[]
    onNavigateTask?: (taskRun: TaskRun) => void
    onOpenQuestion?: (question: PendingQuestion) => void
    onClose: () => void
  }) => (
    <aside data-testid="task-drill-in">
      Drill in: {rootTask.title}
      <span data-testid="task-navigation-count">{navigationTaskRuns.length}</span>
      {navigationTaskRuns[1] && (
        <button type="button" onClick={() => onNavigateTask?.(navigationTaskRuns[1])}>Next filtered task</button>
      )}
      {pendingQuestions[1] && (
        <button type="button" onClick={() => onOpenQuestion?.(pendingQuestions[1])}>Open second question</button>
      )}
      <button type="button" onClick={onClose}>Close task</button>
    </aside>
  ),
}))

vi.mock('./CompactionNoticeCard', () => ({
  CompactionNoticeCard: ({ notice }: { notice: { status: string } }) => (
    <section data-testid="compaction-notice">Compaction {notice.status}</section>
  ),
}))

vi.mock('./AgentRunPanel', () => ({
  AgentRunPanel: ({
    taskRuns,
    expanded,
    onToggle,
    onFocusTask,
  }: {
    taskRuns: TaskRun[]
    expanded: boolean
    onToggle: () => void
    onFocusTask: (taskRun: TaskRun, visibleTaskRuns?: TaskRun[]) => void
  }) => (
    <section data-testid="agent-run-panel">
      <button type="button" onClick={onToggle}>{expanded ? 'Collapse tasks' : 'Expand tasks'}</button>
      {taskRuns.map((task) => (
        <button key={task.id} type="button" data-task-run-id={task.id} onClick={() => onFocusTask(task)}>
          Focus {task.title}
        </button>
      ))}
      {taskRuns.length > 2 && (
        <button type="button" onClick={() => onFocusTask(taskRuns[1], taskRuns.slice(1))}>
          Focus filtered run
        </button>
      )}
    </section>
  ),
}))

vi.mock('./SessionInspector', () => ({
  SessionInspector: ({ onClose }: { onClose: () => void }) => (
    <aside data-testid="session-inspector">
      Session inspector
      <button type="button" onClick={onClose}>Close inspector</button>
    </aside>
  ),
}))

vi.mock('./SessionQuestionDock', () => ({
  SessionQuestionDock: ({
    request,
    queueCount,
  }: {
    request: PendingQuestion
    queueCount: number
  }) => (
    <section data-testid="question-dock">
      Question dock {queueCount}: {request.questions[0]?.question}
    </section>
  ),
}))

vi.mock('./ChatInput', () => ({
  ChatInput: () => <textarea aria-label="Chat prompt" />,
}))

const sessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function emptySessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    messages: [],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens,
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 0,
    lastEventAt: 0,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
    ...overrides,
  }
}

function resetSessionStore() {
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    currentView: emptySessionView(),
    globalErrors: [],
    mcpConnections: [],
    agentMode: 'build',
    totalCost: 0,
    sidebarCollapsed: false,
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
}

function installChatViewApi(options: {
  unrevertResult?: boolean
  unrevertError?: Error
  runtimeReadyCallbacks?: Array<() => void>
  coordinationBoard?: CoordinationBoardPayload
  coordinationUpdatedCallbacks?: Array<() => void>
} = {}) {
  const callbacks = options.runtimeReadyCallbacks ?? []
  const coordinationCallbacks = options.coordinationUpdatedCallbacks ?? []
  return installRendererTestCoworkApi({
    on: {
      runtimeReady: vi.fn((callback: () => void) => {
        callbacks.push(callback)
        return vi.fn()
      }),
      coordinationUpdated: vi.fn((callback: () => void) => {
        coordinationCallbacks.push(callback)
        return vi.fn()
      }),
    },
    session: {
      unrevert: vi.fn(async () => {
        if (options.unrevertError) throw options.unrevertError
        return options.unrevertResult ?? true
      }),
    },
    agents: {
      list: vi.fn(async () => []),
      runtime: vi.fn(async () => []),
    },
    app: {
      builtinAgents: vi.fn(async () => []),
    },
    coordination: {
      board: vi.fn(async () => options.coordinationBoard ?? { projects: [], tasks: [] }),
    },
    knowledge: {
      snapshot: vi.fn(async () => ({
        spaces: [{ id: 'space-local', name: 'Company OS', visibility: 'company', role: 'Maintainer' }],
        pages: [],
        proposals: [],
        graph: { nodes: [], edges: [] },
      })),
      propose: vi.fn(async () => ({
        id: 'proposal-1',
        spaceId: 'space-local',
        pageTitle: 'Conversation',
        by: 'you',
        when: '2026-06-15T00:00:00.000Z',
        summary: 'Capture',
        add: 1,
        del: 0,
        status: 'pending',
        links: [],
        body: [{ id: 'body', type: 'p', text: 'Captured.' }],
      })),
    },
  })
}

function seedCurrentSession(view: SessionView = emptySessionView()) {
  useSessionStore.getState().setSessions([
    {
      id: 'parent-1',
      title: 'Parent thread',
      directory: '/tmp/workspace',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    },
    {
      id: 'session-1',
      title: 'Launch analysis',
      directory: '/tmp/workspace/app',
      parentSessionId: 'parent-1',
      changeSummary: {
        files: 2,
        additions: 14,
        deletions: 3,
      },
      revertedMessageId: 'message-previous',
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    },
  ])
  useSessionStore.getState().setCurrentSession('session-1')
  useSessionStore.getState().setSessionView('session-1', view)
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: undefined,
  })
  resetSessionStore()
})

describe('ChatView', () => {
  it('renders nothing until a current session is selected', () => {
    installChatViewApi()
    const { container } = render(<ChatView />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders session metadata, timeline items, questions, and inspector controls', async () => {
    const user = userEvent.setup()
    const runtimeReadyCallbacks: Array<() => void> = []
    const api = installChatViewApi({ runtimeReadyCallbacks })
    seedCurrentSession(emptySessionView({
      messages: [
        { id: 'message-user', role: 'user', content: 'Start the launch analysis', order: 1 },
        { id: 'message-assistant', role: 'assistant', content: 'Working on it', order: 7 },
      ],
      toolCalls: [
        { id: 'tool-1', name: 'shell.run', input: {}, status: 'complete', order: 2 },
      ],
      taskRuns: [
        {
          id: 'task-1',
          title: 'Research market',
          agent: 'researcher',
          status: 'running',
          sourceSessionId: 'child-1',
          parentSessionId: null,
          content: '',
          transcript: [],
          toolCalls: [],
          compactions: [],
          todos: [],
          error: null,
          sessionCost: 0,
          sessionTokens,
          order: 3,
        },
      ],
      compactions: [
        { id: 'compaction-1', status: 'compacted', auto: true, overflow: false, order: 4 },
      ],
      pendingApprovals: [
        { id: 'approval-1', sessionId: 'session-1', tool: 'shell.run', input: {}, description: 'Run command', order: 5 },
      ],
      pendingQuestions: [
        {
          id: 'question-1',
          sessionId: 'session-1',
          questions: [
            { header: 'Choice', question: 'Which market?', options: [{ label: 'US', description: 'Use US market' }] },
          ],
        },
      ],
      errors: [
        { id: 'error-1', sessionId: 'session-1', message: 'Provider paused', order: 6 },
      ],
      isGenerating: true,
    }))

    render(<ChatView />)

    expect(document.querySelector('[data-workbench-layout="true"]')).toBeInTheDocument()
    expect(document.querySelector('[data-workbench-pane="conversation"]')).toBeInTheDocument()
    expect(document.querySelector('[data-workbench-pane="review"]')).toHaveTextContent('Session inspector')
    expect(screen.getByRole('toolbar', { name: 'Chat actions' })).toBeInTheDocument()
    expect(screen.getByText('Launch analysis')).toBeInTheDocument()
    expect(screen.getByText('/tmp/workspace/app')).toBeInTheDocument()
    expect(screen.getByText('+14')).toBeInTheDocument()
    expect(screen.getByText('−3')).toBeInTheDocument()
    expect(screen.getByText(/2 files/)).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Chat transcript' })).toBeInTheDocument()
    expect(screen.getByTestId('message-message-user')).toHaveTextContent('user: Start the launch analysis')
    expect(screen.getByTestId('message-message-assistant')).toHaveTextContent('assistant: Working on it')
    expect(screen.getByTestId('tool-trace')).toHaveTextContent('shell.run')
    expect(screen.getByTestId('agent-run-panel')).toHaveTextContent('Research market')
    expect(screen.getByTestId('compaction-notice')).toHaveTextContent('compacted')
    expect(screen.getByTestId('approval-card')).toHaveTextContent('approval-1')
    expect(screen.getByTestId('question-dock')).toHaveTextContent('Which market?')
    expect(screen.getByText('Provider paused')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Chat prompt' })).toBeInTheDocument()
    expect(screen.getByTestId('session-inspector')).toBeInTheDocument()

    await waitFor(() => expect(api.app.builtinAgents).toHaveBeenCalledTimes(1))
    expect(runtimeReadyCallbacks).toHaveLength(1)
    runtimeReadyCallbacks[0]?.()
    await waitFor(() => expect(api.app.builtinAgents).toHaveBeenCalledTimes(2))

    await user.click(screen.getByRole('button', { name: /Forked from Parent thread/ }))
    expect(loadSessionMessages).toHaveBeenCalledWith('parent-1')

    await user.click(screen.getByRole('button', { name: 'Reverted · click to unrevert' }))
    await waitFor(() => expect(api.session.unrevert).toHaveBeenCalledWith('session-1'))

    await user.click(screen.getByRole('button', { name: 'Hide Review' }))
    expect(screen.queryByTestId('session-inspector')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show Review' }))
    expect(screen.getByTestId('session-inspector')).toBeInTheDocument()
  })

  it('hides desktop Knowledge capture for cloud workspaces', async () => {
    installChatViewApi()
    seedCurrentSession()
    useSessionStore.setState({ activeWorkspaceId: 'cloud:test' })

    render(<ChatView />)

    await screen.findByRole('toolbar', { name: 'Chat actions' })
    expect(screen.queryByRole('button', { name: 'Capture to knowledge' })).not.toBeInTheDocument()
    expect(document.querySelector('[data-action-id="capture-knowledge"]')).not.toBeInTheDocument()
  })

  it('shows linked project and task context only when coordination links the session', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    installChatViewApi({
      coordinationBoard: {
        projects: [{
          id: 'project-1',
          kind: 'project',
          workspaceId: 'local',
          ownerAuthority: 'desktop_local',
          executionAuthority: 'desktop_local',
          stateOwner: 'desktop_local_store',
          createdAt: '2026-06-13T00:00:00.000Z',
          updatedAt: '2026-06-13T00:00:00.000Z',
          title: 'Studio redesign',
          objective: 'Ship conversation parity',
          status: 'active',
          team: ['chief-of-staff'],
        }],
        tasks: [{
          id: 'task-1',
          kind: 'task',
          workspaceId: 'local',
          ownerAuthority: 'desktop_local',
          executionAuthority: 'desktop_local',
          stateOwner: 'desktop_local_store',
          createdAt: '2026-06-13T00:00:00.000Z',
          updatedAt: '2026-06-13T00:00:00.000Z',
          projectId: 'project-1',
          title: 'Conversation polish',
          spec: 'Add handoff and review affordances',
          status: 'running',
          column: 'doing',
          priority: 'high',
          assignedSessionId: 'session-1',
        }],
      },
    })
    seedCurrentSession()

    render(<ChatView onNavigate={onNavigate} />)

    await screen.findByLabelText('Project Studio redesign, task Conversation polish')
    expect(screen.getByText('Studio redesign')).toBeInTheDocument()
    expect(screen.getByText('Conversation polish')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open board' }))
    expect(onNavigate).toHaveBeenCalledWith('projects')
  })

  it('scrolls from an approval card to its source tool when available', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    installChatViewApi()
    seedCurrentSession(emptySessionView({
      toolCalls: [
        { id: 'tool-approval-1', name: 'shell.run', input: {}, status: 'running', order: 1 },
      ],
      pendingApprovals: [
        { id: 'tool-approval-1', sessionId: 'session-1', tool: 'shell.run', input: {}, description: 'Run command', order: 2 },
      ],
    }))

    render(<ChatView />)
    const sourceTool = document.querySelector('[data-tool-call-id="tool-approval-1"]')
    expect(sourceTool).toBeInstanceOf(HTMLElement)
    Object.defineProperty(sourceTool, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })

    await user.click(screen.getByRole('button', { name: 'Open source tool-approval-1' }))

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    })
  })

  it('respects reduced motion when scrolling from an approval to its source tool', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    })
    installChatViewApi()
    seedCurrentSession(emptySessionView({
      toolCalls: [
        { id: 'tool-approval-1', name: 'shell.run', input: {}, status: 'running', order: 1 },
      ],
      pendingApprovals: [
        { id: 'tool-approval-1', sessionId: 'session-1', tool: 'shell.run', input: {}, description: 'Run command', order: 2 },
      ],
    }))

    render(<ChatView />)
    const sourceTool = document.querySelector('[data-tool-call-id="tool-approval-1"]')
    expect(sourceTool).toBeInstanceOf(HTMLElement)
    Object.defineProperty(sourceTool, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })

    await user.click(screen.getByRole('button', { name: 'Open source tool-approval-1' }))

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })
    })
  })

  it('opens and closes task drill-in from mission control', async () => {
    const user = userEvent.setup()
    installChatViewApi()
    seedCurrentSession(emptySessionView({
      taskRuns: [
        {
          id: 'task-1',
          title: 'Research market',
          agent: 'researcher',
          status: 'running',
          sourceSessionId: 'child-1',
          parentSessionId: null,
          content: '',
          transcript: [],
          toolCalls: [],
          compactions: [],
          todos: [],
          error: null,
          sessionCost: 0,
          sessionTokens,
          order: 1,
        },
      ],
    }))

    render(<ChatView />)

    await user.click(screen.getByRole('button', { name: 'Focus Research market' }))
    expect(screen.getByTestId('task-drill-in')).toHaveTextContent('Drill in: Research market')

    await user.click(screen.getByRole('button', { name: 'Close task' }))
    expect(screen.queryByTestId('task-drill-in')).not.toBeInTheDocument()
  })

  it('keeps filtered drill-in navigation scoped after moving to the next task', async () => {
    const user = userEvent.setup()
    installChatViewApi()
    const task = (id: string, title: string, order: number): TaskRun => ({
      id,
      title,
      agent: 'researcher',
      status: 'running',
      sourceSessionId: `child-${id}`,
      parentSessionId: null,
      content: '',
      transcript: [],
      toolCalls: [],
      compactions: [],
      todos: [],
      error: null,
      sessionCost: 0,
      sessionTokens,
      order,
    })
    seedCurrentSession(emptySessionView({
      taskRuns: [
        task('task-1', 'Outside filter', 1),
        task('task-2', 'Inside filter', 2),
        task('task-3', 'Next inside filter', 3),
      ],
    }))

    render(<ChatView />)

    await user.click(screen.getByRole('button', { name: 'Focus filtered run' }))
    expect(screen.getByTestId('task-drill-in')).toHaveTextContent('Drill in: Inside filter')
    expect(screen.getByTestId('task-navigation-count')).toHaveTextContent('2')

    await user.click(screen.getByRole('button', { name: 'Next filtered task' }))
    expect(screen.getByTestId('task-drill-in')).toHaveTextContent('Drill in: Next inside filter')
    expect(screen.getByTestId('task-navigation-count')).toHaveTextContent('2')
  })

  it('opens the selected queued question from task drill-in', async () => {
    const user = userEvent.setup()
    installChatViewApi()
    seedCurrentSession(emptySessionView({
      taskRuns: [
        {
          id: 'task-1',
          title: 'Research market',
          agent: 'researcher',
          status: 'running',
          sourceSessionId: 'child-1',
          parentSessionId: null,
          content: '',
          transcript: [],
          toolCalls: [],
          compactions: [],
          todos: [],
          error: null,
          sessionCost: 0,
          sessionTokens,
          order: 1,
        },
      ],
      pendingQuestions: [
        {
          id: 'question-1',
          sessionId: 'session-1',
          sourceSessionId: 'session-1',
          questions: [
            { header: 'First', question: 'First queued question?', options: [{ label: 'A', description: 'A' }] },
          ],
        },
        {
          id: 'question-2',
          sessionId: 'child-1',
          sourceSessionId: 'child-1',
          questions: [
            { header: 'Second', question: 'Task-specific question?', options: [{ label: 'B', description: 'B' }] },
          ],
        },
      ],
    }))

    render(<ChatView />)

    expect(screen.getByTestId('question-dock')).toHaveTextContent('First queued question?')
    await user.click(screen.getByRole('button', { name: 'Focus Research market' }))
    await user.click(screen.getByRole('button', { name: 'Open second question' }))

    expect(screen.getByTestId('question-dock')).toHaveTextContent('Task-specific question?')
  })

  it('records a global error when unreverting fails without rendering it inline', async () => {
    const user = userEvent.setup()
    installChatViewApi({ unrevertResult: false })
    seedCurrentSession()

    render(<ChatView />)

    await user.click(screen.getByRole('button', { name: 'Reverted · click to unrevert' }))

    await waitFor(() => expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not unrevert this session. Please try again.'))
    expect(screen.queryByText('Could not unrevert this session. Please try again.')).not.toBeInTheDocument()
  })

  it('records a generic global error when unreverting rejects without rendering it inline', async () => {
    const user = userEvent.setup()
    installChatViewApi({ unrevertError: new Error('Runtime unavailable') })
    seedCurrentSession()

    render(<ChatView />)

    await user.click(screen.getByRole('button', { name: 'Reverted · click to unrevert' }))

    await waitFor(() => expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not unrevert this session. Please try again.'))
    expect(screen.queryByText('Could not unrevert this session. Please try again.')).not.toBeInTheDocument()
  })

  it('stops auto-following when the user scrolls away from the transcript bottom', () => {
    installChatViewApi()
    seedCurrentSession(emptySessionView({
      messages: [
        { id: 'message-user', role: 'user', content: 'Start', order: 1 },
      ],
    }))

    render(<ChatView />)

    const transcript = screen.getByRole('log', { name: 'Chat transcript' })
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(transcript, 'scrollTop', { configurable: true, value: 100 })
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 300 })

    fireEvent.scroll(transcript)

    useSessionStore.getState().setSessionView('session-1', emptySessionView({
      messages: [
        { id: 'message-user', role: 'user', content: 'Start', order: 1 },
        { id: 'message-assistant', role: 'assistant', content: 'Update', order: 2 },
      ],
      isGenerating: true,
    }))

    expect(transcript.scrollTop).toBe(100)
  })

  it('shows a jump-to-latest control when auto-follow is paused and resumes at the bottom', async () => {
    installChatViewApi()
    seedCurrentSession(emptySessionView({
      messages: [
        { id: 'message-user', role: 'user', content: 'Start', order: 1 },
        { id: 'message-assistant', role: 'assistant', content: 'Update', order: 2 },
      ],
    }))

    render(<ChatView />)

    const transcript = screen.getByRole('log', { name: 'Chat transcript' }) as HTMLDivElement
    const scrollTo = vi.fn()
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(transcript, 'scrollTop', { configurable: true, value: 100 })
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(transcript, 'scrollTo', { configurable: true, value: scrollTo })

    fireEvent.scroll(transcript)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({
        top: 1000,
        behavior: 'smooth',
      })
    })
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()
  })
})
