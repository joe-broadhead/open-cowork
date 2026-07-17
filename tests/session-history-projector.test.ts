import { projectSessionHistory } from '@open-cowork/runtime-host/session-history-projector'
import { buildSessionStateFromItems } from '@open-cowork/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
function textMessage(id: string, role: 'user' | 'assistant', text: string, created = 1) {
  return {
    info: {
      id,
      role,
      time: { created },
    },
    parts: [
      { id: `${id}:part:1`, type: 'text', text },
    ],
  }
}

function median(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] || 0
}

test('history projector keeps child task running when the child is idle but has not emitted a terminal stop', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-1',
    cachedModelId: 'databricks-claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-msg-1', role: 'assistant', time: { created: 1 } },
        parts: [
          { id: 'subtask-1', type: 'subtask', agent: 'general', description: 'Check the docs' },
        ],
      },
    ],
    rootTodos: [],
    children: [{ id: 'child-1', title: 'Research docs', time: { created: 2 } }],
    statuses: {
      'root-1': { type: 'busy' },
      'child-1': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [textMessage('child-msg-1', 'assistant', 'Looking into it', 2)],
      todos: [],
    }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')
  assert.ok(taskRun?.taskRun)
  assert.equal(taskRun.taskRun?.status, 'running')
})

test('history projector restores root and child V2 session errors on reopen', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-v2-error',
    cachedModelId: 'openai/gpt-5',
    rootMessages: [
      {
        info: { id: 'root-delegation', role: 'assistant', time: { created: 1 } },
        parts: [
          { id: 'root-subtask', type: 'subtask', agent: 'general', description: 'Run failing child' },
        ],
      },
      {
        id: 'root-error-message',
        type: 'assistant',
        time: { created: 4, completed: 5 },
        agent: 'build',
        model: { providerID: 'openai', id: 'gpt-5' },
        error: { type: 'unknown', message: 'root runtime failed' },
        content: [],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-v2-error',
      title: 'Run failing child',
      parentSessionId: 'root-v2-error',
      time: { created: 2, updated: 3 },
    }],
    statuses: {
      'root-v2-error': { type: 'idle' },
      'child-v2-error': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [{
        id: 'child-error-message',
        type: 'assistant',
        time: { created: 2, completed: 3 },
        agent: 'general',
        model: { providerID: 'openai', id: 'gpt-5-mini' },
        error: { type: 'unknown', message: 'child runtime failed' },
        content: [],
      }],
      todos: [],
    }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')
  assert.equal(taskRun?.taskRun?.status, 'error')
  assert.equal(taskRun?.taskRun?.error, 'child runtime failed')
  const errorItems = items.filter((item) => item.type === 'error')
  assert.deepEqual(
    errorItems.map((item) => [item.error?.sessionId, item.error?.message]),
    [
      ['child-v2-error', 'child runtime failed'],
      ['root-v2-error', 'root runtime failed'],
    ],
  )

  const reopened = buildSessionStateFromItems(items)
  assert.equal(reopened.taskRuns[0]?.status, 'error')
  assert.equal(reopened.taskRuns[0]?.error, 'child runtime failed')
  assert.deepEqual(
    reopened.errors.map((error) => [error.sessionId, error.message]),
    [
      ['child-v2-error', 'child runtime failed'],
      ['root-v2-error', 'root runtime failed'],
    ],
  )
})

test('history projector preserves native V2 tool attachments and output paths on reopen', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-native-tool',
    cachedModelId: 'openai/gpt-5',
    rootMessages: [{
      id: 'assistant-native-tool',
      type: 'assistant',
      time: { created: 1, completed: 2 },
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-5' },
      content: [{
        id: 'tool-native-1',
        type: 'tool',
        name: 'write',
        state: {
          status: 'completed',
          input: { path: '/workspace/report.md' },
          content: [
            { type: 'text', text: 'created' },
            { type: 'file', uri: 'file:///workspace/report.md', mime: 'text/markdown', name: 'report.md' },
          ],
          outputPaths: ['/workspace/report.md'],
        },
      }],
    }],
    rootTodos: [],
    children: [],
    statuses: { 'root-native-tool': { type: 'idle' } },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const tool = items.find((item) => item.type === 'tool')?.tool
  assert.deepEqual(tool?.output, [
    'created',
    { type: 'file', uri: 'file:///workspace/report.md', mime: 'text/markdown', name: 'report.md' },
  ])
  assert.deepEqual(tool?.attachments, [
    { mime: 'text/markdown', url: 'file:///workspace/report.md', filename: 'report.md' },
  ])
  assert.deepEqual(tool?.outputPaths, ['/workspace/report.md'])

  const reopened = buildSessionStateFromItems(items)
  assert.deepEqual(reopened.toolCalls[0]?.attachments, [
    { mime: 'text/markdown', url: 'file:///workspace/report.md', filename: 'report.md' },
  ])
  assert.deepEqual(reopened.toolCalls[0]?.outputPaths, ['/workspace/report.md'])
})

test('history projector uses a stable fallback timestamp for incomplete history', async () => {
  const fallbackTimestampMs = Date.parse('2026-02-03T04:05:06.000Z')
  const input = {
    sessionId: 'root-incomplete',
    cachedModelId: 'databricks-claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-msg-incomplete', role: 'assistant', time: {} },
        parts: [
          { id: 'root-text-incomplete', type: 'text', text: 'Starting' },
          { id: 'root-task-incomplete', type: 'subtask', agent: 'general', description: 'Check missing times' },
        ],
      },
    ],
    rootTodos: [],
    children: [{ id: 'child-incomplete', title: 'Missing child timestamps' }],
    statuses: {
      'root-incomplete': { type: 'busy' },
      'child-incomplete': { type: 'idle' },
    },
    fallbackTimestampMs,
    loadChildSnapshot: async () => ({
      messages: [
        {
          info: { id: 'child-msg-incomplete', role: 'assistant', time: {} },
          parts: [
            { id: 'child-text-incomplete', type: 'text', text: 'Still missing times' },
          ],
        },
      ],
      todos: [],
    }),
  }

  const first = await projectSessionHistory(input)
  const originalDateNow = Date.now
  Date.now = () => Date.parse('2036-02-03T04:05:06.000Z')
  try {
    assert.deepEqual(await projectSessionHistory(input), first)
  } finally {
    Date.now = originalDateNow
  }

  assert.equal(first.find((item) => item.type === 'message')?.timestamp, '2026-02-03T04:05:06.000Z')
  assert.equal(first.find((item) => item.type === 'task_run')?.timestamp, '2026-02-03T04:05:06.000Z')
  assert.equal(first.find((item) => item.type === 'task_text')?.timestamp, '2026-02-03T04:05:06.000Z')
})

test('history projector marks child task complete after a terminal step-finish stop', async () => {
  const created = 1_713_714_000
  const updated = created + 3
  const items = await projectSessionHistory({
    sessionId: 'root-1',
    cachedModelId: 'databricks-claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-msg-1', role: 'assistant', time: { created: 1 } },
        parts: [
          { id: 'subtask-1', type: 'subtask', agent: 'general', description: 'Check the docs' },
        ],
      },
    ],
    rootTodos: [],
    children: [{ id: 'child-1', title: 'Research docs', time: { created, updated } }],
    statuses: {
      'root-1': { type: 'idle' },
      'child-1': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [
        {
          info: { id: 'child-msg-1', role: 'assistant', time: { created: 2 } },
          parts: [
            { id: 'child-msg-1:part:1', type: 'text', text: 'Done' },
            { id: 'finish-1', type: 'step-finish', reason: 'stop', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
          ],
        },
      ],
      todos: [],
    }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')
  assert.ok(taskRun?.taskRun)
  assert.equal(taskRun.taskRun?.status, 'complete')
  assert.equal(taskRun.taskRun?.startedAt, '2024-04-21T15:40:00.000Z')
  assert.equal(taskRun.taskRun?.finishedAt, '2024-04-21T15:40:03.000Z')

  const taskText = items.find((item) => item.type === 'task_text')
  assert.equal(taskText?.content, 'Done')
})

test('history projector projects reasoning separately from visible text', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-reasoning',
    cachedModelId: 'openrouter/deepseek/deepseek-v4-pro',
    rootMessages: [
      {
        info: { id: 'root-msg-reasoning', role: 'assistant', time: { created: 1 } },
        parts: [
          { id: 'reasoning-1', type: 'reasoning', text: 'Internal comparison table' },
          { id: 'text-1', type: 'text', text: 'Final answer' },
        ],
      },
      {
        info: { id: 'root-msg-child', role: 'assistant', time: { created: 2 } },
        parts: [
          { id: 'subtask-reasoning', type: 'subtask', agent: 'research', description: 'Research it' },
        ],
      },
    ],
    rootTodos: [],
    children: [{ id: 'child-reasoning', title: 'Research it', parentSessionId: 'root-reasoning', time: { created: 3, updated: 4 } }],
    statuses: {
      'root-reasoning': { type: 'idle' },
      'child-reasoning': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [
        {
          info: { id: 'child-msg-reasoning', role: 'assistant', time: { created: 3 } },
          parts: [
            { id: 'child-reasoning-1', type: 'reasoning', text: 'Child internal notes' },
            { id: 'child-text-1', type: 'text', text: 'Child final notes' },
            { id: 'child-finish-1', type: 'step-finish', reason: 'stop' },
          ],
        },
      ],
      todos: [],
    }),
  })

  const visibleMessages = items.filter((item) => item.type === 'message')
  const rootReasoning = items.find((item) => item.type === 'message_reasoning')
  const taskText = items.find((item) => item.type === 'task_text')
  const taskReasoning = items.find((item) => item.type === 'task_reasoning')

  assert.equal(visibleMessages.some((item) => item.content === 'Internal comparison table'), false)
  assert.equal(rootReasoning?.content, 'Internal comparison table')
  assert.equal(taskText?.content, 'Child final notes')
  assert.equal(taskReasoning?.content, 'Child internal notes')
})

