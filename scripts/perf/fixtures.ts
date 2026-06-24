import { projectSessionHistory } from '@open-cowork/runtime-host/session-history-projector'
import type { HistoryFixture } from './types.ts'

function createTextMessage(id: string, role: 'user' | 'assistant', text: string, created: number, extraParts: any[] = []) {
  return {
    info: {
      id,
      role,
      time: { created },
    },
    parts: [
      { id: `${id}:text`, type: 'text', text },
      ...extraParts,
    ],
  }
}

export function createHistoryFixture(): HistoryFixture {
  const sessionId = 'perf-root'
  const childCount = 8
  const rootMessageCount = 48
  const childMessagesPerSession = 14
  const rootMessages: any[] = []
  const rootTodos = [
    { id: 'root-todo-1', content: 'Scope the work', status: 'done', priority: 'high' },
    { id: 'root-todo-2', content: 'Summarize findings', status: 'in_progress', priority: 'medium' },
  ]
  const children = Array.from({ length: childCount }, (_, index) => ({
    id: `child-${index + 1}`,
    title: `Research topic ${index + 1}`,
    time: {
      created: 2_000 + index * 100,
      updated: 2_500 + index * 100,
    },
  }))
  const statuses: Record<string, any> = {
    [sessionId]: { type: 'idle' },
  }
  const childSnapshots = new Map<string, { messages: any[]; todos: any[] }>()

  for (const child of children) {
    statuses[child.id] = { type: 'idle' }
  }

  let childCursor = 0
  for (let index = 0; index < rootMessageCount; index += 1) {
    const created = 1_000 + index * 100
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const parts: any[] = []

    if (childCursor < childCount && index % 6 === 1) {
      parts.push({
        id: `subtask-${childCursor + 1}`,
        type: 'subtask',
        agent: childCursor % 2 === 0 ? 'research' : 'engineer',
        description: `Investigate topic ${childCursor + 1}`,
      })
      childCursor += 1
    }

    if (index % 4 === 0) {
      parts.push({
        id: `tool-${index}`,
        type: 'tool',
        tool: 'fetch',
        state: {
          input: { url: `https://example.com/${index}` },
          output: { ok: true, index },
          metadata: { agent: 'assistant' },
        },
      })
    }

    if (index % 5 === 0) {
      parts.push({
        id: `cost-${index}`,
        type: 'step-finish',
        tokens: {
          input: 120 + index,
          output: 40 + index,
          reasoning: 10,
          cache: { read: 5, write: 1 },
        },
        cost: 0.02 + index / 10_000,
      })
    }

    if (index % 12 === 0) {
      parts.push({
        id: `compact-${index}`,
        type: 'compaction',
        auto: true,
        overflow: index % 24 === 0,
      })
    }

    rootMessages.push(createTextMessage(
      `root-msg-${index + 1}`,
      role,
      `${role === 'user' ? 'Request' : 'Response'} ${index + 1}: evaluate the current system and summarize the next step.`,
      created,
      parts,
    ))
  }

  for (const [childIndex, child] of children.entries()) {
    const messages: any[] = []
    for (let index = 0; index < childMessagesPerSession; index += 1) {
      const created = 5_000 + childIndex * 1_000 + index * 100
      const role = index === 0 ? 'user' : 'assistant'
      const parts: any[] = []

      if (index === 1) {
        parts.push({ id: `${child.id}:agent`, type: 'agent', name: childIndex % 2 === 0 ? 'research' : 'engineer' })
      }

      if (index % 3 === 0) {
        parts.push({
          id: `${child.id}:tool:${index}`,
          type: 'tool',
          tool: 'fetch',
          title: `Inspect source ${index}`,
          state: {
            input: { url: `https://example.com/${child.id}/${index}` },
            output: { ok: true, child: child.id, index },
            metadata: { agent: childIndex % 2 === 0 ? 'research' : 'engineer' },
          },
          metadata: { agent: childIndex % 2 === 0 ? 'research' : 'engineer' },
        })
      }

      parts.push({
        id: `${child.id}:finish:${index}`,
        type: 'step-finish',
        tokens: {
          input: 30 + index,
          output: 18 + index,
          reasoning: 6,
          cache: { read: 2, write: 0 },
        },
        cost: 0.01 + index / 20_000,
        ...(index === childMessagesPerSession - 1 ? { reason: 'stop' } : {}),
      })

      messages.push(createTextMessage(
        `${child.id}:msg:${index + 1}`,
        role,
        `${role === 'user' ? 'Task' : 'Finding'} ${index + 1} for ${child.title}.`,
        created,
        parts,
      ))
    }

    childSnapshots.set(child.id, {
      messages,
      todos: [
        { id: `${child.id}:todo:1`, content: `Investigate ${child.title}`, status: 'done', priority: 'high' },
        { id: `${child.id}:todo:2`, content: 'Publish summary', status: 'done', priority: 'medium' },
      ],
    })
  }

  return {
    sessionId,
    cachedModelId: 'databricks-claude-sonnet-4',
    rootMessages,
    rootTodos,
    children,
    statuses,
    childSnapshots,
  }
}

