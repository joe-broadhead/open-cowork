import { signWorkflowWebhookPayload, type WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
  testAbuseConfig,
} from './helpers/cloud-http-test-support.ts'

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
    assert.match(String(run.sessionId), /^workflow_session_/)
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
test('cloud HTTP workflow listing pages workflows and batch-loads recent runs', async () => {
  const fixture = createFixture()
  fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  fixture.store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.test', role: 'owner' })
  for (let index = 0; index < 120; index += 1) {
    const workflowId = `workflow-page-${String(index).padStart(3, '0')}`
    fixture.store.createWorkflow({
      tenantId: 'tenant-1',
      userId: 'user-1',
      workflowId,
      draft: {
        title: `Workflow ${index}`,
        instructions: `Run workflow ${index}.`,
        agentName: 'data-analyst',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
      },
      createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index)),
    })
    const runId = `${workflowId}-run`
    fixture.store.createWorkflowRun({
      tenantId: 'tenant-1',
      userId: 'user-1',
      workflowId,
      runId,
      triggerType: 'manual',
      createdAt: new Date(Date.UTC(2030, 0, 1, 1, 0, index)),
    })
    fixture.store.completeWorkflowRun({
      tenantId: 'tenant-1',
      workflowId,
      runId,
      summary: `done ${index}`,
      nextStatus: 'active',
      nextRunAt: null,
      finishedAt: new Date(Date.UTC(2030, 0, 1, 1, 1, index)),
    })
  }
  let legacyRunListCalls = 0
  const originalListWorkflowRuns = fixture.store.listWorkflowRuns.bind(fixture.store)
  fixture.store.listWorkflowRuns = ((...args: Parameters<typeof fixture.store.listWorkflowRuns>) => {
    legacyRunListCalls += 1
    return originalListWorkflowRuns(...args)
  }) as typeof fixture.store.listWorkflowRuns

  const baseUrl = await fixture.server.listen()
  try {
    const first = await readJson(await fetch(`${baseUrl}/api/workflows?limit=50`))
    assert.equal(asArray(first.workflows).length, 50)
    assert.equal(asArray(first.runs).length, 50)
    assert.equal(first.totalEstimate, 51)
    assert.equal(typeof first.nextCursor, 'string')
    assert.equal(legacyRunListCalls, 0)

    const second = await readJson(await fetch(`${baseUrl}/api/workflows?limit=50&cursor=${encodeURIComponent(String(first.nextCursor))}`))
    assert.equal(asArray(second.workflows).length, 50)
    assert.equal(asArray(second.runs).length, 50)
    assert.notEqual(
      asRecord(asArray(first.workflows)[0]).id,
      asRecord(asArray(second.workflows)[0]).id,
    )
    assert.equal(legacyRunListCalls, 0)

    const invalid = await fetch(`${baseUrl}/api/workflows?cursor=not-a-workflow-cursor`)
    assert.equal(invalid.status, 400)
    assert.equal(asRecord(asRecord(await readJson(invalid)).verdict).policyCode, 'workflows.cursor.invalid')
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
      publicUrl: 'https://cowork.example.test',
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
    const createBody = await readJson(createResponse)
    const workflowId = String(asRecord(createBody.workflow).id)
    const expectedWebhookUrl = `https://cowork.example.test/webhooks/workflows/${encodeURIComponent(workflowId)}`
    assert.equal(asRecord(createBody.workflow).webhookUrl, expectedWebhookUrl)
    const webhookSecret = String(asRecord(createBody.webhookSecretReveal).secret)
    assert.notEqual(webhookSecret, 'cloud-webhook-secret')
    const publicWorkflowJson = JSON.stringify(createBody.workflow)
    assert.equal(publicWorkflowJson.includes(webhookSecret), false)
    assert.equal(publicWorkflowJson.includes('cloud-webhook-secret'), false)
    assert.equal(publicWorkflowJson.includes('webhookSecret'), false)
    const storedWorkflow = await fixture.store.findWorkflow(workflowId)
    const storedSecret = await fixture.store.getWorkflowWebhookSecret(storedWorkflow?.tenantId || '', workflowId)
    assert.equal(JSON.stringify(storedWorkflow).includes('webhookSecret'), false)
    assert.match(storedSecret?.ciphertext || '', /^enc:v1:/)
    assert.equal(storedSecret?.ciphertext.includes(webhookSecret), false)
    const ordinaryDetail = await readJson(await fetch(`${baseUrl}/api/workflows/${workflowId}`))
    const ordinaryList = await readJson(await fetch(`${baseUrl}/api/workflows`))
    assert.equal(asRecord(ordinaryDetail.workflow).webhookUrl, expectedWebhookUrl)
    assert.equal(asRecord(asArray(ordinaryList.workflows)[0]).webhookUrl, expectedWebhookUrl)
    for (const ordinaryPayload of [ordinaryDetail, ordinaryList]) {
      const serialized = JSON.stringify(ordinaryPayload)
      assert.equal(serialized.includes(webhookSecret), false)
      assert.equal(serialized.includes('cloud-webhook-secret'), false)
      assert.equal(serialized.includes('webhookSecret'), false)
    }
    const rawBody = JSON.stringify({ source: 'test-webhook' })
    const timestamp = new Date().toISOString()
    const signature = signWorkflowWebhookPayload(webhookSecret, rawBody, timestamp)

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
    const workflowEvents = await fixture.store.listWorkspaceEvents('tenant-1', 'user-1')
    const serializedEvents = JSON.stringify(workflowEvents)
    assert.equal(serializedEvents.includes(webhookSecret), false)
    assert.equal(serializedEvents.includes('cloud-webhook-secret'), false)
    assert.equal(serializedEvents.includes('webhookSecret'), false)
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

test('cloud workflow secret rotation reveals once, atomically invalidates the old secret, and archive revokes execution', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      publicUrl: 'https://cowork.example.test',
      features: {
        ...basePolicy.features,
        webhooks: true,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Rotated webhook',
        instructions: 'Run from the rotated webhook.',
        agentName: 'data-analyst',
        triggers: [{ id: 'webhook-rotate', type: 'webhook', enabled: true }],
      }),
    }))
    const workflowId = String(asRecord(created.workflow).id)
    const oldSecret = String(asRecord(created.webhookSecretReveal).secret)
    const rotated = await readJson(await fetch(`${baseUrl}/api/workflows/${workflowId}/rotate-webhook-secret`, {
      method: 'POST',
    }))
    const newSecret = String(asRecord(rotated.webhookSecretReveal).secret)
    assert.equal(
      asRecord(rotated.workflow).webhookUrl,
      `https://cowork.example.test/webhooks/workflows/${encodeURIComponent(workflowId)}`,
    )
    assert.notEqual(newSecret, oldSecret)
    assert.equal(JSON.stringify(rotated.workflow).includes(oldSecret), false)
    assert.equal(JSON.stringify(rotated.workflow).includes(newSecret), false)

    const rawBody = JSON.stringify({ source: 'rotation-test' })
    const oldTimestamp = new Date().toISOString()
    const oldResponse = await fetch(`${baseUrl}/webhooks/workflows/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-timestamp': oldTimestamp,
        'x-open-cowork-signature': signWorkflowWebhookPayload(oldSecret, rawBody, oldTimestamp),
      },
      body: rawBody,
    })
    assert.equal(oldResponse.status, 401)

    const newTimestamp = new Date(Date.now() + 1).toISOString()
    const accepted = await fetch(`${baseUrl}/webhooks/workflows/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-timestamp': newTimestamp,
        'x-open-cowork-signature': signWorkflowWebhookPayload(newSecret, rawBody, newTimestamp),
      },
      body: rawBody,
    })
    assert.equal(accepted.status, 202)

    const archived = await fetch(`${baseUrl}/api/workflows/${workflowId}/archive`, { method: 'POST' })
    assert.equal(archived.status, 200)
    const revokedRecord = await fixture.store.getWorkflowWebhookSecret(
      'tenant-1',
      workflowId,
    )
    assert.equal(revokedRecord?.status, 'revoked')
    const archivedTimestamp = new Date(Date.now() + 2).toISOString()
    const revoked = await fetch(`${baseUrl}/webhooks/workflows/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-timestamp': archivedTimestamp,
        'x-open-cowork-signature': signWorkflowWebhookPayload(newSecret, rawBody, archivedTimestamp),
      },
      body: rawBody,
    })
    assert.equal(revoked.status, 401)

    const resumeWithoutRotation = await fetch(`${baseUrl}/api/workflows/${workflowId}/resume`, { method: 'POST' })
    assert.equal(resumeWithoutRotation.status, 409)
    const replacement = await readJson(await fetch(`${baseUrl}/api/workflows/${workflowId}/rotate-webhook-secret`, {
      method: 'POST',
    }))
    const replacementSecret = String(asRecord(replacement.webhookSecretReveal).secret)
    assert.equal(
      asRecord(replacement.workflow).webhookUrl,
      `https://cowork.example.test/webhooks/workflows/${encodeURIComponent(workflowId)}`,
    )
    assert.notEqual(replacementSecret, newSecret)
    assert.equal(
      (await fixture.store.getWorkflowWebhookSecret('tenant-1', workflowId))?.status,
      'active',
    )
    const resumed = await fetch(`${baseUrl}/api/workflows/${workflowId}/resume`, { method: 'POST' })
    assert.equal(resumed.status, 200)
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
    const createBody = await readJson(createResponse)
    const workflowId = String(asRecord(createBody.workflow).id)
    const webhookSecret = String(asRecord(createBody.webhookSecretReveal).secret)
    const rawBody = JSON.stringify({ source: 'trusted-proxy-test' })
    const timestamp = new Date().toISOString()
    const signature = signWorkflowWebhookPayload(webhookSecret, rawBody, timestamp)

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
    const createBody = await readJson(createResponse)
    const workflowId = String(asRecord(createBody.workflow).id)
    const webhookSecret = String(asRecord(createBody.webhookSecretReveal).secret)
    const rawBody = JSON.stringify({ source: 'test-webhook' })
    const timestamp = new Date().toISOString()
    const signature = signWorkflowWebhookPayload(webhookSecret, rawBody, timestamp)

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
    sessionId: 'workflow-stranded-session',
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

  const started = await fixture.service.domains.workflows.claimAndStartDueWorkflow(
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

  const detail = await fixture.service.domains.workflows.getWorkflow({
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

  const second = await fixture.service.domains.workflows.claimAndStartDueWorkflow(
    new Date('2030-01-01T09:00:00.004Z'),
    'scheduler-recovery',
  )
  assert.equal(second, null)
})

test('cloud workflow recovery reuses planned sessions across pre-attach crash windows', async () => {
  const fixture = createFixture({ autoProcessCommands: false })
  fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  fixture.store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.test', role: 'owner' })

  const createWorkflow = (workflowId: string, title: string) => fixture.store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId,
    draft: {
      title,
      instructions: `Recover ${title}.`,
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })

  const noSessionWorkflow = createWorkflow('workflow-no-session-recovery', 'No session recovery')
  const noSessionRun = fixture.store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: noSessionWorkflow.id,
    runId: 'workflow-no-session-run',
    triggerType: 'manual',
    triggerPayload: { source: 'test' },
    claimedBy: 'workflow-api:user-1',
    leaseTtlMs: 30_000,
    createdAt: new Date('2030-01-01T10:00:00.000Z'),
  })
  assert.match(noSessionRun.sessionId || '', /^workflow_session_/)
  fixture.store.reapExpiredWorkflowClaims({ now: new Date('2030-01-01T10:00:31.000Z') })
  const recoveredNoSession = await fixture.service.domains.workflows.claimAndStartDueWorkflow(
    new Date('2030-01-01T10:00:32.000Z'),
    'scheduler-recovery',
  )
  assert.equal(recoveredNoSession?.run.id, noSessionRun.id)
  assert.equal(recoveredNoSession?.sessionId, noSessionRun.sessionId)
  assert.equal(recoveredNoSession?.command.commandId, `workflow:tenant-1:${noSessionWorkflow.id}:${noSessionRun.id}:prompt`)

  const preAttachWorkflow = createWorkflow('workflow-pre-attach-recovery', 'Pre attach recovery')
  const preAttachRun = fixture.store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: preAttachWorkflow.id,
    runId: 'workflow-pre-attach-run',
    triggerType: 'manual',
    triggerPayload: { source: 'test' },
    claimedBy: 'workflow-api:user-1',
    leaseTtlMs: 30_000,
    createdAt: new Date('2030-01-01T11:00:00.000Z'),
  })
  assert.ok(preAttachRun.sessionId)
  fixture.store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: preAttachRun.sessionId!,
    opencodeSessionId: '',
    profileName: 'full',
    title: 'Run Pre attach recovery',
    createdAt: new Date('2030-01-01T11:00:01.000Z'),
  })
  fixture.store.reapExpiredWorkflowClaims({ now: new Date('2030-01-01T11:00:31.000Z') })
  const recoveredPreAttach = await fixture.service.domains.workflows.claimAndStartDueWorkflow(
    new Date('2030-01-01T11:00:32.000Z'),
    'scheduler-recovery',
  )
  assert.equal(recoveredPreAttach?.run.id, preAttachRun.id)
  assert.equal(recoveredPreAttach?.sessionId, preAttachRun.sessionId)
  assert.equal((await fixture.store.getSessionForTenant('tenant-1', preAttachRun.sessionId!))?.createdAt, '2030-01-01T11:00:01.000Z')
  assert.equal(recoveredPreAttach?.command.commandId, `workflow:tenant-1:${preAttachWorkflow.id}:${preAttachRun.id}:prompt`)
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
