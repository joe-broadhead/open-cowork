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
