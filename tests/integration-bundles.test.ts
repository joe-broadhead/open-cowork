import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_INTEGRATION_BUNDLES, getConfiguredIntegrationBundles } from '../apps/desktop/src/main/integration-bundles.ts'

test('open core ships with no configured integration bundles by default', () => {
  assert.deepEqual(BUILTIN_INTEGRATION_BUNDLES, [])
  assert.deepEqual(getConfiguredIntegrationBundles(), [])
})
