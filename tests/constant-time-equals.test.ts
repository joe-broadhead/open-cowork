import test from 'node:test'
import assert from 'node:assert/strict'

import { constantTimeEquals } from '@open-cowork/shared/node'

test('constantTimeEquals matches equal non-empty strings and rejects mismatches', () => {
  assert.equal(constantTimeEquals('secret-token', 'secret-token'), true)
  assert.equal(constantTimeEquals('secret-token', 'secret-tokeX'), false)
  assert.equal(constantTimeEquals('short', 'longer-value'), false) // unequal length, no throw
})

test('constantTimeEquals falsy guard: empty/missing inputs never match (audit P3-7)', () => {
  // The behaviour the cloud copies omitted — a misconfigured empty secret must not be bypassable.
  assert.equal(constantTimeEquals('', ''), false)
  assert.equal(constantTimeEquals('', 'x'), false)
  assert.equal(constantTimeEquals('x', ''), false)
  assert.equal(constantTimeEquals(null, null), false)
  assert.equal(constantTimeEquals(undefined, 'x'), false)
})
