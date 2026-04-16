import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeBreakdown,
  formatCost,
  formatInteger,
  formatProviderLabel,
  formatTokens,
  serializeToolPayload,
} from '../apps/desktop/src/renderer/components/chat/session-inspector-utils.ts'

test('formatters produce stable human-readable values', () => {
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(12_500), '12.5K')
  assert.equal(formatTokens(2_500_000), '2.5M')

  assert.equal(formatInteger(1234567), '1,234,567')
  assert.equal(formatCost(0), '$0.00')
  assert.equal(formatCost(0.0098), '$0.0098')
  assert.equal(formatCost(12.345), '$12.35')

  assert.equal(formatProviderLabel('openrouter'), 'OpenRouter')
  assert.equal(formatProviderLabel('custom-provider'), 'Custom-provider')
  assert.equal(formatProviderLabel(null), 'Unknown')
})

test('serializeToolPayload falls back for circular structures', () => {
  const value: Record<string, unknown> = { ok: true }
  value.self = value

  assert.equal(serializeToolPayload({ a: 1 }), '{"a":1}')
  assert.match(serializeToolPayload(value), /\[object Object\]|self/)
})

test('computeBreakdown scales attributed values to the total context window', () => {
  const breakdown = computeBreakdown({
    messages: [
      { role: 'user', content: 'hello there from the user' },
      { role: 'assistant', content: 'assistant response with more content than before' },
    ],
    toolPayloads: ['{"sql":"select * from table"}'],
    totalContextTokens: 10,
  })

  assert.equal(breakdown.length, 4)
  assert.equal(breakdown.reduce((sum, item) => sum + item.value, 0), 10)
  assert.deepEqual(
    breakdown.map((item) => item.id),
    ['user', 'assistant', 'tool', 'other'],
  )
})

test('computeBreakdown returns zeroed sections when total context is empty', () => {
  const breakdown = computeBreakdown({
    messages: [{ role: 'user', content: 'hello' }],
    toolPayloads: ['payload'],
    totalContextTokens: 0,
  })

  assert.deepEqual(
    breakdown.map((item) => item.value),
    [0, 0, 0, 0],
  )
})
