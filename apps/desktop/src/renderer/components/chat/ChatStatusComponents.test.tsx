import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CompactionNotice, SessionView, TaskRun, TodoItem } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { CompactionNoticeCard } from './CompactionNoticeCard'
import { ThinkingIndicator } from './ThinkingIndicator'
import { TodoListView } from './TodoListView'

const emptyTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function compactionNotice(overrides: Partial<CompactionNotice>): CompactionNotice {
  return {
    id: 'compaction-1',
    status: 'compacting',
    auto: false,
    overflow: false,
    order: 1,
    ...overrides,
  }
}

function todo(overrides: Partial<TodoItem>): TodoItem {
  return {
    id: 'todo-1',
    content: 'Review implementation',
    status: 'pending',
    priority: 'medium',
    ...overrides,
  }
}

function task(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'task-1',
    title: 'Research task',
    agent: 'explore',
    status: 'running',
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

function setCurrentView(overrides: Partial<SessionView>) {
  const currentView = useSessionStore.getState().currentView
  useSessionStore.setState({
    currentView: {
      ...currentView,
      messages: [],
      toolCalls: [],
      taskRuns: [],
      compactions: [],
      pendingApprovals: [],
      pendingQuestions: [],
      errors: [],
      todos: [],
      executionPlan: [],
      contextState: 'idle',
      activeAgent: null,
      isGenerating: true,
      isAwaitingPermission: false,
      isAwaitingQuestion: false,
      ...overrides,
    },
  })
}

beforeEach(() => {
  setCurrentView({})
})

describe('CompactionNoticeCard', () => {
  it('explains running overflow compactions', () => {
    render(<CompactionNoticeCard notice={compactionNotice({ overflow: true })} />)

    expect(screen.getByText('Compacting')).toBeInTheDocument()
    expect(screen.getByText('overflow')).toBeInTheDocument()
    expect(screen.getByText(/Context window overflowed/)).toBeInTheDocument()
  })

  it('distinguishes automatic and manual completed compactions', () => {
    const { rerender } = render(
      <CompactionNoticeCard notice={compactionNotice({ status: 'compacted', auto: true })} />,
    )

    expect(screen.getByText('Compacted')).toBeInTheDocument()
    expect(screen.getByText('auto')).toBeInTheDocument()
    expect(screen.getByText(/summarized automatically/)).toBeInTheDocument()

    rerender(<CompactionNoticeCard notice={compactionNotice({ status: 'compacted', auto: false })} />)

    expect(screen.getByText('manual')).toBeInTheDocument()
    expect(screen.getByText(/manually summarized/)).toBeInTheDocument()
  })
})

describe('TodoListView', () => {
  it('sorts todos by status and priority while rendering status and priority labels', () => {
    render(
      <TodoListView
        todos={[
          todo({ id: 'low-pending', content: 'Backlog polish', status: 'pending', priority: 'low' }),
          todo({ id: 'done-high', content: 'Ship release', status: 'completed', priority: 'high' }),
          todo({ id: 'active-medium', content: 'Write tests', status: 'in_progress', priority: 'medium' }),
          todo({ id: 'blocked-high', content: 'Resolve blocker', status: 'blocked', priority: 'high' }),
        ]}
      />,
    )

    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      '◉Write testsMedium',
      '⊘Resolve blockerHigh',
      '○Backlog polishLow',
      '✓Ship releaseHigh',
    ])
    expect(screen.getByTitle('Active')).toHaveTextContent('◉')
    expect(screen.getByTitle('Blocked')).toHaveTextContent('⊘')
    expect(screen.getByTitle('Done')).toHaveTextContent('✓')
    expect(screen.getAllByTitle('High priority')).toHaveLength(2)
  })

  it('omits priority tags when requested and renders untitled todos', () => {
    render(
      <TodoListView
        showPriorityTag={false}
        todos={[todo({ id: 'untitled', content: '', status: 'pending', priority: 'high' })]}
      />,
    )

    expect(screen.getByText('Untitled todo')).toBeInTheDocument()
    expect(screen.queryByText('High')).not.toBeInTheDocument()
  })
})

describe('ThinkingIndicator', () => {
  it('prioritizes the awaiting-approval label', () => {
    setCurrentView({
      activeAgent: 'build',
      isAwaitingPermission: true,
      taskRuns: [task({ status: 'running' })],
    })

    render(<ThinkingIndicator />)

    expect(screen.getByText('Awaiting your approval')).toBeInTheDocument()
  })

  it('summarizes build coordination and shows plan, todos, and compaction state', () => {
    setCurrentView({
      activeAgent: 'build',
      contextState: 'compacting',
      taskRuns: [
        task({ id: 'running', status: 'running', order: 4 }),
        task({ id: 'queued', status: 'queued', order: 5 }),
      ],
      executionPlan: [
        todo({ id: 'plan-1', content: 'Inspect requirements', status: 'completed', priority: 'high' }),
      ],
      todos: [
        todo({ id: 'todo-1', content: 'Follow up with reviewer', status: 'pending', priority: 'medium' }),
      ],
    })

    render(<ThinkingIndicator />)

    expect(screen.getByText('Build is coordinating 2 agent(s)')).toBeInTheDocument()
    expect(screen.getByText('Compacting conversation to preserve context...')).toBeInTheDocument()
    expect(screen.getByText('Agent plan')).toBeInTheDocument()
    expect(screen.getByText('Session todos')).toBeInTheDocument()
    expect(screen.getByText('Inspect requirements')).toBeInTheDocument()
    expect(screen.getByText('Follow up with reviewer')).toBeInTheDocument()
  })

  it('shows the build merge state after delegated tasks finish ahead of the assistant reply', () => {
    setCurrentView({
      activeAgent: 'build',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Dispatching agents',
          order: 2,
        },
      ],
      taskRuns: [
        task({
          id: 'complete',
          status: 'complete',
          order: 5,
        }),
      ],
    })

    render(<ThinkingIndicator />)

    expect(screen.getByText('Build is merging agent results')).toBeInTheDocument()
  })
})
