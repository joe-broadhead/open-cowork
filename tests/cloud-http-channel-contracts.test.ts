import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiTokenCloudAuthResolver } from '@open-cowork/cloud-server/app'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createCloudHttpServer } from '@open-cowork/cloud-server/http-server'
import { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import { CloudWorker } from '@open-cowork/cloud-server/worker'
import { FakeRuntimeAdapter, createFixture } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
  policyWithRemoteApprovalResponses,
} from './helpers/cloud-http-test-support.ts'
import { readSseUntil } from './helpers/cloud-sse-test-support.ts'

test('cloud HTTP server exposes gateway channel identity, binding, interaction, and delivery APIs', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const account = store.createAccount({
    accountId: 'account-1',
    idpSubject: 'subject-1',
    email: 'member@example.test',
  })
  store.ensureUser({ tenantId: 'tenant-1', userId: account.accountId, email: account.email, role: 'admin' })
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
    scopes: ['gateway', 'admin'],
  })
  const adminIssued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Channel setup token',
    scopes: ['admin'],
  })
  const operatorIssued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Operator diagnostics token',
    scopes: ['operator'],
  })
  const gatewayOnlyIssued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Gateway-only token',
    scopes: ['gateway'],
  })
  const otherGatewayOnlyIssued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Other gateway-only token',
    scopes: ['gateway'],
  })
  const staleGatewayOnlyIssued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Stale-binding gateway-only token',
    scopes: ['gateway'],
  })
  store.createTenant({ tenantId: 'tenant-2', name: 'Tenant 2' })
  const org2 = store.ensureOrgForTenant({ tenantId: 'tenant-2', name: 'Tenant 2' })
  const account2 = store.createAccount({
    accountId: 'account-2',
    idpSubject: 'subject-2',
    email: 'other-member@example.test',
  })
  store.ensureUser({ tenantId: 'tenant-2', userId: account2.accountId, email: account2.email, role: 'admin' })
  store.upsertMembership({
    orgId: org2.orgId,
    accountId: account2.accountId,
    role: 'admin',
    status: 'active',
  })
  const issuedTenant2 = await store.issueApiToken({
    orgId: org2.orgId,
    accountId: account2.accountId,
    name: 'Other org gateway token',
    scopes: ['gateway', 'admin'],
  })
  const adminIssuedTenant2 = await store.issueApiToken({
    orgId: org2.orgId,
    accountId: account2.accountId,
    name: 'Other org channel setup token',
    scopes: ['admin'],
  })

  const runtime = new FakeRuntimeAdapter()
  const policy = policyWithRemoteApprovalResponses()
  let nextId = 0
  const service = new CloudSessionService(store, runtime, policy, undefined, {
    randomUUID: () => `channel-id-${nextId += 1}`,
  })
  const worker = new CloudWorker(store, service, 'worker-1')
  const server = createCloudHttpServer({
    service,
    worker,
    policy,
    auth: createApiTokenCloudAuthResolver(store),
    autoProcessCommands: true,
    ssePollMs: 10,
  })
  const baseUrl = await server.listen()
  const headers = {
    authorization: `Bearer ${issued.plaintext}`,
    'content-type': 'application/json',
  }
  const adminHeaders = {
    authorization: `Bearer ${adminIssued.plaintext}`,
    'content-type': 'application/json',
  }
  const gatewayOnlyHeaders = {
    authorization: `Bearer ${gatewayOnlyIssued.plaintext}`,
    'content-type': 'application/json',
  }
  const otherGatewayOnlyHeaders = {
    authorization: `Bearer ${otherGatewayOnlyIssued.plaintext}`,
    'content-type': 'application/json',
  }
  const staleGatewayOnlyHeaders = {
    authorization: `Bearer ${staleGatewayOnlyIssued.plaintext}`,
    'content-type': 'application/json',
  }
  const tenant2Headers = {
    authorization: `Bearer ${issuedTenant2.plaintext}`,
    'content-type': 'application/json',
  }
  const tenant2AdminHeaders = {
    authorization: `Bearer ${adminIssuedTenant2.plaintext}`,
    'content-type': 'application/json',
  }
  const operatorHeaders = {
    authorization: `Bearer ${operatorIssued.plaintext}`,
    'content-type': 'application/json',
  }
  try {
    const noGrantResponse = await fetch(
      `${baseUrl}/api/channels/sessions/absent-binding/snapshot`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(noGrantResponse.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(noGrantResponse)).verdict).policyCode,
      'channels.binding_scope_required',
    )

    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        agentId: 'agent-seed-1',
        name: 'Data analyst',
        profileName: 'data-analyst',
      }),
    })
    assert.equal(agentResponse.status, 201)
    const agentId = String(asRecord((await readJson(agentResponse)).agent).agentId)
    assert.match(agentId, /^channel_agent_/)

    const staleBindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        bindingId: 'disabled-binding',
        agentId,
        provider: 'telegram',
        displayName: 'Disabled Telegram',
        status: 'disabled',
      }),
    })
    assert.equal(staleBindingResponse.status, 201)
    const disabledBindingId = String(asRecord((await readJson(staleBindingResponse)).binding).bindingId)
    await store.grantApiTokenChannelBinding({
      orgId: org.orgId,
      tokenId: staleGatewayOnlyIssued.token.tokenId,
      channelBindingId: disabledBindingId,
    })
    const staleGrantResponse = await fetch(
      `${baseUrl}/api/channels/sessions/absent-binding/snapshot`,
      { headers: staleGatewayOnlyHeaders },
    )
    assert.equal(staleGrantResponse.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(staleGrantResponse)).verdict).policyCode,
      'channels.binding_scope_required',
    )

    const bindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        bindingId: 'telegram-binding',
        agentId,
        provider: 'telegram',
        displayName: 'Telegram',
        externalWorkspaceId: 'bot-1',
        credentialRef: 'secret/telegram',
      }),
    })
    assert.equal(bindingResponse.status, 201)
    const channelBinding = asRecord((await readJson(bindingResponse)).binding)
    assert.equal(channelBinding.credentialRef, undefined)
    assert.equal(channelBinding.credentialRefConfigured, true)
    assert.equal(channelBinding.credentialRefKind, 'secret-ref')
    store.grantApiTokenChannelBinding({
      orgId: org.orgId,
      tokenId: issued.token.tokenId,
      channelBindingId: String(channelBinding.bindingId),
    })

    const victimIdentity = store.upsertChannelIdentity({
      identityId: 'tenant-2-victim-identity',
      orgId: org2.orgId,
      provider: 'telegram',
      externalWorkspaceId: 'tenant-2-workspace',
      externalUserId: 'tenant-2-user',
      accountId: account2.accountId,
      role: 'owner',
      status: 'active',
      metadata: { sentinel: 'tenant-2-identity-must-not-change' },
    })
    const gatewayIdentityCollision = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: victimIdentity.identityId,
        channelBindingId: channelBinding.bindingId,
        provider: 'telegram',
        externalWorkspaceId: 'bot-1',
        externalUserId: 'gateway-collision-attempt',
      }),
    })
    assert.equal(gatewayIdentityCollision.status, 200)
    const collisionIdentity = asRecord((await readJson(gatewayIdentityCollision)).identity)
    assert.notEqual(collisionIdentity.identityId, victimIdentity.identityId)
    assert.deepEqual(store.getChannelIdentity(org2.orgId, victimIdentity.identityId), victimIdentity)

    const updateBindingResponse = await fetch(`${baseUrl}/api/channels/bindings/${encodeURIComponent(String(channelBinding.bindingId))}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        displayName: 'Telegram primary',
        settings: { webhookSecret: 'channel-redaction-sentinel-1234567890abcdef' },
      }),
    })
    assert.equal(updateBindingResponse.status, 200)
    const updatedBinding = asRecord((await readJson(updateBindingResponse)).binding)
    assert.equal(updatedBinding.credentialRef, undefined)
    assert.equal(JSON.stringify(updatedBinding).includes('channel-redaction-sentinel'), false)
    const bindingAudit = await store.listAuditEvents('tenant-1')
    assert.equal(bindingAudit.some((event) => event.eventType === 'channel_binding.updated'), true)
    assert.equal(JSON.stringify(bindingAudit).includes('channel-redaction-sentinel'), false)

    const tenant2Bindings = await readJson(await fetch(`${baseUrl}/api/channels/bindings`, { headers: tenant2AdminHeaders }))
    assert.deepEqual(asArray(tenant2Bindings.bindings), [])

    const identityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-1',
        externalUserId: 'tg-user-1',
        accountId: account.accountId,
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(identityResponse.status, 200)
    const identity = asRecord((await readJson(identityResponse)).identity)
    assert.equal(identity.status, 'active')

    const mixedScopeUngrantedIdentity = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-2',
        externalUserId: 'tg-user-2',
        accountId: account.accountId,
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(mixedScopeUngrantedIdentity.status, 200)
    const mixedScopeIdentity = asRecord((await readJson(mixedScopeUngrantedIdentity)).identity)
    assert.equal(mixedScopeIdentity.accountId, account.accountId)
    assert.equal(mixedScopeIdentity.role, 'member')
    assert.equal(mixedScopeIdentity.status, 'active')

    const wrongWorkspaceIdentityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-2',
        externalUserId: 'tg-user-2',
        accountId: account.accountId,
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(wrongWorkspaceIdentityResponse.status, 200)
    const wrongWorkspaceIdentity = asRecord((await readJson(wrongWorkspaceIdentityResponse)).identity)

    const unauthorizedActorSpecs = [{
      externalUserId: 'disabled-actor',
      provider: 'telegram',
      externalWorkspaceId: 'bot-1',
      role: 'member',
      status: 'disabled',
    }, {
      externalUserId: 'viewer-actor',
      provider: 'telegram',
      externalWorkspaceId: 'bot-1',
      role: 'viewer',
      status: 'active',
    }, {
      externalUserId: 'wrong-provider-actor',
      provider: 'slack',
      externalWorkspaceId: 'bot-1',
      role: 'member',
      status: 'active',
    }] as const
    const unauthorizedActors: Record<string, unknown>[] = []
    for (const actorSpec of unauthorizedActorSpecs) {
      const actorResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ ...actorSpec, accountId: account.accountId }),
      })
      assert.equal(actorResponse.status, 200)
      unauthorizedActors.push(asRecord((await readJson(actorResponse)).identity))
    }

    const secondBindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        bindingId: 'telegram-binding-2',
        agentId,
        provider: 'telegram',
        displayName: 'Telegram second workspace',
        externalWorkspaceId: 'bot-2',
        credentialRef: 'secret/telegram-2',
      }),
    })
    assert.equal(secondBindingResponse.status, 201)
    const secondChannelBinding = asRecord((await readJson(secondBindingResponse)).binding)
    assert.equal(secondChannelBinding.credentialRef, undefined)
    store.grantApiTokenChannelBinding({
      orgId: org.orgId,
      tokenId: issued.token.tokenId,
      channelBindingId: String(secondChannelBinding.bindingId),
    })

    store.grantApiTokenChannelBinding({
      orgId: org.orgId,
      tokenId: gatewayOnlyIssued.token.tokenId,
      channelBindingId: String(channelBinding.bindingId),
    })
    store.grantApiTokenChannelBinding({
      orgId: org.orgId,
      tokenId: gatewayOnlyIssued.token.tokenId,
      channelBindingId: disabledBindingId,
    })
    store.createChannelDelivery({
      deliveryId: 'disabled-binding-delivery',
      orgId: org.orgId,
      agentId,
      channelBindingId: disabledBindingId,
      provider: 'telegram',
      target: { externalChatId: 'disabled-chat' },
      eventType: 'workflow.completed',
      payload: { runId: 'disabled-run' },
    })
    for (const [label, deniedHeaders] of [
      ['no binding grants', otherGatewayOnlyHeaders],
      ['disabled-only binding grants', staleGatewayOnlyHeaders],
    ] as const) {
      const deniedUnscopedList = await fetch(`${baseUrl}/api/channels/deliveries?limit=10`, {
        headers: deniedHeaders,
      })
      assert.equal(deniedUnscopedList.status, 403, label)
      assert.equal(
        asRecord(asRecord(await readJson(deniedUnscopedList)).verdict).policyCode,
        'channels.binding_scope_required',
        label,
      )
    }
    const activeAndStaleList = await fetch(`${baseUrl}/api/channels/deliveries?limit=10`, {
      headers: gatewayOnlyHeaders,
    })
    assert.equal(activeAndStaleList.status, 200)
    assert.equal(
      asArray((await readJson(activeAndStaleList)).deliveries)
        .some((delivery) => asRecord(delivery).deliveryId === 'disabled-binding-delivery'),
      false,
    )
    const staleScopedList = await fetch(`${baseUrl}/api/channels/deliveries?channelBindingId=${encodeURIComponent(disabledBindingId)}`, {
      headers: gatewayOnlyHeaders,
    })
    assert.equal(staleScopedList.status, 403)
    const staleScopedStream = await fetch(
      `${baseUrl}/api/channels/deliveries/stream?channelBindingId=${encodeURIComponent(disabledBindingId)}`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(staleScopedStream.status, 403)
    const staleScopedCreate = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        deliveryId: 'disabled-binding-create-probe',
        agentId,
        channelBindingId: disabledBindingId,
        provider: 'telegram',
        target: { externalChatId: 'disabled-chat' },
        eventType: 'workflow.completed',
        payload: { runId: 'disabled-create-probe' },
      }),
    })
    assert.equal(staleScopedCreate.status, 403)
    store.grantApiTokenChannelBinding({
      orgId: org.orgId,
      tokenId: otherGatewayOnlyIssued.token.tokenId,
      channelBindingId: String(secondChannelBinding.bindingId),
    })
    store.grantApiTokenChannelBinding({
      orgId: org.orgId,
      tokenId: otherGatewayOnlyIssued.token.tokenId,
      channelBindingId: String(channelBinding.bindingId),
    })

    store.ensureUser({ tenantId: 'tenant-1', userId: 'other-user', email: 'other@example.test' })
    store.createSession({
      tenantId: 'tenant-1',
      userId: 'other-user',
      sessionId: 'other-session',
      opencodeSessionId: 'other-opencode-session',
      profileName: 'full',
    })
    store.enqueueSessionCommand({
      commandId: 'other-session-private-command',
      tenantId: 'tenant-1',
      userId: 'other-user',
      sessionId: 'other-session',
      kind: 'prompt',
      payload: { text: 'private command in another session' },
    })
    const stolenSessionBind = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: channelBinding.bindingId,
        provider: 'telegram',
        externalChatId: 'chat-1',
        externalThreadId: 'thread-stolen',
        sessionId: 'other-session',
      }),
    })
    assert.equal(stolenSessionBind.status, 403)

    const bindResponse = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: channelBinding.bindingId,
        provider: 'telegram',
        externalChatId: 'chat-1',
        externalThreadId: 'thread-1',
        title: 'Telegram thread',
      }),
    })
    assert.equal(bindResponse.status, 200)
    const bound = await readJson(bindResponse)
    const sessionBinding = asRecord(bound.binding)
    const cloudSession = asRecord(asRecord(bound.session).session)
    assert.equal(sessionBinding.sessionId, cloudSession.sessionId)
    assert.equal(sessionBinding.externalWorkspaceId, 'bot-1')

    const secondWorkspaceBindResponse = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: wrongWorkspaceIdentity.identityId,
        channelBindingId: secondChannelBinding.bindingId,
        provider: 'telegram',
        externalChatId: 'chat-1',
        externalThreadId: 'thread-1',
        title: 'Telegram thread in second workspace',
      }),
    })
    assert.equal(secondWorkspaceBindResponse.status, 200)
    const secondWorkspaceSessionBinding = asRecord((await readJson(secondWorkspaceBindResponse)).binding)
    assert.equal(secondWorkspaceSessionBinding.externalWorkspaceId, 'bot-2')
    assert.notEqual(secondWorkspaceSessionBinding.bindingId, sessionBinding.bindingId)

    const prohibitedGeneralGatewaySessionRead = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(String(cloudSession.sessionId))}`, {
      headers: gatewayOnlyHeaders,
    })
    assert.equal(prohibitedGeneralGatewaySessionRead.status, 403)

    const bindingScopedGatewaySessionRead = await fetch(
      `${baseUrl}/api/channels/sessions/${encodeURIComponent(String(sessionBinding.bindingId))}/snapshot`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(bindingScopedGatewaySessionRead.status, 200)
    assert.equal(
      asRecord(asRecord(await readJson(bindingScopedGatewaySessionRead)).session).sessionId,
      cloudSession.sessionId,
    )

    const bindingScopedArtifactRead = await fetch(
      `${baseUrl}/api/channels/sessions/${encodeURIComponent(String(sessionBinding.bindingId))}/artifacts/missing-artifact`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(bindingScopedArtifactRead.status, 503)

    const streamAbort = new AbortController()
    const bindingScopedStream = await fetch(
      `${baseUrl}/api/channels/sessions/${encodeURIComponent(String(sessionBinding.bindingId))}/events`,
      { headers: gatewayOnlyHeaders, signal: streamAbort.signal },
    )
    assert.equal(bindingScopedStream.status, 200)
    await bindingScopedStream.body?.cancel()
    streamAbort.abort()

    const ungrantedBindingScopedRead = await fetch(
      `${baseUrl}/api/channels/sessions/${encodeURIComponent(String(secondWorkspaceSessionBinding.bindingId))}/snapshot`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(ungrantedBindingScopedRead.status, 403)
    const absentBindingScopedRead = await fetch(
      `${baseUrl}/api/channels/sessions/absent-binding/snapshot`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(absentBindingScopedRead.status, 403)
    assert.equal(
      String(asRecord(await readJson(ungrantedBindingScopedRead)).error),
      String(asRecord(await readJson(absentBindingScopedRead)).error),
    )

    const ungrantedSessionId = String(secondWorkspaceSessionBinding.sessionId)
    const ungrantedGatewaySessionRead = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(ungrantedSessionId)}`, {
      headers: gatewayOnlyHeaders,
    })
    assert.equal(ungrantedGatewaySessionRead.status, 403)
    assert.match(String(asRecord(await readJson(ungrantedGatewaySessionRead)).error), /not authorized/)

    const ungrantedGatewaySessionView = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(ungrantedSessionId)}/view`, {
      headers: gatewayOnlyHeaders,
    })
    assert.equal(ungrantedGatewaySessionView.status, 403)
    assert.match(String(asRecord(await readJson(ungrantedGatewaySessionView)).error), /not authorized/)

    const ungrantedGatewaySessionEvents = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(ungrantedSessionId)}/events`, {
      headers: gatewayOnlyHeaders,
    })
    assert.equal(ungrantedGatewaySessionEvents.status, 403)
    assert.match(String(asRecord(await readJson(ungrantedGatewaySessionEvents)).error), /not authorized/)

    const ungrantedGatewayArtifactRead = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(ungrantedSessionId)}/artifacts/missing-artifact`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(ungrantedGatewayArtifactRead.status, 403)
    assert.match(String(asRecord(await readJson(ungrantedGatewayArtifactRead)).error), /not authorized/)

    const ungrantedGatewayBind = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        identityId: wrongWorkspaceIdentity.identityId,
        channelBindingId: secondChannelBinding.bindingId,
        provider: 'telegram',
        externalChatId: 'chat-ungranted',
        externalThreadId: 'thread-ungranted',
        title: 'Ungrantable second workspace thread',
      }),
    })
    assert.equal(ungrantedGatewayBind.status, 403)
    assert.equal(
      asRecord(asRecord(await readJson(ungrantedGatewayBind)).verdict).policyCode,
      'channels.binding_scope_required',
    )

    const ungrantedGatewayThreadLookup = await fetch(
      `${baseUrl}/api/channels/sessions/by-thread?provider=telegram&externalWorkspaceId=bot-2&externalChatId=chat-1&externalThreadId=thread-1`,
      { headers: gatewayOnlyHeaders },
    )
    const absentGatewayThreadLookup = await fetch(
      `${baseUrl}/api/channels/sessions/by-thread?provider=telegram&externalWorkspaceId=bot-2&externalChatId=absent-chat&externalThreadId=absent-thread`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(ungrantedGatewayThreadLookup.status, 404)
    assert.equal(absentGatewayThreadLookup.status, ungrantedGatewayThreadLookup.status)
    assert.deepEqual(
      await readJson(absentGatewayThreadLookup),
      await readJson(ungrantedGatewayThreadLookup),
    )

    const ungrantedGatewayPrompt = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        identityId: wrongWorkspaceIdentity.identityId,
        bindingId: secondWorkspaceSessionBinding.bindingId,
        text: 'should not reach prompt queue',
      }),
    })
    assert.equal(ungrantedGatewayPrompt.status, 403)
    assert.equal(asRecord(asRecord(await readJson(ungrantedGatewayPrompt)).verdict).policyCode, 'channels.binding_scope_required')

    const ungrantedGatewayCursor = await fetch(`${baseUrl}/api/channels/cursor`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        bindingId: secondWorkspaceSessionBinding.bindingId,
        lastEventSequence: 1,
        lastWorkspaceSequence: 1,
        lastChatMessageId: 'message-ungranted',
      }),
    })
    assert.equal(ungrantedGatewayCursor.status, 403)
    assert.equal(asRecord(asRecord(await readJson(ungrantedGatewayCursor)).verdict).policyCode, 'channels.binding_scope_required')

    const ungrantedGatewayIdentity = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        channelBindingId: secondChannelBinding.bindingId,
        externalUserId: 'tg-user-ungranted-explicit',
      }),
    })
    assert.equal(ungrantedGatewayIdentity.status, 403)
    assert.equal(asRecord(asRecord(await readJson(ungrantedGatewayIdentity)).verdict).policyCode, 'channels.binding_scope_required')

    const ungrantedGatewayIdentityFallback = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-2',
        externalUserId: 'tg-user-ungranted-fallback',
      }),
    })
    assert.equal(ungrantedGatewayIdentityFallback.status, 403)
    assert.match(String(asRecord(await readJson(ungrantedGatewayIdentityFallback)).error), /not authorized/)

    const grantedGatewayIdentity = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        channelBindingId: channelBinding.bindingId,
        externalUserId: 'tg-user-granted',
      }),
    })
    assert.equal(grantedGatewayIdentity.status, 200)
    const grantedGatewayIdentityBody = asRecord((await readJson(grantedGatewayIdentity)).identity)
    assert.equal(grantedGatewayIdentityBody.externalWorkspaceId, 'bot-1')
    assert.equal(grantedGatewayIdentityBody.status, 'pending')

    const ungrantedProviderEventClaim = await fetch(`${baseUrl}/api/channels/provider-events/claim`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        providerInstanceId: 'telegram-prod-2',
        channelBindingId: secondChannelBinding.bindingId,
        externalWorkspaceId: 'bot-2',
        providerEventId: 'provider-event-ungranted-explicit',
        eventType: 'message',
        claimedBy: 'gateway-1',
      }),
    })
    assert.equal(ungrantedProviderEventClaim.status, 403)
    assert.equal(asRecord(asRecord(await readJson(ungrantedProviderEventClaim)).verdict).policyCode, 'channels.binding_scope_required')

    const ungrantedProviderEventFallbackClaim = await fetch(`${baseUrl}/api/channels/provider-events/claim`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        providerInstanceId: 'telegram-prod-2',
        externalWorkspaceId: 'bot-2',
        providerEventId: 'provider-event-ungranted-fallback',
        eventType: 'message',
        claimedBy: 'gateway-1',
      }),
    })
    assert.equal(ungrantedProviderEventFallbackClaim.status, 403)
    assert.match(String(asRecord(await readJson(ungrantedProviderEventFallbackClaim)).error), /not authorized/)

    const secondProviderEventClaim = await fetch(`${baseUrl}/api/channels/provider-events/claim`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        providerInstanceId: 'telegram-prod-2',
        channelBindingId: secondChannelBinding.bindingId,
        providerEventId: 'provider-event-second-complete',
        eventType: 'message',
        claimedBy: 'gateway-2',
      }),
    })
    assert.equal(secondProviderEventClaim.status, 200)
    const secondProviderEvent = asRecord(asRecord(await readJson(secondProviderEventClaim)).event)

    const ungrantedProviderEventComplete = await fetch(`${baseUrl}/api/channels/provider-events/${secondProviderEvent.eventId}/complete`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        channelBindingId: secondChannelBinding.bindingId,
        claimedBy: 'gateway-2',
        status: 'processed',
      }),
    })
    assert.equal(ungrantedProviderEventComplete.status, 403)
    assert.equal(asRecord(asRecord(await readJson(ungrantedProviderEventComplete)).verdict).policyCode, 'channels.binding_scope_required')

    const ungrantedProviderEventCompleteByRecordedBinding = await fetch(`${baseUrl}/api/channels/provider-events/${secondProviderEvent.eventId}/complete`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        claimedBy: 'gateway-2',
        status: 'processed',
      }),
    })
    assert.equal(ungrantedProviderEventCompleteByRecordedBinding.status, 404)

    const unscopedProviderEventClaim = store.claimChannelProviderEvent({
      orgId: org.orgId,
      provider: 'telegram',
      providerInstanceId: 'telegram-prod',
      externalWorkspaceId: 'bot-1',
      providerEventId: 'provider-event-unscoped-complete',
      eventType: 'message',
      claimedBy: 'gateway-unscoped',
      ttlMs: 30_000,
      metadata: { providerMessageId: 'unscoped-message' },
    })
    const unscopedProviderEventComplete = await fetch(`${baseUrl}/api/channels/provider-events/${unscopedProviderEventClaim.event.eventId}/complete`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        claimedBy: 'gateway-unscoped',
        status: 'processed',
      }),
    })
    assert.equal(unscopedProviderEventComplete.status, 404)

    const deniedActorIds = [
      'absent-identity',
      wrongWorkspaceIdentity.identityId,
      ...unauthorizedActors.map((actor) => actor.identityId),
    ]
    let actorDenialBody: Record<string, unknown> | null = null
    for (const identityId of deniedActorIds) {
      const deniedPrompt = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          identityId,
          bindingId: sessionBinding.bindingId,
          text: 'should not run',
        }),
      })
      assert.equal(deniedPrompt.status, 403)
      const deniedBody = await readJson(deniedPrompt)
      actorDenialBody ||= deniedBody
      assert.deepEqual(deniedBody, actorDenialBody)
    }
    assert.deepEqual(actorDenialBody, {
      error: 'Channel actor identity is not authorized for this channel session.',
    })
    assert.deepEqual(runtime.prompts, [])

    const promptResponse = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        bindingId: sessionBinding.bindingId,
        text: 'summarize revenue',
        agent: 'data-analyst',
        commandId: 'other-session-private-command',
      }),
    })
    const channelPrompt = await readJson(promptResponse)
    assert.equal(promptResponse.status, 202, JSON.stringify(channelPrompt))
    assert.equal(channelPrompt.processed, 1)
    assert.equal(asRecord(channelPrompt.projectionFence).scope, 'session')
    assert.equal(asRecord(channelPrompt.projectionFence).sessionId, cloudSession.sessionId)
    assert.equal(asRecord(channelPrompt.projectionFence).commandId, asRecord(channelPrompt.command).commandId)
    assert.notEqual(asRecord(channelPrompt.command).commandId, 'other-session-private-command')
    assert.equal(runtime.prompts[0]?.agent, 'data-analyst')

    const freshCallerCommand = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        bindingId: sessionBinding.bindingId,
        text: 'summarize costs',
        commandId: 'fresh-caller-command-id',
      }),
    })
    const freshCallerCommandBody = await readJson(freshCallerCommand)
    assert.equal(freshCallerCommand.status, promptResponse.status)
    assert.notEqual(asRecord(freshCallerCommandBody.command).commandId, 'fresh-caller-command-id')

    const interactionResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interactionId: 'interaction-1',
        agentId,
        sessionBindingId: sessionBinding.bindingId,
        sessionId: cloudSession.sessionId,
        provider: 'telegram',
        kind: 'permission',
        targetId: 'permission-1',
        tokenSecret: 'test-secret',
        createdByIdentityId: victimIdentity.identityId,
      }),
    })
    assert.equal(interactionResponse.status, 201)
    const issuedInteraction = await readJson(interactionResponse)
    assert.equal(typeof issuedInteraction.plaintextToken, 'string')
    assert.equal('tokenHash' in asRecord(issuedInteraction.interaction), false)
    assert.equal(asRecord(issuedInteraction.interaction).createdByIdentityId, null)

    const serviceTokenOnlyApproval = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token: issuedInteraction.plaintextToken,
        response: { allowed: true },
      }),
    })
    assert.equal(serviceTokenOnlyApproval.status, 404)

    const wrongWorkspaceApproval = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: wrongWorkspaceIdentity.identityId,
        token: issuedInteraction.plaintextToken,
        response: { allowed: true },
      }),
    })
    assert.equal(wrongWorkspaceApproval.status, 404)

    const approvalResponse = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        token: issuedInteraction.plaintextToken,
        response: { allowed: true },
      }),
    })
    assert.equal(approvalResponse.status, 202)
    const approval = await readJson(approvalResponse)
    assert.equal(asRecord(approval.command).kind, 'permission.respond')
    assert.equal(approval.processed, 1)
    assert.equal(asRecord(approval.projectionFence).commandId, asRecord(approval.command).commandId)
    assert.equal(asRecord(approval.projectionFence).sessionId, cloudSession.sessionId)
    assert.deepEqual(runtime.permissions, [{ permissionId: 'permission-1', allowed: true }])

    const questionInteractionResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interactionId: 'interaction-2',
        agentId,
        sessionBindingId: sessionBinding.bindingId,
        sessionId: cloudSession.sessionId,
        provider: 'telegram',
        kind: 'question',
        targetId: 'question-1',
        tokenSecret: 'question-secret',
      }),
    })
    assert.equal(questionInteractionResponse.status, 201)
    const issuedQuestion = await readJson(questionInteractionResponse)
    assert.equal(typeof issuedQuestion.plaintextToken, 'string')

    const questionResponse = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        token: issuedQuestion.plaintextToken,
        answers: ['Ship it'],
      }),
    })
    assert.equal(questionResponse.status, 202)
    const question = await readJson(questionResponse)
    assert.equal(asRecord(question.command).kind, 'question.reply')
    assert.equal(question.processed, 1)
    assert.equal(asRecord(question.projectionFence).commandId, asRecord(question.command).commandId)
    assert.equal(asRecord(question.projectionFence).sessionId, cloudSession.sessionId)
    assert.deepEqual(runtime.questionReplies, [{ requestId: 'question-1', answers: ['Ship it'] }])

    const auditPayload = JSON.stringify(await store.listAuditEvents('tenant-1'))
    assert.match(auditPayload, /channel_interaction\.permission\.responded/)
    assert.match(auditPayload, /channel_interaction\.question\.replied/)
    assert.equal(auditPayload.includes(String(issuedInteraction.plaintextToken)), false)
    assert.equal(auditPayload.includes(String(issuedQuestion.plaintextToken)), false)

    const providerEventClaimResponse = await fetch(`${baseUrl}/api/channels/provider-events/claim`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        providerInstanceId: 'telegram-prod',
        channelBindingId: channelBinding.bindingId,
        externalWorkspaceId: 'bot-1',
        providerEventId: 'provider-event-1',
        eventType: 'message',
        claimedBy: 'gateway-1',
        ttlMs: 30_000,
        metadata: {
          providerMessageId: 'message-1',
          attachmentCount: 0,
        },
      }),
    })
    assert.equal(providerEventClaimResponse.status, 200)
    const providerEventClaim = await readJson(providerEventClaimResponse)
    assert.equal(providerEventClaim.claimed, true)
    assert.equal(providerEventClaim.duplicate, false)
    const providerEvent = asRecord(providerEventClaim.event)
    assert.equal(providerEvent.status, 'processing')

    const duplicateBeforeComplete = await fetch(`${baseUrl}/api/channels/provider-events/claim`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        providerInstanceId: 'telegram-prod',
        channelBindingId: channelBinding.bindingId,
        externalWorkspaceId: 'bot-1',
        providerEventId: 'provider-event-1',
        eventType: 'message',
        claimedBy: 'gateway-2',
      }),
    })
    assert.equal(duplicateBeforeComplete.status, 200)
    assert.equal((await readJson(duplicateBeforeComplete)).claimed, false)

    const wrongClaimantComplete = await fetch(`${baseUrl}/api/channels/provider-events/${providerEvent.eventId}/complete`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({ channelBindingId: channelBinding.bindingId, claimedBy: 'gateway-2', status: 'processed' }),
    })
    assert.equal(wrongClaimantComplete.status, 404)

    const missingClaimantComplete = await fetch(`${baseUrl}/api/channels/provider-events/${providerEvent.eventId}/complete`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({ channelBindingId: channelBinding.bindingId, status: 'processed' }),
    })
    assert.equal(missingClaimantComplete.status, 400)

    const providerEventComplete = await fetch(`${baseUrl}/api/channels/provider-events/${providerEvent.eventId}/complete`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({ channelBindingId: channelBinding.bindingId, claimedBy: 'gateway-1', status: 'processed' }),
    })
    assert.equal(providerEventComplete.status, 200)
    assert.equal(asRecord((await readJson(providerEventComplete)).event).status, 'processed')

    const duplicateAfterComplete = await fetch(`${baseUrl}/api/channels/provider-events/claim`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        provider: 'telegram',
        providerInstanceId: 'telegram-prod',
        channelBindingId: channelBinding.bindingId,
        externalWorkspaceId: 'bot-1',
        providerEventId: 'provider-event-1',
        eventType: 'message',
        claimedBy: 'gateway-3',
      }),
    })
    assert.equal(duplicateAfterComplete.status, 200)
    const duplicateAfterCompleteBody = await readJson(duplicateAfterComplete)
    assert.equal(duplicateAfterCompleteBody.claimed, false)
    assert.equal(asRecord(duplicateAfterCompleteBody.event).status, 'processed')

    const deliveryResponse = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deliveryId: 'delivery-1',
        agentId,
        channelBindingId: channelBinding.bindingId,
        sessionBindingId: sessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-1' },
      }),
    })
    assert.equal(deliveryResponse.status, 201)

    store.createHeadlessAgent({
      agentId: 'unrelated-agent',
      orgId: org.orgId,
      tenantId: 'tenant-1',
      profileName: 'full',
      name: 'Unrelated agent',
    })
    const agentProbe = async (probeAgentId: string, deliveryId: string) => fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        deliveryId,
        agentId: probeAgentId,
        channelBindingId: channelBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-agent-probe' },
      }),
    })
    const absentAgentDelivery = await agentProbe('absent-agent', 'delivery-absent-agent-probe')
    const unrelatedAgentDelivery = await agentProbe('unrelated-agent', 'delivery-unrelated-agent-probe')
    assert.equal(absentAgentDelivery.status, 403)
    assert.equal(unrelatedAgentDelivery.status, absentAgentDelivery.status)
    assert.deepEqual(await readJson(unrelatedAgentDelivery), await readJson(absentAgentDelivery))

    const ungrantedDeliveryCreate = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        deliveryId: 'delivery-ungranted-create',
        agentId,
        channelBindingId: secondChannelBinding.bindingId,
        sessionBindingId: secondWorkspaceSessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-ungranted-create' },
      }),
    })
    assert.equal(ungrantedDeliveryCreate.status, 403)

    const crossBindingDelivery = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        deliveryId: 'delivery-cross-binding-probe',
        agentId,
        channelBindingId: channelBinding.bindingId,
        sessionBindingId: secondWorkspaceSessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-cross-binding-probe' },
      }),
    })
    const absentSessionBindingDelivery = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        deliveryId: 'delivery-absent-binding-probe',
        agentId,
        channelBindingId: channelBinding.bindingId,
        sessionBindingId: 'absent-session-binding',
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-absent-binding-probe' },
      }),
    })
    assert.equal(crossBindingDelivery.status, 403)
    assert.equal(absentSessionBindingDelivery.status, crossBindingDelivery.status)
    assert.deepEqual(
      await readJson(absentSessionBindingDelivery),
      await readJson(crossBindingDelivery),
    )

    const mismatchedDelivery = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deliveryId: 'delivery-mismatch',
        agentId,
        channelBindingId: secondChannelBinding.bindingId,
        sessionBindingId: sessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-1' },
      }),
    })
    assert.equal(mismatchedDelivery.status, 403)

    const crossOrgDelivery = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers: tenant2Headers,
      body: JSON.stringify({
        deliveryId: 'delivery-cross-org',
        agentId,
        channelBindingId: channelBinding.bindingId,
        sessionBindingId: sessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-1' },
      }),
    })
    assert.equal(crossOrgDelivery.status, 403)

    const ungrantedListResponse = await fetch(
      `${baseUrl}/api/channels/deliveries?channelBindingId=${encodeURIComponent(String(secondChannelBinding.bindingId))}&limit=10`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(ungrantedListResponse.status, 403)
    const ungrantedStream = await fetch(
      `${baseUrl}/api/channels/deliveries/stream?claimedBy=test-gateway&channelBindingId=${encodeURIComponent(String(secondChannelBinding.bindingId))}`,
      {
        headers: gatewayOnlyHeaders,
      },
    )
    assert.equal(ungrantedStream.status, 403)

    const controller = new AbortController()
    const stream = await fetch(`${baseUrl}/api/channels/deliveries/stream?claimedBy=test-gateway`, {
      headers: gatewayOnlyHeaders,
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)
    const deliveryEvent = await readSseUntil(stream, (event) => (
      asRecord(event.delivery).deliveryId === 'delivery-1'
    ))
    controller.abort()
    assert.equal(asRecord(deliveryEvent.delivery).status, 'claimed')
    assert.equal(asRecord(deliveryEvent.delivery).claimedBy, 'test-gateway')
    assert.equal(asRecord(deliveryEvent.delivery).lastClaimedBy, gatewayOnlyIssued.token.tokenId)

    const ackResponse = await fetch(`${baseUrl}/api/channels/deliveries/delivery-1/ack`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({ status: 'sent', claimedBy: 'test-gateway' }),
    })
    assert.equal(ackResponse.status, 200)
    assert.equal(asRecord((await readJson(ackResponse)).delivery).status, 'sent')

    const defaultClaimantDeliveryResponse = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deliveryId: 'delivery-default-claimant',
        agentId,
        channelBindingId: channelBinding.bindingId,
        sessionBindingId: sessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-default-claimant' },
      }),
    })
    assert.equal(defaultClaimantDeliveryResponse.status, 201)
    const defaultController = new AbortController()
    const defaultStream = await fetch(`${baseUrl}/api/channels/deliveries/stream`, {
      headers: gatewayOnlyHeaders,
      signal: defaultController.signal,
    })
    assert.equal(defaultStream.status, 200)
    const defaultClaimantEvent = await readSseUntil(defaultStream, (event) => (
      asRecord(event.delivery).deliveryId === 'delivery-default-claimant'
    ))
    defaultController.abort()
    assert.equal(asRecord(defaultClaimantEvent.delivery).claimedBy, gatewayOnlyIssued.token.tokenId)
    assert.equal(asRecord(defaultClaimantEvent.delivery).lastClaimedBy, gatewayOnlyIssued.token.tokenId)
    const defaultClaimantAck = await fetch(`${baseUrl}/api/channels/deliveries/delivery-default-claimant/ack`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({ status: 'sent' }),
    })
    assert.equal(defaultClaimantAck.status, 200)

    const listedDeliveriesResponse = await fetch(`${baseUrl}/api/channels/deliveries?limit=10`, { headers })
    const listedDeliveries = await readJson(listedDeliveriesResponse)
    assert.equal(listedDeliveriesResponse.status, 200, JSON.stringify(listedDeliveries))
    assert.equal(
      asArray(listedDeliveries.deliveries).some((delivery) => asRecord(delivery).deliveryId === 'delivery-1'),
      true,
    )
    const gatewayListedDeliveries = await readJson(await fetch(`${baseUrl}/api/channels/deliveries?limit=10`, { headers: gatewayOnlyHeaders }))
    assert.equal(asArray(gatewayListedDeliveries.deliveries).some((delivery) => asRecord(delivery).deliveryId === 'delivery-1'), true)
    const otherGatewayListedDeliveries = await readJson(await fetch(`${baseUrl}/api/channels/deliveries?limit=10`, { headers: otherGatewayOnlyHeaders }))
    assert.equal(asArray(otherGatewayListedDeliveries.deliveries).some((delivery) => asRecord(delivery).deliveryId === 'delivery-1'), false)

    const otherGatewayRetry = await fetch(`${baseUrl}/api/channels/deliveries/delivery-1/retry`, {
      method: 'POST',
      headers: otherGatewayOnlyHeaders,
      body: JSON.stringify({}),
    })
    assert.equal(otherGatewayRetry.status, 404)

    const retryDelivery = await fetch(`${baseUrl}/api/channels/deliveries/delivery-1/retry`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({}),
    })
    assert.equal(retryDelivery.status, 200)
    assert.equal(asRecord((await readJson(retryDelivery)).delivery).status, 'failed')

    const tokenLikeErrorText = ['sk', 'production', 'secret', '1234567890'].join('-')
    const deadLetterDelivery = await fetch(`${baseUrl}/api/channels/deliveries/delivery-1/dead-letter`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({ lastError: `poison event token=${tokenLikeErrorText}` }),
    })
    assert.equal(deadLetterDelivery.status, 200)
    const deadDelivery = asRecord((await readJson(deadLetterDelivery)).delivery)
    assert.equal(deadDelivery.status, 'dead')
    assert.equal(String(deadDelivery.lastError).includes(tokenLikeErrorText), false)

    const adminDiagnostics = await fetch(`${baseUrl}/api/diagnostics`, { headers })
    assert.equal(adminDiagnostics.status, 403)
    const diagnostics = await readJson(await fetch(`${baseUrl}/api/diagnostics`, { headers: operatorHeaders }))
    assert.equal(diagnostics.redaction, 'secrets-redacted')
    assert.equal(asRecord(asRecord(diagnostics.gateway).agents).total, 2)
    assert.equal(asRecord(asRecord(diagnostics.gateway).deliveriesByStatus).dead, 1)
    assert.equal(asRecord(diagnostics.gateway).deliveriesByStatusScope, 'recent_deliveries')
    assert.equal(asRecord(diagnostics.gateway).deliverySampleLimit, 200)
    const diagnosticsText = JSON.stringify(diagnostics)
    assert.equal(diagnosticsText.includes(issued.plaintext), false)
    assert.equal(diagnosticsText.includes(operatorIssued.plaintext), false)
    assert.equal(diagnosticsText.includes(gatewayOnlyIssued.plaintext), false)
    assert.equal(diagnosticsText.includes(otherGatewayOnlyIssued.plaintext), false)
    assert.equal(diagnosticsText.includes(tokenLikeErrorText), false)
    assert.equal(diagnosticsText.includes('secret/telegram'), false)

    // Caller-supplied ids are idempotency seeds, never global storage
    // authority. Seed the raw values in another tenant, then prove the remote
    // API behaves like a fresh create and leaves those records untouched.
    const tenant2VictimAgent = store.createHeadlessAgent({
      agentId: 'cross-tenant-agent-seed',
      orgId: org2.orgId,
      tenantId: 'tenant-2',
      profileName: 'full',
      name: 'Tenant 2 victim agent',
    })
    const tenant2VictimBinding = store.createChannelBinding({
      bindingId: 'cross-tenant-binding-seed',
      orgId: org2.orgId,
      agentId: tenant2VictimAgent.agentId,
      provider: 'telegram',
      externalWorkspaceId: 'tenant-2-workspace',
      displayName: 'Tenant 2 victim binding',
    })
    store.createSession({
      tenantId: 'tenant-2',
      userId: account2.accountId,
      sessionId: 'tenant-2-interaction-session',
      opencodeSessionId: 'tenant-2-interaction-opencode-session',
      profileName: 'full',
    })
    const tenant2SessionBinding = store.bindChannelSession({
      bindingId: 'tenant-2-interaction-session-binding',
      orgId: org2.orgId,
      agentId: tenant2VictimAgent.agentId,
      channelBindingId: tenant2VictimBinding.bindingId,
      provider: 'telegram',
      externalWorkspaceId: 'tenant-2-workspace',
      externalChatId: 'tenant-2-chat',
      externalThreadId: 'tenant-2-thread',
      sessionId: 'tenant-2-interaction-session',
    })
    const tenant2VictimInteraction = await store.createChannelInteraction({
      interactionId: 'cross-tenant-interaction-seed',
      orgId: org2.orgId,
      agentId: tenant2VictimAgent.agentId,
      channelBindingId: tenant2VictimBinding.bindingId,
      sessionBindingId: tenant2SessionBinding.bindingId,
      sessionId: 'tenant-2-interaction-session',
      provider: 'telegram',
      kind: 'permission',
      targetId: 'tenant-2-permission',
      expiresAt: new Date(Date.now() + 60_000),
      tokenSecret: 'tenant-2-interaction-secret',
    })

    const collisionAgentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        agentId: tenant2VictimAgent.agentId,
        name: 'Tenant 1 collision-safe agent',
        profileName: 'full',
      }),
    })
    assert.equal(collisionAgentResponse.status, 201)
    const collisionAgent = asRecord((await readJson(collisionAgentResponse)).agent)
    assert.match(String(collisionAgent.agentId), /^channel_agent_/)
    assert.notEqual(collisionAgent.agentId, tenant2VictimAgent.agentId)

    const collisionBindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        bindingId: tenant2VictimBinding.bindingId,
        agentId,
        provider: 'telegram',
        externalWorkspaceId: 'bot-1',
        displayName: 'Tenant 1 collision-safe binding',
      }),
    })
    assert.equal(collisionBindingResponse.status, 201)
    const collisionBinding = asRecord((await readJson(collisionBindingResponse)).binding)
    assert.match(String(collisionBinding.bindingId), /^channel_binding_/)
    assert.notEqual(collisionBinding.bindingId, tenant2VictimBinding.bindingId)
    store.grantApiTokenChannelBinding({
      orgId: org.orgId,
      tokenId: issued.token.tokenId,
      channelBindingId: String(collisionBinding.bindingId),
    })

    const collisionInteractionResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interactionId: tenant2VictimInteraction.interaction.interactionId,
        agentId,
        sessionBindingId: sessionBinding.bindingId,
        sessionId: cloudSession.sessionId,
        provider: 'telegram',
        kind: 'permission',
        targetId: 'collision-safe-permission',
        createdByIdentityId: victimIdentity.identityId,
        tokenSecret: 'collision-safe-secret',
      }),
    })
    assert.equal(collisionInteractionResponse.status, 201)
    const collisionInteraction = asRecord((await readJson(collisionInteractionResponse)).interaction)
    assert.match(String(collisionInteraction.interactionId), /^channel_interaction_/)
    assert.notEqual(collisionInteraction.interactionId, tenant2VictimInteraction.interaction.interactionId)
    assert.equal(collisionInteraction.createdByIdentityId, null)

    const collisionSessionBindResponse = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: collisionBinding.bindingId,
        provider: 'telegram',
        externalChatId: 'collision-callback-chat',
        externalThreadId: 'collision-callback-thread',
      }),
    })
    assert.equal(collisionSessionBindResponse.status, 200)
    const collisionSessionBound = await readJson(collisionSessionBindResponse)
    const collisionSessionBinding = asRecord(collisionSessionBound.binding)
    const collisionCloudSession = asRecord(asRecord(collisionSessionBound.session).session)
    const createExternalInteraction = async (input: {
      interactionId: string
      sessionBindingId: string
      sessionId: string
      targetId: string
    }) => {
      const response = await fetch(`${baseUrl}/api/channels/interactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...input,
          externalInteractionId: 'shared-external-interaction-across-bindings',
          agentId,
          provider: 'telegram',
          kind: 'permission',
          tokenSecret: `${input.interactionId}-secret`,
        }),
      })
      assert.equal(response.status, 201)
      return asRecord((await readJson(response)).interaction)
    }
    const primaryExternalInteraction = await createExternalInteraction({
      interactionId: 'primary-shared-external-interaction',
      sessionBindingId: String(sessionBinding.bindingId),
      sessionId: String(cloudSession.sessionId),
      targetId: 'primary-shared-external-permission',
    })
    const collisionExternalInteraction = await createExternalInteraction({
      interactionId: 'collision-shared-external-interaction',
      sessionBindingId: String(collisionSessionBinding.bindingId),
      sessionId: String(collisionCloudSession.sessionId),
      targetId: 'collision-shared-external-permission',
    })
    assert.notEqual(primaryExternalInteraction.interactionId, collisionExternalInteraction.interactionId)
    const ambiguousExternalResolution = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        provider: 'telegram',
        externalInteractionId: 'shared-external-interaction-across-bindings',
        response: { allowed: true },
      }),
    })
    assert.equal(ambiguousExternalResolution.status, 404)
    const primaryExternalResolution = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        identityId: identity.identityId,
        provider: 'telegram',
        externalInteractionId: 'shared-external-interaction-across-bindings',
        response: { allowed: true },
      }),
    })
    assert.equal(primaryExternalResolution.status, 202)
    assert.equal(
      asRecord((await readJson(primaryExternalResolution)).interaction).interactionId,
      primaryExternalInteraction.interactionId,
    )

    // The same provider event and delivery ids remain independent across two
    // authorized bindings, and a mutation without a unique binding scope fails
    // closed instead of selecting one arbitrarily.
    const claimScopedProviderEvent = async (channelBindingId: string, claimedBy: string) => {
      const response = await fetch(`${baseUrl}/api/channels/provider-events/claim`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: 'telegram',
          providerInstanceId: 'telegram-shared-instance',
          channelBindingId,
          externalWorkspaceId: 'bot-1',
          providerEventId: 'provider-event-shared-across-bindings',
          eventType: 'message',
          claimedBy,
        }),
      })
      assert.equal(response.status, 200)
      return asRecord(await readJson(response))
    }
    const primaryScopedEvent = await claimScopedProviderEvent(String(channelBinding.bindingId), 'gateway-primary-scope')
    const collisionScopedEvent = await claimScopedProviderEvent(String(collisionBinding.bindingId), 'gateway-collision-scope')
    assert.equal(primaryScopedEvent.claimed, true)
    assert.equal(collisionScopedEvent.claimed, true)
    assert.notEqual(asRecord(primaryScopedEvent.event).eventId, asRecord(collisionScopedEvent.event).eventId)
    const wrongBindingCompletion = await fetch(
      `${baseUrl}/api/channels/provider-events/${encodeURIComponent(String(asRecord(primaryScopedEvent.event).eventId))}/complete`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          channelBindingId: collisionBinding.bindingId,
          claimedBy: 'gateway-primary-scope',
          status: 'processed',
        }),
      },
    )
    assert.equal(wrongBindingCompletion.status, 404)
    const correctBindingCompletion = await fetch(
      `${baseUrl}/api/channels/provider-events/${encodeURIComponent(String(asRecord(primaryScopedEvent.event).eventId))}/complete`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          channelBindingId: channelBinding.bindingId,
          claimedBy: 'gateway-primary-scope',
          status: 'processed',
        }),
      },
    )
    assert.equal(correctBindingCompletion.status, 200)

    const createScopedDelivery = async (channelBindingId: string, bindingMarker: string) => {
      const response = await fetch(`${baseUrl}/api/channels/deliveries`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          deliveryId: 'delivery-shared-across-bindings',
          agentId,
          channelBindingId,
          provider: 'telegram',
          target: { externalChatId: `chat-${bindingMarker}` },
          eventType: 'workflow.completed',
          payload: { bindingMarker },
        }),
      })
      assert.equal(response.status, 201)
      return asRecord((await readJson(response)).delivery)
    }
    const primaryScopedDelivery = await createScopedDelivery(String(channelBinding.bindingId), 'primary')
    const collisionScopedDelivery = await createScopedDelivery(String(collisionBinding.bindingId), 'collision')
    assert.deepEqual(primaryScopedDelivery.payload, { bindingMarker: 'primary' })
    assert.deepEqual(collisionScopedDelivery.payload, { bindingMarker: 'collision' })
    const primaryIssuedClaim = store.claimNextChannelDelivery({
      orgId: org.orgId,
      channelBindingIds: [String(channelBinding.bindingId)],
      claimedBy: 'issued-primary-claim',
      lastClaimedBy: issued.token.tokenId,
      now: new Date(Date.now() + 1_000),
    })
    const collisionIssuedClaim = store.claimNextChannelDelivery({
      orgId: org.orgId,
      channelBindingIds: [String(collisionBinding.bindingId)],
      claimedBy: 'issued-collision-claim',
      lastClaimedBy: issued.token.tokenId,
      now: new Date(Date.now() + 1_000),
    })
    assert.equal(primaryIssuedClaim?.deliveryId, 'delivery-shared-across-bindings')
    assert.equal(collisionIssuedClaim?.deliveryId, 'delivery-shared-across-bindings')
    const ambiguousDeliveryAck = await fetch(`${baseUrl}/api/channels/deliveries/delivery-shared-across-bindings/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status: 'sent' }),
    })
    assert.equal(ambiguousDeliveryAck.status, 404)
    const primaryScopedAck = await fetch(`${baseUrl}/api/channels/deliveries/delivery-shared-across-bindings/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        channelBindingId: channelBinding.bindingId,
        status: 'sent',
        claimedBy: 'issued-primary-claim',
      }),
    })
    assert.equal(primaryScopedAck.status, 200)
    assert.equal(asRecord((await readJson(primaryScopedAck)).delivery).channelBindingId, channelBinding.bindingId)
    const collisionScopedAck = await fetch(`${baseUrl}/api/channels/deliveries/delivery-shared-across-bindings/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        channelBindingId: collisionBinding.bindingId,
        status: 'sent',
        claimedBy: 'issued-collision-claim',
      }),
    })
    assert.equal(collisionScopedAck.status, 200)
    assert.equal(asRecord((await readJson(collisionScopedAck)).delivery).channelBindingId, collisionBinding.bindingId)

    const primaryScopedRetry = await fetch(`${baseUrl}/api/channels/deliveries/delivery-shared-across-bindings/retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ channelBindingId: channelBinding.bindingId }),
    })
    assert.equal(primaryScopedRetry.status, 200)
    assert.equal(asRecord((await readJson(primaryScopedRetry)).delivery).channelBindingId, channelBinding.bindingId)
    const collisionScopedRetry = await fetch(`${baseUrl}/api/channels/deliveries/delivery-shared-across-bindings/retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ channelBindingId: collisionBinding.bindingId }),
    })
    assert.equal(collisionScopedRetry.status, 200)
    assert.equal(asRecord((await readJson(collisionScopedRetry)).delivery).channelBindingId, collisionBinding.bindingId)
    const primaryScopedDeadLetter = await fetch(`${baseUrl}/api/channels/deliveries/delivery-shared-across-bindings/dead-letter`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        channelBindingId: channelBinding.bindingId,
        lastError: 'Scoped delivery rejected',
      }),
    })
    assert.equal(primaryScopedDeadLetter.status, 200)
    assert.equal(asRecord((await readJson(primaryScopedDeadLetter)).delivery).channelBindingId, channelBinding.bindingId)

    assert.deepEqual(store.getHeadlessAgent(org2.orgId, tenant2VictimAgent.agentId), tenant2VictimAgent)
    assert.deepEqual(store.getChannelBinding(org2.orgId, tenant2VictimBinding.bindingId), tenant2VictimBinding)
    assert.equal((await store.findChannelInteraction({
      orgId: org2.orgId,
      token: tenant2VictimInteraction.plaintextToken,
    }))?.interactionId, tenant2VictimInteraction.interaction.interactionId)
  } finally {
    await server.close()
  }
})

