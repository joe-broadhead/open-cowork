import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  applyOperationalQueueSettings,
  resolveOperationalAutonomyCeiling,
} from '../apps/desktop/src/main/operational-queue-controls.ts'
import { saveSettings } from '../apps/desktop/src/main/settings.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

function writeEmptyConfig(configDir: string) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), '{}\n')
}

test('operational queue settings clamp autonomy/run caps and apply explicit write parallelism', () => {
  const tempRoot = testTempDir('opencowork-operational-controls-')
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeEmptyConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    saveSettings({
      operationalMaxAutonomy: 'approve',
      operationalWriteMaxParallel: 3,
      operationalMaxRunDurationMinutes: 30,
      operationalMaxCostUsd: 2.5,
      operationalMaxRetries: 1,
    })

    assert.equal(resolveOperationalAutonomyCeiling('bounded-auto'), 'approve')
    assert.equal(resolveOperationalAutonomyCeiling('draft'), 'draft')
    assert.deepEqual(applyOperationalQueueSettings({
      maxParallel: 1,
      maxRunDurationMinutes: 120,
      maxCostUsd: 5,
      maxRetries: 4,
    }, { writeCapable: true }), {
      maxParallel: 3,
      maxRunDurationMinutes: 30,
      maxCostUsd: 2.5,
      maxRetries: 1,
    })
    assert.equal(applyOperationalQueueSettings({ maxParallel: 2 }, { writeCapable: false }).maxParallel, 2)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
