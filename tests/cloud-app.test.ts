import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { DEFAULT_CONFIG } from '../apps/desktop/src/main/config-types.ts'
import {
  createControlPlaneStoreForCloud,
  createHeaderCloudAuthResolver,
  resolveCloudControlPlaneUrl,
  resolveCloudBootstrapOptionsFromEnv,
  resolveCloudOidcClientSecret,
  shouldRunCloudScheduler,
  shouldRunCloudWeb,
  shouldRunCloudWorker,
  startCloudApp,
} from '../apps/desktop/src/main/cloud/app.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/control-plane-store.ts'
import { createInMemoryObjectStore } from '../apps/desktop/src/main/cloud/object-store.ts'
import { createCloudPathProvider } from '../apps/desktop/src/main/cloud/path-provider.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEventListener,
  CloudRuntimePromptPart,
} from '../apps/desktop/src/main/cloud/runtime-adapter.ts'
import { sessionCheckpointLatestKey } from '../apps/desktop/src/main/cloud/workspace-checkpoint-store.ts'

const TEST_COOKIE_KEY = 'not-a-real-cookie-key-for-tests'

class FakeRuntime implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string, parts: CloudRuntimePromptPart[], agent: string }> = []
  questionReplies: Array<{ requestId: string, answers: unknown[] }> = []
  permissionResponses: Array<{ permissionId: string, allowed: boolean }> = []
  listeners: CloudRuntimeEventListener[] = []
  closed = false
  private nextSession = 0

  async createSession() {
    this.nextSession += 1
    return {
      id: `session-${this.nextSession}`,
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
          messageId: `${input.sessionId}:assistant`,
          content: 'runtime answer',
        },
      }],
    }
  }

  async abortSession() {}

  async replyToQuestion(input: { requestId: string, answers: unknown[] }) {
    this.questionReplies.push(input)
  }

  async respondToPermission(input: { permissionId: string, allowed: boolean }) {
    this.permissionResponses.push(input)
  }

  subscribeEvents(listener: CloudRuntimeEventListener) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    }
  }

  async emitAssistant(sessionId: string, content: string) {
    for (const listener of this.listeners) {
      await listener({
        type: 'assistant.message',
        payload: {
          sessionId,
          messageId: `${sessionId}:external`,
          content,
        },
      })
    }
  }

  close() {
    this.closed = true
  }
}

async function readJson(response: Response) {
  return JSON.parse(await response.text()) as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(Boolean(value && typeof value === 'object' && !Array.isArray(value)), true)
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true)
  return value as unknown[]
}

async function writeFixture(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}

test('cloud bootstrap parses env options and role helpers', () => {
  assert.deepEqual(resolveCloudBootstrapOptionsFromEnv({
    OPEN_COWORK_CLOUD_ROOT: '/tmp/open-cowork-cloud',
    OPEN_COWORK_CLOUD_HOST: '127.0.0.1',
    OPEN_COWORK_CLOUD_PORT: '9999',
    OPEN_COWORK_CLOUD_WORKER_POLL_MS: '25',
    OPEN_COWORK_CLOUD_SCHEDULER_POLL_MS: '40',
    OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS: 'false',
    OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED: 'true',
    OPEN_COWORK_CLOUD_COOKIE_SECURE: 'false',
    OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
  }), {
    root: '/tmp/open-cowork-cloud',
    hostname: '127.0.0.1',
    port: 9999,
    workerPollMs: 25,
    schedulerPollMs: 40,
    corsOrigin: null,
    autoProcessCommands: false,
    checkpointsEnabled: true,
    cookieSecure: false,
    publicUrl: 'https://cloud.example.test',
  })

  assert.equal(shouldRunCloudWeb('all-in-one'), true)
  assert.equal(shouldRunCloudWeb('worker'), false)
  assert.equal(shouldRunCloudWorker('all-in-one'), true)
  assert.equal(shouldRunCloudWorker('web'), false)
  assert.equal(shouldRunCloudScheduler('all-in-one'), true)
  assert.equal(shouldRunCloudScheduler('scheduler'), true)
  assert.equal(shouldRunCloudScheduler('web'), false)
  assert.equal(shouldRunCloudScheduler('worker'), false)
})

