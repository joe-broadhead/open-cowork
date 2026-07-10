import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import {
  createApiTokenCloudAuthResolver,
  createCompositeCloudAuthResolver,
  createLocalCloudAuthResolver,
} from '@open-cowork/cloud-server/app'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createCloudHttpServer } from '@open-cowork/cloud-server/http-server'
import type { CloudRuntimeAdapter, CloudRuntimeEvent, CloudRuntimePromptPart } from '@open-cowork/cloud-server/runtime-adapter'
import { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import { CloudWorker } from '@open-cowork/cloud-server/worker'
import { createCloudGateway, createGatewayDaemon, resolveGatewayCloudConnection, resolveGatewayConfig } from '../apps/gateway/dist/index.js'

function gatewayPolicy() {
  return {
    ...resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    allowRemoteApprovalResponses: true,
  }
}

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
    this.prompts.push({ sessionId: input.sessionId, parts: input.parts, agent: input.agent })
    const events: CloudRuntimeEvent[] = [{
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
    }]
    return {
      events,
    }
  }

  async abortSession(input: { sessionId: string }) {
    this.aborted.push(input.sessionId)
  }

  async respondToPermission(input: { permissionId: string, allowed: boolean }) {
    this.permissions.push({ permissionId: input.permissionId, allowed: input.allowed })
  }

  async replyToQuestion(input: { requestId: string, answers: unknown[] }) {
    this.questionReplies.push({ requestId: input.requestId, answers: input.answers })
  }

  async rejectQuestion(input: { requestId: string }) {
    this.questionRejections.push(input.requestId)
  }
}

async function readJson(response: Response) {
  return JSON.parse(await response.text()) as Record<string, unknown>
}

