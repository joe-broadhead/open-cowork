import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { createStubBillingAdapter } from '@open-cowork/cloud-server/stub-billing-adapter'
import type {
  CloudLogRecord,
  CloudMetricRecord,
  CloudObservabilityAdapter,
} from '@open-cowork/cloud-server/observability'
import type { CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import { asArray, asRecord, readJson, testBillingConfig } from './helpers/cloud-http-test-support.ts'

test('chat=false denies every interactive HTTP and SSE session action before body parsing or resource lookup', async () => {
  const defaultPolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...defaultPolicy,
      features: {
        ...defaultPolicy.features,
        chat: false,
      },
    },
  })
  await fixture.service.ensurePrincipal({
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user@example.test',
    role: 'owner',
    authSource: 'local',
  })
  fixture.store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'existing-session',
    opencodeSessionId: 'existing-opencode-session',
    profileName: 'full',
  })
  const baseUrl = await fixture.server.listen()

  const requests: Array<{ label: string, path: string, method?: string, body?: string }> = [
    { label: 'import', path: '/api/import/sessions', method: 'POST', body: '{invalid-json' },
    { label: 'list', path: '/api/sessions' },
    { label: 'create', path: '/api/sessions', method: 'POST', body: '{invalid-json' },
    { label: 'get existing', path: '/api/sessions/existing-session' },
    { label: 'get absent', path: '/api/sessions/absent-session' },
    { label: 'activate', path: '/api/sessions/existing-session/activate', method: 'POST', body: '{invalid-json' },
    { label: 'view existing', path: '/api/sessions/existing-session/view' },
    { label: 'view absent', path: '/api/sessions/absent-session/view' },
    { label: 'workspace SSE', path: '/api/events' },
    { label: 'SSE existing', path: '/api/sessions/existing-session/events' },
    { label: 'SSE absent', path: '/api/sessions/absent-session/events' },
    { label: 'prompt', path: '/api/sessions/existing-session/prompt', method: 'POST', body: '{invalid-json' },
    { label: 'abort', path: '/api/sessions/existing-session/abort', method: 'POST', body: '{invalid-json' },
    { label: 'question reply', path: '/api/sessions/existing-session/question-reply', method: 'POST', body: '{invalid-json' },
    { label: 'question reject', path: '/api/sessions/existing-session/question-reject', method: 'POST', body: '{invalid-json' },
    { label: 'permission response', path: '/api/sessions/existing-session/permission-respond', method: 'POST', body: '{invalid-json' },
  ]

  try {
    for (const request of requests) {
      const response = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers: request.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: request.body,
      })
      assert.equal(response.status, 403, request.label)
      assert.doesNotMatch(response.headers.get('content-type') || '', /text\/event-stream/, request.label)
      const payload = asRecord(await readJson(response))
      assert.equal(payload.error, 'Chat is disabled for this cloud profile.', request.label)
      assert.equal(asRecord(payload.verdict).policyCode, 'chat.disabled', request.label)
    }
    assert.deepEqual(fixture.runtime.prompts, [])
    assert.deepEqual(fixture.runtime.aborted, [])
    assert.deepEqual(fixture.runtime.questionReplies, [])
    assert.deepEqual(fixture.runtime.questionRejects, [])
    assert.deepEqual(fixture.runtime.permissions, [])
    assert.equal((await fetch(`${baseUrl}/api/sessions/existing-session/projection-status`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/sessions/existing-session/projection-repair`, { method: 'POST' })).status, 200)
  } finally {
    await fixture.server.close()
  }
})

test('unknown and feature-disabled routes perform no principal bootstrap before denial', async () => {
  const defaultPolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...defaultPolicy,
      features: {
        ...defaultPolicy.features,
        chat: false,
        channels: false,
        byok: false,
      },
    },
    auth: async () => ({
      tenantId: 'unbootstrapped-tenant',
      tenantName: 'Unbootstrapped tenant',
      orgId: 'unbootstrapped-tenant',
      userId: 'unbootstrapped-user',
      accountId: 'unbootstrapped-user',
      email: 'unbootstrapped@example.test',
      role: 'member',
      authSource: 'user',
    }),
  })
  let bootstrapWrites = 0
  let membershipReads = 0
  const createTenant = fixture.store.createTenant.bind(fixture.store)
  const ensureOrgForTenant = fixture.store.ensureOrgForTenant.bind(fixture.store)
  const createAccount = fixture.store.createAccount.bind(fixture.store)
  const ensureUser = fixture.store.ensureUser.bind(fixture.store)
  const upsertMembership = fixture.store.upsertMembership.bind(fixture.store)
  const resolvePrincipalMembership = fixture.store.resolvePrincipalMembership.bind(fixture.store)
  fixture.store.createTenant = (input) => {
    bootstrapWrites += 1
    return createTenant(input)
  }
  fixture.store.ensureOrgForTenant = (input) => {
    bootstrapWrites += 1
    return ensureOrgForTenant(input)
  }
  fixture.store.createAccount = (input) => {
    bootstrapWrites += 1
    return createAccount(input)
  }
  fixture.store.ensureUser = (input) => {
    bootstrapWrites += 1
    return ensureUser(input)
  }
  fixture.store.upsertMembership = (input) => {
    bootstrapWrites += 1
    return upsertMembership(input)
  }
  fixture.store.resolvePrincipalMembership = (input) => {
    membershipReads += 1
    return resolvePrincipalMembership(input)
  }

  const baseUrl = await fixture.server.listen()
  try {
    const unknown = await fetch(`${baseUrl}/api/sessions/private-session/events/extra`)
    assert.equal(unknown.status, 403)
    assert.equal(asRecord(asRecord(await readJson(unknown)).verdict).policyCode, 'authorization.action_unknown')

    const disabled = await fetch(`${baseUrl}/api/sessions/private-session`)
    assert.equal(disabled.status, 403)
    assert.equal(asRecord(asRecord(await readJson(disabled)).verdict).policyCode, 'chat.disabled')

    const disabledChannelAdmin = await fetch(`${baseUrl}/api/channels/agents`)
    assert.equal(disabledChannelAdmin.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(disabledChannelAdmin)).verdict).policyCode,
      'channels.disabled',
    )

    const disabledByokAdmin = await fetch(`${baseUrl}/api/byok`)
    assert.equal(disabledByokAdmin.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(disabledByokAdmin)).verdict).policyCode,
      'byok.disabled',
    )

    assert.equal(bootstrapWrites, 0)
    assert.equal(membershipReads, 0)
  } finally {
    await fixture.server.close()
  }
})

test('mixed service tokens compose per action while gateway routes remain binding-scoped', async () => {
  const gatewayPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'gateway-account',
    accountId: 'gateway-account',
    email: 'gateway@example.test',
    role: 'admin' as const,
    authSource: 'api_token' as const,
    tokenId: 'gateway-token',
    tokenScopes: ['gateway', 'desktop'] as Array<'gateway' | 'desktop'>,
  }
  const fixture = createFixture({ auth: async () => gatewayPrincipal })
  await fixture.service.ensurePrincipal(gatewayPrincipal)
  const issued = await fixture.store.issueApiToken({
    orgId: 'tenant-1',
    accountId: 'gateway-account',
    name: 'Mixed gateway and desktop token',
    scopes: ['gateway', 'desktop'],
  })
  gatewayPrincipal.tokenId = issued.token.tokenId
  fixture.store.createHeadlessAgent({
    agentId: 'gateway-agent',
    orgId: 'tenant-1',
    tenantId: 'tenant-1',
    profileName: 'full',
    name: 'Gateway agent',
  })
  fixture.store.createChannelBinding({
    bindingId: 'gateway-binding',
    orgId: 'tenant-1',
    agentId: 'gateway-agent',
    provider: 'telegram',
    externalWorkspaceId: 'gateway-workspace',
    displayName: 'Gateway binding',
  })
  fixture.store.grantApiTokenChannelBinding({
    orgId: 'tenant-1',
    tokenId: issued.token.tokenId,
    channelBindingId: 'gateway-binding',
  })
  fixture.store.createSession({
    tenantId: 'tenant-1',
    userId: 'gateway-account',
    sessionId: 'session-1',
    opencodeSessionId: 'opencode-session-1',
    profileName: 'full',
  })
  const baseUrl = await fixture.server.listen()
  try {
    assert.equal((await fetch(`${baseUrl}/api/sessions`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/sessions/session-1`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/workflows`)).status, 200)

    const channelResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelBindingId: 'gateway-binding',
        provider: 'telegram',
        externalWorkspaceId: 'gateway-workspace',
        externalUserId: 'gateway-user',
      }),
    })
    const channelBody = await readJson(channelResponse)
    assert.equal(channelResponse.status, 200, JSON.stringify(channelBody))
    assert.equal(asRecord(channelBody.identity).externalUserId, 'gateway-user')
  } finally {
    await fixture.server.close()
  }
})

test('gateway plus admin scope can bootstrap Channels without weakening gateway binding checks', async () => {
  const gatewayPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'gateway-admin-account',
    accountId: 'gateway-admin-account',
    email: 'gateway-admin@example.test',
    role: 'admin' as const,
    authSource: 'api_token' as const,
    tokenId: '',
    tokenScopes: ['gateway', 'admin'] as Array<'gateway' | 'admin'>,
  }
  const fixture = createFixture({ auth: async () => ({ ...gatewayPrincipal }) })
  await fixture.service.ensurePrincipal({
    ...gatewayPrincipal,
    authSource: 'local',
    tokenId: undefined,
    tokenScopes: undefined,
  })
  const issued = await fixture.store.issueApiToken({
    orgId: 'tenant-1',
    accountId: 'gateway-admin-account',
    name: 'Gateway bootstrap admin',
    scopes: ['gateway', 'admin'],
  })
  gatewayPrincipal.tokenId = issued.token.tokenId
  const baseUrl = await fixture.server.listen()
  try {
    assert.equal((await fetch(`${baseUrl}/api/channels/agents`)).status, 200)
    const identityBootstrap = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'cli',
        externalUserId: 'pre-binding-user',
        accountId: 'gateway-admin-account',
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(identityBootstrap.status, 200, JSON.stringify(await readJson(identityBootstrap)))
    const deniedGatewayRoute = await fetch(`${baseUrl}/api/channels/sessions/absent/snapshot`)
    assert.equal(deniedGatewayRoute.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(deniedGatewayRoute)).verdict).policyCode,
      'channels.binding_scope_required',
    )
  } finally {
    await fixture.server.close()
  }
})

test('human channel admins can resolve identities and operate deliveries without gaining gateway delivery access', async () => {
  const owner: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'channel-owner',
    accountId: 'channel-owner',
    email: 'channel-owner@example.test',
    role: 'owner',
    authSource: 'user',
  }
  const member: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'channel-member',
    accountId: 'channel-member',
    email: 'channel-member@example.test',
    role: 'member',
    authSource: 'user',
  }
  let activePrincipal: CloudPrincipal = owner
  const fixture = createFixture({ auth: async () => ({ ...activePrincipal }) })
  for (const principal of [owner, member]) {
    await fixture.service.ensurePrincipal({ ...principal, authSource: 'local' })
  }
  fixture.store.createHeadlessAgent({
    agentId: 'browser-agent',
    orgId: 'tenant-1',
    tenantId: 'tenant-1',
    profileName: 'full',
    name: 'Browser agent',
  })
  fixture.store.createChannelBinding({
    bindingId: 'browser-binding',
    orgId: 'tenant-1',
    agentId: 'browser-agent',
    provider: 'cli',
    displayName: 'Browser binding',
  })
  fixture.store.createChannelDelivery({
    deliveryId: 'browser-delivery',
    orgId: 'tenant-1',
    agentId: 'browser-agent',
    channelBindingId: 'browser-binding',
    provider: 'cli',
    target: { externalChatId: 'browser-chat' },
    eventType: 'workflow.completed',
    payload: { runId: 'browser-run' },
  })

  const baseUrl = await fixture.server.listen()
  try {
    const identity = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'cli',
        externalUserId: 'browser-user',
        accountId: owner.accountId,
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(identity.status, 200, JSON.stringify(await readJson(identity)))

    const deliveryList = await fetch(`${baseUrl}/api/channels/deliveries?limit=10`)
    const deliveryListBody = await readJson(deliveryList)
    assert.equal(deliveryList.status, 200, JSON.stringify(deliveryListBody))
    assert.equal(
      asArray(deliveryListBody.deliveries).some((delivery) => (
        asRecord(delivery).deliveryId === 'browser-delivery'
      )),
      true,
    )

    const retry = await fetch(`${baseUrl}/api/channels/deliveries/browser-delivery/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelBindingId: 'browser-binding' }),
    })
    assert.equal(retry.status, 200, JSON.stringify(await readJson(retry)))

    const gatewayOnlyCreate = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(gatewayOnlyCreate.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(gatewayOnlyCreate)).verdict).policyCode,
      'authorization.principal_denied',
    )

    activePrincipal = member
    for (const [path, init] of [
      ['/api/channels/deliveries', undefined],
      ['/api/channels/identities/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cli', externalUserId: 'denied-member' }),
      }],
    ] as const) {
      const denied = await fetch(`${baseUrl}${path}`, init)
      assert.equal(denied.status, 403, path)
      assert.equal(
        asRecord(asRecord(await readJson(denied)).verdict).policyCode,
        'authorization.principal_denied',
        path,
      )
    }
  } finally {
    await fixture.server.close()
  }
})

