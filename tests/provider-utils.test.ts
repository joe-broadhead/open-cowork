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

test('normalizeProviderListResponse handles legacy provider arrays and providers objects', () => {
  const fromArray = normalizeProviderListResponse([
    { id: 'databricks', models: {} },
    { id: 'vertex', models: {} },
  ])
  assert.equal(fromArray.length, 2)

  const fromProvidersField = normalizeProviderListResponse({
    providers: [
      { id: 'databricks', models: {} },
      { id: 'vertex', models: {} },
    ],
  })
  assert.equal(fromProvidersField.length, 2)
})
