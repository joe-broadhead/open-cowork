import test from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import {
  methodRequiresCsrf,
  writeCorsHeaders,
  writeError,
  writeJson,
  writePolicyError,
  writeRedirect,
  writeSecurityHeaders,
} from '../apps/desktop/src/main/cloud/http-response-writers.ts'

// Focused coverage for the pure HTTP response writers extracted from
// http-server.ts. A minimal fake ServerResponse records headers/status/body so
// the header + body shaping is asserted directly.

type FakeRes = ServerResponse & {
  headers: Record<string, unknown>
  statusCode: number
  body: string
}

function mockRes(): FakeRes {
  const headers: Record<string, unknown> = {}
  const res = {
    headers,
    statusCode: 0,
    body: '',
    setHeader(key: string, value: unknown) { headers[key.toLowerCase()] = value },
    writeHead(status: number, extra?: Record<string, unknown>) {
      res.statusCode = status
      if (extra) for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value
      return res
    },
    end(chunk?: string) { res.body = chunk ?? '' },
  }
  return res as unknown as FakeRes
}

test('writeSecurityHeaders sets the baseline hardening headers and gates HSTS', () => {
  const res = mockRes()
  writeSecurityHeaders(res)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['x-frame-options'], 'DENY')
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin')
  assert.equal(res.headers['strict-transport-security'], undefined)

  const secure = mockRes()
  writeSecurityHeaders(secure, { strictTransportSecurity: true })
  assert.match(String(secure.headers['strict-transport-security']), /max-age=31536000/)
})

test('writeCorsHeaders only echoes an origin when one is provided', () => {
  const withOrigin = mockRes()
  writeCorsHeaders(withOrigin, 'https://app.example')
  assert.equal(withOrigin.headers['access-control-allow-origin'], 'https://app.example')
  assert.equal(withOrigin.headers['vary'], 'Origin')

  const without = mockRes()
  writeCorsHeaders(without, null)
  assert.equal(without.headers['access-control-allow-origin'], undefined)
})

test('writeJson sets status, no-store JSON content-type, and a serialized body', () => {
  const res = mockRes()
  writeJson(res, 201, { ok: true }, 'https://app.example')
  assert.equal(res.statusCode, 201)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['access-control-allow-origin'], 'https://app.example')
  assert.deepEqual(JSON.parse(res.body), { ok: true })
})

test('writeError carries a verdict + Retry-After when policy/retry details are present', () => {
  const res = mockRes()
  writeError(res, 429, 'Slow down', undefined, { policyCode: 'rate.limited', retryAfterMs: 5000 })
  assert.equal(res.statusCode, 429)
  assert.equal(res.headers['retry-after'], '5')
  const body = JSON.parse(res.body)
  assert.equal(body.error, 'Slow down')
  assert.equal(body.retryAfterMs, 5000)
  assert.deepEqual(body.verdict, { allowed: false, reason: 'Slow down', policyCode: 'rate.limited' })

  const plain = mockRes()
  writeError(plain, 400, 'Bad input')
  const plainBody = JSON.parse(plain.body)
  assert.equal(plainBody.error, 'Bad input')
  assert.equal(plainBody.verdict, undefined)
  assert.equal(plain.headers['retry-after'], undefined)
})

test('writePolicyError always emits a denied verdict', () => {
  const res = mockRes()
  writePolicyError(res, 403, 'Not allowed', 'forbidden.scope')
  const body = JSON.parse(res.body)
  assert.deepEqual(body.verdict, { allowed: false, reason: 'Not allowed', policyCode: 'forbidden.scope' })
})

test('writeRedirect issues a 302 with location and optional set-cookie', () => {
  const res = mockRes()
  writeRedirect(res, '/next', ['sid=1; HttpOnly'], 'https://app.example')
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['location'], '/next')
  assert.deepEqual(res.headers['set-cookie'], ['sid=1; HttpOnly'])

  const noCookie = mockRes()
  writeRedirect(noCookie, '/next', undefined)
  assert.equal(noCookie.headers['set-cookie'], undefined)
})

test('methodRequiresCsrf flags only mutating methods', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(methodRequiresCsrf(method), true)
  for (const method of ['GET', 'HEAD', 'OPTIONS', undefined]) assert.equal(methodRequiresCsrf(method), false)
})
