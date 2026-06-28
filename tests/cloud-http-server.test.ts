import { invalidateRuntimeCatalogSnapshotCache } from '@open-cowork/runtime-host/runtime-catalog-snapshot'
import { setKnowledgeDatabaseForTests } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import { clearCoordinationStoreCache } from '@open-cowork/runtime-host/coordination/coordination-store'
import { signWorkflowWebhookPayload, type WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { DEFAULT_CONFIG, type CloudAbuseConfig, type CloudBillingConfig } from '@open-cowork/shared'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { CloudArtifactService } from '@open-cowork/cloud-server/artifact-service'
import type { BillingAdapter } from '@open-cowork/cloud-server/billing-adapter'
import { createApiTokenCloudAuthResolver, createManagedWorkerCloudAuthResolver } from '@open-cowork/cloud-server/app'
import { createByokSecretStore, type ByokSecretStoreOptions } from '@open-cowork/cloud-server/byok-secret-store'
import { resolveCloudRuntimePolicy, type CloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import {
  CloudHttpError,
  createCloudHttpServer,
  type CloudAuthResolver,
  type CloudBrowserAuthProvider,
  type CloudDesktopAuthConfig,
} from '@open-cowork/cloud-server/http-server'
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-server/transport-adapter'
import { browserRendererBuildExists } from '@open-cowork/cloud-server/browser-renderer-app'
import { CloudWorkspaceAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { createInMemoryObjectStore } from '@open-cowork/cloud-server/object-store'
import { createPrometheusCloudObservability, type CloudObservabilityAdapter } from '@open-cowork/cloud-server/observability'
import { createEnvelopeSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import { createCloudSessionCookieManager } from '@open-cowork/cloud-server/session-cookie-auth'
import { CloudSessionService, type ByokManagementPolicy, type CloudEmailSender, type CloudIdentityPolicy, type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createStubBillingAdapter } from '@open-cowork/cloud-server/stub-billing-adapter'
import { CloudWorker } from '@open-cowork/cloud-server/worker'
import {
  KNOWLEDGE_AGENT_TOKEN_TTL_MS,
  signKnowledgeAgentToken,
} from '@open-cowork/cloud-server/knowledge-agent-token'
import type {
  CloudRuntimeAdapter,
  CloudRuntimePromptPart,
} from '@open-cowork/cloud-server/runtime-adapter'
const TEST_COOKIE_KEY = 'not-a-real-cookie-key-for-tests'

class FakeRuntimeAdapter implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string, parts: CloudRuntimePromptPart[], agent: string }> = []
  createdSessions: string[] = []
  aborted: string[] = []
  permissions: Array<{ permissionId: string, allowed: boolean }> = []
  questionReplies: Array<{ requestId: string, answers: unknown[] }> = []
  questionRejects: Array<{ requestId: string }> = []
  private nextSession = 0

  async createSession() {
    this.nextSession += 1
    const id = `oc-session-${this.nextSession}`
    this.createdSessions.push(id)
    return {
      id,
      title: `Session ${this.nextSession}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.prompts.push({ sessionId: input.sessionId, parts: input.parts, agent: input.agent })
    const text = input.parts.find((part) => part.type === 'text')?.text || ''
    return {
      events: [{
        type: 'assistant.message',
        payload: {
          messageId: `${input.sessionId}:assistant:${this.prompts.length}`,
          content: `echo: ${text}`,
        },
      }, {
        type: 'session.idle',
        payload: {
          sessionId: input.sessionId,
        },
      }],
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
    this.questionRejects.push({ requestId: input.requestId })
  }
}

function createFixture(options: {
  autoProcessCommands?: boolean
  ssePollMs?: number
  policy?: CloudRuntimePolicy
  sessionCookies?: ReturnType<typeof createCloudSessionCookieManager> | null
  auth?: CloudAuthResolver
  browserAuth?: CloudBrowserAuthProvider | null
  desktopAuth?: CloudDesktopAuthConfig | null
  observability?: CloudObservabilityAdapter | null
  internalToken?: string | null
  byokPolicy?: ByokManagementPolicy
  abuse?: CloudAbuseConfig
  billing?: CloudBillingConfig | null
  billingAdapter?: BillingAdapter | null
  identityPolicy?: CloudIdentityPolicy
  byokSecretStoreOptions?: Omit<ByokSecretStoreOptions, 'ids'>
  webhookSecurity?: WorkflowWebhookSecurityStore | null
  trustProxyHeaders?: boolean
  trustedProxyCidrs?: readonly string[] | null
  inviteSigningSecret?: string | null
  emailSender?: CloudEmailSender | null
  knowledgeAgentTokenSecret?: string | null
} = {}) {
  const runtime = new FakeRuntimeAdapter()
  const store = new InMemoryControlPlaneStore()
  const objectStore = createInMemoryObjectStore()
  const policy = options.policy || resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  let nextId = 0
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('cloud-http-test-byok-key'), {
    ids: { randomUUID: () => `byok-${nextId += 1}` },
    ...options.byokSecretStoreOptions,
  })
  const service = new CloudSessionService(store, runtime, policy, undefined, {
    randomUUID: () => `cmd-${nextId += 1}`,
  }, undefined, byokSecrets, options.byokPolicy, options.abuse, options.billing || null, options.billingAdapter || null, options.identityPolicy, null, options.inviteSigningSecret ?? null, options.emailSender ?? null)
  const artifacts = new CloudArtifactService(service, objectStore, {
    randomUUID: () => `artifact-${nextId += 1}`,
  })
  const worker = new CloudWorker(store, service, 'worker-1', 30_000, {}, options.abuse || null, options.observability || null)
  const workerAuth = createManagedWorkerCloudAuthResolver(store)
  const server = createCloudHttpServer({
    service,
    artifacts,
    worker,
    policy,
    publicBranding: DEFAULT_CONFIG.cloud.publicBranding,
    autoProcessCommands: options.autoProcessCommands ?? true,
    ssePollMs: options.ssePollMs,
    sessionCookies: options.sessionCookies,
    browserAuth: options.browserAuth,
    desktopAuth: options.desktopAuth,
    observability: options.observability,
    internalToken: options.internalToken,
    webhookSecurity: options.webhookSecurity,
    trustProxyHeaders: options.trustProxyHeaders,
    trustedProxyCidrs: options.trustedProxyCidrs,
    knowledgeAgentTokenSecret: options.knowledgeAgentTokenSecret,
    auth: options.auth || (async (req) => {
      const authorization = String(req.headers.authorization || '')
      if (authorization.startsWith('Bearer ocw_')) return workerAuth(req)
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
    }),
  })
  return { runtime, store, objectStore, policy, service, artifacts, worker, server }
}

async function processOneSessionCommand(fixture: ReturnType<typeof createFixture>, tenantId: string, sessionId: string) {
  const lease = await fixture.store.claimSessionLease(tenantId, sessionId, 'single-command-worker')
  if (!lease) return 0
  try {
    const command = await fixture.store.claimNextSessionCommand(lease)
    if (!command) return 0
    await fixture.service.executeCommand(lease, command)
    return 1
  } finally {
    await fixture.store.releaseSessionLease(lease)
  }
}

async function readJson(response: Response) {
  const text = await response.text()
  return JSON.parse(text) as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(Boolean(value && typeof value === 'object' && !Array.isArray(value)), true)
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true)
  return value as unknown[]
}

function setCookieHeaders(response: Response) {
  const getSetCookie = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') return getSetCookie.call(response.headers)
  const combined = response.headers.get('set-cookie')
  return combined ? combined.split(/,(?=[^ ;]+=)/g) : []
}

function cookieHeader(headers: string[]) {
  return headers.map((header) => header.split(';')[0]).join('; ')
}

function cookieValue(headers: string[], name: string) {
  const prefix = `${name}=`
  const value = headers
    .map((header) => header.split(';')[0])
    .find((entry) => entry.startsWith(prefix))
  return value ? decodeURIComponent(value.slice(prefix.length)) : null
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function policyWithRemoteApprovalResponses(basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)): CloudRuntimePolicy {
  return {
    ...basePolicy,
    allowRemoteApprovalResponses: true,
  }
}

function testAbuseConfig(overrides: Partial<CloudAbuseConfig> = {}): CloudAbuseConfig {
  return {
    ...DEFAULT_CONFIG.cloud.abuse,
    ...overrides,
    enabled: overrides.enabled ?? true,
    httpRateLimit: {
      ...DEFAULT_CONFIG.cloud.abuse.httpRateLimit,
      ...(overrides.httpRateLimit || {}),
    },
    authBackoff: {
      ...DEFAULT_CONFIG.cloud.abuse.authBackoff,
      ...(overrides.authBackoff || {}),
    },
  }
}

function testBillingConfig(overrides: Partial<CloudBillingConfig> = {}): CloudBillingConfig {
  return {
    ...DEFAULT_CONFIG.cloud.billing,
    ...overrides,
    enabled: overrides.enabled ?? true,
    provider: overrides.provider || 'stub',
    defaultPlanKey: overrides.defaultPlanKey || 'pro',
    plans: {
      pro: {
        label: 'Pro',
        entitlements: {
          allowNewSessions: true,
          allowPrompts: true,
          allowWorkers: true,
        },
      },
      blocked: {
        label: 'Blocked',
        entitlements: {
          allowNewSessions: false,
          allowPrompts: false,
          allowWorkers: false,
        },
      },
      ...(overrides.plans || {}),
    },
  }
}

async function readSseUntil(
  response: Response,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 1000,
) {
  const reader = response.body?.getReader()
  assert.ok(reader)
  const decoder = new TextDecoder()
  let buffered = ''
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const chunk = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for SSE event.')), remaining).unref()
      }),
    ])
    if (chunk.done) break
    buffered += decoder.decode(chunk.value, { stream: true })
    const blocks = buffered.split('\n\n')
    buffered = blocks.pop() || ''
    for (const block of blocks) {
      const data = block.split('\n').find((line) => line.startsWith('data: '))
      if (!data) continue
      const event = JSON.parse(data.slice('data: '.length)) as Record<string, unknown>
      if (predicate(event)) return event
    }
  }
  throw new Error('Timed out waiting for SSE event.')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function eventually<T>(
  read: () => T | Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
  timeoutMs = 1000,
): Promise<T> {
  const startedAt = Date.now()
  let lastValue: T | undefined
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await read()
    if (accepts(lastValue)) return lastValue
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`)
}

async function readInitialStreamChunk(response: Response) {
  const reader = response.body?.getReader()
  assert.ok(reader)
  const chunk = await withTimeout(reader.read(), 1000, 'Timed out waiting for initial SSE chunk.')
  assert.equal(chunk.done, false)
  return reader
}

async function waitForStreamReaderClosed(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    try {
      const chunk = await withTimeout(reader.read(), remaining, 'Timed out waiting for SSE reader to close.')
      if (chunk.done) return
    } catch {
      return
    }
  }
  throw new Error('Timed out waiting for SSE reader to close.')
}

test('cloud HTTP server exposes health, config, session create/list/get, prompt, and abort', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const health = await readJson(await fetch(`${baseUrl}/healthz`))
    assert.equal(health.ok, true)
    assert.equal(health.role, 'all-in-one')

    const htmlResponse = await fetch(`${baseUrl}/`)
    assert.equal(htmlResponse.status, 200)
    assert.match(htmlResponse.headers.get('content-type') || '', /text\/html/)
    const html = await htmlResponse.text()
    assert.match(html, /Open Cowork Cloud/)
    assert.match(html, /\/api\/workspace/)
    assert.match(html, /\/api\/byok/)
    assert.match(html, /\/api\/api-tokens/)

    const config = await readJson(await fetch(`${baseUrl}/api/config`))
    assert.equal(config.profileName, 'full')
    assert.equal(config.features.chat, true)
    assert.equal(asRecord(config.publicBranding).productName, 'Open Cowork Cloud')

    const runtimeStatus = await readJson(await fetch(`${baseUrl}/api/runtime/status`))
    assert.equal(runtimeStatus.role, 'all-in-one')
    assert.equal(runtimeStatus.canExecute, true)
    assert.equal(runtimeStatus.commandProcessing, 'inline')

    const workspace = await readJson(await fetch(`${baseUrl}/api/workspace`))
    assert.equal(workspace.tenantId, 'tenant-1')
    assert.equal(workspace.userId, 'user-1')
    assert.equal(workspace.orgId, 'tenant-1')
    assert.equal(asRecord(workspace.policy).localFiles, 'disabled')

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(createdResponse.status, 201)
    const created = await readJson(createdResponse)
    assert.equal(asRecord(created.session).sessionId, 'oc-session-1')
    assert.equal(asArray(asRecord(asRecord(created.projection).view).messages).length, 0)

    const listed = await readJson(await fetch(`${baseUrl}/api/sessions`))
    assert.equal(asArray(listed.sessions).length, 1)

    const promptResponse = await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello cloud', agent: 'data-analyst' }),
    })
    assert.equal(promptResponse.status, 202)
    const prompt = await readJson(promptResponse)
    assert.equal(asRecord(prompt.command).status, 'pending')
    assert.equal(prompt.processed, 1)
    assert.equal(asRecord(prompt.projectionFence).scope, 'session')
    assert.equal(asRecord(prompt.projectionFence).tenantId, 'tenant-1')
    assert.equal(asRecord(prompt.projectionFence).sessionId, 'oc-session-1')
    assert.equal(asRecord(prompt.projectionFence).commandId, asRecord(prompt.command).commandId)
    assert.equal(fixture.runtime.prompts[0]?.agent, 'data-analyst')
    const promptMessages = asArray(asRecord(asRecord(asRecord(prompt.view).projection).view).messages)
    assert.equal(promptMessages.length, 2)
    assert.equal(asRecord(promptMessages[1]).content, 'echo: hello cloud')

    const session = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1`))
    const sessionView = asRecord(asRecord(session.projection).view)
    assert.equal(sessionView.isGenerating, false)
    assert.equal(asRecord(asArray(sessionView.messages)[0]).content, 'hello cloud')

    const sharedViewResponse = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/view`))
    const sharedView = asRecord(sharedViewResponse.view)
    assert.equal(asArray(sharedView.messages).length, 2)
    assert.equal(asRecord(asArray(sharedView.messages)[0]).content, 'hello cloud')
    assert.equal(sharedView.isGenerating, false)

    const abortResponse = await fetch(`${baseUrl}/api/sessions/oc-session-1/abort`, { method: 'POST' })
    assert.equal(abortResponse.status, 202)
    const abort = await readJson(abortResponse)
    assert.equal(abort.processed, 1)
    assert.equal(asRecord(abort.projectionFence).commandId, asRecord(abort.command).commandId)
    assert.equal(asRecord(abort.projectionFence).sequence, asRecord(asRecord(abort.view).projection).sequence)
    assert.deepEqual(fixture.runtime.aborted, ['oc-session-1'])
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP knowledge routes expose snapshot, proposal review, and version history', async () => {
  const knowledgeDb = new DatabaseSync(':memory:')
  setKnowledgeDatabaseForTests(knowledgeDb)
  const ownerPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner',
    authSource: 'user',
  }
  const memberPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'member-1',
    accountId: 'member-1',
    email: 'member@example.test',
    role: 'member',
    authSource: 'user',
  }
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-role']) === 'member' ? memberPrincipal : ownerPrincipal,
  })
  const baseUrl = await fixture.server.listen()
  try {
    const snapshot = await readJson(await fetch(`${baseUrl}/api/knowledge`))
    const spaces = asArray(snapshot.spaces).map(asRecord)
    const pages = asArray(snapshot.pages).map(asRecord)
    assert.equal(spaces[0]?.role, 'Maintainer')
    assert.equal(pages[0]?.version, 1)
    assert.equal(snapshot.limit, 100)
    assert.equal(snapshot.truncated, false)
    assert.ok(asArray(asRecord(snapshot.graph).nodes).some((node) => asRecord(node).label === 'Company OS'))

    // Creating a Space is org-admin gated (structural). A member cannot; the org admin can, and the
    // new Space is tenant-scoped and appears in the snapshot — making the Space model usable.
    const memberSpace = await fetch(`${baseUrl}/api/knowledge/spaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'member' },
      body: JSON.stringify({ name: 'Member space', visibility: 'team' }),
    })
    assert.equal(memberSpace.status, 403)
    const createdSpace = await fetch(`${baseUrl}/api/knowledge/spaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Engineering', visibility: 'team', icon: 'blocks' }),
    })
    assert.equal(createdSpace.status, 201)
    assert.equal(asRecord(await readJson(createdSpace)).name, 'Engineering')
    assert.ok(asArray(asRecord(await readJson(await fetch(`${baseUrl}/api/knowledge`))).spaces)
      .map(asRecord).some((space) => space.name === 'Engineering'))

    // A member with a contributor/maintainer Space role MAY propose — the space role governs (the
    // store's assertCanPropose), not the Cloud org-admin role. Proposals stay pending until a
    // Maintainer reviews, so the "Contributor can propose" path is reachable on cloud.
    const memberProposal = await fetch(`${baseUrl}/api/knowledge/proposals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'member' },
      body: JSON.stringify({
        spaceId: String(spaces[0]?.id),
        pageId: String(pages[0]?.id),
        pageTitle: String(pages[0]?.title),
        by: 'member',
        summary: 'A member contributor proposes a Cloud Knowledge change.',
        body: [{ type: 'p', text: 'Member proposal pending review.' }],
      }),
    })
    assert.equal(memberProposal.status, 201)
    const memberProposalId = String(asRecord(await readJson(memberProposal)).id)
    // Reviewing still requires admin authority — decline it as the org admin so it does not linger.
    const memberProposalDecline = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(memberProposalId)}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewedBy: 'maintainer' }),
    })
    assert.equal(memberProposalDecline.status, 200)

    const proposalResponse = await fetch(`${baseUrl}/api/knowledge/proposals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        spaceId: String(spaces[0]?.id),
        pageId: String(pages[0]?.id),
        pageTitle: String(pages[0]?.title),
        by: 'you',
        summary: 'Capture Cloud conversation decisions for review.',
        links: [{ kind: 'thread', label: 'Cloud conversation', targetId: 'session-1' }],
        body: [
          { type: 'callout', text: 'Captured from Cloud Web for Knowledge review.' },
          { type: 'p', text: 'The accepted result should publish as the next version.' },
        ],
      }),
    })
    assert.equal(proposalResponse.status, 201)
    const proposal = await readJson(proposalResponse)
    assert.equal(proposal.status, 'pending')
    assert.equal(proposal.pageId, pages[0]?.id)
    assert.equal(proposal.by, ownerPrincipal.email)

    const unauthorizedReview = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(String(proposal.id))}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'member' },
      body: JSON.stringify({ reviewedBy: 'member' }),
    })
    assert.equal(unauthorizedReview.status, 403)
    assert.match(String((await readJson(unauthorizedReview)).error), /admin|review/i)

    const acceptedResponse = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(String(proposal.id))}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewedBy: 'maintainer' }),
    })
    assert.equal(acceptedResponse.status, 200)
    const accepted = await readJson(acceptedResponse)
    assert.equal(asRecord(accepted.proposal).status, 'accepted')
    assert.equal(asRecord(accepted.proposal).reviewedBy, ownerPrincipal.email)
    assert.equal(asRecord(accepted.page).id, pages[0]?.id)
    assert.equal(asRecord(accepted.page).pageId, pages[0]?.id)
    assert.equal(asRecord(accepted.page).versionId, `version:${String(pages[0]?.id)}:2`)
    assert.equal(asRecord(accepted.page).version, 2)
    assert.equal(asRecord(accepted.page).proposalId, proposal.id)

    const history = asArray(await readJson(await fetch(`${baseUrl}/api/knowledge/pages/${encodeURIComponent(String(pages[0]?.id))}/history`))).map(asRecord)
    assert.deepEqual(history.map((entry) => entry.version), [2, 1])
    assert.deepEqual(history.map((entry) => entry.id), [pages[0]?.id, pages[0]?.id])
    const limitedHistory = asArray(await readJson(await fetch(`${baseUrl}/api/knowledge/pages/${encodeURIComponent(String(pages[0]?.id))}/history?limit=1`))).map(asRecord)
    assert.deepEqual(limitedHistory.map((entry) => entry.version), [2])

    const afterAccept = await readJson(await fetch(`${baseUrl}/api/knowledge`))
    assert.equal(asArray(afterAccept.proposals).length, 0)
    assert.equal(asArray(afterAccept.pages).map(asRecord).find((page) => page.id === pages[0]?.id)?.version, 2)

    // Restoring a historical version requires review authority and publishes a new audited version.
    const restoreUrl = `${baseUrl}/api/knowledge/pages/${encodeURIComponent(String(pages[0]?.id))}/restore`
    const restoreVersionId = `version:${String(pages[0]?.id)}:1`
    const unauthorizedRestore = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'member' },
      body: JSON.stringify({ versionId: restoreVersionId }),
    })
    assert.equal(unauthorizedRestore.status, 403)

    const restored = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: restoreVersionId }),
    })
    assert.equal(restored.status, 200)
    const restoredPage = asRecord((await readJson(restored)).page)
    assert.equal(restoredPage.version, 3)
    assert.equal(restoredPage.versionId, `version:${String(pages[0]?.id)}:3`)
    assert.equal(restoredPage.proposalId, null)

    const afterRestore = asArray(await readJson(await fetch(`${baseUrl}/api/knowledge/pages/${encodeURIComponent(String(pages[0]?.id))}/history`))).map(asRecord)
    assert.deepEqual(afterRestore.map((entry) => entry.version), [3, 2, 1])

    // Restoring the version that is already current is a client error; unknown versions are not-found.
    const alreadyCurrent = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: `version:${String(pages[0]?.id)}:3` }),
    })
    assert.equal(alreadyCurrent.status, 400)
    const unknownVersion = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: `version:${String(pages[0]?.id)}:99` }),
    })
    assert.equal(unknownVersion.status, 404)
    const missingVersionId = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missingVersionId.status, 400)

    const missing = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(String(proposal.id))}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewedBy: 'maintainer' }),
    })
    assert.equal(missing.status, 400)

    fixture.store.upsertMembership({
      orgId: ownerPrincipal.orgId || ownerPrincipal.tenantId,
      accountId: ownerPrincipal.accountId || ownerPrincipal.userId,
      role: 'member',
      status: 'disabled',
    })
    const staleOwnerHeader = await fetch(`${baseUrl}/api/knowledge`, {
      headers: { 'x-test-role': 'owner' },
    })
    assert.equal(staleOwnerHeader.status, 403)
    assert.match(String((await readJson(staleOwnerHeader)).error), /membership is not active/i)
  } finally {
    await fixture.server.close()
    setKnowledgeDatabaseForTests(null)
    knowledgeDb.close()
  }
})

