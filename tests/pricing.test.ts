import test from 'node:test'
import assert from 'node:assert/strict'
import { getMeaningfulSdkPricing, normalizeModelId } from '../apps/desktop/src/main/pricing-utils.ts'

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
