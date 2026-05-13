import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore, type TaskRun } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { TaskDrillIn } from './TaskDrillIn'

vi.mock('../agents/AgentAvatar', () => ({
  AgentAvatar: ({ name }: { name: string }) => <div data-testid="agent-avatar">{name}</div>,
}))

vi.mock('./ElapsedClock', () => ({
  ElapsedClock: () => <span data-testid="elapsed-clock">12s</span>,
}))

vi.mock('./ToolTrace', () => ({
  ToolTrace: ({ tools }: { tools: Array<{ name: string }> }) => (
    <div data-testid="tool-trace">{tools.map((tool) => tool.name).join(', ')}</div>
  ),
}))

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: ({ text, streaming }: { text: string; streaming?: boolean }) => (
    <article data-testid="markdown-content">
      {text}
      {streaming ? ' streaming' : ''}
    </article>
  ),
}))

vi.mock('./CompactionNoticeCard', () => ({
  CompactionNoticeCard: ({ notice }: { notice: { status: string } }) => (
    <div data-testid="compaction-notice">{notice.status}</div>
  ),
}))

vi.mock('./TodoListView', () => ({
  TodoListView: ({ todos }: { todos: Array<{ content: string }> }) => (
    <ul data-testid="todo-list">
      {todos.map((todo) => <li key={todo.content}>{todo.content}</li>)}
    </ul>
  ),
}))

vi.mock('./MissionControlLane', () => ({
  MissionControlLane: ({
    taskRun,
    onToggle,
  }: {
    taskRun: TaskRun
    onToggle: () => void
  }) => (
    <button type="button" onClick={onToggle}>
      Open {taskRun.title}
    </button>
  ),
}))

const baseTokens = {
  input: 1200,
  output: 340,
  reasoning: 25,
  cacheRead: 500,
  cacheWrite: 20,
}

function createTask(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'task-root',
    title: 'Review auth changes',
    agent: 'code-reviewer',
    status: 'running',
    sourceSessionId: 'child-session-1234567890',
    parentSessionId: null,
    content: '',
    transcript: [
      {
        id: 'segment-1',
        content: 'Reading the auth patch',
        order: 1,
      },
    ],
    toolCalls: [
      {
        id: 'tool-1',
        name: 'read',
        input: { file: 'src/auth.ts' },
        status: 'complete',
        output: 'ok',
        order: 2,
      },
    ],
    compactions: [
      {
        id: 'compact-1',
        status: 'compacting',
        auto: true,
        overflow: false,
        order: 3,
      },
    ],
    todos: [
      {
        id: 'todo-1',
        content: 'Verify OAuth callback handling',
        status: 'in_progress',
        priority: 'high',
      },
    ],
    error: null,
    sessionCost: 0.0123,
    sessionTokens: baseTokens,
    order: 1,
    startedAt: '2026-05-07T03:00:00.000Z',
    finishedAt: null,
    ...overrides,
  }
}

function resetSessionStore() {
  useSessionStore.setState({
    globalErrors: [],
  })
}

