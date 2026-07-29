import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { startCloudApp } from '@open-cowork/cloud-server/app'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createInMemoryObjectStore } from '@open-cowork/cloud-server/object-store'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'
import {
  FakeRuntime,
  ShutdownAwareSlowPromptRuntime,
  SlowPromptRuntime,
} from './helpers/cloud-app-runtime.ts'
import { asRecord, readJson } from './helpers/cloud-app-test-support.ts'

test('cloud startup unwinds owned resources and preserves the original migration failure', async () => {
  const runtime = new FakeRuntime()
  let runtimeCloseCalls = 0
  runtime.close = () => {
    runtimeCloseCalls += 1
    throw new Error('synthetic runtime cleanup failure')
  }
  const store = new InMemoryControlPlaneStore()
  let storeCloseCalls = 0
  store.close = async () => {
    storeCloseCalls += 1
  }
  store.listLegacyWorkflowWebhookSecrets = async () => {
    throw new Error('synthetic migration startup failure')
  }
  let objectStoreCloseCalls = 0
  const objectStore = {
    ...createInMemoryObjectStore(),
    async close() {
      objectStoreCloseCalls += 1
    },
  }
  const root = await mkdtemp(
    join(tmpdir(), 'open-cowork-cloud-startup-unwind-'),
  )

  await assert.rejects(() => startCloudApp({
    runtime,
    store,
    objectStore,
    paths: createCloudPathProvider(root),
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
      OPEN_COWORK_CLOUD_WORKER_ID: 'startup-unwind-worker',
    },
  }), /synthetic migration startup failure/)
  assert.equal(runtimeCloseCalls, 1)
  assert.equal(objectStoreCloseCalls, 1)
  assert.equal(storeCloseCalls, 1)
})

test('cloud listen failure unwinds worker resources and permits retry on the same identity', async () => {
  const blocker = createServer()
  await new Promise<void>((resolveListen, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', resolveListen)
  })
  const blockerAddress = blocker.address()
  assert.ok(blockerAddress && typeof blockerAddress !== 'string')
  const port = blockerAddress.port
  const runtime = new FakeRuntime()
  const store = new InMemoryControlPlaneStore()
  let storeCloseCalls = 0
  store.close = async () => {
    storeCloseCalls += 1
  }
  const objectStore = createInMemoryObjectStore()
  let objectStoreCloseCalls = 0
  objectStore.close = async () => {
    objectStoreCloseCalls += 1
  }
  const env = {
    OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
    OPEN_COWORK_CLOUD_PROFILE: 'full',
    OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
    OPEN_COWORK_CLOUD_WORKER_ID: 'listen-retry-worker',
  }
  const failureRoot = await mkdtemp(
    join(tmpdir(), 'open-cowork-cloud-listen-failure-'),
  )

  try {
    await assert.rejects(() => startCloudApp({
      runtime,
      store,
      objectStore,
      paths: createCloudPathProvider(failureRoot),
      env,
      hostname: '127.0.0.1',
      port,
    }), (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'EADDRINUSE'
    ))
    assert.equal(runtime.closed, true)
    assert.equal(objectStoreCloseCalls, 1)
    assert.equal(storeCloseCalls, 1)
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      blocker.close((error) => error ? reject(error) : resolveClose())
    })
  }

  const retry = await startCloudApp({
    runtime: new FakeRuntime(),
    store: new InMemoryControlPlaneStore(),
    objectStore: createInMemoryObjectStore(),
    paths: createCloudPathProvider(await mkdtemp(
      join(tmpdir(), 'open-cowork-cloud-listen-retry-'),
    )),
    env,
    hostname: '127.0.0.1',
    port,
  })
  try {
    assert.match(retry.url || '', new RegExp(`:${port}$`))
  } finally {
    await retry.close()
  }
})

test('cloud worker liveness bind failure rejects startup and unwinds owned resources', async () => {
  const blocker = createServer()
  await new Promise<void>((resolveListen, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', resolveListen)
  })
  const blockerAddress = blocker.address()
  assert.ok(blockerAddress && typeof blockerAddress !== 'string')
  const runtime = new FakeRuntime()
  const store = new InMemoryControlPlaneStore()
  let storeCloseCalls = 0
  store.close = async () => {
    storeCloseCalls += 1
  }
  const objectStore = createInMemoryObjectStore()
  let objectStoreCloseCalls = 0
  objectStore.close = async () => {
    objectStoreCloseCalls += 1
  }
  const root = await mkdtemp(
    join(tmpdir(), 'open-cowork-cloud-liveness-bind-failure-'),
  )

  try {
    await assert.rejects(() => startCloudApp({
      runtime,
      store,
      objectStore,
      paths: createCloudPathProvider(root),
      env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
        OPEN_COWORK_CLOUD_WORKER_ID: 'liveness-bind-failure-worker',
        OPEN_COWORK_CLOUD_LIVENESS_PORT: String(blockerAddress.port),
      },
      hostname: '127.0.0.1',
      workerPollMs: 60_000,
    }), (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'EADDRINUSE'
    ))
    assert.equal(runtime.closed, true)
    assert.equal(objectStoreCloseCalls, 1)
    assert.equal(storeCloseCalls, 1)
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      blocker.close((error) => error ? reject(error) : resolveClose())
    })
  }
})

