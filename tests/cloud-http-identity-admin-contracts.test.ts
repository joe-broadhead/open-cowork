import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { createApiTokenCloudAuthResolver } from '@open-cowork/cloud-server/app'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createCloudHttpServer } from '@open-cowork/cloud-server/http-server'
import { CloudSessionService, type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { FakeRuntimeAdapter, createFixture } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
  headerValue,
} from './helpers/cloud-http-test-support.ts'

test('cloud HTTP server authenticates bearer API tokens and rejects revoked tokens', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const account = store.createAccount({
    accountId: 'account-1',
    idpSubject: 'subject-1',
    email: 'member@example.test',
  })
  store.ensureUser({ tenantId: 'tenant-1', userId: account.accountId, email: account.email })
  store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'admin',
    status: 'active',
  })
  const issued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Desktop token',
    scopes: ['desktop'],
  })
  const desktopAdmin = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Desktop admin token',
    scopes: ['desktop', 'admin'],
  })

  const runtime = new FakeRuntimeAdapter()
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const service = new CloudSessionService(store, runtime, policy)
  const server = createCloudHttpServer({
    service,
    policy,
    auth: createApiTokenCloudAuthResolver(store),
    autoProcessCommands: true,
  })
  const baseUrl = await server.listen()
  try {
    const ok = await readJson(await fetch(`${baseUrl}/api/workspace`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    }))
    assert.equal(ok.tenantId, 'tenant-1')
    assert.equal(ok.userId, account.accountId)

    const desktopOnlyAdmin = await fetch(`${baseUrl}/api/admin/members`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    })
    assert.equal(desktopOnlyAdmin.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(desktopOnlyAdmin)).verdict).policyCode,
      'authorization.scope_required',
    )
    assert.equal((await fetch(`${baseUrl}/api/workspace`, {
      headers: { authorization: `Bearer ${desktopAdmin.plaintext}` },
    })).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/admin/members`, {
      headers: { authorization: `Bearer ${desktopAdmin.plaintext}` },
    })).status, 200)

    store.revokeApiToken({ tokenId: issued.token.tokenId })
    const rejected = await fetch(`${baseUrl}/api/workspace`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    })
    assert.equal(rejected.status, 401)
  } finally {
    await server.close()
  }
})
test('cloud HTTP server rejects user-bound admin API token privileges after role demotion', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const account = store.createAccount({
    accountId: 'account-1',
    idpSubject: 'subject-1',
    email: 'member@example.test',
  })
  store.ensureUser({ tenantId: 'tenant-1', userId: account.accountId, email: account.email })
  store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'admin',
    status: 'active',
  })
  const issued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Admin token',
    scopes: ['admin'],
  })

  const runtime = new FakeRuntimeAdapter()
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const service = new CloudSessionService(store, runtime, policy)
  const server = createCloudHttpServer({
    service,
    policy,
    auth: createApiTokenCloudAuthResolver(store),
    autoProcessCommands: true,
  })
  const baseUrl = await server.listen()
  const headers = { authorization: `Bearer ${issued.plaintext}` }
  try {
    const beforeDemotion = await fetch(`${baseUrl}/api/admin/members`, { headers })
    assert.equal(beforeDemotion.status, 200)

    store.upsertMembership({
      orgId: org.orgId,
      accountId: account.accountId,
      role: 'member',
      status: 'active',
    })

    const afterDemotion = await fetch(`${baseUrl}/api/admin/members`, { headers })
    assert.equal(afterDemotion.status, 403)

    const issueAfterDemotion = await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Blocked admin token', scopes: ['desktop'] }),
    })
    assert.equal(issueAfterDemotion.status, 403)
  } finally {
    await server.close()
  }
})

test('members:read grants the member directory without granting member or role mutation', async () => {
  const memberReader: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'member-reader-account',
    accountId: 'member-reader-account',
    email: 'member-reader@example.test',
    role: 'member',
    authSource: 'user',
  }
  const fixture = createFixture({ auth: async () => ({ ...memberReader }) })
  fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const org = fixture.store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  fixture.store.createCustomRole({
    orgId: org.orgId,
    roleKey: 'member-reader',
    name: 'Member reader',
    baseRole: 'member',
    permissions: ['members:read'],
  })
  const account = fixture.store.createAccount({
    accountId: memberReader.accountId!,
    idpSubject: 'member-reader-subject',
    email: memberReader.email!,
  })
  fixture.store.ensureUser({
    tenantId: 'tenant-1',
    userId: account.accountId,
    email: account.email,
    role: 'member',
  })
  fixture.store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'member',
    customRoleKey: 'member-reader',
    status: 'active',
  })

  const baseUrl = await fixture.server.listen()
  try {
    const membersResponse = await fetch(`${baseUrl}/api/admin/members`)
    const membersBody = await readJson(membersResponse)
    assert.equal(membersResponse.status, 200, JSON.stringify(membersBody))
    assert.equal(
      asArray(membersBody.members).some((member) => asRecord(member).accountId === account.accountId),
      true,
    )

    const inviteResponse = await fetch(`${baseUrl}/api/admin/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.test', role: 'member' }),
    })
    assert.equal(inviteResponse.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(inviteResponse)).verdict).policyCode,
      'authorization.principal_denied',
    )
    assert.equal((await fetch(`${baseUrl}/api/admin/roles`)).status, 403)
  } finally {
    await fixture.server.close()
  }
})

