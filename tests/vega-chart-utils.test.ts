import test from 'node:test'
import assert from 'node:assert/strict'
import { isFullVegaSpec, normalizeVegaSpecSchema } from '../apps/desktop/src/renderer/components/chat/vega-chart-utils.ts'

test('normalizeVegaSpecSchema upgrades legacy vega-lite schemas to v6', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    mark: 'bar',
  }

  assert.deepEqual(normalizeVegaSpecSchema(spec), {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    mark: 'bar',
  })
})

test('normalizeVegaSpecSchema leaves full vega specs untouched', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v5.json',
    marks: [],
  }

  assert.equal(normalizeVegaSpecSchema(spec), spec)
  assert.equal(isFullVegaSpec(spec), true)
})
