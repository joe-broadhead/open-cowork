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
          { id: 'subtask-1', type: 'subtask', agent: 'research', description: 'Check the docs' },
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
  const items = await projectSessionHistory({
    sessionId: 'root-1',
    cachedModelId: 'databricks-claude-sonnet-4',
    rootMessages: [
      {
        info: { id: 'root-msg-1', role: 'assistant', time: { created: 1 } },
        parts: [
          { id: 'subtask-1', type: 'subtask', agent: 'research', description: 'Check the docs' },
        ],
      },
    ],
    rootTodos: [],
    children: [{ id: 'child-1', title: 'Research docs', time: { created: 2 } }],
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

  const taskText = items.find((item) => item.type === 'task_text')
  assert.equal(taskText?.content, 'Done')
})
