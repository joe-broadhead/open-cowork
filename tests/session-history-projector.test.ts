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

test('history projector scans later direct children when matching task tool sessions', async () => {
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

  const targetTask = items.find((item) => item.id === 'child:child-target')?.taskRun
  const unrelatedTask = items.find((item) => item.id === 'child:child-unrelated')?.taskRun

  assert.ok(targetTask)
  assert.equal(targetTask.sourceSessionId, 'child-target')
  assert.equal(targetTask.title, 'Target market analysis')
  assert.ok(unrelatedTask)
  assert.equal(unrelatedTask.sourceSessionId, 'child-unrelated')
  assert.equal(unrelatedTask.title, 'Earlier unrelated research')
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