test('API token authentication hydrates custom roles and intersects permissions with token scope', async () => {
  let apiTokenAuth: ReturnType<typeof createApiTokenCloudAuthResolver> | undefined
  const fixture = createFixture({
    auth: (req) => {
      if (!apiTokenAuth) throw new Error('API token auth was not initialized.')
      return apiTokenAuth(req)
    },
  })
  fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const org = fixture.store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  fixture.store.createCustomRole({
    orgId: org.orgId,
    roleKey: 'restricted-admin',
    name: 'Restricted admin',
    baseRole: 'admin',
    permissions: ['sessions:read'],
  })
  fixture.store.createCustomRole({
    orgId: org.orgId,
    roleKey: 'channel-manager',
    name: 'Channel manager',
    baseRole: 'member',
    permissions: ['org:manage'],
  })
  fixture.store.createCustomRole({
    orgId: org.orgId,
    roleKey: 'operations-reader',
    name: 'Operations reader',
    baseRole: 'member',
    permissions: ['operations:view'],
  })
  fixture.store.createCustomRole({
    orgId: org.orgId,
    roleKey: 'diagnostics-reader',
    name: 'Diagnostics reader',
    baseRole: 'member',
    permissions: ['diagnostics:view'],
  })

  const restrictedAccount = fixture.store.createAccount({
    accountId: 'restricted-admin-account',
    idpSubject: 'restricted-admin-subject',
    email: 'restricted-admin@example.test',
  })
  fixture.store.ensureUser({
    tenantId: 'tenant-1',
    userId: restrictedAccount.accountId,
    email: restrictedAccount.email,
    role: 'admin',
  })
  fixture.store.upsertMembership({
    orgId: org.orgId,
    accountId: restrictedAccount.accountId,
    role: 'admin',
    customRoleKey: 'restricted-admin',
    status: 'active',
  })
  const restrictedToken = await fixture.store.issueApiToken({
    orgId: org.orgId,
    accountId: restrictedAccount.accountId,
    name: 'Restricted admin token',
    scopes: ['admin', 'operator'],
  })

  const delegatedAccount = fixture.store.createAccount({
    accountId: 'delegated-channel-account',
    idpSubject: 'delegated-channel-subject',
    email: 'delegated-channel@example.test',
  })
  fixture.store.ensureUser({
    tenantId: 'tenant-1',
    userId: delegatedAccount.accountId,
    email: delegatedAccount.email,
    role: 'member',
  })
  fixture.store.upsertMembership({
    orgId: org.orgId,
    accountId: delegatedAccount.accountId,
    role: 'member',
    customRoleKey: 'channel-manager',
    status: 'active',
  })
  const delegatedToken = await fixture.store.issueApiToken({
    orgId: org.orgId,
    accountId: delegatedAccount.accountId,
    name: 'Delegated channel token',
    scopes: ['admin'],
  })
  const delegatedOperatorTokens: Record<'operations' | 'diagnostics', string> = {
    operations: '',
    diagnostics: '',
  }
  for (const [kind, permissionRole] of [
    ['operations', 'operations-reader'],
    ['diagnostics', 'diagnostics-reader'],
  ] as const) {
    const account = fixture.store.createAccount({
      accountId: `${kind}-reader-account`,
      idpSubject: `${kind}-reader-subject`,
      email: `${kind}-reader@example.test`,
    })
    fixture.store.ensureUser({
      tenantId: 'tenant-1',
      userId: account.accountId,
      email: account.email,
      role: 'member',
    })
    fixture.store.upsertMembership({
      orgId: org.orgId,
      accountId: account.accountId,
      role: 'member',
      customRoleKey: permissionRole,
      status: 'active',
    })
    const issued = await fixture.store.issueApiToken({
      orgId: org.orgId,
      accountId: account.accountId,
      name: `${kind} reader token`,
      scopes: ['operator'],
    })
    delegatedOperatorTokens[kind] = issued.plaintext
  }
  apiTokenAuth = createApiTokenCloudAuthResolver(fixture.store)

  const baseUrl = await fixture.server.listen()
  const restrictedHeaders = {
    authorization: `Bearer ${restrictedToken.plaintext}`,
    'content-type': 'application/json',
  }
  const delegatedHeaders = {
    authorization: `Bearer ${delegatedToken.plaintext}`,
    'content-type': 'application/json',
  }
  try {
    for (const [path, body] of [
      ['/api/billing/checkout', { planKey: 'pro' }],
      ['/api/api-tokens', { name: 'forbidden nested token', scopes: ['desktop'] }],
      ['/api/channels/agents', { agentId: 'forbidden-agent', name: 'Forbidden agent', profileName: 'full' }],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: restrictedHeaders,
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 403, `restricted admin token must not access ${path}`)
    }

    const delegatedChannel = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: delegatedHeaders,
      body: JSON.stringify({
        agentId: 'delegated-agent',
        name: 'Delegated agent',
        profileName: 'full',
      }),
    })
    assert.equal(delegatedChannel.status, 201, JSON.stringify(await readJson(delegatedChannel)))

    for (const [path, body] of [
      ['/api/billing/checkout', { planKey: 'pro' }],
      ['/api/api-tokens', { name: 'forbidden nested token', scopes: ['desktop'] }],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: delegatedHeaders,
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 403, `channel permission must not grant ${path}`)
    }

    const operationsHeaders = { authorization: `Bearer ${delegatedOperatorTokens.operations}` }
    assert.equal((await fetch(`${baseUrl}/api/metrics`, { headers: operationsHeaders })).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/diagnostics`, { headers: operationsHeaders })).status, 403)

    const diagnosticsHeaders = { authorization: `Bearer ${delegatedOperatorTokens.diagnostics}` }
    const delegatedDiagnostics = await fetch(`${baseUrl}/api/diagnostics`, { headers: diagnosticsHeaders })
    assert.equal(delegatedDiagnostics.status, 200, await delegatedDiagnostics.text())
    assert.equal((await fetch(`${baseUrl}/api/metrics`, { headers: diagnosticsHeaders })).status, 403)

    assert.equal((await fetch(`${baseUrl}/api/metrics`, { headers: restrictedHeaders })).status, 403)
    assert.equal((await fetch(`${baseUrl}/api/diagnostics`, { headers: restrictedHeaders })).status, 403)
  } finally {
    await fixture.server.close()
  }
})

test('principal bootstrap fast-path skips redundant writes but still enforces the membership gate', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const bootstrapOrg = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const bootstrapAccount = store.createAccount({ accountId: 'account-1', idpSubject: 'subject-1', email: 'member@example.test' })
  store.ensureUser({ tenantId: 'tenant-1', userId: bootstrapAccount.accountId, email: bootstrapAccount.email })
  store.upsertMembership({ orgId: bootstrapOrg.orgId, accountId: bootstrapAccount.accountId, role: 'admin', status: 'active' })
  const service = new CloudSessionService(store, new FakeRuntimeAdapter(), resolveCloudRuntimePolicy(DEFAULT_CONFIG))

  // Count the bootstrap WRITES so we can prove the fast path skips them.
  let bootstrapWrites = 0
  const realCreateAccount = store.createAccount.bind(store)
  store.createAccount = ((input: Parameters<typeof realCreateAccount>[0]) => {
    bootstrapWrites += 1
    return realCreateAccount(input)
  }) as typeof store.createAccount

  const principal = (): CloudPrincipal => ({
    tenantId: 'tenant-1',
    orgId: bootstrapOrg.orgId,
    tenantName: 'Tenant 1',
    userId: bootstrapAccount.accountId,
    accountId: bootstrapAccount.accountId,
    email: bootstrapAccount.email,
    role: 'admin',
    authSource: 'api_token',
    tokenId: 'token-1',
  })

  await service.ensurePrincipal(principal()) // first call bootstraps (writes)
  await service.ensurePrincipal(principal()) // second call takes the fast path (no writes)
  assert.equal(bootstrapWrites, 1, 'the second request reused the bootstrap and skipped the idempotent writes')

  // Suspend the membership AFTER bootstrap. The gate must still fire on the next
  // request even though the principal is cached as bootstrapped — the fast path
  // re-reads membership status every request, so there is no revocation window.
  store.upsertMembership({ orgId: bootstrapOrg.orgId, accountId: bootstrapAccount.accountId, role: 'admin', status: 'suspended' })
  await assert.rejects(() => service.ensurePrincipal(principal()), /membership is not active/i)
})

test('cloud HTTP server keeps gateway-scoped tokens out of desktop API routes', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const account = store.createAccount({
    accountId: 'account-1',
    idpSubject: 'subject-1',
    email: 'member@example.test',
  })
  store.ensureUser({ tenantId: 'tenant-1', userId: account.accountId, email: account.email })
  store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'admin',
    status: 'active',
  })
  const issued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Gateway token',
    scopes: ['gateway'],
  })
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const service = new CloudSessionService(store, new FakeRuntimeAdapter(), policy)
  const server = createCloudHttpServer({
    service,
    policy,
    auth: createApiTokenCloudAuthResolver(store),
    autoProcessCommands: true,
  })
  const baseUrl = await server.listen()
  try {
    const workspace = await fetch(`${baseUrl}/api/workspace`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    })
    assert.equal(workspace.status, 403)

    const channelDeliveries = await fetch(`${baseUrl}/api/channels/deliveries`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    })
    assert.equal(channelDeliveries.status, 403)

    store.createSession({
      tenantId: 'tenant-1',
      userId: account.accountId,
      sessionId: 'gateway-readable-session',
      opencodeSessionId: 'gateway-readable-opencode-session',
      profileName: 'full',
    })
    const session = await fetch(`${baseUrl}/api/sessions/gateway-readable-session`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    })
    assert.equal(session.status, 403)

    const sessionList = await fetch(`${baseUrl}/api/sessions`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    })
    assert.equal(sessionList.status, 403)

    const createSession = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(createSession.status, 403)

    const prompt = await fetch(`${baseUrl}/api/sessions/gateway-readable-session/prompt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'blocked' }),
    })
    assert.equal(prompt.status, 403)
  } finally {
    await server.close()
  }
})

