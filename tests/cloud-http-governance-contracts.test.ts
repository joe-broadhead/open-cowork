import test from 'node:test'
import assert from 'node:assert/strict'
import { CloudHttpError } from '@open-cowork/cloud-server/http-server'
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-server/transport-adapter'
import { CloudSessionService, type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createStubBillingAdapter } from '@open-cowork/cloud-server/stub-billing-adapter'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
  testAbuseConfig,
  testBillingConfig,
} from './helpers/cloud-http-test-support.ts'

test('cloud HTTP server readiness fails closed when no readiness callback is configured', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const live = await readJson(await fetch(`${baseUrl}/livez`))
    assert.equal(live.ok, true)
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 404)

    const response = await fetch(`${baseUrl}/readyz`)
    assert.equal(response.status, 503)
    const ready = await readJson(response)
    assert.equal(ready.ok, false)
    const checks = asArray(ready.checks).map(asRecord)
    assert.equal(checks.some((entry) => entry.name === 'readiness_config' && entry.status === 'error'), true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server returns machine-readable rate-limit and auth-backoff responses', async () => {
  const fixture = createFixture({
    auth: () => {
      throw new CloudHttpError(401, 'not authorized')
    },
    abuse: testAbuseConfig({
      httpRateLimit: { enabled: true, windowMs: 60_000, maxRequests: 2 },
      authBackoff: { enabled: true, windowMs: 60_000, maxFailures: 1, backoffMs: 60_000 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    assert.equal((await fetch(`${baseUrl}/livez`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/config`)).status, 401)
    const authBlocked = await fetch(`${baseUrl}/api/config`)
    assert.equal(authBlocked.status, 429)
    const authBackoff = await readJson(authBlocked)
    assert.equal(asRecord(authBackoff.verdict).policyCode, 'auth.backoff')
    assert.equal(Number(authBlocked.headers.get('retry-after')) > 0, true)

    const rateLimited = await fetch(`${baseUrl}/api/config`)
    assert.equal(rateLimited.status, 429)
    const rateBody = await readJson(rateLimited)
    assert.equal(asRecord(rateBody.verdict).policyCode, 'rate_limit.http_exceeded')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server preserves auth failures when auth accounting storage fails', async () => {
  const accountingMetrics: string[] = []
  const fixture = createFixture({
    auth: () => {
      throw new CloudHttpError(401, 'not authorized')
    },
    observability: {
      log() {},
      metric(record) {
        if (record.name === 'open_cowork_cloud_auth_accounting_errors_total') {
          accountingMetrics.push(String(record.attributes?.cloud_auth_accounting_operation || ''))
        }
      },
      span() {},
    },
    abuse: testAbuseConfig({
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
      authBackoff: { enabled: true, windowMs: 60_000, maxFailures: 1, backoffMs: 60_000 },
    }),
  })
  const service = fixture.service as CloudSessionService & {
    checkCloudAuthBackoff: CloudSessionService['checkCloudAuthBackoff']
    recordCloudAuthFailure: CloudSessionService['recordCloudAuthFailure']
  }
  service.checkCloudAuthBackoff = async () => {
    throw new Error('auth accounting store unavailable')
  }
  service.recordCloudAuthFailure = async () => {
    throw new Error('auth accounting store unavailable')
  }

  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/config`)
    assert.equal(response.status, 401)
    const body = await readJson(response)
    assert.equal(body.error, 'not authorized')
    assert.deepEqual(accountingMetrics.sort(), ['check_backoff', 'record_failure'])
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server preserves auth backoff when another auth scope has accounting storage failure', async () => {
  let authCalled = false
  const fixture = createFixture({
    auth: () => {
      authCalled = true
      return {
        tenantId: 'tenant-1',
        tenantName: 'Tenant 1',
        orgId: 'tenant-1',
        userId: 'user-1',
        accountId: 'user-1',
        email: 'user@example.test',
        role: 'owner',
        authSource: 'local',
      }
    },
    abuse: testAbuseConfig({
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
      authBackoff: { enabled: true, windowMs: 60_000, maxFailures: 1, backoffMs: 60_000 },
    }),
  })
  const service = fixture.service as CloudSessionService & {
    checkCloudAuthBackoff: CloudSessionService['checkCloudAuthBackoff']
  }
  service.checkCloudAuthBackoff = async ({ scope }) => {
    if (scope.startsWith('auth:')) {
      throw new CloudHttpError(429, 'Too many rejected cloud authentication attempts. Try again later.', {
        policyCode: 'auth.backoff',
        retryAfterMs: 60_000,
      })
    }
    throw new Error('auth accounting store unavailable')
  }

  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/config`, {
      headers: { authorization: 'Bearer invalid-token' },
    })
    assert.equal(response.status, 429)
    assert.equal(authCalled, false)
    const body = await readJson(response)
    assert.equal(asRecord(body.verdict).policyCode, 'auth.backoff')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server auth backoff applies to the source when bearer tokens rotate', async () => {
  const fixture = createFixture({
    auth: () => {
      throw new CloudHttpError(401, 'not authorized')
    },
    abuse: testAbuseConfig({
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
      authBackoff: { enabled: true, windowMs: 60_000, maxFailures: 1, backoffMs: 60_000 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const first = await fetch(`${baseUrl}/api/config`, {
      headers: { authorization: 'Bearer one-invalid-token' },
    })
    assert.equal(first.status, 401)

    const rotated = await fetch(`${baseUrl}/api/config`, {
      headers: { authorization: 'Bearer another-invalid-token' },
    })
    assert.equal(rotated.status, 429)
    const blocked = await readJson(rotated)
    assert.equal(asRecord(blocked.verdict).policyCode, 'auth.backoff')
    assert.equal(Number(rotated.headers.get('retry-after')) > 0, true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server blocks excess gateway channel bindings before persistence', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxGatewayChannelBindingsPerOrg: 1,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-quota',
        name: 'Quota agent',
        profileName: 'full',
      }),
    })
    assert.equal(agentResponse.status, 201)

    const firstBinding = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindingId: 'binding-quota-1',
        agentId: 'agent-quota',
        provider: 'telegram',
        displayName: 'Telegram',
      }),
    })
    assert.equal(firstBinding.status, 201)

    const secondBinding = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindingId: 'binding-quota-2',
        agentId: 'agent-quota',
        provider: 'slack',
        displayName: 'Slack',
      }),
    })
    assert.equal(secondBinding.status, 429)
    const body = await readJson(secondBinding)
    assert.equal(asRecord(body.verdict).policyCode, 'quota.gateway_channel_bindings_exceeded')
    const listed = await readJson(await fetch(`${baseUrl}/api/channels/bindings`))
    assert.equal(asArray(listed.bindings).length, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server blocks artifact uploads that exceed daily byte quota', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxArtifactBytesPerDay: 4,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const upload = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'too-large.txt',
        contentType: 'text/plain',
        dataBase64: Buffer.from('hello').toString('base64'),
      }),
    })
    assert.equal(upload.status, 429)
    const body = await readJson(upload)
    assert.equal(asRecord(body.verdict).policyCode, 'quota.artifact_bytes_per_day_exceeded')
    const artifacts = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))
    assert.equal(asArray(artifacts.artifacts).length, 0)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP validates artifact metadata before consuming upload quota', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxArtifactBytesPerDay: 100,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const upload = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'invalid-kind.txt',
        contentType: 'text/plain',
        dataBase64: Buffer.from('valid body').toString('base64'),
        kind: 'unknown-kind',
      }),
    })
    assert.equal(upload.status, 400)
    const counters = await fixture.store.listUsageQuotaCounters('tenant-1')
    const artifactBytes = counters.find((counter) => counter.quotaKey === 'artifact_bytes:day')
    assert.equal(artifactBytes?.quantity || 0, 0)
    const artifacts = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))
    assert.equal(asArray(artifacts.artifacts).length, 0)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server exposes metadata-only BYOK APIs with rotation, disable, and audit records', async () => {
  const rawFirst = 'credential-http-first-1234567890'
  const rawSecond = 'credential-http-second-abcdefghi'
  const fixture = createFixture({
    byokSecretStoreOptions: {
      validators: { anthropic: () => true },
    },
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
    const createResponse = await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: rawFirst }),
    })
    assert.equal(createResponse.status, 201)
    const created = await readJson(createResponse)
    const createdSecret = asRecord(created.secret)
    assert.equal(createdSecret.providerId, 'anthropic')
    assert.equal(createdSecret.status, 'pending_validation')
    assert.equal(createdSecret.credentialKind, 'plaintext')
    assert.equal(createdSecret.last4, '7890')
    assert.equal(JSON.stringify(created).includes(rawFirst), false)
    assert.equal(JSON.stringify(created).includes('ciphertext'), false)
    assert.equal(JSON.stringify(created).includes('kmsRef'), false)

    const list = await readJson(await fetch(`${baseUrl}/api/byok`))
    assert.equal(asArray(list.secrets).length, 1)
    assert.equal(JSON.stringify(list).includes(rawFirst), false)

    const validateResponse = await fetch(`${baseUrl}/api/byok/anthropic/validate`, { method: 'POST' })
    assert.equal(validateResponse.status, 200)
    const validated = await readJson(validateResponse)
    assert.equal(asRecord(validated.secret).status, 'active')
    assert.equal(typeof asRecord(validated.secret).lastValidatedAt, 'string')
    assert.equal(JSON.stringify(validated).includes(rawFirst), false)

    const client = createHttpSseCloudTransportAdapter({ baseUrl })
    const clientSecret = await client.validateByokSecret?.('anthropic')
    assert.equal(clientSecret?.status, 'active')
    assert.equal(JSON.stringify(clientSecret).includes(rawFirst), false)

    const rotateResponse = await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: rawSecond }),
    })
    assert.equal(rotateResponse.status, 201)
    const rotated = await readJson(rotateResponse)
    assert.equal(asRecord(rotated.secret).status, 'pending_validation')
    assert.equal(asRecord(rotated.secret).last4, 'fghi')
    assert.equal(JSON.stringify(rotated).includes(rawSecond), false)

    const validateRotated = await fetch(`${baseUrl}/api/byok/anthropic/validate`, { method: 'POST' })
    assert.equal(validateRotated.status, 200)
    assert.equal(asRecord((await readJson(validateRotated)).secret).status, 'active')

    const records = await fixture.store.listByokSecrets('tenant-1')
    assert.equal(records.length, 2)
    assert.equal(records.filter((record) => record.status === 'active').length, 1)
    assert.equal(records.some((record) => record.status === 'disabled'), true)
    assert.equal(JSON.stringify(records).includes(rawFirst), false)
    assert.equal(JSON.stringify(records).includes(rawSecond), false)

    const deleteResponse = await fetch(`${baseUrl}/api/byok/anthropic`, { method: 'DELETE' })
    assert.equal(deleteResponse.status, 200)
    const deleted = await readJson(deleteResponse)
    assert.equal(deleted.disabled, true)
    assert.equal(asRecord(deleted.secret).status, 'disabled')
    assert.equal(await fixture.store.getActiveByokSecret('tenant-1', 'anthropic'), null)
    assert.equal((await fixture.store.listByokSecrets('tenant-1')).filter((record) => record.status !== 'disabled').length, 0)

    const provider = await readJson(await fetch(`${baseUrl}/api/byok/anthropic`))
    assert.equal(asRecord(provider.secret).status, 'disabled')
    assert.equal(JSON.stringify(provider).includes(rawSecond), false)

    const audit = await fixture.store.listAuditEvents('tenant-1')
    assert.equal(audit.some((event) => event.eventType === 'byok_secret.created'), true)
    assert.equal(audit.some((event) => event.eventType === 'byok_secret.rotated'), true)
    assert.equal(audit.some((event) => event.eventType === 'byok_secret.disabled'), true)
    assert.equal(JSON.stringify(audit).includes(rawFirst), false)
    assert.equal(JSON.stringify(audit).includes(rawSecond), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP BYOK APIs enforce effective policy permissions and explicit token scope', async () => {
  const rawKey = 'credential-http-rbac-1234567890'
  let currentPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    orgId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'policy-manager',
    accountId: 'policy-manager',
    email: 'policy-manager@example.test',
    role: 'member',
    authSource: 'user',
  }
  const fixture = createFixture({
    auth: () => ({
      ...currentPrincipal,
      tokenScopes: currentPrincipal.tokenScopes ? [...currentPrincipal.tokenScopes] : undefined,
    }),
  })
  await fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1', orgId: 'tenant-1' })
  await fixture.store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1', orgId: 'tenant-1' })
  await fixture.store.createAccount({ accountId: 'policy-manager', email: 'policy-manager@example.test' })
  await fixture.store.createCustomRole({
    orgId: 'tenant-1',
    roleKey: 'provider-key-admin',
    name: 'Provider Key Admin',
    baseRole: 'member',
    permissions: ['org:read', 'policy:manage'],
  })
  await fixture.store.upsertMembership({
    orgId: 'tenant-1',
    accountId: 'policy-manager',
    role: 'member',
    customRoleKey: 'provider-key-admin',
    status: 'active',
  })
  await fixture.store.createAccount({ accountId: 'limited-admin', email: 'limited-admin@example.test' })
  await fixture.store.createCustomRole({
    orgId: 'tenant-1',
    roleKey: 'limited-admin',
    name: 'Limited Admin',
    baseRole: 'admin',
    permissions: ['org:read', 'members:read'],
  })
  await fixture.store.upsertMembership({
    orgId: 'tenant-1',
    accountId: 'limited-admin',
    role: 'admin',
    customRoleKey: 'limited-admin',
    status: 'active',
  })

  const baseUrl = await fixture.server.listen()
  try {
    const delegatedCreate = await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: rawKey }),
    })
    assert.equal(delegatedCreate.status, 201)
    assert.equal(asRecord((await readJson(delegatedCreate)).secret).providerId, 'anthropic')

    currentPrincipal = {
      tenantId: 'tenant-1',
      orgId: 'tenant-1',
      tenantName: 'Tenant 1',
      userId: 'limited-admin',
      accountId: 'limited-admin',
      email: 'limited-admin@example.test',
      role: 'admin',
      authSource: 'user',
    }
    const strippedAdminRead = await fetch(`${baseUrl}/api/byok`)
    assert.equal(strippedAdminRead.status, 403)
    assert.match(JSON.stringify(await readJson(strippedAdminRead)), /policy:manage/)

    currentPrincipal = {
      tenantId: 'tenant-1',
      orgId: 'tenant-1',
      tenantName: 'Tenant 1',
      userId: 'token-admin',
      accountId: 'token-admin',
      email: 'token-admin@example.test',
      role: 'owner',
      authSource: 'api_token',
      tokenId: 'token-desktop',
      tokenScopes: ['desktop'],
    }
    const desktopTokenRead = await fetch(`${baseUrl}/api/byok`)
    assert.equal(desktopTokenRead.status, 403)
    assert.match(JSON.stringify(await readJson(desktopTokenRead)), /admin token scope/)

    currentPrincipal = {
      tenantId: 'tenant-1',
      orgId: 'tenant-1',
      tenantName: 'Tenant 1',
      userId: 'token-admin',
      accountId: 'token-admin',
      email: 'token-admin@example.test',
      role: 'owner',
      authSource: 'api_token',
      tokenId: 'token-admin',
      tokenScopes: ['admin'],
    }
    const adminTokenRead = await fetch(`${baseUrl}/api/byok`)
    assert.equal(adminTokenRead.status, 200)
    assert.equal(asArray((await readJson(adminTokenRead)).secrets).length, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP BYOK APIs enforce provider availability and org entitlement policy', async () => {
  const unavailableProviderKey = ['credential', 'policy', 'openai', '1234567890'].join('-')
  const blockedProviderKey = ['credential', 'policy', 'anthropic', '1234567890'].join('-')
  const fixture = createFixture({
    byokPolicy: {
      allowedProviderIds: ['anthropic'],
      checkEntitlement(input) {
        return input.providerId === 'anthropic'
          ? { allowed: false, status: 402, reason: 'BYOK provider is not included in this plan.' }
          : { allowed: true }
      },
    },
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
    const unavailable = await fetch(`${baseUrl}/api/byok/openai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: unavailableProviderKey }),
    })
    assert.equal(unavailable.status, 403)
    assert.match(JSON.stringify(await readJson(unavailable)), /not enabled/)

    const blocked = await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: blockedProviderKey }),
    })
    assert.equal(blocked.status, 402)
    assert.match(JSON.stringify(await readJson(blocked)), /not included/)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP BYOK APIs treat an empty provider allowlist as deny-all', async () => {
  const fixture = createFixture({
    byokPolicy: {
      allowedProviderIds: [],
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: ['credential', 'empty', 'allowlist', '1234567890'].join('-') }),
    })

    assert.equal(response.status, 403)
    assert.match(JSON.stringify(await readJson(response)), /not enabled/)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP BYOK override activates an unvalidated provider with audited reason', async () => {
  const rawKey = 'credential-http-override-1234567890'
  const fixture = createFixture({
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
    // Require audited override when no validator exists for custom-provider.
    byokSecretStoreOptions: { activateUnvalidatedProviders: false },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/byok/custom-provider`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: rawKey }),
    }))
    assert.equal(asRecord(created.secret).status, 'pending_validation')

    const validated = await readJson(await fetch(`${baseUrl}/api/byok/custom-provider/validate`, { method: 'POST' }))
    assert.equal(asRecord(validated.secret).status, 'unsupported')
    assert.equal(validated.validated, false)

    const override = await fetch(`${baseUrl}/api/byok/custom-provider/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: `manual smoke ${rawKey}` }),
    })
    assert.equal(override.status, 200)
    const overridden = await readJson(override)
    assert.equal(overridden.overridden, true)
    assert.equal(asRecord(overridden.secret).status, 'active')
    assert.equal(JSON.stringify(overridden).includes(rawKey), false)

    const auditPayload = JSON.stringify(await fixture.store.listAuditEvents('tenant-1'))
    assert.match(auditPayload, /byok_secret.validation_override/)
    assert.equal(auditPayload.includes(rawKey), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP billing routes use stub adapter and gate canceled subscriptions with 402', async () => {
  const billing = testBillingConfig()
  const fixture = createFixture({
    billing,
    billingAdapter: createStubBillingAdapter(billing),
    autoProcessCommands: false,
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
    const initial = await readJson(await fetch(`${baseUrl}/api/billing/subscription`))
    assert.equal(initial.enabled, true)
    assert.equal(initial.subscription, null)

    const checkoutResponse = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planKey: 'pro' }),
    })
    assert.equal(checkoutResponse.status, 200)
    assert.match(String((await readJson(checkoutResponse)).url), /billing\.local/)

    const active = await readJson(await fetch(`${baseUrl}/api/billing/subscription`))
    assert.equal(asRecord(active.subscription).status, 'active')
    assert.equal(active.active, true)

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(createdResponse.status, 201)
    const sessionId = String(asRecord((await readJson(createdResponse)).session).sessionId)

    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'billing-agent',
        name: 'Billing agent',
        profileName: 'full',
      }),
    })
    assert.equal(agentResponse.status, 201)
    const bindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindingId: 'billing-binding',
        agentId: 'billing-agent',
        provider: 'telegram',
        displayName: 'Billing Telegram',
      }),
    })
    assert.equal(bindingResponse.status, 201)
    const identityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'telegram',
        externalUserId: 'billing-user',
        accountId: 'owner-1',
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(identityResponse.status, 200)
    const identity = asRecord((await readJson(identityResponse)).identity)

    await fixture.store.upsertBillingSubscription({
      orgId: 'tenant-1',
      providerId: 'stub',
      providerCustomerId: 'stub_customer_tenant-1',
      providerSubscriptionId: 'stub_subscription_tenant-1',
      planKey: 'pro',
      status: 'canceled',
    })

    const blockedCreate = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(blockedCreate.status, 402)
    const createBody = await readJson(blockedCreate)
    assert.equal(asRecord(createBody.verdict).policyCode, 'billing.subscription_inactive')

    const blockedPrompt = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'should not run' }),
    })
    assert.equal(blockedPrompt.status, 402)
    const promptBody = await readJson(blockedPrompt)
    assert.equal(asRecord(promptBody.verdict).policyCode, 'billing.subscription_inactive')

    const blockedArtifact = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'blocked.txt',
        contentType: 'text/plain',
        dataBase64: Buffer.from('blocked').toString('base64'),
      }),
    })
    assert.equal(blockedArtifact.status, 402)
    assert.equal(asRecord((await readJson(blockedArtifact)).verdict).policyCode, 'billing.subscription_inactive')

    const blockedBinding = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindingId: 'billing-binding-blocked',
        agentId: 'billing-agent',
        provider: 'slack',
        displayName: 'Blocked Slack',
      }),
    })
    assert.equal(blockedBinding.status, 402)
    assert.equal(asRecord((await readJson(blockedBinding)).verdict).policyCode, 'billing.subscription_inactive')

    const blockedChannelBind = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: 'billing-binding',
        provider: 'telegram',
        externalChatId: 'billing-chat',
        externalThreadId: 'billing-thread',
        title: 'Billing blocked thread',
      }),
    })
    assert.equal(blockedChannelBind.status, 402)
    assert.equal(asRecord((await readJson(blockedChannelBind)).verdict).policyCode, 'billing.subscription_inactive')

    await fixture.store.enqueueSessionCommand({
      commandId: 'queued-before-cancel',
      tenantId: 'tenant-1',
      userId: 'owner-1',
      sessionId,
      kind: 'prompt',
      payload: { text: 'queued', agent: 'build' },
    })
    assert.equal(await fixture.worker.processSessionCommands('tenant-1', sessionId), 0)
    assert.equal(fixture.runtime.prompts.length, 0)
  } finally {
    await fixture.server.close()
  }
})

