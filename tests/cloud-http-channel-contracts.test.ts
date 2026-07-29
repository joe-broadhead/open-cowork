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
  const gatewayOnlyHeaders = {
    authorization: `Bearer ${gatewayOnlyIssued.plaintext}`,
    'content-type': 'application/json',
  }
  const otherGatewayOnlyHeaders = {
    authorization: `Bearer ${otherGatewayOnlyIssued.plaintext}`,
    'content-type': 'application/json',
  }
  const tenant2Headers = {
    authorization: `Bearer ${issuedTenant2.plaintext}`,
    'content-type': 'application/json',
  }
  const operatorHeaders = {
    authorization: `Bearer ${operatorIssued.plaintext}`,
    'content-type': 'application/json',
  }
  try {
    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-1',
        name: 'Data analyst',
        profileName: 'data-analyst',
      }),
    })
    assert.equal(agentResponse.status, 201)
    assert.equal(asRecord((await readJson(agentResponse)).agent).agentId, 'agent-1')

    const bindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bindingId: 'telegram-binding',
        agentId: 'agent-1',
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

    const updateBindingResponse = await fetch(`${baseUrl}/api/channels/bindings/telegram-binding`, {
      method: 'PATCH',
      headers,
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

    const tenant2Bindings = await readJson(await fetch(`${baseUrl}/api/channels/bindings`, { headers: tenant2Headers }))
    assert.deepEqual(asArray(tenant2Bindings.bindings), [])

    const identityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
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

    const wrongWorkspaceIdentityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
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
    assert.equal(wrongWorkspaceIdentityResponse.status, 200)
    const wrongWorkspaceIdentity = asRecord((await readJson(wrongWorkspaceIdentityResponse)).identity)

    const secondBindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bindingId: 'telegram-binding-2',
        agentId: 'agent-1',
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
      tokenId: gatewayOnlyIssued.token.tokenId,
      channelBindingId: String(channelBinding.bindingId),
    })
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

    const grantedGatewaySessionRead = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(String(cloudSession.sessionId))}`, {
      headers: gatewayOnlyHeaders,
    })
    assert.equal(grantedGatewaySessionRead.status, 200)

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
    assert.match(String(asRecord(await readJson(ungrantedGatewayBind)).error), /not authorized/)

    const ungrantedGatewayThreadLookup = await fetch(
      `${baseUrl}/api/channels/sessions/by-thread?provider=telegram&externalWorkspaceId=bot-2&externalChatId=chat-1&externalThreadId=thread-1`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(ungrantedGatewayThreadLookup.status, 403)
    assert.match(String(asRecord(await readJson(ungrantedGatewayThreadLookup)).error), /not authorized/)

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
    assert.match(String(asRecord(await readJson(ungrantedGatewayPrompt)).error), /not authorized/)

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
    assert.match(String(asRecord(await readJson(ungrantedGatewayCursor)).error), /not authorized/)

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
    assert.match(String(asRecord(await readJson(ungrantedGatewayIdentity)).error), /not authorized/)

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
    assert.match(String(asRecord(await readJson(ungrantedProviderEventClaim)).error), /not authorized/)

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
    assert.match(String(asRecord(await readJson(ungrantedProviderEventComplete)).error), /not authorized/)

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

    const wrongWorkspacePrompt = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: wrongWorkspaceIdentity.identityId,
        bindingId: sessionBinding.bindingId,
        text: 'should not run',
      }),
    })
    assert.equal(wrongWorkspacePrompt.status, 403)

    const promptResponse = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        bindingId: sessionBinding.bindingId,
        text: 'summarize revenue',
        agent: 'data-analyst',
      }),
    })
    assert.equal(promptResponse.status, 202)
    const channelPrompt = await readJson(promptResponse)
    assert.equal(channelPrompt.processed, 1)
    assert.equal(asRecord(channelPrompt.projectionFence).scope, 'session')
    assert.equal(asRecord(channelPrompt.projectionFence).sessionId, cloudSession.sessionId)
    assert.equal(asRecord(channelPrompt.projectionFence).commandId, asRecord(channelPrompt.command).commandId)
    assert.equal(runtime.prompts[0]?.agent, 'data-analyst')

    const interactionResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interactionId: 'interaction-1',
        agentId: 'agent-1',
        sessionId: cloudSession.sessionId,
        provider: 'telegram',
        kind: 'permission',
        targetId: 'permission-1',
        tokenSecret: 'test-secret',
      }),
    })
    assert.equal(interactionResponse.status, 201)
    const issuedInteraction = await readJson(interactionResponse)
    assert.equal(typeof issuedInteraction.plaintextToken, 'string')
    assert.equal('tokenHash' in asRecord(issuedInteraction.interaction), false)

    const serviceTokenOnlyApproval = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token: issuedInteraction.plaintextToken,
        response: { allowed: true },
      }),
    })
    assert.equal(serviceTokenOnlyApproval.status, 403)

    const wrongWorkspaceApproval = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: wrongWorkspaceIdentity.identityId,
        token: issuedInteraction.plaintextToken,
        response: { allowed: true },
      }),
    })
    assert.equal(wrongWorkspaceApproval.status, 403)

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
        agentId: 'agent-1',
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
        agentId: 'agent-1',
        channelBindingId: channelBinding.bindingId,
        sessionBindingId: sessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-1' },
      }),
    })
    assert.equal(deliveryResponse.status, 201)

    const ungrantedDeliveryCreate = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        deliveryId: 'delivery-ungranted-create',
        agentId: 'agent-1',
        channelBindingId: secondChannelBinding.bindingId,
        sessionBindingId: secondWorkspaceSessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-ungranted-create' },
      }),
    })
    assert.equal(ungrantedDeliveryCreate.status, 403)

    const mismatchedDelivery = await fetch(`${baseUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deliveryId: 'delivery-mismatch',
        agentId: 'agent-1',
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
        agentId: 'agent-1',
        channelBindingId: channelBinding.bindingId,
        sessionBindingId: sessionBinding.bindingId,
        provider: 'telegram',
        target: { externalChatId: 'chat-1', externalThreadId: 'thread-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-1' },
      }),
    })
    assert.equal(crossOrgDelivery.status, 404)

    const ungrantedListResponse = await fetch(
      `${baseUrl}/api/channels/deliveries?channelBindingId=${encodeURIComponent(String(secondChannelBinding.bindingId))}&limit=10`,
      { headers: gatewayOnlyHeaders },
    )
    assert.equal(ungrantedListResponse.status, 403)
    const ungrantedController = new AbortController()
    const ungrantedStream = await fetch(
      `${baseUrl}/api/channels/deliveries/stream?claimedBy=test-gateway&channelBindingId=${encodeURIComponent(String(secondChannelBinding.bindingId))}`,
      {
        headers: gatewayOnlyHeaders,
        signal: ungrantedController.signal,
      },
    )
    assert.equal(ungrantedStream.status, 200)
    const ungrantedEvent = await readSseUntil(ungrantedStream, (event) => typeof event.error === 'string')
    ungrantedController.abort()
    assert.match(String(ungrantedEvent.error), /not authorized/)

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
        agentId: 'agent-1',
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

    const listedDeliveries = await readJson(await fetch(`${baseUrl}/api/channels/deliveries?limit=10`, { headers }))
    assert.equal(asArray(listedDeliveries.deliveries).some((delivery) => asRecord(delivery).deliveryId === 'delivery-1'), true)
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
    assert.equal(asRecord(asRecord(diagnostics.gateway).agents).total, 1)
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
  } finally {
    await server.close()
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
