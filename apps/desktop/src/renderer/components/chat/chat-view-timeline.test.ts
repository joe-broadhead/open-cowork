import { describe, expect, it } from 'vitest'
import type { Message, PendingApproval, SessionError, TaskRun, ToolCall } from '../../stores/session'
import { buildChatTimeline } from './chat-view-timeline'

const sessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function taskRun(id: string, order: number): TaskRun {
  return {
    id,
    title: id,
    agent: 'worker',
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
  }
}

describe('buildChatTimeline', () => {
  it('sorts transcript events and groups adjacent tools and tasks', () => {
    const messages: Message[] = [
      { id: 'message-2', role: 'assistant', content: 'done', order: 6 },
      { id: 'message-1', role: 'user', content: 'start', order: 1 },
    ]
    const toolCalls: ToolCall[] = [
      { id: 'tool-1', name: 'bash', input: {}, status: 'running', order: 2 },
      { id: 'tool-2', name: 'edit', input: {}, status: 'complete', order: 3 },
    ]
    const taskRuns = [
      taskRun('task-1', 4),
      taskRun('task-2', 5),
    ]
    const errors: SessionError[] = [
      { id: 'error-1', sessionId: 'session-1', message: 'Provider paused', order: 7 },
    ]

    const timeline = buildChatTimeline({
      messages,
      toolCalls,
      taskRuns,
      compactions: [],
      approvals: [],
      errors,
    })

    expect(timeline.map((item) => item.kind)).toEqual(['message', 'tools', 'task_group', 'message', 'error'])
    expect(timeline[1]).toMatchObject({ kind: 'tools', data: [{ id: 'tool-1' }, { id: 'tool-2' }] })
    expect(timeline[2]).toMatchObject({ kind: 'task_group', data: [{ id: 'task-1' }, { id: 'task-2' }] })
  })

  it('flushes pending groups before non-group transcript items', () => {
    const approval: PendingApproval = {
      id: 'approval-1',
      sessionId: 'session-1',
      tool: 'bash',
      input: {},
      description: 'Run command',
      order: 3,
    }

    const timeline = buildChatTimeline({
      messages: [],
      toolCalls: [
        { id: 'tool-1', name: 'bash', input: {}, status: 'running', order: 1 },
      ],
      taskRuns: [
        taskRun('task-1', 4),
      ],
      compactions: [],
      approvals: [approval],
      errors: [],
    })

    expect(timeline.map((item) => item.kind)).toEqual(['tools', 'approval', 'task'])
  })
})
