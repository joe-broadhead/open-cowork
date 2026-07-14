import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SMALL_MODEL_USE_MAIN } from '../packages/shared/src/app-config.ts'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'

// Persisted fixtures intentionally declare the current clean-baseline ledger.
// The schema-version test below also verifies this stays aligned with runtime.
const CURRENT_SETTINGS_SCHEMA_VERSION = 1

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
          smallModel: 'internal-fast',
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

function writeCredentialDescriptorConfig(configDir: string) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    providers: {
      available: ['acme'],
      defaultProvider: 'acme',
      defaultModel: 'acme/model',
      descriptors: {
        acme: {
          runtime: 'builtin',
          name: 'Acme',
          description: 'Acme provider',
          defaultModel: 'acme/model',
          credentials: [
            { key: 'apiKey', label: 'API key', description: 'Secret API key', secret: true },
            { key: 'projectId', label: 'Project', description: 'Visible project id', secret: false },
          ],
          models: [{ id: 'acme/model', name: 'Acme Model' }],
        },
      },
    },
    mcps: [{
      name: 'github',
      type: 'remote',
      description: 'GitHub',
      authMode: 'api_token',
      url: 'https://mcp.example.test/github',
      credentials: [
        { key: 'token', label: 'Token', description: 'Secret token', secret: true },
        { key: 'host', label: 'Host', description: 'Visible host', secret: false },
      ],
    }],
  }))
}

async function importFreshSettingsModule(label: string) {
  // settings now lives in @open-cowork/runtime-host; a package specifier can't
  // carry the cache-busting query, so reload the built dist module directly.
  return import(`../packages/runtime-host/dist/settings.js?${label}-${Date.now()}`)
}

test('native permission ask defaults initialize fresh profiles with toggles enabled', async () => {
  const tempRoot = testTempDir('open-cowork-settings-ask-defaults-')
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
    assert.equal(settings.bashPermission, 'ask')
    assert.equal(settings.fileWritePermission, 'ask')
    assert.equal(settings.webPermission, 'allow')
    assert.equal(settings.webSearchEnabled, true)
    assert.equal(settings.taskPermission, 'allow')
    assert.equal(settings.externalDirectoryPermission, 'allow')
    assert.equal(settings.mcpPermission, 'allow')
    assert.equal(settings.requireApprovalBeforeSending, true)
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
  const tempRoot = testTempDir('open-cowork-settings-public-defaults-')
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
    assert.equal(settings.bashPermission, 'ask')
    assert.equal(settings.fileWritePermission, 'ask')
    assert.equal(settings.webPermission, 'allow')
    assert.equal(settings.webSearchEnabled, true)
    assert.equal(settings.taskPermission, 'allow')
    assert.equal(settings.externalDirectoryPermission, 'allow')
    assert.equal(settings.mcpPermission, 'allow')
    assert.equal(settings.notificationVoiceReplies, true)
    assert.equal(settings.notificationDailyDigest, false)
    assert.equal(settings.privacyKeepConversationHistory, true)
    assert.equal(settings.privacyShareAnonymizedUsage, false)
    assert.equal(settings.runtimeConfigSource, 'app')
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
  const tempRoot = testTempDir('open-cowork-settings-normalize-')
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
      bashPermission: 'deny',
      workflowQuietHoursStart: '99:99',
      providerCredentials: {
        openrouter: {
          apiKey: 'valid-key',
          oversized: 'x'.repeat(65 * 1024),
        },
      },
      webPermission: 'allow',
      webSearchEnabled: false,
      taskPermission: 'deny',
      externalDirectoryPermission: 'ask',
      mcpPermission: 'deny',
      requireApprovalBeforeSending: false,
      notificationDailyDigest: true,
      privacyShareAnonymizedUsage: true,
      runtimeConfigSource: 'machine',
      unexpectedTopLevel: 'should not persist',
    } as any)

    const after = loadSettings() as any
    assert.equal(after.bashPermission, 'deny')
    assert.equal(after.workflowQuietHoursStart, before.workflowQuietHoursStart)
    assert.equal(after.providerCredentials.openrouter.apiKey, 'valid-key')
    assert.equal(after.providerCredentials.openrouter.oversized, undefined)
    assert.equal(after.webPermission, 'allow')
    assert.equal(after.webSearchEnabled, false)
    assert.equal(after.taskPermission, 'deny')
    assert.equal(after.externalDirectoryPermission, 'ask')
    assert.equal(after.mcpPermission, 'deny')
    assert.equal(after.requireApprovalBeforeSending, false)
    assert.equal(after.notificationDailyDigest, true)
    assert.equal(after.privacyShareAnonymizedUsage, true)
    assert.equal(after.runtimeConfigSource, 'machine')
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

