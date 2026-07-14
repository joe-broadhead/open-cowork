import { combineNativeProviderCatalog, listNativeProviders } from '@open-cowork/runtime-host/provider-utils'
import test from 'node:test'
import assert from 'node:assert/strict'

test('combineNativeProviderCatalog joins V2 providers, models, costs, and variants', () => {
  const providers = combineNativeProviderCatalog(
    [{ id: 'openai', name: 'OpenAI' }] as never,
    [{
      id: 'gpt-5.4',
      providerID: 'openai',
      name: 'GPT-5.4',
      cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
      variants: [{ id: 'xhigh', name: 'Extra high' }],
    }] as never,
  )

  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'openai')
  assert.equal(providers[0].connected, true)
  assert.deepEqual(providers[0].models?.['gpt-5.4'], {
    id: 'gpt-5.4',
    providerID: 'openai',
    name: 'GPT-5.4',
    cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
    variants: { xhigh: { id: 'xhigh', name: 'Extra high' } },
  })
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
