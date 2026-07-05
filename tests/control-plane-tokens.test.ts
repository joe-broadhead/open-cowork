import test from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'

import {
  generateChannelInteractionToken,
  generateCloudApiToken,
  hashChannelInteractionToken,
  hashCloudApiToken,
  plaintextMatchesChannelInteractionId,
  plaintextMatchesCloudApiTokenId,
  verifyChannelInteractionTokenHash,
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

test('channel interaction token hashes use per-interaction salts while preserving legacy verification (P2-6)', () => {
  const token = generateChannelInteractionToken({ interactionId: 'int_test', secret: 'secret-value' })
  const first = hashChannelInteractionToken(token)
  const second = hashChannelInteractionToken(token)

  assert.match(first, /^scrypt-v2:/)
  assert.notEqual(first, second) // per-interaction random salt — no shared precomputable hash
  assert.equal(verifyChannelInteractionTokenHash(token, first), true)
  assert.equal(verifyChannelInteractionTokenHash(`${token}-wrong`, first), false)
  assert.equal(plaintextMatchesChannelInteractionId(token, 'int_test'), true)
  assert.equal(plaintextMatchesChannelInteractionId(token, 'other'), false)

  // Pre-rotation constant-salt hashes still verify until the interaction is re-issued.
  const legacyHash = `scrypt:${scryptSync(token, 'open-cowork-channel-interaction-token-v1', 32).toString('base64url')}`
  assert.equal(verifyChannelInteractionTokenHash(token, legacyHash), true)
})