test('saveSettings persists explicit native permission modes and clamps to downstream maximums', async () => {
  const tempRoot = testTempDir('open-cowork-settings-permission-modes-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeAskPermissionConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, saveSettings } = await importFreshSettingsModule('permission-modes')
    saveSettings({
      bashPermission: 'allow',
      fileWritePermission: 'deny',
    })

    const after = loadSettings()
    assert.equal(after.bashPermission, 'ask')
    assert.equal(after.fileWritePermission, 'deny')
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('saveSettings records an explicit persisted schema version', async () => {
  const tempRoot = testTempDir('open-cowork-settings-schema-version-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, saveSettings, SETTINGS_SCHEMA_VERSION } = await importFreshSettingsModule('schema-version')
    assert.equal(loadSettings()._schemaVersion, SETTINGS_SCHEMA_VERSION)
    saveSettings({ bashPermission: 'deny' })
    const persisted = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    assert.equal(persisted._schemaVersion, SETTINGS_SCHEMA_VERSION)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('window zoom defaults and persists within the accessible desktop range', async () => {
  const tempRoot = testTempDir('open-cowork-settings-window-zoom-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, saveSettings } = await importFreshSettingsModule('window-zoom')
    assert.equal(loadSettings().windowZoomFactor, 1)

    saveSettings({ windowZoomFactor: 1.234 })
    assert.equal(loadSettings().windowZoomFactor, 1.23)

    saveSettings({ windowZoomFactor: 12 })
    assert.equal(loadSettings().windowZoomFactor, 1.5)

    saveSettings({ windowZoomFactor: 0.1 })
    assert.equal(loadSettings().windowZoomFactor, 0.8)

    saveSettings({ windowZoomFactor: Number.NaN })
    assert.equal(loadSettings().windowZoomFactor, 0.8)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('loadSettings rejects a future schema without changing the settings file', async () => {
  const tempRoot = testTempDir('open-cowork-settings-future-schema-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { SETTINGS_SCHEMA_VERSION } = await importFreshSettingsModule('future-schema-constant')
    const settingsPath = join(userDataDir, 'settings.json')
    const original = JSON.stringify({
      _schemaVersion: SETTINGS_SCHEMA_VERSION + 1,
      selectedProviderId: 'openrouter',
      selectedModelId: 'openrouter/auto',
    })
    writeFileSync(settingsPath, original)
    const { loadSettings } = await importFreshSettingsModule('future-schema-load')
    assert.throws(
      () => loadSettings(),
      /requires exact settings schema version.*left untouched/,
    )
    assert.equal(readFileSync(settingsPath, 'utf-8'), original)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('loadSettings rejects missing and older schema ledgers without rewriting settings', async () => {
  const tempRoot = testTempDir('open-cowork-settings-noncurrent-schema-')
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir

  try {
    for (const [label, stored] of [
      ['missing', { selectedProviderId: 'openrouter' }],
      ['older', { _schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION - 1, selectedProviderId: 'openrouter' }],
    ] as const) {
      const userDataDir = join(tempRoot, label)
      const settingsPath = join(userDataDir, 'settings.json')
      mkdirSync(userDataDir, { recursive: true })
      const original = JSON.stringify(stored)
      writeFileSync(settingsPath, original)
      process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
      clearConfigCaches()

      const { loadSettings } = await importFreshSettingsModule(`noncurrent-${label}`)
      assert.throws(
        () => loadSettings(),
        /does not migrate settings in place.*left untouched/,
      )
      assert.equal(readFileSync(settingsPath, 'utf-8'), original)
    }
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('loadSettings reads current plaintext development settings in plaintext mode', async () => {
  const tempRoot = testTempDir('open-cowork-settings-plaintext-dev-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  const plaintextSettings = {
    _schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    selectedProviderId: 'openrouter',
    selectedModelId: 'openrouter/auto',
    providerCredentials: {
      openrouter: {
        apiKey: 'provider-secret',
      },
    },
  }
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(plaintextSettings))
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const settingsModule = await importFreshSettingsModule('plaintext-dev-settings')
    settingsModule.setSettingsSecretStorageForTests({
      mode: 'plaintext',
      encryptString: (value: string) => Buffer.from(`sealed:${value}`),
      decryptString: (raw: Buffer) => raw.toString('utf-8').replace(/^sealed:/, ''),
    })

    const settings = settingsModule.loadSettings()
    assert.equal(settings.selectedProviderId, 'openrouter')
    assert.equal(settings.providerCredentials.openrouter.apiKey, 'provider-secret')

    const persisted = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
    assert.equal(persisted.providerCredentials.openrouter.apiKey, 'provider-secret')
    assert.equal(existsSync(join(userDataDir, 'settings.enc')), false)
    settingsModule.setSettingsSecretStorageForTests(null)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('credential reads return descriptor-aware masks while default effective settings can be masked', async () => {
  const tempRoot = testTempDir('open-cowork-settings-scoped-credentials-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeCredentialDescriptorConfig(configDir)
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
          acme: { apiKey: 'provider-secret', projectId: 'project-visible' },
          databricks: { token: 'other-provider-secret' },
        },
        integrationCredentials: {
          github: { token: 'integration-secret', host: 'github.example.test' },
        },
      })

    const masked = maskEffectiveSettingsCredentials(getEffectiveSettings())
    assert.equal(masked.providerCredentials.acme.apiKey, CREDENTIAL_MASK)
    assert.equal(masked.providerCredentials.acme.projectId, CREDENTIAL_MASK)
    assert.equal(masked.integrationCredentials.github.token, CREDENTIAL_MASK)
    assert.equal(masked.integrationCredentials.github.host, CREDENTIAL_MASK)
    assert.deepEqual(getProviderCredentials('acme'), {
      apiKey: CREDENTIAL_MASK,
      projectId: 'project-visible',
    })
    assert.deepEqual(getIntegrationCredentials('github'), {
      token: CREDENTIAL_MASK,
      host: 'github.example.test',
    })
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('stored settings without optional permission fields inherit downstream ask defaults', async () => {
  const tempRoot = testTempDir('open-cowork-settings-stored-ask-defaults-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeAskPermissionConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    _schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    selectedProviderId: 'openrouter',
    selectedModelId: 'openrouter/auto',
  }))
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings } = await importFreshSettingsModule('stored-ask-defaults')
    const settings = loadSettings()
    assert.equal(settings.bashPermission, 'ask')
    assert.equal(settings.fileWritePermission, 'ask')
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
  const tempRoot = testTempDir('open-cowork-settings-provider-default-')
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
    assert.equal(effective.effectiveSmallModel, 'acme-large')
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
  const tempRoot = testTempDir('open-cowork-settings-provider-switch-default-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    _schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
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
    assert.equal(effective.effectiveSmallModel, 'internal-fast')
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
  const tempRoot = testTempDir('open-cowork-settings-prefixed-provider-model-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    _schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
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
    assert.equal(effective.effectiveSmallModel, 'internal-fast')
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('effective settings accept an explicit provider-prefixed small model', async () => {
  const tempRoot = testTempDir('open-cowork-settings-small-model-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    _schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    selectedProviderId: 'internal-gateway',
    selectedModelId: 'internal-balanced',
    selectedSmallModelId: 'internal-gateway/internal-fast',
  }))
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, getEffectiveSettings } = await importFreshSettingsModule('explicit-small-model')
    const effective = getEffectiveSettings(loadSettings())
    assert.equal(effective.effectiveProviderId, 'internal-gateway')
    assert.equal(effective.effectiveModel, 'internal-balanced')
    assert.equal(effective.effectiveSmallModel, 'internal-fast')
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('effective settings let small model explicitly follow the selected main model', async () => {
  const tempRoot = testTempDir('open-cowork-settings-small-model-main-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    _schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    selectedProviderId: 'internal-gateway',
    selectedModelId: 'internal-balanced',
    selectedSmallModelId: SMALL_MODEL_USE_MAIN,
  }))
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const { loadSettings, getEffectiveSettings } = await importFreshSettingsModule('small-model-main')
    const effective = getEffectiveSettings(loadSettings())
    assert.equal(effective.effectiveProviderId, 'internal-gateway')
    assert.equal(effective.effectiveModel, 'internal-balanced')
    assert.equal(effective.effectiveSmallModel, 'internal-balanced')
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
  const tempRoot = testTempDir('open-cowork-settings-provider-default-missing-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeProviderDefaultConfig(configDir, 'missing-model')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    _schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
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
