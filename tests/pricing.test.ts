import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateCostForModel, resolveDisplayCostForModel } from '../apps/desktop/src/main/pricing-core.ts'
import { getMeaningfulSdkPricing, normalizeModelId, resolveMeaningfulCost } from '../apps/desktop/src/main/pricing-utils.ts'

test('normalizeModelId removes provider prefixes', () => {
  assert.equal(normalizeModelId('databricks/databricks-claude-sonnet-4'), 'databricks-claude-sonnet-4')
  assert.equal(normalizeModelId('databricks-claude-sonnet-4'), 'databricks-claude-sonnet-4')
})

test('getMeaningfulSdkPricing ignores zero-valued sdk prices', () => {
  const pricing = getMeaningfulSdkPricing({
    'databricks-claude-sonnet-4': {
      inputPer1M: 0,
      outputPer1M: 0,
      cachePer1M: 0,
    },
  }, 'databricks-claude-sonnet-4')

  assert.equal(pricing, null)
})

test('getMeaningfulSdkPricing accepts cache-write-only pricing', () => {
  const pricing = getMeaningfulSdkPricing({
    'example-model': {
      inputPer1M: 0,
      outputPer1M: 0,
      cacheWritePer1M: 2,
    },
  }, 'example-model')

  assert.deepEqual(pricing, {
    inputPer1M: 0,
    outputPer1M: 0,
    cacheWritePer1M: 2,
  })
})

test('getMeaningfulSdkPricing matches provider-prefixed model ids', () => {
  const pricing = getMeaningfulSdkPricing({
    'databricks-claude-sonnet-4': {
      inputPer1M: 3,
      outputPer1M: 15,
      cachePer1M: 0.3,
    },
  }, 'databricks/databricks-claude-sonnet-4')

  assert.deepEqual(pricing, {
    inputPer1M: 3,
    outputPer1M: 15,
    cachePer1M: 0.3,
  })
})

test('resolveMeaningfulCost prefers the estimated cost when the reported cost is implausibly tiny', () => {
  const cost = resolveMeaningfulCost(7.6266e-8, 0.076266)
  assert.equal(cost, 0.076266)
})

test('resolveMeaningfulCost keeps the reported cost when it is already plausible', () => {
  const cost = resolveMeaningfulCost(0.076266, 0.076266)
  assert.equal(cost, 0.076266)
})

test('resolveMeaningfulCost prefers the estimated cost when the reported cost is implausibly large', () => {
  const cost = resolveMeaningfulCost(47355.2, 0.076266)
  assert.equal(cost, 0.076266)
})

test('calculateCostForModel returns zero when no SDK or configured pricing exists', () => {
  const cost = calculateCostForModel('unknown/model', {
    input: 1000,
    output: 500,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  assert.equal(cost, 0)
})

test('resolveDisplayCostForModel keeps reported cost when pricing is unavailable', () => {
  const cost = resolveDisplayCostForModel('unknown/model', 0.0123, {
    input: 1000,
    output: 500,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  assert.equal(cost, 0.0123)
})

test('calculateCostForModel uses SDK cache read and write pricing when available', () => {
  const cost = calculateCostForModel('openai/gpt-example', {
    input: 3000,
    output: 1000,
    reasoning: 500,
    cache: { read: 1000, write: 500 },
  }, {
    'openai/gpt-example': {
      inputPer1M: 2,
      outputPer1M: 8,
      cachePer1M: 0.5,
      cacheWritePer1M: 1,
    },
  })

  assert.equal(cost, 0.016)
})
