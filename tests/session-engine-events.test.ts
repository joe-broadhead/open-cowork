import { buildPendingApproval, buildPendingQuestion, buildTaskRunUpdate, normalizeToolStatus } from '@open-cowork/runtime-host/session-engine-events'
import test from 'node:test'
import assert from 'node:assert/strict'

test('normalizeToolStatus accepts only runtime tool terminal states', () => {
  assert.equal(normalizeToolStatus('running'), 'running')
  assert.equal(normalizeToolStatus('complete'), 'complete')
  assert.equal(normalizeToolStatus('error'), 'error')
  assert.equal(normalizeToolStatus('queued'), 'running')
  assert.equal(normalizeToolStatus(null), 'running')
})

test('buildTaskRunUpdate normalizes task run payloads from streamed events', () => {
  assert.deepEqual(buildTaskRunUpdate('session-1', {
    type: 'task_run',
    id: 'task-1',
    title: 'Explore repo',
    agent: 'explore',
    status: 'complete',
    sourceSessionId: 'child-1',
    parentSessionId: 'session-1',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:05:00.000Z',
  }, 1_700_000_000_000), {
    id: 'task-1',
    title: 'Explore repo',
    agent: 'explore',
    status: 'complete',
    sourceSessionId: 'child-1',
    parentSessionId: 'session-1',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:05:00.000Z',
  })
})

test('buildTaskRunUpdate falls back for malformed optional task fields', () => {
  const update = buildTaskRunUpdate('session-1', {
    type: 'task_run',
    status: 'unknown',
    parentSessionId: 12,
    startedAt: false,
    finishedAt: {},
  }, 1_700_000_000_000)

  assert.equal(update.id, 'session-1:task:1700000000000')
  assert.equal(update.title, 'Task')
  assert.equal(update.status, 'queued')
  assert.equal(update.parentSessionId, null)
  assert.equal(update.startedAt, null)
  assert.equal(update.finishedAt, null)
})

test('buildPendingApproval uses explicit descriptions and permission fallbacks', () => {
  assert.deepEqual(buildPendingApproval('session-1', {
    type: 'approval',
    id: 'approval-1',
    sourceSessionId: 'child-1',
    taskRunId: 'task-1',
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'Run pwd',
  }, 1_700_000_000_000), {
    id: 'approval-1',
    sessionId: 'session-1',
    sourceSessionId: 'child-1',
    taskRunId: 'task-1',
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'Run pwd',
  })

  const fallback = buildPendingApproval('session-1', { type: 'approval' }, 1_700_000_000_001)
  assert.equal(fallback.id, 'session-1:approval:1700000000001')
  assert.equal(fallback.sourceSessionId, null)
  assert.equal(fallback.tool, 'permission')
  assert.deepEqual(fallback.input, {})
  assert.equal(fallback.description, 'Permission requested')
})

test('buildPendingQuestion preserves question prompts and normalized tool identity', () => {
  assert.deepEqual(buildPendingQuestion('session-1', {
    type: 'question_asked',
    id: 'question-1',
    sourceSessionId: 'child-1',
    questions: [{
      header: 'Scope',
      question: 'What should change?',
      options: [{ label: 'Tests', description: 'Focus tests' }],
    }],
    tool: {
      messageId: 'message-1',
      callId: 'call-1',
    },
  }, 1_700_000_000_000), {
    id: 'question-1',
    sessionId: 'session-1',
    sourceSessionId: 'child-1',
    questions: [{
      header: 'Scope',
      question: 'What should change?',
      options: [{ label: 'Tests', description: 'Focus tests' }],
    }],
    tool: {
      messageId: 'message-1',
      callId: 'call-1',
    },
  })
})