test('cloud HTTP knowledge agent-propose route is token-authed, tenant-scoped from the token, and propose-only', async () => {
  const knowledgeDb = new DatabaseSync(':memory:')
  setKnowledgeDatabaseForTests(knowledgeDb)
  const AGENT_SECRET = 'cloud-knowledge-agent-secret-for-tests'
  const now = Date.now()
  // A principal is still supplied by the fixture, but this route is pre-user-auth:
  // it authenticates ONLY via the signed agent token, not the principal.
  const fixture = createFixture({ knowledgeAgentTokenSecret: AGENT_SECRET })
  const baseUrl = await fixture.server.listen()
  const proposeUrl = `${baseUrl}/api/knowledge/agent/propose`
  // The seeded default Space for the token's tenant (cloud:tenant-1). The agent
  // never learns this from the body — it proposes against its own workspace.
  const tokenSpaceId = 'space:cloud:tenant-1:company-os'
  const proposalBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
    spaceId: tokenSpaceId,
    pageTitle: 'Operating Model',
    summary: 'A cloud coworker proposes a knowledge change.',
    body: [{ type: 'p', text: 'Proposed by an agent; pending human review.' }],
    ...extra,
  })
  const signToken = (payload: { tenantId: string; sessionId: string; exp?: number }) =>
    signKnowledgeAgentToken(AGENT_SECRET, {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      exp: payload.exp ?? now + KNOWLEDGE_AGENT_TOKEN_TTL_MS,
    })

  try {
    // Missing token → 401.
    assert.equal((await fetch(proposeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: proposalBody() })).status, 401)

    // Malformed / wrong-secret / expired tokens → 401.
    assert.equal((await fetch(proposeUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-token' }, body: proposalBody() })).status, 401)
    assert.equal((await fetch(proposeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signKnowledgeAgentToken('a-different-secret', { tenantId: 'tenant-1', sessionId: 's-1', exp: now + 1000 })}` },
      body: proposalBody(),
    })).status, 401)
    assert.equal((await fetch(proposeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken({ tenantId: 'tenant-1', sessionId: 's-1', exp: now - 1 })}` },
      body: proposalBody(),
    })).status, 401)

    // Non-POST is rejected (propose-only, single verb).
    assert.equal((await fetch(proposeUrl, { method: 'GET', headers: { authorization: `Bearer ${signToken({ tenantId: 'tenant-1', sessionId: 's-1' })}` } })).status, 405)

    // Valid token → 201, a PENDING proposal scoped to the TOKEN's tenant.
    const validToken = signToken({ tenantId: 'tenant-1', sessionId: 'session-abc' })
    const created = await fetch(proposeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validToken}` },
      // The agent supplies a hostile `by` + a body-level workspace/tenant override.
      body: proposalBody({ by: 'totally-the-admin', workspaceId: 'cloud:tenant-victim', tenantId: 'tenant-victim' }),
    })
    assert.equal(created.status, 201)
    const createdBody = asRecord(await readJson(created))
    assert.equal(createdBody.ok, true)
    const proposal = asRecord(createdBody.proposal)
    assert.ok(proposal.id)
    // `by` is server-forced to 'Coworker' (the hostile body `by` is ignored).
    assert.equal(proposal.by, 'Coworker')
    // Created PENDING — it stays for a human Maintainer.
    assert.equal(proposal.status, 'pending')
    assert.equal(proposal.spaceId, tokenSpaceId)

    // The proposal landed in the TOKEN's tenant (cloud:tenant-1), NOT the body's
    // claimed tenant. It is visible in tenant-1's snapshot…
    const tenant1Snapshot = asRecord(await readJson(await fetch(`${baseUrl}/api/knowledge`, { headers: { 'x-test-role': 'owner' } })))
    assert.ok(asArray(tenant1Snapshot.proposals).map(asRecord).some((entry) => entry.id === proposal.id))

    // The agent route is propose-ONLY: there is no agent accept/decline/list/read
    // surface. The only other path under the agent base 404s (it is not routed as
    // a human knowledge API — it sits pre-user-auth and only matches the exact
    // propose path), so the agent token cannot reach review/read endpoints.
    const acceptViaAgent = await fetch(`${baseUrl}/api/knowledge/agent/proposals/${encodeURIComponent(String(proposal.id))}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validToken}` },
      body: JSON.stringify({}),
    })
    // Not the propose path ⇒ falls through to the desktop-API user-principal gate,
    // which the agent token is not. It never reaches an accept handler.
    assert.notEqual(acceptViaAgent.status, 200)
    assert.equal(asArray(tenant1Snapshot.proposals).map(asRecord).find((entry) => entry.id === proposal.id)?.status, 'pending')
  } finally {
    await fixture.server.close()
    setKnowledgeDatabaseForTests(null)
    knowledgeDb.close()
  }
})

test('cloud HTTP knowledge agent-propose route fails closed without a secret and when knowledge is disabled', async () => {
  const knowledgeDb = new DatabaseSync(':memory:')
  setKnowledgeDatabaseForTests(knowledgeDb)
  const now = Date.now()
  const proposalBody = JSON.stringify({
    spaceId: 'space:cloud:tenant-1:company-os',
    pageTitle: 'Operating Model',
    summary: 'A cloud coworker proposes a knowledge change.',
    body: [{ type: 'p', text: 'Proposed by an agent.' }],
  })

  // No configured secret ⇒ the route rejects even a structurally valid-looking
  // token (it must NOT verify against an empty secret). Fail closed → 401.
  const noSecretFixture = createFixture({ knowledgeAgentTokenSecret: null })
  const noSecretUrl = await noSecretFixture.server.listen()
  try {
    const forged = signKnowledgeAgentToken('', { tenantId: 'tenant-1', sessionId: 's-1', exp: now + 1000 })
    const rejected = await fetch(`${noSecretUrl}/api/knowledge/agent/propose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${forged}` },
      body: proposalBody,
    })
    assert.equal(rejected.status, 401)
  } finally {
    await noSecretFixture.server.close()
  }

  // Knowledge disabled by policy ⇒ 403 (feature gate), even with a valid token.
  const disabledPolicy: CloudRuntimePolicy = {
    ...resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    features: { ...resolveCloudRuntimePolicy(DEFAULT_CONFIG).features, knowledge: false },
  }
  const AGENT_SECRET = 'cloud-knowledge-agent-secret-for-tests'
  const disabledFixture = createFixture({ policy: disabledPolicy, knowledgeAgentTokenSecret: AGENT_SECRET })
  const disabledUrl = await disabledFixture.server.listen()
  try {
    const validToken = signKnowledgeAgentToken(AGENT_SECRET, { tenantId: 'tenant-1', sessionId: 's-1', exp: now + KNOWLEDGE_AGENT_TOKEN_TTL_MS })
    const gated = await fetch(`${disabledUrl}/api/knowledge/agent/propose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validToken}` },
      body: proposalBody,
    })
    assert.equal(gated.status, 403)
  } finally {
    await disabledFixture.server.close()
    setKnowledgeDatabaseForTests(null)
    knowledgeDb.close()
  }
})

test('cloud HTTP coordination routes expose the desktop coordination model', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-coordination-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

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
  try {
    await fixture.service.ensurePrincipal(tenant1Principal)
    await fixture.service.ensurePrincipal(tenant2Principal)

    const projectResponse = await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Studio parity',
        objective: 'Coordinate the design parity roadmap.',
        team: ['cleo', 'builder'],
      }),
    })
    assert.equal(projectResponse.status, 201)
    const project = await readJson(projectResponse)
    const projectId = String(project.id)
    assert.equal(project.kind, 'project')
    assert.equal(project.workspaceId, 'cloud:tenant-1')
    assert.equal(project.objective, 'Coordinate the design parity roadmap.')
    assert.deepEqual(project.team, ['cleo', 'builder'])

    const taskResponse = await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        title: 'Build the board backend',
        spec: 'Persist project tasks and expose them to Cloud Web.',
        priority: 'high',
        assigneeAgent: 'builder',
      }),
    })
    assert.equal(taskResponse.status, 201)
    const task = await readJson(taskResponse)
    const taskId = String(task.id)
    assert.equal(task.kind, 'task')
    assert.equal(task.workspaceId, 'cloud:tenant-1')
    assert.equal(task.projectId, projectId)
    assert.equal(task.column, 'backlog')
    assert.equal(task.priority, 'high')

    const board = await readJson(await fetch(`${baseUrl}/api/coordination/board`))
    assert.equal(asArray(board.projects).length, 1)
    assert.equal(asArray(board.tasks).length, 1)

    const moved = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ column: 'doing' }),
    }))
    assert.equal(moved.column, 'doing')

    const assigned = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeAgent: 'reviewer' }),
    }))
    assert.equal(assigned.assigneeAgent, 'reviewer')

    const cloudSession = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const cloudSessionRecord = asRecord(cloudSession.session)
    const cloudSessionId = String(cloudSessionRecord.sessionId)
    const linked = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/link-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assignedSessionId: cloudSessionId,
        status: 'running',
      }),
    }))
    assert.equal(linked.assignedSessionId, cloudSessionId)
    assert.equal(linked.status, 'running')
    assert.equal(linked.column, 'doing')

    const workTarget = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/work-target`))
    assert.equal(workTarget.id, cloudSessionId)
    assert.equal(workTarget.createdAt, cloudSessionRecord.createdAt)

    const tasks = await readJson(await fetch(`${baseUrl}/api/coordination/tasks?projectId=${encodeURIComponent(projectId)}`))
    const listedTask = asRecord(asArray(tasks)[0])
    assert.equal(listedTask.id, taskId)
    assert.equal(listedTask.column, 'doing')
    assert.equal(listedTask.assigneeAgent, 'reviewer')

    const cleoPlanResponse = await fetch(`${baseUrl}/api/coordination/projects/${projectId}/plan-with-cleo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tasks: [{
          spec: 'Review the board handoff.\n\nAcceptance: project tasks are ready for the human review lane.',
          priority: 'med',
          assigneeAgent: 'cleo',
        }],
      }),
    })
    assert.equal(cleoPlanResponse.status, 201)
    const cleoPlan = await readJson(cleoPlanResponse)
    const cleoTasks = asArray(cleoPlan.tasks).map(asRecord)
    assert.equal(cleoPlan.plannerAgent, 'chief-of-staff')
    assert.equal(cleoPlan.displayName, 'Cleo')
    assert.equal(cleoTasks.length, 1)
    assert.equal(cleoTasks[0]?.projectId, projectId)
    assert.equal(cleoTasks[0]?.workspaceId, 'cloud:tenant-1')
    assert.equal(cleoTasks[0]?.column, 'planning')
    assert.equal(cleoTasks[0]?.priority, 'med')
    assert.equal(cleoTasks[0]?.assigneeAgent, 'builder')

    const channelAgent = await readJson(await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', name: 'Watch delivery agent' }),
    }))
    assert.equal(asRecord(channelAgent.agent).agentId, 'agent-1')
    const channelBinding = await readJson(await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindingId: 'binding-1',
        agentId: 'agent-1',
        provider: 'telegram',
        displayName: 'Project telegram',
      }),
    }))
    assert.equal(asRecord(channelBinding.binding).bindingId, 'binding-1')

    const unsupportedWorkflowWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'workflow', id: 'workflow-1' },
        events: ['run.finished'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'workflow-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(unsupportedWorkflowWatch.status, 400)
    assert.match(String((await readJson(unsupportedWorkflowWatch)).error), /not supported/i)
    const unsupportedWorkflowFilter = await fetch(`${baseUrl}/api/coordination/watches?targetKind=workflow&targetId=workflow-1`)
    assert.equal(unsupportedWorkflowFilter.status, 400)
    assert.match(String((await readJson(unsupportedWorkflowFilter)).error), /not supported/i)

    const watchResponse = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: projectId },
        events: ['task.moved', 'task.review_ready'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member', identityId: 'identity-1' },
      }),
    })
    assert.equal(watchResponse.status, 201)
    const watch = await readJson(watchResponse)
    const watchId = String(watch.id)
    assert.equal(watch.kind, 'watch')
    assert.equal(watch.workspaceId, 'cloud:tenant-1')
    assert.equal(watch.ownerAuthority, 'cloud_channel_gateway')
    assert.deepEqual(watch.events, ['task.moved', 'task.review_ready'])

    const movedToReview = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ column: 'review' }),
    }))
    assert.equal(movedToReview.column, 'review')
    const projectWatchDeliveries = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId: 'binding-1', limit: 10 }),
      (deliveries) => {
        const watchEventTypes = deliveries
          .filter((delivery) => asRecord(delivery.payload).watchId === watchId)
          .map((delivery) => delivery.eventType)
        return watchEventTypes.includes('task.moved') && watchEventTypes.includes('task.review_ready')
      },
      'project task watch delivery',
    )
    const taskMovedDelivery = projectWatchDeliveries.find((delivery) => delivery.eventType === 'task.moved' && asRecord(delivery.payload).watchId === watchId)
    assert.ok(taskMovedDelivery)
    assert.equal(asRecord(asRecord(taskMovedDelivery.payload).target).id, taskId)
    assert.equal(asRecord(asArray(asRecord(taskMovedDelivery.payload).relatedTargets)[0]).id, projectId)

    const linkWatchTask = await readJson(await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        title: 'Link-work watch task',
        spec: 'Linking work should emit the same moved watch event as direct task mutations.',
      }),
    }))
    const linkWatchTaskId = String(linkWatchTask.id)
    const linkWatchSession = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const linkedWatchTask = await readJson(await fetch(`${baseUrl}/api/coordination/tasks/${linkWatchTaskId}/link-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assignedSessionId: String(asRecord(linkWatchSession.session).sessionId),
        status: 'running',
      }),
    }))
    assert.equal(linkedWatchTask.column, 'doing')
    const linkWorkDelivery = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId: 'binding-1', limit: 20 }),
      (deliveries) => deliveries.some((delivery) => (
        delivery.eventType === 'task.moved'
        && asRecord(delivery.payload).watchId === watchId
        && asRecord(asRecord(delivery.payload).target).id === linkWatchTaskId
      )),
      'link-work task moved watch delivery',
    )
    assert.ok(linkWorkDelivery.some((delivery) => (
      delivery.eventType === 'task.moved'
      && asRecord(delivery.payload).watchId === watchId
      && asRecord(asRecord(delivery.payload).target).id === linkWatchTaskId
    )))

    const watches = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(projectId)}&status=active`))
    assert.deepEqual(asArray(watches).map((entry) => asRecord(entry).id), [watchId])

    const updatedWatch = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: ['task.review_ready'],
        recipient: { role: 'approver' },
      }),
    }))
    assert.deepEqual(updatedWatch.events, ['task.review_ready'])
    assert.equal(asRecord(updatedWatch.recipient).role, 'approver')

    const pausedWatch = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${watchId}/pause`, { method: 'POST' }))
    assert.equal(pausedWatch.status, 'paused')
    const resumedWatch = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${watchId}/resume`, { method: 'POST' }))
    assert.equal(resumedWatch.status, 'active')

    const tenantTwoBoard = await readJson(await fetch(`${baseUrl}/api/coordination/board`, {
      headers: { 'x-test-tenant': 'tenant-2' },
    }))
    assert.deepEqual(asArray(tenantTwoBoard.projects), [])
    assert.deepEqual(asArray(tenantTwoBoard.tasks), [])

    const tenantTwoProjectUpdate = await fetch(`${baseUrl}/api/coordination/projects/${projectId}`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should not update' }),
    })
    assert.equal(tenantTwoProjectUpdate.status, 404)

    const tenantTwoTaskMove = await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/move`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({ column: 'done' }),
    })
    assert.equal(tenantTwoTaskMove.status, 404)

    const tenantTwoWatchUpdate = await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })
    assert.equal(tenantTwoWatchUpdate.status, 404)

    const tenantTwoWatchDelete = await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, {
      method: 'DELETE',
      headers: { 'x-test-tenant': 'tenant-2' },
    })
    assert.equal(tenantTwoWatchDelete.status, 404)

    const tenantTwoTaskCreate = await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        title: 'Cross tenant task',
        spec: 'This should not be allowed.',
      }),
    })
    assert.equal(tenantTwoTaskCreate.status, 404)

    const tenantTwoProject = await readJson(await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Tenant two project',
        objective: 'Prove Cloud work links resolve only tenant-owned sessions.',
      }),
    }))
    const tenantTwoTask = await readJson(await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: tenantTwoProject.id,
        title: 'Tenant two task',
        spec: 'This task cannot link tenant one work.',
      }),
    }))
    const crossTenantSessionLink = await fetch(`${baseUrl}/api/coordination/tasks/${String(tenantTwoTask.id)}/link-work`, {
      method: 'POST',
      headers: { 'x-test-tenant': 'tenant-2', 'content-type': 'application/json' },
      body: JSON.stringify({ assignedSessionId: cloudSessionId }),
    })
    assert.equal(crossTenantSessionLink.status, 404)
    assert.match(String((await readJson(crossTenantSessionLink)).error), /session/i)

    const missingTitle = await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'Missing title should be a bad request.' }),
    })
    assert.equal(missingTitle.status, 400)
    assert.match(String((await readJson(missingTitle)).error), /title/i)

    const invalidMove = await fetch(`${baseUrl}/api/coordination/tasks/${taskId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ column: 'blocked' }),
    })
    assert.equal(invalidMove.status, 400)
    assert.match(String((await readJson(invalidMove)).error), /column/i)

    const watchDelete = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, { method: 'DELETE' }))
    assert.equal(watchDelete.deleted, true)
    const watchesAfterDelete = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(projectId)}`))
    assert.deepEqual(asArray(watchesAfterDelete), [])
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('cloud watch delivery resolves channel org from tenant workspace id', async () => {
  const fixture = createFixture()
  const principal = {
    tenantId: 'tenant-slug',
    tenantName: 'Tenant Slug',
    orgId: 'org-real',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner' as const,
    authSource: 'local' as const,
  }
  await fixture.service.ensurePrincipal(principal)
  assert.equal(await fixture.service.resolveOrgIdForTenant('tenant-slug'), 'org-real')
})

