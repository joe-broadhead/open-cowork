import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildChartFrameContentSecurityPolicy,
  buildContentSecurityPolicy,
  PACKAGED_CONTENT_SECURITY_POLICY,
} from '../apps/desktop/src/main/content-security-policy.ts'

test('buildContentSecurityPolicy keeps the packaged renderer self-contained and only adds dev origins when needed', () => {
  const devPolicy = buildContentSecurityPolicy({ devServerUrl: 'http://127.0.0.1:5173' })
  const packagedPolicy = buildContentSecurityPolicy()

  assert.match(devPolicy, /script-src 'self'/)
  assert.match(devPolicy, /script-src[^;]*'unsafe-inline'/)
  assert.doesNotMatch(devPolicy, /unsafe-eval/)
  assert.doesNotMatch(packagedPolicy, /unsafe-eval/)
  assert.doesNotMatch(packagedPolicy, /unsafe-inline'[^;]*;[^;]*script-src/)
  assert.match(packagedPolicy, /script-src 'self'(?!\s+'unsafe-inline')/)
  assert.match(devPolicy, /connect-src .*http:\/\/127\.0\.0\.1:5173/)
  assert.match(devPolicy, /connect-src .*ws:\/\/127\.0\.0\.1:5173/)
  assert.doesNotMatch(packagedPolicy, /connect-src .*https:/)
  assert.doesNotMatch(packagedPolicy, /connect-src .*127\.0\.0\.1:5173/)
  assert.match(packagedPolicy, /img-src 'self' data: blob: open-cowork-asset:/)
  assert.doesNotMatch(packagedPolicy, /img-src[^;]*https:/)
})

test('index.html does not ship a meta CSP (main process attaches the authoritative header)', () => {
  const html = readFileSync(resolve('apps/desktop/index.html'), 'utf8')
  assert.doesNotMatch(html, /http-equiv\s*=\s*["']Content-Security-Policy["']/i)
  // PACKAGED_CONTENT_SECURITY_POLICY remains exported for consumers that need
  // to reason about the packaged-mode policy without a live session.
  assert.match(PACKAGED_CONTENT_SECURITY_POLICY, /script-src 'self'/)
})

test('chart frame CSP allows only local scripts with eval and no network egress in packaged mode', () => {
  const policy = buildChartFrameContentSecurityPolicy()

  assert.match(policy, /script-src 'self' 'unsafe-eval'/)
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/)
  assert.match(policy, /connect-src 'none'/)
  assert.match(policy, /img-src 'self' data: blob:/)
  assert.doesNotMatch(policy, /img-src[^;]*open-cowork-asset:/)
  assert.match(policy, /frame-ancestors 'self'/)
  assert.doesNotMatch(policy, /https:/)
})

test('chart frame CSP opens HMR channel in dev while keeping packaged egress denied', () => {
  const devPolicy = buildChartFrameContentSecurityPolicy({ devServerUrl: 'http://127.0.0.1:5173' })

  assert.match(devPolicy, /script-src[^;]*'unsafe-inline'/)
  assert.match(devPolicy, /connect-src[^;]*http:\/\/127\.0\.0\.1:5173/)
  assert.match(devPolicy, /connect-src[^;]*ws:\/\/127\.0\.0\.1:5173/)
  assert.doesNotMatch(devPolicy, /connect-src 'none'/)
})
