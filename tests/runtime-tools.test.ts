import test from 'node:test'
import assert from 'node:assert/strict'
import { invalidateRuntimeToolCache } from '../apps/desktop/src/main/runtime-tool-cache.ts'
import { runtimeState } from '../apps/desktop/src/main/runtime-state.ts'
import {
  isVisibleRuntimeToolId,
  listRuntimeToolsForResolvedContext,
  runtimeToolId,
  toRuntimeToolMetadata,
} from '../apps/desktop/src/main/runtime-tools.ts'

type RuntimeClient = Parameters<typeof runtimeState.setClient>[0]

test('internal OpenCode runtime tools are hidden from Cowork tool catalogs', () => {
  assert.equal(isVisibleRuntimeToolId('skill'), false)
  assert.equal(isVisibleRuntimeToolId('invalid'), false)
  assert.equal(isVisibleRuntimeToolId('websearch'), true)
})

test('runtime tool metadata skips hidden internal tools', () => {
  assert.equal(
    toRuntimeToolMetadata({
      id: 'invalid',
      description: 'Do not use.',
    }),
    null,
  )

  assert.equal(
    toRuntimeToolMetadata({
      id: 'skill',
      description: 'Internal skill loading tool.',
    }),
    null,
  )

  assert.deepEqual(
    toRuntimeToolMetadata({
      id: 'websearch',
      description: 'Search the web.',
    }),
    { id: 'websearch', description: 'Search the web.' },
  )
})

test('runtime tool discovery coalesces concurrent calls and reuses the cache', async () => {
  let calls = 0
  let releaseDiscovery!: () => void
  const discoveryGate = new Promise<void>((resolve) => {
    releaseDiscovery = resolve
  })
  const fakeClient = {
    tool: {
      list: async (request: Record<string, unknown>) => {
        calls += 1
        assert.equal(request.directory, '/workspace/large-mcp-catalog')
        assert.equal(request.provider, 'openrouter')
        assert.equal(request.model, 'openrouter/model')
        await discoveryGate
        return {
          data: [
            { id: 'bash', description: 'Run shell commands.' },
            { id: 'skill', description: 'Hidden runtime implementation detail.' },
          ],
        }
      },
    },
  }

  invalidateRuntimeToolCache()
  runtimeState.setClient(fakeClient as RuntimeClient)
  runtimeState.setServerUrl(null)
  try {
    const request = {
      directory: '/workspace/large-mcp-catalog',
      provider: 'openrouter',
      model: 'openrouter/model',
    }
    const first = listRuntimeToolsForResolvedContext(request)
    const second = listRuntimeToolsForResolvedContext(request)
    releaseDiscovery()

    const [firstTools, secondTools] = await Promise.all([first, second])
    assert.equal(calls, 1)
    assert.deepEqual(firstTools.map(runtimeToolId), ['bash'])
    assert.deepEqual(secondTools.map(runtimeToolId), ['bash'])

    const cachedTools = await listRuntimeToolsForResolvedContext(request)
    assert.equal(calls, 1)
    assert.deepEqual(cachedTools.map(runtimeToolId), ['bash'])
  } finally {
    invalidateRuntimeToolCache()
    runtimeState.resetAfterStop()
  }
})

test('runtime tool discovery does not cache stale in-flight results after invalidation', async () => {
  let calls = 0
  let releaseFirstDiscovery!: () => void
  const firstDiscoveryGate = new Promise<void>((resolve) => {
    releaseFirstDiscovery = resolve
  })
  const fakeClient = {
    tool: {
      list: async () => {
        calls += 1
        if (calls === 1) {
          await firstDiscoveryGate
        }
        return {
          data: [
            { id: 'bash', description: 'Run shell commands.' },
          ],
        }
      },
    },
  }

  invalidateRuntimeToolCache()
  runtimeState.setClient(fakeClient as RuntimeClient)
  runtimeState.setServerUrl(null)
  try {
    const request = {
      directory: '/workspace/cache-invalidation',
      provider: 'openrouter',
      model: 'openrouter/model',
    }
    const staleDiscovery = listRuntimeToolsForResolvedContext(request)
    invalidateRuntimeToolCache()
    releaseFirstDiscovery()

    assert.deepEqual((await staleDiscovery).map(runtimeToolId), ['bash'])
    assert.equal(calls, 1)

    const freshDiscovery = await listRuntimeToolsForResolvedContext(request)
    assert.deepEqual(freshDiscovery.map(runtimeToolId), ['bash'])
    assert.equal(calls, 2)

    const cachedFreshDiscovery = await listRuntimeToolsForResolvedContext(request)
    assert.deepEqual(cachedFreshDiscovery.map(runtimeToolId), ['bash'])
    assert.equal(calls, 2)
  } finally {
    invalidateRuntimeToolCache()
    runtimeState.resetAfterStop()
  }
})