test('disabled Channels denies gateway requests before binding-grant lookup', async () => {
  const defaultPolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const gatewayPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'gateway-account',
    accountId: 'gateway-account',
    email: 'gateway@example.test',
    role: 'admin' as const,
    authSource: 'api_token' as const,
    tokenId: '',
    tokenScopes: ['gateway'] as Array<'gateway'>,
  }
  const fixture = createFixture({
    policy: {
      ...defaultPolicy,
      features: { ...defaultPolicy.features, channels: false },
    },
    auth: async () => ({ ...gatewayPrincipal }),
  })
  await fixture.service.ensurePrincipal({
    ...gatewayPrincipal,
    authSource: 'local',
    tokenId: undefined,
    tokenScopes: undefined,
  })
  const noGrant = await fixture.store.issueApiToken({
    orgId: 'tenant-1',
    accountId: 'gateway-account',
    name: 'No grant',
    scopes: ['gateway'],
  })
  const staleGrant = await fixture.store.issueApiToken({
    orgId: 'tenant-1',
    accountId: 'gateway-account',
    name: 'Stale grant',
    scopes: ['gateway'],
  })
  const activeGrant = await fixture.store.issueApiToken({
    orgId: 'tenant-1',
    accountId: 'gateway-account',
    name: 'Active grant',
    scopes: ['gateway'],
  })
  fixture.store.createHeadlessAgent({
    agentId: 'gateway-agent',
    orgId: 'tenant-1',
    tenantId: 'tenant-1',
    profileName: 'full',
    name: 'Gateway agent',
  })
  for (const [bindingId, status] of [['stale-binding', 'disabled'], ['active-binding', 'active']] as const) {
    fixture.store.createChannelBinding({
      bindingId,
      orgId: 'tenant-1',
      agentId: 'gateway-agent',
      provider: 'telegram',
      displayName: bindingId,
      status,
    })
  }
  fixture.store.grantApiTokenChannelBinding({
    orgId: 'tenant-1',
    tokenId: staleGrant.token.tokenId,
    channelBindingId: 'stale-binding',
  })
  fixture.store.grantApiTokenChannelBinding({
    orgId: 'tenant-1',
    tokenId: activeGrant.token.tokenId,
    channelBindingId: 'active-binding',
  })

  const baseUrl = await fixture.server.listen()
  try {
    let expectedBody: Record<string, unknown> | null = null
    for (const issued of [noGrant, staleGrant, activeGrant]) {
      gatewayPrincipal.tokenId = issued.token.tokenId
      const response = await fetch(`${baseUrl}/api/channels/sessions/absent-binding/snapshot`)
      assert.equal(response.status, 403)
      const body = await readJson(response)
      expectedBody ||= body
      assert.deepEqual(body, expectedBody)
    }
    assert.deepEqual(expectedBody, {
      error: 'Channels are disabled for this cloud profile.',
      verdict: {
        allowed: false,
        reason: 'Channels are disabled for this cloud profile.',
        policyCode: 'channels.disabled',
      },
    })
  } finally {
    await fixture.server.close()
  }
})

