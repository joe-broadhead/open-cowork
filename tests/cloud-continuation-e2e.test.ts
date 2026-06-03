import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createHttpSseCloudTransportAdapter,
  type CloudTransportAdapter,
  type CloudTransportSessionEvent,
} from '../packages/cloud-client/src/index.ts'
import {
  readCloudSessionProjection,
} from '../packages/shared/dist/cloud-session-projection.js'
import type {
  SessionView,
} from '../packages/shared/src/session.ts'

import { DEFAULT_CONFIG } from '../apps/desktop/src/main/config-types.ts'
import { createApiTokenCloudAuthResolver } from '../apps/desktop/src/main/cloud/app.ts'
import { resolveCloudRuntimePolicy } from '../apps/desktop/src/main/cloud/cloud-config.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/in-memory-control-plane-store.ts'
import { createCloudHttpServer } from '../apps/desktop/src/main/cloud/http-server.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimePromptPart,
} from '../apps/desktop/src/main/cloud/runtime-adapter.ts'
import { CloudSessionService } from '../apps/desktop/src/main/cloud/session-service.ts'
import { CloudWorker } from '../apps/desktop/src/main/cloud/worker.ts'
import { FileCloudWorkspaceCache } from '../apps/desktop/src/main/cloud-workspace-cache.ts'
import {
  CloudWorkspaceAdapter,
  cloudWorkspaceCacheKey,
} from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import type { CloudWorkspaceConnectionRecord } from '../apps/desktop/src/main/cloud-workspace-registry.ts'
import {
  LOCAL_WORKSPACE_ID,
  createWorkspaceGateway,
} from '../apps/desktop/src/main/workspace-gateway.ts'
import { createCloudGateway, resolveGatewayCloudConnection, resolveGatewayConfig } from '../apps/gateway/dist/index.js'

type ContinuationFixture = Awaited<ReturnType<typeof createContinuationFixture>>

class ContinuationRuntime implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string, text: string, agent: string }> = []
  permissions: Array<{ permissionId: string, allowed: boolean }> = []
  questionReplies: Array<{ requestId: string, answers: unknown[] }> = []
  private nextSession = 0

  async createSession() {
    this.nextSession += 1
    return {
      id: `runtime-session-${this.nextSession}`,
      title: `Runtime session ${this.nextSession}`,
      createdAt: '2026-05-28T10:00:00.000Z',
      updatedAt: '2026-05-28T10:00:00.000Z',
    }
  }

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    const text = input.parts
      .filter((part): part is Extract<CloudRuntimePromptPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    this.prompts.push({ sessionId: input.sessionId, text, agent: input.agent })
    const index = this.prompts.length
    const taskRunId = `${input.sessionId}:task:${index}`
    const toolCallId = `${input.sessionId}:tool:${index}`
    const permissionId = `${input.sessionId}:permission:${index}`
    const questionId = `${input.sessionId}:question:${index}`
    const artifactId = `${input.sessionId}:artifact:${index}`
    const events: CloudRuntimeEvent[] = [
      {
        type: 'session.status',
        payload: { sessionId: input.sessionId, statusType: 'running' },
      },
      {
        type: 'task.run',
        payload: {
          sessionId: input.sessionId,
          id: taskRunId,
          title: 'Analyze continuation request',
          agent: input.agent,
          status: 'running',
        },
      },
      {
        type: 'tool.call',
        payload: {
          sessionId: input.sessionId,
          taskRunId,
          id: toolCallId,
          name: 'read',
          input: { path: 'README.md' },
          status: 'running',
        },
      },
      {
        type: 'tool.call',
        payload: {
          sessionId: input.sessionId,
          taskRunId,
          id: toolCallId,
          name: 'read',
          input: { path: 'README.md' },
          output: 'read ok',
          status: 'complete',
        },
      },
      {
        type: 'assistant.message',
        payload: {
          sessionId: input.sessionId,
          messageId: `${input.sessionId}:assistant:${index}`,
          content: `continued from ${text}`,
        },
      },
      {
        type: 'artifact.created',
        payload: {
          sessionId: input.sessionId,
          artifactId,
          filename: 'continuation-result.json',
          contentType: 'application/json',
          size: 42,
          taskRunId,
        },
      },
      {
        type: 'todos.updated',
        payload: {
          sessionId: input.sessionId,
          todos: [{ id: 'todo-1', content: 'Verify all surfaces', status: 'completed', priority: 'high' }],
        },
      },
      {
        type: 'cost.updated',
        payload: {
          sessionId: input.sessionId,
          cost: 0.01,
          tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        type: 'permission.requested',
        payload: {
          sessionId: input.sessionId,
          permissionId,
          tool: 'shell',
          input: { command: 'npm test' },
          description: 'Allow continuation verification command?',
        },
      },
      {
        type: 'question.asked',
        payload: {
          sessionId: input.sessionId,
          requestId: questionId,
          questions: [{
            header: 'Continuation',
            question: 'Should the gateway continue?',
            options: [{ label: 'Yes', description: 'Continue the shared cloud session.' }],
            multiple: false,
            custom: true,
          }],
        },
      },
      {
        type: 'session.idle',
        payload: { sessionId: input.sessionId },
      },
    ]
    if (text.includes('error fixture')) {
      events.push({
        type: 'runtime.error',
        payload: {
          sessionId: input.sessionId,
          id: `${input.sessionId}:error:${index}`,
          message: 'Fixture runtime error',
        },
      })
    }
    return { events }
  }

  async abortSession() {}

  async respondToPermission(input: { permissionId: string, allowed: boolean }) {
    this.permissions.push({ permissionId: input.permissionId, allowed: input.allowed })
  }

  async replyToQuestion(input: { requestId: string, answers: unknown[] }) {
    this.questionReplies.push({ requestId: input.requestId, answers: input.answers })
  }
}

