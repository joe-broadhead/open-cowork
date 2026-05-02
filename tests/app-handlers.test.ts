import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureRuntimeAfterAuthLogin, mergeRuntimeProviderModels } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { clearConfigCaches, getPublicAppConfig } from '../apps/desktop/src/main/config-loader.ts'

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

test('mergeRuntimeProviderModels drops provider defaults absent from the live runtime catalog', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-provider-runtime-default-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    providers: {
      available: ['acme-provider'],
      defaultProvider: 'acme-provider',
      defaultModel: null,
      descriptors: {
        'acme-provider': {
          runtime: 'builtin',
          name: 'Acme Provider',
          description: 'Acme provider',
          defaultModel: 'stale-default',
          credentials: [],
          models: [],
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    const config = getPublicAppConfig()
    assert.equal(config.providers.available[0]?.defaultModel, 'stale-default')

    const merged = mergeRuntimeProviderModels(config, [{
      id: 'acme-provider',
      models: {
        live: { name: 'Live' },
      },
      connected: true,
    }])
    assert.equal(merged.providers.available[0]?.defaultModel, undefined)
    assert.equal(merged.providers.available[0]?.connected, true)

    const withRuntimeDefault = mergeRuntimeProviderModels(config, [{
      id: 'acme-provider',
      models: {
        live: { name: 'Live' },
      },
      defaultModel: 'live',
    }])
    assert.equal(withRuntimeDefault.providers.available[0]?.defaultModel, 'live')
  } finally {
    if (previousOverride === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
