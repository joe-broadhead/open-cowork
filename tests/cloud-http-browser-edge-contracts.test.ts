import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CloudHttpError,
  createCloudHttpServer,
  type CloudAuthResolver,
  type CloudBrowserAuthProvider,
} from '@open-cowork/cloud-server/http-server'
import { browserRendererBuildExists } from '@open-cowork/cloud-server/browser-renderer-app'
import { createInMemoryObjectStore, type ObjectStoreAdapter } from '@open-cowork/cloud-server/object-store'
import { createPrometheusCloudObservability, type CloudObservabilityAdapter } from '@open-cowork/cloud-server/observability'
import { createCloudSessionCookieManager } from '@open-cowork/cloud-server/session-cookie-auth'
import { type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createStubBillingAdapter } from '@open-cowork/cloud-server/stub-billing-adapter'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import {
  TEST_COOKIE_KEY,
  readJson,
  asRecord,
  setCookieHeaders,
  cookieHeader,
  cookieValue,
  testAbuseConfig,
  testBillingConfig,
} from './helpers/cloud-http-test-support.ts'

test('cloud HTTP server returns public errors for malformed request bodies', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken"',
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await readJson(response), { error: 'Request body must be valid JSON.' })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server applies security headers and exact-match non-credentialed CORS', async () => {
  const fixture = createFixture()
  const server = createCloudHttpServer({
    service: fixture.service,
    artifacts: fixture.artifacts,
    worker: fixture.worker,
    policy: fixture.policy,
    auth: () => ({
      tenantId: 'tenant-1',
      tenantName: 'Tenant 1',
      orgId: 'tenant-1',
      userId: 'user-1',
      accountId: 'user-1',
      email: 'user@example.test',
      role: 'owner',
      authSource: 'local',
    }),
    corsOrigin: 'https://app.example.test',
    strictTransportSecurity: true,
  })
  const baseUrl = await server.listen()
  try {
    const html = await fetch(`${baseUrl}/`, {
      headers: { origin: 'https://app.example.test' },
    })
    // Build-independent security/CORS headers apply to every response (including the
    // 404 when the renderer build is absent in this lane).
    assert.equal(html.headers.get('access-control-allow-origin'), 'https://app.example.test')
    assert.equal(html.headers.get('access-control-allow-credentials'), null)
    assert.equal(html.headers.get('vary'), 'Origin')
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(html.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains')
    // GET / now serves the UNIFIED RENDERER SPA (the one-UI-codebase cutover; the
    // bespoke website is gone), identical to /app. Its CSP is relaxed for the
    // runtime-injected <style> element but stays script-strict. Gate the CSP body
    // assertions on the renderer build, which isn't produced in every CI lane.
    if (browserRendererBuildExists()) {
      assert.equal(html.status, 200)
      const csp = html.headers.get('content-security-policy') || ''
      // RELAXED for the runtime-injected <style> element: style-src has 'unsafe-inline'.
      assert.match(csp, /style-src 'self' 'unsafe-inline'/)
      assert.match(csp, /style-src-attr 'unsafe-inline'/)
      assert.match(csp, /font-src 'self'/)
      assert.match(csp, /object-src 'none'/)
      // Scripts stay strict — external hashed modules only, NO inline script execution.
      assert.match(csp, /script-src 'self'/)
      assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/)
    }

    const mismatched = await fetch(`${baseUrl}/api/config`, {
      headers: { origin: 'https://evil.example.test' },
    })
    assert.equal(mismatched.headers.get('access-control-allow-origin'), null)
    assert.equal(mismatched.headers.get('x-content-type-options'), 'nosniff')
  } finally {
    await server.close()
  }
})

// The unified renderer ships its OWN fonts as hashed /app/assets/*.woff2 files (served
// by browser-renderer-app.ts). The bespoke website's /assets/fonts/* route and its
// react-client /assets/*.js route are gone with the website — the renderer is the only
// UI the cloud serves. Unknown static paths now fall through to the auth/API pipeline
// (they 404/401 there), so there is no dedicated font/react-client serving test.