test('cloud control plane URL resolves from env and config refs', () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      storage: {
        ...DEFAULT_CONFIG.cloud.storage,
        controlPlane: {
          kind: 'postgres' as const,
          urlRef: 'OPEN_COWORK_DATABASE_URL',
        },
      },
    },
  }

  assert.equal(resolveCloudControlPlaneUrl(config, {
    OPEN_COWORK_DATABASE_URL: 'postgres://from-ref',
  }), 'postgres://from-ref')
  assert.equal(resolveCloudControlPlaneUrl(config, {
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://from-env',
    OPEN_COWORK_DATABASE_URL: 'postgres://from-ref',
  }), 'postgres://from-env')
})

test('cloud OIDC client secret resolves from explicit env before config refs', () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      auth: {
        ...DEFAULT_CONFIG.cloud.auth,
        mode: 'oidc' as const,
        clientSecretRef: 'OIDC_SECRET_REF',
      },
    },
  }

  assert.equal(resolveCloudOidcClientSecret(config, {
    OIDC_SECRET_REF: 'from-ref',
  }), 'from-ref')
  assert.equal(resolveCloudOidcClientSecret(config, {
    OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET: 'from-env',
    OIDC_SECRET_REF: 'from-ref',
  }), 'from-env')
})

test('cloud control plane local adapter remains default without a postgres URL', async () => {
  const store = await createControlPlaneStoreForCloud({
    config: DEFAULT_CONFIG,
    env: {},
  })
  try {
    assert.equal(store instanceof InMemoryControlPlaneStore, true)
  } finally {
    await store.close?.()
  }
})

test('cloud postgres control plane fails closed without a connection URL', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      storage: {
        ...DEFAULT_CONFIG.cloud.storage,
        controlPlane: {
          kind: 'postgres' as const,
        },
      },
    },
  }

  await assert.rejects(() => createControlPlaneStoreForCloud({
    config,
    env: {},
  }), /no connection URL/)
})

test('cloud app lets deployers inject a durable control-plane store factory', async () => {
  const runtime = new FakeRuntime()
  const store = new InMemoryControlPlaneStore()
  let factoryCalls = 0
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    storeFactory(input) {
      factoryCalls += 1
      assert.equal(input.env.OPEN_COWORK_CLOUD_CONTROL_PLANE_URL, 'postgres://db.example.test/open_cowork')
      return store
    },
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://db.example.test/open_cowork',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.equal(factoryCalls, 1)
    assert.equal(app.store, store)
  } finally {
    await app.close()
  }
})

test('cloud all-in-one app starts web and worker and routes runtime events into projections', async () => {
  const runtime = new FakeRuntime()
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.ok(app.url)
    assert.ok(app.worker)
    assert.ok(app.server)

    const created = await readJson(await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(asRecord(created.session).tenantId, 'tenant-a')

    const prompted = await readJson(await fetch(`${app.url}/api/sessions/session-1/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({ text: 'hello', agent: 'build' }),
    }))
    assert.equal(prompted.processed, 1)
    assert.equal(runtime.prompts.length, 1)

    await runtime.emitAssistant('session-1', 'external event')
    const view = await readJson(await fetch(`${app.url}/api/sessions/session-1`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
    }))
    const messages = asArray(asRecord(asRecord(view.projection).view).messages)
    assert.equal(asRecord(messages.at(-1)).content, 'external event')
  } finally {
    await app.close()
  }

  assert.equal(runtime.closed, true)
})

test('cloud web role starts transport without processing worker commands inline', async () => {
  const runtime = new FakeRuntime()
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.ok(app.url)
    assert.equal(app.worker, null)

    const created = await readJson(await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    assert.equal(asRecord(created.session).opencodeSessionId, '')

    const prompted = await readJson(await fetch(`${app.url}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'queued only' }),
    }))
    assert.equal(prompted.processed, 0)
    assert.equal(runtime.prompts.length, 0)
  } finally {
    await app.close()
  }
})