function installTaskApi(options: {
  abortTask?: ReturnType<typeof vi.fn>
  reportRendererError?: ReturnType<typeof vi.fn>
} = {}) {
  return installRendererTestCoworkApi({
    diagnostics: {
      reportRendererError: options.reportRendererError || vi.fn(),
    },
    session: {
      abortTask: options.abortTask || vi.fn(async () => true),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  installTaskApi()
  resetSessionStore()
  window.localStorage.clear()
})

describe('TaskDrillIn', () => {
  it('renders the focused task transcript, scorecard, todos, tools, and abort action', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const api = installTaskApi()
    const rootTask = createTask()

    render(
      <TaskDrillIn
        rootTask={rootTask}
        allTaskRuns={[rootTask]}
        agentVisuals={{ 'code-reviewer': { color: 'blue', avatar: null } }}
        rootSessionId="root-session"
        onClose={onClose}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Code Reviewer drill-in' })).toBeInTheDocument()
    expect(screen.getByText('Review auth changes')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByTestId('elapsed-clock')).toHaveTextContent('12s')
    expect(screen.getByText('Tokens')).toBeInTheDocument()
    expect(screen.getByText('Cost')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('Reading the auth patch streaming')
    expect(screen.getByTestId('tool-trace')).toHaveTextContent('read')
    expect(screen.getByTestId('compaction-notice')).toHaveTextContent('compacting')
    expect(screen.getByTestId('todo-list')).toHaveTextContent('Verify OAuth callback handling')

    await user.click(screen.getByRole('button', { name: 'Abort this task' }))
    await waitFor(() => {
      expect(api.session.abortTask).toHaveBeenCalledWith('root-session', 'child-session-1234567890')
    })

    await user.click(screen.getByRole('button', { name: 'Close drawer' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces abort failures through the chat error channel and diagnostics', async () => {
    const user = userEvent.setup()
    const abortTask = vi.fn(async () => {
      throw new Error('runtime rejected abort')
    })
    const reportRendererError = vi.fn()
    const api = installTaskApi({ abortTask, reportRendererError })
    const rootTask = createTask()

    render(
      <TaskDrillIn
        rootTask={rootTask}
        allTaskRuns={[rootTask]}
        agentVisuals={{ 'code-reviewer': { color: 'blue', avatar: null } }}
        rootSessionId="root-session"
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Abort this task' }))

    await waitFor(() => {
      expect(api.session.abortTask).toHaveBeenCalledWith('root-session', 'child-session-1234567890')
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not abort this task. Please try again.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('runtime rejected abort'),
      view: 'task-drill-in',
    }))
  })

  it('supports nested task drill-in navigation and returning to the parent task', async () => {
    const user = userEvent.setup()
    const rootTask = createTask()
    const nestedTask = createTask({
      id: 'task-nested',
      title: 'Nested Research',
      agent: 'researcher',
      status: 'complete',
      sourceSessionId: 'nested-session',
      parentSessionId: rootTask.sourceSessionId,
      transcript: [{ id: 'segment-nested', content: 'Finished nested checks', order: 1 }],
      toolCalls: [],
      compactions: [],
      todos: [],
      sessionCost: 0,
      sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      finishedAt: '2026-05-07T03:01:00.000Z',
    })

    render(
      <TaskDrillIn
        rootTask={rootTask}
        allTaskRuns={[rootTask, nestedTask]}
        agentVisuals={{ researcher: { color: 'green', avatar: null } }}
        rootSessionId="root-session"
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Nested sub-agents (1)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Nested Research' }))

    expect(screen.getByRole('dialog', { name: 'Researcher drill-in' })).toBeInTheDocument()
    expect(screen.getByText('Complete')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('Finished nested checks')
    expect(screen.queryByRole('button', { name: 'Abort this task' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back to parent task' }))
    expect(screen.getByRole('dialog', { name: 'Code Reviewer drill-in' })).toBeInTheDocument()
  })

  it('supports filtered task navigation and opens review and artifact affordances', async () => {
    const user = userEvent.setup()
    const api = installTaskApi()
    const onNavigateTask = vi.fn()
    const onOpenTaskInTranscript = vi.fn()
    const onOpenApproval = vi.fn()
    const onOpenQuestion = vi.fn()
    const rootTask = createTask({
      toolCalls: [
        {
          id: 'tool-write',
          name: 'write',
          input: { filePath: '/tmp/report.md' },
          status: 'complete',
          output: 'ok',
          order: 2,
        },
      ],
    })
    const nextTask = createTask({
      id: 'task-next',
      title: 'Write summary',
      agent: 'writer',
      sourceSessionId: 'writer-session',
      parentSessionId: null,
      transcript: [{ id: 'segment-next', content: 'Writing summary', order: 1 }],
      toolCalls: [],
    })
    const pendingApproval = {
      id: 'approval-1',
      sessionId: rootTask.sourceSessionId!,
      taskRunId: rootTask.id,
      tool: 'bash',
      input: {},
      description: 'Run command',
      order: 4,
    }
    const pendingQuestion = {
      id: 'question-1',
      sessionId: rootTask.sourceSessionId!,
      sourceSessionId: rootTask.sourceSessionId,
      questions: [{ header: 'Scope', question: 'Continue?', options: [] }],
    }

    render(
      <TaskDrillIn
        rootTask={rootTask}
        allTaskRuns={[rootTask, nextTask]}
        agentVisuals={{ writer: { color: 'green', avatar: null } }}
        rootSessionId="root-session"
        navigationTaskRuns={[rootTask, nextTask]}
        pendingApprovals={[pendingApproval]}
        pendingQuestions={[pendingQuestion]}
        onNavigateTask={onNavigateTask}
        onOpenTaskInTranscript={onOpenTaskInTranscript}
        onOpenApproval={onOpenApproval}
        onOpenQuestion={onOpenQuestion}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Open approval/ }))
    expect(onOpenApproval).toHaveBeenCalledWith(pendingApproval)

    await user.click(screen.getByRole('button', { name: /Open question/ }))
    expect(onOpenQuestion).toHaveBeenCalledWith(pendingQuestion)

    await user.click(screen.getByRole('button', { name: /Open artifact/ }))
    await waitFor(() => {
      expect(api.artifact.reveal).toHaveBeenCalledWith({ sessionId: 'root-session', filePath: '/tmp/report.md' })
    })

    await user.click(screen.getByRole('button', { name: 'Next task in current filter' }))
    expect(onNavigateTask).toHaveBeenCalledWith(nextTask)
    expect(screen.getByRole('dialog', { name: 'Writer drill-in' })).toBeInTheDocument()

    await user.click(screen.getByText('Source'))
    expect(onOpenTaskInTranscript).toHaveBeenCalledWith(nextTask)
  })

  it('closes on Escape and shows empty transcript copy for completed tasks without output', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const rootTask = createTask({
      status: 'complete',
      content: '',
      transcript: [],
      toolCalls: [],
      compactions: [],
      todos: [],
      finishedAt: '2026-05-07T03:01:00.000Z',
    })

    render(
      <TaskDrillIn
        rootTask={rootTask}
        allTaskRuns={[rootTask]}
        agentVisuals={{}}
        rootSessionId="root-session"
        onClose={onClose}
      />,
    )

    expect(screen.getByText('No transcript captured.')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
