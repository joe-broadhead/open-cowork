import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SETUP_HEALTH_CHECK_IDS,
  SETUP_HEALTH_CHECKS,
  SETUP_INTENT_IDS,
  SETUP_INTENTS,
  setupHealthCheckById,
  setupIntentById,
} from '../packages/shared/src/setup-health.ts'
import {
  workspaceAuthorityContract,
} from '../packages/shared/src/workspace.ts'
import {
  SETUP_HEALTH_CHECKS as DIST_SETUP_HEALTH_CHECKS,
  SETUP_INTENTS as DIST_SETUP_INTENTS,
  setupHealthCheckById as distSetupHealthCheckById,
  setupIntentById as distSetupIntentById,
} from '../packages/shared/dist/index.js'

test('setup health contract covers every first-run topology path', () => {
  const intentIds = new Set(SETUP_INTENTS.map((intent) => intent.id))
  assert.deepEqual([...intentIds].sort(), [...SETUP_INTENT_IDS].sort())
  for (const intent of SETUP_INTENTS) {
    assert.equal(setupIntentById(intent.id)?.id, intent.id)
    assert.ok(intent.label)
    assert.ok(intent.summary)
    assert.ok(intent.topologyProfile)
    assert.ok(intent.primaryDocs.startsWith('docs/'))
    assert.ok(intent.readyWhen.length > 0)
    assert.ok(intent.nextActions.length > 0)
    if (intent.authority !== 'mixed') {
      assert.equal(workspaceAuthorityContract(intent.authority).authority, intent.authority)
    }
  }
})

test('setup health checks provide recovery docs for release readiness', () => {
  const checkIds = new Set(SETUP_HEALTH_CHECKS.map((check) => check.id))
  assert.deepEqual([...checkIds].sort(), [...SETUP_HEALTH_CHECK_IDS].sort())
  for (const check of SETUP_HEALTH_CHECKS) {
    assert.equal(setupHealthCheckById(check.id)?.id, check.id)
    assert.ok(check.label)
    assert.ok(check.recoveryAction)
    assert.ok(check.docs.length > 0)
  }
})

test('built shared package exports setup and health helpers', () => {
  assert.deepEqual(
    DIST_SETUP_INTENTS.map((intent) => intent.id).sort(),
    SETUP_INTENTS.map((intent) => intent.id).sort(),
  )
  assert.deepEqual(
    DIST_SETUP_HEALTH_CHECKS.map((check) => check.id).sort(),
    SETUP_HEALTH_CHECKS.map((check) => check.id).sort(),
  )
  assert.equal(distSetupIntentById('full-hybrid')?.authority, 'mixed')
  assert.equal(distSetupIntentById('missing-intent'), null)
  assert.equal(
    distSetupHealthCheckById('gateway.operator_auth.configured')?.severityWhenMissing,
    'action_required',
  )
  assert.equal(distSetupHealthCheckById('missing-check'), null)
})

test('desktop setup and health surfaces consume the shared setup contract', () => {
  const setupScreen = readFileSync('apps/desktop/src/renderer/components/SetupScreen.tsx', 'utf8')
  const healthCenter = readFileSync('apps/desktop/src/renderer/components/health/HealthCenterPage.tsx', 'utf8')
  const sidebar = readFileSync('apps/desktop/src/renderer/components/layout/Sidebar.tsx', 'utf8')
  assert.match(setupScreen, /SETUP_INTENTS/)
  assert.match(healthCenter, /SETUP_INTENTS/)
  assert.match(healthCenter, /workspace\.support/)
  assert.match(healthCenter, /runtime\.status/)
  assert.match(healthCenter, /runtimeInputs/)
  assert.match(healthCenter, /desktopPairing\.list/)
  assert.match(sidebar, /Health Center/)
})