test('cloud coordination stale watches remain visible and removable after channel targets disappear', async () => {
  clearCoordinationStoreCache()
  clearConfigCaches()
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const ownerPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user@example.test',
    role: 'owner',
    authSource: 'local',
  }
  try {
    const project = await readJson(await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Stale watch cleanup',
        objective: 'Prove watches can be cleaned up after channel targets are removed.',
      }),
    }))
    const projectId = String(asRecord(project).id)
    const staleWatch = await fixture.service.createCloudCoordinationWatch(ownerPrincipal, {
      workspaceId: 'cloud:tenant-1',
      target: { kind: 'project', id: projectId },
      events: ['task.moved'],
      channel: {
        provider: 'telegram',
        agentId: 'deleted-agent',
        channelBindingId: 'deleted-binding',
        target: { chatId: 'stale-watch-chat' },
      },
      recipient: { role: 'member' },
    })

    const listed = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(projectId)}`))
    assert.deepEqual(asArray(listed).map((entry) => asRecord(entry).id), [staleWatch.id])

    const paused = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${staleWatch.id}/pause`, { method: 'POST' }))
    assert.equal(paused.status, 'paused')
    const resumed = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${staleWatch.id}/resume`, { method: 'POST' }))
    assert.equal(resumed.status, 'active')
    const deleted = await readJson(await fetch(`${baseUrl}/api/coordination/watches/${staleWatch.id}`, { method: 'DELETE' }))
    assert.equal(deleted.deleted, true)
    const listedAfterDelete = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(projectId)}`))
    assert.deepEqual(asArray(listedAfterDelete), [])

    const invalidNewWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: projectId },
        events: ['task.moved'],
        channel: {
          provider: 'telegram',
          agentId: 'deleted-agent',
          channelBindingId: 'deleted-binding',
          target: { chatId: 'stale-watch-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(invalidNewWatch.status, 404)
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
  }
})

