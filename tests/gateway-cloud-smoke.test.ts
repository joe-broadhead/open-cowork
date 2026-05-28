import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../apps/desktop/src/main/config-types.ts'
import { createApiTokenCloudAuthResolver } from '../apps/desktop/src/main/cloud/app.ts'
import { resolveCloudRuntimePolicy } from '../apps/desktop/src/main/cloud/cloud-config.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/control-plane-store.ts'
import { createCloudHttpServer } from '../apps/desktop/src/main/cloud/http-server.ts'
import type { CloudRuntimeAdapter, CloudRuntimePromptPart } from '../apps/desktop/src/main/cloud/runtime-adapter.ts'
import { CloudSessionService } from '../apps/desktop/src/main/cloud/session-service.ts'
import { CloudWorker } from '../apps/desktop/src/main/cloud/worker.ts'
import { createCloudGateway, createGatewayDaemon, resolveGatewayConfig } from '../apps/gateway/dist/index.js'

class FakeRuntime implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string, parts: CloudRuntimePromptPart[], agent: string }> = []
  aborted: string[] = []
  permissions: Array<{ permissionId: string, allowed: boolean }> = []
  questionReplies: Array<{ requestId: string, answers: unknown[] }> = []
  questionRejections: string[] = []
  private nextSession = 0

  async createSession() {
    this.nextSession += 1
    return {
      id: `opencode-session-${this.nextSession}`,
      title: `Session ${this.nextSession}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.prompts.push(input)
    return {
      events: [{
        type: 'assistant.message',
        payload: {
          sessionId: input.sessionId,
          messageId: `${input.sessionId}:assistant:${this.prompts.length}`,
          content: 'gateway smoke response',
        },
      }, {
        type: 'permission.requested',
        payload: {
          sessionId: input.sessionId,
          permissionId: `${input.sessionId}:permission:${this.prompts.length}`,
          title: 'Approve smoke permission',
          description: 'Allow the fake runtime action?',
        },
      }, {
        type: 'session.idle',
        payload: { sessionId: input.sessionId },
      }],
    }
  }

  async abortSession(input: { sessionId: string }) {
    this.aborted.push(input.sessionId)
  }

  async respondToPermission(input: { permissionId: string, allowed: boolean }) {
    this.permissions.push(input)
  }

  async replyToQuestion(input: { requestId: string, answers: unknown[] }) {
    this.questionReplies.push(input)
  }

  async rejectQuestion(input: { requestId: string }) {
    this.questionRejections.push(input.requestId)
  }
}

async function readJson(response: Response) {
  return JSON.parse(await response.text()) as Record<string, unknown>
}

function waitFor<T>(setup: (resolve: (value: T) => void, reject: (error: unknown) => void) => { close(): void } | undefined, timeoutMs = 1000) {
  let subscription: { close(): void } | undefined
  return {
    promise: new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for gateway smoke event.')), timeoutMs)
      timer.unref()
      subscription = setup((value) => {
        clearTimeout(timer)
        resolve(value)
      }, (error) => {
        clearTimeout(timer)
        reject(error)
      })
    }),
    close() {
      subscription?.close()
    },
  }
}

test('gateway daemon prompts an in-process cloud session through fake provider webhook', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  const account = store.createAccount({
    accountId: 'account-1',
    idpSubject: 'subject-1',
    email: 'owner@example.test',
  })
  store.ensureUser({ tenantId: 'tenant-1', userId: account.accountId, email: account.email, role: 'admin' })
  store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'admin',
    status: 'active',
  })
  const issued = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Gateway smoke token',
    scopes: ['gateway', 'admin'],
  })

  const runtime = new FakeRuntime()
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const service = new CloudSessionService(store, runtime, policy)
  const worker = new CloudWorker(store, service, 'worker-1')
  const cloud = createCloudHttpServer({
    service,
    worker,
    policy,
    auth: createApiTokenCloudAuthResolver(store),
    autoProcessCommands: true,
    ssePollMs: 10,
  })
  const cloudUrl = await cloud.listen()
  const headers = {
    authorization: `Bearer ${issued.plaintext}`,
    'content-type': 'application/json',
  }

  try {
    assert.equal((await fetch(`${cloudUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-1',
        name: 'Fake gateway agent',
        profileName: 'full',
      }),
    })).status, 201)
    assert.equal((await fetch(`${cloudUrl}/api/channels/bindings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bindingId: 'fake-binding',
        agentId: 'agent-1',
        provider: 'cli',
        displayName: 'Fake provider',
      }),
    })).status, 201)
    assert.equal((await fetch(`${cloudUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'cli',
        externalUserId: 'user-1',
        role: 'member',
        status: 'active',
      }),
    })).status, 200)

    const gatewayConfig = resolveGatewayConfig({
      cloud: {
        baseUrl: cloudUrl,
        serviceToken: issued.plaintext,
      },
      server: {
        port: 0,
      },
      providers: [{
        id: 'fake',
        kind: 'fake',
        channelBindingId: 'fake-binding',
      }],
    })
    const cloudGateway = createCloudGateway(gatewayConfig)
    const identity = await cloudGateway.resolveIdentity({
      provider: 'cli',
      externalUserId: 'user-1',
    })
    const bound = await cloudGateway.bindSession({
      identityId: identity.identityId,
      provider: 'cli',
      externalUserId: 'user-1',
      channelBindingId: 'fake-binding',
      externalChatId: 'chat-wrapper',
      externalThreadId: 'thread-wrapper',
      title: 'Wrapper smoke',
    })
    assert.equal(bound.binding.channelBindingId, 'fake-binding')
    assert.equal((await cloudGateway.findSessionByThread({
      provider: 'cli',
      externalChatId: 'chat-wrapper',
      externalThreadId: 'thread-wrapper',
    }))?.binding.bindingId, bound.binding.bindingId)

    const sessionEvent = waitFor((resolve, reject) => cloudGateway.subscribeSessionEvents({
      sessionId: bound.session.session.sessionId,
      afterSequence: 0,
      onEvent: (event) => {
        if (event.type === 'assistant.message') resolve(event)
      },
      onError: reject,
    }))
    await cloudGateway.prompt({
      bindingId: bound.binding.bindingId,
      identityId: identity.identityId,
      provider: 'cli',
      externalUserId: 'user-1',
      text: 'real cloud wrapper prompt',
    })
    const assistantEvent = await sessionEvent.promise
    sessionEvent.close()
    const wrapperRuntimeSessionId = runtime.prompts.at(-1)?.sessionId
    assert.equal(assistantEvent.payload.content, 'gateway smoke response')

    const cursor = await cloudGateway.updateCursor({
      bindingId: bound.binding.bindingId,
      lastEventSequence: assistantEvent.sequence,
      lastWorkspaceSequence: 0,
      lastChatMessageId: 'chat-message-1',
    })
    assert.equal(cursor?.lastChatMessageId, 'chat-message-1')

    await cloudGateway.respondToPermission(bound.session.session.sessionId, {
      permissionId: 'permission-wrapper',
      response: { allowed: true },
    })
    await cloudGateway.replyToQuestion(bound.session.session.sessionId, {
      requestId: 'question-wrapper',
      answers: ['yes'],
    })
    await cloudGateway.rejectQuestion(bound.session.session.sessionId, {
      requestId: 'question-reject-wrapper',
    })
    await cloudGateway.abortSession(bound.session.session.sessionId)
    assert.deepEqual(runtime.permissions, [{ permissionId: 'permission-wrapper', allowed: true }])
    assert.deepEqual(runtime.questionReplies, [{ requestId: 'question-wrapper', answers: ['yes'] }])
    assert.deepEqual(runtime.questionRejections, ['question-reject-wrapper'])
    assert.deepEqual(runtime.aborted, [wrapperRuntimeSessionId])

    const interactionResponse = await fetch(`${cloudUrl}/api/channels/interactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interactionId: 'interaction-wrapper',
        agentId: 'agent-1',
        sessionId: bound.session.session.sessionId,
        provider: 'cli',
        kind: 'permission',
        targetId: 'permission-interaction-wrapper',
        tokenSecret: 'test-secret',
      }),
    })
    assert.equal(interactionResponse.status, 201)
    const interaction = await readJson(interactionResponse)
    await cloudGateway.resolveChannelInteraction({
      identityId: identity.identityId,
      provider: 'cli',
      externalUserId: 'user-1',
      token: String(interaction.plaintextToken),
      response: { allowed: false },
    })
    assert.deepEqual(runtime.permissions.at(-1), { permissionId: 'permission-interaction-wrapper', allowed: false })

    const deliveryEvent = waitFor((resolve, reject) => cloudGateway.subscribeDeliveries({
      claimedBy: 'gateway-wrapper-smoke',
      ttlMs: 5_000,
      onDelivery: resolve,
      onError: reject,
    }))
    const deliveryResponse = await fetch(`${cloudUrl}/api/channels/deliveries`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deliveryId: 'delivery-wrapper',
        agentId: 'agent-1',
        channelBindingId: 'fake-binding',
        sessionBindingId: bound.binding.bindingId,
        provider: 'cli',
        target: { externalChatId: 'chat-wrapper', externalThreadId: 'thread-wrapper' },
        eventType: 'workflow.completed',
        payload: { text: 'done' },
      }),
    })
    assert.equal(deliveryResponse.status, 201)
    const delivery = await deliveryEvent.promise
    deliveryEvent.close()
    assert.equal(delivery.deliveryId, 'delivery-wrapper')
    assert.equal((await cloudGateway.ackDelivery(delivery.deliveryId, {
      claimedBy: 'gateway-wrapper-smoke',
      status: 'sent',
    }))?.status, 'sent')

    const gateway = createGatewayDaemon(resolveGatewayConfig({
      cloud: {
        baseUrl: cloudUrl,
        serviceToken: issued.plaintext,
      },
      server: {
        port: 0,
      },
      providers: [{
        id: 'fake',
        kind: 'fake',
        channelBindingId: 'fake-binding',
      }],
    }))
    const promptsBeforeDaemon = runtime.prompts.length
    const gatewayUrl = await gateway.start()
    const fakeProvider = gateway.runtime.providers.get('fake')?.provider as {
      sent: Array<{ text?: string, buttons?: Array<Array<{ token: string }>> }>
      answered: Array<{ interactionId: string, text?: string }>
    } | undefined
    assert.ok(fakeProvider)

    try {
      assert.equal((await fetch(`${gatewayUrl}/health`)).status, 200)
      assert.equal((await fetch(`${gatewayUrl}/ready`)).status, 200)
      const prompt = await fetch(`${gatewayUrl}/webhooks/fake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'summarize this repo',
          chatId: 'chat-1',
          userId: 'user-1',
        }),
      })
      assert.equal(prompt.status, 202)
      assert.equal(runtime.prompts.length, promptsBeforeDaemon + 1)
      assert.equal(runtime.prompts.at(-1)?.parts.find((part) => part.type === 'text')?.text, 'summarize this repo')
      await waitUntil(() => fakeProvider.sent.some((entry) => entry.text === 'gateway smoke response'))
      await waitUntil(() => fakeProvider.sent.some((entry) => entry.buttons))
      const approveToken = fakeProvider.sent.find((entry) => entry.buttons)?.buttons?.[0]?.[0]?.token
      assert.ok(approveToken)

      const approval = await fetch(`${gatewayUrl}/webhooks/fake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: approveToken,
          chatId: 'chat-1',
          userId: 'user-1',
          interaction: {
            id: 'fake-callback-1',
            token: approveToken,
            kind: 'button',
          },
        }),
      })
      assert.equal(approval.status, 202)
      await waitUntil(() => runtime.permissions.some((permission) => permission.allowed))
      assert.equal(fakeProvider.answered.at(-1)?.interactionId, 'fake-callback-1')
    } finally {
      await gateway.stop()
    }
  } finally {
    await cloud.close()
  }
})

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for gateway smoke predicate.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
