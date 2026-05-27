import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../apps/desktop/src/main/config-types.ts'
import { CloudArtifactService } from '../apps/desktop/src/main/cloud/artifact-service.ts'
import { createApiTokenCloudAuthResolver } from '../apps/desktop/src/main/cloud/app.ts'
import { resolveCloudRuntimePolicy, type CloudRuntimePolicy } from '../apps/desktop/src/main/cloud/cloud-config.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/control-plane-store.ts'
import {
  createCloudHttpServer,
  type CloudAuthResolver,
  type CloudBrowserAuthProvider,
  type CloudDesktopAuthConfig,
} from '../apps/desktop/src/main/cloud/http-server.ts'
import { createHttpSseCloudTransportAdapter } from '../apps/desktop/src/main/cloud/transport-adapter.ts'
import { CloudWorkspaceAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { createInMemoryObjectStore } from '../apps/desktop/src/main/cloud/object-store.ts'
import type { CloudObservabilityAdapter } from '../apps/desktop/src/main/cloud/observability.ts'
import { createCloudSessionCookieManager } from '../apps/desktop/src/main/cloud/session-cookie-auth.ts'
import { CloudSessionService } from '../apps/desktop/src/main/cloud/session-service.ts'
import { CloudWorker } from '../apps/desktop/src/main/cloud/worker.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimePromptPart,
} from '../apps/desktop/src/main/cloud/runtime-adapter.ts'
import { signWorkflowWebhookPayload } from '../apps/desktop/src/main/workflow/workflow-webhook-server.ts'

const TEST_COOKIE_KEY = 'not-a-real-cookie-key-for-tests'

class FakeRuntimeAdapter implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string, parts: CloudRuntimePromptPart[], agent: string }> = []
  aborted: string[] = []
  private nextSession = 0

  async createSession() {
    this.nextSession += 1
    const id = `oc-session-${this.nextSession}`
    return {
      id,
      title: `Session ${this.nextSession}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.prompts.push(input)
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
  } = {}) {
  const runtime = new FakeRuntimeAdapter()
  const store = new InMemoryControlPlaneStore()
  const objectStore = createInMemoryObjectStore()
  const policy = options.policy || resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  let nextId = 0
  const service = new CloudSessionService(store, runtime, policy, undefined, {
    randomUUID: () => `cmd-${nextId += 1}`,
  })
  const artifacts = new CloudArtifactService(service, objectStore, {
    randomUUID: () => `artifact-${nextId += 1}`,
  })
  const worker = new CloudWorker(store, service, 'worker-1')
  const server = createCloudHttpServer({
    service,
    artifacts,
    worker,
    policy,
    autoProcessCommands: options.autoProcessCommands ?? true,
    ssePollMs: options.ssePollMs,
    sessionCookies: options.sessionCookies,
      browserAuth: options.browserAuth,
      desktopAuth: options.desktopAuth,
      observability: options.observability,
      internalToken: options.internalToken,
      auth: options.auth || (() => ({
      tenantId: 'tenant-1',
      tenantName: 'Tenant 1',
      userId: 'user-1',
      email: 'user@example.test',
    })),
  })
  return { runtime, store, objectStore, policy, service, worker, server }
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
    assert.match(html, /\/api\/sessions/)
    assert.match(html, /\/api\/runtime\/status/)

    const config = await readJson(await fetch(`${baseUrl}/api/config`))
    assert.equal(config.profileName, 'full')
    assert.equal(config.features.chat, true)

    const runtimeStatus = await readJson(await fetch(`${baseUrl}/api/runtime/status`))
    assert.equal(runtimeStatus.role, 'all-in-one')
    assert.equal(runtimeStatus.canExecute, true)
    assert.equal(runtimeStatus.commandProcessing, 'inline')

    const workspace = await readJson(await fetch(`${baseUrl}/api/workspace`))
    assert.equal(workspace.tenantId, 'tenant-1')
    assert.equal(workspace.userId, 'user-1')
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
    assert.deepEqual(fixture.runtime.aborted, ['oc-session-1'])
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
    name: 'Gateway token',
    scopes: ['gateway'],
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
    const stream = await fetch(`${baseUrl}/api/events?after=${firstAssistant.sequence}`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)
    const replayed = await readSseUntil(stream, (entry) => (
      entry.type === 'assistant.message' && entry.sessionId === 'oc-session-2'
    ))
    assert.equal(asRecord(replayed.payload).content, 'echo: second session')
  } finally {
    controller.abort()
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
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    fixture.service.listWorkspaceEvents = async (principal, afterSequence = 0) => {
      if (afterSequence === 0) {
        return [{
          tenantId: 'tenant-1',
          userId: 'user-1',
          sessionId: 'oc-session-1',
          eventId: 'oc-session-1:retained-event-10',
          sequence: 10,
          type: 'assistant.message',
          payload: { content: 'retained only' },
          createdAt: '2026-01-01T00:00:00.000Z',
        }]
      }
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
  } finally {
    controller.abort()
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
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = asRecord((await readJson(createResponse)).workflow)
    assert.equal(created.title, 'Revenue daily')
    assert.equal(created.status, 'active')

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
    const listed = await readJson(await fetch(`${baseUrl}/api/workflows`))
    assert.equal(asArray(listed.workflows).length, 1)
    assert.equal(asArray(listed.runs).length, 1)
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
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const uploadedResponse = await fetch(`${baseUrl}/api/sessions/oc-session-1/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'report.txt',
        contentType: 'text/plain',
        dataBase64: Buffer.from('cloud artifact').toString('base64'),
      }),
    })
    assert.equal(uploadedResponse.status, 201)
    const uploadedBody = await readJson(uploadedResponse)
    const uploaded = asRecord(uploadedBody.artifact)
    assert.equal(uploaded.filename, 'report.txt')
    assert.equal(uploaded.size, 'cloud artifact'.length)

    const listed = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/artifacts`))
    const artifacts = asArray(listed.artifacts)
    assert.equal(artifacts.length, 1)
    assert.equal(asRecord(artifacts[0]).artifactId, uploaded.artifactId)

    const read = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/artifacts/${uploaded.artifactId}`))
    const artifact = asRecord(read.artifact)
    assert.equal(Buffer.from(String(artifact.dataBase64), 'base64').toString('utf8'), 'cloud artifact')
  } finally {
    await fixture.server.close()
  }
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
  } finally {
    await fixture.server.close()
  }
})