test('cloud runtime events deliver coordination watches through channel delivery', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-runtime-watch-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const channelAgent = await readJson(await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-runtime-watch', name: 'Runtime watch agent' }),
    }))
    assert.equal(asRecord(channelAgent.agent).agentId, 'agent-runtime-watch')
    const channelBinding = await readJson(await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindingId: 'binding-runtime-watch',
        agentId: 'agent-runtime-watch',
        provider: 'telegram',
        displayName: 'Runtime watch telegram',
      }),
    }))
    assert.equal(asRecord(channelBinding.binding).bindingId, 'binding-runtime-watch')

    const createdSession = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(createdSession.session).sessionId)

    const watchResponse = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'session', id: sessionId },
        events: ['run.finished', 'needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-runtime-watch',
          channelBindingId: 'binding-runtime-watch',
          target: { chatId: 'runtime-watch-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(watchResponse.status, 201)

    const promptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'finish this run' }),
    })
    assert.equal(promptResponse.status, 202)

    const deliveriesAfterRun = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId: 'binding-runtime-watch', limit: 10 }),
      (deliveries) => deliveries.some((delivery) => delivery.eventType === 'run.finished'),
      'run.finished watch delivery',
    )
    const runFinished = deliveriesAfterRun.find((delivery) => delivery.eventType === 'run.finished')
    assert.ok(runFinished)
    assert.equal(runFinished.provider, 'telegram')
    assert.equal(asRecord(runFinished.payload).eventType, 'run.finished')
    assert.equal(asRecord(asRecord(runFinished.payload).target).id, sessionId)

    const appended = await fixture.worker.appendRuntimeEvent('tenant-1', sessionId, {
      type: 'permission.requested',
      payload: {
        sessionId: fixture.runtime.createdSessions[0],
        permissionId: 'permission-runtime-watch',
        description: 'Approve the cloud command.',
        tool: 'bash',
      },
    })
    assert.equal(appended, true)

    const deliveriesAfterInput = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId: 'binding-runtime-watch', limit: 10 }),
      (deliveries) => deliveries.some((delivery) => delivery.eventType === 'needs_input'),
      'needs_input watch delivery',
    )
    const needsInput = deliveriesAfterInput.find((delivery) => delivery.eventType === 'needs_input')
    assert.ok(needsInput)
    assert.equal(asRecord(needsInput.payload).eventType, 'needs_input')
    assert.equal(asRecord(asRecord(needsInput.payload).target).id, sessionId)
    assert.equal(asRecord(asRecord(needsInput.payload).metadata).requestId, 'permission-runtime-watch')
    assert.equal(fixture.store.resolvePrincipalMembership({
      tenantId: 'tenant-1',
      userId: 'coordination-watch',
      accountId: 'coordination-watch',
      email: 'coordination-watch@local.open-cowork',
    }), null)
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('cloud HTTP watch creation validates channel authority before persisting subscriptions', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-watch-auth-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const ownerPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner' as const,
    authSource: 'local' as const,
  }
  const memberPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'member-1',
    accountId: 'member-1',
    email: 'member@example.test',
    role: 'member' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-user']) === 'owner' ? ownerPrincipal : memberPrincipal,
  })
  const baseUrl = await fixture.server.listen()
  try {
    await fixture.service.createHeadlessAgent(ownerPrincipal, {
      agentId: 'agent-1',
      name: 'Watch delivery agent',
    })
    await fixture.service.createChannelBinding(ownerPrincipal, {
      bindingId: 'binding-1',
      agentId: 'agent-1',
      provider: 'telegram',
      displayName: 'Project telegram',
    })
    const project = await readJson(await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Member project',
        objective: 'Prove watch creation does not launder channel delivery authority.',
      }),
    }))

    const unauthorizedWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: project.id },
        events: ['task.moved'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(unauthorizedWatch.status, 403)
    assert.match(String((await readJson(unauthorizedWatch)).error), /gateway|administration|access/i)
    const watches = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(String(project.id))}`))
    assert.deepEqual(asArray(watches), [])

    const ownerWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: project.id },
        events: ['task.moved'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(ownerWatch.status, 201)
    const watchId = String((await readJson(ownerWatch)).id)

    const ownerViewerWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', id: project.id },
        events: ['task.review_ready'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'viewer-watch-chat' },
        },
        recipient: { role: 'viewer' },
      }),
    })
    assert.equal(ownerViewerWatch.status, 201)
    const viewerWatchId = String((await readJson(ownerViewerWatch)).id)

    const forgedWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        watchId,
        createdAt: 'not-a-date',
        target: { kind: 'project', id: project.id },
        events: ['task.moved'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'forged-watch-chat' },
        },
        recipient: { role: 'viewer' },
      }),
    })
    assert.equal(forgedWatch.status, 201)
    const forgedWatchBody = await readJson(forgedWatch)
    assert.notEqual(String(forgedWatchBody.id), watchId)
    assert.notEqual(String(forgedWatchBody.createdAt), 'not-a-date')

    const unauthorizedUpdate = await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: ['task.review_ready'],
        status: 'paused',
      }),
    })
    assert.equal(unauthorizedUpdate.status, 403)

    const unauthorizedPause = await fetch(`${baseUrl}/api/coordination/watches/${watchId}/pause`, { method: 'POST' })
    assert.equal(unauthorizedPause.status, 403)

    const unauthorizedDelete = await fetch(`${baseUrl}/api/coordination/watches/${watchId}`, { method: 'DELETE' })
    assert.equal(unauthorizedDelete.status, 403)

    const unauthorizedViewerUpdate = await fetch(`${baseUrl}/api/coordination/watches/${viewerWatchId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })
    assert.equal(unauthorizedViewerUpdate.status, 403)

    const unauthorizedViewerDelete = await fetch(`${baseUrl}/api/coordination/watches/${viewerWatchId}`, { method: 'DELETE' })
    assert.equal(unauthorizedViewerDelete.status, 403)

    const watchesAfterDeniedMutation = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(String(project.id))}`))
    assert.deepEqual(asArray(watchesAfterDeniedMutation), [])
    const ownerVisibleWatches = await readJson(await fetch(`${baseUrl}/api/coordination/watches?targetKind=project&targetId=${encodeURIComponent(String(project.id))}`, {
      headers: { 'x-test-user': 'owner' },
    }))
    const persistedWatch = asArray(ownerVisibleWatches).map(asRecord).find((watch) => watch.id === watchId)
    assert.ok(persistedWatch)
    assert.equal(persistedWatch.id, watchId)
    assert.equal(persistedWatch.status, 'active')
    assert.deepEqual(persistedWatch.events, ['task.moved'])
    assert.ok(asArray(ownerVisibleWatches).map(asRecord).some((watch) => watch.id === viewerWatchId))

    const memberSession = await readJson(await fetch(`${baseUrl}/api/sessions`, { method: 'POST' }))
    const memberSessionId = String(asRecord(memberSession.session).sessionId)
    const unauthorizedSessionWatch = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'session', id: memberSessionId },
        events: ['run.finished'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member' },
      }),
    })
    assert.equal(unauthorizedSessionWatch.status, 404)
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('cloud gateway watch creation defaults omitted non-admin-scoped recipients to viewer', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-watch-recipient-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const ownerPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner',
    authSource: 'local',
  }
  let gatewayTokenId = 'gateway-token-pending'
  const gatewayPrincipal = (): CloudPrincipal => ({
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'gateway-token-user',
    accountId: 'gateway-token-user',
    email: 'gateway-token@example.test',
    role: 'admin',
    authSource: 'api_token',
    tokenId: gatewayTokenId,
    tokenScopes: ['gateway'],
  })
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-auth']) === 'gateway' ? gatewayPrincipal() : ownerPrincipal,
  })
  let listening = false
  try {
    await fixture.service.ensurePrincipal(ownerPrincipal)
    const issued = fixture.store.issueApiToken({
      orgId: 'tenant-1',
      accountId: 'owner-1',
      name: 'Gateway-only watch token',
      scopes: ['gateway'],
    })
    gatewayTokenId = issued.token.tokenId
    await fixture.service.createHeadlessAgent(ownerPrincipal, {
      agentId: 'agent-watch-recipient',
      name: 'Watch recipient agent',
    })
    await fixture.service.createChannelBinding(ownerPrincipal, {
      bindingId: 'binding-watch-recipient',
      agentId: 'agent-watch-recipient',
      provider: 'telegram',
      displayName: 'Watch recipient telegram',
    })
    fixture.store.grantApiTokenChannelBinding({
      orgId: 'tenant-1',
      tokenId: gatewayTokenId,
      channelBindingId: 'binding-watch-recipient',
      actor: {
        actorType: 'user',
        actorId: 'owner-1',
        accountId: 'owner-1',
      },
    })

    const baseUrl = await fixture.server.listen()
    listening = true

    const gatewayHeaders = {
      'x-test-auth': 'gateway',
      'content-type': 'application/json',
    }
    const gatewaySession = await fixture.service.createSession(gatewayPrincipal())
    const gatewaySessionId = gatewaySession.session.sessionId

    const gatewayWatchResponse = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({
        target: { kind: 'session', id: gatewaySessionId },
        events: ['needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-watch-recipient',
          channelBindingId: 'binding-watch-recipient',
          target: { chatId: 'watch-recipient-chat' },
        },
      }),
    })
    const gatewayWatch = await readJson(gatewayWatchResponse)
    assert.equal(gatewayWatchResponse.status, 201, JSON.stringify(gatewayWatch))
    assert.equal(asRecord(gatewayWatch.recipient).role, 'viewer')

    const gatewayNoRoleRecipientWatchResponse = await fetch(`${baseUrl}/api/coordination/watches`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({
        target: { kind: 'session', id: gatewaySessionId },
        events: ['needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-watch-recipient',
          channelBindingId: 'binding-watch-recipient',
          target: { chatId: 'watch-recipient-chat' },
        },
        recipient: { identityId: 'identity-watch-recipient' },
      }),
    })
    const gatewayNoRoleRecipientWatch = await readJson(gatewayNoRoleRecipientWatchResponse)
    assert.equal(gatewayNoRoleRecipientWatchResponse.status, 201, JSON.stringify(gatewayNoRoleRecipientWatch))
    assert.equal(asRecord(gatewayNoRoleRecipientWatch.recipient).role, 'viewer')
    assert.equal(asRecord(gatewayNoRoleRecipientWatch.recipient).identityId, 'identity-watch-recipient')

    const ownerLegacyWatch = await fixture.service.createCloudCoordinationWatch(ownerPrincipal, {
      workspaceId: 'cloud:tenant-1',
      target: { kind: 'session', id: gatewaySessionId },
      events: ['needs_input'],
      channel: {
        provider: 'telegram',
        agentId: 'agent-watch-recipient',
        channelBindingId: 'binding-watch-recipient',
        target: { chatId: 'watch-recipient-chat' },
      },
    })
    assert.equal(ownerLegacyWatch.recipient ?? null, null)

    const appended = await fixture.worker.appendRuntimeEvent('tenant-1', gatewaySessionId, {
      type: 'permission.requested',
      payload: {
        sessionId: fixture.runtime.createdSessions[0],
        permissionId: 'permission-watch-recipient',
        description: 'Approve the cloud command.',
        tool: 'bash',
      },
    })
    assert.equal(appended, true)

    const deliveries = await eventually(
      () => fixture.store.listChannelDeliveries({ orgId: 'tenant-1', channelBindingId: 'binding-watch-recipient', limit: 10 }),
      (records) => records.some((delivery) => asRecord(delivery.payload).watchId === ownerLegacyWatch.id),
      'owner watch needs_input delivery',
    )
    assert.equal(
      deliveries.some((delivery) => asRecord(delivery.payload).watchId === gatewayWatch.id),
      false,
      'viewer watch must not receive needs_input deliveries',
    )
    assert.equal(
      deliveries.some((delivery) => asRecord(delivery.payload).watchId === gatewayNoRoleRecipientWatch.id),
      false,
      'viewer watch with no-role recipient must not receive needs_input deliveries',
    )

    const deniedUpdate = await fetch(`${baseUrl}/api/coordination/watches/${String(ownerLegacyWatch.id)}`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({ status: 'paused' }),
    })
    assert.equal(deniedUpdate.status, 403)
    assert.match(String((await readJson(deniedUpdate)).error), /recipient roles/i)
  } finally {
    if (listening) await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('cloud HTTP launchpad feed uses bounded session scans and honors disabled artifacts', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        artifacts: false,
      },
    },
  })
  const originalListSessionsPage = fixture.service.listSessionsPage.bind(fixture.service)
  const pageLimits: Array<number | null | undefined> = []
  let listSessionsCalled = false
  let artifactIndexCalled = false
  fixture.service.listSessions = async () => {
    listSessionsCalled = true
    throw new Error('launchpad feed must use bounded session pagination')
  }
  fixture.service.listSessionsPage = async (principal, input = {}) => {
    pageLimits.push(input.limit)
    await originalListSessionsPage(principal, input)
    return {
      items: [],
      nextCursor: 'more-sessions',
      totalEstimate: 101,
    }
  }
  fixture.artifacts.listArtifactIndex = async () => {
    artifactIndexCalled = true
    throw new Error('launchpad feed must not read artifacts when artifacts are disabled')
  }
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/launchpad/feed?limit=4`)
    assert.equal(response.status, 200)
    const feed = await readJson(response)
    assert.equal(listSessionsCalled, false)
    assert.deepEqual(pageLimits, [100])
    assert.equal(artifactIndexCalled, false)
    assert.deepEqual(asArray(feed.freshArtifacts), [])
    assert.equal(asRecord(feed.totals).freshArtifacts, 0)
    assert.equal(asRecord(feed.truncated).freshArtifacts, false)
    assert.deepEqual(asArray(feed.waitingOnYou), [])
    assert.equal(asRecord(feed.totals).waitingOnYou, 1)
    assert.equal(asRecord(feed.truncated).waitingOnYou, true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP launchpad filters task-linked artifacts after project enrichment', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-launchpad-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = dataDir
  clearConfigCaches()
  clearCoordinationStoreCache()

  const fixture = createFixture()
  let artifactRequestProjectId: unknown = 'not-called'
  let artifactRequestTaskIds: unknown = 'not-called'
  let artifactRequestLimit: unknown = 'not-called'
  const baseUrl = await fixture.server.listen()
  try {
    const project = await readJson(await fetch(`${baseUrl}/api/coordination/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Launchpad project',
        objective: 'Surface task-linked artifacts.',
      }),
    }))
    const projectId = String(project.id)
    const task = await readJson(await fetch(`${baseUrl}/api/coordination/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        title: 'Collect artifacts',
        spec: 'Return fresh artifacts linked only by task id.',
      }),
    }))
    const taskId = String(task.id)
    fixture.artifacts.listArtifactIndex = async (_principal, request = {}) => {
      artifactRequestProjectId = request.projectId
      artifactRequestTaskIds = request.taskIds
      artifactRequestLimit = request.limit
      return {
        artifacts: [{
          id: 'cloud-artifact-task-only',
          cloudArtifactId: 'cloud-artifact-task-only',
          source: 'cloud',
          toolId: 'cloud-artifact',
          toolName: 'cloud.artifact',
          filePath: 'cloud-artifact://cloud-artifact-task-only/report.md',
          filename: 'report.md',
          order: 1,
          sessionId: 'session-artifacts',
          workspaceId: 'cloud:tenant-1',
          kind: 'document',
          status: 'draft',
          projectId: null,
          taskId,
          authorAgentId: 'builder',
          createdAt: '2026-06-09T11:00:00.000Z',
          updatedAt: '2026-06-09T11:00:00.000Z',
        }],
        total: 1,
      }
    }

    const feed = await readJson(await fetch(`${baseUrl}/api/launchpad/feed?projectId=${encodeURIComponent(projectId)}`))
    assert.equal(artifactRequestProjectId, projectId)
    assert.deepEqual(artifactRequestTaskIds, [taskId])
    assert.equal(artifactRequestLimit, 9)
    const freshArtifacts = asArray(feed.freshArtifacts)
    assert.equal(freshArtifacts.length, 1)
    assert.equal(asRecord(freshArtifacts[0]).artifactId, 'cloud-artifact-task-only')
    assert.equal(asRecord(freshArtifacts[0]).projectId, projectId)
  } finally {
    await fixture.server.close()
    clearCoordinationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('cloud HTTP command projection fences require the submitted command event', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const originalProcessSessionCommands = fixture.worker.processSessionCommands.bind(fixture.worker)
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    fixture.worker.processSessionCommands = async () => 0
    const oldPromptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'older queued command' }),
    })
    assert.equal(oldPromptResponse.status, 202)
    const oldPrompt = await readJson(oldPromptResponse)
    assert.equal(oldPrompt.processed, 0)
    assert.equal(oldPrompt.projectionFence, null)

    fixture.worker.processSessionCommands = async (tenantId, targetSessionId) => {
      return processOneSessionCommand(fixture, tenantId, targetSessionId)
    }
    const newPromptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'new command still pending' }),
    })
    assert.equal(newPromptResponse.status, 202)
    const newPrompt = await readJson(newPromptResponse)
    assert.equal(newPrompt.processed, 1)
    assert.equal(newPrompt.projectionFence, null)
    assert.notEqual(asRecord(oldPrompt.command).commandId, asRecord(newPrompt.command).commandId)

    const projectedMessages = asArray(asRecord(asRecord(asRecord(newPrompt.view).projection).view).messages)
    assert.equal(projectedMessages.some((message) => asRecord(message).content === 'older queued command'), true)
    assert.equal(projectedMessages.some((message) => asRecord(message).content === 'new command still pending'), false)
    assert.deepEqual(fixture.runtime.prompts.map((prompt) => (prompt.parts[0] as { text?: string } | undefined)?.text), ['older queued command'])
  } finally {
    fixture.worker.processSessionCommands = originalProcessSessionCommands
    await fixture.server.close()
  }
})

