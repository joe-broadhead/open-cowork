import test from 'node:test'
import assert from 'node:assert/strict'

import {
  imposesCopyleft,
  isCopyleftLicenseId,
} from '../scripts/check-license-compatibility.mjs'

test('isCopyleftLicenseId flags the strong-copyleft SPDX families', () => {
  for (const id of [
    'GPL-2.0-only',
    'GPL-3.0-or-later',
    'GPL-2.0+',
    'AGPL-3.0-only',
    'LGPL-2.1-only',
    'LGPL-3.0',
    'SSPL-1.0',
    'CPAL-1.0',
    'EUPL-1.2',
    'GPL-3.0-with-classpath-exception',
  ]) {
    assert.equal(isCopyleftLicenseId(id), true, `${id} must be classified as copyleft`)
  }
})

test('isCopyleftLicenseId leaves permissive and weak-copyleft ids alone', () => {
  for (const id of [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'MPL-2.0',
    '0BSD',
    'Unlicense',
    'Python-2.0',
    'BlueOak-1.0.0',
    'OFL-1.1',
  ]) {
    assert.equal(isCopyleftLicenseId(id), false, `${id} must not be classified as copyleft`)
  }
})

test('imposesCopyleft evaluates SPDX expressions, dual licenses, and exceptions', () => {
  // Single permissive ids and empty/unknown values do not impose copyleft.
  assert.equal(imposesCopyleft('MIT'), false)
  assert.equal(imposesCopyleft(''), false)
  assert.equal(imposesCopyleft('UNKNOWN'), false)

  // A single copyleft id imposes copyleft.
  assert.equal(imposesCopyleft('GPL-3.0-only'), true)
  assert.equal(imposesCopyleft('AGPL-3.0'), true)

  // OR alternatives: copyleft only when EVERY alternative is copyleft.
  assert.equal(imposesCopyleft('(MIT OR GPL-2.0)'), false)
  assert.equal(imposesCopyleft('(MPL-2.0 OR Apache-2.0)'), false)
  assert.equal(imposesCopyleft('MIT OR GPL-2.0'), false)
  assert.equal(imposesCopyleft('(GPL-2.0-only OR AGPL-3.0-only)'), true)

  // AND terms all apply: copyleft when any term is copyleft.
  assert.equal(imposesCopyleft('GPL-2.0 AND MIT'), true)
  assert.equal(imposesCopyleft('MIT AND Apache-2.0'), false)

  // WITH-exception base ids keep their underlying classification.
  assert.equal(imposesCopyleft('Apache-2.0 WITH LLVM-exception'), false)
  assert.equal(imposesCopyleft('GPL-3.0-only WITH Classpath-exception-2.0'), true)

  // Comma-joined alternatives (legacy npm `licenses` arrays) behave like OR.
  assert.equal(imposesCopyleft('MIT, GPL-2.0'), false)
  assert.equal(imposesCopyleft('GPL-2.0, LGPL-3.0'), true)
})