test('central gateway decision verifies the requested session binding and records one denial', async () => {
  const logs: CloudLogRecord[] = []
  const metrics: CloudMetricRecord[] = []
  const observability: CloudObservabilityAdapter = {
    log(record) { logs.push(record) },
    metric(record) { metrics.push(record) },
    span() {},
  }
  const gatewayPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'gateway-target-account',
    accountId: 'gateway-target-account',
    email: 'gateway-target@example.test',
    role: 'admin' as const,
    authSource: 'api_token' as const,
    tokenId: '',
    tokenScopes: ['gateway'] as Array<'gateway'>,
  }
  const fixture = createFixture({
    auth: async () => ({ ...gatewayPrincipal }),
    observability,
  })
  await fixture.service.ensurePrincipal({
    ...gatewayPrincipal,
    authSource: 'local',
    tokenId: undefined,
    tokenScopes: undefined,
  })
  const issued = await fixture.store.issueApiToken({
    orgId: 'tenant-1',
    accountId: gatewayPrincipal.accountId,
    name: 'Target-bound gateway',
    scopes: ['gateway'],
  })
  gatewayPrincipal.tokenId = issued.token.tokenId
  fixture.store.createHeadlessAgent({
    agentId: 'target-agent',
    orgId: 'tenant-1',
    tenantId: 'tenant-1',
    profileName: 'full',
    name: 'Target agent',
  })
  for (const bindingId of ['granted-binding', 'other-binding']) {
    fixture.store.createChannelBinding({
      bindingId,
      orgId: 'tenant-1',
      agentId: 'target-agent',
      provider: 'telegram',
      displayName: bindingId,
    })
  }
  fixture.store.grantApiTokenChannelBinding({
    orgId: 'tenant-1',
    tokenId: issued.token.tokenId,
    channelBindingId: 'granted-binding',
  })
  fixture.store.createSession({
    tenantId: 'tenant-1',
    userId: gatewayPrincipal.accountId,
    sessionId: 'private-session',
    opencodeSessionId: 'private-opencode-session',
    profileName: 'full',
  })
  fixture.store.bindChannelSession({
    bindingId: 'other-session-binding',
    orgId: 'tenant-1',
    agentId: 'target-agent',
    channelBindingId: 'other-binding',
    provider: 'telegram',
    externalThreadId: 'thread-1',
    externalChatId: 'chat-1',
    sessionId: 'private-session',
  })

  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/channels/sessions/other-session-binding/snapshot`)
    assert.equal(response.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(response)).verdict).policyCode,
      'channels.binding_scope_required',
    )
    const policyLogs = logs.filter((record) => record.name === 'cloud.workspace_policy.decision')
    const policyMetrics = metrics.filter((record) => record.name === 'open_cowork_cloud_workspace_policy_decisions_total')
    assert.equal(policyLogs.length, 1)
    assert.equal(policyMetrics.length, 1)
    assert.deepEqual(policyLogs[0]?.attributes, {
      workspace_policy_action: 'channels.service.session',
      workspace_policy_principal: 'gateway-service',
      workspace_policy_outcome: 'deny',
      workspace_policy_reason: 'channels.binding_scope_required',
    })
  } finally {
    await fixture.server.close()
  }
})

test('custom channel roles upgrade members and downgrade admins across matrix and domain guards', async () => {
  const upgradedMember = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'delegated-channel-manager',
    accountId: 'delegated-channel-manager',
    email: 'delegated-channel-manager@example.test',
    role: 'member' as const,
    authSource: 'user' as const,
  }
  const downgradedAdmin = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'restricted-channel-admin',
    accountId: 'restricted-channel-admin',
    email: 'restricted-channel-admin@example.test',
    role: 'admin' as const,
    authSource: 'user' as const,
  }
  let activePrincipal = upgradedMember
  const fixture = createFixture({ auth: async () => ({ ...activePrincipal }) })
  for (const principal of [upgradedMember, downgradedAdmin]) {
    await fixture.service.ensurePrincipal({ ...principal, authSource: 'local' })
  }
  fixture.store.createCustomRole({
    orgId: 'tenant-1',
    roleKey: 'channel-manager',
    name: 'Channel manager',
    baseRole: 'member',
    permissions: ['org:manage'],
  })
  fixture.store.createCustomRole({
    orgId: 'tenant-1',
    roleKey: 'restricted-admin',
    name: 'Restricted admin',
    baseRole: 'admin',
    permissions: [],
  })
  fixture.store.upsertMembership({
    orgId: 'tenant-1',
    accountId: upgradedMember.accountId,
    role: 'member',
    customRoleKey: 'channel-manager',
    status: 'active',
  })
  fixture.store.upsertMembership({
    orgId: 'tenant-1',
    accountId: downgradedAdmin.accountId,
    role: 'admin',
    customRoleKey: 'restricted-admin',
    status: 'active',
  })

  const baseUrl = await fixture.server.listen()
  try {
    const upgraded = await fetch(`${baseUrl}/api/channels/agents`)
    assert.equal(upgraded.status, 200)

    activePrincipal = downgradedAdmin
    const downgraded = await fetch(`${baseUrl}/api/channels/agents`)
    assert.equal(downgraded.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(downgraded)).verdict).policyCode,
      'authorization.principal_denied',
    )
  } finally {
    await fixture.server.close()
  }
})

test('projection operations deny ordinary members before session lookup and retain operator-token access', async () => {
  const operatorPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'operator-account',
    accountId: 'operator-account',
    email: 'operator@example.test',
    role: 'owner' as const,
    authSource: 'api_token' as const,
    tokenId: 'operator-token',
    tokenScopes: ['operator'] as Array<'operator'>,
  }
  let principal: typeof operatorPrincipal | {
    tenantId: string
    tenantName: string
    orgId: string
    userId: string
    accountId: string
    email: string
    role: 'member'
    authSource: 'user'
  } = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'member-account',
    accountId: 'member-account',
    email: 'member@example.test',
    role: 'member',
    authSource: 'user',
  }
  const fixture = createFixture({ auth: async () => ({ ...principal }) })
  await fixture.service.ensurePrincipal({
    ...operatorPrincipal,
    authSource: 'local',
    tokenScopes: undefined,
    tokenId: undefined,
  })
  fixture.store.createSession({
    tenantId: 'tenant-1',
    userId: 'operator-account',
    sessionId: 'operator-session',
    opencodeSessionId: 'operator-opencode-session',
    profileName: 'full',
  })
  const baseUrl = await fixture.server.listen()
  try {
    const memberResponse = await fetch(`${baseUrl}/api/sessions/absent/projection-status`)
    assert.equal(memberResponse.status, 403)
    const memberPayload = asRecord(await readJson(memberResponse))
    assert.equal(asRecord(memberPayload.verdict).policyCode, 'authorization.principal_denied')

    principal = operatorPrincipal
    const operatorResponse = await fetch(`${baseUrl}/api/sessions/operator-session/projection-status`)
    assert.equal(operatorResponse.status, 200)
    assert.equal(asRecord(await readJson(operatorResponse)).sessionId, 'operator-session')
  } finally {
    await fixture.server.close()
  }
})

test('workspace policy telemetry contains only bounded decision dimensions', async () => {
  const logs: CloudLogRecord[] = []
  const metrics: CloudMetricRecord[] = []
  const observability: CloudObservabilityAdapter = {
    log(record) { logs.push(record) },
    metric(record) { metrics.push(record) },
    span() {},
  }
  const fixture = createFixture({ observability })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/sessions/secret-session-id/events/extra`)
    assert.equal(response.status, 403)
    const log = logs.find((record) => record.name === 'cloud.workspace_policy.decision')
    const metric = metrics.find((record) => record.name === 'open_cowork_cloud_workspace_policy_decisions_total')
    assert.ok(log)
    assert.ok(metric)
    const expectedKeys = [
      'workspace_policy_action',
      'workspace_policy_outcome',
      'workspace_policy_principal',
      'workspace_policy_reason',
    ]
    assert.deepEqual(Object.keys(log.attributes || {}).sort(), expectedKeys)
    assert.deepEqual(Object.keys(metric.attributes || {}).sort(), expectedKeys)
    assert.deepEqual(log.attributes, {
      workspace_policy_action: 'unknown',
      workspace_policy_principal: 'local',
      workspace_policy_outcome: 'deny',
      workspace_policy_reason: 'authorization.action_unknown',
    })
    const serialized = JSON.stringify({ log, metric })
    assert.doesNotMatch(serialized, /secret-session-id|cookie|tenantId|prompt|url\.path|request_id/i)
  } finally {
    await fixture.server.close()
  }
})