test('cloud HTTP direct question and approval responses fail closed unless the profile opts in', async () => {
  const fixture = createFixture({ autoProcessCommands: false })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const denied = await fetch(`${baseUrl}/api/sessions/${sessionId}/permission-respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionId: 'permission-1', response: { allowed: true } }),
    })
    assert.equal(denied.status, 403)
    const body = await readJson(denied)
    assert.equal(asRecord(body.verdict).policyCode, 'cloud-remote-approval-disabled')

    assert.equal(await fixture.worker.processAllSessionCommands(), 0)
    const auditEvents = await fixture.store.listAuditEvents('tenant-1')
    const deniedAudit = auditEvents.find((event) => event.eventType === 'cloud_interaction.remote_policy.denied')
    assert.ok(deniedAudit)
    assert.equal(asRecord(deniedAudit.metadata).policyReasonCode, 'cloud-remote-approval-disabled')
    assert.equal(asRecord(deniedAudit.metadata).interaction, 'permission-approval')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP direct question responses require explicit remote approval opt-in', async () => {
  const fixture = createFixture({
    autoProcessCommands: false,
    policy: policyWithRemoteApprovalResponses(),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const allowed = await fetch(`${baseUrl}/api/sessions/${sessionId}/question-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'question-1', answers: [{ value: 'yes' }] }),
    })
    assert.equal(allowed.status, 202)
    const body = await readJson(allowed)
    assert.equal(asRecord(body.command).kind, 'question.reply')

    assert.equal(await fixture.worker.processAllSessionCommands(), 1)
    assert.deepEqual(fixture.runtime.questionReplies, [{
      requestId: 'question-1',
      answers: [{ value: 'yes' }],
    }])
    const auditEvents = await fixture.store.listAuditEvents('tenant-1')
    const allowedAudit = auditEvents.find((event) => event.eventType === 'cloud_interaction.question.replied')
    assert.ok(allowedAudit)
    assert.equal(asRecord(allowedAudit.metadata).policyReasonCode, 'cloud-rbac-workspace-membership-required')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP channel approval responses fail closed unless the profile opts in', async () => {
  const fixture = createFixture({ autoProcessCommands: false })
  const baseUrl = await fixture.server.listen()
  const headers = { 'content-type': 'application/json' }
  try {
    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-1',
        name: 'Gateway agent',
      }),
    })
    assert.equal(agentResponse.status, 201)

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

    const identityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-1',
        externalUserId: 'tg-user-1',
        accountId: 'user-1',
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
        channelBindingId: channelBinding.bindingId,
        provider: 'telegram',
        externalChatId: 'chat-1',
        externalThreadId: 'thread-1',
        title: 'Telegram thread',
      }),
    })
    assert.equal(bindResponse.status, 200)
    const bound = await readJson(bindResponse)
    const cloudSession = asRecord(asRecord(bound.session).session)

    const interactionResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interactionId: 'interaction-policy-denied',
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

    const denied = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        token: issuedInteraction.plaintextToken,
        response: { allowed: true },
      }),
    })
    assert.equal(denied.status, 403)
    const body = await readJson(denied)
    assert.equal(asRecord(body.verdict).policyCode, 'gateway-remote-approval-disabled')

    assert.equal(await fixture.worker.processAllSessionCommands(), 0)
    assert.deepEqual(fixture.runtime.permissions, [])
    const pending = fixture.store.findChannelInteraction({
      orgId: 'tenant-1',
      token: String(issuedInteraction.plaintextToken),
      provider: 'telegram',
    })
    assert.equal(pending?.status, 'pending')

    const auditEvents = await fixture.store.listAuditEvents('tenant-1')
    const deniedAudit = auditEvents.find((event) => event.eventType === 'channel_interaction.remote_policy.denied')
    assert.ok(deniedAudit)
    assert.equal(deniedAudit.targetType, 'channel_interaction')
    assert.equal(deniedAudit.targetId, 'interaction-policy-denied')
    assert.equal(asRecord(deniedAudit.metadata).policyReasonCode, 'gateway-remote-approval-disabled')
    assert.equal(asRecord(deniedAudit.metadata).interaction, 'permission-approval')
    assert.equal(asRecord(deniedAudit.metadata).authority, 'cloud-channel-gateway')
    assert.equal(asRecord(deniedAudit.metadata).actorWorkspaceMember, true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server paginates session lists with scoped cursors and filters', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const createdSessionIds: string[] = []
    for (const [index, profileName] of ['default', 'data-analyst', 'default', 'default', 'default'].entries()) {
      const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileName }),
      }))
      const sessionId = String(asRecord(created.session).sessionId)
      createdSessionIds.push(sessionId)
      fixture.store.updateSessionStatus({
        tenantId: 'tenant-1',
        sessionId,
        status: index === 2 ? 'closed' : 'idle',
        title: index === 1 ? 'Revenue model' : `Cursor contract ${index + 1}`,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
    }

    const firstResponse = await fetch(`${baseUrl}/api/sessions?limit=2`)
    assert.equal(firstResponse.status, 200)
    const first = await readJson(firstResponse)
    const firstItems = asArray(first.sessions).map((session) => String(asRecord(session).sessionId))
    assert.deepEqual(firstItems, [createdSessionIds[0], createdSessionIds[1]])
    assert.equal(first.totalEstimate, 5)
    assert.equal(typeof first.nextCursor, 'string')

    const secondResponse = await fetch(`${baseUrl}/api/sessions?limit=2&cursor=${encodeURIComponent(String(first.nextCursor))}`)
    assert.equal(secondResponse.status, 200)
    const second = await readJson(secondResponse)
    const secondItems = asArray(second.sessions).map((session) => String(asRecord(session).sessionId))
    assert.deepEqual(secondItems, [createdSessionIds[2], createdSessionIds[3]])
    assert.equal(new Set([...firstItems, ...secondItems]).size, 4)

    const statusFiltered = await readJson(await fetch(`${baseUrl}/api/sessions?status=closed`))
    assert.deepEqual(asArray(statusFiltered.sessions).map((session) => String(asRecord(session).sessionId)), [createdSessionIds[2]])

    const profileFiltered = await readJson(await fetch(`${baseUrl}/api/sessions?profileName=data-analyst`))
    assert.deepEqual(asArray(profileFiltered.sessions).map((session) => String(asRecord(session).sessionId)), [createdSessionIds[1]])

    const qFiltered = await readJson(await fetch(`${baseUrl}/api/sessions?q=revenue`))
    assert.deepEqual(asArray(qFiltered.sessions).map((session) => String(asRecord(session).sessionId)), [createdSessionIds[1]])

    const queryFiltered = await readJson(await fetch(`${baseUrl}/api/sessions?query=revenue`))
    assert.deepEqual(asArray(queryFiltered.sessions).map((session) => String(asRecord(session).sessionId)), [createdSessionIds[1]])

    const malformedCursor = await fetch(`${baseUrl}/api/sessions?cursor=not-a-valid-cursor`)
    assert.equal(malformedCursor.status, 400)
    assert.match(String((await readJson(malformedCursor)).error), /cursor/i)

    const mismatchedFilterCursor = await fetch(`${baseUrl}/api/sessions?status=closed&cursor=${encodeURIComponent(String(first.nextCursor))}`)
    assert.equal(mismatchedFilterCursor.status, 400)
    assert.match(String((await readJson(mismatchedFilterCursor)).error), /cursor/i)

    const unsupportedStatus = await fetch(`${baseUrl}/api/sessions?status=deleted`)
    assert.equal(unsupportedStatus.status, 400)
    assert.match(String((await readJson(unsupportedStatus)).error), /status/i)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP session list cursors are scoped to the authenticated tenant', async () => {
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
  try {
    await fixture.service.ensurePrincipal(tenant1Principal)
    await fixture.service.ensurePrincipal(tenant2Principal)
    for (let index = 0; index < 3; index += 1) {
      await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    }
    const first = await readJson(await fetch(`${baseUrl}/api/sessions?limit=1`))
    assert.equal(typeof first.nextCursor, 'string')

    const tenantTwoList = await readJson(await fetch(`${baseUrl}/api/sessions`, { headers: { 'x-test-tenant': 'tenant-2' } }))
    assert.deepEqual(asArray(tenantTwoList.sessions), [])

    const tenantTwoCursor = await fetch(`${baseUrl}/api/sessions?cursor=${encodeURIComponent(String(first.nextCursor))}`, {
      headers: { 'x-test-tenant': 'tenant-2' },
    })
    assert.equal(tenantTwoCursor.status, 400)
    assert.match(String((await readJson(tenantTwoCursor)).error), /cursor/i)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server imports a redacted local session snapshot and audits the copy', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const importResponse = await fetch(`${baseUrl}/api/import/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          kind: 'local-session',
          fingerprint: 'sha256:source-session-redacted',
          title: 'Local import',
        },
        title: 'Local import',
        selection: {
          includeMessages: true,
          includeArtifacts: true,
          includeAttachments: false,
          includeProjectSource: false,
        },
        itemCounts: {
          messages: 2,
          artifacts: 1,
          attachments: 0,
          projectSource: 0,
          excluded: 3,
        },
        messages: [{
          id: 'local-user-1',
          role: 'user',
          content: 'Summarize the redacted project.',
          timestamp: '2026-05-28T10:00:00.000Z',
          order: 1,
        }, {
          id: 'local-assistant-1',
          role: 'assistant',
          content: 'Summary complete.',
          timestamp: '2026-05-28T10:00:01.000Z',
          order: 2,
        }],
        artifacts: [{
          id: 'local-artifact-1',
          filename: 'summary.txt',
          contentType: 'text/plain',
          dataBase64: Buffer.from('artifact body').toString('base64'),
          order: 3,
          kind: 'document',
          status: 'in-review',
          authorAgentId: 'agent-writer',
          projectId: 'project-1',
          taskId: 'task-1',
          statusUpdatedBy: 'reviewer-1',
          statusUpdatedAt: '2026-05-28T10:00:02.000Z',
        }],
        warnings: [{
          code: 'redacted-local-data',
          message: 'Some local paths or secret-like text will be redacted before cloud import.',
          severity: 'warning',
        }],
        excluded: [{
          kind: 'secrets',
          count: 1,
          reason: 'Secrets stay local.',
        }],
      }),
    })
    assert.equal(importResponse.status, 201)
    const imported = await readJson(importResponse)
    const session = asRecord(imported.session)
    const sessionId = String(session.sessionId)
    assert.equal(fixture.runtime.createdSessions.length, 0, 'import should not create an OpenCode runtime session')
    const projection = asRecord(asRecord(imported.projection).view)
    assert.equal(asRecord(projection.origin).sourceFingerprint, 'sha256:source-session-redacted')
    assert.equal(asArray(projection.messages).length, 2)
    assert.equal(asRecord(asArray(projection.messages)[0]).content, 'Summarize the redacted project.')
    assert.equal(asArray(projection.artifacts).length, 1)
    const projectedArtifact = asRecord(asArray(projection.artifacts)[0])
    assert.equal(projectedArtifact.kind, 'document')
    assert.equal(projectedArtifact.status, 'in-review')
    assert.equal(projectedArtifact.authorAgentId, 'agent-writer')
    assert.equal(projectedArtifact.projectId, 'project-1')
    assert.equal(projectedArtifact.taskId, 'task-1')
    assert.equal(projectedArtifact.statusUpdatedBy, 'reviewer-1')
    assert.equal(projectedArtifact.statusUpdatedAt, '2026-05-28T10:00:02.000Z')

    const artifacts = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))
    assert.equal(asArray(artifacts.artifacts).length, 1)
    const listedArtifact = asRecord(asArray(artifacts.artifacts)[0])
    assert.equal(listedArtifact.status, 'in-review')
    assert.equal(listedArtifact.projectId, 'project-1')
    assert.equal(listedArtifact.taskId, 'task-1')
    assert.equal(listedArtifact.statusUpdatedAt, '2026-05-28T10:00:02.000Z')
    assert.equal('key' in listedArtifact, false)

    const promptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'continue in cloud' }),
    })
    assert.equal(promptResponse.status, 202)
    assert.equal(fixture.runtime.createdSessions.length, 1)
    const prompted = await readJson(promptResponse)
    assert.equal(asArray(asRecord(asRecord(asRecord(prompted.view).projection).view).messages).length, 4)

    const audit = await fixture.store.listAuditEvents('tenant-1')
    const completed = audit.find((event) => event.eventType === 'session_import.completed')
    assert.ok(completed)
    assert.equal(completed.targetId, sessionId)
    assert.equal(asRecord(completed.metadata).sourceFingerprint, 'sha256:source-session-redacted')
    assert.equal(JSON.stringify(audit).includes('/Users/'), false)
    assert.equal(JSON.stringify(audit).includes('sk-'), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP session import rejects local paths before projection or audit persistence', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/import/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          kind: 'local-session',
          fingerprint: 'sha256:unsafe',
          title: 'Unsafe import',
        },
        title: 'Unsafe import',
        selection: { includeMessages: true },
        itemCounts: {
          messages: 1,
          artifacts: 0,
          attachments: 0,
          projectSource: 0,
          excluded: 0,
        },
        messages: [{
          id: 'msg-1',
          role: 'user',
          content: 'Read /Users/alice/private-project/.env',
          order: 1,
        }],
      }),
    })
    assert.equal(response.status, 400)
    const body = await readJson(response)
    assert.match(String(body.error), /local paths|secret-like/)
    assert.equal((await fixture.store.listAuditEvents('tenant-1')).some((event) => event.eventType.startsWith('session_import.')), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server enforces prompt quotas before processing commands and exposes usage events', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxPromptsPerHour: 1,
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
    const firstPrompt = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first' }),
    })
    assert.equal(firstPrompt.status, 202)
    assert.equal(fixture.runtime.prompts.length, 1)

    const blockedPrompt = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'second' }),
    })
    assert.equal(blockedPrompt.status, 429)
    assert.equal(Number(blockedPrompt.headers.get('retry-after')) > 0, true)
    const blocked = await readJson(blockedPrompt)
    assert.equal(asRecord(blocked.verdict).policyCode, 'quota.prompts_per_hour_exceeded')
    assert.equal(fixture.runtime.prompts.length, 1)

    const usage = await readJson(await fetch(`${baseUrl}/api/usage/events`))
    const events = asArray(usage.events).map(asRecord)
    assert.equal(events.some((event) => event.eventType === 'prompt.enqueued'), true)
    assert.equal(events.some((event) => event.eventType === 'worker.minute'), true)
    const summary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    const quotas = asArray(summary.quotas).map(asRecord)
    const promptQuota = quotas.find((quota) => quota.quotaKey === 'prompts:hour')
    assert.equal(promptQuota?.limit, 1)
    assert.equal(promptQuota?.used, 1)
    assert.equal(typeof promptQuota?.resetAt, 'string')
    assert.equal(summary.totalsScope, 'recent_events')
    assert.equal(summary.eventSampleLimit, 50)
    const totals = asArray(summary.totals).map(asRecord)
    assert.equal(totals.some((total) => total.eventType === 'prompt.enqueued' && total.quantity === 1), true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server blocks managed command queue depth before enqueueing extra work', async () => {
  const fixture = createFixture({
    autoProcessCommands: false,
    abuse: testAbuseConfig({
      maxQueuedCommandsPerOrg: 1,
      maxPromptsPerHour: 100,
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
    const first = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first queued prompt' }),
    })
    assert.equal(first.status, 202)
    assert.equal(fixture.runtime.prompts.length, 0)

    const blocked = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'this prompt text must not be metered' }),
    })
    assert.equal(blocked.status, 429)
    const body = await readJson(blocked)
    assert.equal(asRecord(body.verdict).policyCode, 'quota.queued_commands_exceeded')
    assert.equal(fixture.runtime.prompts.length, 0)

    const usage = await readJson(await fetch(`${baseUrl}/api/usage/events?limit=50`))
    const usageText = JSON.stringify(usage)
    assert.equal(usageText.includes('first queued prompt'), false)
    assert.equal(usageText.includes('this prompt text must not be metered'), false)
    const events = asArray(usage.events).map(asRecord)
    assert.equal(events.some((event) => event.eventType === 'work.queued'), true)
    const summary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    const promptQuota = asArray(summary.quotas).map(asRecord).find((quota) => quota.quotaKey === 'prompts:hour')
    assert.equal(promptQuota?.used, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server gates gateway-originated prompts separately from general prompts', async () => {
  const fixture = createFixture({
    autoProcessCommands: false,
    abuse: testAbuseConfig({
      maxPromptsPerHour: 100,
      maxGatewayPromptsPerHour: 1,
      maxQueuedCommandsPerOrg: 100,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  const headers = { 'content-type': 'application/json' }
  try {
    assert.equal((await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-gateway-quota',
        name: 'Gateway quota agent',
        profileName: 'full',
      }),
    })).status, 201)
    assert.equal((await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bindingId: 'binding-gateway-quota',
        agentId: 'agent-gateway-quota',
        provider: 'telegram',
        displayName: 'Telegram quota',
        externalWorkspaceId: 'bot-quota',
      }),
    })).status, 201)
    const identity = asRecord((await readJson(await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-quota',
        externalUserId: 'tg-quota-user',
        accountId: 'user-1',
        role: 'member',
        status: 'active',
      }),
    }))).identity)
    const bound = await readJson(await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: 'binding-gateway-quota',
        provider: 'telegram',
        externalChatId: 'chat-quota',
        externalThreadId: 'thread-quota',
        title: 'Gateway quota thread',
      }),
    }))
    const bindingId = String(asRecord(bound.binding).bindingId)

    const first = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        bindingId,
        text: 'first gateway prompt',
      }),
    })
    assert.equal(first.status, 202)
    const blocked = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        bindingId,
        text: 'second gateway prompt',
      }),
    })
    assert.equal(blocked.status, 429)
    assert.equal(asRecord((await readJson(blocked)).verdict).policyCode, 'quota.gateway_prompts_per_hour_exceeded')
    const summary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    const gatewayQuota = asArray(summary.quotas).map(asRecord).find((quota) => quota.quotaKey === 'gateway_prompts:hour')
    assert.equal(gatewayQuota?.limit, 1)
    assert.equal(gatewayQuota?.used, 1)
    const promptQuota = asArray(summary.quotas).map(asRecord).find((quota) => quota.quotaKey === 'prompts:hour')
    assert.equal(promptQuota?.used, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server blocks worker execution when worker-minute quota is exhausted', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxWorkerMinutesPerHour: 1,
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
    const now = new Date()
    fixture.store.consumeUsageQuota({
      orgId: 'tenant-1',
      quotaKey: 'worker_minutes:hour',
      quantity: 1,
      limit: 1,
      windowMs: 60 * 60 * 1000,
      now,
      policyCode: 'quota.worker_minutes_per_hour_exceeded',
    })

    const prompt = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'do not execute' }),
    })
    assert.equal(prompt.status, 202)
    const body = await readJson(prompt)
    assert.equal(body.processed, 0)
    assert.equal(body.projectionFence, null)
    assert.equal(fixture.runtime.prompts.length, 0)

    const summary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    const quotas = asArray(summary.quotas).map(asRecord)
    const workerMinutes = quotas.find((quota) => quota.quotaKey === 'worker_minutes:hour')
    assert.equal(workerMinutes?.limit, 1)
    assert.equal(workerMinutes?.used, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server saturates worker-minute quota when a command crosses the limit', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxWorkerMinutesPerHour: 10,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  await fixture.server.listen()
  try {
    fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
    fixture.store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
    const now = new Date()
    fixture.store.consumeUsageQuota({
      orgId: 'tenant-1',
      quotaKey: 'worker_minutes:hour',
      quantity: 9,
      limit: 10,
      windowMs: 60 * 60 * 1000,
      now,
      policyCode: 'quota.worker_minutes_per_hour_exceeded',
    })

    await fixture.service.recordWorkerMinutes({
      tenantId: 'tenant-1',
      sessionId: 'session-crossing',
      workerId: 'worker-a',
      elapsedMs: 2 * 60_000,
    })

    const counters = await fixture.store.listUsageQuotaCounters('tenant-1')
    const workerMinutes = counters.find((counter) => counter.quotaKey === 'worker_minutes:hour')
    assert.equal(workerMinutes?.quantity, 10)
    await assert.rejects(
      () => fixture.service.assertWorkerExecutionAllowed('tenant-1'),
      /Cloud worker minute quota exceeded/,
    )
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server blocks session quotas before eager runtime creation', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxConcurrentSessionsPerOrg: 1,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const first = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(first.status, 201)
    assert.equal(fixture.runtime.createdSessions.length, 0)

    const blocked = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(blocked.status, 429)
    assert.equal(fixture.runtime.createdSessions.length, 0)
    const body = await readJson(blocked)
    assert.equal(asRecord(body.verdict).policyCode, 'quota.concurrent_sessions_exceeded')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server readiness fails closed when no readiness callback is configured', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const live = await readJson(await fetch(`${baseUrl}/livez`))
    assert.equal(live.ok, true)

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
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200)
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
          accountingMetrics.push(String(record.attributes?.['cloud.auth.accounting.operation'] || ''))
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
    assert.equal(html.headers.get('access-control-allow-origin'), 'https://app.example.test')
    assert.equal(html.headers.get('access-control-allow-credentials'), null)
    assert.equal(html.headers.get('vary'), 'Origin')
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(html.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains')
    const csp = html.headers.get('content-security-policy') || ''
    assert.match(csp, /script-src 'self' 'nonce-/)
    assert.match(csp, /font-src 'self'/)
    assert.match(csp, /object-src 'none'/)
    // Scripts stay locked to nonce'd <script> — no inline script execution.
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/)
    // <style> elements stay nonce-locked; only inline style ATTRIBUTES are
    // allowed (style-src-attr), which the design system needs for dynamic
    // per-entity theming (--entity-chroma / --studio-tone / --spine). A style
    // attribute cannot carry a nonce and cannot execute script.
    assert.match(csp, /style-src 'self' 'nonce-/)
    assert.match(csp, /style-src-attr 'unsafe-inline'/)

    const mismatched = await fetch(`${baseUrl}/api/config`, {
      headers: { origin: 'https://evil.example.test' },
    })
    assert.equal(mismatched.headers.get('access-control-allow-origin'), null)
    assert.equal(mismatched.headers.get('x-content-type-options'), 'nosniff')
  } finally {
    await server.close()
  }
})

test('cloud HTTP server serves only allow-listed Cloud Web font assets', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    for (const fontName of [
      'mona-sans-latin-wght-normal.woff2',
      'schibsted-grotesk-latin-wght-normal.woff2',
    ]) {
      const font = await fetch(`${baseUrl}/assets/fonts/${fontName}`)
      assert.equal(font.status, 200)
      assert.equal(font.headers.get('content-type'), 'font/woff2')
      assert.equal(font.headers.get('cache-control'), 'public, max-age=86400')
      assert.ok((await font.arrayBuffer()).byteLength > 1024, `${fontName} response has woff2 bytes`)
    }

    const unknown = await fetch(`${baseUrl}/assets/fonts/not-a-font.woff2`)
    assert.equal(unknown.status, 404)
    assert.match(JSON.stringify(await readJson(unknown)), /not found/i)

    const traversal = await fetch(`${baseUrl}/assets/fonts/..%2Fpackage.json`)
    assert.equal(traversal.status, 404)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server serves the allow-listed Cloud Web React client asset', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const asset = await fetch(`${baseUrl}/assets/open-cowork-cloud-react.js`)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-type'), 'application/javascript; charset=utf-8')
    assert.equal(asset.headers.get('cache-control'), 'no-store')
    assert.match(await asset.text(), /open-cowork-cloud-react-root|cloud-react-probe|reactStatus/)

    const unknown = await fetch(`${baseUrl}/assets/not-the-react-client.js`)
    assert.equal(unknown.status, 404)
  } finally {
    await fixture.server.close()
  }
})

