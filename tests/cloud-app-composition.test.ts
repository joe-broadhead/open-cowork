import { clearKnowledgeStoreCache } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { startCloudApp } from '@open-cowork/cloud-server/app'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'
import { FakeRuntime } from './helpers/cloud-app-runtime.ts'
import { asArray, asRecord, readJson } from './helpers/cloud-app-test-support.ts'

test('cloud all-in-one app starts web and worker and routes runtime events into projections', async () => {
  const runtime = new FakeRuntime()
  const paths = createCloudPathProvider(await mkdtemp(join(tmpdir(), 'open-cowork-cloud-blank-')))
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    paths,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
        OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
    const coworkSessionId = String(asRecord(created.session).sessionId)
    assert.equal(asRecord(created.session).opencodeSessionId, '')

    const prompted = await readJson(await fetch(`${app.url}/api/sessions/${coworkSessionId}/prompt`, {
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
    assert.equal((await stat(paths.resolveWorkspacePath('tenant-a', coworkSessionId))).isDirectory(), true)

    await runtime.emitAssistant('session-1', 'external event')
    const view = await readJson(await fetch(`${app.url}/api/sessions/${coworkSessionId}`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
    }))
    const messages = asArray(asRecord(asRecord(view.projection).view).messages)
    assert.equal(asRecord(messages.at(-1)).content, 'external event')

    const appendProjectedSessionEvent = app.store.appendProjectedSessionEvent
    app.store.appendProjectedSessionEvent = () => {
      throw new Error('synthetic durable runtime event failure')
    }
    try {
      await assert.rejects(
        () => runtime.emit({
          type: 'runtime.error',
          payload: {
            sessionId: 'session-1',
            message: 'unpersisted event',
          },
        }),
        /synthetic durable runtime event failure/,
      )
    } finally {
      app.store.appendProjectedSessionEvent = appendProjectedSessionEvent
    }
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
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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

test('cloud app stores Knowledge data under the configured cloud app data root', async () => {
  const runtime = new FakeRuntime()
  const paths = createCloudPathProvider(await mkdtemp(join(tmpdir(), 'open-cowork-cloud-knowledge-')))
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    paths,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'web',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.ok(app.url)
    // JOE-832: elevated roles require signed header auth; knowledge list is
    // available to members over unsigned loopback header auth (no secret).
    const response = await fetch(`${app.url}/api/knowledge`, {
      headers: {
        'x-open-cowork-tenant-id': 'tenant-knowledge',
        'x-open-cowork-user-id': 'user-knowledge',
        'x-open-cowork-user-email': 'knowledge@example.test',
        'x-open-cowork-user-role': 'member',
      },
    })
    assert.equal(response.status, 200)
    const dbStat = await stat(join(paths.getAppDataDir(), 'knowledge.sqlite'))
    assert.equal(dbStat.isFile(), true)
  } finally {
    await app.close()
    clearKnowledgeStoreCache()
  }
})

test('cloud all-in-one app rejects malformed project source payloads', async () => {
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime: new FakeRuntime(),
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
        OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.ok(app.url)
    const response = await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-tenant-id': 'tenant-a',
        'x-open-cowork-user-id': 'user-a',
        'x-open-cowork-user-email': 'a@example.test',
      },
      body: JSON.stringify({ projectSource: { kind: 'git' } }),
    })
    assert.equal(response.status, 400)
    const body = await readJson(response)
    assert.match(String(body.error), /project source/i)
  } finally {
    await app.close()
  }
})
