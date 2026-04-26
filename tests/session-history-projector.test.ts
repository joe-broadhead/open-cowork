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