test('cloud HTTP session bind validates the row returned by the thread uniqueness race', async () => {
  const fixture = createFixture({ policy: policyWithRemoteApprovalResponses() })
  const baseUrl = await fixture.server.listen()
  const headers = { 'content-type': 'application/json' }
  const originalBindChannelSession = fixture.store.bindChannelSession.bind(fixture.store)

  try {
    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-session-bind-race',
        name: 'Session bind race agent',
        profileName: 'full',
      }),
    })
    assert.equal(agentResponse.status, 201)

    const createBinding = async (bindingId: string, displayName: string) => {
      const response = await fetch(`${baseUrl}/api/channels/bindings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          bindingId,
          agentId: 'agent-session-bind-race',
          provider: 'telegram',
          externalWorkspaceId: 'session-bind-race-workspace',
          displayName,
        }),
      })
      assert.equal(response.status, 201)
      return asRecord((await readJson(response)).binding)
    }
    const requestedBinding = await createBinding('binding-session-bind-race-requested', 'Requested binding')
    const winningBinding = await createBinding('binding-session-bind-race-winner', 'Concurrent winner binding')
    const identityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'session-bind-race-workspace',
        externalUserId: 'session-bind-race-user',
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(identityResponse.status, 200)
    const identity = asRecord((await readJson(identityResponse)).identity)

    // Simulate another writer winning the unique thread insert after this
    // request's preflight read. Both real stores return that conflict row.
    fixture.store.bindChannelSession = ((input) => originalBindChannelSession({
      ...input,
      bindingId: 'session-bind-race-winning-row',
      channelBindingId: String(winningBinding.bindingId),
    })) as typeof fixture.store.bindChannelSession

    const response = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: requestedBinding.bindingId,
        provider: 'telegram',
        externalChatId: 'session-bind-race-chat',
        externalThreadId: 'session-bind-race-thread',
      }),
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await readJson(response), {
      error: 'Channel thread is already bound to a different channel authority.',
    })
    assert.equal(fixture.store.findChannelSessionBindingByThread({
      orgId: 'tenant-1',
      provider: 'telegram',
      externalWorkspaceId: 'session-bind-race-workspace',
      externalChatId: 'session-bind-race-chat',
      externalThreadId: 'session-bind-race-thread',
    })?.channelBindingId, winningBinding.bindingId)
  } finally {
    fixture.store.bindChannelSession = originalBindChannelSession
    await fixture.server.close()
  }
})

test('cloud HTTP interaction resolution hides token existence from missing and unauthorized actors', async () => {
  const fixture = createFixture({ policy: policyWithRemoteApprovalResponses() })
  const baseUrl = await fixture.server.listen()
  const headers = { 'content-type': 'application/json' }

  try {
    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-interaction-oracle',
        name: 'Interaction Oracle',
        profileName: 'full',
      }),
    })
    assert.equal(agentResponse.status, 201)

    const bindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bindingId: 'binding-interaction-oracle',
        agentId: 'agent-interaction-oracle',
        provider: 'telegram',
        externalWorkspaceId: 'bot-interaction-oracle',
        displayName: 'Telegram',
        status: 'active',
      }),
    })
    assert.equal(bindingResponse.status, 201)
    const binding = asRecord((await readJson(bindingResponse)).binding)

    const actorResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-interaction-oracle',
        externalUserId: 'interaction-actor',
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(actorResponse.status, 200)
    const actor = asRecord((await readJson(actorResponse)).identity)

    const unauthorizedActorResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-interaction-oracle-other',
        externalUserId: 'interaction-bystander',
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(unauthorizedActorResponse.status, 200)
    const unauthorizedActor = asRecord((await readJson(unauthorizedActorResponse)).identity)

    const bindResponse = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: actor.identityId,
        channelBindingId: binding.bindingId,
        provider: 'telegram',
        externalChatId: 'interaction-chat',
        externalThreadId: 'interaction-thread',
        title: 'Interaction oracle regression',
      }),
    })
    assert.equal(bindResponse.status, 200)
    const bound = await readJson(bindResponse)
    const sessionBinding = asRecord(bound.binding)
    const cloudSession = asRecord(asRecord(bound.session).session)

    const interactions = [{
      kind: 'permission',
      interactionId: 'interaction-oracle-permission',
      targetId: 'permission-oracle',
      resolution: { response: { allowed: true } },
    }, {
      kind: 'question',
      interactionId: 'interaction-oracle-question',
      targetId: 'question-oracle',
      resolution: { answers: ['Ship it'] },
    }] as const

    for (const interaction of interactions) {
      const createResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          interactionId: interaction.interactionId,
          agentId: 'agent-interaction-oracle',
          sessionBindingId: sessionBinding.bindingId,
          sessionId: cloudSession.sessionId,
          provider: 'telegram',
          kind: interaction.kind,
          targetId: interaction.targetId,
          tokenSecret: `${interaction.kind}-secret`,
        }),
      })
      assert.equal(createResponse.status, 201)
      const issued = await readJson(createResponse)

      const absentTokenResponse = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          identityId: actor.identityId,
          token: `occi_absent-${interaction.kind}_missing`,
          ...interaction.resolution,
        }),
      })
      const absentTokenBody = await readJson(absentTokenResponse)
      assert.equal(absentTokenResponse.status, 404)
      assert.deepEqual(absentTokenBody, {
        error: 'Channel interaction was not found or is no longer pending.',
      })

      const expiredCreateResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          interactionId: `${interaction.interactionId}-expired`,
          agentId: 'agent-interaction-oracle',
          sessionBindingId: sessionBinding.bindingId,
          sessionId: cloudSession.sessionId,
          provider: 'telegram',
          kind: interaction.kind,
          targetId: `${interaction.targetId}-expired`,
          tokenSecret: `${interaction.kind}-expired-secret`,
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      })
      assert.equal(expiredCreateResponse.status, 201)
      const expiredInteraction = await readJson(expiredCreateResponse)
      const expiredTokenResponse = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          identityId: actor.identityId,
          token: expiredInteraction.plaintextToken,
          ...interaction.resolution,
        }),
      })
      assert.equal(expiredTokenResponse.status, absentTokenResponse.status)
      assert.deepEqual(await readJson(expiredTokenResponse), absentTokenBody)

      const missingActorResponse = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          token: issued.plaintextToken,
          ...interaction.resolution,
        }),
      })
      assert.equal(missingActorResponse.status, absentTokenResponse.status)
      assert.deepEqual(await readJson(missingActorResponse), absentTokenBody)

      const unauthorizedActorResolution = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          identityId: unauthorizedActor.identityId,
          token: issued.plaintextToken,
          ...interaction.resolution,
        }),
      })
      assert.equal(unauthorizedActorResolution.status, absentTokenResponse.status)
      assert.deepEqual(await readJson(unauthorizedActorResolution), absentTokenBody)

      const authorizedResolution = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          identityId: actor.identityId,
          token: issued.plaintextToken,
          ...interaction.resolution,
        }),
      })
      assert.equal(authorizedResolution.status, 202)
    }
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP channel interaction callbacks acknowledge accepted runtime-processing failures', async () => {
  const fixture = createFixture({ policy: policyWithRemoteApprovalResponses() })
  fixture.runtime.respondToPermission = async (input) => {
    throw new Error(`Permission request not found: ${input.permissionId}`)
  }
  const baseUrl = await fixture.server.listen()
  const headers = { 'content-type': 'application/json' }

  try {
    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-callback-processing',
        name: 'Callback Processing',
        profileName: 'full',
      }),
    })
    assert.equal(agentResponse.status, 201)

    const bindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bindingId: 'binding-callback-processing',
        agentId: 'agent-callback-processing',
        provider: 'telegram',
        displayName: 'Telegram',
        status: 'active',
      }),
    })
    assert.equal(bindingResponse.status, 201)
    const binding = asRecord((await readJson(bindingResponse)).binding)

    const identityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalUserId: 'callback-user',
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(identityResponse.status, 200)
    const identity = asRecord((await readJson(identityResponse)).identity)

    const bindResponse = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: binding.bindingId,
        provider: 'telegram',
        externalChatId: 'callback-chat',
        externalThreadId: 'callback-thread',
        title: 'Callback processing',
      }),
    })
    assert.equal(bindResponse.status, 200)
    const cloudSession = asRecord(asRecord((await readJson(bindResponse)).session).session)

    const interactionResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interactionId: 'interaction-callback-processing',
        agentId: 'agent-callback-processing',
        sessionId: cloudSession.sessionId,
        provider: 'telegram',
        kind: 'permission',
        targetId: 'permission-missing',
        tokenSecret: 'callback-secret',
      }),
    })
    assert.equal(interactionResponse.status, 201)
    const issuedInteraction = await readJson(interactionResponse)

    const approvalResponse = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        token: issuedInteraction.plaintextToken,
        response: { allowed: true },
      }),
    })
    assert.equal(approvalResponse.status, 202)
    const approval = await readJson(approvalResponse)
    assert.equal(asRecord(approval.command).kind, 'permission.respond')
    assert.equal(approval.processed, 0)
    assert.match(String(approval.processingError), /Permission request not found: permission-missing/)
    assert.equal(asRecord(approval.interaction).status, 'used')
    assert.equal(approval.projectionFence, null)

    const view = asRecord(asRecord(approval.view).projection).view
    assert.match(String(asRecord(view).lastError), /Permission request not found: permission-missing/)
    assert.deepEqual(fixture.runtime.permissions, [])
  } finally {
    await fixture.server.close()
  }
})