test('cloud shutdown continues durable cleanup after runtime teardown fails', async () => {
  const runtime = new FakeRuntime()
  runtime.close = () => {
    throw new Error('synthetic runtime cleanup failure')
  }
  const store = new InMemoryControlPlaneStore()
  let storeCloseCalls = 0
  store.close = async () => {
    storeCloseCalls += 1
  }
  let objectStoreCloseCalls = 0
  const objectStore = {
    ...createInMemoryObjectStore(),
    async close() {
      objectStoreCloseCalls += 1
    },
  }
  const root = await mkdtemp(
    join(tmpdir(), 'open-cowork-cloud-shutdown-settle-'),
  )
  const app = await startCloudApp({
    runtime,
    store,
    objectStore,
    paths: createCloudPathProvider(root),
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
      OPEN_COWORK_CLOUD_WORKER_ID: 'shutdown-settle-worker',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  const firstClose = app.close()
  const duplicateClose = app.close()
  assert.equal(firstClose, duplicateClose)
  await assert.rejects(firstClose, /Cloud app shutdown encountered/)
  assert.equal(objectStoreCloseCalls, 1)
  assert.equal(storeCloseCalls, 1)
})

test('cloud worker shutdown waits for an active command loop before closing runtime', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new SlowPromptRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-drain',
    },
    workerPollMs: 1,
    shutdownGraceMs: 1000,
  })
  let workerClosed = false

  try {
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-drain',
        'x-open-cowork-user-id': 'user-drain',
        'x-open-cowork-user-email': 'drain@example.test',
      },
      body: JSON.stringify({}),
    }))
    const coworkSessionId = String(asRecord(created.session).sessionId)

    await fetch(`${web.url}/api/sessions/${coworkSessionId}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-drain',
        'x-open-cowork-user-id': 'user-drain',
        'x-open-cowork-user-email': 'drain@example.test',
      },
      body: JSON.stringify({ text: 'close during active worker loop', agent: 'build' }),
    })

    await runtime.started
    let closeReturned = false
    const closePromise = worker.close().then(() => {
      closeReturned = true
      workerClosed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(closeReturned, false)
    assert.equal(runtime.closed, false)

    runtime.release()
    await closePromise
    assert.equal(runtime.closed, true)
    assert.equal(runtime.prompts.length, 1)
  } finally {
    runtime.release()
    if (!workerClosed) await worker.close()
    await web.close()
  }
})

test('cloud worker shutdown aborts and recovers active commands after drain grace', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new ShutdownAwareSlowPromptRuntime()
  const web = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-forced-shutdown',
    },
    workerPollMs: 1,
    shutdownGraceMs: 25,
  })
  let workerClosed = false

  try {
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-forced-shutdown',
        'x-open-cowork-user-id': 'user-forced-shutdown',
        'x-open-cowork-user-email': 'forced-shutdown@example.test',
      },
      body: JSON.stringify({}),
    }))
    const coworkSessionId = String(asRecord(created.session).sessionId)

    await fetch(`${web.url}/api/sessions/${coworkSessionId}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-forced-shutdown',
        'x-open-cowork-user-id': 'user-forced-shutdown',
        'x-open-cowork-user-email': 'forced-shutdown@example.test',
      },
      body: JSON.stringify({ text: 'force close during active worker loop', agent: 'build' }),
    })

    await runtime.started
    await worker.close()
    workerClosed = true

    assert.equal(runtime.observedAbort, true)
    assert.equal(runtime.abortCalls, 1)
    assert.equal(runtime.closed, true)
    const replacementLease = store.claimSessionLease(
      'tenant-forced-shutdown',
      coworkSessionId,
      'replacement-worker',
      new Date('2030-01-01T00:00:00.000Z'),
    )
    assert.ok(replacementLease)
    const recoveredCommand = store.claimNextSessionCommand(replacementLease, new Date('2030-01-01T00:00:00.000Z'))
    assert.equal(recoveredCommand?.kind, 'prompt')
    assert.equal(recoveredCommand?.attemptCount, 2)
  } finally {
    if (!workerClosed) await worker.close()
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
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
        OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
      new Date(),
      20,
    )
    assert.ok(staleLease)
    assert.equal(store.claimNextSessionCommand(staleLease)?.commandId, commandId)
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(await replacementWorker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts.length, 1)
    assert.equal(runtime.prompts[0]?.parts[0]?.text, 'recover this command')
    assert.throws(() => store.ackSessionCommand(staleLease, commandId), /stale/)
  } finally {
    await replacementWorker.close()
    await web.close()
  }
})
