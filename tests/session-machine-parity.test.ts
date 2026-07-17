import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCloudSessionProjectionView,
  deriveSessionInteractionFlags,
  deriveToolStatus,
  reduceCloudSessionProjectionEvent,
  cloudSessionViewToSessionView,
  resolveAssistantMessageContent,
  SESSION_STATE_MACHINE_CONVERGENCE_PLAN,
  SESSION_STATE_MACHINE_OWNERSHIP,
  upsertProjectionById,
} from '@open-cowork/shared'
import { SessionEngine } from '@open-cowork/runtime-host/session-engine'

function sessionRecord() {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-parity-1',
    profileName: 'default',
    status: 'running' as const,
    title: 'Parity session',
    updatedAt: '2026-05-29T10:00:00.000Z',
  }
}

function eventRecord(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
) {
  return {
    sequence,
    type,
    payload,
    createdAt: `2026-05-29T10:${String(sequence).padStart(2, '0')}:00.000Z`,
  }
}

test('JOE-846: ownership matrix documents live, history, and cloud machines', () => {
  assert.equal(SESSION_STATE_MACHINE_OWNERSHIP.live.id, 'live')
  assert.equal(SESSION_STATE_MACHINE_OWNERSHIP.history.id, 'history')
  assert.equal(SESSION_STATE_MACHINE_OWNERSHIP.cloud.id, 'cloud')
  assert.ok(SESSION_STATE_MACHINE_OWNERSHIP.live.owns.length > 0)
  assert.ok(SESSION_STATE_MACHINE_OWNERSHIP.history.owns.length > 0)
  assert.ok(SESSION_STATE_MACHINE_OWNERSHIP.cloud.owns.length > 0)
  assert.ok(SESSION_STATE_MACHINE_CONVERGENCE_PLAN.length >= 3)
})

test('JOE-846: shared assistant append/replace policy preserves whitespace deltas', () => {
  assert.equal(
    resolveAssistantMessageContent({ mode: 'append', existingContent: 'Hello', content: ' world' }),
    'Hello world',
  )
  assert.equal(
    resolveAssistantMessageContent({ mode: 'append', existingContent: 'Hello', content: ' ' }),
    'Hello ',
  )
  assert.equal(
    resolveAssistantMessageContent({ mode: 'replace', existingContent: 'Hello', content: 'Final' }),
    'Final',
  )
})

test('JOE-846: interaction flags suppress generating while awaiting permission or question', () => {
  assert.deepEqual(
    deriveSessionInteractionFlags({
      isBusyOrGenerating: true,
      pendingApprovalCount: 1,
      pendingQuestionCount: 0,
    }),
    { isGenerating: false, isAwaitingPermission: true, isAwaitingQuestion: false },
  )
  assert.deepEqual(
    deriveSessionInteractionFlags({
      isBusyOrGenerating: true,
      pendingApprovalCount: 0,
      pendingQuestionCount: 1,
    }),
    { isGenerating: false, isAwaitingPermission: false, isAwaitingQuestion: true },
  )
  assert.deepEqual(
    deriveSessionInteractionFlags({
      isBusyOrGenerating: true,
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
    }),
    { isGenerating: true, isAwaitingPermission: false, isAwaitingQuestion: false },
  )
})

