import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticateMcpThroughRuntime } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'

test('authenticateMcpThroughRuntime routes explicit auth through the runtime client', async () => {
  const calls: Array<{ name: string }> = []

  const result = await authenticateMcpThroughRuntime({
    mcp: {
      auth: {
        authenticate: async (payload) => {
          calls.push(payload)
        },
      },
    },
  }, 'nova')

  assert.equal(result, true)
  assert.deepEqual(calls, [{ name: 'nova' }])
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