test('history projector treats provider-specific final step-finish reasons as terminal', async () => {
  const created = 1_713_714_000
  const updated = created + 9
  const items = await projectSessionHistory({
    sessionId: 'root-provider-finish',
    cachedModelId: 'openrouter/deepseek/deepseek-v4-pro',
    rootMessages: [
      {
        info: { id: 'root-msg-provider-finish', role: 'assistant', time: { created: 1 } },
        parts: [
          { id: 'subtask-provider-finish', type: 'subtask', agent: 'research', description: 'Research provider finish reason' },
        ],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-provider-finish',
      title: 'Research provider finish reason (@research subagent)',
      parentSessionId: 'root-provider-finish',
      time: { created, updated },
    }],
    // The SDK status snapshot may omit already-idle sessions after a refresh.
    // Completion should still hydrate from the child transcript's final step.
    statuses: {},
    loadChildSnapshot: async () => ({
      messages: [
        {
          info: { id: 'child-provider-msg-1', role: 'assistant', time: { created: 2 } },
          parts: [
            { id: 'child-provider-text-1', type: 'text', text: 'I found the answer.' },
            { id: 'child-provider-finish-1', type: 'step-finish', reason: 'other', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
          ],
        },
      ],
      todos: [],
    }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')
  assert.ok(taskRun?.taskRun)
  assert.equal(taskRun.taskRun?.status, 'complete')
  assert.equal(taskRun.taskRun?.finishedAt, '2024-04-21T15:40:09.000Z')
})

test('history projector keeps tool-call step finishes non-terminal', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-tool-calls',
    cachedModelId: 'openrouter/deepseek/deepseek-v4-pro',
    rootMessages: [
      {
        info: { id: 'root-msg-tool-calls', role: 'assistant', time: { created: 1 } },
        parts: [
          { id: 'subtask-tool-calls', type: 'subtask', agent: 'research', description: 'Research with tools' },
        ],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-tool-calls',
      title: 'Research with tools (@research subagent)',
      parentSessionId: 'root-tool-calls',
      time: { created: 2, updated: 5 },
    }],
    statuses: {},
    loadChildSnapshot: async () => ({
      messages: [
        {
          info: { id: 'child-tool-msg-1', role: 'assistant', time: { created: 2 } },
          parts: [
            { id: 'child-tool-finish-1', type: 'step-finish', reason: 'tool-calls', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
          ],
        },
      ],
      todos: [],
    }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')
  assert.ok(taskRun?.taskRun)
  assert.equal(taskRun.taskRun?.status, 'queued')
})

test('history projector skips question tool parts so they can be rendered through question state instead', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-2',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-msg-2', role: 'assistant', time: { created: 1 } },
      parts: [{
        id: 'question-part',
        type: 'tool',
        tool: 'question',
        state: {
          input: {
            questions: [{
              header: 'Engineering focus',
              question: 'What kind of work are you doing?',
              options: [{ label: 'Backend', description: 'APIs' }],
            }],
          },
        },
      }],
    }],
    rootTodos: [],
    children: [],
    statuses: {
      'root-2': { type: 'busy' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  assert.equal(items.some((item) => item.type === 'tool'), false)
})

test('history projector anchors root task tool runs before the parent follow-up response', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-task-msg', role: 'assistant', time: { created: 10 } },
        parts: [
          { id: 'root-task-text', type: 'text', text: 'I will delegate this to the analyst.' },
          {
            id: 'root-task-part',
            type: 'tool',
            tool: 'task',
            callID: 'task-call-1',
            state: {
              status: 'completed',
              input: {
                agent: 'business-analyst',
                description: 'UK website traffic and conversion analysis',
              },
              output: 'done',
              metadata: {},
            },
          },
          { id: 'root-task-finish', type: 'step-finish', reason: 'tool-calls' },
        ],
      },
      {
        info: { id: 'root-final-msg', role: 'assistant', time: { created: 30 } },
        parts: [
          { id: 'root-final-text', type: 'text', text: 'The analyst finished the work.' },
          { id: 'root-final-finish', type: 'step-finish', reason: 'stop' },
        ],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-analyst',
      title: 'UK website traffic and conversion analysis (@business-analyst subagent)',
      parentSessionId: 'root-task-tool',
      time: { created: 20, updated: 25 },
    }],
    statuses: {
      'root-task-tool': { type: 'idle' },
      'child-analyst': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [{
        info: { id: 'child-analyst-msg', role: 'assistant', time: { created: 22 } },
        parts: [
          { id: 'child-analyst-text', type: 'text', text: 'Analyst details.' },
          { id: 'child-analyst-finish', type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')
  const finalMessage = items.find((item) => item.messageId === 'root-final-msg' && item.type === 'message')

  assert.ok(taskRun?.taskRun)
  assert.equal(taskRun.id, 'child:child-analyst')
  assert.equal(taskRun.taskRun.agent, 'business-analyst')
  assert.equal(taskRun.taskRun.sourceSessionId, 'child-analyst')
  assert.equal(taskRun.taskRun.title, 'UK website traffic and conversion analysis')
  assert.equal(items.some((item) => item.type === 'tool' && item.id === 'task-call-1'), false)
  assert.ok(taskRun.sequence < (finalMessage?.sequence || 0))
})

test('history projector preserves task-tool binding before later subtask parts', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-mixed-delegation',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-mixed-msg', role: 'assistant', time: { created: 10 } },
      parts: [
        {
          id: 'root-mixed-task-tool',
          type: 'tool',
          tool: 'task',
          callID: 'mixed-task-call',
          state: {
            status: 'completed',
            input: {
              agent: 'analyst',
              description: 'Analyze first child',
            },
            output: 'done',
            metadata: {},
          },
        },
        { id: 'root-mixed-subtask', type: 'subtask', agent: 'research', description: 'Research second child' },
      ],
    }],
    rootTodos: [],
    children: [
      { id: 'child-first', title: 'First delegated child', parentSessionId: 'root-mixed-delegation', time: { created: 20, updated: 25 } },
      { id: 'child-second', title: 'Second delegated child', parentSessionId: 'root-mixed-delegation', time: { created: 21, updated: 26 } },
    ],
    statuses: {
      'root-mixed-delegation': { type: 'idle' },
      'child-first': { type: 'idle' },
      'child-second': { type: 'idle' },
    },
    loadChildSnapshot: async (childId) => ({
      messages: [{
        info: { id: `${childId}-msg`, role: 'assistant', time: { created: childId === 'child-first' ? 22 : 23 } },
        parts: [
          { id: `${childId}-text`, type: 'text', text: `${childId} result` },
          { id: `${childId}-finish`, type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const taskRuns = items
    .filter((item) => item.type === 'task_run')
    .map((item) => item.taskRun)
    .filter(Boolean)

  assert.deepEqual(
    taskRuns.map((taskRun) => ({ source: taskRun?.sourceSessionId, title: taskRun?.title })),
    [
      { source: 'child-first', title: 'Analyze first child' },
      { source: 'child-second', title: 'Research second child' },
    ],
  )
  assert.equal(items.find((item) => item.content === 'child-first result')?.taskRunId, 'child:child-first')
  assert.equal(items.find((item) => item.content === 'child-second result')?.taskRunId, 'child:child-second')
})

test('history projector binds task tool metadata session ids exactly once', async () => {
  const childIds = ['child-a', 'child-b', 'child-c']
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-metadata',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-metadata-task-msg', role: 'assistant', time: { created: 10 } },
      parts: childIds.map((childId, index) => ({
        id: `root-task-part-${index}`,
        type: 'tool',
        tool: 'task',
        callID: `task-call-${index}`,
        state: {
          status: 'completed',
          input: {
            agent: 'business-analyst',
            description: `Generic delegation ${index}`,
          },
          output: 'done',
          metadata: { sessionId: childId },
        },
      })),
    }],
    rootTodos: [],
    children: childIds.map((childId, index) => ({
      id: childId,
      title: `SDK child session ${index}`,
      parentSessionId: 'root-task-tool-metadata',
      time: { created: 20 + index, updated: 30 + index },
    })),
    statuses: {
      'root-task-tool-metadata': { type: 'idle' },
      'child-a': { type: 'idle' },
      'child-b': { type: 'idle' },
      'child-c': { type: 'idle' },
    },
    loadChildSnapshot: async (childId) => ({
      messages: [{
        info: { id: `${childId}-msg`, role: 'assistant', time: { created: 40 } },
        parts: [
          { id: `${childId}-text`, type: 'text', text: `${childId} result` },
          { id: `${childId}-finish`, type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const taskRuns = items.filter((item) => item.type === 'task_run')
  assert.equal(taskRuns.length, 3)
  assert.deepEqual(
    taskRuns.map((item) => item.id),
    ['child:child-a', 'child:child-b', 'child:child-c'],
  )
  assert.equal(taskRuns.some((item) => item.id.startsWith('pending:')), false)
  assert.deepEqual(
    taskRuns.map((item) => item.taskRun?.sourceSessionId),
    childIds,
  )
})

test('history projector binds parallel task tools to same-turn child sessions by order', async () => {
  const childIds = ['child-parallel-a', 'child-parallel-b']
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-parallel',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-parallel-task-msg', role: 'assistant', time: { created: 10 } },
      parts: [
        {
          id: 'root-parallel-task-a',
          type: 'tool',
          tool: 'task',
          callID: 'parallel-task-call-a',
          state: {
            status: 'completed',
            input: { agent: 'analyst', description: 'Analyze churn' },
            output: 'started',
            metadata: {},
          },
        },
        {
          id: 'root-parallel-task-b',
          type: 'tool',
          tool: 'task',
          callID: 'parallel-task-call-b',
          state: {
            status: 'completed',
            input: { agent: 'research', description: 'Research market' },
            output: 'started',
            metadata: {},
          },
        },
      ],
    }],
    rootTodos: [],
    children: childIds.map((childId, index) => ({
      id: childId,
      title: `Parallel child ${index + 1}`,
      parentSessionId: 'root-task-tool-parallel',
      time: { created: 11 + index, updated: 20 + index },
    })),
    statuses: {
      'root-task-tool-parallel': { type: 'idle' },
      'child-parallel-a': { type: 'idle' },
      'child-parallel-b': { type: 'idle' },
    },
    loadChildSnapshot: async (childId) => ({
      messages: [{
        info: { id: `${childId}-msg`, role: 'assistant', time: { created: 30 } },
        parts: [
          { id: `${childId}-text`, type: 'text', text: `${childId} result` },
          { id: `${childId}-finish`, type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const taskRuns = items.filter((item) => item.type === 'task_run')
  assert.equal(taskRuns.some((item) => item.id.startsWith('pending:')), false)
  assert.deepEqual(
    taskRuns.map((item) => item.taskRun?.sourceSessionId),
    childIds,
  )
  assert.deepEqual(
    taskRuns.map((item) => item.taskRun?.title),
    ['Analyze churn', 'Research market'],
  )
  assert.equal(items.find((item) => item.content === 'child-parallel-a result')?.taskRunId, 'child:child-parallel-a')
  assert.equal(items.find((item) => item.content === 'child-parallel-b result')?.taskRunId, 'child:child-parallel-b')
})

test('history projector reserves explicit task-tool children when binding implicit task tools', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-mixed-explicit',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-mixed-task-msg', role: 'assistant', time: { created: 10 } },
      parts: [
        {
          id: 'root-mixed-implicit-task',
          type: 'tool',
          tool: 'task',
          callID: 'mixed-implicit-call',
          state: {
            status: 'completed',
            input: { agent: 'analyst', description: 'Implicit child work' },
            output: 'started',
            metadata: {},
          },
        },
        {
          id: 'root-mixed-explicit-task',
          type: 'tool',
          tool: 'task',
          callID: 'mixed-explicit-call',
          state: {
            status: 'completed',
            input: { agent: 'research', description: 'Explicit child work' },
            output: 'started',
            metadata: { sessionId: 'child-mixed-explicit' },
          },
        },
      ],
    }],
    rootTodos: [],
    children: [
      {
        id: 'child-mixed-implicit',
        title: 'Implicit child work (@analyst subagent)',
        parentSessionId: 'root-task-tool-mixed-explicit',
        time: { created: 11, updated: 20 },
      },
      {
        id: 'child-mixed-explicit',
        title: 'Explicit child work (@research subagent)',
        parentSessionId: 'root-task-tool-mixed-explicit',
        time: { created: 12, updated: 21 },
      },
    ],
    statuses: {
      'root-task-tool-mixed-explicit': { type: 'idle' },
      'child-mixed-implicit': { type: 'idle' },
      'child-mixed-explicit': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const taskRuns = items.filter((item) => item.type === 'task_run')
  assert.equal(taskRuns.some((item) => item.id.startsWith('pending:')), false)
  assert.deepEqual(
    taskRuns.map((item) => item.taskRun?.sourceSessionId),
    ['child-mixed-implicit', 'child-mixed-explicit'],
  )
  assert.deepEqual(
    taskRuns.map((item) => item.taskRun?.title),
    ['Implicit child work', 'Explicit child work'],
  )
})

test('history projector binds an implicit task tool before a later subtask when only one child is present', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-partial-mixed',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-partial-mixed-msg', role: 'assistant', time: { created: 10 } },
      parts: [
        {
          id: 'root-partial-task',
          type: 'tool',
          tool: 'task',
          callID: 'partial-task-call',
          state: {
            status: 'completed',
            input: { agent: 'analyst', description: 'Partial task child' },
            output: 'started',
            metadata: {},
          },
        },
        {
          id: 'root-partial-subtask',
          type: 'subtask',
          agent: 'research',
          description: 'Missing later child',
        },
      ],
    }],
    rootTodos: [],
    children: [{
      id: 'child-partial-task',
      title: 'Partial task child (@analyst subagent)',
      parentSessionId: 'root-task-tool-partial-mixed',
      time: { created: 11, updated: 20 },
    }],
    statuses: {
      'root-task-tool-partial-mixed': { type: 'idle' },
      'child-partial-task': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const taskRuns = items.filter((item) => item.type === 'task_run')
  const taskToolRun = taskRuns.find((item) => item.id === 'child:child-partial-task')?.taskRun
  const pendingSubtask = taskRuns.find((item) => item.id === 'pending:root-partial-subtask')?.taskRun

  assert.ok(taskToolRun)
  assert.equal(taskToolRun.sourceSessionId, 'child-partial-task')
  assert.equal(taskToolRun.title, 'Partial task child')
  assert.ok(pendingSubtask)
  assert.equal(pendingSubtask.sourceSessionId, null)
  assert.equal(pendingSubtask.title, 'Missing later child')
})

test('history projector preserves mixed task-tool and subtask child order in one message', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-subtask-order',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-mixed-order-msg', role: 'assistant', time: { created: 10 } },
      parts: [
        {
          id: 'root-mixed-order-task',
          type: 'tool',
          tool: 'task',
          callID: 'mixed-order-task-call',
          state: {
            status: 'completed',
            input: { agent: 'analyst', description: 'First delegated child' },
            output: 'started',
            metadata: {},
          },
        },
        {
          id: 'root-mixed-order-subtask',
          type: 'subtask',
          agent: 'research',
          description: 'Second delegated child',
        },
      ],
    }],
    rootTodos: [],
    children: [
      {
        id: 'child-mixed-order-first',
        title: 'First delegated child (@analyst subagent)',
        parentSessionId: 'root-task-tool-subtask-order',
        time: { created: 11, updated: 20 },
      },
      {
        id: 'child-mixed-order-second',
        title: 'Second delegated child (@research subagent)',
        parentSessionId: 'root-task-tool-subtask-order',
        time: { created: 12, updated: 21 },
      },
    ],
    statuses: {
      'root-task-tool-subtask-order': { type: 'idle' },
      'child-mixed-order-first': { type: 'idle' },
      'child-mixed-order-second': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const taskRuns = items
    .filter((item) => item.type === 'task_run')
    .map((item) => item.taskRun)

  assert.deepEqual(
    taskRuns.map((taskRun) => taskRun?.sourceSessionId),
    ['child-mixed-order-first', 'child-mixed-order-second'],
  )
  assert.deepEqual(
    taskRuns.map((taskRun) => taskRun?.title),
    ['First delegated child', 'Second delegated child'],
  )
})

test('history projector does not let a missing subtask consume a later task-tool child', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-missing-subtask-slot',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-missing-subtask-slot-msg', role: 'assistant', time: { created: 10 } },
      parts: [
        {
          id: 'root-first-task-tool',
          type: 'tool',
          tool: 'task',
          callID: 'first-task-call',
          state: {
            status: 'completed',
            input: { agent: 'analyst', description: 'First delegated child' },
            output: 'started',
            metadata: {},
          },
        },
        {
          id: 'root-missing-subtask',
          type: 'subtask',
          agent: 'research',
          description: 'Missing middle child',
        },
        {
          id: 'root-later-task-tool',
          type: 'tool',
          tool: 'task',
          callID: 'later-task-call',
          state: {
            status: 'completed',
            input: { agent: 'writer', description: 'Later delegated child' },
            output: 'started',
            metadata: {},
          },
        },
      ],
    }],
    rootTodos: [],
    children: [
      {
        id: 'child-first-task-tool',
        title: 'First delegated child (@analyst subagent)',
        parentSessionId: 'root-task-tool-missing-subtask-slot',
        time: { created: 11, updated: 20 },
      },
      {
        id: 'child-later-task-tool',
        title: 'Later delegated child (@writer subagent)',
        parentSessionId: 'root-task-tool-missing-subtask-slot',
        time: { created: 12, updated: 21 },
      },
    ],
    statuses: {
      'root-task-tool-missing-subtask-slot': { type: 'idle' },
      'child-first-task-tool': { type: 'idle' },
      'child-later-task-tool': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const taskRuns = items
    .filter((item) => item.type === 'task_run')
    .map((item) => item.taskRun)

  assert.deepEqual(
    taskRuns.map((taskRun) => taskRun?.sourceSessionId),
    ['child-first-task-tool', null, 'child-later-task-tool'],
  )
  assert.deepEqual(
    taskRuns.map((taskRun) => taskRun?.title),
    ['First delegated child', 'Missing middle child', 'Later delegated child'],
  )
})

test('history projector does not bind a terminal task tool to a later unrelated child session', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-unrelated-child',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-failed-task-msg', role: 'assistant', time: { created: 10 } },
        parts: [
          {
            id: 'root-failed-task-part',
            type: 'tool',
            tool: 'task',
            callID: 'failed-task-call',
            state: {
              status: 'completed',
              input: {
                agent: 'business-analyst',
                description: 'Failed delegation attempt',
              },
              output: 'Delegation did not start.',
              metadata: {},
            },
          },
        ],
      },
      {
        info: { id: 'root-real-subtask-msg', role: 'assistant', time: { created: 20 } },
        parts: [
          { id: 'root-real-subtask', type: 'subtask', agent: 'research', description: 'Actual child work' },
        ],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-real',
      title: 'Actual child work (@research subagent)',
      parentSessionId: 'root-task-tool-unrelated-child',
      time: { created: 21, updated: 25 },
    }],
    statuses: {
      'root-task-tool-unrelated-child': { type: 'idle' },
      'child-real': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [{
        info: { id: 'child-real-msg', role: 'assistant', time: { created: 22 } },
        parts: [
          { id: 'child-real-text', type: 'text', text: 'Child result.' },
          { id: 'child-real-finish', type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const taskRuns = items.filter((item) => item.type === 'task_run')
  const failedTask = taskRuns.find((item) => item.id === 'pending:failed-task-call')?.taskRun
  const childTask = taskRuns.find((item) => item.id === 'child:child-real')?.taskRun

  assert.ok(failedTask)
  assert.equal(failedTask.status, 'complete')
  assert.equal(failedTask.sourceSessionId, null)
  assert.ok(childTask)
  assert.equal(childTask.sourceSessionId, 'child-real')
  assert.equal(childTask.title, 'Actual child work')
})

test('history projector does not bind task tools by fuzzy child title matches', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-later-child-match',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-task-msg', role: 'assistant', time: { created: 10 } },
        parts: [
          {
            id: 'root-task-part',
            type: 'tool',
            tool: 'task',
            callID: 'task-call-target',
            state: {
              status: 'completed',
              input: {
                agent: 'analyst',
                description: 'Target market analysis',
              },
              output: 'done',
              metadata: {},
            },
          },
        ],
      },
      {
        info: { id: 'root-subtask-msg', role: 'assistant', time: { created: 20 } },
        parts: [
          { id: 'root-subtask', type: 'subtask', agent: 'research', description: 'Earlier unrelated research' },
        ],
      },
    ],
    rootTodos: [],
    children: [
      {
        id: 'child-unrelated',
        title: 'Earlier unrelated research (@research subagent)',
        parentSessionId: 'root-task-tool-later-child-match',
        time: { created: 11, updated: 14 },
      },
      {
        id: 'child-target',
        title: 'Target market analysis (@analyst subagent)',
        parentSessionId: 'root-task-tool-later-child-match',
        time: { created: 12, updated: 18 },
      },
    ],
    statuses: {
      'root-task-tool-later-child-match': { type: 'idle' },
      'child-unrelated': { type: 'idle' },
      'child-target': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const pendingTask = items.find((item) => item.id === 'pending:task-call-target')?.taskRun
  const unrelatedTask = items.find((item) => item.id === 'child:child-unrelated')?.taskRun
  const targetTask = items.find((item) => item.id === 'child:child-target')?.taskRun

  assert.ok(pendingTask)
  assert.equal(pendingTask.sourceSessionId, null)
  assert.equal(pendingTask.title, 'Target market analysis')
  assert.equal(pendingTask.agent, 'analyst')
  assert.ok(unrelatedTask)
  assert.equal(unrelatedTask.sourceSessionId, 'child-unrelated')
  assert.equal(unrelatedTask.title, 'Earlier unrelated research')
  assert.ok(targetTask)
  assert.equal(targetTask.sourceSessionId, 'child-target')
  assert.equal(targetTask.title, 'Target market analysis')
})

