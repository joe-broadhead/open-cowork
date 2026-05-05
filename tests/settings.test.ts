import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

function writeAskPermissionConfig(configDir: string) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), `{
  "permissions": {
    "bash": "ask",
    "fileWrite": "ask",
    "task": "allow",
    "web": "allow",
    "webSearch": true
  }
}
`)
}

function writeEmptyConfig(configDir: string) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), '{}\n')
}

function writeProviderDefaultConfig(configDir: string, internalDefaultModel = 'internal-balanced') {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    providers: {
      available: ['acme-gateway', 'internal-gateway'],
      defaultProvider: 'acme-gateway',
      defaultModel: 'fallback-large',
      descriptors: {
        'acme-gateway': {
          runtime: 'builtin',
          name: 'Acme Gateway',
          description: 'Acme model gateway',
          defaultModel: 'acme-large',
          credentials: [],
          models: [
            { id: 'fallback-large', name: 'Fallback Large' },
            { id: 'acme-large', name: 'Acme Large' },
          ],
        },
        'internal-gateway': {
          runtime: 'builtin',
          name: 'Internal Gateway',
          description: 'Internal model gateway',
          defaultModel: internalDefaultModel,
          credentials: [],
          models: [
            { id: 'internal-fast', name: 'Internal Fast' },
            { id: 'internal-balanced', name: 'Internal Balanced' },
          ],
        },
      },
    },
  }))
}

async function importFreshSettingsModule(label: string) {
  return import(`../apps/desktop/src/main/settings.ts?${label}-${Date.now()}`)
}

test('native permission ask defaults initialize fresh profiles with toggles enabled', async () => {
  const tempRoot = testTempDir('opencowork-settings-ask-defaults-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeAskPermissionConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings } = await importFreshSettingsModule('fresh-ask-defaults')
    const settings = loadSettings()
    assert.equal(settings.enableBash, true)
    assert.equal(settings.enableFileWrite, true)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('default public config initializes native permission toggles enabled', async () => {
  const tempRoot = testTempDir('opencowork-settings-public-defaults-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings } = await importFreshSettingsModule('fresh-public-defaults')
    const settings = loadSettings()
    assert.equal(settings.enableBash, true)
    assert.equal(settings.enableFileWrite, true)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('saveSettings normalizes renderer updates before persistence', async () => {
  const tempRoot = testTempDir('opencowork-settings-normalize-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, saveSettings } = await importFreshSettingsModule('normalize-updates')
    const before = loadSettings()
    saveSettings({
      enableBash: false,
      automationQuietHoursStart: '99:99',
      defaultAutomationAutonomyPolicy: 'invalid',
      providerCredentials: {
        openrouter: {
          apiKey: 'valid-key',
          oversized: 'x'.repeat(65 * 1024),
        },
      },
      unexpectedTopLevel: 'should not persist',
    } as any)

    const after = loadSettings() as any
    assert.equal(after.enableBash, false)
    assert.equal(after.automationQuietHoursStart, before.automationQuietHoursStart)
    assert.equal(after.defaultAutomationAutonomyPolicy, before.defaultAutomationAutonomyPolicy)
    assert.equal(after.providerCredentials.openrouter.apiKey, 'valid-key')
    assert.equal(after.providerCredentials.openrouter.oversized, undefined)
    assert.equal(after.unexpectedTopLevel, undefined)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('credential reads are scoped while default effective settings can be masked', async () => {
  const tempRoot = testTempDir('opencowork-settings-scoped-credentials-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const {
      CREDENTIAL_MASK,
      getEffectiveSettings,
      getIntegrationCredentials,
      getProviderCredentials,
      maskEffectiveSettingsCredentials,
      saveSettings,
    } = await importFreshSettingsModule('scoped-credentials')
    saveSettings({
      providerCredentials: {
        openrouter: { apiKey: 'provider-secret' },
        databricks: { token: 'other-provider-secret' },
      },
      integrationCredentials: {
        github: { token: 'integration-secret' },
      },
    })

    const masked = maskEffectiveSettingsCredentials(getEffectiveSettings())
    assert.equal(masked.providerCredentials.openrouter.apiKey, CREDENTIAL_MASK)
    assert.equal(masked.integrationCredentials.github.token, CREDENTIAL_MASK)
    assert.deepEqual(getProviderCredentials('openrouter'), { apiKey: 'provider-secret' })
    assert.deepEqual(getIntegrationCredentials('github'), { token: 'integration-secret' })
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('legacy settings without native toggles inherit downstream ask defaults', async () => {
  const tempRoot = testTempDir('opencowork-settings-legacy-ask-defaults-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeAskPermissionConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    selectedProviderId: 'openrouter',
    selectedModelId: 'openrouter/auto',
  }))
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings } = await importFreshSettingsModule('legacy-ask-defaults')
    const settings = loadSettings()
    assert.equal(settings.enableBash, true)
    assert.equal(settings.enableFileWrite, true)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('fresh settings initialize to the default provider local default model', async () => {
  const tempRoot = testTempDir('opencowork-settings-provider-default-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, getEffectiveSettings } = await importFreshSettingsModule('fresh-provider-default')
    const settings = loadSettings()
    const effective = getEffectiveSettings(settings)
    assert.equal(settings.selectedProviderId, 'acme-gateway')
    assert.equal(settings.selectedModelId, 'acme-large')
    assert.equal(effective.effectiveProviderId, 'acme-gateway')
    assert.equal(effective.effectiveModel, 'acme-large')
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('effective settings use a selected provider local default when the saved model belongs to another provider', async () => {
  const tempRoot = testTempDir('opencowork-settings-provider-switch-default-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    selectedProviderId: 'internal-gateway',
    selectedModelId: 'acme-large',
  }))
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, getEffectiveSettings } = await importFreshSettingsModule('provider-switch-default')
    const effective = getEffectiveSettings(loadSettings())
    assert.equal(effective.effectiveProviderId, 'internal-gateway')
    assert.equal(effective.effectiveModel, 'internal-balanced')
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('effective settings accept provider-prefixed model ids for configured provider catalogs', async () => {
  const tempRoot = testTempDir('opencowork-settings-prefixed-provider-model-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    selectedProviderId: 'internal-gateway',
    selectedModelId: 'internal-gateway/internal-fast',
  }))
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, getEffectiveSettings } = await importFreshSettingsModule('prefixed-provider-model')
    const effective = getEffectiveSettings(loadSettings())
    assert.equal(effective.effectiveProviderId, 'internal-gateway')
    assert.equal(effective.effectiveModel, 'internal-fast')
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('effective settings fall back to the first provider model when the provider local default is unavailable', async () => {
  const tempRoot = testTempDir('opencowork-settings-provider-default-missing-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir, 'missing-model')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    selectedProviderId: 'internal-gateway',
    selectedModelId: 'acme-large',
  }))
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, getEffectiveSettings } = await importFreshSettingsModule('provider-default-missing')
    const effective = getEffectiveSettings(loadSettings())
    assert.equal(effective.effectiveProviderId, 'internal-gateway')
    assert.equal(effective.effectiveModel, 'internal-fast')
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
