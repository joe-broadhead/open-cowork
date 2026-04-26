import test from 'node:test'
import assert from 'node:assert/strict'
import { canPromoteNumericColorToQuantitative, inferSequentialXAxisEncoding, normalizeSeriesColorField } from '../mcps/charts/src/chart-utils.ts'

test('inferSequentialXAxisEncoding keeps weekday strings as ordered categorical values', () => {
  const encoding = inferSequentialXAxisEncoding([
    { day: 'Sunday', sales: 10 },
    { day: 'Monday', sales: 20 },
    { day: 'Tuesday', sales: 15 },
  ], 'day')

  assert.equal(encoding.type, 'ordinal')
  assert.deepEqual(encoding.sort, ['Sunday', 'Monday', 'Tuesday'])
})

test('inferSequentialXAxisEncoding keeps month abbreviations in calendar order', () => {
  const encoding = inferSequentialXAxisEncoding([
    { month: 'Jan', revenue: 10 },
    { month: 'Mar', revenue: 30 },
    { month: 'Feb', revenue: 20 },
  ], 'month')

  assert.equal(encoding.type, 'ordinal')
  assert.deepEqual(encoding.sort, ['Jan', 'Feb', 'Mar'])
})

test('inferSequentialXAxisEncoding preserves true temporal fields', () => {
  const encoding = inferSequentialXAxisEncoding([
    { day: '2026-04-14', sales: 10 },
    { day: '2026-04-15', sales: 20 },
  ], 'day')

  assert.equal(encoding.type, 'temporal')
})

test('normalizeSeriesColorField rejects x/y fields as invalid series groups', () => {
  assert.equal(normalizeSeriesColorField('current', 'day', 'current'), undefined)
  assert.equal(normalizeSeriesColorField('day', 'day', 'current'), undefined)
  assert.equal(normalizeSeriesColorField('period', 'day', 'current'), 'period')
})

test('numeric color series stay nominal for line and area charts', () => {
  assert.equal(canPromoteNumericColorToQuantitative({ mark: 'line' }), false)
  assert.equal(canPromoteNumericColorToQuantitative({ mark: { type: 'area' } }), false)
  assert.equal(canPromoteNumericColorToQuantitative({ mark: 'bar' }), true)
})