// The unified renderer browser build (packages/app/dist-browser) is not produced in
// every CI lane, so gate on its presence — but assert the full route wiring (the
// /app SPA document with its relaxed-but-script-strict CSP, and a hashed /app/assets
// JS file with the right content-type) when the build IS present.
test('cloud HTTP server serves the unified renderer at /app with a script-strict, style-relaxed CSP', {
  skip: browserRendererBuildExists() ? false : 'packages/app/dist-browser is not built',
}, async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const app = await fetch(`${baseUrl}/app`)
    assert.equal(app.status, 200)
    assert.match(app.headers.get('content-type') || '', /text\/html/)
    const body = await app.text()
    // The served document is the dist-browser SPA: it references the renderer's
    // hashed assets, rewritten under /app/assets so they load mounted at /app.
    assert.match(body, /\/app\/assets\//)
    assert.match(body, /id="cowork-bootstrap"/)

    const csp = app.headers.get('content-security-policy') || ''
    // RELAXED for the runtime-injected <style> element: style-src has 'unsafe-inline'.
    assert.match(csp, /style-src 'self' 'unsafe-inline'/)
    assert.match(csp, /style-src-attr 'unsafe-inline'/)
    // STRICT for scripts: external hashed modules only — script-src has NO inline.
    assert.match(csp, /script-src 'self'/)
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/)
    assert.match(csp, /connect-src 'self'/)
    assert.match(csp, /object-src 'none'/)

    // /app/ (trailing slash) serves the same document.
    const appSlash = await fetch(`${baseUrl}/app/`)
    assert.equal(appSlash.status, 200)

    // A hashed asset referenced by the document serves with the JS content-type and
    // immutable caching. Pull the first /app/assets/*.js path out of the document.
    const assetMatch = body.match(/\/app\/assets\/[A-Za-z0-9_-]+\.js/)
    assert.ok(assetMatch, 'served /app document references a hashed JS asset')
    const asset = await fetch(`${baseUrl}${assetMatch![0]}`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') || '', /text\/javascript/)
    assert.match(asset.headers.get('cache-control') || '', /immutable/)
    assert.ok((await asset.arrayBuffer()).byteLength > 0)

    // Path traversal / unknown assets 404 (no leaking files outside dist-browser).
    const bad = await fetch(`${baseUrl}/app/assets/not-a-real-chunk.js`)
    assert.equal(bad.status, 404)
  } finally {
    await fixture.server.close()
  }
})

// Permanent cutover: GET / (and /index.html) is now the UNIFIED RENDERER, identical
// to /app — the bespoke website is deleted and the renderer is the only UI the cloud
// serves. (The old OPEN_COWORK_CLOUD_UNIFIED_UI reversible-cutover flag is gone; the
// renderer is always on.) Gated on the renderer build, which isn't built in every lane.
test('cloud HTTP server serves the unified renderer as the default route (/, /index.html) identically to /app', {
  skip: browserRendererBuildExists() ? false : 'packages/app/dist-browser is not built',
}, async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    for (const path of ['/', '/index.html']) {
      const root = await fetch(`${baseUrl}${path}`)
      assert.equal(root.status, 200, `${path} serves the renderer SPA`)
      assert.match(root.headers.get('content-type') || '', /text\/html/)
      const body = await root.text()
      // The renderer SPA references its hashed assets under /app/assets and carries
      // the bootstrap tag the browser shim reads at runtime.
      assert.match(body, /\/app\/assets\//)
      assert.match(body, /id="cowork-bootstrap"/)
      const csp = root.headers.get('content-security-policy') || ''
      // Relaxed-but-script-strict CSP, same as /app (NOT a nonce'd website SSR shell).
      assert.match(csp, /style-src 'self' 'unsafe-inline'/)
      assert.match(csp, /script-src 'self'/)
      assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/)
    }

    // / and /app serve byte-identical documents (same browserRendererHtml output).
    const rootBody = await (await fetch(`${baseUrl}/`)).text()
    const appBody = await (await fetch(`${baseUrl}/app`)).text()
    assert.equal(rootBody, appBody, '/ and /app serve the same renderer document')
  } finally {
    await fixture.server.close()
  }
})

// An object store that supports presigned transfer, used to exercise the cloud's
// presigned-upload CSP + billing/quota gates. Wraps the in-memory store with presign
// capability whose URLs target a fixed cross-origin object-store origin.
const PRESIGN_OBJECT_STORE_ORIGIN = 'https://objects.example.test'
function createPresignCapableObjectStore(): ObjectStoreAdapter {
  const base = createInMemoryObjectStore()
  return {
    ...base,
    presignedUpload: {
      enforcement: 'exact-content-length',
      maxBytes: 25 * 1024 * 1024,
      async presignPut(input) {
        return {
          method: 'PUT',
          url: `${PRESIGN_OBJECT_STORE_ORIGIN}/${input.key}`,
          headers: input.contentType ? { 'content-type': input.contentType } : {},
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }
      },
    },
    async presignGet(key) {
      return {
        method: 'GET',
        url: `${PRESIGN_OBJECT_STORE_ORIGIN}/${key}`,
        headers: {},
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }
    },
  }
}