function encryptedStorage() {
  return {
    mode: 'encrypted' as const,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8'),
  }
}

function waitForSubscriptionEvent<T>(
  setup: (resolve: (value: T) => void, reject: (error: unknown) => void) => { close(): void },
  timeoutMs = 1_500,
) {
  let subscription: { close(): void } | null = null
  const promise = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for cloud continuation event.')), timeoutMs)
    timer.unref()
    subscription = setup((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return {
    promise,
    close() {
      subscription?.close()
    },
  }
}

async function waitForView(
  getter: () => Promise<SessionView>,
  predicate: (view: SessionView) => boolean,
  label: string,
  timeoutMs = 1_500,
) {
  const startedAt = Date.now()
  let latest: SessionView | null = null
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await getter()
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}. Latest view: ${JSON.stringify(latest)}`)
}

function createThrowingTransport(): CloudTransportAdapter {
  return new Proxy({}, {
    get() {
      return async () => {
        throw new Error('cloud transport offline')
      }
    },
  }) as CloudTransportAdapter
}

function ipcEvent(senderId: number) {
  return { sender: { id: senderId } } as never
}

async function runContinuationSmokeScript(input: {
  cloudUrl: string
  adminToken: string
  promptPrefix: string
}) {
  const child = spawn(process.execPath, [
    '--no-warnings',
    '--experimental-strip-types',
    'scripts/cloud-continuation-smoke.mjs',
    '--cloud-url',
    input.cloudUrl,
    '--allow-insecure-http',
    '--timeout-ms',
    '5000',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN: input.adminToken,
      OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION: 'true',
      OPEN_COWORK_CONTINUATION_SMOKE_PROMPT_PREFIX: input.promptPrefix,
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
      reject(new Error(`Continuation smoke script timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 30_000)
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

function assertContinuationProjection(view: SessionView, expectedText: string) {
  assert.ok(view.messages.some((message) => message.role === 'assistant' && message.content.includes(expectedText)))
  assert.equal(view.taskRuns.length, 1)
  assert.equal(view.taskRuns[0]?.toolCalls[0]?.status, 'complete')
  assert.equal(view.artifacts[0]?.filename, 'continuation-result.json')
  assert.equal(view.todos[0]?.content, 'Verify all surfaces')
  assert.equal(view.sessionTokens.input, 10)
  assert.equal(view.sessionTokens.output, 20)
}

async function createContinuationFixture() {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-continuation', name: 'Continuation Tenant' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-continuation', name: 'Continuation Tenant' })
  const account = store.createAccount({
    accountId: 'account-continuation',
    idpSubject: 'subject-continuation',
    email: 'owner@example.test',
  })
  store.ensureUser({
    tenantId: 'tenant-continuation',
    userId: account.accountId,
    email: account.email,
    role: 'admin',
  })
  store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'admin',
    status: 'active',
  })
  const desktopToken = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Desktop continuation token',
    scopes: ['desktop', 'admin'],
  }).plaintext
  const webToken = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Web continuation token',
    scopes: ['desktop', 'admin'],
  }).plaintext
  const gatewayToken = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Gateway continuation token',
    scopes: ['gateway', 'admin'],
  }).plaintext
  const runtime = new ContinuationRuntime()
  const policy = {
    ...resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    allowRemoteApprovalResponses: true,
  }
  const service = new CloudSessionService(store, runtime, policy)
  const worker = new CloudWorker(store, service, 'continuation-worker')
  const cloud = createCloudHttpServer({
    service,
    worker,
    policy,
    auth: createApiTokenCloudAuthResolver(store),
    autoProcessCommands: true,
    ssePollMs: 10,
  })
  const baseUrl = await cloud.listen()
  const clientFor = (token: string) => createHttpSseCloudTransportAdapter({
    baseUrl,
    headers: { authorization: `Bearer ${token}` },
  })
  const webClient = clientFor(webToken)
  const setupClient = clientFor(gatewayToken)
  const workspace = await webClient.getWorkspace()
  const now = '2026-05-28T10:00:00.000Z'
  const connection: CloudWorkspaceConnectionRecord = {
    id: 'cloud:continuation',
    baseUrl,
    label: 'Continuation Cloud',
    tenantId: workspace.tenantId,
    userId: workspace.userId,
    profileName: workspace.profileName,
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const cache = new FileCloudWorkspaceCache({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-continuation-cache-')), 'cloud-workspace-cache.json'),
    mode: 'full',
    secretStorage: encryptedStorage(),
  })
  const desktop = new CloudWorkspaceAdapter({
    connection,
    transport: clientFor(desktopToken),
    cache,
  })
  const gatewayEnv = {
    OPEN_COWORK_CLOUD_BASE_URL: baseUrl,
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: gatewayToken,
  }
  resolveGatewayConfig({
    server: {
      adminToken: 'continuation-gateway-admin-token',
      port: 0,
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'cli-binding',
    }],
  }, gatewayEnv)
  const gateway = createCloudGateway(resolveGatewayCloudConnection(gatewayEnv))

  return {
    account,
    baseUrl,
    cache,
    cloud,
    connection,
    desktop,
    desktopToken,
    gateway,
    gatewayToken,
    runtime,
    setupClient,
    webToken,
    webClient,
  }
}