// The unified renderer browser build (apps/desktop/dist-browser) is not produced in
// every CI lane, so gate on its presence — but assert the full route wiring (the
// /app SPA document with its relaxed-but-script-strict CSP, and a hashed /app/assets
// JS file with the right content-type) when the build IS present.
test('cloud HTTP server serves the unified renderer at /app with a script-strict, style-relaxed CSP', {
  skip: browserRendererBuildExists() ? false : 'apps/desktop/dist-browser is not built',
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

test('cloud HTTP server serves the unified renderer at / when OPEN_COWORK_CLOUD_UNIFIED_UI is enabled (reversible cutover)', {
  skip: browserRendererBuildExists() ? false : 'apps/desktop/dist-browser is not built',
}, async () => {
  const previous = process.env.OPEN_COWORK_CLOUD_UNIFIED_UI
  process.env.OPEN_COWORK_CLOUD_UNIFIED_UI = 'true'
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const root = await fetch(`${baseUrl}/`)
    assert.equal(root.status, 200)
    const body = await root.text()
    // Flag on: GET / serves the unified renderer SPA (references /app/assets + the
    // bootstrap tag) with the relaxed-but-script-strict CSP, NOT the website SSR.
    assert.match(body, /\/app\/assets\//)
    assert.match(body, /id="cowork-bootstrap"/)
    const csp = root.headers.get('content-security-policy') || ''
    assert.match(csp, /style-src 'self' 'unsafe-inline'/)
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/)
  } finally {
    await fixture.server.close()
    if (previous === undefined) delete process.env.OPEN_COWORK_CLOUD_UNIFIED_UI
    else process.env.OPEN_COWORK_CLOUD_UNIFIED_UI = previous
  }
})

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
  const issued = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Desktop token',
    scopes: ['desktop'],
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
  const issued = store.issueApiToken({
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
  const issued = store.issueApiToken({
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
    assert.equal(session.status, 200)

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
      () => fixture.service.getDiagnosticsBundle(workerPrincipal),
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

test('cloud HTTP admin APIs reject member-only users while preserving read-only policy', async () => {
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
    assert.equal(members.status, 403)
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
  const issued = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Gateway token',
    scopes: ['gateway', 'admin'],
  })
  const operatorIssued = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Operator diagnostics token',
    scopes: ['operator'],
  })
  const gatewayOnlyIssued = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Gateway-only token',
    scopes: ['gateway'],
  })
  const otherGatewayOnlyIssued = store.issueApiToken({
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
  const issuedTenant2 = store.issueApiToken({
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

    const legacyProviderEventClaim = store.claimChannelProviderEvent({
      orgId: org.orgId,
      provider: 'telegram',
      providerInstanceId: 'telegram-prod',
      externalWorkspaceId: 'bot-1',
      providerEventId: 'provider-event-legacy-complete',
      eventType: 'message',
      claimedBy: 'gateway-legacy',
      ttlMs: 30_000,
      metadata: { providerMessageId: 'legacy-message' },
    })
    const legacyProviderEventComplete = await fetch(`${baseUrl}/api/channels/provider-events/${legacyProviderEventClaim.event.eventId}/complete`, {
      method: 'POST',
      headers: gatewayOnlyHeaders,
      body: JSON.stringify({
        claimedBy: 'gateway-legacy',
        status: 'processed',
      }),
    })
    assert.equal(legacyProviderEventComplete.status, 200)

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
    const response = await fetch(`${baseUrl}/healthz`, {
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
    assert.equal(((logs[0] as Record<string, unknown>).attributes as Record<string, unknown>)['url.path'], '/healthz')
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
    const health = await fetch(`${baseUrl}/healthz`)
    assert.equal(health.status, 200)
    await health.text()
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

test('cloud HTTP SSE streams durable session events without sticky renderer state', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const stream = await fetch(`${baseUrl}/api/sessions/oc-session-1/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'stream me', agent: 'build' }),
    })

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(asRecord(event.payload).content, 'echo: stream me')
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP workspace event feed streams owned session deltas', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const stream = await fetch(`${baseUrl}/api/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'workspace stream', agent: 'build' }),
    })

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(event.entityType, 'session')
    assert.equal(event.entityId, 'oc-session-1')
    assert.equal(event.operation, 'update')
    assert.equal(event.projectionVersion, event.sequence)
    assert.equal(asRecord(event.payload).content, 'echo: workspace stream')
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP server close shuts down active SSE streams without client aborts', async () => {
  const scenarios = [
    {
      name: 'session events',
      setup: async (baseUrl: string) => {
        await fetch(`${baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      },
      path: '/api/sessions/oc-session-1/events?after=0',
    },
    {
      name: 'workspace events',
      setup: async () => {},
      path: '/api/events?after=0',
    },
    {
      name: 'channel deliveries',
      setup: async () => {},
      path: '/api/channels/deliveries/stream?claimedBy=test-gateway',
    },
  ]

  for (const scenario of scenarios) {
    const fixture = createFixture({ ssePollMs: 10 })
    const baseUrl = await fixture.server.listen()
    const controller = new AbortController()
    let closed = false
    try {
      await scenario.setup(baseUrl)
      const stream = await fetch(`${baseUrl}${scenario.path}`, {
        signal: controller.signal,
      })
      assert.equal(stream.status, 200, scenario.name)
      const reader = await readInitialStreamChunk(stream)

      await withTimeout(
        fixture.server.close().then(() => {
          closed = true
        }),
        1000,
        `${scenario.name} stream blocked server shutdown.`,
      )
      await waitForStreamReaderClosed(reader)
    } finally {
      controller.abort()
      if (!closed) await fixture.server.close().catch(() => {})
    }
  }
})

test('cloud HTTP server close handles workspace SSE shutdown during replay load', async () => {
  const fixture = createFixture({ ssePollMs: 10 })
  const originalListWorkspaceEvents = fixture.service.listWorkspaceEvents.bind(fixture.service)
  let releaseList: (() => void) | null = null
  const listStarted = new Promise<void>((resolve) => {
    fixture.service.listWorkspaceEvents = async () => {
      resolve()
      await new Promise<void>((release) => {
        releaseList = release
      })
      return [{
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'oc-session-1',
        sequence: 10,
        entityType: 'session',
        entityId: 'oc-session-1',
        operation: 'update',
        projectionVersion: 10,
        type: 'assistant.message',
        eventId: 'event-10',
        payload: { content: 'retained event after a replay gap' },
        createdAt: '2026-06-02T00:00:00.000Z',
      }] satisfies Awaited<ReturnType<typeof originalListWorkspaceEvents>>
    }
  })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  let closed = false
  try {
    const stream = await fetch(`${baseUrl}/api/events?after=8`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)
    await listStarted

    const closePromise = fixture.server.close().then(() => {
      closed = true
    })
    releaseList?.()
    await withTimeout(closePromise, 1000, 'Workspace SSE replay load blocked server shutdown.')
    const reader = stream.body?.getReader()
    if (reader) await waitForStreamReaderClosed(reader)
  } finally {
    controller.abort()
    releaseList?.()
    fixture.service.listWorkspaceEvents = originalListWorkspaceEvents
    if (!closed) await fixture.server.close().catch(() => {})
  }
})

test('cloud HTTP workspace event feed replays one ordered user stream across sessions', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'user-1',
    email: 'user@example.test',
  }
  const originalListWorkspaceEvents = fixture.service.listWorkspaceEvents.bind(fixture.service)
  const replayListCalls: number[] = []
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first session', agent: 'build' }),
    })
    await fetch(`${baseUrl}/api/sessions/oc-session-2/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'second session', agent: 'build' }),
    })

    const events = await fixture.service.listWorkspaceEvents(principal, 0)
    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: events.length }, (_, index) => index + 1),
    )
    assert.deepEqual(
      events.filter((event) => event.type === 'assistant.message').map((event) => event.sessionId),
      ['oc-session-1', 'oc-session-2'],
    )

    const firstAssistant = events.find((event) => event.type === 'assistant.message' && event.sessionId === 'oc-session-1')
    assert.ok(firstAssistant)
    fixture.service.listWorkspaceEvents = async (eventPrincipal, afterSequence = 0) => {
      replayListCalls.push(afterSequence)
      return originalListWorkspaceEvents(eventPrincipal, afterSequence)
    }
    const stream = await fetch(`${baseUrl}/api/events?after=${firstAssistant.sequence}`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)
    const replayed = await readSseUntil(stream, (entry) => (
      entry.type === 'assistant.message' && entry.sessionId === 'oc-session-2'
    ))
    assert.equal(asRecord(replayed.payload).content, 'echo: second session')
    assert.equal(replayListCalls.includes(0), false)
    assert.equal(replayListCalls.includes(firstAssistant.sequence), true)
  } finally {
    controller.abort()
    fixture.service.listWorkspaceEvents = originalListWorkspaceEvents
    await fixture.server.close()
  }
})

