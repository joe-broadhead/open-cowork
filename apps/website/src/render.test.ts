import test from 'node:test'
import assert from 'node:assert/strict'
import { cloudWebsiteClientScript, cloudWebsiteHtml } from './render.ts'
import { canManageOrg } from './roles.ts'

const html = cloudWebsiteHtml({
  role: 'web',
  profileName: 'default',
  features: {
    chat: true,
    workflows: true,
  },
})

test('cloud website renders onboarding dashboard surfaces', () => {
  assert.match(html, /Open Cowork Cloud/)
  assert.match(html, /BYOK/)
  assert.match(html, /Desktop token/)
  assert.match(html, /Gateway token/)
  assert.match(html, /Headless gateway/)
  assert.match(html, /Billing/)
  assert.match(html, /Usage/)
})

test('cloud website client avoids persistent browser secret storage', () => {
  const script = cloudWebsiteClientScript()
  assert.equal(script.includes('localStorage'), false)
  assert.equal(script.includes('sessionStorage'), false)
  assert.equal(script.includes('indexedDB'), false)
})

test('cloud website binds actions through the client script', () => {
  assert.equal(html.includes('onclick='), false)
  assert.match(cloudWebsiteClientScript(), /signin-inline/)
})

test('cloud website disables dynamic admin actions for member roles', () => {
  const script = cloudWebsiteClientScript()
  assert.match(script, /Validate', \(\) => validateByok\(secret\.providerId\), 'secondary', adminLocked\(\)\)/)
  assert.match(script, /Revoke', \(\) => revokeToken\(token\.tokenId\), 'danger', adminLocked\(\)\)/)
})

test('cloud website role helper gates admin controls', () => {
  assert.equal(canManageOrg('owner'), true)
  assert.equal(canManageOrg('admin'), true)
  assert.equal(canManageOrg('member'), false)
  assert.equal(canManageOrg(null), false)
})