test('JOE-846: critical transcript shapes agree across cloud projection and live SessionEngine', () => {
  // Product event sequence shared by cloud durable log and (after fan-out) live engine.
  const productEvents = [
    eventRecord(1, 'assistant.message', {
      sessionId: 'session-parity-1',
      messageId: 'msg-a',
      content: 'Hello',
      mode: 'append',
    }),
    eventRecord(2, 'assistant.message', {
      sessionId: 'session-parity-1',
      messageId: 'msg-a',
      content: ' world',
      mode: 'append',
    }),
    eventRecord(3, 'tool.call', {
      sessionId: 'session-parity-1',
      id: 'tool-1',
      name: 'bash',
      input: { command: 'echo hi' },
      status: 'complete',
      output: 'hi',
    }),
    eventRecord(4, 'permission.requested', {
      permissionId: 'perm-1',
      sessionId: 'session-parity-1',
      tool: 'bash',
      input: { command: 'rm -rf /' },
      description: 'Dangerous command',
    }),
    eventRecord(5, 'question.asked', {
      requestId: 'q-1',
      sessionId: 'session-parity-1',
      questions: [{ header: 'Confirm', question: 'Proceed?', options: [], multiple: false, custom: true }],
    }),
  ]

  const session = sessionRecord()
  let cloudView = createCloudSessionProjectionView(session)
  for (const event of productEvents) {
    cloudView = reduceCloudSessionProjectionEvent(session, cloudView, event)
  }
  const cloudSessionView = cloudSessionViewToSessionView({
    session,
    projection: {
      sequence: productEvents.length,
      updatedAt: productEvents[productEvents.length - 1]!.createdAt,
      view: cloudView,
    },
  })

  // Live engine consumes RuntimeSessionEvent fan-out shapes for the same transcript facts.
  const engine = new SessionEngine({
    generateId: () => 'fixed-id',
    nowMs: () => 1_700_000_000_000,
    nowIso: () => '2026-05-29T10:00:00.000Z',
  })
  engine.activateSession('session-parity-1')
  engine.applyStreamEvent({
    sessionId: 'session-parity-1',
    data: {
      type: 'text',
      messageId: 'msg-a',
      partId: 'part-1',
      role: 'assistant',
      content: 'Hello',
      mode: 'replace',
    },
  })
  engine.applyStreamEvent({
    sessionId: 'session-parity-1',
    data: {
      type: 'text',
      messageId: 'msg-a',
      partId: 'part-1',
      role: 'assistant',
      content: 'Hello world',
      mode: 'replace',
    },
  })
  engine.applyStreamEvent({
    sessionId: 'session-parity-1',
    data: {
      type: 'tool_call',
      id: 'tool-1',
      name: 'bash',
      input: { command: 'echo hi' },
      status: 'complete',
      output: 'hi',
    },
  })
  engine.applyStreamEvent({
    sessionId: 'session-parity-1',
    data: {
      type: 'approval',
      id: 'perm-1',
      tool: 'bash',
      input: { command: 'rm -rf /' },
      description: 'Dangerous command',
      sourceSessionId: 'session-parity-1',
    },
  })
  engine.applyStreamEvent({
    sessionId: 'session-parity-1',
    data: {
      type: 'awaiting_permission',
      id: 'perm-1',
    },
  })
  engine.applyStreamEvent({
    sessionId: 'session-parity-1',
    data: {
      type: 'question_asked',
      id: 'q-1',
      questions: [{ header: 'Confirm', question: 'Proceed?', options: [], multiple: false, custom: true }],
      sourceSessionId: 'session-parity-1',
    },
  })
  const liveView = engine.getSessionView('session-parity-1')

  // Critical shapes — not full deep equality (ordering/metadata differ by machine).
  const cloudAssistant = cloudSessionView.messages.filter((m) => m.role === 'assistant')
  const liveAssistant = liveView.messages.filter((m) => m.role === 'assistant')
  assert.equal(cloudAssistant.length >= 1, true)
  assert.equal(liveAssistant.length >= 1, true)
  assert.equal(cloudAssistant[0]?.content, 'Hello world')
  assert.equal(liveAssistant[0]?.content, 'Hello world')

  assert.equal(cloudSessionView.toolCalls.some((t) => t.id === 'tool-1' && t.status === 'complete'), true)
  assert.equal(liveView.toolCalls.some((t) => t.id === 'tool-1' && t.status === 'complete'), true)

  assert.equal(cloudSessionView.pendingApprovals.some((a) => a.id === 'perm-1'), true)
  assert.equal(liveView.pendingApprovals.some((a) => a.id === 'perm-1'), true)

  assert.equal(cloudSessionView.pendingQuestions.some((q) => q.id === 'q-1'), true)
  assert.equal(liveView.pendingQuestions.some((q) => q.id === 'q-1'), true)

  // Interaction flags: both machines suppress generating while waiting.
  assert.equal(cloudSessionView.isAwaitingPermission || cloudSessionView.isAwaitingQuestion, true)
  assert.equal(liveView.isAwaitingPermission || liveView.isAwaitingQuestion, true)
  assert.equal(cloudSessionView.isGenerating, false)
  assert.equal(liveView.isGenerating, false)
})

test('JOE-846: tool status pure helper and upsert are shared-policy building blocks', () => {
  assert.equal(deriveToolStatus({ hasOutput: true, hasError: false }), 'complete')
  assert.equal(deriveToolStatus({ hasOutput: false, hasError: true }), 'error')
  assert.equal(deriveToolStatus({ hasOutput: false, hasError: false }), 'running')

  const next = upsertProjectionById(
    [{ id: 'a', value: 1 }],
    { id: 'a', value: 2 },
    (existing, incoming) => ({ ...existing, value: incoming.value }),
  )
  assert.deepEqual(next, [{ id: 'a', value: 2 }])
})
