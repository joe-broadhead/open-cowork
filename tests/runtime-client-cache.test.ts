import { getOrCreateDirectoryClient } from '@open-cowork/runtime-host/runtime-client-cache'
import assert from 'node:assert/strict'
import test from 'node:test'
test('directory client cache returns the base client for the runtime home', () => {
  const cache = new Map<string, object>()
  const baseClient = { id: 'base' }

  const result = getOrCreateDirectoryClient({
    baseClient,
    serverUrl: 'http://127.0.0.1:8765',
    directory: '/runtime-home',
    runtimeHomeDir: '/runtime-home',
    cache,
    maxEntries: 2,
    createClient: () => ({ id: 'scoped' }),
  })

  assert.equal(result, baseClient)
  assert.equal(cache.size, 0)
})

test('directory client cache reuses scoped clients and evicts the oldest entry', () => {
  const cache = new Map<string, { id: string }>()
  const baseClient = { id: 'base' }
  let created = 0

  const createClient = (_baseUrl: string, directory: string) => {
    created += 1
    return { id: `client:${directory}:${created}` }
  }

  const first = getOrCreateDirectoryClient({
    baseClient,
    serverUrl: 'http://127.0.0.1:8765',
    directory: '/a',
    runtimeHomeDir: '/runtime-home',
    cache,
    maxEntries: 2,
    createClient,
  })
  const second = getOrCreateDirectoryClient({
    baseClient,
    serverUrl: 'http://127.0.0.1:8765',
    directory: '/b',
    runtimeHomeDir: '/runtime-home',
    cache,
    maxEntries: 2,
    createClient,
  })
  const reusedFirst = getOrCreateDirectoryClient({
    baseClient,
    serverUrl: 'http://127.0.0.1:8765',
    directory: '/a',
    runtimeHomeDir: '/runtime-home',
    cache,
    maxEntries: 2,
    createClient,
  })
  const third = getOrCreateDirectoryClient({
    baseClient,
    serverUrl: 'http://127.0.0.1:8765',
    directory: '/c',
    runtimeHomeDir: '/runtime-home',
    cache,
    maxEntries: 2,
    createClient,
  })

  assert.equal(first?.id.startsWith('client:/a:'), true)
  assert.equal(second?.id.startsWith('client:/b:'), true)
  assert.equal(reusedFirst, first)
  assert.equal(cache.has('/b'), false)
  assert.equal(cache.has('/a'), true)
  assert.equal(cache.has('/c'), true)
  assert.equal(third?.id.startsWith('client:/c:'), true)
})

test('directory client cache can retain more than fifty scoped clients without eviction', () => {
  const cache = new Map<string, { id: string }>()
  const baseClient = { id: 'base' }
  const evicted: string[] = []

  for (let index = 0; index < 60; index += 1) {
    const directory = `/project-${index}`
    const client = getOrCreateDirectoryClient({
      baseClient,
      serverUrl: 'http://127.0.0.1:8765',
      directory,
      runtimeHomeDir: '/runtime-home',
      cache,
      maxEntries: 10_000,
      createClient: (_baseUrl, scopedDirectory) => ({ id: `client:${scopedDirectory}` }),
      onEvict: (_client, scopedDirectory) => {
        evicted.push(scopedDirectory)
      },
    })

    assert.equal(client?.id, `client:${directory}`)
  }

  assert.equal(cache.size, 60)
  assert.deepEqual(evicted, [])
})
