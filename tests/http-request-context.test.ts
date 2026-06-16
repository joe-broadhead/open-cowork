import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import {
  authFailureScopes,
  extractSignatureWebhookAuth,
  requestCorsOrigin,
  requestHeaderRecord,
  webhookAuthScope,
  workflowScopeKey,
} from '../apps/desktop/src/main/cloud/http-request-context.ts'

// Focused coverage for the security-relevant request-context helpers extracted
// from http-server.ts: CORS-origin allow-listing, auth-failure scope derivation,
// header flattening, and the signature-webhook required-header check.

function mockReq(headers: Record<string, string | string[] | undefined>, remoteAddress = '203.0.113.7'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

test('requestCorsOrigin only echoes the request origin when it exactly matches the configured origin', () => {
  const configured = 'https://app.example'
  assert.equal(requestCorsOrigin(mockReq({ origin: 'https://app.example' }), configured), 'https://app.example')
  assert.equal(requestCorsOrigin(mockReq({ origin: 'https://evil.example' }), configured), null)
  assert.equal(requestCorsOrigin(mockReq({ origin: 'https://app.example' }), null), null)
  assert.equal(requestCorsOrigin(mockReq({}), configured), null)
})

test('requestHeaderRecord lowercases header names and collapses array values to the first', () => {
  const record = requestHeaderRecord(mockReq({ 'X-Test': 'one', 'X-Multi': ['a', 'b'], host: 'h' }))
  assert.equal(record['x-test'], 'one')
  assert.equal(record['x-multi'], 'a')
  assert.equal(record['host'], 'h')
})

test('authFailureScopes always carries an ip scope and adds a hashed auth scope only when authorized', () => {
  const anon = authFailureScopes(mockReq({}))
  assert.equal(anon.length, 1)
  assert.match(anon[0], /^ip:/)

  const authed = authFailureScopes(mockReq({ authorization: 'Bearer secret-token' }))
  assert.equal(authed.length, 2)
  assert.match(authed[0], /^ip:/)
  assert.match(authed[1], /^auth:[0-9a-f]{16}$/)
  // The auth scope is a hash, never the raw token.
  assert.ok(!authed[1].includes('secret-token'))
})

test('workflowScopeKey is a deterministic 16-hex digest and webhookAuthScope composes it', () => {
  const key = workflowScopeKey('wf-123')
  assert.match(key, /^[0-9a-f]{16}$/)
  assert.equal(workflowScopeKey('wf-123'), key)
  assert.notEqual(workflowScopeKey('wf-456'), key)
  assert.equal(webhookAuthScope('ip:1.2.3.4', 'wf-123'), `ip:1.2.3.4:${key}`)
})

test('extractSignatureWebhookAuth requires both timestamp and signature headers', () => {
  const ok = extractSignatureWebhookAuth(
    mockReq({ 'x-open-cowork-timestamp': '12345', 'x-open-cowork-signature': 'sig' }),
    'raw-body',
  )
  assert.deepEqual(ok, { kind: 'signature', timestamp: '12345', signature: 'sig', rawBody: 'raw-body' })

  assert.throws(() => extractSignatureWebhookAuth(mockReq({ 'x-open-cowork-signature': 'sig' }), 'b'), /authorization is required/)
  assert.throws(() => extractSignatureWebhookAuth(mockReq({ 'x-open-cowork-timestamp': '1' }), 'b'), /authorization is required/)
  assert.throws(() => extractSignatureWebhookAuth(mockReq({}), 'b'), /authorization is required/)
})
