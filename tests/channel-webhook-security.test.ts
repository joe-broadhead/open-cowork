import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import {
  WebhookRateLimiter,
  verifyDiscordInteractionSignature,
  verifyMetaHubSignature256,
  verifyMetaHubVerifyToken,
  verifySlackRequestSignature,
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

test('verifySlackRequestSignature accepts valid Slack signatures within skew', () => {
  const secret = 'slack-signing-secret'
  const timestamp = '1710000000'
  const body = '{"type":"event_callback"}'
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
  const nowMs = Number(timestamp) * 1000
  assert.equal(verifySlackRequestSignature(secret, signature, timestamp, body, { nowMs }), true)
  assert.equal(verifySlackRequestSignature(secret, signature, timestamp, body, { nowMs: nowMs + 10 * 60 * 1000 }), false)
  assert.equal(verifySlackRequestSignature(secret, `v0=${'00'.repeat(32)}`, timestamp, body, { nowMs }), false)
  assert.equal(verifySlackRequestSignature('', signature, timestamp, body, { nowMs }), false)
  assert.equal(verifySlackRequestSignature(secret, signature.slice(3), timestamp, body, { nowMs }), false)
})

test('shared WebhookRateLimiter claims then rate-limits and backs off auth failures', () => {
  const limiter = new WebhookRateLimiter()
  const nowMs = 1_700_000_000_000
  const key = 'test:client'
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.claim({ key, nowMs, windowMs: 60_000, maxRequests: 3 }).ok, true)
  }
  const limited = limiter.claim({ key, nowMs, windowMs: 60_000, maxRequests: 3 })
  assert.equal(limited.ok, false)
  if (!limited.ok) assert.ok(limited.retryAfterMs > 0)

  const authKey = 'test:attacker'
  for (let i = 0; i < 2; i++) {
    assert.equal(limiter.backoff({ key: authKey, nowMs, windowMs: 60_000, maxFailures: 2, backoffMs: 30_000 }).ok, true)
  }
  const blocked = limiter.claim({ key: authKey, nowMs, windowMs: 60_000, maxRequests: 100 })
  assert.equal(blocked.ok, false)
  limiter.clear()
  assert.equal(limiter.claim({ key: authKey, nowMs, windowMs: 60_000, maxRequests: 100 }).ok, true)
})
