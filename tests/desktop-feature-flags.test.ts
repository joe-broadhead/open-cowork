import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DESKTOP_PRIMARY_FEATURE_KEYS,
  DESKTOP_SECONDARY_FEATURE_KEYS,
  isDesktopFeatureEnabled,
} from '../packages/shared/src/app-config.ts'

test('primary features default on when omitted', () => {
  for (const key of DESKTOP_PRIMARY_FEATURE_KEYS) {
    assert.equal(isDesktopFeatureEnabled(undefined, key), true)
    assert.equal(isDesktopFeatureEnabled({}, key), true)
  }
})

test('secondary Studio features default off when omitted', () => {
  for (const key of DESKTOP_SECONDARY_FEATURE_KEYS) {
    assert.equal(isDesktopFeatureEnabled(undefined, key), false)
    assert.equal(isDesktopFeatureEnabled({}, key), false)
  }
})

test('explicit true/false overrides defaults', () => {
  assert.equal(isDesktopFeatureEnabled({ knowledge: true }, 'knowledge'), true)
  assert.equal(isDesktopFeatureEnabled({ knowledge: false }, 'knowledge'), false)
  assert.equal(isDesktopFeatureEnabled({ projects: false }, 'projects'), false)
  assert.equal(isDesktopFeatureEnabled({ projects: true }, 'projects'), true)
})