async function runGatewayCloudSmokeScript(input: {
  cloudUrl: string
  adminToken: string
  prompt: string
  timeoutMs?: number
  skipTokenRevocation?: boolean
}) {
  const args = [
    'scripts/gateway-cloud-smoke.mjs',
    '--cloud-url',
    input.cloudUrl,
    '--allow-insecure-http',
    '--timeout-ms',
    String(input.timeoutMs ?? 5_000),
  ]
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN: input.adminToken,
      OPEN_COWORK_GATEWAY_SMOKE_PROMPT: input.prompt,
      ...(input.skipTokenRevocation ? { OPEN_COWORK_GATEWAY_SMOKE_SKIP_TOKEN_REVOCATION: 'true' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Gateway cloud smoke script timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 25_000)
    timer.unref()
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  return { exitCode, stdout, stderr }
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
  const issued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Gateway smoke token',
    scopes: ['gateway', 'admin'],
  })

  const runtime = new FakeRuntime()
  const policy = gatewayPolicy()
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

    const gatewayEnv = {
      OPEN_COWORK_CLOUD_BASE_URL: cloudUrl,
      OPEN_COWORK_GATEWAY_SERVICE_TOKEN: issued.plaintext,
    }
    const _gatewayConfig = resolveGatewayConfig({
      server: {
        adminToken: 'gateway-cloud-smoke-admin-token',
        port: 0,
      },
      providers: [{
        id: 'fake',
        kind: 'fake',
        channelBindingId: 'fake-binding',
      }],
    }, gatewayEnv)
    const cloudGateway = createCloudGateway(resolveGatewayCloudConnection(gatewayEnv))
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

    const sessionEvent = waitFor<{ sequence: number, payload: { content?: unknown } }>((resolve, reject) => cloudGateway.subscribeSessionEvents({
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
    assert.equal(cursor.ok, true)
    if (!cursor.ok) assert.fail(`Expected cursor update to succeed, got ${cursor.reason}`)
    assert.equal(cursor.binding.lastChatMessageId, 'chat-message-1')

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

    const deliveryEvent = waitFor<{ deliveryId: string, claimedBy: string | null }>((resolve, reject) => cloudGateway.subscribeDeliveries({
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
    assert.equal(typeof delivery.claimedBy, 'string')
    assert.equal((await cloudGateway.ackDelivery(delivery.deliveryId, {
      claimedBy: String(delivery.claimedBy),
      status: 'sent',
    }))?.status, 'sent')

    const daemonGatewayConfig = resolveGatewayConfig({
      server: {
        adminToken: 'gateway-cloud-smoke-admin-token',
        port: 0,
      },
      providers: [{
        id: 'fake',
        kind: 'fake',
        channelBindingId: 'fake-binding',
      }],
    }, gatewayEnv)
    const gateway = createGatewayDaemon(daemonGatewayConfig, createCloudGateway(resolveGatewayCloudConnection(gatewayEnv)))
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

test('gateway cloud smoke script validates self-host gateway against deployed cloud control plane', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-smoke', name: 'Tenant Smoke' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-smoke', name: 'Tenant Smoke' })
  const account = store.createAccount({
    accountId: 'account-smoke',
    idpSubject: 'subject-smoke',
    email: 'owner-smoke@example.test',
  })
  store.ensureUser({ tenantId: 'tenant-smoke', userId: account.accountId, email: account.email, role: 'admin' })
  store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'admin',
    status: 'active',
  })
  const issued = await store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Gateway smoke admin token',
    scopes: ['admin', 'gateway'],
  })

  const runtime = new FakeRuntime()
  const policy = gatewayPolicy()
  const service = new CloudSessionService(store, runtime, policy)
  const worker = new CloudWorker(store, service, 'worker-smoke')
  const cloud = createCloudHttpServer({
    service,
    worker,
    policy,
    auth: createApiTokenCloudAuthResolver(store),
    autoProcessCommands: true,
    ssePollMs: 10,
  })
  const cloudUrl = await cloud.listen()
  const prompt = 'gateway deployment smoke fixture'

  try {
    const result = await runGatewayCloudSmokeScript({
      cloudUrl,
      adminToken: issued.plaintext,
      prompt,
    })
    assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.equal(result.stdout.includes(issued.plaintext), false)
    assert.equal(result.stderr.includes(issued.plaintext), false)

    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      results: {
        cloudSetup: {
          gatewayTokenScope: string
          leastPrivilegeChecks: string[]
        }
        selfHost: {
          prompt: {
            commandAccepted: boolean
            projection: {
              messages: number
            }
          }
          interaction: {
            acknowledged: boolean
          }
          delivery: {
            status: string
            retryInitialStatus: string
            retryStatus: string
            deadLetterStatus: string
            gatewayOperatorRetryStatus: number
            gatewayOperatorDeadLetterStatus: number
          }
          operatorEndpoints: {
            metrics: string
            diagnostics: string
          }
        }
        tokenRevocation: {
          rejected: boolean
        }
      }
    }
    assert.equal(payload.ok, true)
    assert.equal(payload.results.cloudSetup.gatewayTokenScope, 'gateway')
    assert.deepEqual(payload.results.cloudSetup.leastPrivilegeChecks, [
      'channel_admin_forbidden',
      'api_token_admin_forbidden',
    ])
    assert.equal(payload.results.selfHost.prompt.commandAccepted, true)
    assert.equal(payload.results.selfHost.prompt.projection.messages > 0, true)
    assert.equal(payload.results.selfHost.interaction.acknowledged, true)
    assert.equal(payload.results.selfHost.delivery.status, 'sent')
    assert.equal(payload.results.selfHost.delivery.retryInitialStatus, 'failed')
    assert.equal(payload.results.selfHost.delivery.retryStatus, 'sent')
    assert.equal(payload.results.selfHost.delivery.deadLetterStatus, 'dead')
    assert.equal(payload.results.selfHost.delivery.gatewayOperatorRetryStatus, 200)
    assert.equal(payload.results.selfHost.delivery.gatewayOperatorDeadLetterStatus, 200)
    assert.deepEqual(payload.results.selfHost.operatorEndpoints, {
      metrics: 'admin_only',
      diagnostics: 'admin_only',
    })
    assert.equal(payload.results.tokenRevocation.rejected, true)
    assert.equal(runtime.prompts.some((entry) => entry.parts.some((part) => part.type === 'text' && part.text === prompt)), true)

    const issuedSmokeTokens = store.listApiTokens(org.orgId)
      .filter((token) => token.name.startsWith('Gateway deployment smoke '))
    assert.equal(issuedSmokeTokens.length, 1)
    assert.equal(typeof issuedSmokeTokens[0]?.revokedAt, 'string')
  } finally {
    await cloud.close()
  }
})

test('gateway cloud smoke script can skip only the post-revocation probe for local auth fallback', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const policy = gatewayPolicy()
  const service = new CloudSessionService(store, runtime, policy)
  const worker = new CloudWorker(store, service, 'worker-local-smoke')
  const cloud = createCloudHttpServer({
    service,
    worker,
    policy,
    auth: createCompositeCloudAuthResolver(
      createApiTokenCloudAuthResolver(store),
      createLocalCloudAuthResolver(),
    ),
    autoProcessCommands: true,
    ssePollMs: 10,
  })
  const cloudUrl = await cloud.listen()

  try {
    const result = await runGatewayCloudSmokeScript({
      cloudUrl,
      adminToken: 'local-demo-admin-token',
      prompt: 'gateway local auth fallback smoke fixture',
      skipTokenRevocation: true,
    })
    assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      results: {
        tokenRevocation: {
          skipped: boolean
          reason: string
          revokedAt: string
        }
      }
    }
    assert.equal(payload.ok, true)
    assert.equal(payload.results.tokenRevocation.skipped, true)
    assert.equal(payload.results.tokenRevocation.reason, 'explicit_skip')
    assert.equal(typeof payload.results.tokenRevocation.revokedAt, 'string')
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
