import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import {
  verifyDiscordInteractionSignature,
  verifyMetaHubSignature256,
  verifyMetaHubVerifyToken,
  verifyTelegramWebhookSecretToken,
} from '@open-cowork/shared/node'

test('verifyMetaHubSignature256 accepts valid Meta hub signatures', () => {
  const secret = 'app-secret'
  const body = '{"object":"whatsapp_business_account"}'
  const hex = createHmac('sha256', secret).update(body).digest('hex')
  assert.equal(verifyMetaHubSignature256(secret, `sha256=${hex}`, body), true)
  assert.equal(verifyMetaHubSignature256(secret, `sha256=${hex.slice(0, -1)}0`, body), false)
  assert.equal(verifyMetaHubSignature256(secret, hex, body), false)
  assert.equal(verifyMetaHubSignature256('', `sha256=${hex}`, body), false)
})

test('verifyMetaHubVerifyToken uses digest equality', () => {
  assert.equal(verifyMetaHubVerifyToken('token-a', 'token-a'), true)
  assert.equal(verifyMetaHubVerifyToken('token-a', 'token-b'), false)
  assert.equal(verifyMetaHubVerifyToken('', 'token-a'), false)
})

test('verifyDiscordInteractionSignature accepts valid ed25519 signatures', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  const timestamp = '1710000000'
  const body = '{"type":1}'
  const signatureHex = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex')
  assert.equal(verifyDiscordInteractionSignature(publicKeyHex, signatureHex, timestamp, body), true)
  assert.equal(verifyDiscordInteractionSignature(publicKeyHex, signatureHex, '0', body), false)
  assert.equal(verifyDiscordInteractionSignature('00'.repeat(32), signatureHex, timestamp, body), false)
})

test('verifyTelegramWebhookSecretToken rejects missing secrets', () => {
  assert.equal(verifyTelegramWebhookSecretToken('secret', 'secret'), true)
  assert.equal(verifyTelegramWebhookSecretToken('secret', 'other'), false)
  assert.equal(verifyTelegramWebhookSecretToken(null, 'secret'), false)
})