async function setupGatewayBinding(fixture: ContinuationFixture) {
  const agent = await fixture.setupClient.createHeadlessAgent?.({
    agentId: 'continuation-agent',
    name: 'Continuation Agent',
    profileName: 'full',
  })
  assert.ok(agent)
  const channelBinding = await fixture.setupClient.createChannelBinding?.({
    bindingId: 'cli-binding',
    agentId: agent.agentId,
    provider: 'cli',
    displayName: 'CLI continuation binding',
  })
  assert.ok(channelBinding)
  const identity = await fixture.setupClient.resolveChannelIdentity?.({
    provider: 'cli',
    externalUserId: 'cli-user-1',
    accountId: fixture.account.accountId,
    role: 'member',
    status: 'active',
  })
  assert.ok(identity)
  return { agent, channelBinding, identity }
}

test('desktop-created cloud sessions are visible to web clients over bearer-auth HTTP and SSE', async () => {
  const fixture = await createContinuationFixture()
  try {
    const workspaceEvent = waitForSubscriptionEvent((resolve, reject) => fixture.webClient.subscribeWorkspaceEvents({
      afterSequence: 0,
      onEvent: (event) => {
        if (event.type === 'session.created') resolve(event)
      },
      onError: reject,
    }))

    const session = await fixture.desktop.createSession()
    const createdEvent = await workspaceEvent.promise
    workspaceEvent.close()
    assert.equal(createdEvent.sessionId, session.id)

    const webSessions = await fixture.webClient.listSessions()
    assert.ok(webSessions.some((entry) => entry.sessionId === session.id))

    const permissionEvent = waitForSubscriptionEvent<CloudTransportSessionEvent>((resolve, reject) => fixture.webClient.subscribeSessionEvents(session.id, {
      afterSequence: 0,
      onEvent: (event) => {
        if (event.type === 'permission.requested') resolve(event)
      },
      onError: reject,
    }))

    await fixture.desktop.promptSession(session.id, {
      text: 'desktop prompt',
      agent: 'build',
    })
    const sseEvent = await permissionEvent.promise
    permissionEvent.close()
    assert.equal(sseEvent.type, 'permission.requested')

    const webView = await fixture.webClient.getSession(session.id)
    const webProjection = readCloudSessionProjection(webView)
    assert.ok(webProjection)
    assert.ok(webProjection.pendingApprovals.length > 0)
    assert.ok(webProjection.pendingQuestions.length > 0)
    assert.ok(webProjection.messages.some((message) => message.content.includes('desktop prompt')))

    const desktopView = await waitForView(
      () => fixture.desktop.getSessionView(session.id),
      (view) => view.isAwaitingPermission && view.isAwaitingQuestion,
      'desktop pending permission and question',
    )
    assertContinuationProjection(desktopView, 'desktop prompt')
  } finally {
    await fixture.cloud.close()
  }
})

