import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticateMcpThroughRuntime } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'

test('authenticateMcpThroughRuntime routes explicit auth through the runtime client', async () => {
  const calls: Array<{ method: string; name: string }> = []

  const result = await authenticateMcpThroughRuntime({
    mcp: {
      auth: {
        remove: async (payload) => {
          calls.push({ method: 'remove', name: payload.name })
        },
        authenticate: async (payload) => {
          calls.push({ method: 'authenticate', name: payload.name })
        },
      },
    },
  }, 'nova')

  assert.equal(result, true)
  assert.deepEqual(calls, [
    { method: 'remove', name: 'nova' },
    { method: 'authenticate', name: 'nova' },
  ])
})

test('authenticateMcpThroughRuntime still authenticates when clearing stored auth fails', async () => {
  const calls: string[] = []

  const result = await authenticateMcpThroughRuntime({
    mcp: {
      auth: {
        remove: async () => {
          calls.push('remove')
          throw new Error('no saved credentials')
        },
        authenticate: async () => {
          calls.push('authenticate')
        },
      },
    },
  }, 'nova')

  assert.equal(result, true)
  assert.deepEqual(calls, ['remove', 'authenticate'])
})

test('authenticateMcpThroughRuntime surfaces runtime auth failures', async () => {
  await assert.rejects(
    authenticateMcpThroughRuntime({
      mcp: {
        auth: {
          authenticate: async () => {
            throw new Error('state mismatch')
          },
        },
      },
    }, 'nova'),
    /state mismatch/,
  )
})
