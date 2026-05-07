import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRun } from '@open-cowork/shared'
import { MissionControl } from './MissionControl'

vi.mock('../agents/AgentAvatar', () => ({
  AgentAvatar: ({ name }: { name: string }) => (
    <span data-testid="agent-avatar">{name}</span>
  ),
}))

vi.mock('./ElapsedClock', () => ({
  ElapsedClock: ({
    startedAt,
    finishedAt,
  }: {
    startedAt?: string | null
    finishedAt?: string | null
  }) => (
    <span data-testid="elapsed-clock">
      {startedAt || 'not-started'} / {finishedAt || 'running'}
    </span>
  ),
}))

vi.mock('./useLiveNow', () => ({
  useLiveNow: () => new Date('2026-05-07T00:02:00.000Z').getTime(),
}))

const emptyTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function task(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'task-1',
    title: 'Research launch',
    agent: 'research-agent',
    status: 'running',
    sourceSessionId: 'child-session-1',
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

const agentVisuals = {
  'research-agent': {
    id: 'research-agent',
    name: 'Research Agent',
    color: 'blue',
    avatar: null,
  },
  explore: {
    id: 'explore',
    name: 'Explore',
    color: 'green',
    avatar: null,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MissionControl', () => {
  it('summarizes running tasks and toggles the lane group', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()

    render(
      <MissionControl
        taskRuns={[
          task({
            id: 'research',
            startedAt: '2026-05-07T00:00:00.000Z',
            sessionTokens: {
              input: 900,
              output: 500,
              reasoning: 100,
              cacheRead: 0,
              cacheWrite: 0,
            },
            sessionCost: 0.42,
          }),
          task({
            id: 'explore',
            agent: 'explore',
            status: 'queued',
            sourceSessionId: 'child-session-2',
            order: 2,
          }),
        ]}
        agentVisuals={agentVisuals}
        expanded={false}
        onToggle={onToggle}
        focusedTaskId={null}
        onFocusTask={vi.fn()}
      />,
    )

    expect(screen.getByText('Agents working')).toBeInTheDocument()
    expect(screen.getByText('2 tasks · Research Agent, Explore')).toBeInTheDocument()
    expect(screen.getByText('2 running')).toBeInTheDocument()
    expect(screen.getByText(/tok$/)).toHaveTextContent('1.5k tok')
    expect(screen.getByText('$0.42')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Research Agent — running' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Agents working/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('renders nested lanes and focuses the clicked task', async () => {
    const user = userEvent.setup()
    const onFocusTask = vi.fn()
    const root = task({
      id: 'root',
      agent: 'research-agent',
      sourceSessionId: 'root-session',
      status: 'running',
      startedAt: '2026-05-07T00:00:00.000Z',
      transcript: [{ id: 'seg-1', content: 'Reviewing launch notes', order: 1 }],
      order: 1,
    })
    const child = task({
      id: 'child',
      agent: 'explore',
      sourceSessionId: 'child-session',
      parentSessionId: 'root-session',
      status: 'complete',
      startedAt: '2026-05-07T00:00:30.000Z',
      finishedAt: '2026-05-07T00:01:00.000Z',
      order: 2,
    })
    const grandchild = task({
      id: 'grandchild',
      agent: 'general',
      sourceSessionId: 'grandchild-session',
      parentSessionId: 'child-session',
      status: 'complete',
      order: 3,
    })

    render(
      <MissionControl
        taskRuns={[root, child, grandchild]}
        agentVisuals={agentVisuals}
        expanded
        onToggle={vi.fn()}
        focusedTaskId="child"
        onFocusTask={onFocusTask}
      />,
    )

    expect(screen.getByRole('button', { name: 'Research Agent — running' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Explore — done' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('1 deeper')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /General.*done/ })).not.toBeInTheDocument()
    expect(screen.getByText('Reviewing launch notes')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Explore — done' }))
    expect(onFocusTask).toHaveBeenLastCalledWith(child)

    await user.click(screen.getByRole('button', { name: 'Research Agent — running' }))
    expect(onFocusTask).toHaveBeenLastCalledWith(root)
  })

  it('labels completed and errored task groups distinctly', () => {
    const { rerender } = render(
      <MissionControl
        taskRuns={[
          task({
            id: 'complete',
            status: 'complete',
            startedAt: '2026-05-07T00:00:00.000Z',
            finishedAt: '2026-05-07T00:01:00.000Z',
          }),
        ]}
        agentVisuals={agentVisuals}
        expanded={false}
        onToggle={vi.fn()}
        focusedTaskId={null}
        onFocusTask={vi.fn()}
      />,
    )

    expect(screen.getByText('Agents complete')).toBeInTheDocument()
    expect(screen.queryByText('1 complete')).not.toBeInTheDocument()

    rerender(
      <MissionControl
        taskRuns={[
          task({
            id: 'failed',
            status: 'error',
            error: 'Tool failed',
          }),
          task({
            id: 'queued',
            agent: 'explore',
            status: 'queued',
            order: 2,
          }),
        ]}
        agentVisuals={agentVisuals}
        expanded={false}
        onToggle={vi.fn()}
        focusedTaskId={null}
        onFocusTask={vi.fn()}
      />,
    )

    expect(screen.getByText('Agents errored')).toBeInTheDocument()
    expect(screen.getByText('1 running')).toBeInTheDocument()
  })
})
