import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
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
      {tools.map((tool) => <span key={tool.id}>{tool.name}</span>)}
    </section>
  ),
}))

vi.mock('./ApprovalCard', () => ({
  ApprovalCard: ({ approval }: { approval: PendingApproval }) => (
    <section data-testid="approval-card">Approval {approval.id}: {approval.tool}</section>
  ),
}))

vi.mock('./ThinkingIndicator', () => ({
  ThinkingIndicator: () => <div data-testid="thinking-indicator">Thinking</div>,
}))

vi.mock('./TaskDrillIn', () => ({
  TaskDrillIn: ({
    rootTask,
    onClose,
  }: {
    rootTask: TaskRun
    onClose: () => void
  }) => (
    <aside data-testid="task-drill-in">
      Drill in: {rootTask.title}
      <button type="button" onClick={onClose}>Close task</button>
    </aside>
  ),
}))

vi.mock('./CompactionNoticeCard', () => ({
  CompactionNoticeCard: ({ notice }: { notice: { status: string } }) => (
    <section data-testid="compaction-notice">Compaction {notice.status}</section>
  ),
}))

vi.mock('./MissionControl', () => ({
  MissionControl: ({
    taskRuns,
    expanded,
    onToggle,
    onFocusTask,
  }: {
    taskRuns: TaskRun[]
    expanded: boolean
    onToggle: () => void
    onFocusTask: (taskRun: TaskRun) => void
  }) => (
    <section data-testid="mission-control">
      <button type="button" onClick={onToggle}>{expanded ? 'Collapse tasks' : 'Expand tasks'}</button>
      {taskRuns.map((task) => (
        <button key={task.id} type="button" onClick={() => onFocusTask(task)}>
          Focus {task.title}
        </button>
      ))}
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
  runtimeReadyCallbacks?: Array<() => void>
} = {}) {
  const callbacks = options.runtimeReadyCallbacks ?? []
  return installRendererTestCoworkApi({
    on: {
      runtimeReady: vi.fn((callback: () => void) => {
        callbacks.push(callback)
        return vi.fn()
      }),
    },
    session: {
      unrevert: vi.fn(async () => options.unrevertResult ?? true),
    },
    agents: {
      list: vi.fn(async () => []),
      runtime: vi.fn(async () => []),
    },
    app: {
      builtinAgents: vi.fn(async () => []),
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

    expect(screen.getByText('Launch analysis')).toBeInTheDocument()
    expect(screen.getByText('/tmp/workspace/app')).toBeInTheDocument()
    expect(screen.getByText('+14')).toBeInTheDocument()
    expect(screen.getByText('−3')).toBeInTheDocument()
    expect(screen.getByText(/2 files/)).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Chat transcript' })).toBeInTheDocument()
    expect(screen.getByTestId('message-message-user')).toHaveTextContent('user: Start the launch analysis')
    expect(screen.getByTestId('message-message-assistant')).toHaveTextContent('assistant: Working on it')
    expect(screen.getByTestId('tool-trace')).toHaveTextContent('shell.run')
    expect(screen.getByTestId('mission-control')).toHaveTextContent('Research market')
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

    await user.click(screen.getByRole('button', { name: 'Hide Context' }))
    expect(screen.queryByTestId('session-inspector')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show Context' }))
    expect(screen.getByTestId('session-inspector')).toBeInTheDocument()
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

  it('surfaces a global error when unreverting fails', async () => {
    const user = userEvent.setup()
    installChatViewApi({ unrevertResult: false })
    seedCurrentSession()

    render(<ChatView />)

    await user.click(screen.getByRole('button', { name: 'Reverted · click to unrevert' }))

    expect(await screen.findByText('Could not unrevert this session. Please try again.')).toBeInTheDocument()
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
})
