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
  assert.match(html, /Slack team ID/)
  assert.match(html, /Inbound address/)
  assert.match(html, /Webhook delivery URL/)
  assert.match(html, /Billing/)
  assert.match(html, /Usage/)
})

test('cloud website renders deployer public branding', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'data-analyst',
    features: {
      chat: true,
      workflows: false,
    },
  }, {
    productName: 'Acme Cowork',
    shortName: 'AC',
    logoUrl: 'https://assets.acme.example/cowork/logo.png',
    supportUrl: 'https://support.acme.example/cowork',
    privacyUrl: 'https://legal.acme.example/privacy',
    theme: {
      accent: '#0f6b4b',
    },
    dashboard: {
      title: 'Acme workspace',
      subtitle: 'Manage Acme clients.',
      connectionsDescription: 'Issue scoped Acme tokens.',
    },
    managedOrgConnectionLabels: {
      desktopToken: 'Acme Desktop token',
      gatewayToken: 'Acme Gateway token',
      apiToken: 'Acme API token',
      cloudUrl: 'Acme Cloud URL',
    },
  })

  assert.match(branded, /<title>Acme Cowork<\/title>/)
  assert.match(branded, /https:\/\/assets\.acme\.example\/cowork\/logo\.png/)
  assert.match(branded, /Acme workspace/)
  assert.match(branded, /Issue scoped Acme tokens/)
  assert.match(branded, /Acme Desktop token/)
  assert.match(branded, /--accent: #0f6b4b;/)
  assert.match(branded, /https:\/\/support\.acme\.example\/cowork/)
  assert.match(branded, /https:\/\/legal\.acme\.example\/privacy/)
})

test('cloud website drops unsafe public branding URLs', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: 'Acme Cowork',
    logoUrl: 'http://assets.example.test/logo.png',
    supportUrl: 'javascript:alert(1)',
    privacyUrl: 'mailto:privacy@example.test',
  })

  assert.doesNotMatch(branded, /http:\/\/assets\.example\.test/)
  assert.doesNotMatch(branded, /javascript:alert/)
  assert.doesNotMatch(branded, /mailto:privacy/)
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
  assert.match(cloudWebsiteClientScript(), /providerSettingsFromForm/)
  assert.match(cloudWebsiteClientScript(), /updateBindingProviderFields/)
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