test('history projector does not bind task tools across same-timestamp delegation boundaries', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-same-timestamp-boundary',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-first-task-msg', role: 'assistant', time: { created: 20 } },
        parts: [
          {
            id: 'root-first-task-part',
            type: 'tool',
            tool: 'task',
            callID: 'first-task-call',
            state: {
              status: 'completed',
              input: {
                agent: 'analyst',
                description: 'Earlier same timestamp delegation',
              },
              output: 'done',
              metadata: {},
            },
          },
        ],
      },
      {
        info: { id: 'root-second-subtask-msg', role: 'assistant', time: { created: 20 } },
        parts: [
          { id: 'root-second-subtask', type: 'subtask', agent: 'research', description: 'Later same timestamp delegation' },
        ],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-later-same-timestamp',
      title: 'Later same timestamp delegation (@research subagent)',
      parentSessionId: 'root-same-timestamp-boundary',
      time: { created: 21, updated: 24 },
    }],
    statuses: {
      'root-same-timestamp-boundary': { type: 'idle' },
      'child-later-same-timestamp': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const pendingTask = items.find((item) => item.id === 'pending:first-task-call')?.taskRun
  const childTask = items.find((item) => item.id === 'child:child-later-same-timestamp')?.taskRun

  assert.ok(pendingTask)
  assert.equal(pendingTask.sourceSessionId, null)
  assert.equal(pendingTask.title, 'Earlier same timestamp delegation')
  assert.ok(childTask)
  assert.equal(childTask.sourceSessionId, 'child-later-same-timestamp')
  assert.equal(childTask.title, 'Later same timestamp delegation')
})

