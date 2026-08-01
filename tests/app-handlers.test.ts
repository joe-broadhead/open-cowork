import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureRuntimeAfterAuthLogin,
  hasRuntimeSensitiveSettingsUpdate,
  mergeRuntimeProviderModels,
  runtimeSensitiveSettingsChanged,
} from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { validateSettingsUpdate } from '../apps/desktop/src/main/ipc/object-validators.ts'
import { clearConfigCaches, getPublicAppConfig } from '@open-cowork/runtime-host/config'
import { createDisabledRuntimeToolingBridgeConsent } from '@open-cowork/shared'
import { resolveDevelopmentSetupConnectionValidator } from '../apps/desktop/src/main/setup/connection-validation.ts'

test('packaged builds cannot enable the setup fixture validator through environment variables', () => {
  const env = {
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_SETUP_VALIDATION_KEY: 'fixture-key',
  }
  assert.equal(resolveDevelopmentSetupConnectionValidator({ isPackaged: true, env }), undefined)
  assert.equal(typeof resolveDevelopmentSetupConnectionValidator({ isPackaged: false, env }), 'function')
})

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

test('small model changes are runtime-sensitive settings updates', () => {
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ selectedSmallModelId: 'openrouter/qwen/qwen3-coder-flash' }), true)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ selectedSmallModelId: null }), true)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ webPermission: 'deny' }), true)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ webSearchEnabled: false }), true)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ taskPermission: 'ask' }), true)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ externalDirectoryPermission: 'ask' }), true)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ mcpPermission: 'deny' }), true)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({
    runtimeToolingBridge: createDisabledRuntimeToolingBridgeConsent(),
  }), true)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ notificationVoiceReplies: false }), false)
  assert.equal(hasRuntimeSensitiveSettingsUpdate({ workflowDesktopNotifications: false }), false)
})

test('runtime-sensitive settings only restart the runtime when their effective value changes', () => {
  const before = {
    selectedProviderId: 'openrouter',
    selectedModelId: 'anthropic/claude-sonnet-4',
    providerCredentials: { openrouter: { apiKey: 'secret' } },
  }
  assert.equal(runtimeSensitiveSettingsChanged(before, { ...before }), false)
  assert.equal(runtimeSensitiveSettingsChanged(before, {
    ...before,
    selectedModelId: 'openai/gpt-5.5',
  }), true)
  assert.equal(runtimeSensitiveSettingsChanged(before, {
    ...before,
    notificationVoiceReplies: false,
  }), false)
})

test('tooling bridge IPC accepts only the complete current granular consent contract', () => {
  const runtimeToolingBridge = createDisabledRuntimeToolingBridgeConsent()
  runtimeToolingBridge.categories.sourceControl = true
  assert.deepEqual(
    validateSettingsUpdate({ runtimeToolingBridge }).runtimeToolingBridge,
    runtimeToolingBridge,
  )
  assert.throws(
    () => validateSettingsUpdate({ runtimeToolingBridgeEnabled: true }),
    /Unknown settings key/,
  )
  assert.throws(
    () => validateSettingsUpdate({
      runtimeToolingBridge: {
        ...runtimeToolingBridge,
        version: 0,
      },
    }),
    /consent version/,
  )
  const missingCategory = Object.fromEntries(
    Object.entries(runtimeToolingBridge.categories).filter(([id]) => id !== 'ssh'),
  )
  assert.throws(
    () => validateSettingsUpdate({
      runtimeToolingBridge: {
        ...runtimeToolingBridge,
        categories: missingCategory,
      },
    }),
    /category "ssh" must be a boolean/,
  )
})

test('settings IPC accepts bounded startup appearance mirrors', () => {
  assert.deepEqual(
    validateSettingsUpdate({
      appearanceColorScheme: 'system',
      appearanceThemeId: 'northstar',
    }),
    {
      appearanceColorScheme: 'system',
      appearanceThemeId: 'northstar',
    },
  )
  assert.throws(
    () => validateSettingsUpdate({ appearanceColorScheme: 'sepia' }),
    /Appearance color scheme must be system, dark, or light/,
  )
  assert.throws(
    () => validateSettingsUpdate({ appearanceThemeId: '../northstar' }),
    /Appearance theme id must use lowercase letters, numbers, and hyphens/,
  )
})

test('mergeRuntimeProviderModels drops provider defaults absent from the live runtime catalog', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-provider-runtime-default-'))
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

test('mergeRuntimeProviderModels prefers OpenCode live defaults over app-wide defaults', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-provider-runtime-default-precedence-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    providers: {
      available: ['acme-provider'],
      defaultProvider: 'acme-provider',
      defaultModel: 'app-wide',
      descriptors: {
        'acme-provider': {
          runtime: 'builtin',
          name: 'Acme Provider',
          description: 'Acme provider',
          defaultModel: 'stale-local',
          credentials: [],
          models: [
            { id: 'app-wide', name: 'App Wide' },
          ],
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    const merged = mergeRuntimeProviderModels(getPublicAppConfig(), [{
      id: 'acme-provider',
      models: {
        'app-wide': { name: 'App Wide' },
        live: { name: 'Live' },
      },
      defaultModel: 'live',
    }])
    assert.equal(merged.providers.available[0]?.defaultModel, 'live')
  } finally {
    if (previousOverride === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('mergeRuntimeProviderModels preserves OpenCode defaults when the runtime omits the model list', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-provider-runtime-default-no-models-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    providers: {
      available: ['acme-provider'],
      defaultProvider: 'acme-provider',
      defaultModel: 'static-model',
      descriptors: {
        'acme-provider': {
          runtime: 'builtin',
          name: 'Acme Provider',
          description: 'Acme provider',
          credentials: [],
          models: [
            { id: 'static-model', name: 'Static Model' },
          ],
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    const merged = mergeRuntimeProviderModels(getPublicAppConfig(), [{
      id: 'acme-provider',
      defaultModel: 'runtime-owned-model',
      connected: true,
    }])
    assert.equal(merged.providers.available[0]?.defaultModel, 'runtime-owned-model')
    assert.equal(merged.providers.available[0]?.connected, true)
  } finally {
    if (previousOverride === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('mergeRuntimeProviderModels exposes OpenCode reasoning model metadata', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-provider-runtime-reasoning-'))
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
          credentials: [],
          models: [
            { id: 'live', name: 'Configured Live', featured: true },
          ],
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    const merged = mergeRuntimeProviderModels(getPublicAppConfig(), [{
      id: 'acme-provider',
      models: {
        live: {
          name: 'Live Reasoning',
          capabilities: { reasoning: true },
          variants: {
            xhigh: {},
            low: {},
            disabled: { disabled: true },
          },
        },
      },
      defaultModel: 'live',
      connected: true,
    }])
    const model = merged.providers.available[0]?.models.find((entry) => entry.id === 'live')

    assert.equal(model?.reasoning, true)
    assert.deepEqual(model?.variants, ['low', 'xhigh'])
    assert.equal(model?.name, 'Configured Live')
    assert.equal(model?.featured, true)
  } finally {
    if (previousOverride === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