test('cloud billing webhook updates subscriptions idempotently with replay protection', async () => {
  const billing = testBillingConfig()
  const fixture = createFixture({
    billing,
    billingAdapter: createStubBillingAdapter(billing),
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
    await readJson(await fetch(`${baseUrl}/api/billing/subscription`))
    const payload = {
      id: 'evt_stub_1',
      type: 'customer.subscription.updated',
      subscription: {
        orgId: 'tenant-1',
        planKey: 'pro',
        status: 'active',
      },
    }
    const first = await fetch(`${baseUrl}/webhooks/billing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(first.status, 200)
    assert.equal(asRecord((await readJson(first)).subscription).status, 'active')

    const replay = await fetch(`${baseUrl}/webhooks/billing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(replay.status, 200)
    assert.equal((await readJson(replay)).replayed, true)
    const audit = await fixture.store.listAuditEvents('tenant-1')
    assert.equal(audit.filter((event) => event.eventType === 'billing.webhook.processed').length, 1)
    assert.equal(
      audit.filter((event) => event.eventType === 'billing.subscription.created' || event.eventType === 'billing.subscription.updated').length,
      1,
    )
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP BYOK KMS refs require explicit deployer policy and validate without worker reveal', async () => {
  const defaultFixture = createFixture({
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
  const defaultBaseUrl = await defaultFixture.server.listen()
  try {
    const blocked = await fetch(`${defaultBaseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kmsRef: 'gcp-sm://projects/acme/secrets/anthropic/versions/latest' }),
    })
    assert.equal(blocked.status, 403)
    assert.match(JSON.stringify(await readJson(blocked)), /disabled/)
  } finally {
    await defaultFixture.server.close()
  }

  const fixture = createFixture({
    byokPolicy: {
      kmsRefs: {
        enabled: true,
        allowedPrefixes: ['gcp-sm://projects/acme/secrets/'],
      },
    },
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
    const envRef = await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kmsRef: 'env:OPEN_COWORK_BYOK_ANTHROPIC' }),
    })
    assert.equal(envRef.status, 403)
    assert.match(JSON.stringify(await readJson(envRef)), /Environment-backed/)

    const outsidePrefix = await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kmsRef: 'gcp-sm://projects/other/secrets/anthropic/versions/latest' }),
    })
    assert.equal(outsidePrefix.status, 403)
    assert.match(JSON.stringify(await readJson(outsidePrefix)), /not allowed/)

    const createResponse = await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kmsRef: 'gcp-sm://projects/acme/secrets/anthropic/versions/latest' }),
    })
    assert.equal(createResponse.status, 201)
    const created = await readJson(createResponse)
    assert.equal(asRecord(created.secret).status, 'pending_validation')
    assert.equal(asRecord(created.secret).credentialKind, 'kms_ref')
    assert.equal(JSON.stringify(created).includes('kmsRef'), false)

    const validateResponse = await fetch(`${baseUrl}/api/byok/anthropic/validate`, { method: 'POST' })
    assert.equal(validateResponse.status, 200)
    const validated = await readJson(validateResponse)
    assert.equal(validated.validated, false)
    assert.equal(asRecord(validated.secret).status, 'pending_validation')
    assert.equal(typeof asRecord(validated.secret).lastValidatedAt, 'string')
    assert.equal(JSON.stringify(validated).includes('kmsRef'), false)
  } finally {
    await fixture.server.close()
  }
})