test('history projector treats untimed later delegations as task-tool binding boundaries', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-untimed-boundary',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-earlier-task-msg', role: 'assistant', time: { created: 10 } },
        parts: [
          {
            id: 'root-earlier-task-part',
            type: 'tool',
            tool: 'task',
            callID: 'earlier-task-call',
            state: {
              status: 'completed',
              input: {
                agent: 'analyst',
                description: 'Earlier timed task tool',
              },
              output: 'done',
              metadata: {},
            },
          },
        ],
      },
      {
        info: { id: 'root-later-untimed-subtask-msg', role: 'assistant' },
        parts: [
          { id: 'root-later-untimed-subtask', type: 'subtask', agent: 'research', description: 'Later untimed delegation' },
        ],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-later-untimed-boundary',
      title: 'Later untimed delegation (@research subagent)',
      parentSessionId: 'root-untimed-boundary',
      time: { created: 11, updated: 14 },
    }],
    statuses: {
      'root-untimed-boundary': { type: 'idle' },
      'child-later-untimed-boundary': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const pendingTask = items.find((item) => item.id === 'pending:earlier-task-call')?.taskRun
  const childTask = items.find((item) => item.id === 'child:child-later-untimed-boundary')?.taskRun

  assert.ok(pendingTask)
  assert.equal(pendingTask.sourceSessionId, null)
  assert.equal(pendingTask.title, 'Earlier timed task tool')
  assert.ok(childTask)
  assert.equal(childTask.sourceSessionId, 'child-later-untimed-boundary')
  assert.equal(childTask.title, 'Later untimed delegation')
})