test('cloud HTTP tenant isolation fails closed for sessions, artifacts, BYOK, and usage APIs', async () => {
  const tenantOneByokFixture = 'credential-tenant-one-1234567890'
  const tenant1Principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner1@example.test',
    role: 'owner' as const,
    authSource: 'user' as const,
  }
  const tenant2Principal = {
    tenantId: 'tenant-2',
    tenantName: 'Tenant 2',
    orgId: 'tenant-2',
    userId: 'owner-2',
    accountId: 'owner-2',
    email: 'owner2@example.test',
    role: 'owner' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-tenant']) === 'tenant-2' ? tenant2Principal : tenant1Principal,
  })
  const baseUrl = await fixture.server.listen()
  const tenant2Headers = { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' }
  try {
    await fixture.service.ensurePrincipal(tenant1Principal)
    await fixture.service.ensurePrincipal(tenant2Principal)
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const uploaded = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'private.txt',
        dataBase64: Buffer.from('tenant one').toString('base64'),
      }),
    }))
    const artifactId = String(asRecord(uploaded.artifact).artifactId)
    await fetch(`${baseUrl}/api/byok/anthropic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: tenantOneByokFixture }),
    })
    await fixture.store.recordUsageEvent({
      orgId: 'tenant-1',
      accountId: 'owner-1',
      eventType: 'prompt.enqueued',
      unit: 'count',
      quantity: 1,
    })

    for (const path of [
      `/api/sessions/${sessionId}`,
      `/api/sessions/${sessionId}/view`,
      `/api/sessions/${sessionId}/artifacts`,
      `/api/sessions/${sessionId}/artifacts/${artifactId}`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: tenant2Headers })
      assert.equal(response.status, 404)
    }
    const tenant2Prompt = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: tenant2Headers,
      body: JSON.stringify({ text: 'steal' }),
    })
    assert.equal(tenant2Prompt.status, 404)

    const tenant2Byok = await readJson(await fetch(`${baseUrl}/api/byok`, { headers: tenant2Headers }))
    assert.deepEqual(asArray(tenant2Byok.secrets), [])
    const tenant2Usage = await readJson(await fetch(`${baseUrl}/api/usage/events`, { headers: tenant2Headers }))
    assert.deepEqual(asArray(tenant2Usage.events), [])
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP API token issuance applies default and maximum expirations', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const issued = await readJson(await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Gateway token', scopes: ['gateway'] }),
    }))
    const token = asRecord(issued.token)
    assert.equal(typeof token.expiresAt, 'string')
    const expiresAt = Date.parse(String(token.expiresAt))
    assert.equal(Number.isFinite(expiresAt), true)
    assert.equal(expiresAt > Date.now(), true)

    const tooLong = await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Too long',
        scopes: ['gateway'],
        expiresAt: new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    })
    assert.equal(tooLong.status, 400)

    const malformed = await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Malformed',
        scopes: ['gateway'],
        expiresAt: 'not-a-date',
      }),
    })
    assert.equal(malformed.status, 400)
    assert.match(String((await readJson(malformed)).error), /valid ISO timestamp/)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP API token issuance obeys configured TTL and scope policy', async () => {
  const fixture = createFixture({
    identityPolicy: {
      allowSelfServiceSignup: true,
      apiTokenDefaultTtlMs: 2 * 24 * 60 * 60 * 1000,
      apiTokenMaxTtlMs: 3 * 24 * 60 * 60 * 1000,
      apiTokenAllowedScopes: ['desktop'],
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const issued = await readJson(await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Desktop token', scopes: ['desktop'] }),
    }))
    const token = asRecord(issued.token)
    const ttlMs = Date.parse(String(token.expiresAt)) - Date.now()
    assert.equal(ttlMs > 24 * 60 * 60 * 1000, true)
    assert.equal(ttlMs < 3 * 24 * 60 * 60 * 1000, true)

    const disallowedScope = await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Gateway token', scopes: ['gateway'] }),
    })
    assert.equal(disallowedScope.status, 403)

    const tooLong = await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Too long',
        scopes: ['desktop'],
        expiresAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    })
    assert.equal(tooLong.status, 400)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP self-service mode requires an active invited membership when disabled', async () => {
  const principal = {
    tenantId: 'tenant-1',
    orgId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'invited-1',
    accountId: 'invited-1',
    email: 'invited@example.test',
    role: 'member' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({
    auth: () => principal,
    identityPolicy: { allowSelfServiceSignup: false },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const missingInvite = await fetch(`${baseUrl}/api/workspace`)
    assert.equal(missingInvite.status, 403)

    fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
    const org = fixture.store.ensureOrgForTenant({ tenantId: 'tenant-1', orgId: 'tenant-1', name: 'Tenant 1' })
    fixture.store.ensureUser({ tenantId: 'tenant-1', userId: 'invited-1', email: 'invited@example.test' })
    fixture.store.createAccount({ accountId: 'invited-1', idpSubject: 'invited-1', email: 'invited@example.test' })
    fixture.store.upsertMembership({
      orgId: org.orgId,
      accountId: 'invited-1',
      role: 'member',
      status: 'pending',
    })
    const pendingInvite = await fetch(`${baseUrl}/api/workspace`)
    assert.equal(pendingInvite.status, 403)

    fixture.store.upsertMembership({
      orgId: org.orgId,
      accountId: 'invited-1',
      role: 'member',
      status: 'invited',
    })
    const invitedAccepted = await readJson(await fetch(`${baseUrl}/api/workspace`))
    assert.equal(invitedAccepted.orgId, 'tenant-1')
    assert.equal(invitedAccepted.accountId, 'invited-1')
    assert.equal(fixture.store.resolvePrincipalMembership({
      tenantId: 'tenant-1',
      accountId: 'invited-1',
    })?.membership.status, 'active')

    fixture.store.upsertMembership({
      orgId: org.orgId,
      accountId: 'invited-1',
      role: 'member',
      status: 'active',
    })
    const accepted = await readJson(await fetch(`${baseUrl}/api/workspace`))
    assert.equal(accepted.orgId, 'tenant-1')
    assert.equal(accepted.accountId, 'invited-1')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP worker status endpoints require operator privileges', async () => {
  const memberPrincipal = {
    tenantId: 'tenant-1',
    orgId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'member-1',
    accountId: 'member-1',
    email: 'member@example.test',
    role: 'member' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({ auth: () => memberPrincipal })
  const baseUrl = await fixture.server.listen()
  try {
    await fixture.service.ensurePrincipal(memberPrincipal)
    const response = await fetch(`${baseUrl}/api/workers/heartbeats`)
    assert.equal(response.status, 403)
    const runtimeStatus = await fetch(`${baseUrl}/api/runtime/status`)
    assert.equal(runtimeStatus.status, 403)
    const diagnostics = await fetch(`${baseUrl}/api/diagnostics`)
    assert.equal(diagnostics.status, 403)
    const workerPrincipal = {
      tenantId: 'tenant-1',
      orgId: 'tenant-1',
      tenantName: 'Tenant 1',
      userId: 'worker-token',
      accountId: 'worker-token',
      email: 'worker@example.test',
      role: 'member' as const,
      authSource: 'api_token' as const,
      tokenScopes: ['worker-internal' as const],
    }
    assert.equal((await fixture.service.listWorkerHeartbeats(workerPrincipal)).length, 0)
    await assert.rejects(
      () => fixture.service.domains.diagnostics.getDiagnosticsBundle(workerPrincipal),
      /Cloud diagnostics require operator/,
    )
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server auto-provisions workspace and exposes one-time API token issuance', async () => {
  const ownerPrincipal = {
    tenantId: 'tenant-1',
    orgId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner' as const,
    authSource: 'user' as const,
  }
  let fixture: ReturnType<typeof createFixture>
  fixture = createFixture({
    auth: (req) => {
      const authorization = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0] || ''
        : req.headers.authorization || ''
      return authorization.startsWith('Bearer ')
        ? createApiTokenCloudAuthResolver(fixture.store)(req)
        : ownerPrincipal
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const workspace = await readJson(await fetch(`${baseUrl}/api/workspace`))
    assert.equal(workspace.orgId, 'tenant-1')
    assert.equal(workspace.accountId, 'owner-1')
    assert.equal(workspace.role, 'owner')
    assert.equal(fixture.store.resolvePrincipalMembership({
      tenantId: 'tenant-1',
      accountId: 'owner-1',
    })?.membership.status, 'active')

    const invalidScope = await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad token', scopes: ['desktop', 'unknown'] }),
    })
    assert.equal(invalidScope.status, 400)

    const issuedResponse = await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Desktop token', scopes: ['desktop'] }),
    })
    assert.equal(issuedResponse.status, 201)
    const issued = await readJson(issuedResponse)
    assert.match(String(issued.plaintext), /^occ_/)
    assert.equal('tokenHash' in asRecord(issued.token), false)

    const listed = await readJson(await fetch(`${baseUrl}/api/api-tokens`))
    const token = asRecord(asArray(listed.tokens)[0])
    assert.equal(token.name, 'Desktop token')
    assert.equal('plaintext' in token, false)
    assert.equal('tokenHash' in token, false)

    const bearerWorkspace = await readJson(await fetch(`${baseUrl}/api/workspace`, {
      headers: { authorization: `Bearer ${String(issued.plaintext)}` },
    }))
    assert.equal(bearerWorkspace.orgId, 'tenant-1')

    const revoke = await fetch(`${baseUrl}/api/api-tokens/${encodeURIComponent(String(token.tokenId))}`, {
      method: 'DELETE',
    })
    assert.equal(revoke.status, 200)
    const revoked = await readJson(revoke)
    assert.equal(asRecord(revoked.token).revokedAt !== null, true)

    const rejected = await fetch(`${baseUrl}/api/workspace`, {
      headers: { authorization: `Bearer ${String(issued.plaintext)}` },
    })
    assert.equal(rejected.status, 401)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server prevents member-only users from API token administration', async () => {
  const fixture = createFixture({
    auth: () => ({
      tenantId: 'tenant-1',
      orgId: 'tenant-1',
      tenantName: 'Tenant 1',
      userId: 'member-1',
      accountId: 'member-1',
      email: 'member@example.test',
      role: 'member',
      authSource: 'user',
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    await readJson(await fetch(`${baseUrl}/api/workspace`))
    const response = await fetch(`${baseUrl}/api/api-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Blocked token', scopes: ['desktop'] }),
    })
    assert.equal(response.status, 403)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP admin APIs manage invited members and expose redacted audit', async () => {
  const fixture = createFixture({
    identityPolicy: {
      allowSelfServiceSignup: false,
      signupMode: 'invite',
      allowedEmailDomains: ['example.test'],
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const policy = asRecord((await readJson(await fetch(`${baseUrl}/api/admin/policy`))).policy)
    assert.equal(asRecord(policy.signup).mode, 'invite')
    assert.deepEqual(asRecord(policy.signup).allowedEmailDomains, ['example.test'])
    assert.equal(asRecord(policy.runtime).machineRuntimeConfig, 'disabled')

    const initialMembers = asArray((await readJson(await fetch(`${baseUrl}/api/admin/members`))).members)
    assert.equal(initialMembers.some((entry) => asRecord(entry).email === 'user@example.test'), true)

    const invitedResponse = await fetch(`${baseUrl}/api/admin/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.test', role: 'admin' }),
    })
    assert.equal(invitedResponse.status, 201)
    const invited = asRecord((await readJson(invitedResponse)).member)
    assert.equal(invited.email, 'invitee@example.test')
    assert.equal(invited.role, 'admin')
    assert.equal(invited.status, 'invited')

    const listed = asArray((await readJson(await fetch(`${baseUrl}/api/admin/members?q=invitee`))).members)
    assert.equal(listed.length, 1)

    const accountId = String(invited.accountId)
    const missingConfirm = await fetch(`${baseUrl}/api/admin/members/${encodeURIComponent(accountId)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    assert.equal(missingConfirm.status, 400)

    const disabled = await readJson(await fetch(`${baseUrl}/api/admin/members/${encodeURIComponent(accountId)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled', confirm: accountId }),
    }))
    assert.equal(asRecord(disabled.member).status, 'disabled')

    const audit = asArray((await readJson(await fetch(`${baseUrl}/api/admin/audit?limit=50`))).events)
    const auditText = JSON.stringify(audit)
    assert.match(auditText, /membership\.created/)
    assert.match(auditText, /membership\.updated/)
    assert.equal(auditText.includes('occ_'), false)
    assert.equal(auditText.includes('sk-'), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP issues a signed team invite, emails it, and accepts it via the public endpoint', async () => {
  const emails: Array<{ to: string, subject: string }> = []
  const fixture = createFixture({
    identityPolicy: { allowSelfServiceSignup: false, signupMode: 'invite', allowedEmailDomains: ['example.test'] },
    inviteSigningSecret: 'cloud-http-invite-signing-secret-key',
    emailSender: { send: async (message) => { emails.push({ to: message.to, subject: message.subject }) } },
  })
  const baseUrl = await fixture.server.listen()
  try {
    // Admin invites → response carries a single-use invite token + expiry, and the email seam fires.
    const invitedResponse = await fetch(`${baseUrl}/api/admin/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.test', role: 'member' }),
    })
    assert.equal(invitedResponse.status, 201)
    const invitedBody = asRecord(await readJson(invitedResponse))
    assert.equal(asRecord(invitedBody.member).status, 'invited')
    const token = String(invitedBody.inviteToken)
    assert.ok(token.length > 0)
    assert.equal(typeof invitedBody.inviteExpiresAt, 'string')
    assert.deepEqual(emails, [{ to: 'invitee@example.test', subject: 'You have been invited to a team' }])

    // The public, pre-auth accept endpoint activates the membership (the token is the credential).
    const acceptResponse = await fetch(`${baseUrl}/api/invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    assert.equal(acceptResponse.status, 200)
    assert.equal(asRecord(asRecord(await readJson(acceptResponse)).membership).status, 'active')

    // The member now shows active in the admin list.
    const members = asArray((await readJson(await fetch(`${baseUrl}/api/admin/members?q=invitee`))).members)
    assert.equal(asRecord(members[0]).status, 'active')

    // Accepting again is idempotent; a garbage token is rejected.
    assert.equal((await fetch(`${baseUrl}/api/invites/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    })).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/invites/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'not-a-valid-token' }),
    })).status, 400)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects an invite accept after the membership is revoked', async () => {
  const fixture = createFixture({
    identityPolicy: { allowSelfServiceSignup: false, signupMode: 'invite', allowedEmailDomains: ['example.test'] },
    inviteSigningSecret: 'cloud-http-invite-signing-secret-key',
  })
  const baseUrl = await fixture.server.listen()
  try {
    const invitedBody = asRecord(await readJson(await fetch(`${baseUrl}/api/admin/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'revoked@example.test', role: 'member' }),
    })))
    const token = String(invitedBody.inviteToken)
    const accountId = String(asRecord(invitedBody.member).accountId)

    // Admin revokes (disables) the invited membership before it is accepted.
    await fetch(`${baseUrl}/api/admin/members/${encodeURIComponent(accountId)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled', confirm: accountId }),
    })

    const accept = await fetch(`${baseUrl}/api/invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    assert.equal(accept.status, 403)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP admin APIs manage managed worker lifecycle and worker heartbeat auth', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    await readJson(await fetch(`${baseUrl}/api/workspace`))
    fixture.store.createTenant({ tenantId: 'tenant-2', name: 'Tenant 2' })
    fixture.store.ensureOrgForTenant({ tenantId: 'tenant-2', name: 'Tenant 2' })

    const poolResponse = await fetch(`${baseUrl}/api/admin/worker-pools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        poolId: 'pool-1',
        tenantId: 'tenant-2',
        name: 'Internal pool',
        mode: 'self_hosted',
        capabilities: { profiles: ['default'] },
        maxWorkers: 2,
        maxConcurrentWork: 1,
      }),
    })
    assert.equal(poolResponse.status, 201)
    const createdPool = asRecord(asRecord(await readJson(poolResponse)).pool)
    assert.equal(createdPool.poolId, 'pool-1')
    assert.equal(createdPool.tenantId, 'tenant-1')

    const unsupportedPool = await fetch(`${baseUrl}/api/admin/worker-pools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'External pool', mode: 'customer_hosted' }),
    })
    assert.equal(unsupportedPool.status, 400)

    const workerResponse = await fetch(`${baseUrl}/api/admin/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: 'worker-1',
        poolId: 'pool-1',
        tenantId: 'tenant-2',
        displayName: 'Worker one',
      }),
    })
    assert.equal(workerResponse.status, 201)
    const createdWorker = asRecord(asRecord(await readJson(workerResponse)).worker)
    assert.equal(createdWorker.status, 'pending')
    assert.equal(createdWorker.tenantId, 'tenant-1')

    const secondWorkerResponse = await fetch(`${baseUrl}/api/admin/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: 'worker-2',
        poolId: 'pool-1',
        displayName: 'Worker two',
      }),
    })
    assert.equal(secondWorkerResponse.status, 201)
    const overCapacityWorker = await fetch(`${baseUrl}/api/admin/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: 'worker-3',
        poolId: 'pool-1',
        displayName: 'Worker three',
      }),
    })
    assert.equal(overCapacityWorker.status, 429)

    const invalidDrain = await fetch(`${baseUrl}/api/admin/workers/worker-1/drain`, { method: 'POST' })
    assert.equal(invalidDrain.status, 400)

    const active = await fetch(`${baseUrl}/api/admin/workers/worker-1/activate`, { method: 'POST' })
    assert.equal(active.status, 200)
    assert.equal(asRecord(asRecord(await readJson(active)).worker).status, 'active')

    const credentialResponse = await fetch(`${baseUrl}/api/admin/workers/worker-1/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: ['heartbeat'] }),
    })
    assert.equal(credentialResponse.status, 201)
    const issued = asRecord(asRecord(await readJson(credentialResponse)).credential)
    const credential = asRecord(issued.credential)
    const plaintext = String(issued.plaintext)
    assert.match(plaintext, /^ocw_/)
    assert.equal(JSON.stringify(credential).includes('tokenHash'), false)

    const heartbeatResponse = await fetch(`${baseUrl}/api/workers/worker-1/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.0',
        currentLoad: 1,
        activeWorkIds: ['cmd-1'],
      }),
    })
    assert.equal(heartbeatResponse.status, 200)
    assert.equal(asRecord(asRecord(await readJson(heartbeatResponse)).heartbeat).currentLoad, 1)

    const overCapacityHeartbeat = await fetch(`${baseUrl}/api/workers/worker-1/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.0',
        currentLoad: 2,
      }),
    })
    assert.equal(overCapacityHeartbeat.status, 429)

    const blockedAdmin = await fetch(`${baseUrl}/api/admin/worker-pools`, {
      headers: { authorization: `Bearer ${plaintext}` },
    })
    assert.equal(blockedAdmin.status, 403)

    const listedHeartbeats = asArray((await readJson(await fetch(`${baseUrl}/api/admin/workers/worker-1/heartbeats`))).heartbeats)
    assert.equal(listedHeartbeats.length, 1)

    const revokeCredential = await fetch(`${baseUrl}/api/admin/workers/worker-1/credentials/${encodeURIComponent(String(credential.credentialId))}/revoke`, {
      method: 'POST',
    })
    assert.equal(revokeCredential.status, 200)
    const rejectedHeartbeat = await fetch(`${baseUrl}/api/workers/worker-1/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ version: '1.0.1' }),
    })
    assert.equal(rejectedHeartbeat.status, 401)

    const audit = asArray((await readJson(await fetch(`${baseUrl}/api/admin/audit?limit=100`))).events)
    const auditText = JSON.stringify(audit)
    assert.match(auditText, /managed_worker_pool\.created/)
    assert.match(auditText, /managed_worker_credential\.revoked/)
    assert.equal(auditText.includes(plaintext), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP admin APIs give built-in members their read-only policy and directory access', async () => {
  const memberPrincipal = {
    tenantId: 'tenant-1',
    orgId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'member-1',
    accountId: 'member-1',
    email: 'member@example.test',
    role: 'member' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({ auth: () => memberPrincipal })
  const baseUrl = await fixture.server.listen()
  try {
    await readJson(await fetch(`${baseUrl}/api/workspace`))
    const policy = await fetch(`${baseUrl}/api/admin/policy`)
    assert.equal(policy.status, 200)
    const members = await fetch(`${baseUrl}/api/admin/members`)
    assert.equal(members.status, 200)
    const audit = await fetch(`${baseUrl}/api/admin/audit`)
    assert.equal(audit.status, 403)
    const invite = await fetch(`${baseUrl}/api/admin/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'blocked@example.test', role: 'member' }),
    })
    assert.equal(invite.status, 403)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP admin APIs protect owner membership changes', async () => {
  const adminPrincipal = {
    tenantId: 'tenant-1',
    orgId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'admin-1',
    accountId: 'admin-1',
    email: 'admin@example.test',
    role: 'admin' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({ auth: () => adminPrincipal })
  const baseUrl = await fixture.server.listen()
  try {
    await readJson(await fetch(`${baseUrl}/api/workspace`))
    fixture.store.createAccount({
      accountId: 'owner-1',
      idpSubject: 'owner-subject',
      email: 'owner@example.test',
    })
    fixture.store.upsertMembership({
      orgId: 'tenant-1',
      accountId: 'owner-1',
      role: 'owner',
      status: 'active',
    })

    const demoteOwner = await fetch(`${baseUrl}/api/admin/members/owner-1/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    })
    assert.equal(demoteOwner.status, 403)

    const selfDemote = await fetch(`${baseUrl}/api/admin/members/admin-1/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    })
    assert.equal(selfDemote.status, 400)
  } finally {
    await fixture.server.close()
  }
})