test('cloud web and worker roles hand off session runtime creation through the control plane', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({}),
    }))
    const coworkSessionId = String(asRecord(created.session).sessionId)
    assert.equal(asRecord(created.session).opencodeSessionId, '')

    const prompted = await readJson(await fetch(`${web.url}/api/sessions/${coworkSessionId}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({ text: 'from stateless web', agent: 'build' }),
    }))
    assert.equal(prompted.processed, 0)
    assert.equal(runtime.prompts.length, 0)

    assert.equal(await worker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts.length, 1)
    assert.equal(runtime.prompts[0]?.sessionId, 'session-1')
    assert.notEqual(runtime.prompts[0]?.sessionId, coworkSessionId)

    const stored = store.getSession('tenant-a', 'user-a', coworkSessionId)
    assert.equal(stored?.opencodeSessionId, 'session-1')

    const view = await readJson(await fetch(`${web.url}/api/sessions/${coworkSessionId}`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
    }))
    const messages = asArray(asRecord(asRecord(view.projection).view).messages)
    assert.equal(asRecord(messages.at(-1)).content, 'runtime answer')

    await runtime.emitAssistant('session-1', 'subscription event')
    const streamed = await readJson(await fetch(`${web.url}/api/sessions/${coworkSessionId}`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
    }))
    const streamedMessages = asArray(asRecord(asRecord(streamed.projection).view).messages)
    assert.equal(asRecord(streamedMessages.at(-1)).content, 'subscription event')
  } finally {
    await worker.close()
    await web.close()
  }
})

test('cloud worker reclaims stale running commands after worker lease expiry', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const replacementWorker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-b',
    },
    workerPollMs: 60_000,
  })

  try {
    const headers = {
      'content-type': 'application/json',
      'x-open-cowork-tenant-id': 'tenant-a',
      'x-open-cowork-user-id': 'user-a',
      'x-open-cowork-user-email': 'a@example.test',
    }
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const prompted = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'recover this command', agent: 'build' }),
    }))
    const commandId = String(asRecord(prompted.command).commandId)

    const staleLease = store.claimSessionLease(
      'tenant-a',
      sessionId,
      'worker-a-crashed',
      new Date('2026-01-01T00:00:00.000Z'),
      1,
    )
    assert.ok(staleLease)
    assert.equal(store.claimNextSessionCommand(staleLease)?.commandId, commandId)

    assert.equal(await replacementWorker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts.length, 1)
    assert.equal(runtime.prompts[0]?.parts[0]?.text, 'recover this command')
    assert.throws(() => store.ackSessionCommand(staleLease, commandId), /stale/)
  } finally {
    await replacementWorker.close()
    await web.close()
  }
})

test('cloud worker applies durable question replies and permission responses to OpenCode', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    const headers = {
      'content-type': 'application/json',
      'x-open-cowork-tenant-id': 'tenant-a',
      'x-open-cowork-user-id': 'user-a',
      'x-open-cowork-user-email': 'a@example.test',
    }
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const question = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/question-reply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'question-1', answers: [{ value: 'yes' }] }),
    }))
    const permission = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/permission-respond`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ permissionId: 'permission-1', response: { allowed: true } }),
    }))

    assert.equal(question.processed, 0)
    assert.equal(permission.processed, 0)
    assert.equal(await worker.worker?.processAllSessionCommands(), 2)
    assert.deepEqual(runtime.questionReplies, [{ requestId: 'question-1', answers: [{ value: 'yes' }] }])
    assert.deepEqual(runtime.permissionResponses, [{ permissionId: 'permission-1', allowed: true }])

    const events = await store.listSessionEvents('tenant-a', sessionId)
    assert.equal(events.some((event) => event.type === 'question.resolved'), true)
    assert.equal(events.some((event) => event.type === 'permission.resolved'), true)
  } finally {
    await worker.close()
    await web.close()
  }
})