test('history projector binds earlier timed child before an untimed later delegation when another child remains', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-untimed-boundary-with-extra-child',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-extra-earlier-task-msg', role: 'assistant', time: { created: 10 } },
        parts: [
          {
            id: 'root-extra-earlier-task-part',
            type: 'tool',
            tool: 'task',
            callID: 'extra-earlier-task-call',
            state: {
              status: 'completed',
              input: {
                agent: 'analyst',
                description: 'Earlier timestamped task tool',
              },
              output: 'done',
              metadata: {},
            },
          },
        ],
      },
      {
        info: { id: 'root-extra-later-untimed-subtask-msg', role: 'assistant' },
        parts: [
          { id: 'root-extra-later-untimed-subtask', type: 'subtask', agent: 'research', description: 'Later untimed delegation with remaining child' },
        ],
      },
    ],
    rootTodos: [],
    children: [
      {
        id: 'child-extra-later-untimed',
        title: 'Later untimed delegation with remaining child (@research subagent)',
        parentSessionId: 'root-untimed-boundary-with-extra-child',
      },
      {
        id: 'child-extra-earlier-timed',
        title: 'Earlier timestamped task tool (@analyst subagent)',
        parentSessionId: 'root-untimed-boundary-with-extra-child',
        time: { created: 11, updated: 14 },
      },
    ],
    statuses: {
      'root-untimed-boundary-with-extra-child': { type: 'idle' },
      'child-extra-earlier-timed': { type: 'idle' },
      'child-extra-later-untimed': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const earlierTask = items.find((item) => item.id === 'child:child-extra-earlier-timed')?.taskRun
  const laterTask = items.find((item) => item.id === 'child:child-extra-later-untimed')?.taskRun

  assert.ok(earlierTask)
  assert.equal(earlierTask.sourceSessionId, 'child-extra-earlier-timed')
  assert.equal(earlierTask.title, 'Earlier timestamped task tool')
  assert.ok(laterTask)
  assert.equal(laterTask.sourceSessionId, 'child-extra-later-untimed')
  assert.equal(laterTask.title, 'Later untimed delegation with remaining child')
})

test('history projector does not bind bounded task tools to untimed later children', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-bounded-untimed-child',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-bounded-task-msg', role: 'assistant', time: { created: 10 } },
        parts: [{
          id: 'root-bounded-task-tool',
          type: 'tool',
          tool: 'task',
          callID: 'bounded-task-call',
          state: {
            status: 'completed',
            input: {
              agent: 'analyst',
              description: 'Earlier bounded task tool',
            },
            output: 'started',
            metadata: {},
          },
        }],
      },
      {
        info: { id: 'root-later-timed-subtask-msg', role: 'assistant', time: { created: 20 } },
        parts: [
          { id: 'root-later-timed-subtask', type: 'subtask', agent: 'research', description: 'Later timed delegation' },
        ],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-later-untimed',
      title: 'Later timed delegation (@research subagent)',
      parentSessionId: 'root-bounded-untimed-child',
    }],
    statuses: {
      'root-bounded-untimed-child': { type: 'idle' },
      'child-later-untimed': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const pendingTask = items.find((item) => item.id === 'pending:bounded-task-call')?.taskRun
  const childTask = items.find((item) => item.id === 'child:child-later-untimed')?.taskRun

  assert.ok(pendingTask)
  assert.equal(pendingTask.sourceSessionId, null)
  assert.equal(pendingTask.title, 'Earlier bounded task tool')
  assert.ok(childTask)
  assert.equal(childTask.sourceSessionId, 'child-later-untimed')
  assert.equal(childTask.title, 'Later timed delegation')
})

test('history projector binds task tools when the root message has no created timestamp', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-missing-time',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-missing-time-task-msg', role: 'assistant' },
      parts: [
        {
          id: 'root-missing-time-task-part',
          type: 'tool',
          tool: 'task',
          callID: 'missing-time-task-call',
          state: {
            status: 'completed',
            input: { agent: 'analyst', description: 'Analyze missing timestamp replay' },
            output: 'started',
            metadata: {},
          },
        },
      ],
    }],
    rootTodos: [],
    children: [{
      id: 'child-missing-time',
      title: 'Analyze missing timestamp replay (@analyst subagent)',
      parentSessionId: 'root-task-tool-missing-time',
      time: { created: 20, updated: 30 },
    }],
    statuses: {
      'root-task-tool-missing-time': { type: 'idle' },
      'child-missing-time': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')?.taskRun

  assert.ok(taskRun)
  assert.equal(taskRun.sourceSessionId, 'child-missing-time')
  assert.equal(taskRun.title, 'Analyze missing timestamp replay')
})

test('history projector binds task tools to child sessions with missing created timestamps', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-tool-child-missing-time',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-child-missing-time-task-msg', role: 'assistant', time: { created: 10 } },
      parts: [
        {
          id: 'root-child-missing-time-task-part',
          type: 'tool',
          tool: 'task',
          callID: 'child-missing-time-task-call',
          state: {
            status: 'completed',
            input: { agent: 'analyst', description: 'Analyze child missing timestamp replay' },
            output: 'started',
            metadata: {},
          },
        },
      ],
    }],
    rootTodos: [],
    children: [{
      id: 'child-without-created-time',
      title: 'Analyze child missing timestamp replay (@analyst subagent)',
      parentSessionId: 'root-task-tool-child-missing-time',
      time: { updated: 30 },
    }],
    statuses: {
      'root-task-tool-child-missing-time': { type: 'idle' },
      'child-without-created-time': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')?.taskRun

  assert.ok(taskRun)
  assert.equal(taskRun.sourceSessionId, 'child-without-created-time')
  assert.equal(taskRun.title, 'Analyze child missing timestamp replay')
})

test('history projector preserves root message part order around task tools', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-task-order',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-task-order-msg', role: 'assistant', time: { created: 10 } },
        parts: [
          { id: 'root-task-order-before', type: 'text', text: 'Before delegation.' },
          {
            id: 'root-task-order-part',
            type: 'tool',
            tool: 'task',
            callID: 'task-order-call',
            state: {
              status: 'completed',
              input: { agent: 'analyst', description: 'Analyze order' },
              output: 'done',
              metadata: {},
            },
          },
          { id: 'root-task-order-after', type: 'text', text: 'After delegation.' },
        ],
      },
    ],
    rootTodos: [],
    children: [{
      id: 'child-task-order',
      title: 'Analyze order (@analyst subagent)',
      parentSessionId: 'root-task-order',
      time: { created: 11, updated: 12 },
    }],
    statuses: {
      'root-task-order': { type: 'idle' },
      'child-task-order': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [{
        info: { id: 'child-task-order-msg', role: 'assistant', time: { created: 11 } },
        parts: [
          { id: 'child-task-order-text', type: 'text', text: 'Child done.' },
          { id: 'child-task-order-finish', type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const before = items.find((item) => item.type === 'message' && item.content === 'Before delegation.')
  const taskRun = items.find((item) => item.type === 'task_run')
  const after = items.find((item) => item.type === 'message' && item.content === 'After delegation.')

  assert.ok(before?.sequence)
  assert.ok(taskRun?.sequence)
  assert.ok(after?.sequence)
  assert.ok(before.sequence < taskRun.sequence)
  assert.ok(taskRun.sequence < after.sequence)
})

test('history projector preserves child transcript order around tool calls', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-child-order',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-child-order-msg', role: 'assistant', time: { created: 1 } },
      parts: [
        { id: 'subtask-child-order', type: 'subtask', agent: 'analyst', description: 'Check child ordering' },
      ],
    }],
    rootTodos: [],
    children: [{
      id: 'child-order',
      title: 'Check child ordering (@analyst subagent)',
      parentSessionId: 'root-child-order',
      time: { created: 2, updated: 4 },
    }],
    statuses: {
      'root-child-order': { type: 'idle' },
      'child-order': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [{
        info: { id: 'child-order-msg', role: 'assistant', time: { created: 2 } },
        parts: [
          { id: 'child-order-before', type: 'text', text: 'Before tool.' },
          {
            id: 'child-order-tool',
            type: 'tool',
            tool: 'read',
            callID: 'child-order-read',
            state: {
              input: { filePath: 'README.md' },
              output: 'ok',
              metadata: {},
            },
          },
          { id: 'child-order-after', type: 'text', text: 'After tool.' },
          { id: 'child-order-finish', type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const before = items.find((item) => item.type === 'task_text' && item.content === 'Before tool.')
  const tool = items.find((item) => item.type === 'task_tool' && item.id === 'child-order-read')
  const after = items.find((item) => item.type === 'task_text' && item.content === 'After tool.')

  assert.ok(before?.sequence)
  assert.ok(tool?.sequence)
  assert.ok(after?.sequence)
  assert.ok(before.sequence < tool.sequence)
  assert.ok(tool.sequence < after.sequence)
})

test('history projector binds nested task tools to grandchild sessions during replay', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-nested-task-tool',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-nested-task-msg', role: 'assistant', time: { created: 1 } },
      parts: [
        { id: 'root-nested-subtask', type: 'subtask', agent: 'research', description: 'Investigate nested delegation' },
      ],
    }],
    rootTodos: [],
    children: [
      {
        id: 'child-nested-parent',
        title: 'Investigate nested delegation (@research subagent)',
        parentSessionId: 'root-nested-task-tool',
        time: { created: 2, updated: 8 },
      },
      {
        id: 'grandchild-nested-task',
        title: 'Deep dive into nested delegation (@analyst subagent)',
        parentSessionId: 'child-nested-parent',
        time: { created: 4, updated: 7 },
      },
    ],
    statuses: {
      'root-nested-task-tool': { type: 'idle' },
      'child-nested-parent': { type: 'idle' },
      'grandchild-nested-task': { type: 'idle' },
    },
    loadChildSnapshot: async (childId) => {
      if (childId === 'child-nested-parent') {
        return {
          messages: [{
            info: { id: 'child-nested-parent-msg', role: 'assistant', time: { created: 3 } },
            parts: [
              { id: 'child-nested-before', type: 'text', text: 'Before nested delegation.' },
              {
                id: 'child-nested-task-part',
                type: 'tool',
                tool: 'task',
                callID: 'nested-task-call',
                title: 'Nested explicit metadata delegation',
                state: {
                  status: 'completed',
                  input: {
                    agent: 'analyst',
                    description: 'Nested explicit metadata delegation',
                    prompt: 'Nested explicit metadata delegation',
                  },
                  output: 'started',
                  metadata: { sessionId: 'grandchild-nested-task' },
                },
              },
              { id: 'child-nested-after', type: 'text', text: 'After nested delegation.' },
              { id: 'child-nested-finish', type: 'step-finish', reason: 'stop' },
            ],
          }],
          todos: [],
        }
      }

      return {
        messages: [{
          info: { id: 'grandchild-nested-task-msg', role: 'assistant', time: { created: 5 } },
          parts: [
            { id: 'grandchild-nested-text', type: 'text', text: 'Nested analysis complete.' },
            { id: 'grandchild-nested-finish', type: 'step-finish', reason: 'stop' },
          ],
        }],
        todos: [],
      }
    },
  })

  const nestedTaskRuns = items.filter((item) => item.type === 'task_run' && item.taskRun?.sourceSessionId === 'grandchild-nested-task')
  const nestedTool = items.find((item) => item.type === 'task_tool' && item.id === 'nested-task-call')
  const before = items.find((item) => item.type === 'task_text' && item.content === 'Before nested delegation.')
  const nestedRun = nestedTaskRuns[0]
  const after = items.find((item) => item.type === 'task_text' && item.content === 'After nested delegation.')
  const nestedText = items.find((item) => item.type === 'task_text' && item.content === 'Nested analysis complete.')

  assert.equal(nestedTaskRuns.length, 1)
  assert.equal(nestedRun?.id, 'child:grandchild-nested-task')
  assert.equal(nestedRun?.taskRun?.parentSessionId, 'child-nested-parent')
  assert.equal(nestedRun?.taskRun?.agent, 'analyst')
  assert.equal(nestedTool, undefined)
  assert.ok(before?.sequence)
  assert.ok(nestedRun?.sequence)
  assert.ok(after?.sequence)
  assert.ok(nestedText?.sequence)
  assert.ok(before.sequence < nestedRun.sequence)
  assert.ok(nestedRun.sequence < after.sequence)
  assert.equal(nestedText.taskRunId, 'child:grandchild-nested-task')
})

