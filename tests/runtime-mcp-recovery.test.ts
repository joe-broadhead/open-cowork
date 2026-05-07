import test from 'node:test'
import assert from 'node:assert/strict'
import { createStartupMcpRecovery } from '../apps/desktop/src/main/runtime-mcp-recovery.ts'

function createFakeClient() {
  const connected: string[] = []
  return {
    connected,
    client: {
      mcp: {
        connect: async ({ name }: { name: string }) => {
          connected.push(name)
        },
      },
    },
  }
}

test('startup MCP recovery retries failed local MCPs with a per-MCP cap', async () => {
  const fake = createFakeClient()
  const recovery = createStartupMcpRecovery({
    client: fake.client,
    runtimeProjectDirectory: null,
    recoverableLocalNames: ['charts'],
    googleAuthLocalNames: [],
  })

  const statuses = [{ name: 'charts', connected: false, rawStatus: 'failed' }]
  await recovery.recoverFailedLocalMcps(statuses)
  await recovery.recoverFailedLocalMcps(statuses)
  await recovery.recoverFailedLocalMcps(statuses)
  await recovery.recoverFailedLocalMcps(statuses)

  assert.deepEqual(fake.connected, ['charts', 'charts', 'charts'])
})

test('startup MCP recovery refreshes Google-auth MCPs through the auth path', async () => {
  const fake = createFakeClient()
  let refreshCount = 0
  const recovery = createStartupMcpRecovery({
    client: fake.client,
    runtimeProjectDirectory: null,
    recoverableLocalNames: ['google-sheets'],
    googleAuthLocalNames: ['google-sheets'],
    refreshGoogleAuth: async () => {
      refreshCount += 1
      return true
    },
  })

  const statuses = [{ name: 'google-sheets', connected: false, rawStatus: 'failed' }]
  await recovery.recoverFailedLocalMcps(statuses)
  assert.deepEqual(fake.connected, [])

  await recovery.recoverDisconnectedGoogleAuthMcps(statuses)
  assert.equal(refreshCount, 1)
  assert.deepEqual(fake.connected, ['google-sheets'])
})

test('startup MCP recovery skips Google-auth MCP reconnects when auth refresh is unavailable', async () => {
  const fake = createFakeClient()
  const recovery = createStartupMcpRecovery({
    client: fake.client,
    runtimeProjectDirectory: null,
    recoverableLocalNames: ['google-sheets'],
    googleAuthLocalNames: ['google-sheets'],
    refreshGoogleAuth: async () => false,
  })

  await recovery.recoverDisconnectedGoogleAuthMcps([
    { name: 'google-sheets', connected: false, rawStatus: 'failed' },
  ])

  assert.deepEqual(fake.connected, [])
})