test('cloud worker can checkpoint workspace state to object storage after commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-cloud-checkpoint-app-'))
  const store = new InMemoryControlPlaneStore()
  const objectStore = createInMemoryObjectStore()
  const runtime = new FakeRuntime()
  const workerPaths = createCloudPathProvider(join(root, 'worker'))
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    objectStore,
    paths: createCloudPathProvider(join(root, 'web')),
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    objectStore,
    runtime,
    paths: workerPaths,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
      OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED: 'true',
      OPEN_COWORK_CLOUD_SECRET_KEY: 'local-test-secret',
    },
    workerPollMs: 60_000,
  })

  try {
    assert.ok(worker.checkpointStore)
    const principalHeaders = {
      'x-open-cowork-tenant-id': 'tenant-a',
      'x-open-cowork-user-id': 'user-a',
      'x-open-cowork-user-email': 'a@example.test',
    }
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({}),
    }))
    const coworkSessionId = String(asRecord(created.session).sessionId)
    await writeFixture(workerPaths.resolveWorkspacePath('tenant-a', coworkSessionId, 'README.md'), 'checkpoint me')

    const prompted = await readJson(await fetch(`${web.url}/api/sessions/${coworkSessionId}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({ text: 'from stateless web', agent: 'build' }),
    }))
    assert.equal(prompted.processed, 0)
    assert.equal(await worker.worker?.processAllSessionCommands(), 1)

    const manifest = await worker.checkpointStore.readSessionCheckpoint({
      tenantId: 'tenant-a',
      sessionId: coworkSessionId,
    })
    assert.ok(manifest)
    assert.equal(manifest.checkpointVersion, 1)
    assert.equal(manifest.entries.some((entry) => entry.rootId === 'workspace' && entry.relativePath === 'README.md'), true)
    assert.equal((await objectStore.headObject(sessionCheckpointLatestKey({
      tenantId: 'tenant-a',
      sessionId: coworkSessionId,
    })))?.metadata.latest, 'true')
  } finally {
    await worker.close()
    await web.close()
  }
})

test('cloud web and worker roles hand off workflow run execution through the control plane', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    const principalHeaders = {
      'x-open-cowork-tenant-id': 'tenant-a',
      'x-open-cowork-user-id': 'user-a',
      'x-open-cowork-user-email': 'a@example.test',
    }
    const created = await readJson(await fetch(`${web.url}/api/workflows`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({
        title: 'Split workflow',
        instructions: 'Run from a web replica.',
        agentName: 'build',
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      }),
    }))
    const workflowId = String(asRecord(created.workflow).id)

    const started = await readJson(await fetch(`${web.url}/api/workflows/${workflowId}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({}),
    }))
    assert.equal(started.processed, 0)
    const runId = String(asRecord(started.run).id)
    const coworkSessionId = String(started.sessionId)
    assert.equal(runtime.prompts.length, 0)

    assert.equal(await worker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts[0]?.sessionId, 'session-1')
    assert.notEqual(runtime.prompts[0]?.sessionId, coworkSessionId)

    const workflow = asRecord((await readJson(await fetch(`${web.url}/api/workflows/${workflowId}`, {
      headers: principalHeaders,
    }))).workflow)
    const run = asRecord(asArray(workflow.runs).find((entry) => asRecord(entry).id === runId))
    assert.equal(run.status, 'completed')
    assert.equal(run.summary, 'runtime answer')
    assert.equal(workflow.latestRunStatus, 'completed')
  } finally {
    await worker.close()
    await web.close()
  }
})