test('history projector binds nested parallel task tools to grandchildren by order', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-nested-parallel-task-tool',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-nested-parallel-msg', role: 'assistant', time: { created: 1 } },
      parts: [
        { id: 'root-nested-parallel-subtask', type: 'subtask', agent: 'research', description: 'Coordinate nested parallel work' },
      ],
    }],
    rootTodos: [],
    children: [
      {
        id: 'child-nested-parallel-parent',
        title: 'Coordinate nested parallel work (@research subagent)',
        parentSessionId: 'root-nested-parallel-task-tool',
        time: { created: 2, updated: 8 },
      },
      {
        id: 'grandchild-nested-parallel-a',
        title: 'Nested parallel A (@analyst subagent)',
        parentSessionId: 'child-nested-parallel-parent',
        time: { created: 4, updated: 7 },
      },
      {
        id: 'grandchild-nested-parallel-b',
        title: 'Nested parallel B (@writer subagent)',
        parentSessionId: 'child-nested-parallel-parent',
        time: { created: 5, updated: 8 },
      },
    ],
    statuses: {
      'root-nested-parallel-task-tool': { type: 'idle' },
      'child-nested-parallel-parent': { type: 'idle' },
      'grandchild-nested-parallel-a': { type: 'idle' },
      'grandchild-nested-parallel-b': { type: 'idle' },
    },
    loadChildSnapshot: async (childId) => {
      if (childId === 'child-nested-parallel-parent') {
        return {
          messages: [{
            info: { id: 'child-nested-parallel-parent-msg', role: 'assistant', time: { created: 3 } },
            parts: [
              {
                id: 'child-nested-parallel-task-a',
                type: 'tool',
                tool: 'task',
                callID: 'nested-parallel-call-a',
                state: {
                  status: 'completed',
                  input: { agent: 'analyst', description: 'Nested parallel A' },
                  output: 'started',
                  metadata: {},
                },
              },
              {
                id: 'child-nested-parallel-task-b',
                type: 'tool',
                tool: 'task',
                callID: 'nested-parallel-call-b',
                state: {
                  status: 'completed',
                  input: { agent: 'writer', description: 'Nested parallel B' },
                  output: 'started',
                  metadata: {},
                },
              },
              { id: 'child-nested-parallel-finish', type: 'step-finish', reason: 'stop' },
            ],
          }],
          todos: [],
        }
      }

      return {
        messages: [{
          info: { id: `${childId}-msg`, role: 'assistant', time: { created: 6 } },
          parts: [
            { id: `${childId}-text`, type: 'text', text: `${childId} result` },
            { id: `${childId}-finish`, type: 'step-finish', reason: 'stop' },
          ],
        }],
        todos: [],
      }
    },
  })

  const nestedTaskRuns = items
    .filter((item) => item.type === 'task_run')
    .map((item) => item.taskRun)
    .filter((taskRun) => taskRun?.parentSessionId === 'child-nested-parallel-parent')

  assert.deepEqual(
    nestedTaskRuns.map((taskRun) => taskRun?.sourceSessionId),
    ['grandchild-nested-parallel-a', 'grandchild-nested-parallel-b'],
  )
  assert.deepEqual(
    nestedTaskRuns.map((taskRun) => taskRun?.title),
    ['Nested parallel A', 'Nested parallel B'],
  )
  assert.equal(items.find((item) => item.content === 'grandchild-nested-parallel-a result')?.taskRunId, 'child:grandchild-nested-parallel-a')
  assert.equal(items.find((item) => item.content === 'grandchild-nested-parallel-b result')?.taskRunId, 'child:grandchild-nested-parallel-b')
})

test('history projector reserves explicit nested task-tool grandchildren when binding implicit nested task tools', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-nested-mixed-task-tool',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-nested-mixed-msg', role: 'assistant', time: { created: 1 } },
      parts: [
        { id: 'root-nested-mixed-subtask', type: 'subtask', agent: 'research', description: 'Coordinate nested mixed work' },
      ],
    }],
    rootTodos: [],
    children: [
      {
        id: 'child-nested-mixed-parent',
        title: 'Coordinate nested mixed work (@research subagent)',
        parentSessionId: 'root-nested-mixed-task-tool',
        time: { created: 2, updated: 8 },
      },
      {
        id: 'grandchild-nested-mixed-implicit',
        title: 'Nested implicit work (@analyst subagent)',
        parentSessionId: 'child-nested-mixed-parent',
        time: { created: 4, updated: 7 },
      },
      {
        id: 'grandchild-nested-mixed-explicit',
        title: 'Nested explicit work (@writer subagent)',
        parentSessionId: 'child-nested-mixed-parent',
        time: { created: 5, updated: 8 },
      },
    ],
    statuses: {
      'root-nested-mixed-task-tool': { type: 'idle' },
      'child-nested-mixed-parent': { type: 'idle' },
      'grandchild-nested-mixed-implicit': { type: 'idle' },
      'grandchild-nested-mixed-explicit': { type: 'idle' },
    },
    loadChildSnapshot: async (childId) => {
      if (childId === 'child-nested-mixed-parent') {
        return {
          messages: [{
            info: { id: 'child-nested-mixed-parent-msg', role: 'assistant', time: { created: 3 } },
            parts: [
              {
                id: 'child-nested-mixed-implicit-task',
                type: 'tool',
                tool: 'task',
                callID: 'nested-mixed-implicit-call',
                state: {
                  status: 'completed',
                  input: { agent: 'analyst', description: 'Nested implicit work' },
                  output: 'started',
                  metadata: {},
                },
              },
              {
                id: 'child-nested-mixed-explicit-task',
                type: 'tool',
                tool: 'task',
                callID: 'nested-mixed-explicit-call',
                state: {
                  status: 'completed',
                  input: { agent: 'writer', description: 'Nested explicit work' },
                  output: 'started',
                  metadata: { sessionId: 'grandchild-nested-mixed-explicit' },
                },
              },
              { id: 'child-nested-mixed-finish', type: 'step-finish', reason: 'stop' },
            ],
          }],
          todos: [],
        }
      }

      return { messages: [], todos: [] }
    },
  })

  const nestedTaskRuns = items
    .filter((item) => item.type === 'task_run')
    .map((item) => item.taskRun)
    .filter((taskRun) => taskRun?.parentSessionId === 'child-nested-mixed-parent')

  assert.deepEqual(
    nestedTaskRuns.map((taskRun) => taskRun?.sourceSessionId),
    ['grandchild-nested-mixed-implicit', 'grandchild-nested-mixed-explicit'],
  )
  assert.deepEqual(
    nestedTaskRuns.map((taskRun) => taskRun?.title),
    ['Nested implicit work', 'Nested explicit work'],
  )
})