test('verified billing webhooks receive one bounded matrix decision before workspace mutation', async () => {
  const logs: CloudLogRecord[] = []
  const metrics: CloudMetricRecord[] = []
  const observability: CloudObservabilityAdapter = {
    log(record) { logs.push(record) },
    metric(record) { metrics.push(record) },
    span() {},
  }
  const billing = testBillingConfig()
  const fixture = createFixture({
    billing,
    billingAdapter: createStubBillingAdapter(billing),
    observability,
  })
  await fixture.service.ensurePrincipal({
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner',
    authSource: 'local',
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/webhooks/billing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'evt_workspace_policy',
        type: 'customer.subscription.updated',
        subscription: {
          orgId: 'tenant-1',
          planKey: 'pro',
          status: 'active',
        },
      }),
    })
    assert.equal(response.status, 200)
    const policyLogs = logs.filter((record) => record.name === 'cloud.workspace_policy.decision')
    const policyMetrics = metrics.filter((record) => record.name === 'open_cowork_cloud_workspace_policy_decisions_total')
    assert.equal(policyLogs.length, 1)
    assert.equal(policyMetrics.length, 1)
    assert.deepEqual(policyLogs[0]?.attributes, {
      workspace_policy_action: 'billing.webhookApply',
      workspace_policy_principal: 'billing-webhook-service',
      workspace_policy_outcome: 'allow',
      workspace_policy_reason: 'allowed',
    })
  } finally {
    await fixture.server.close()
  }
})