test('gateway prompts continue the same cloud thread and resolve approvals for desktop and web', async () => {
  const fixture = await createContinuationFixture()
  try {
    const { agent, identity } = await setupGatewayBinding(fixture)
    const bound = await fixture.gateway.bindSession({
      identityId: identity.identityId,
      provider: 'cli',
      externalUserId: 'cli-user-1',
      channelBindingId: 'cli-binding',
      externalChatId: 'chat-1',
      externalThreadId: 'thread-1',
      title: 'Gateway continuation thread',
    })
    const sessionId = bound.session.session.sessionId

    await fixture.gateway.prompt({
      bindingId: bound.binding.bindingId,
      identityId: identity.identityId,
      provider: 'cli',
      externalUserId: 'cli-user-1',
      text: 'gateway prompt',
      agent: 'build',
    })

    const desktopSessions = await fixture.desktop.listSessions()
    assert.ok(desktopSessions.some((entry) => entry.id === sessionId))

    const desktopView = await waitForView(
      () => fixture.desktop.getSessionView(sessionId),
      (view) => view.pendingApprovals.length === 1 && view.pendingQuestions.length === 1,
      'gateway-created pending desktop state',
    )
    assertContinuationProjection(desktopView, 'gateway prompt')
    const permissionId = desktopView.pendingApprovals[0]?.id
    const questionId = desktopView.pendingQuestions[0]?.id
    assert.ok(permissionId)
    assert.ok(questionId)

    const cursorHydration = waitForSubscriptionEvent<CloudTransportSessionEvent>((resolve, reject) => fixture.desktop.subscribeSessionEvents?.(sessionId, {
      afterSequence: 0,
      onEvent: (event) => {
        if (event.type === 'permission.requested') resolve(event)
      },
      onError: reject,
    }) ?? { close() {} })
    await cursorHydration.promise
    cursorHydration.close()

    const permissionInteraction = await fixture.gateway.createChannelInteraction({
      agentId: agent.agentId,
      sessionId,
      provider: 'cli',
      kind: 'permission',
      targetId: permissionId,
      createdByIdentityId: identity.identityId,
    })
    await fixture.gateway.resolveChannelInteraction({
      identityId: identity.identityId,
      provider: 'cli',
      externalUserId: 'cli-user-1',
      token: permissionInteraction.plaintextToken,
      response: { allowed: true },
    })

    const questionInteraction = await fixture.gateway.createChannelInteraction({
      agentId: agent.agentId,
      sessionId,
      provider: 'cli',
      kind: 'question',
      targetId: questionId,
      createdByIdentityId: identity.identityId,
    })
    await fixture.gateway.resolveChannelInteraction({
      identityId: identity.identityId,
      provider: 'cli',
      externalUserId: 'cli-user-1',
      token: questionInteraction.plaintextToken,
      answers: ['yes'],
    })

    assert.deepEqual(fixture.runtime.permissions, [{ permissionId, allowed: true }])
    assert.deepEqual(fixture.runtime.questionReplies, [{ requestId: questionId, answers: ['yes'] }])

    const resolvedDesktop = await waitForView(
      () => fixture.desktop.getSessionView(sessionId),
      (view) => view.pendingApprovals.length === 0 && view.pendingQuestions.length === 0,
      'resolved desktop state',
    )
    assert.equal(resolvedDesktop.isAwaitingPermission, false)
    assert.equal(resolvedDesktop.isAwaitingQuestion, false)
    const webProjection = readCloudSessionProjection(await fixture.webClient.getSession(sessionId))
    assert.ok(webProjection)
    assert.equal(webProjection.pendingApprovals.length, 0)
    assert.equal(webProjection.pendingQuestions.length, 0)
  } finally {
    await fixture.cloud.close()
  }
})

