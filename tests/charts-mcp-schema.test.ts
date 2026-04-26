import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from '../mcps/charts/node_modules/zod/index.js'
import { inferBarChartEncoding } from '../mcps/charts/src/chart-utils.ts'
import { chartDataSchema, MAX_CHART_DATA_ROWS, vegaLiteSpecSchema } from '../mcps/charts/src/schemas.ts'

test('chart MCP schemas export to JSON schema for tool discovery', () => {
  const schema = z.object({
    data: chartDataSchema,
    spec: vegaLiteSpecSchema,
  })

  const jsonSchema = z.toJSONSchema(schema)

  assert.equal(jsonSchema.type, 'object')
  assert.ok(jsonSchema.properties?.data)
  assert.ok(jsonSchema.properties?.spec)
})

test('chart MCP data schema rejects oversized row sets', () => {
  const result = chartDataSchema.safeParse(
    Array.from({ length: MAX_CHART_DATA_ROWS + 1 }, (_, index) => ({ index })),
  )

  assert.equal(result.success, false)
})

test('chart MCP custom spec schema rejects external resource references', () => {
  const result = vegaLiteSpecSchema.safeParse({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { url: 'https://example.com/data.csv' },
    mark: 'bar',
  })

  assert.equal(result.success, false)
})

test('chart MCP custom spec schema rejects oversized inline values', () => {
  const result = vegaLiteSpecSchema.safeParse({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: {
      values: Array.from({ length: 20_001 }, (_, index) => ({ index })),
    },
    mark: 'bar',
  })

  assert.equal(result.success, false)
})

test('chart MCP custom spec schema rejects non-serializable specs', () => {
  const spec: Record<string, unknown> = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    mark: 'bar',
  }
  spec.self = spec

  const result = vegaLiteSpecSchema.safeParse(spec)

  assert.equal(result.success, false)
})

test('chart MCP bar encoding accepts natural horizontal x=value y=category calls', () => {
  const encoding = inferBarChartEncoding(
    [
      { game: 'Counter-Strike 2', current_players: 1_066_999 },
      { game: 'Dota 2', current_players: 504_386 },
    ],
    'current_players',
    'game',
    true,
  )

  assert.deepEqual(encoding, {
    y: { field: 'game', type: 'nominal', sort: '-x', axis: { labelAngle: 0 } },
    x: { field: 'current_players', type: 'quantitative' },
  })
})

test('chart MCP bar encoding preserves legacy horizontal x=category y=value calls', () => {
  const encoding = inferBarChartEncoding(
    [
      { game: 'Counter-Strike 2', current_players: 1_066_999 },
      { game: 'Dota 2', current_players: 504_386 },
    ],
    'game',
    'current_players',
    true,
  )

  assert.deepEqual(encoding, {
    y: { field: 'game', type: 'nominal', sort: '-x', axis: { labelAngle: 0 } },
    x: { field: 'current_players', type: 'quantitative' },
  })
})
