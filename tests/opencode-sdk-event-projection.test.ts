import test from 'node:test'
import assert from 'node:assert/strict'

import { translateOpencodeRuntimeEvent } from '../apps/desktop/src/main/cloud/opencode-runtime-adapter.ts'
import {
  CLOUD_SESSION_EVENT_TYPES,
  cloudSessionViewToSessionView,
  createCloudSessionProjectionView,
  reduceCloudSessionProjectionEvent,
} from '../packages/shared/dist/cloud-session-projection.js'

function sessionRecord() {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    profileName: 'default',
    status: 'running' as const,
    title: 'SDK fixture session',
    updatedAt: '2026-05-29T10:00:00.000Z',
  }
}

function eventRecord(sequence: number, event: { type: string, payload: Record<string, unknown> }) {
  return {
    sequence,
    type: event.type,
    payload: event.payload,
    createdAt: `2026-05-29T10:${String(sequence).padStart(2, '0')}:00.000Z`,
  }
}

test('SDK v2 event fixtures normalize into the shared cloud projection contract', () => {
  const rawSdkEvents = [
    {
      payload: {
        type: 'message.part.updated',
        data: {
          sessionID: 'session-1',
          messageID: 'assistant-message-1',
          role: 'assistant',
          part: { id: 'part-1', type: 'text', text: 'normalized assistant text' },
        },
      },
    },
    {
      payload: {
        type: 'message.part.updated',
        data: {
          sessionID: 'session-1',
          part: {
            id: 'part-2',
            callID: 'tool-call-1',
            type: 'tool',
            tool: 'bash',
            state: {
              input: { command: 'pnpm test' },
              status: 'completed',
              output: 'ok',
            },
          },
        },
      },
    },
    {
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'session-1',
          permission: {
            id: 'permission-1',
            tool: 'bash',
            input: { command: 'pnpm test' },
          },
        },
      },
    },
    {
      payload: {
        type: 'question.asked',
        properties: {
          sessionID: 'session-1',
          id: 'question-1',
          questions: [{
            header: 'Scope',
            question: 'Run all checks?',
            options: [{ label: 'Yes', description: 'Run the full suite' }],
          }],
          tool: { messageID: 'assistant-message-1', callID: 'tool-call-1' },
        },
      },
    },
    {
      payload: {
        type: 'todo.updated',
        properties: {
          sessionID: 'session-1',
          todos: [{ id: 'todo-1', content: 'Harden SDK boundary', status: 'in_progress', priority: 'high' }],
        },
      },
    },
    {
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'session-1',
          status: { type: 'idle' },
        },
      },
    },
  ]

  const normalized = rawSdkEvents.flatMap(translateOpencodeRuntimeEvent)
  assert.deepEqual(normalized.map((event) => event.type), [
    'assistant.message',
    'tool.call',
    'permission.requested',
    'question.asked',
    'todos.updated',
    'session.status',
  ])

  const session = sessionRecord()
  let projection = createCloudSessionProjectionView(session)
  normalized.forEach((event, index) => {
    assert.equal(CLOUD_SESSION_EVENT_TYPES.includes(event.type), true, `${event.type} must be a shared cloud event`)
    projection = reduceCloudSessionProjectionEvent(session, projection, eventRecord(index + 1, event))
  })

  assert.deepEqual(projection.messages.map((message) => message.content), ['normalized assistant text'])
  assert.equal(projection.toolCalls[0]?.name, 'bash')
  assert.equal(projection.toolCalls[0]?.status, 'complete')
  assert.equal(projection.pendingApprovals[0]?.id, 'permission-1')
  assert.equal(projection.pendingQuestions[0]?.id, 'question-1')
  assert.equal(projection.pendingQuestions[0]?.tool?.callId, 'tool-call-1')
  assert.deepEqual(projection.todos.map((todo) => todo.content), ['Harden SDK boundary'])
  assert.equal(projection.status, 'idle')

  const desktopView = cloudSessionViewToSessionView({
    session,
    projection: {
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      sequence: normalized.length,
      view: projection,
      updatedAt: projection.updatedAt,
    },
  })
  assert.equal(desktopView.messages[0]?.content, 'normalized assistant text')
  assert.equal(desktopView.pendingApprovals[0]?.id, 'permission-1')
  assert.equal(desktopView.pendingQuestions[0]?.id, 'question-1')
})

test('SDK v2 permission and question resolution fixtures clear shared pending state', () => {
  const session = sessionRecord()
  const rawSdkEvents = [
    {
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'session-1',
          permission: { id: 'permission-1', tool: 'bash', input: { command: 'pwd' } },
        },
      },
    },
    {
      payload: {
        type: 'question.asked',
        properties: {
          sessionID: 'session-1',
          id: 'question-1',
          questions: [{ question: 'Continue?', options: [] }],
        },
      },
    },
    {
      payload: {
        type: 'permission.resolved',
        properties: {
          sessionID: 'session-1',
          permission: { id: 'permission-1' },
        },
      },
    },
    {
      payload: {
        type: 'question.resolved',
        properties: {
          sessionID: 'session-1',
          id: 'question-1',
        },
      },
    },
  ]

  let projection = createCloudSessionProjectionView(session)
  rawSdkEvents
    .flatMap(translateOpencodeRuntimeEvent)
    .forEach((event, index) => {
      assert.equal(CLOUD_SESSION_EVENT_TYPES.includes(event.type), true, `${event.type} must be a shared cloud event`)
      projection = reduceCloudSessionProjectionEvent(session, projection, eventRecord(index + 1, event))
    })

  assert.equal(projection.pendingApprovals.length, 0)
  assert.equal(projection.pendingQuestions.length, 0)
})