export async function buildProjectedHistory(fixture: HistoryFixture) {
  return projectSessionHistory({
    sessionId: fixture.sessionId,
    cachedModelId: fixture.cachedModelId,
    rootMessages: fixture.rootMessages,
    rootTodos: fixture.rootTodos,
    children: fixture.children,
    statuses: fixture.statuses,
    loadChildSnapshot: async (childId: string) => {
      return fixture.childSnapshots.get(childId) || { messages: [], todos: [] }
    },
  })
}

export function createStreamEvents(sessionId: string) {
  const events: Array<{ sessionId: string; data: Record<string, unknown> }> = []
  events.push({ sessionId, data: { type: 'busy' } })
  events.push({ sessionId, data: { type: 'agent', name: 'assistant' } })

  for (let taskIndex = 0; taskIndex < 6; taskIndex += 1) {
    const taskRunId = `task-${taskIndex + 1}`
    const childId = `child-${taskIndex + 1}`
    events.push({
      sessionId,
      data: {
        type: 'task_run',
        id: taskRunId,
        title: `Investigate area ${taskIndex + 1}`,
        agent: taskIndex % 2 === 0 ? 'research' : 'engineer',
        status: 'running',
        sourceSessionId: childId,
      },
    })

    for (let chunkIndex = 0; chunkIndex < 40; chunkIndex += 1) {
      events.push({
        sessionId,
        data: {
          type: 'text',
          role: 'assistant',
          messageId: 'assistant-live',
          partId: 'assistant-live:part:1',
          content: `root chunk ${taskIndex}-${chunkIndex} `,
          mode: 'append',
        },
      })
      events.push({
        sessionId,
        data: {
          type: 'text',
          taskRunId,
          messageId: `${taskRunId}:assistant`,
          partId: `${taskRunId}:assistant:part:1`,
          content: `task chunk ${taskIndex}-${chunkIndex} `,
          mode: 'append',
        },
      })

      if (chunkIndex % 5 === 0) {
        events.push({
          sessionId,
          data: {
            type: 'tool_call',
            id: `${taskRunId}:tool:${chunkIndex}`,
            taskRunId,
            name: 'fetch',
            input: { query: `doc-${chunkIndex}` },
            status: 'complete',
            output: { ok: true, chunkIndex },
            agent: taskIndex % 2 === 0 ? 'research' : 'engineer',
            sourceSessionId: childId,
          },
        })
      }

      if (chunkIndex % 10 === 0) {
        events.push({
          sessionId,
          data: {
            type: 'todos',
            taskRunId,
            todos: [
              { id: `${taskRunId}:todo:1`, content: 'Inspect source', status: 'done', priority: 'high' },
              { id: `${taskRunId}:todo:2`, content: 'Write summary', status: chunkIndex < 30 ? 'in_progress' : 'done', priority: 'medium' },
            ],
          },
        })
      }

      if (chunkIndex % 4 === 0) {
        events.push({
          sessionId,
          data: {
            type: 'cost',
            taskRunId,
            cost: 0.005,
            tokens: {
              input: 45,
              output: 20,
              reasoning: 4,
              cache: { read: 2, write: 0 },
            },
          },
        })
      }
    }

    events.push({
      sessionId,
      data: {
        type: 'compaction',
        taskRunId,
        id: `${taskRunId}:compaction`,
        auto: true,
        overflow: false,
        sourceSessionId: childId,
      },
    })
    events.push({
      sessionId,
      data: {
        type: 'compacted',
        taskRunId,
        id: `${taskRunId}:compaction`,
        auto: true,
        overflow: false,
        sourceSessionId: childId,
      },
    })
    events.push({
      sessionId,
      data: {
        type: 'task_run',
        id: taskRunId,
        title: `Investigate area ${taskIndex + 1}`,
        agent: taskIndex % 2 === 0 ? 'research' : 'engineer',
        status: 'complete',
        sourceSessionId: childId,
      },
    })
  }

  events.push({
    sessionId,
    data: {
      type: 'todos',
      todos: [
        { id: 'root:todo:1', content: 'Coordinate sub-work', status: 'done', priority: 'high' },
        { id: 'root:todo:2', content: 'Produce final answer', status: 'in_progress', priority: 'high' },
      ],
    },
  })
  events.push({ sessionId, data: { type: 'done' } })
  return events
}
