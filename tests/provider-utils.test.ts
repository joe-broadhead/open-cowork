import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProviderListResponse } from '../apps/desktop/src/main/provider-utils.ts'

test('normalizeProviderListResponse handles v2 provider.list payloads', () => {
  const providers = normalizeProviderListResponse({
    all: [
      { id: 'databricks', name: 'Databricks', models: { 'databricks-claude-sonnet-4': { limit: { context: 200_000 } } } },
      { id: 'google-vertex', name: 'Google Vertex', models: { 'gemini-2.5-pro': { limit: { context: 1_048_576 } } } },
    ],
    default: { databricks: 'databricks-claude-sonnet-4' },
    connected: ['databricks', 'google-vertex'],
  })

  assert.equal(providers.length, 2)
  assert.equal(providers[0].id, 'databricks')
  assert.equal(providers[1].id, 'google-vertex')
})

test('normalizeProviderListResponse returns an empty array for non-v2 payloads', () => {
  assert.deepEqual(normalizeProviderListResponse(null), [])
  assert.deepEqual(normalizeProviderListResponse(undefined), [])
  assert.deepEqual(normalizeProviderListResponse([
    { id: 'legacy-array-payload' },
  ]), [])
  assert.deepEqual(normalizeProviderListResponse({
    providers: [{ id: 'legacy-providers-field' }],
  }), [])
})
