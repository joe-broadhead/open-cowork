import test from 'node:test'
import assert from 'node:assert/strict'
import { CLOUD_WEB_ROUTE_GROUPS, DEFAULT_CLOUD_WEB_ROUTE, findCloudWebRoute } from './app-shell.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientStateContract } from './client-contract.ts'
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

test('cloud website renders workbench and admin shell surfaces', () => {
  assert.match(html, /Open Cowork Cloud/)
  assert.match(html, /Workbench/)
  assert.match(html, /Threads/)
  assert.match(html, /Chat/)
  assert.match(html, /Tools &amp; Skills/)
  assert.match(html, /Artifacts/)
  assert.match(html, /Admin/)
  assert.match(html, /Org/)
  assert.match(html, /Members/)
  assert.match(html, /BYOK/)
  assert.match(html, /Desktop token/)
  assert.match(html, /Gateway token/)
  assert.match(html, /Headless gateway/)
  assert.match(html, /Audit/)
  assert.match(html, /Diagnostics/)
  assert.match(html, /data-route-panel="threads"/)
  assert.match(html, /data-route-panel="byok"/)
})

test('cloud website app shell exposes typed route metadata', () => {
  assert.equal(DEFAULT_CLOUD_WEB_ROUTE, 'threads')
  assert.deepEqual(CLOUD_WEB_ROUTE_GROUPS.map((group) => group.id), ['workbench', 'admin'])
  assert.equal(findCloudWebRoute('threads')?.surface, 'workbench')
  assert.equal(findCloudWebRoute('byok')?.requiresAdmin, true)
  assert.equal(findCloudWebRoute('usage')?.requiresAdmin, false)
})

test('cloud website bootstrap exposes typed client endpoint metadata', () => {
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'config')?.path, '/api/config')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'workspace')?.path, '/api/workspace')
  assert.match(html, /"api":/)
  assert.match(cloudWebsiteClientScript(), /endpoint\(id, fallback\)/)
  const stateContract: CloudWebClientStateContract = {
    authStatus: 'loading',
    activeRoute: DEFAULT_CLOUD_WEB_ROUTE,
    workspace: null,
    csrfToken: null,
    workspaceEvents: {
      status: 'idle',
      cursor: null,
      error: null,
    },
  }
  assert.equal(stateContract.workspaceEvents.status, 'idle')
})

test('cloud website keeps existing admin dashboard surfaces available', () => {
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

test('cloud website serializes bootstrap JSON for raw script parsing', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: '</script><img src=x onerror=alert(1)>',
    shortName: 'OC',
  })

  const match = branded.match(/<script[^>]+id="open-cowork-cloud-bootstrap"[^>]*>(.*?)<\/script>/s)
  assert.ok(match)
  assert.doesNotMatch(match[1], /<\/script>/i)
  assert.equal(JSON.parse(match[1]).publicBranding.productName, '</script><img src=x onerror=alert(1)>')
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
  assert.match(cloudWebsiteClientScript(), /\/api\/config/)
  assert.match(cloudWebsiteClientScript(), /\/api\/workspace/)
  assert.match(cloudWebsiteClientScript(), /setRoute/)
  assert.match(cloudWebsiteClientScript(), /providerSettingsFromForm/)
  assert.match(cloudWebsiteClientScript(), /updateBindingProviderFields/)
})

test('cloud website disables dynamic admin actions for member roles', () => {
  const script = cloudWebsiteClientScript()
  assert.match(script, /Validate', \(\) => validateByok\(secret\.providerId\), 'secondary', adminLocked\(\)\)/)
  assert.match(script, /Revoke', \(\) => revokeToken\(token\.tokenId\), 'danger', adminLocked\(\)\)/)
  assert.match(html, /data-requires-admin="true"/)
})

test('cloud website renders signed-out, member, admin, and policy-disabled states', () => {
  const member = cloudWebsiteHtml({
    role: 'member',
    profileName: 'default',
    features: {
      chat: false,
      workflows: false,
    },
  })
  assert.match(member, /<strong id="role-name">member<\/strong>/)
  assert.match(member, /Admin actions are disabled for this role/)
  assert.match(member, /data-route-panel="members"[^>]+data-requires-admin="true"/)
  assert.match(member, /<span class="pill" data-kind="warn">disabled<\/span>/)

  const owner = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  })
  assert.match(owner, /<strong id="role-name">admin<\/strong>/)
  assert.match(owner, /data-route-panel="diagnostics"/)
  assert.match(owner, /signed-out-only/)
})

test('cloud website role helper gates admin controls', () => {
  assert.equal(canManageOrg('owner'), true)
  assert.equal(canManageOrg('admin'), true)
  assert.equal(canManageOrg('member'), false)
  assert.equal(canManageOrg(null), false)
})