test('history projector preserves nested child parentage when replaying reopened threads', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-3',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-msg-3', role: 'assistant', time: { created: 1 } },
      parts: [
        { id: 'subtask-root-a', type: 'subtask', agent: 'research', description: 'Investigate A' },
        { id: 'subtask-root-b', type: 'subtask', agent: 'writer', description: 'Investigate B' },
      ],
    }],
    rootTodos: [],
    children: [
      { id: 'child-a', title: 'Investigate A', parentSessionId: 'root-3', time: { created: 2, updated: 6 } },
      { id: 'grandchild-a1', title: 'Deep dive A1', parentSessionId: 'child-a', time: { created: 3, updated: 5 } },
      { id: 'child-b', title: 'Investigate B', parentSessionId: 'root-3', time: { created: 4, updated: 7 } },
    ],
    statuses: {
      'root-3': { type: 'idle' },
      'child-a': { type: 'idle' },
      'grandchild-a1': { type: 'idle' },
      'child-b': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [{
        info: { id: 'done-msg', role: 'assistant', time: { created: 8 } },
        parts: [
          { id: 'done-text', type: 'text', text: 'Done' },
          { id: 'done-finish', type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        ],
      }],
      todos: [],
    }),
  })

  const taskRuns = items.filter((item) => item.type === 'task_run').map((item) => item.taskRun).filter(Boolean)
  const bySource = new Map(taskRuns.map((taskRun) => [taskRun?.sourceSessionId, taskRun]))

  assert.equal(bySource.get('child-a')?.parentSessionId, 'root-3')
  assert.equal(bySource.get('child-b')?.parentSessionId, 'root-3')
  assert.equal(bySource.get('grandchild-a1')?.parentSessionId, 'child-a')
})

test('history projector binds same-parent child sessions to replayed subtasks by order', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-4',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-msg-4', role: 'assistant', time: { created: 1 } },
      parts: [
        { id: 'subtask-market', type: 'subtask', agent: 'research', description: 'Summarize market lineage' },
        { id: 'subtask-sports', type: 'subtask', agent: 'research', description: 'Summarize sports lineage' },
      ],
    }],
    rootTodos: [],
    children: [
      { id: 'child-sports', title: 'Summarize sports lineage', parentSessionId: 'root-4', time: { created: 2, updated: 5 } },
      { id: 'child-market', title: 'Summarize market lineage', parentSessionId: 'root-4', time: { created: 3, updated: 6 } },
    ],
    statuses: {
      'root-4': { type: 'idle' },
      'child-sports': { type: 'idle' },
      'child-market': { type: 'idle' },
    },
    loadChildSnapshot: async (childId) => ({
      messages: [{
        info: { id: `${childId}-msg`, role: 'assistant', time: { created: childId === 'child-sports' ? 4 : 5 } },
        parts: [
          { id: `${childId}-text`, type: 'text', text: `${childId} result` },
          { id: `${childId}-finish`, type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        ],
      }],
      todos: [],
    }),
  })

  const taskRuns = items.filter((item) => item.type === 'task_run').map((item) => item.taskRun).filter(Boolean)
  assert.deepEqual(
    taskRuns.map((taskRun) => ({ source: taskRun?.sourceSessionId, title: taskRun?.title })),
    [
      { source: 'child-sports', title: 'Summarize market lineage' },
      { source: 'child-market', title: 'Summarize sports lineage' },
    ],
  )

  const taskTexts = items.filter((item) => item.type === 'task_text')
  assert.equal(taskTexts.find((item) => item.content === 'child-market result')?.taskRunId, 'child:child-market')
  assert.equal(taskTexts.find((item) => item.content === 'child-sports result')?.taskRunId, 'child:child-sports')
})

test('history projector does not reorder child sessions from partial task titles', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-5',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-msg-5', role: 'assistant', time: { created: 1 } },
      parts: [
        { id: 'subtask-market', type: 'subtask', description: 'Summarize market lineage in detail' },
        { id: 'subtask-sports', type: 'subtask', description: 'Summarize sports lineage' },
      ],
    }],
    rootTodos: [],
    children: [
      { id: 'child-sports', title: 'Summarize sports lineage', parentSessionId: 'root-5', time: { created: 2, updated: 5 } },
      { id: 'child-market', title: 'Summarize market lineage', parentSessionId: 'root-5', time: { created: 3, updated: 6 } },
    ],
    statuses: {
      'root-5': { type: 'idle' },
      'child-sports': { type: 'idle' },
      'child-market': { type: 'idle' },
    },
    loadChildSnapshot: async (childId) => ({
      messages: [{
        info: { id: `${childId}-msg`, role: 'assistant', time: { created: childId === 'child-sports' ? 4 : 5 } },
        parts: [
          { id: `${childId}-text`, type: 'text', text: `${childId} result` },
          { id: `${childId}-finish`, type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        ],
      }],
      todos: [],
    }),
  })

  const taskRuns = items.filter((item) => item.type === 'task_run').map((item) => item.taskRun).filter(Boolean)
  assert.deepEqual(
    taskRuns.map((taskRun) => ({ source: taskRun?.sourceSessionId, title: taskRun?.title })),
    [
      { source: 'child-sports', title: 'Summarize market lineage in detail' },
      { source: 'child-market', title: 'Summarize sports lineage' },
    ],
  )
})

test('history projector normalizes replayed todo snapshots', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-todos',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [],
    rootTodos: [
      { id: 'root-todo-1', content: 'Review docs', status: 'pending', priority: 'high', ignored: true },
      { content: 'Missing priority', status: 'pending' },
      'not-a-todo',
    ],
    children: [
      { id: 'child-todos', title: 'Review docs child', parentSessionId: 'root-todos', time: { created: 2, updated: 3 } },
    ],
    statuses: {
      'root-todos': { type: 'idle' },
      'child-todos': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [],
      todos: [
        { id: 'child-todo-1', content: 'Summarize notes', status: 'in_progress', priority: 'medium' },
        { content: 'Missing status', priority: 'low' },
      ],
    }),
  })

  const rootTodos = items.find((item) => item.type === 'todos')?.todos
  assert.equal(rootTodos?.length, 1)
  assert.deepEqual(rootTodos?.[0], {
    id: 'root-todo-1',
    content: 'Review docs',
    status: 'pending',
    priority: 'high',
  })

  const childTodos = items.find((item) => item.type === 'task_todos')?.todos
  assert.equal(childTodos?.length, 1)
  assert.deepEqual(childTodos?.[0], {
    id: 'child-todo-1',
    content: 'Summarize notes',
    status: 'in_progress',
    priority: 'medium',
  })
})

test('history projector resequences orphan child task runs by chronological replay order', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-orphan-order',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [
      textMessage('root-before-orphan', 'assistant', 'Before orphan child.', 10),
      textMessage('root-after-orphan', 'assistant', 'After orphan child.', 30),
    ],
    rootTodos: [],
    children: [{
      id: 'child-orphan-order',
      title: 'Analyze order (@analyst subagent)',
      parentSessionId: 'root-orphan-order',
      time: { created: 20, updated: 22 },
    }],
    statuses: {
      'root-orphan-order': { type: 'idle' },
      'child-orphan-order': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [{
        info: { id: 'child-orphan-msg', role: 'assistant', time: { created: 21 } },
        parts: [
          { id: 'child-orphan-text', type: 'text', text: 'Child details.' },
          { id: 'child-orphan-finish', type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const before = items.find((item) => item.messageId === 'root-before-orphan' && item.type === 'message')
  const taskRun = items.find((item) => item.type === 'task_run' && item.id === 'child:child-orphan-order')
  const taskText = items.find((item) => item.type === 'task_text' && item.content === 'Child details.')
  const after = items.find((item) => item.messageId === 'root-after-orphan' && item.type === 'message')

  assert.ok(before?.sequence)
  assert.ok(taskRun?.sequence)
  assert.ok(taskText?.sequence)
  assert.ok(after?.sequence)
  assert.ok(before.sequence < taskRun.sequence)
  assert.ok(taskRun.sequence < taskText.sequence)
  assert.ok(taskText.sequence < after.sequence)
})

test('history projector accepts deterministic fallback id generation', async () => {
  let nextId = 0
  const generateId = () => `generated-${++nextId}`
  const items = await projectSessionHistory({
    sessionId: 'root-generated',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'msg-generated', role: 'assistant', time: { created: 1 } },
      parts: [
        { type: 'text', text: 'Hello from replay.' },
        { type: 'compaction', auto: true, overflow: false },
        { type: 'tool', tool: 'read', state: { input: { filePath: 'README.md' }, output: 'ok', metadata: {} } },
      ],
    }],
    rootTodos: [],
    children: [],
    statuses: { 'root-generated': { type: 'idle' } },
    loadChildSnapshot: async () => ({ messages: [], todos: [] }),
    generateId,
  })

  assert.deepEqual(
    items.map((item) => item.id),
    [
      'msg-generated:msg-generated:part:0:text',
      'generated-1',
      'generated-2',
    ],
  )
})

