import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSessionHistory } from '../apps/desktop/src/main/session-history-projector.ts'

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
