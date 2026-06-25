import test from 'node:test'
import assert from 'node:assert/strict'

import { cssColorLuminance } from '../packages/shared/src/design-tokens.ts'

test('cssColorLuminance rejects a pathological color string without catastrophic backtracking (P2)', () => {
  // A long run of spaces inside an unterminated rgb( previously caused catastrophic
  // backtracking on the colorFunctionArgs regex (reachable from operator branding tokens).
  const malicious = `rgb(${' '.repeat(100_000)}`
  const start = Date.now()
  assert.equal(cssColorLuminance(malicious), null)
  assert.ok(Date.now() - start < 1_000, 'must return promptly, not backtrack')

  // Valid colors still parse on both the comma and space-separated forms.
  assert.equal(typeof cssColorLuminance('rgb(255, 255, 255)'), 'number')
  assert.equal(typeof cssColorLuminance('rgb(0 0 0)'), 'number')
  assert.equal(typeof cssColorLuminance('#1a2b3c'), 'number')
})
