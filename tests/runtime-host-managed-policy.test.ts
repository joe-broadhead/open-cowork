import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  EMPTY_MANAGED_POLICY,
  clampLevelToCeiling,
  clampManagedPolicyDimension,
  clampManagedPolicyPermissions,
  filterProvidersByManagedPolicy,
  isManagedPolicyExtensionClassEnabled,
  isModelAllowedByManagedPolicy,
  isProviderAllowedByManagedPolicy,
  getActiveManagedPolicy,
  setActiveManagedPolicy,
  resetActiveManagedPolicyCache,
} from '@open-cowork/runtime-host/managed-policy'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import type { ManagedDesktopPolicy } from '@open-cowork/shared'

function restrictivePolicy(): ManagedDesktopPolicy {
  return {
    allowedProviders: ['openai'],
    deniedProviders: ['forbidden'],
    allowedModels: ['gpt-x'],
    deniedModels: ['gpt-legacy'],
    keyManagement: 'byok_required',
    extensions: { customProviders: false, customMcps: true, customSkills: false },
    features: {},
    permissionCeilings: {
      bash: 'deny',
      fileWrite: 'ask',
      web: 'allow',
      webSearch: 'deny',
      task: 'allow',
      mcp: 'ask',
      externalDirectory: 'deny',
    },
    updateChannel: 'stable',
  }
}

test('managed policy clamp is tighten-never-loosen', () => {
  // The org ceiling can only make a level stricter (deny < ask < allow).
  assert.equal(clampLevelToCeiling('allow', 'deny'), 'deny')
  assert.equal(clampLevelToCeiling('allow', 'ask'), 'ask')
  assert.equal(clampLevelToCeiling('ask', 'deny'), 'deny')
  // It never loosens: a stricter base beats a looser ceiling.
  assert.equal(clampLevelToCeiling('deny', 'allow'), 'deny')
  assert.equal(clampLevelToCeiling('ask', 'allow'), 'ask')
  // An absent/invalid ceiling is a no-op ('allow').
  assert.equal(clampLevelToCeiling('ask', undefined), 'ask')

  const policy = restrictivePolicy()
  assert.equal(clampManagedPolicyDimension('allow', 'bash', policy), 'deny')
  assert.equal(clampManagedPolicyDimension('allow', 'web', policy), 'allow')
  assert.equal(clampManagedPolicyDimension('allow', 'bash', null), 'allow')

  const clamped = clampManagedPolicyPermissions(
    { bash: 'allow', fileWrite: 'allow', web: 'allow', webSearch: 'allow', task: 'allow', mcp: 'allow', externalDirectory: 'allow' },
    policy,
  )
  assert.equal(clamped.bash, 'deny')
  assert.equal(clamped.fileWrite, 'ask')
  assert.equal(clamped.web, 'allow')
  assert.equal(clamped.externalDirectory, 'deny')
})

test('managed policy scopes providers/models and gates extension classes', () => {
  const policy = restrictivePolicy()
  assert.deepEqual(filterProvidersByManagedPolicy(['openai', 'anthropic', 'forbidden'], policy), ['openai'])
  assert.deepEqual(filterProvidersByManagedPolicy(['openai', 'anthropic'], null), ['openai', 'anthropic'])
  assert.equal(isProviderAllowedByManagedPolicy('openai', policy), true)
  assert.equal(isProviderAllowedByManagedPolicy('anthropic', policy), false)
  assert.equal(isModelAllowedByManagedPolicy('gpt-x', policy), true)
  assert.equal(isModelAllowedByManagedPolicy('gpt-legacy', policy), false)
  assert.equal(isModelAllowedByManagedPolicy('anything', null), true)
  assert.equal(isManagedPolicyExtensionClassEnabled(policy, 'customProviders'), false)
  assert.equal(isManagedPolicyExtensionClassEnabled(policy, 'customMcps'), true)
  assert.equal(isManagedPolicyExtensionClassEnabled(null, 'customSkills'), true)
})

test('active managed policy is offline-safe: persists across a cache reset, clears on null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-policy-'))
  const previousEnv = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_USER_DATA_DIR = dir
  clearConfigCaches()
  resetActiveManagedPolicyCache()
  try {
    // No policy set ⇒ the unrestricted baseline (no-op enforcement).
    assert.equal(getActiveManagedPolicy(), EMPTY_MANAGED_POLICY)

    const policy = restrictivePolicy()
    setActiveManagedPolicy(policy)
    assert.equal(getActiveManagedPolicy().permissionCeilings.bash, 'deny')

    // Simulate a restart while offline: drop the in-memory cache; the last-known policy
    // is reloaded from disk and keeps enforcing.
    resetActiveManagedPolicyCache()
    const reloaded = getActiveManagedPolicy()
    assert.equal(reloaded.permissionCeilings.bash, 'deny')
    assert.deepEqual(reloaded.allowedProviders, ['openai'])

    // An explicit clear (sign-out / org removal) removes enforcement.
    setActiveManagedPolicy(null)
    resetActiveManagedPolicyCache()
    assert.equal(getActiveManagedPolicy(), EMPTY_MANAGED_POLICY)
  } finally {
    setActiveManagedPolicy(null)
    resetActiveManagedPolicyCache()
    if (previousEnv === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousEnv
    clearConfigCaches()
    rmSync(dir, { recursive: true, force: true })
  }
})
