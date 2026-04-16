import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshAccessTokenIntoEnvironment } from '../apps/desktop/src/main/runtime-token-refresh.ts'

test('refreshAccessTokenIntoEnvironment stores a refreshed token in the environment', async () => {
  const env: NodeJS.ProcessEnv = {}
  const errors: string[] = []

  const result = await refreshAccessTokenIntoEnvironment({
    refreshAccessToken: async () => 'token-123',
    logError: (message) => errors.push(message),
    env,
  })

  assert.equal(result, 'token-123')
  assert.equal(env.GOOGLE_WORKSPACE_CLI_TOKEN, 'token-123')
  assert.deepEqual(errors, [])
})

test('refreshAccessTokenIntoEnvironment logs and suppresses refresh failures', async () => {
  const env: NodeJS.ProcessEnv = {}
  const errors: string[] = []

  const result = await refreshAccessTokenIntoEnvironment({
    refreshAccessToken: async () => {
      throw new Error('refresh failed')
    },
    logError: (message) => errors.push(message),
    env,
  })

  assert.equal(result, null)
  assert.equal(env.GOOGLE_WORKSPACE_CLI_TOKEN, undefined)
  assert.match(errors[0] || '', /refresh failed/)
})
