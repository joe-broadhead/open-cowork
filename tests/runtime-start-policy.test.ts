import assert from 'node:assert/strict'
import test from 'node:test'

import { canStartDesktopRuntime } from '../apps/desktop/src/main/runtime-start-policy.ts'

test('desktop runtime starts only for a proof or the explicit setup-validation intent', () => {
  assert.equal(canStartDesktopRuntime(true, 'validated'), true)
  assert.equal(canStartDesktopRuntime(false, 'validated'), false)
  assert.equal(canStartDesktopRuntime(false, 'setup_connection_validation'), true)
})
