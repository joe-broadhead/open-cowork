import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatCost, formatTokensCompact } from '../apps/desktop/src/renderer/helpers/format.ts'

describe('formatCost (default)', () => {
  it('always renders $X.XX including zero', () => {
    assert.equal(formatCost(0), '$0.00')
    assert.equal(formatCost(0.004), '$0.00')
    assert.equal(formatCost(0.08), '$0.08')
    assert.equal(formatCost(12.345), '$12.35')
  })
})

describe('formatCost (precise)', () => {
  it('uses 4-decimal precision for sub-cent values', () => {
    assert.equal(formatCost(0, 'precise'), '$0.00')
    assert.equal(formatCost(0.0098, 'precise'), '$0.0098')
    assert.equal(formatCost(0.5, 'precise'), '$0.50')
    assert.equal(formatCost(12.345, 'precise'), '$12.35')
  })
})

describe('formatCost (compact)', () => {
  it('hides zero and uses <$0.01 for sub-cent', () => {
    assert.equal(formatCost(0, 'compact'), '')
    assert.equal(formatCost(0.004, 'compact'), '<$0.01')
    assert.equal(formatCost(0.08, 'compact'), '$0.08')
    assert.equal(formatCost(12.345, 'compact'), '$12.35')
  })
})

describe('formatTokensCompact', () => {
  it('maps token counts to the right compact band', () => {
    assert.equal(formatTokensCompact(0), '')
    assert.equal(formatTokensCompact(42), '42')
    assert.equal(formatTokensCompact(1_234), '1.2k')
    assert.equal(formatTokensCompact(14_000), '14k')
    assert.equal(formatTokensCompact(1_500_000), '1.5M')
  })
})
