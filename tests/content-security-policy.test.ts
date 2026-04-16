import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildContentSecurityPolicy,
  PACKAGED_CONTENT_SECURITY_POLICY,
} from '../apps/desktop/src/main/content-security-policy.ts'

test('buildContentSecurityPolicy allows eval for Vega rendering and adds dev websocket origins only in development', () => {
  const devPolicy = buildContentSecurityPolicy({ devServerUrl: 'http://127.0.0.1:5173' })
  const packagedPolicy = buildContentSecurityPolicy()

  assert.match(devPolicy, /script-src 'self' 'unsafe-eval'/)
  assert.match(packagedPolicy, /script-src 'self' 'unsafe-eval'/)
  assert.match(devPolicy, /connect-src .*http:\/\/127\.0\.0\.1:5173/)
  assert.match(devPolicy, /connect-src .*ws:\/\/127\.0\.0\.1:5173/)
  assert.doesNotMatch(packagedPolicy, /connect-src .*127\.0\.0\.1:5173/)
})

test('packaged CSP meta tag stays aligned with the packaged runtime policy', () => {
  const html = readFileSync(resolve('apps/desktop/index.html'), 'utf8')
  const match = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)

  assert.ok(match, 'expected CSP meta tag in apps/desktop/index.html')
  assert.equal(match?.[1], PACKAGED_CONTENT_SECURITY_POLICY)
})
