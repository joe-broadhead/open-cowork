import { combineNativeProviderCatalog, listNativeProviders } from '@open-cowork/runtime-host/provider-utils'
import test from 'node:test'
import assert from 'node:assert/strict'

test('combineNativeProviderCatalog joins V2 providers, models, costs, and variants', () => {
  const providers = combineNativeProviderCatalog(
    [{ id: 'openai', name: 'OpenAI' }] as never,
    [{
      id: 'gpt-5.4',
      providerID: 'openai',
      family: 'gpt-5',
      name: 'GPT-5.4',
      api: { id: 'openai', type: 'aisdk', package: '@ai-sdk/openai', settings: { apiKey: 'api-secret' } },
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      request: {
        headers: { Authorization: 'Bearer header-secret' },
        body: { apiKey: 'body-secret' },
      },
      cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
      variants: [{
        id: 'xhigh',
        disabled: true,
        headers: { Authorization: 'Bearer variant-header-secret' },
        body: { apiKey: 'variant-body-secret' },
      }],
      time: { released: 1_765_843_200_000 },
      status: 'active',
      enabled: true,
      limit: { context: 1_000_000, input: 900_000, output: 100_000 },
    }] as never,
  )

  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'openai')
  assert.equal(providers[0].connected, true)
  assert.deepEqual(providers[0].models?.['gpt-5.4'], {
    id: 'gpt-5.4',
    providerID: 'openai',
    family: 'gpt-5',
    name: 'GPT-5.4',
    capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    time: { released: 1_765_843_200_000 },
    cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
    status: 'active',
    enabled: true,
    limit: { context: 1_000_000, input: 900_000, output: 100_000 },
    variants: { xhigh: { id: 'xhigh', disabled: true } },
  })
  const serialized = JSON.stringify(providers)
  for (const secret of [
    'api-secret',
    'header-secret',
    'body-secret',
    'variant-header-secret',
    'variant-body-secret',
  ]) {
    assert.equal(serialized.includes(secret), false)
  }
  assert.equal(serialized.includes('Authorization'), false)
  assert.equal(serialized.includes('request'), false)
  assert.equal(serialized.includes('settings'), false)
})

test('combineNativeProviderCatalog treats hostile model ids as data, not object prototypes', () => {
  const providers = combineNativeProviderCatalog(
    [{ id: 'safe', name: 'Safe' }] as never,
    [{
      id: '__proto__',
      providerID: 'safe',
      name: 'Prototype-shaped model',
      capabilities: { tools: false, input: ['text'], output: ['text'] },
      cost: [],
      variants: [],
      time: { released: 0 },
      status: 'active',
      enabled: true,
      limit: { context: 1, output: 1 },
    }] as never,
  )

  assert.equal(Object.hasOwn(providers[0]?.models || {}, '__proto__'), true)
  assert.equal(({} as Record<string, unknown>).name, undefined)
})

test('listNativeProviders reads only the native V2 provider and model routes', async () => {
  const calls: string[] = []
  const client = {
    v2: {
      provider: {
        async list() {
          calls.push('v2.provider.list')
          return { data: { data: [{ id: 'acme', name: 'Acme' }] } }
        },
      },
      model: {
        async list() {
          calls.push('v2.model.list')
          return { data: { data: [] } }
        },
      },
    },
  }

  assert.deepEqual(await listNativeProviders(client as never), [{
    id: 'acme',
    name: 'Acme',
    models: {},
    connected: true,
  }])
  assert.deepEqual(calls.sort(), ['v2.model.list', 'v2.provider.list'])
})
