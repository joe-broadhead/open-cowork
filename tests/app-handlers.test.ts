import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureRuntimeAfterAuthLogin } from '../apps/desktop/src/main/ipc/app-handlers.ts'

test('ensureRuntimeAfterAuthLogin reboots an active runtime after successful sign-in', async () => {
  const calls: string[] = []

  await ensureRuntimeAfterAuthLogin({
    authenticated: true,
    setupComplete: true,
    hasActiveRuntime: true,
    bootRuntime: async () => {
      calls.push('boot')
    },
    rebootRuntime: async () => {
      calls.push('reboot')
    },
  })

  assert.deepEqual(calls, ['reboot'])
})

test('ensureRuntimeAfterAuthLogin boots when sign-in succeeded and no runtime is active', async () => {
  const calls: string[] = []

  await ensureRuntimeAfterAuthLogin({
    authenticated: true,
    setupComplete: true,
    hasActiveRuntime: false,
    bootRuntime: async () => {
      calls.push('boot')
    },
    rebootRuntime: async () => {
      calls.push('reboot')
    },
  })

  assert.deepEqual(calls, ['boot'])
})

test('ensureRuntimeAfterAuthLogin does nothing for incomplete or failed auth flows', async () => {
  const calls: string[] = []

  await ensureRuntimeAfterAuthLogin({
    authenticated: false,
    setupComplete: true,
    hasActiveRuntime: true,
    bootRuntime: async () => {
      calls.push('boot')
    },
    rebootRuntime: async () => {
      calls.push('reboot')
    },
  })

  await ensureRuntimeAfterAuthLogin({
    authenticated: true,
    setupComplete: false,
    hasActiveRuntime: true,
    bootRuntime: async () => {
      calls.push('boot')
    },
    rebootRuntime: async () => {
      calls.push('reboot')
    },
  })

  assert.deepEqual(calls, [])
})
