import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { startCloudApp } from '@open-cowork/cloud-server/app'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createInMemoryObjectStore } from '@open-cowork/cloud-server/object-store'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'
import { sessionCheckpointLatestKey } from '@open-cowork/cloud-server/workspace-checkpoint-store'
import { AdmittedPromptRuntime, FakeRuntime } from './helpers/cloud-app-runtime.ts'
import {
  asArray,
  asRecord,
  cloudConfigWithRemoteApprovalResponses,
  readJson,
} from './helpers/cloud-app-test-support.ts'

test('cloud web and worker roles hand off session runtime creation through the control plane', async () => {
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
  const worker = await startCloudApp({
    config: DEFAULT_CONFIG,
    store,
    runtime,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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

test('cloud worker applies durable question replies and permission responses to OpenCode', async () => {
  const store = new InMemoryControlPlaneStore()
  const runtime = new FakeRuntime()
  const config = cloudConfigWithRemoteApprovalResponses()
  const web = await startCloudApp({
    config,
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
    config,
    store,
    runtime,
    env: {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
    const questionReject = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/question-reject`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'question-2' }),
    }))
    const permission = await readJson(await fetch(`${web.url}/api/sessions/${sessionId}/permission-respond`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ permissionId: 'permission-1', response: { allowed: true } }),
    }))

    assert.equal(question.processed, 0)
    assert.equal(questionReject.processed, 0)
    assert.equal(permission.processed, 0)
    assert.equal(await worker.worker?.processAllSessionCommands(), 3)
    assert.deepEqual(runtime.questionReplies, [{ requestId: 'question-1', answers: [{ value: 'yes' }] }])
    assert.deepEqual(runtime.questionRejects, [{ requestId: 'question-2' }])
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
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
        OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
    const snapshot = await readJson(await fetch(`${web.url}/api/project-sources/snapshots`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({
        title: 'fixture',
        files: [{
          path: 'README.md',
          dataBase64: Buffer.from('checkpoint me').toString('base64'),
          byteCount: 'checkpoint me'.length,
        }],
        fileCount: 1,
        byteCount: 'checkpoint me'.length,
      }),
    }))
    const created = await readJson(await fetch(`${web.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({ projectSource: snapshot.projectSource }),
    }))
    const coworkSessionId = String(asRecord(created.session).sessionId)

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
    assert.equal(
      await readFile(workerPaths.resolveWorkspacePath('tenant-a', coworkSessionId, 'README.md'), 'utf8'),
      'checkpoint me',
    )

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
  const runtime = new AdmittedPromptRuntime()
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

    const admittedWorkflow = asRecord((await readJson(await fetch(`${web.url}/api/workflows/${workflowId}`, {
      headers: principalHeaders,
    }))).workflow)
    const admittedRun = asRecord(asArray(admittedWorkflow.runs).find((entry) => asRecord(entry).id === runId))
    assert.equal(admittedRun.status, 'running')

    await runtime.emitAssistant('session-1', 'runtime answer')
    await runtime.emitIdle('session-1')

    const workflow = asRecord((await readJson(await fetch(`${web.url}/api/workflows/${workflowId}`, {
      headers: principalHeaders,
    }))).workflow)
    const run = asRecord(asArray(workflow.runs).find((entry) => asRecord(entry).id === runId))
    assert.equal(run.status, 'completed')
    assert.equal(run.summary, 'runtime answer')
    assert.equal(workflow.latestRunStatus, 'completed')

    const restarted = await readJson(await fetch(`${web.url}/api/workflows/${workflowId}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...principalHeaders,
      },
      body: JSON.stringify({}),
    }))
    const failedRunId = String(asRecord(restarted.run).id)
    assert.equal(await worker.worker?.processAllSessionCommands(), 1)
    assert.equal(runtime.prompts[1]?.sessionId, 'session-2')

    const secondAdmittedWorkflow = asRecord((await readJson(await fetch(`${web.url}/api/workflows/${workflowId}`, {
      headers: principalHeaders,
    }))).workflow)
    const secondAdmittedRun = asRecord(
      asArray(secondAdmittedWorkflow.runs).find((entry) => asRecord(entry).id === failedRunId),
    )
    assert.equal(secondAdmittedRun.status, 'running')

    await runtime.emitRuntimeError('session-2', 'delayed runtime failure')

    const failedWorkflow = asRecord((await readJson(await fetch(`${web.url}/api/workflows/${workflowId}`, {
      headers: principalHeaders,
    }))).workflow)
    const failedRun = asRecord(asArray(failedWorkflow.runs).find((entry) => asRecord(entry).id === failedRunId))
    assert.equal(failedRun.status, 'failed')
    assert.equal(failedRun.error, 'delayed runtime failure')
    assert.equal(failedWorkflow.latestRunStatus, 'failed')
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
    nextRunAt: '2030-01-01T09:00:00.000Z',
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
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
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
        OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
        OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_WORKER_ID: 'worker-a',
    },
    workerPollMs: 60_000,
  })

  try {
    assert.equal(scheduler.server, null)
    assert.equal(scheduler.worker, null)
    assert.notEqual(scheduler.scheduler, null)
    assert.equal(worker.scheduler, null)

    const claimed = await scheduler.scheduler?.processDueWorkflows(new Date('2030-01-01T09:00:00.000Z'))
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