test('deployed continuation smoke script proves Web Desktop and Gateway projection parity', async () => {
  const fixture = await createContinuationFixture()
  try {
    const promptPrefix = 'continuation script fixture'
    const result = await runContinuationSmokeScript({
      cloudUrl: fixture.baseUrl,
      adminToken: fixture.webToken,
      promptPrefix,
    })
    assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.equal(result.stdout.includes(fixture.webToken), false)
    assert.equal(result.stderr.includes(fixture.webToken), false)

    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      results: {
        webSurface: { requestIdEchoed: boolean }
        workspace: { tenantBound: boolean, gatewayTenantMatches: boolean }
        sessions: {
          webCreated: { sessionId: string, resolution: { permissionResolvedByWeb: boolean, questionResolvedByGateway: boolean }, parity: { raw: { messages: number, artifacts: number }, desktop: { messages: number, artifacts: number } } }
          desktopCreated: { sessionId: string, parity: { raw: { messages: number }, desktop: { messages: number } } }
          gatewayCreated: { sessionId: string, parity: { raw: { messages: number }, desktop: { messages: number } } }
        }
        concurrency: { markersPresent: { web: boolean, desktop: boolean }, after: { messages: number } }
        replay: { firstEvent: { type: string, sequence: number }, hydrated: boolean }
        gateway: { renderedMessages: number, activeStreams: number }
        tokens: { revoked: Record<string, boolean> }
      }
    }

    assert.equal(payload.ok, true)
    assert.equal(payload.results.webSurface.requestIdEchoed, true)
    assert.equal(payload.results.workspace.tenantBound, true)
    assert.equal(payload.results.workspace.gatewayTenantMatches, true)
    assert.equal(payload.results.sessions.webCreated.resolution.permissionResolvedByWeb, true)
    assert.equal(payload.results.sessions.webCreated.resolution.questionResolvedByGateway, true)
    assert.ok(payload.results.sessions.webCreated.parity.raw.messages > 0)
    assert.ok(payload.results.sessions.webCreated.parity.desktop.messages >= payload.results.sessions.webCreated.parity.raw.messages)
    assert.ok(payload.results.sessions.webCreated.parity.raw.artifacts > 0)
    assert.ok(payload.results.sessions.webCreated.parity.desktop.artifacts >= payload.results.sessions.webCreated.parity.raw.artifacts)
    assert.ok(payload.results.sessions.desktopCreated.parity.desktop.messages >= payload.results.sessions.desktopCreated.parity.raw.messages)
    assert.ok(payload.results.sessions.gatewayCreated.parity.desktop.messages >= payload.results.sessions.gatewayCreated.parity.raw.messages)
    assert.equal(payload.results.concurrency.markersPresent.web, true)
    assert.equal(payload.results.concurrency.markersPresent.desktop, true)
    assert.equal(payload.results.replay.firstEvent.type, 'session.created')
    assert.equal(payload.results.replay.firstEvent.sequence, 1)
    assert.equal(payload.results.replay.hydrated, true)
    assert.ok(payload.results.gateway.renderedMessages > 0)
    assert.ok(payload.results.gateway.activeStreams >= 3)
    assert.deepEqual(payload.results.tokens.revoked, {
      web: true,
      desktop: true,
      gateway: true,
    })
  } finally {
    await fixture.cloud.close()
  }
})