test('history projector treats falsy tool outputs as completed outputs', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-falsy-tool-output',
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages: [{
      info: { id: 'root-falsy-msg', role: 'assistant', time: { created: 1 } },
      parts: [
        { type: 'tool', tool: 'read', id: 'root-empty-tool', state: { input: { filePath: 'README.md' }, output: '', metadata: {} } },
      ],
    }],
    rootTodos: [],
    children: [{
      id: 'child-falsy-tool-output',
      title: 'Falsy tool output task',
      parentSessionId: 'root-falsy-tool-output',
      time: { created: 2, updated: 3 },
    }],
    statuses: {
      'root-falsy-tool-output': { type: 'idle' },
      'child-falsy-tool-output': { type: 'idle' },
    },
    loadChildSnapshot: async () => ({
      messages: [{
        info: { id: 'child-falsy-msg', role: 'assistant', time: { created: 2 } },
        parts: [
          { type: 'tool', tool: 'bash', id: 'child-zero-tool', state: { input: { cmd: 'true' }, output: 0, metadata: {} } },
          { id: 'child-falsy-finish', type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const rootTool = items.find((item) => item.type === 'tool' && item.id === 'root-empty-tool')
  const childTool = items.find((item) => item.type === 'task_tool' && item.id === 'child-zero-tool')
  assert.equal(rootTool?.tool?.status, 'complete')
  assert.equal(rootTool?.tool?.output, '')
  assert.equal(childTool?.tool?.status, 'complete')
  assert.equal(childTool?.tool?.output, 0)
})

test('history projector does not mine agent identity from user prompt/raw content', async () => {
  const items = await projectSessionHistory({
    sessionId: 'root-attr',
    cachedModelId: 'databricks-claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-attr-msg', role: 'assistant', time: { created: 1 } },
        parts: [
          {
            id: 'root-attr-task',
            type: 'tool',
            tool: 'task',
            callID: 'attr-call',
            state: {
              status: 'completed',
              // No structured `agent`/`subagent_type`; the only "@name" token lives in the
              // user-supplied prompt, which must NOT be attributed as the executing agent.
              input: { description: 'Investigate the outage', prompt: 'Please ask @spurious for the runbook' },
              output: 'started',
              metadata: {},
            },
          },
        ],
      },
    ],
    rootTodos: [],
    children: [
      { id: 'child-attr', title: 'Investigate the outage', parentSessionId: 'root-attr', time: { created: 2, updated: 3 } },
    ],
    statuses: { 'root-attr': { type: 'idle' }, 'child-attr': { type: 'idle' } },
    loadChildSnapshot: async () => ({
      messages: [{
        info: { id: 'child-attr-msg', role: 'assistant', time: { created: 4 } },
        parts: [
          { id: 'child-attr-text', type: 'text', text: 'done' },
          { id: 'child-attr-finish', type: 'step-finish', reason: 'stop' },
        ],
      }],
      todos: [],
    }),
  })

  const taskRun = items.find((item) => item.type === 'task_run')
  assert.ok(taskRun, 'expected a task run')
  // Agent identity must come from structured/labeled fields only — a stray "@spurious"
  // in the prompt is not the executing agent.
  assert.notEqual(taskRun.taskRun?.agent, 'spurious')
  assert.equal(taskRun.taskRun?.agent, null)
  // The human-readable title may still draw on the description text.
  assert.equal(taskRun.taskRun?.title, 'Investigate the outage')
})

test('history projector scales task-tool binding across many bounded and nested delegations', async () => {
  const sessionId = 'root-scale-task-tool-binding'
  const rootDelegationCount = 420
  const nestedDelegationCount = 120
  const rootMessages: any[] = []
  const children: any[] = []
  const statuses: Record<string, { type: string }> = {
    [sessionId]: { type: 'idle' },
  }
  const childSnapshots = new Map<string, { messages: any[]; todos: any[] }>()
  const doneSnapshot = (childId: string, created: number) => ({
    messages: [{
      info: { id: `${childId}-msg`, role: 'assistant', time: { created } },
      parts: [
        { id: `${childId}-text`, type: 'text', text: `${childId} done` },
        { id: `${childId}-finish`, type: 'step-finish', reason: 'stop' },
      ],
    }],
    todos: [],
  })

  for (let index = 0; index < rootDelegationCount; index += 1) {
    const baseTime = 1_000 + index * 10
    const taskChildId = `root-task-child-${index}`
    const boundaryChildId = `root-boundary-child-${index}`

    rootMessages.push({
      info: { id: `root-task-msg-${index}`, role: 'assistant', time: { created: baseTime } },
      parts: [{
        id: `root-task-part-${index}`,
        type: 'tool',
        tool: 'task',
        callID: `root-task-call-${index}`,
        state: {
          status: 'completed',
          input: { agent: 'analyst', description: `Bounded root task ${index}` },
          output: 'started',
          metadata: {},
        },
      }],
    })
    rootMessages.push({
      info: { id: `root-boundary-msg-${index}`, role: 'assistant', time: { created: baseTime + 5 } },
      parts: [{
        id: `root-boundary-subtask-${index}`,
        type: 'subtask',
        agent: 'research',
        description: `Boundary subtask ${index}`,
      }],
    })

    children.push({
      id: taskChildId,
      title: `Bounded root task ${index} (@analyst subagent)`,
      parentSessionId: sessionId,
      time: { created: baseTime + 1, updated: baseTime + 2 },
    })
    children.push({
      id: boundaryChildId,
      title: `Boundary subtask ${index} (@research subagent)`,
      parentSessionId: sessionId,
      time: { created: baseTime + 6, updated: baseTime + 7 },
    })
    statuses[taskChildId] = { type: 'idle' }
    statuses[boundaryChildId] = { type: 'idle' }
    childSnapshots.set(taskChildId, doneSnapshot(taskChildId, baseTime + 2))
    childSnapshots.set(boundaryChildId, doneSnapshot(boundaryChildId, baseTime + 7))
  }

  const nestedParentId = 'root-task-child-0'
  const nestedParts: any[] = []
  for (let index = 0; index < nestedDelegationCount; index += 1) {
    const childId = `nested-task-child-${index}`
    nestedParts.push({
      id: `nested-task-part-${index}`,
      type: 'tool',
      tool: 'task',
      callID: `nested-task-call-${index}`,
      state: {
        status: 'completed',
        input: { agent: 'writer', description: `Nested parallel task ${index}` },
        output: 'started',
        metadata: {},
      },
    })
    children.push({
      id: childId,
      title: `Nested parallel task ${index} (@writer subagent)`,
      parentSessionId: nestedParentId,
      time: { created: 100_000 + index, updated: 100_500 + index },
    })
    statuses[childId] = { type: 'idle' }
    childSnapshots.set(childId, doneSnapshot(childId, 100_600 + index))
  }
  nestedParts.push({ id: 'nested-parent-finish', type: 'step-finish', reason: 'stop' })
  childSnapshots.set(nestedParentId, {
    messages: [{
      info: { id: 'nested-parent-msg', role: 'assistant', time: { created: 99_999 } },
      parts: nestedParts,
    }],
    todos: [],
  })

  const project = () => projectSessionHistory({
    sessionId,
    cachedModelId: 'openrouter/anthropic/claude-sonnet-4',
    rootMessages,
    rootTodos: [],
    children,
    statuses,
    loadChildSnapshot: async (childId) => childSnapshots.get(childId) || { messages: [], todos: [] },
  })

  const warmResult = await project()
  const samples: number[] = []
  for (let index = 0; index < 5; index += 1) {
    const start = performance.now()
    await project()
    samples.push(performance.now() - start)
  }

  const taskRuns = warmResult.filter((item) => item.type === 'task_run')
  const nestedTaskRuns = taskRuns.filter((item) => item.taskRun?.parentSessionId === nestedParentId)
  assert.equal(taskRuns.some((item) => item.id.startsWith('pending:')), false)
  assert.equal(nestedTaskRuns.length, nestedDelegationCount)
  assert.equal(warmResult.find((item) => item.id === 'child:root-task-child-419')?.taskRun?.title, 'Bounded root task 419')
  assert.equal(warmResult.find((item) => item.id === 'child:root-boundary-child-419')?.taskRun?.title, 'Boundary subtask 419')
  assert.equal(nestedTaskRuns[119]?.taskRun?.sourceSessionId, 'nested-task-child-119')

  const medianMs = median(samples)
  assert.ok(
    medianMs <= 500,
    `task-tool history projection median ${medianMs.toFixed(3)} ms exceeded the 500 ms guard for `
    + `${rootDelegationCount} bounded root task tools and ${nestedDelegationCount} nested task tools`,
  )
})