// SEC-2: when the object store can presign, the browser shim PUTs F4 uploads directly to
// that cross-origin store, so the served renderer's CSP connect-src must allow its origin
// (else the PUT is silently blocked and direct transfer is dead in the browser). Gated on
// the renderer build, which isn't produced in every CI lane.
test('cloud HTTP server adds the presigned object-store origin to the renderer CSP connect-src', {
  skip: browserRendererBuildExists() ? false : 'packages/app/dist-browser is not built',
}, async () => {
  const fixture = createFixture({ objectStore: createPresignCapableObjectStore() })
  const baseUrl = await fixture.server.listen()
  try {
    for (const path of ['/', '/app']) {
      const res = await fetch(`${baseUrl}${path}`)
      assert.equal(res.status, 200)
      const csp = res.headers.get('content-security-policy') || ''
      assert.match(
        csp,
        new RegExp(`connect-src 'self' ${PRESIGN_OBJECT_STORE_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `${path} CSP allows the object-store origin for the presigned PUT`,
      )
    }
  } finally {
    await fixture.server.close()
  }
})

// A buffered-only store (no presign) leaves connect-src 'self' — the shim uses the
// same-origin buffered path. Gated on the renderer build.
test('cloud HTTP server keeps renderer CSP connect-src self for buffered-only object stores', {
  skip: browserRendererBuildExists() ? false : 'packages/app/dist-browser is not built',
}, async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const csp = (await fetch(`${baseUrl}/`)).headers.get('content-security-policy') || ''
    assert.match(csp, /connect-src 'self'(;|$)/)
    assert.doesNotMatch(csp, /objects\.example\.test/)
  } finally {
    await fixture.server.close()
  }
})

// BUNDLE-1: interactive Vega charts render inside a sandboxed iframe whose document is
// chart-frame.html. The cloud must serve it at /chart-frame.html and /app/chart-frame.html
// with a vega-capable, embeddable CSP, and its hashed chunks under /app/assets. Gated on
// the renderer build.
test('cloud HTTP server serves the Vega chart frame with an embeddable, vega-capable CSP', {
  skip: browserRendererBuildExists() ? false : 'packages/app/dist-browser is not built',
}, async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    for (const path of ['/chart-frame.html', '/app/chart-frame.html']) {
      const frame = await fetch(`${baseUrl}${path}`)
      assert.equal(frame.status, 200, `${path} serves the chart frame`)
      assert.match(frame.headers.get('content-type') || '', /text\/html/)
      const body = await frame.text()
      // References the hashed chartFrame module chunk under /app/assets.
      assert.match(body, /\/app\/assets\/chartFrame-[A-Za-z0-9_-]+\.js/)
      const csp = frame.headers.get('content-security-policy') || ''
      // vega compiles specs to functions at runtime → needs 'unsafe-eval'.
      assert.match(csp, /script-src 'self' 'unsafe-eval'/)
      // Embeddable by the same-origin SPA (overrides the global X-Frame-Options DENY).
      assert.match(csp, /frame-ancestors 'self'/)
      assert.equal(frame.headers.get('x-frame-options'), 'SAMEORIGIN')
    }

    // The chart frame's hashed module chunk serves through /app/assets with a wildcard
    // ACAO so the sandboxed (opaque-origin) iframe can load it in CORS mode.
    const frameBody = await (await fetch(`${baseUrl}/chart-frame.html`)).text()
    const chunk = frameBody.match(/\/app\/assets\/chartFrame-[A-Za-z0-9_-]+\.js/)
    assert.ok(chunk, 'chart frame references a hashed chartFrame chunk')
    const asset = await fetch(`${baseUrl}${chunk![0]}`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') || '', /text\/javascript/)
    assert.equal(asset.headers.get('access-control-allow-origin'), '*')
  } finally {
    await fixture.server.close()
  }
})

// SEC-1: the presigned-upload BEGIN endpoint mints a URL that writes bytes straight to the
// object store, bypassing the pod — so it must run the SAME billing + quota gate the
// buffered upload runs. A canceled subscription must reject the mint (402), not hand out a
// bypass URL.
test('cloud HTTP server gates presigned artifact upload BEGIN behind the billing/quota check', async () => {
  const billing = testBillingConfig()
  const fixture = createFixture({
    billing,
    billingAdapter: createStubBillingAdapter(billing),
    objectStore: createPresignCapableObjectStore(),
    auth: () => ({
      tenantId: 'tenant-1',
      orgId: 'tenant-1',
      tenantName: 'Tenant 1',
      userId: 'owner-1',
      accountId: 'owner-1',
      email: 'owner@example.test',
      role: 'owner',
      authSource: 'user',
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    // Activate billing (the stub checkout creates an active subscription) so the org can
    // create sessions; we cancel it below to prove the presign gate rejects the mint.
    const checkout = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planKey: 'pro' }),
    })
    assert.equal(checkout.status, 200)

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(createdResponse.status, 201)
    const sessionId = String(asRecord((await readJson(createdResponse)).session).sessionId)

    // With billing active, BEGIN mints a presigned URL.
    const allowed = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'chart.png', contentType: 'image/png', expectedSize: 5 }),
    })
    assert.equal(allowed.status, 200)
    assert.equal(asRecord((await readJson(allowed)).upload).transfer, 'presigned')

    // Cancel the subscription, then BEGIN must be rejected before minting any URL.
    await fixture.store.upsertBillingSubscription({
      orgId: 'tenant-1',
      providerId: 'stub',
      providerCustomerId: 'stub_customer_tenant-1',
      providerSubscriptionId: 'stub_subscription_tenant-1',
      planKey: 'pro',
      status: 'canceled',
    })

    const blocked = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'chart.png', contentType: 'image/png', expectedSize: 5 }),
    })
    assert.equal(blocked.status, 402)
    assert.equal(asRecord((await readJson(blocked)).verdict).policyCode, 'billing.subscription_inactive')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server attaches request ids and emits observability records', async () => {
  const logs: unknown[] = []
  const metrics: unknown[] = []
  const spans: unknown[] = []
  const observability: CloudObservabilityAdapter = {
    log(record) { logs.push(record) },
    metric(record) { metrics.push(record) },
    span(record) { spans.push(record) },
  }
  const fixture = createFixture({ observability })
  const baseUrl = await fixture.server.listen()

  try {
    const response = await fetch(`${baseUrl}/livez`, {
      headers: { 'x-request-id': 'request-1' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'request-1')
    await response.text()
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal((logs[0] as Record<string, unknown>).name, 'cloud.http.request')
    assert.equal((metrics[0] as Record<string, unknown>).name, 'cloud.http.server.duration_ms')
    assert.equal((spans[0] as Record<string, unknown>).name, 'cloud.http.request')
    assert.equal(((logs[0] as Record<string, unknown>).attributes as Record<string, unknown>).request_id, 'request-1')
    assert.equal(((logs[0] as Record<string, unknown>).attributes as Record<string, unknown>)['url.path'], '/livez')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server exposes operator-scoped Prometheus metrics', async () => {
  const memberFixture = createFixture({
    observability: createPrometheusCloudObservability(),
    auth: () => ({
      tenantId: 'tenant-1',
      tenantName: 'Tenant 1',
      orgId: 'tenant-1',
      userId: 'member-1',
      accountId: 'member-1',
      email: 'member@example.test',
      role: 'member',
      authSource: 'user',
    }),
  })
  const memberBaseUrl = await memberFixture.server.listen()
  try {
    const blocked = await fetch(`${memberBaseUrl}/api/metrics`)
    assert.equal(blocked.status, 403)
  } finally {
    await memberFixture.server.close()
  }

  const observability = createPrometheusCloudObservability()
  const fixture = createFixture({ observability })
  const baseUrl = await fixture.server.listen()

  try {
    const liveness = await fetch(`${baseUrl}/livez`)
    assert.equal(liveness.status, 200)
    await liveness.text()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const metrics = await fetch(`${baseUrl}/api/metrics`)
    assert.equal(metrics.status, 200)
    const text = await metrics.text()
    assert.match(text, /open_cowork_cloud_http_requests_total/)
    assert.match(text, /open_cowork_cloud_http_request_duration_ms/)
    assert.doesNotMatch(text, /request-1/)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server metrics require operator-scoped API token access', async () => {
  const observability = createPrometheusCloudObservability()
  const principal = (
    userId: string,
    role: CloudPrincipal['role'],
    authSource: CloudPrincipal['authSource'],
    tokenScopes?: CloudPrincipal['tokenScopes'],
  ): CloudPrincipal => ({
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId,
    accountId: userId,
    email: `${userId}@example.test`,
    role,
    authSource,
    tokenScopes,
  })
  const fixture = createFixture({
    observability,
    auth: (req) => {
      const authorization = String(req.headers.authorization || '')
      if (authorization === 'Bearer operator-token') return principal('operator-token', 'admin', 'api_token', ['operator'])
      if (authorization === 'Bearer gateway-token') return principal('gateway-token', 'admin', 'api_token', ['gateway'])
      if (authorization === 'Bearer desktop-token') return principal('desktop-token', 'admin', 'api_token', ['desktop'])
      if (authorization === 'Bearer worker-token') return principal('worker-token', 'member', 'api_token', ['worker-internal'])
      return principal('member-1', 'member', 'user')
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    assert.equal((await fetch(`${baseUrl}/api/metrics`)).status, 403)
    assert.equal((await fetch(`${baseUrl}/api/metrics`, {
      headers: { authorization: 'Bearer gateway-token' },
    })).status, 403)
    assert.equal((await fetch(`${baseUrl}/api/metrics`, {
      headers: { authorization: 'Bearer desktop-token' },
    })).status, 403)
    assert.equal((await fetch(`${baseUrl}/api/metrics`, {
      headers: { authorization: 'Bearer worker-token' },
    })).status, 403)
    assert.equal((await fetch(`${baseUrl}/api/workers/heartbeats`, {
      headers: { authorization: 'Bearer worker-token' },
    })).status, 200)

    const liveness = await fetch(`${baseUrl}/livez`)
    assert.equal(liveness.status, 200)
    await liveness.text()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const metrics = await fetch(`${baseUrl}/api/metrics`, {
      headers: { authorization: 'Bearer operator-token' },
    })
    assert.equal(metrics.status, 200)
    assert.match(await metrics.text(), /open_cowork_cloud_http_requests_total/)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server emits auth and quota denial metrics', async () => {
  const metrics: unknown[] = []
  const observability: CloudObservabilityAdapter = {
    log() {},
    metric(record) { metrics.push(record) },
    span() {},
  }
  const authFixture = createFixture({
    observability,
    auth: () => {
      throw new CloudHttpError(401, 'Cloud authentication is required.', { policyCode: 'auth.invalid_token' })
    },
  })
  const authBaseUrl = await authFixture.server.listen()
  try {
    const rejected = await fetch(`${authBaseUrl}/api/workspace`)
    assert.equal(rejected.status, 401)
    await rejected.text()
  } finally {
    await authFixture.server.close()
  }

  const quotaFixture = createFixture({
    observability,
    abuse: testAbuseConfig({
      httpRateLimit: {
        enabled: true,
        windowMs: 60_000,
        maxRequests: 1,
      },
    }),
  })
  const quotaBaseUrl = await quotaFixture.server.listen()
  try {
    const first = await fetch(`${quotaBaseUrl}/api/workspace`)
    assert.equal(first.status, 200)
    await first.text()
    const second = await fetch(`${quotaBaseUrl}/api/workspace`)
    assert.equal(second.status, 429)
    await second.text()
  } finally {
    await quotaFixture.server.close()
  }

  assert.equal(metrics.some((metric) => (metric as Record<string, unknown>).name === 'open_cowork_cloud_auth_failures_total'), true)
  assert.equal(metrics.some((metric) => (metric as Record<string, unknown>).name === 'open_cowork_cloud_quota_rejections_total'), true)
})

test('cloud HTTP policy error responses ignore failing observability sinks', async () => {
  const observability: CloudObservabilityAdapter = {
    log() {},
    metric() { throw new Error('metric sink unavailable') },
    span() {},
  }
  const fixture = createFixture({
    observability,
    auth: () => {
      throw new CloudHttpError(401, 'Cloud authentication is required.', { policyCode: 'auth.invalid_token' })
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const rejected = await fetch(`${baseUrl}/api/workspace`, {
      signal: AbortSignal.timeout(1_000),
    })
    assert.equal(rejected.status, 401)
    await rejected.text()
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP browser session cookies use secure flags and enforce CSRF on mutating routes', async () => {
  const sessionCookies = createCloudSessionCookieManager({
    secret: TEST_COOKIE_KEY,
    now: () => new Date('2026-05-26T12:00:00.000Z'),
  })
  const fixture = createFixture({ sessionCookies })
  const baseUrl = await fixture.server.listen()

  try {
    const loginResponse = await fetch(`${baseUrl}/auth/session`, { method: 'POST' })
    assert.equal(loginResponse.status, 200)
    const login = await readJson(loginResponse)
    assert.equal(asRecord(login.principal).tenantId, 'tenant-1')
    assert.equal(typeof login.csrfToken, 'string')

    const cookies = setCookieHeaders(loginResponse)
    assert.equal(cookies.length, 2)
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('open_cowork_cloud_session='))
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('open_cowork_cloud_csrf='))
    assert.ok(sessionCookie)
    assert.ok(csrfCookie)
    assert.match(sessionCookie, /HttpOnly/)
    assert.match(sessionCookie, /Secure/)
    assert.match(sessionCookie, /SameSite=Lax/)
    assert.doesNotMatch(csrfCookie, /HttpOnly/)
    assert.match(csrfCookie, /Secure/)
    assert.match(csrfCookie, /SameSite=Lax/)

    const missingCsrf = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader(cookies),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert.equal(missingCsrf.status, 403)

    const csrfToken = cookieValue(cookies, 'open_cowork_cloud_csrf')
    assert.ok(csrfToken)
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader(cookies),
        'x-csrf-token': csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert.equal(created.status, 201)

    const me = await readJson(await fetch(`${baseUrl}/auth/me`, {
      headers: {
        cookie: cookieHeader(cookies),
      },
    }))
    assert.equal(asRecord(me.principal).userId, 'user-1')
    assert.equal(me.csrfToken, csrfToken)

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader(cookies),
        'x-csrf-token': csrfToken,
      },
    })
    assert.equal(logout.status, 200)
    assert.equal(setCookieHeaders(logout).every((cookie) => /Max-Age=0/.test(cookie)), true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP browser session cookies refresh membership role before admin authorization', async () => {
  const sessionCookies = createCloudSessionCookieManager({
    secret: TEST_COOKIE_KEY,
    now: () => new Date('2026-05-26T12:00:00.000Z'),
  })
  const fixture = createFixture({
    sessionCookies,
    auth: () => {
      throw new CloudHttpError(401, 'Fallback auth should not be used for cookie requests.')
    },
  })
  fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const org = fixture.store.ensureOrgForTenant({ tenantId: 'tenant-1', orgId: 'tenant-1', name: 'Tenant 1' })
  const account = fixture.store.createAccount({
    accountId: 'admin-1',
    idpSubject: 'subject-admin-1',
    email: 'admin@example.test',
  })
  fixture.store.ensureUser({
    tenantId: 'tenant-1',
    userId: account.accountId,
    email: account.email,
    role: 'admin',
  })
  fixture.store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'admin',
    status: 'active',
  })
  const staleAdminCookie = sessionCookies.issue({
    tenantId: 'tenant-1',
    orgId: org.orgId,
    tenantName: 'Tenant 1',
    userId: account.accountId,
    accountId: account.accountId,
    email: account.email,
    role: 'admin',
    authSource: 'user',
  })
  const headers = { cookie: cookieHeader(staleAdminCookie.setCookieHeaders) }
  const baseUrl = await fixture.server.listen()

  try {
    const beforeDemotion = await fetch(`${baseUrl}/api/admin/members`, { headers })
    assert.equal(beforeDemotion.status, 200)

    fixture.store.upsertMembership({
      orgId: org.orgId,
      accountId: account.accountId,
      role: 'member',
      status: 'active',
    })

    const afterDemotion = await fetch(`${baseUrl}/api/admin/members`, { headers })
    assert.equal(afterDemotion.status, 403)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes public desktop OIDC config without cookies', async () => {
  const fixture = createFixture({
    desktopAuth: {
      mode: 'oidc',
      issuerUrl: 'https://issuer.example.test',
      clientId: 'open-cowork-desktop',
      scope: 'openid email profile offline_access',
    },
  })
  const baseUrl = await fixture.server.listen()

  try {
    const response = await fetch(`${baseUrl}/auth/desktop/config`)
    assert.equal(response.status, 200)
    const body = await readJson(response)
    assert.deepEqual(body, {
      mode: 'oidc',
      issuerUrl: 'https://issuer.example.test',
      clientId: 'open-cowork-desktop',
      scope: 'openid email profile offline_access',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP bearer auth remains usable without CSRF when session cookies are configured', async () => {
  const sessionCookies = createCloudSessionCookieManager({
    secret: TEST_COOKIE_KEY,
    now: () => new Date('2026-05-26T12:00:00.000Z'),
  })
  const auth: CloudAuthResolver = (req) => {
    assert.equal(req.headers.authorization, 'Bearer test-token')
    return {
      tenantId: 'tenant-bearer',
      tenantName: 'Tenant Bearer',
      userId: 'bearer-user',
      email: 'bearer@example.test',
    }
  }
  const fixture = createFixture({ sessionCookies, auth })
  const baseUrl = await fixture.server.listen()

  try {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert.equal(created.status, 201)
    const body = await readJson(created)
    assert.equal(asRecord(body.session).tenantId, 'tenant-bearer')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP OIDC browser login redirects through callback and issues session cookies', async () => {
  const sessionCookies = createCloudSessionCookieManager({
    secret: TEST_COOKIE_KEY,
    now: () => new Date('2026-05-26T12:00:00.000Z'),
  })
  const browserAuth: CloudBrowserAuthProvider = {
    isCallbackPath(pathname) {
      return pathname === '/auth/callback'
    },
    login() {
      return {
        location: 'https://auth.example.test/authorize?state=state-1',
        setCookieHeaders: ['open_cowork_cloud_oidc=state-cookie; Max-Age=600; Path=/; SameSite=Lax; HttpOnly; Secure'],
      }
    },
    callback(_req, url) {
      assert.equal(url.searchParams.get('code'), 'code-1')
      assert.equal(url.searchParams.get('state'), 'state-1')
      return {
        principal: {
          tenantId: 'tenant-oidc',
          tenantName: 'Tenant OIDC',
          userId: 'oidc-user',
          email: 'oidc@example.test',
        },
        redirectTo: '/cloud',
        setCookieHeaders: ['open_cowork_cloud_oidc=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly; Secure'],
      }
    },
  }
  const fixture = createFixture({ sessionCookies, browserAuth })
  const baseUrl = await fixture.server.listen()

  try {
    if (browserRendererBuildExists()) {
      const shell = await (await fetch(`${baseUrl}/`)).text()
      const bootstrapMatch = shell.match(/<script id="cowork-bootstrap" type="application\/json">([\s\S]*?)<\/script>/)
      assert.ok(bootstrapMatch, 'renderer shell carries its public bootstrap')
      const bootstrap = JSON.parse(bootstrapMatch[1] || '{}') as Record<string, unknown>
      assert.deepEqual(Object.keys(bootstrap).sort(), ['authRequired', 'sessionEventTypes'])
      assert.equal(bootstrap.authRequired, true)
      assert.equal(Array.isArray(bootstrap.sessionEventTypes), true)
      assert.doesNotMatch(JSON.stringify(bootstrap), /cookie|secret|tenant|provider/i)
    }

    const login = await fetch(`${baseUrl}/auth/login?returnTo=/cloud`, { redirect: 'manual' })
    assert.equal(login.status, 302)
    assert.equal(login.headers.get('location'), 'https://auth.example.test/authorize?state=state-1')
    assert.match(setCookieHeaders(login)[0] || '', /open_cowork_cloud_oidc=state-cookie/)

    const callback = await fetch(`${baseUrl}/auth/callback?code=code-1&state=state-1`, {
      redirect: 'manual',
      headers: { cookie: cookieHeader(setCookieHeaders(login)) },
    })
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get('location'), '/cloud')
    const cookies = setCookieHeaders(callback)
    assert.equal(cookies.some((cookie) => cookie.startsWith('open_cowork_cloud_oidc=') && /Max-Age=0/.test(cookie)), true)
    assert.equal(cookies.some((cookie) => cookie.startsWith('open_cowork_cloud_session=')), true)
    assert.equal(cookies.some((cookie) => cookie.startsWith('open_cowork_cloud_csrf=')), true)

    const me = await readJson(await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: cookieHeader(cookies) },
    }))
    assert.equal(asRecord(me.principal).tenantId, 'tenant-oidc')
    assert.equal(asRecord(me.principal).email, 'oidc@example.test')
  } finally {
    await fixture.server.close()
  }
})