test('cloud scheduler role claims due workflows for workers without owning runtime', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  store.createTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  store.ensureUser({ tenantId: 'tenant-a', userId: 'user-a', email: 'a@example.test' })
  store.createWorkflow({
    tenantId: 'tenant-a',
    userId: 'user-a',
    workflowId: 'workflow-scheduled',
    nextRunAt: '2026-01-01T09:00:00.000Z',
    draft: {
      title: 'Scheduled workflow',
      instructions: 'Run from the scheduler.',
      agentName: 'build',
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
  })

  const scheduler = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'scheduler',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_SCHEDULER_ID: 'scheduler-a',
    },
    schedulerPollMs: 60_000,
  })
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    assert.equal(scheduler.server, null)
    assert.equal(scheduler.worker, null)
    assert.notEqual(scheduler.scheduler, null)
    assert.equal(worker.scheduler, null)

    const claimed = await scheduler.scheduler?.processDueWorkflows(new Date('2026-01-01T09:00:00.000Z'))
    assert.equal(claimed, 1)
    assert.equal(runtime.prompts.length, 0)

    const claimedWorkflow = await store.getWorkflowForTenant('tenant-a', 'workflow-scheduled')
    const coworkSessionId = claimedWorkflow?.latestRunSessionId
    assert.equal(claimedWorkflow?.status, 'running')
    assert.equal(claimedWorkflow?.latestRunStatus, 'running')
    assert.equal(typeof coworkSessionId, 'string')

    const session = await store.getSession('tenant-a', 'user-a', String(coworkSessionId))
    assert.equal(session?.opencodeSessionId, '')

    const schedulerHeartbeat = (await store.listWorkerHeartbeats())
      .find((heartbeat) => heartbeat.workerId === 'scheduler-a')
    assert.equal(schedulerHeartbeat?.role, 'scheduler')
    assert.deepEqual(schedulerHeartbeat?.activeSessionIds, [coworkSessionId])

    assert.equal(await worker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts[0]?.sessionId, 'session-1')
    assert.notEqual(runtime.prompts[0]?.sessionId, coworkSessionId)

    const completed = await store.getWorkflowForTenant('tenant-a', 'workflow-scheduled')
    assert.equal(completed?.status, 'active')
    assert.equal(completed?.latestRunStatus, 'completed')
    assert.equal(completed?.latestRunSummary, 'runtime answer')
    assert.equal((await store.getSession('tenant-a', 'user-a', String(coworkSessionId)))?.opencodeSessionId, 'session-1')
  } finally {
    await worker.close()
    await scheduler.close()
  }
})

test('cloud app wires OIDC auth mode instead of header demo auth', async () => {
  const runtime = new FakeRuntime()
  const app = await startCloudApp({
    config: {
      ...DEFAULT_CONFIG,
      cloud: {
        ...DEFAULT_CONFIG.cloud,
        auth: {
          mode: 'oidc',
          issuerUrl: 'https://auth.example.test',
          clientId: 'open-cowork-cloud',
        },
      },
    },
    runtime,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    const health = await readJson(await fetch(`${app.url}/healthz`))
    assert.equal(health.ok, true)

    const response = await fetch(`${app.url}/api/config`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-from-header',
        'x-open-cowork-user-id': 'user-from-header',
        'x-open-cowork-user-email': 'header@example.test',
      },
    })
    assert.equal(response.status, 401)
    assert.match(await response.text(), /bearer authorization/i)
  } finally {
    await app.close()
  }
})

test('cloud app wires OIDC browser login when session cookies are configured', async () => {
  const originalFetch = globalThis.fetch
  const issuer = 'https://auth.example.test'
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer,
        jwks_uri: `${issuer}/jwks.json`,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  let app: Awaited<ReturnType<typeof startCloudApp>> | null = null
  try {
    app = await startCloudApp({
      config: {
        ...DEFAULT_CONFIG,
        cloud: {
          ...DEFAULT_CONFIG.cloud,
          auth: {
            mode: 'oidc',
            issuerUrl: issuer,
            clientId: 'open-cowork-cloud',
          },
        },
      },
      env: {
        OPEN_COWORK_CLOUD_ROLE: 'web',
        OPEN_COWORK_CLOUD_COOKIE_SECRET: TEST_COOKIE_KEY,
        OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
      },
      hostname: '127.0.0.1',
      port: 0,
    })
    const response = await originalFetch(`${app.url}/auth/login?returnTo=/cloud`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    const location = new URL(response.headers.get('location') || '')
    assert.equal(location.origin, issuer)
    assert.equal(location.pathname, '/authorize')
    assert.equal(location.searchParams.get('redirect_uri'), 'https://cloud.example.test/auth/callback')
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
    assert.match(response.headers.get('set-cookie') || '', /open_cowork_cloud_oidc=/)
  } finally {
    await app?.close()
    globalThis.fetch = originalFetch
  }
})

test('cloud header auth resolver maps request headers to tenant principal', async () => {
  const auth = createHeaderCloudAuthResolver()
  const principal = await auth({
    headers: {
      'x-open-cowork-tenant-id': 'tenant-1',
      'x-open-cowork-tenant-name': 'Tenant 1',
      'x-open-cowork-user-id': 'user-1',
      'x-open-cowork-user-email': 'user@example.test',
    },
  } as unknown as IncomingMessage)

  assert.deepEqual(principal, {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'user-1',
    email: 'user@example.test',
  })
})
