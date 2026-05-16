import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRootToolCall, getLatestHistoryEventAt } from '../apps/desktop/src/main/session-engine-helpers.ts'

test('getLatestHistoryEventAt returns the newest finite history timestamp', () => {
  const latest = getLatestHistoryEventAt([
    { id: 'a', role: 'assistant', text: 'older', timestamp: '2026-01-01T10:00:00.000Z' },
    { id: 'b', role: 'assistant', text: 'invalid', timestamp: 'not-a-date' },
    { id: 'c', role: 'user', text: 'newer', timestamp: '2026-01-01T10:05:00.000Z' },
  ])

  assert.equal(latest, Date.parse('2026-01-01T10:05:00.000Z'))
})

test('createRootToolCall fills safe defaults and preserves supplied metadata', () => {
  const tool = createRootToolCall('tool-1', {
    name: 'write',
    input: { file: 'README.md' },
    status: 'complete',
    output: 'done',
    agent: 'build',
    sourceSessionId: 'child-1',
  }, { order: 42 })

  assert.equal(tool.id, 'tool-1')
  assert.equal(tool.name, 'write')
  assert.deepEqual(tool.input, { file: 'README.md' })
  assert.equal(tool.status, 'complete')
  assert.equal(tool.output, 'done')
  assert.equal(tool.agent, 'build')
  assert.equal(tool.sourceSessionId, 'child-1')
  assert.equal(tool.order, 42)
})

test('createRootToolCall falls back to a running generic tool shape', () => {
  const tool = createRootToolCall('tool-2', {}, { order: 7 })

  assert.equal(tool.name, 'tool')
  assert.deepEqual(tool.input, {})
  assert.equal(tool.status, 'running')
  assert.equal(tool.agent, null)
  assert.equal(tool.sourceSessionId, null)
  assert.equal(tool.order, 7)
})
