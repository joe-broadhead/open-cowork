import test from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'

import {
  generateCloudApiToken,
  hashCloudApiToken,
  plaintextMatchesCloudApiTokenId,
  verifyCloudApiTokenHash,
} from '@open-cowork/cloud-server/control-plane-tokens'

test('cloud API token hashes use per-token salts while preserving legacy verification', () => {
  const generated = generateCloudApiToken({ tokenId: 'tok_test', secret: 'secret-value' })
  const first = hashCloudApiToken(generated.plaintext)
  const second = hashCloudApiToken(generated.plaintext)

  assert.match(first, /^scrypt-v2:/)
  assert.notEqual(first, second)
  assert.equal(verifyCloudApiTokenHash(generated.plaintext, first), true)
  assert.equal(verifyCloudApiTokenHash(`${generated.plaintext}-wrong`, first), false)
  assert.equal(plaintextMatchesCloudApiTokenId(generated.plaintext, generated.tokenId), true)

  const legacyHash = `scrypt:${scryptSync(generated.plaintext, 'open-cowork-cloud-api-token-hash-v1', 32).toString('base64url')}`
  assert.equal(verifyCloudApiTokenHash(generated.plaintext, legacyHash), true)
})
