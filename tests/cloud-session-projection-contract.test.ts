import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cloudSessionViewToSessionView,
  createCloudSessionProjectionView,
  reduceCloudSessionProjectionEvent,
} from '../packages/shared/dist/cloud-session-projection.js'

test('shared cloud projection reducer feeds desktop SessionView contract', () => {
  const session = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    profileName: 'default',
    status: 'idle' as const,
    title: 'Shared projection',
    updatedAt: '2026-05-28T10:00:00.000Z',
  }
  let view = createCloudSessionProjectionView(session)
  view = reduceCloudSessionProjectionEvent(session, view, {
    sequence: 1,
    type: 'prompt.submitted',
    payload: { messageId: 'user-1', text: 'run checks' },
    createdAt: '2026-05-28T10:01:00.000Z',
  })
  view = reduceCloudSessionProjectionEvent(session, view, {
    sequence: 2,
    type: 'tool.call',
    payload: {
      id: 'tool-1',
      name: 'bash',
      input: { command: 'pnpm test' },
      status: 'running',
    },
    createdAt: '2026-05-28T10:02:00.000Z',
  })
  view = reduceCloudSessionProjectionEvent(session, view, {
    sequence: 3,
    type: 'permission.requested',
    payload: {
      permissionId: 'permission-1',
      tool: 'bash',
      input: { command: 'pnpm test' },
      description: 'Run tests',
    },
    createdAt: '2026-05-28T10:03:00.000Z',
  })
  view = reduceCloudSessionProjectionEvent(session, view, {
    sequence: 4,
    type: 'assistant.message',
    payload: { messageId: 'assistant-1', content: 'Waiting for approval.' },
    createdAt: '2026-05-28T10:04:00.000Z',
  })

  const sessionView = cloudSessionViewToSessionView({
    session,
    projection: {
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      sequence: 4,
      view,
      updatedAt: '2026-05-28T10:04:00.000Z',
    },
  })

  assert.deepEqual(sessionView.messages.map((message) => message.content), [
    'run checks',
    'Waiting for approval.',
  ])
  assert.equal(sessionView.toolCalls[0]?.name, 'bash')
  assert.equal(sessionView.pendingApprovals[0]?.id, 'permission-1')
  assert.equal(sessionView.isAwaitingPermission, true)
  assert.equal(sessionView.isGenerating, false)
})
