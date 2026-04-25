import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from '../mcps/charts/node_modules/zod/index.js'
import { chartDataSchema, vegaLiteSpecSchema } from '../mcps/charts/src/schemas.ts'

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