test('cloud HTTP workspace event feed polls durable events written by another service instance', async () => {
  const fixture = createFixture({ autoProcessCommands: false, ssePollMs: 10 })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const stream = await fetch(`${baseUrl}/api/events?after=0`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    const workerSideService = new CloudSessionService(fixture.store, fixture.runtime, fixture.policy)
    await workerSideService.appendRuntimeEvent({
      tenantId: 'tenant-1',
      sessionId: 'oc-session-1',
      event: {
        type: 'assistant.message',
        payload: {
          messageId: 'external-workspace-message',
          content: 'from another workspace worker',
        },
      },
    })

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(asRecord(event.payload).messageId, 'external-workspace-message')
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP workspace event feed asks clients to refresh snapshots after retention gaps', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const originalListWorkspaceEvents = fixture.service.listWorkspaceEvents.bind(fixture.service)
  const originalGetWorkspaceEventCursor = fixture.service.getWorkspaceEventCursor.bind(fixture.service)
  const replayListCalls: number[] = []
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    fixture.service.getWorkspaceEventCursor = async () => ({
      earliestSequence: 10,
      latestSequence: 10,
    })
    fixture.service.listWorkspaceEvents = async (principal, afterSequence = 0) => {
      replayListCalls.push(afterSequence)
      return originalListWorkspaceEvents(principal, afterSequence)
    }

    const stream = await fetch(`${baseUrl}/api/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    const event = await readSseUntil(stream, (entry) => entry.type === 'snapshot.required')
    assert.equal(asRecord(event.payload).reason, 'event_retention_gap')
    assert.equal(asRecord(event.payload).afterSequence, 1)
    assert.equal(asRecord(event.payload).earliestSequence, 10)
    assert.equal(asRecord(event.payload).latestSequence, 10)
    assert.equal(replayListCalls.includes(0), false)
  } finally {
    controller.abort()
    fixture.service.getWorkspaceEventCursor = originalGetWorkspaceEventCursor
    fixture.service.listWorkspaceEvents = originalListWorkspaceEvents
    await fixture.server.close()
  }
})

test('cloud HTTP clients share session state across desktop adapter and web transport', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const web = createHttpSseCloudTransportAdapter({ baseUrl })
    const desktop = new CloudWorkspaceAdapter({
      connection: {
        id: 'cloud:test',
        baseUrl,
        label: 'Test Cloud',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
        lastSyncedAt: null,
      },
      transport: createHttpSseCloudTransportAdapter({ baseUrl }),
      cache: null,
    })

    const created = await desktop.createSession()
    assert.equal((await web.listSessions()).some((session) => session.sessionId === created.id), true)

    await web.promptSession(created.id, { text: 'from web', agent: 'build' })
    const desktopAfterWebPrompt = await desktop.getSessionView(created.id)
    assert.equal(desktopAfterWebPrompt.messages.some((message) => message.content === 'echo: from web'), true)

    await desktop.promptSession(created.id, { text: 'from desktop', agent: 'build' })
    const webAfterDesktopPrompt = await web.getSession(created.id)
    assert.equal(
      webAfterDesktopPrompt.projection?.view.messages.some((message) => message.content === 'echo: from desktop'),
      true,
    )
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP SSE resumes from Last-Event-ID without replaying older events', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'user-1',
    email: 'user@example.test',
  }

  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'before reconnect', agent: 'build' }),
    })
    const priorEvents = await fixture.service.listEvents(principal, 'oc-session-1')
    const lastSequence = Math.max(...priorEvents.map((event) => event.sequence))

    const stream = await fetch(`${baseUrl}/api/sessions/oc-session-1/events`, {
      signal: controller.signal,
      headers: {
        'Last-Event-ID': String(lastSequence),
      },
    })
    assert.equal(stream.status, 200)

    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'after reconnect', agent: 'build' }),
    })

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(asRecord(event.payload).content, 'echo: after reconnect')
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP SSE polls durable events written by another service instance', async () => {
  const fixture = createFixture({ autoProcessCommands: false, ssePollMs: 10 })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const stream = await fetch(`${baseUrl}/api/sessions/oc-session-1/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    const workerSideService = new CloudSessionService(fixture.store, fixture.runtime, fixture.policy)
    await workerSideService.appendRuntimeEvent({
      tenantId: 'tenant-1',
      sessionId: 'oc-session-1',
      event: {
        type: 'assistant.message',
        payload: {
          messageId: 'external-worker-message',
          content: 'from another worker',
        },
      },
    })

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(asRecord(event.payload).messageId, 'external-worker-message')
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP exposes operator projection lag and repair routes', async () => {
  const fixture = createFixture({ autoProcessCommands: false })
  const baseUrl = await fixture.server.listen()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fixture.store.appendSessionEvent({
      tenantId: 'tenant-1',
      sessionId: 'oc-session-1',
      type: 'assistant.message',
      payload: {
        messageId: 'repair-http-message',
        content: 'repair over http',
      },
    })

    const status = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/projection-status`))
    assert.equal(asRecord(status).latestEventSequence, 2)
    assert.equal(asRecord(status).projectionSequence, 1)
    assert.equal(asRecord(status).lag, 1)

    const repaired = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/projection-repair`, {
      method: 'POST',
    }))
    assert.equal(asRecord(repaired).repaired, true)
    assert.equal(asRecord(repaired).projectionSequence, 2)

    const view = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/view`))
    const projectionView = asRecord(asRecord(view.projection).view)
    assert.equal(asRecord(asArray(projectionView.messages).at(-1)).content, 'repair over http')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes worker heartbeat visibility for operators', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    await fixture.store.recordWorkerHeartbeat({
      workerId: 'worker-1',
      role: 'worker',
      activeSessionIds: ['oc-session-1'],
      now: new Date('2026-05-26T12:00:00.000Z'),
    })

    const response = await fetch(`${baseUrl}/api/workers/heartbeats`)
    assert.equal(response.status, 200)
    const body = await readJson(response)
    const heartbeats = asArray(body.heartbeats)
    assert.equal(heartbeats.length, 1)
    assert.deepEqual(asRecord(heartbeats[0]), {
      workerId: 'worker-1',
      role: 'worker',
      activeSessionIds: ['oc-session-1'],
      lastSeenAt: '2026-05-26T12:00:00.000Z',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes a read-only capability catalog filtered by profile allowlists', async () => {
  const previousConfigPath = process.env.OPEN_COWORK_CONFIG_PATH
  const configDir = await mkdtemp(join(tmpdir(), 'open-cowork-capabilities-'))
  const configPath = join(configDir, 'open-cowork.config.json')
  await writeFile(configPath, JSON.stringify({
    tools: [{
      id: 'charts',
      name: 'Charts',
      description: 'Render chart artifacts.',
      kind: 'mcp',
      namespace: 'charts',
      patterns: ['mcp__charts__*'],
    }],
    mcps: [{
      name: 'charts',
      type: 'local',
      description: 'Charts MCP',
      authMode: 'none',
      command: ['node', 'charts.js'],
    }],
    agents: [{
      name: 'data-analyst',
      label: 'data-analyst',
      description: 'Analyze data.',
      instructions: 'Analyze data.',
      toolIds: ['charts'],
    }],
  }), 'utf8')
  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()
  invalidateRuntimeCatalogSnapshotCache()

  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      allowedAgents: ['data-analyst'],
      allowedTools: ['charts'],
      allowedMcps: ['charts'],
      features: {
        ...basePolicy.features,
        customSkills: false,
        customMcps: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const catalog = await readJson(await fetch(`${baseUrl}/api/capabilities`))
    const tools = asArray(catalog.tools)
    assert.equal(tools.length, 1)
    assert.equal(asRecord(tools[0]).id, 'charts')

    const charts = await readJson(await fetch(`${baseUrl}/api/capabilities/tools/charts`))
    assert.equal(asRecord(charts.tool).namespace, 'charts')
    const clockResponse = await fetch(`${baseUrl}/api/capabilities/tools/clock`)
    assert.equal(clockResponse.status, 404)

    const skills = asArray((await readJson(await fetch(`${baseUrl}/api/capabilities/skills`))).skills)
    assert.equal(skills.some((skill) => asRecord(skill).name === 'workflow-creator'), false)
    assert.equal(skills.some((skill) => asRecord(skill).toolIds && asArray(asRecord(skill).toolIds).includes('charts')), true)
  } finally {
    await fixture.server.close()
    if (previousConfigPath === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousConfigPath
    clearConfigCaches()
    invalidateRuntimeCatalogSnapshotCache()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('cloud HTTP returns policy verdicts when capabilities are disabled', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        agents: false,
        customSkills: false,
        customMcps: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/capabilities`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Capabilities are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Capabilities are disabled for this cloud profile.',
      policyCode: 'capabilities.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes user-scoped settings metadata', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const saveResponse = await fetch(`${baseUrl}/api/settings/provider.openai`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: { secretRef: 'cloud-secret/openai' } }),
    })
    assert.equal(saveResponse.status, 200)
    const saved = asRecord((await readJson(saveResponse)).setting)
    assert.equal(saved.key, 'provider.openai')
    assert.deepEqual(saved.value, { secretRef: 'cloud-secret/openai' })

    const listed = await readJson(await fetch(`${baseUrl}/api/settings`))
    assert.equal(asArray(listed.settings).length, 1)
    const fetched = await readJson(await fetch(`${baseUrl}/api/settings/provider.openai`))
    assert.deepEqual(asRecord(fetched.setting).value, { secretRef: 'cloud-secret/openai' })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects settings APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        settings: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/settings`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Settings are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Settings are disabled for this cloud profile.',
      policyCode: 'settings.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects knowledge APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        knowledge: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/knowledge`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Knowledge is disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Knowledge is disabled for this cloud profile.',
      policyCode: 'knowledge.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects channel APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        channels: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/channels`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Channels are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Channels are disabled for this cloud profile.',
      policyCode: 'channels.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects BYOK APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        byok: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/byok`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Bring-your-own-key is disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Bring-your-own-key is disabled for this cloud profile.',
      policyCode: 'byok.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP enforces the deployer agent allowlist on the prompt path', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: { ...basePolicy, allowedAgents: ['plan'] },
  })
  const baseUrl = await fixture.server.listen()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    // An agent outside the deployer allowlist is rejected — without this gate a
    // caller could name any agent on a prompt and bypass a restricted profile.
    const blocked = await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', agent: 'build' }),
    })
    assert.equal(blocked.status, 403)
    assert.equal(asRecord((await readJson(blocked)).verdict).policyCode, 'policy.agent_not_enabled')

    // An allowlisted agent is accepted.
    const allowed = await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', agent: 'plan' }),
    })
    assert.equal(allowed.status, 202)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes durable thread tags, metadata, and smart filters', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const tagResponse = await fetch(`${baseUrl}/api/threads/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Revenue', color: '#22c55e' }),
    })
    assert.equal(tagResponse.status, 201)
    const tagBody = await readJson(tagResponse)
    const tag = asRecord(tagBody.tag)
    assert.equal(tag.name, 'Revenue')

    const applyResponse = await fetch(`${baseUrl}/api/threads/tags/${tag.tagId}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['oc-session-1'] }),
    })
    assert.equal(applyResponse.status, 200)

    const threads = await readJson(await fetch(`${baseUrl}/api/threads?tagId=${tag.tagId}`))
    const thread = asRecord(asArray(threads.threads)[0])
    assert.equal(thread.sessionId, 'oc-session-1')
    assert.equal(asRecord(asArray(thread.tags)[0]).name, 'Revenue')

    const updateTagResponse = await fetch(`${baseUrl}/api/threads/tags/${tag.tagId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Finance' }),
    })
    assert.equal(updateTagResponse.status, 200)
    assert.equal(asRecord((await readJson(updateTagResponse)).tag).name, 'Finance')

    const filterResponse = await fetch(`${baseUrl}/api/threads/smart-filters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tagged finance', query: { tagIds: [tag.tagId] } }),
    })
    assert.equal(filterResponse.status, 201)
    const filter = asRecord((await readJson(filterResponse)).filter)
    assert.equal(filter.name, 'Tagged finance')

    const filters = await readJson(await fetch(`${baseUrl}/api/threads/smart-filters`))
    assert.equal(asArray(filters.filters).length, 1)

    const removeResponse = await fetch(`${baseUrl}/api/threads/tags/${tag.tagId}/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['oc-session-1'] }),
    })
    assert.equal(removeResponse.status, 200)
    const untagged = await readJson(await fetch(`${baseUrl}/api/threads`))
    assert.deepEqual(asRecord(asArray(untagged.threads)[0]).tags, [])
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects thread-index APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        threadIndex: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/threads/tags`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Thread index is disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Thread index is disabled for this cloud profile.',
      policyCode: 'thread_index.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes workflow create, manual run, and durable finalization', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const createResponse = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Revenue daily',
        instructions: 'Summarize revenue for today.',
        agentName: 'data-analyst',
        toolIds: ['charts'],
        steps: [
          { id: 'load', title: 'Load daily revenue', detail: 'Fetch the latest revenue inputs.' },
          { id: 'summarize', title: 'Summarize variance', detail: 'Highlight material changes.' },
        ],
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = asRecord((await readJson(createResponse)).workflow)
    assert.equal(created.title, 'Revenue daily')
    assert.equal(created.status, 'active')
    assert.deepEqual(asArray(created.steps).map((step) => String(asRecord(step).title)), [
      'Load daily revenue',
      'Summarize variance',
    ])

    const workflowId = String(created.id)
    const runResponse = await fetch(`${baseUrl}/api/workflows/${workflowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ triggerPayload: { requestedBy: 'test' } }),
    })
    assert.equal(runResponse.status, 202)
    const runBody = await readJson(runResponse)
    assert.equal(runBody.processed, 1)
    assert.equal(fixture.runtime.prompts[0]?.agent, 'data-analyst')
    const firstPart = fixture.runtime.prompts[0]?.parts[0]
    assert.equal(firstPart?.type, 'text')
    assert.equal(firstPart?.type === 'text' ? firstPart.text : null, 'Summarize revenue for today.')

    const run = asRecord(runBody.run)
    assert.equal(run.status, 'completed')
    assert.equal(run.sessionId, 'oc-session-1')
    assert.equal(run.summary, 'echo: Summarize revenue for today.')

    const workflow = asRecord(runBody.workflow)
    assert.equal(workflow.status, 'active')
    assert.equal(workflow.latestRunStatus, 'completed')

    const fetched = asRecord((await readJson(await fetch(`${baseUrl}/api/workflows/${workflowId}`))).workflow)
    assert.equal(asRecord(asArray(fetched.runs)[0]).status, 'completed')
    assert.deepEqual(asArray(fetched.steps).map((step) => String(asRecord(step).title)), [
      'Load daily revenue',
      'Summarize variance',
    ])
    const listed = await readJson(await fetch(`${baseUrl}/api/workflows`))
    assert.equal(asArray(listed.workflows).length, 1)
    assert.equal(asArray(listed.runs).length, 1)
    const listedWorkflow = asRecord(asArray(listed.workflows)[0])
    assert.deepEqual(asArray(listedWorkflow.steps).map((step) => String(asRecord(step).title)), [
      'Load daily revenue',
      'Summarize variance',
    ])
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP validates workflow schedules at the create boundary', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const postWorkflow = (triggers: unknown[]) => fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Scheduled revenue',
      instructions: 'Summarize scheduled revenue.',
      agentName: 'data-analyst',
      triggers,
    }),
  })

  try {
    const invalidHour = await postWorkflow([{
      id: 'daily',
      type: 'schedule',
      enabled: true,
      schedule: {
        type: 'daily',
        timezone: 'UTC',
        runAtHour: 24,
      },
    }])
    assert.equal(invalidHour.status, 400)
    assert.match(String((await readJson(invalidHour)).error), /runAtHour/)

    const pastOneTime = await postWorkflow([{
      id: 'once',
      type: 'schedule',
      enabled: true,
      schedule: {
        type: 'one_time',
        timezone: 'UTC',
        startAt: '2000-01-01T00:00:00.000Z',
      },
    }])
    assert.equal(pastOneTime.status, 400)
    assert.match(String((await readJson(pastOneTime)).error), /future/)

    const futureStartAt = '2099-01-01T00:00:00.000Z'
    const valid = await postWorkflow([{
      id: 'once',
      type: 'schedule',
      enabled: true,
      schedule: {
        type: 'one_time',
        timezone: 'UTC',
        startAt: futureStartAt,
      },
    }])
    assert.equal(valid.status, 201)
    const workflow = asRecord((await readJson(valid)).workflow)
    assert.equal(workflow.nextRunAt, futureStartAt)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP gates managed workflow runs by concurrency and hourly quotas', async () => {
  const createWorkflow = async (baseUrl: string, suffix: string) => {
    const response = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: `Workflow quota ${suffix}`,
        instructions: `Run quota workflow ${suffix}.`,
        agentName: 'data-analyst',
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      }),
    })
    assert.equal(response.status, 201)
    return String(asRecord((await readJson(response)).workflow).id)
  }

  const concurrentFixture = createFixture({
    autoProcessCommands: false,
    abuse: testAbuseConfig({
      maxConcurrentWorkflowRunsPerOrg: 1,
      maxWorkflowRunsPerHour: 100,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const concurrentBaseUrl = await concurrentFixture.server.listen()
  try {
    const firstWorkflowId = await createWorkflow(concurrentBaseUrl, 'concurrent-a')
    const secondWorkflowId = await createWorkflow(concurrentBaseUrl, 'concurrent-b')
    const firstRun = await fetch(`${concurrentBaseUrl}/api/workflows/${firstWorkflowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(firstRun.status, 202)
    const blocked = await fetch(`${concurrentBaseUrl}/api/workflows/${secondWorkflowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(blocked.status, 429)
    assert.equal(asRecord((await readJson(blocked)).verdict).policyCode, 'quota.concurrent_workflow_runs_exceeded')
  } finally {
    await concurrentFixture.server.close()
  }

  const hourlyFixture = createFixture({
    autoProcessCommands: false,
    abuse: testAbuseConfig({
      maxConcurrentWorkflowRunsPerOrg: 100,
      maxWorkflowRunsPerHour: 1,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const hourlyBaseUrl = await hourlyFixture.server.listen()
  try {
    const firstWorkflowId = await createWorkflow(hourlyBaseUrl, 'hourly-a')
    const secondWorkflowId = await createWorkflow(hourlyBaseUrl, 'hourly-b')
    const firstRun = await fetch(`${hourlyBaseUrl}/api/workflows/${firstWorkflowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(firstRun.status, 202)
    const blocked = await fetch(`${hourlyBaseUrl}/api/workflows/${secondWorkflowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(blocked.status, 429)
    assert.equal(asRecord((await readJson(blocked)).verdict).policyCode, 'quota.workflow_runs_per_hour_exceeded')
    const summary = await readJson(await fetch(`${hourlyBaseUrl}/api/usage/summary?limit=50`))
    const workflowQuota = asArray(summary.quotas).map(asRecord).find((quota) => quota.quotaKey === 'workflow_runs:hour')
    assert.equal(workflowQuota?.limit, 1)
    assert.equal(workflowQuota?.used, 1)
  } finally {
    await hourlyFixture.server.close()
  }
})

test('cloud HTTP rejects workflow starts before creating runs when managed command queues are full', async () => {
  const fixture = createFixture({
    autoProcessCommands: false,
    abuse: testAbuseConfig({
      maxQueuedCommandsPerOrg: 1,
      maxPromptsPerHour: 100,
      maxWorkflowRunsPerHour: 100,
      maxConcurrentWorkflowRunsPerOrg: 100,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const session = asRecord((await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))).session)
    assert.equal((await fetch(`${baseUrl}/api/sessions/${session.sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'fill the managed command queue' }),
    })).status, 202)

    const workflowResponse = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Workflow queue full',
        instructions: 'This text must not be enqueued while the queue is full.',
        agentName: 'data-analyst',
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      }),
    })
    assert.equal(workflowResponse.status, 201)
    const workflowId = String(asRecord((await readJson(workflowResponse)).workflow).id)
    const blocked = await fetch(`${baseUrl}/api/workflows/${workflowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(blocked.status, 429)
    assert.equal(asRecord((await readJson(blocked)).verdict).policyCode, 'quota.queued_commands_exceeded')

    const workflow = asRecord((await readJson(await fetch(`${baseUrl}/api/workflows/${workflowId}`))).workflow)
    assert.equal(asArray(workflow.runs).length, 0)
    const usage = await readJson(await fetch(`${baseUrl}/api/usage/events?limit=50`))
    assert.equal(JSON.stringify(usage).includes('This text must not be enqueued'), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP scheduler tick requires an internal token', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const missing = await fetch(`${baseUrl}/api/workflows/scheduler/tick`, { method: 'POST' })
    assert.equal(missing.status, 404)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP scheduler tick claims one due workflow and starts it once with internal token', async () => {
  const fixture = createFixture({ internalToken: 'test-internal-token' })
  const baseUrl = await fixture.server.listen()
  try {
    await fixture.service.ensurePrincipal({
      tenantId: 'tenant-1',
      tenantName: 'Tenant 1',
      userId: 'user-1',
      email: 'user@example.test',
    })
    fixture.store.createWorkflow({
      tenantId: 'tenant-1',
      userId: 'user-1',
      workflowId: 'workflow-scheduled',
      draft: {
        title: 'Scheduled revenue',
        instructions: 'Run the scheduled report.',
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{
          id: 'schedule-1',
          type: 'schedule',
          enabled: true,
          schedule: {
            type: 'daily',
            timezone: 'UTC',
            runAtHour: 9,
            runAtMinute: 0,
          },
        }],
      },
      nextRunAt: '2026-01-01T09:00:00.000Z',
    })

    const rejected = await fetch(`${baseUrl}/api/workflows/scheduler/tick`, { method: 'POST' })
    assert.equal(rejected.status, 403)

    const tickResponse = await fetch(`${baseUrl}/api/workflows/scheduler/tick`, {
      method: 'POST',
      headers: { 'x-open-cowork-internal-token': 'test-internal-token' },
    })
    assert.equal(tickResponse.status, 200)
    const tick = await readJson(tickResponse)
    assert.equal(tick.processed, 1)
    const claimed = asRecord(tick.claimed)
    assert.equal(claimed.tenantId, 'tenant-1')
    assert.equal(claimed.workflowId, 'workflow-scheduled')
    assert.equal(typeof claimed.runId, 'string')
    assert.equal(typeof claimed.sessionId, 'string')
    assert.equal(Object.prototype.hasOwnProperty.call(claimed, 'workflow'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(claimed, 'command'), false)
    assert.equal(fixture.runtime.prompts.length, 1)

    const secondTick = await readJson(await fetch(`${baseUrl}/api/workflows/scheduler/tick`, {
      method: 'POST',
      headers: { 'x-open-cowork-internal-token': 'test-internal-token' },
    }))
    assert.equal(secondTick.claimed, null)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP public workflow webhooks require HMAC signatures and reject replay', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        webhooks: true,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const createResponse = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Webhook revenue',
        instructions: 'Run from webhook.',
        agentName: 'data-analyst',
        triggers: [{
          id: 'webhook-1',
          type: 'webhook',
          enabled: true,
          webhookSecret: 'cloud-webhook-secret',
        }],
      }),
    })
    assert.equal(createResponse.status, 201)
    const workflowId = String(asRecord((await readJson(createResponse)).workflow).id)
    const rawBody = JSON.stringify({ source: 'test-webhook' })
    const timestamp = new Date().toISOString()
    const signature = signWorkflowWebhookPayload('cloud-webhook-secret', rawBody, timestamp)

    const sharedSecretResponse = await fetch(`${baseUrl}/webhooks/workflows/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-webhook-secret': 'cloud-webhook-secret',
      },
      body: rawBody,
    })
    assert.equal(sharedSecretResponse.status, 401)

    const accepted = await fetch(`${baseUrl}/webhooks/workflows/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-timestamp': timestamp,
        'x-open-cowork-signature': signature,
      },
      body: rawBody,
    })
    assert.equal(accepted.status, 202)
    const acceptedBody = await readJson(accepted)
    assert.equal(acceptedBody.ok, true)
    assert.equal(acceptedBody.processed, 1)
    assert.equal(fixture.runtime.prompts[0]?.parts[0]?.type === 'text'
      ? fixture.runtime.prompts[0].parts[0].text
      : null, 'Run from webhook.')

    const replay = await fetch(`${baseUrl}/webhooks/workflows/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-timestamp': timestamp,
        'x-open-cowork-signature': signature,
      },
      body: rawBody,
    })
    assert.equal(replay.status, 401)
  } finally {
    await fixture.server.close()
  }
})

test('cloud workflow webhook security keys honor trusted proxy client attribution', async () => {
  const requestSources: string[] = []
  const authScopes: string[] = []
  const signatureKeys: string[] = []
  const securityStore: WorkflowWebhookSecurityStore = {
    claimRequest(input) {
      requestSources.push(input.source)
      return true
    },
    checkAuthBackoff(input) {
      authScopes.push(input.scope)
      return true
    },
    recordAuthFailure() {
      throw new Error('recordAuthFailure should not run for an accepted webhook.')
    },
    claimSignature(input) {
      signatureKeys.push(input.key)
      return { accept() {}, release() {} }
    },
    clear() {},
  }
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    webhookSecurity: securityStore,
    trustProxyHeaders: true,
    trustedProxyCidrs: ['127.0.0.0/8'],
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        webhooks: true,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const createResponse = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Webhook proxy source',
        instructions: 'Run from a trusted proxy.',
        agentName: 'data-analyst',
        triggers: [{
          id: 'webhook-1',
          type: 'webhook',
          enabled: true,
          webhookSecret: 'cloud-webhook-secret',
        }],
      }),
    })
    assert.equal(createResponse.status, 201)
    const workflowId = String(asRecord((await readJson(createResponse)).workflow).id)
    const rawBody = JSON.stringify({ source: 'trusted-proxy-test' })
    const timestamp = new Date().toISOString()
    const signature = signWorkflowWebhookPayload('cloud-webhook-secret', rawBody, timestamp)

    const accepted = await fetch(`${baseUrl}/webhooks/workflows/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.8, 127.0.0.2',
        'x-open-cowork-timestamp': timestamp,
        'x-open-cowork-signature': signature,
      },
      body: rawBody,
    })
    assert.equal(accepted.status, 202)
    assert.deepEqual(requestSources, ['203.0.113.8'])
    assert.equal(authScopes[0]?.startsWith('203.0.113.8:'), true)
    assert.equal(signatureKeys.length, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud workflow webhooks enqueue managed worker execution without web auto-processing', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    autoProcessCommands: false,
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        webhooks: true,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const createResponse = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Webhook managed worker',
        instructions: 'Run later from worker.',
        agentName: 'data-analyst',
        triggers: [{
          id: 'webhook-1',
          type: 'webhook',
          enabled: true,
          webhookSecret: 'cloud-webhook-secret',
        }],
      }),
    })
    assert.equal(createResponse.status, 201)
    const workflowId = String(asRecord((await readJson(createResponse)).workflow).id)
    const rawBody = JSON.stringify({ source: 'test-webhook' })
    const timestamp = new Date().toISOString()
    const signature = signWorkflowWebhookPayload('cloud-webhook-secret', rawBody, timestamp)

    const accepted = await fetch(`${baseUrl}/webhooks/workflows/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-timestamp': timestamp,
        'x-open-cowork-signature': signature,
      },
      body: rawBody,
    })
    assert.equal(accepted.status, 202)
    const acceptedBody = await readJson(accepted)
    assert.equal(acceptedBody.ok, true)
    assert.equal(acceptedBody.processed, 0)
    assert.equal(fixture.runtime.prompts.length, 0)

    const sessionId = String(acceptedBody.sessionId)
    const queuedWorkflow = asRecord((await readJson(await fetch(`${baseUrl}/api/workflows/${workflowId}`))).workflow)
    assert.equal(queuedWorkflow.latestRunStatus, 'running')
    assert.equal(queuedWorkflow.latestRunSessionId, sessionId)

    assert.equal(await fixture.worker.processAllSessionCommands(), 1)
    assert.equal(fixture.runtime.prompts.length, 1)
    assert.equal(fixture.runtime.prompts[0]?.parts[0]?.type === 'text'
      ? fixture.runtime.prompts[0].parts[0].text
      : null, 'Run later from worker.')

    const completedWorkflow = asRecord((await readJson(await fetch(`${baseUrl}/api/workflows/${workflowId}`))).workflow)
    assert.equal(completedWorkflow.latestRunStatus, 'completed')
    assert.equal(completedWorkflow.latestRunSummary, 'echo: Run later from worker.')
  } finally {
    await fixture.server.close()
  }
})

test('cloud workflow recovery enqueues missing commands on attached runs without duplicating sessions', async () => {
  const fixture = createFixture({ autoProcessCommands: false })
  fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  fixture.store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.test', role: 'owner' })
  const workflow = fixture.store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-attached-recovery',
    draft: {
      title: 'Attached recovery',
      instructions: 'Recover the missing command.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
  fixture.store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'workflow-stranded-session',
    opencodeSessionId: '',
    profileName: 'full',
    title: 'Run Attached recovery',
    createdAt: new Date('2030-01-01T09:00:00.000Z'),
  })
  const run = fixture.store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: workflow.id,
    runId: 'workflow-attached-recovery-run',
    triggerType: 'manual',
    triggerPayload: { source: 'test' },
    claimedBy: 'workflow-api:user-1',
    leaseTtlMs: 30_000,
    createdAt: new Date('2030-01-01T09:00:00.001Z'),
  })
  assert.ok(run.claimToken)
  fixture.store.attachWorkflowRunSession({
    tenantId: 'tenant-1',
    workflowId: workflow.id,
    runId: run.id,
    sessionId: 'workflow-stranded-session',
    claimToken: run.claimToken,
    startedAt: new Date('2030-01-01T09:00:00.002Z'),
  })

  const started = await fixture.service.claimAndStartDueWorkflow(
    new Date('2030-01-01T09:00:00.003Z'),
    'scheduler-recovery',
  )
  assert.equal(started?.run.id, run.id)
  assert.equal(started?.sessionId, 'workflow-stranded-session')
  assert.equal(started?.command.commandId, `workflow:tenant-1:${workflow.id}:${run.id}:prompt`)
  assert.equal(fixture.runtime.prompts.length, 0)

  assert.equal(await fixture.worker.processAllSessionCommands(), 1)
  assert.equal(fixture.runtime.prompts.length, 1)
  assert.equal(fixture.runtime.prompts[0]?.sessionId, 'oc-session-1')
  assert.equal(fixture.runtime.prompts[0]?.parts[0]?.type === 'text'
    ? fixture.runtime.prompts[0].parts[0].text
    : null, 'Recover the missing command.')

  const detail = await fixture.service.getWorkflow({
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user@example.test',
    role: 'owner',
    authSource: 'local',
  }, workflow.id)
  assert.equal(detail?.latestRunStatus, 'completed')
  assert.equal(detail?.latestRunSessionId, 'workflow-stranded-session')

  const second = await fixture.service.claimAndStartDueWorkflow(
    new Date('2030-01-01T09:00:00.004Z'),
    'scheduler-recovery',
  )
  assert.equal(second, null)
})

test('cloud HTTP rejects workflow APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        workflows: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/workflows`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Workflows are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Workflows are disabled for this cloud profile.',
      policyCode: 'workflows.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP artifacts use object storage and durable artifact events', async () => {
  const fixture = createFixture({ abuse: testAbuseConfig() })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const uploadedResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'report.txt',
        contentType: 'text/plain',
        dataBase64: Buffer.from('cloud artifact').toString('base64'),
        authorAgentId: 'agent-writer',
        projectId: 'project-1',
        taskId: 'task-1',
      }),
    })
    assert.equal(uploadedResponse.status, 201)
    const uploadedBody = await readJson(uploadedResponse)
    const uploaded = asRecord(uploadedBody.artifact)
    assert.equal(uploaded.filename, 'report.txt')
    assert.equal(uploaded.size, 'cloud artifact'.length)
    assert.equal(uploaded.kind, 'document')
    assert.equal(uploaded.status, 'draft')
    assert.equal(uploaded.authorAgentId, 'agent-writer')
    assert.equal(uploaded.projectId, 'project-1')
    assert.equal(uploaded.taskId, 'task-1')
    assert.equal('key' in uploaded, false)

    const listed = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))
    const artifacts = asArray(listed.artifacts)
    assert.equal(artifacts.length, 1)
    const listedArtifact = asRecord(artifacts[0])
    assert.equal(listedArtifact.artifactId, uploaded.artifactId)
    assert.equal(listedArtifact.status, 'draft')
    assert.equal('key' in listedArtifact, false)

    const invalidTimestampResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'bad-timestamp.txt',
        contentType: 'text/plain',
        dataBase64: Buffer.from('bad timestamp').toString('base64'),
        statusUpdatedAt: 'next week',
      }),
    })
    assert.equal(invalidTimestampResponse.status, 400)
    const afterInvalidTimestamp = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))
    assert.equal(asArray(afterInvalidTimestamp.artifacts).length, 1)

    const indexed = await readJson(await fetch(`${baseUrl}/api/artifacts?projectId=project-1&status=draft&kind=document`))
    const indexedArtifacts = asArray(indexed.artifacts).map(asRecord)
    assert.equal(indexedArtifacts.length, 1)
    assert.equal(indexedArtifacts[0]?.artifactId, uploaded.artifactId)
    assert.equal(indexedArtifacts[0]?.sessionId, sessionId)
    assert.equal(indexedArtifacts[0]?.projectId, 'project-1')
    assert.equal('key' in indexedArtifacts[0]!, false)

    const indexedByTaskIds = await readJson(await fetch(`${baseUrl}/api/artifacts?projectId=project-other&taskIds=task-1&taskIds=missing`))
    const taskLinkedArtifacts = asArray(indexedByTaskIds.artifacts).map(asRecord)
    assert.equal(taskLinkedArtifacts.length, 1)
    assert.equal(taskLinkedArtifacts[0]?.artifactId, uploaded.artifactId)
    assert.equal(taskLinkedArtifacts[0]?.taskId, 'task-1')
    assert.equal('key' in taskLinkedArtifacts[0]!, false)

    const emptyTaskIdsResponse = await fetch(`${baseUrl}/api/artifacts?taskIds=,,`)
    assert.equal(emptyTaskIdsResponse.status, 200)
    const emptyTaskIds = await readJson(emptyTaskIdsResponse)
    assert.equal(asArray(emptyTaskIds.artifacts).length, 1)

    const statusResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${uploaded.artifactId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'in-review',
        updatedBy: 'reviewer-1',
      }),
    })
    assert.equal(statusResponse.status, 200)
    const statusBody = await readJson(statusResponse)
    const reviewedArtifact = asRecord(statusBody.artifact)
    assert.equal(reviewedArtifact.status, 'in-review')
    assert.equal(reviewedArtifact.statusUpdatedBy, 'reviewer-1')
    assert.equal('key' in reviewedArtifact, false)

    const principal = {
      tenantId: 'tenant-1',
      tenantName: 'Tenant 1',
      orgId: 'tenant-1',
      userId: 'user-1',
      accountId: 'user-1',
      email: 'user@example.test',
      role: 'owner' as const,
      authSource: 'local' as const,
    }
    const eventsAfterReview = await fixture.service.listEvents(principal, sessionId)
    const firstUpdatePayload = asRecord(eventsAfterReview.find((event) => event.type === 'artifact.updated')?.payload)
    assert.equal(firstUpdatePayload.statusUpdatedBy, 'reviewer-1')
    assert.equal('key' in firstUpdatePayload, false)

    const regressionResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${uploaded.artifactId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'draft', updatedBy: 'reviewer-1' }),
    })
    assert.equal(regressionResponse.status, 409)

    const finalResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${uploaded.artifactId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'final' }),
    })
    assert.equal(finalResponse.status, 200)
    const finalArtifact = asRecord(asRecord(await readJson(finalResponse)).artifact)
    assert.equal(finalArtifact.status, 'final')
    assert.equal(finalArtifact.statusUpdatedBy, null)
    assert.equal('key' in finalArtifact, false)

    const updateEvents = (await fixture.service.listEvents(principal, sessionId)).filter((event) => event.type === 'artifact.updated')
    assert.equal(updateEvents.length, 2)
    const finalUpdatePayload = asRecord(updateEvents.at(-1)?.payload)
    assert.equal(finalUpdatePayload.status, 'final')
    assert.equal(finalUpdatePayload.statusUpdatedBy, null)
    assert.equal('key' in finalUpdatePayload, false)

    const read = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${uploaded.artifactId}`))
    const artifact = asRecord(read.artifact)
    assert.equal(Buffer.from(String(artifact.dataBase64), 'base64').toString('utf8'), 'cloud artifact')
    assert.equal(artifact.status, 'final')
    assert.equal(artifact.statusUpdatedBy, null)
    assert.equal('key' in artifact, false)
    const usage = await readJson(await fetch(`${baseUrl}/api/usage/events`))
    const usageEvents = asArray(usage.events).map(asRecord)
    const downloaded = usageEvents.find((event) => event.eventType === 'artifact.downloaded')
    assert.equal(downloaded?.quantity, 'cloud artifact'.length)

    await assert.rejects(() => fixture.artifacts.readSessionArtifact({
      tenantId: 'tenant-2',
      orgId: 'tenant-2',
      tenantName: 'Tenant 2',
      userId: 'user-2',
      accountId: 'user-2',
      email: 'user2@example.test',
      role: 'owner' as const,
      authSource: 'user' as const,
    }, sessionId, String(uploaded.artifactId)), /Cloud session was not found|Unknown session|Unknown tenant/)
  } finally {
    await fixture.server.close()
  }
})

test('cloud artifact index scans paged sessions until matching artifacts are found', async () => {
  const principal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user1@example.test',
    role: 'owner',
    authSource: 'user',
  }
  const sessions = [
    ...Array.from({ length: 100 }, (_value, index) => ({
      sessionId: `session-empty-${index + 1}`,
      title: `Empty session ${index + 1}`,
      updatedAt: '2026-01-02T00:00:00.000Z',
    })),
    { sessionId: 'session-artifact', title: 'Artifact session', updatedAt: '2026-01-01T00:00:00.000Z' },
  ]
  const eventCalls: string[] = []
  const requestedLimits: Array<number | undefined> = []
  const sessionService = {
    async listSessions() {
      assert.fail('Artifact index must use paged session listing.')
    },
    async listSessionsPage(_principal: CloudPrincipal, input: { limit?: number, cursor?: string | null } = {}) {
      requestedLimits.push(input.limit)
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit ?? sessions.length
      const nextOffset = offset + limit
      return {
        items: sessions.slice(offset, nextOffset),
        nextCursor: nextOffset < sessions.length ? String(nextOffset) : null,
        totalEstimate: sessions.length,
      }
    },
    async getSessionView(_principal: CloudPrincipal, sessionId: string) {
      const session = sessions.find((entry) => entry.sessionId === sessionId)
      if (!session) throw new Error(`Unknown session ${sessionId}`)
      return { session, projection: null }
    },
    async listEvents(_principal: CloudPrincipal, sessionId: string) {
      eventCalls.push(sessionId)
      if (sessionId !== 'session-artifact') return []
      return [{
        type: 'artifact.created',
        payload: {
          artifactId: 'artifact-older',
          sessionId,
          filename: 'older.txt',
          contentType: 'text/plain',
          size: 6,
          key: 'tenants/tenant-1/private-object-key-older',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          kind: 'document',
          status: 'draft',
          authorAgentId: 'agent-writer',
          projectId: 'project-1',
          taskId: 'task-1',
          statusUpdatedBy: null,
          statusUpdatedAt: null,
        },
      }, {
        type: 'artifact.created',
        payload: {
          artifactId: 'artifact-newer',
          sessionId,
          filename: 'newer.txt',
          contentType: 'text/plain',
          size: 7,
          key: 'tenants/tenant-1/private-object-key-newer',
          createdAt: '2026-01-01T00:01:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
          kind: 'document',
          status: 'draft',
          authorAgentId: 'agent-writer',
          projectId: 'project-1',
          taskId: 'task-1',
          statusUpdatedBy: null,
          statusUpdatedAt: null,
        },
      }]
    },
  } as unknown as CloudSessionService
  const artifacts = new CloudArtifactService(sessionService, createInMemoryObjectStore())

  const indexed = await artifacts.listArtifactIndex(principal, { limit: 1 })
  assert.equal(indexed.artifacts.length, 1)
  assert.equal(indexed.artifacts[0]?.artifactId, 'artifact-newer')
  assert.equal('key' in indexed.artifacts[0]!, false)
  assert.equal(indexed.scannedSessions, 101)
  assert.equal(indexed.truncated, true)
  assert.deepEqual(requestedLimits, [100, 100])
  assert.equal(eventCalls.length, 101)
  assert.equal(eventCalls[0], 'session-empty-1')
  assert.equal(eventCalls.at(-1), 'session-artifact')

  requestedLimits.length = 0
  eventCalls.length = 0
  const complete = await artifacts.listArtifactIndex(principal, { limit: 2 })
  assert.equal(complete.artifacts.length, 2)
  assert.deepEqual(complete.artifacts.map((artifact) => artifact.artifactId), ['artifact-newer', 'artifact-older'])
  assert.equal(complete.scannedSessions, 101)
  assert.equal(complete.truncated, true)
  assert.deepEqual(requestedLimits, [100, 100])
  assert.equal(eventCalls.length, 101)

  requestedLimits.length = 0
  eventCalls.length = 0
  const linkedByTask = await artifacts.listArtifactIndex(principal, {
    projectId: 'project-with-task-only-artifacts',
    taskIds: ['task-1'],
    limit: 1,
  })
  assert.equal(linkedByTask.artifacts.length, 1)
  assert.equal(linkedByTask.artifacts[0]?.artifactId, 'artifact-newer')
  assert.equal(linkedByTask.truncated, true)
  assert.deepEqual(requestedLimits, [100, 100])
})

test('cloud HTTP returns policy verdicts when artifacts are disabled', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        artifacts: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/sessions/oc-session-1/artifacts`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Artifacts are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Artifacts are disabled for this cloud profile.',
      policyCode: 'artifacts.disabled',
    })
    const indexResponse = await fetch(`${baseUrl}/api/artifacts`)
    assert.equal(indexResponse.status, 403)
  } finally {
    await fixture.server.close()
  }
})
