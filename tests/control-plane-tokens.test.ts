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

test('cloud API token hashes use per-token salts and reject legacy constant-salt hashes', async () => {
  const generated = generateCloudApiToken({ tokenId: 'tok_test', secret: 'secret-value' })
  const first = await hashCloudApiToken(generated.plaintext)
  const second = await hashCloudApiToken(generated.plaintext)

  assert.match(first, /^scrypt-v2:/)
  assert.notEqual(first, second)
  assert.equal(await verifyCloudApiTokenHash(generated.plaintext, first), true)
  assert.equal(await verifyCloudApiTokenHash(`${generated.plaintext}-wrong`, first), false)
  assert.equal(plaintextMatchesCloudApiTokenId(generated.plaintext, generated.tokenId), true)

  // Legacy constant-salt hashes are no longer accepted — any non-v2 stored hash fails closed.
  const legacyHash = `scrypt:${scryptSync(generated.plaintext, 'open-cowork-cloud-api-token-hash-v1', 32).toString('base64url')}`
  assert.equal(await verifyCloudApiTokenHash(generated.plaintext, legacyHash), false)
})

test('channel interaction token hashes use per-interaction salts and reject legacy constant-salt hashes', async () => {
  const token = generateChannelInteractionToken({ interactionId: 'int_test', secret: 'secret-value' })
  const first = await hashChannelInteractionToken(token)
  const second = await hashChannelInteractionToken(token)

  assert.match(first, /^scrypt-v2:/)
  assert.notEqual(first, second) // per-interaction random salt — no shared precomputable hash
  assert.equal(await verifyChannelInteractionTokenHash(token, first), true)
  assert.equal(await verifyChannelInteractionTokenHash(`${token}-wrong`, first), false)
  assert.equal(plaintextMatchesChannelInteractionId(token, 'int_test'), true)
  assert.equal(plaintextMatchesChannelInteractionId(token, 'other'), false)

  // Legacy constant-salt hashes are no longer accepted — they fail closed.
  const legacyHash = `scrypt:${scryptSync(token, 'open-cowork-channel-interaction-token-v1', 32).toString('base64url')}`
  assert.equal(await verifyChannelInteractionTokenHash(token, legacyHash), false)
})