test('desktop restart replays from durable projection instead of corrupting a cached cursor', async () => {
  const fixture = await createContinuationFixture()
  try {
    const session = await fixture.desktop.createSession()
    await fixture.desktop.promptSession(session.id, {
      text: 'restart prompt',
      agent: 'build',
    })
    await fixture.desktop.getSessionView(session.id)
    const cacheKey = cloudWorkspaceCacheKey(fixture.connection)
    fixture.cache.setEventCursor(cacheKey, `session:${session.id}`, 99)

    const restartedDesktop = new CloudWorkspaceAdapter({
      connection: fixture.connection,
      transport: createHttpSseCloudTransportAdapter({
        baseUrl: fixture.baseUrl,
        headers: { authorization: `Bearer ${fixture.desktopToken}` },
      }),
      cache: fixture.cache,
    })
    const firstReplayed = waitForSubscriptionEvent<CloudTransportSessionEvent>((resolve, reject) => restartedDesktop.subscribeSessionEvents?.(session.id, {
      onEvent: resolve,
      onError: reject,
    }) ?? { close() {} })
    const replayed = await firstReplayed.promise
    firstReplayed.close()
    assert.equal(replayed.sequence, 1)
    assert.equal(replayed.type, 'session.created')

    const restartedView = await restartedDesktop.getSessionView(session.id)
    assertContinuationProjection(restartedView, 'restart prompt')
    assert.equal(restartedView.pendingApprovals.length, 1)
    assert.equal(restartedView.pendingQuestions.length, 1)
  } finally {
    await fixture.cloud.close()
  }
})

test('offline cloud cache is read-only while the local workspace remains independent', async () => {
  const fixture = await createContinuationFixture()
  try {
    const session = await fixture.desktop.createSession()
    await fixture.desktop.promptSession(session.id, {
      text: 'offline prompt',
      agent: 'build',
    })
    await fixture.desktop.listSessions()
    await fixture.desktop.getSessionView(session.id)

    const offlineDesktop = new CloudWorkspaceAdapter({
      connection: fixture.connection,
      transport: createThrowingTransport(),
      cache: fixture.cache,
    })
    const cachedSessions = await offlineDesktop.listSessions()
    assert.ok(cachedSessions.some((entry) => entry.id === session.id))
    const cachedView = await offlineDesktop.getSessionView(session.id)
    assertContinuationProjection(cachedView, 'offline prompt')
    await assert.rejects(
      () => offlineDesktop.promptSession(session.id, { text: 'should not queue offline' }),
      /cloud transport offline/,
    )

    const localGateway = createWorkspaceGateway({ cloudRegistry: null, cloudCredentialStore: null })
    const localWorkspaces = localGateway.list(ipcEvent(1))
    assert.equal(localWorkspaces[0]?.id, LOCAL_WORKSPACE_ID)
    assert.equal(localWorkspaces[0]?.status, 'online')
    assert.equal(localGateway.isLocalWorkspace(ipcEvent(1)), true)
  } finally {
    await fixture.cloud.close()
  }
})

test('continuation client surfaces do not import the OpenCode SDK directly', () => {
  const clientSurfaceFiles = [
    'packages/cloud-client/src/index.ts',
    'apps/desktop/src/main/cloud-workspace-adapter.ts',
    'apps/gateway/src/cloud-gateway.ts',
    'apps/gateway/src/session-stream-manager.ts',
    'apps/gateway/src/daemon.ts',
  ]
  for (const file of clientSurfaceFiles) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /@opencode-ai\/sdk|opencode-ai/)
  }
})
