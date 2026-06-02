import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { runtimeState } from '../apps/desktop/src/main/runtime-state.ts'
import { setRuntimeReady } from '../apps/desktop/src/main/runtime-status.ts'
import {
  clearWorkflowStoreCache,
  createWorkflow,
  createWorkflowRun,
  getWorkflow,
} from '../apps/desktop/src/main/workflow/workflow-store.ts'
import {
  configureWorkflowService,
  runWorkflowSchedulerTick,
  startWorkflowService,
  stopWorkflowService,
} from '../apps/desktop/src/main/workflow/workflow-service.ts'
import {
  configureWorkflowWebhookServer,
  ensureWorkflowWebhookServer,
  getWorkflowWebhookBaseUrl,
  isWorkflowWebhookLoopbackBindAddress,
  InMemoryWorkflowWebhookSecurityStore,
  resetWorkflowWebhookSecurityStateForTests,
  signWorkflowWebhookPayload,
  stopWorkflowWebhookServer,
  claimWorkflowWebhookSignatureOnce,
  verifyWorkflowWebhookAuth,
} from '../apps/desktop/src/main/workflow/workflow-webhook-server.ts'
import {
  ensureWorkflowToolBridge,
  getWorkflowToolBridgeEnvironment,
  stopWorkflowToolBridge,
} from '../apps/desktop/src/main/workflow/workflow-tool-bridge.ts'
import { configureWorkflowToolActions } from '../apps/desktop/src/main/workflow/workflow-tool-actions.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-workflow-runtime-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

async function withWorkflowRuntimeStore(name: string, run: (userDataDir: string) => Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearWorkflowStoreCache()
    await run(userDataDir)
  } finally {
    stopWorkflowService()
    stopWorkflowWebhookServer()
    stopWorkflowToolBridge()
    runtimeState.resetRuntimeSessionState()
    setRuntimeReady(false)
    clearWorkflowStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

async function waitForCondition(assertion: () => boolean, timeoutMs = 2_500) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(assertion(), true)
}

async function fetchWorkflowWebhookWithRetry(url: string, init: RequestInit) {
  try {
    return await fetch(url, init)
  } catch (error) {
    if (error instanceof TypeError) return fetch(url, init)
    throw error
  }
}

const manualWorkflowDraft = {
  title: 'Inbox summary',
  instructions: 'Scan the inbox and email a concise workload summary.',
  agentName: 'build',
  skillNames: ['email-triage'],
  toolIds: ['gmail'],
  projectDirectory: null,
  draftSessionId: 'ses_draft',
  triggers: [{ id: 'manual', type: 'manual' as const, enabled: true }],
}

const dueScheduledWorkflowDraft = {
  ...manualWorkflowDraft,
  title: 'Scheduled inbox summary',
  triggers: [{
    id: 'daily',
    type: 'schedule' as const,
    enabled: true,
    schedule: {
      type: 'daily' as const,
      timezone: 'UTC',
      runAtHour: 0,
      runAtMinute: 0,
    },
  }],
}

test('workflow service startup recovers interrupted runs before scheduling new work', async () => {
  await withWorkflowRuntimeStore('startup-recovery', async () => {
    const workflow = createWorkflow(manualWorkflowDraft)
    const interrupted = createWorkflowRun(workflow.id, 'manual', { source: 'test' })
    assert.equal(getWorkflow(workflow.id)?.status, 'running')

    clearWorkflowStoreCache()
    configureWorkflowService({ getMainWindow: () => null })
    startWorkflowService()
    await runWorkflowSchedulerTick()
    await ensureWorkflowWebhookServer()

    assert.equal(getWorkflow(workflow.id)?.status, 'active')
    assert.equal(getWorkflow(workflow.id)?.latestRunId, interrupted?.id)
    assert.equal(getWorkflow(workflow.id)?.latestRunStatus, 'failed')
    assert.equal(getWorkflow(workflow.id)?.latestRunSummary, 'Workflow run was interrupted before completion.')
  })
})

test('workflow scheduler coalesces overlapping ticks', async () => {
  await withWorkflowRuntimeStore('scheduler-overlap', async () => {
    configureWorkflowService({ getMainWindow: () => null })
    const workflow = createWorkflow(dueScheduledWorkflowDraft, null, { now: new Date('2026-05-14T12:00:00.000Z') })

    await Promise.all([
      runWorkflowSchedulerTick(new Date('2026-05-15T12:00:00.000Z')),
      runWorkflowSchedulerTick(new Date('2026-05-15T12:00:00.000Z')),
    ])

    const detail = getWorkflow(workflow.id)
    assert.equal(detail?.runs.length, 1)
    assert.equal(detail?.runs[0]?.triggerType, 'schedule')
  })
})

test('workflow run completion reconciles through session status when idle event is missed', async () => {
  await withWorkflowRuntimeStore('status-reconcile', async () => {
    const workflow = createWorkflow(dueScheduledWorkflowDraft, null, { now: new Date('2026-05-14T12:00:00.000Z') })
    const sessionId = 'ses_workflow_reconcile'
    const prompts: unknown[] = []
    let statusCalls = 0
    runtimeState.setClient({
      session: {
        create: async () => ({
          data: {
            id: sessionId,
            title: 'Workflow session',
            time: { created: 1_700_000_000, updated: 1_700_000_001 },
          },
        }),
        promptAsync: async (input: unknown) => {
          prompts.push(input)
          return { data: {} }
        },
        status: async () => {
          statusCalls += 1
          return { data: { [sessionId]: { type: 'idle' } } }
        },
        messages: async () => ({
          data: [{
            id: 'msg_done',
            role: 'assistant',
            time: { created: 1_700_000_002 },
            parts: [{ type: 'text', text: 'Workflow finished through status reconciliation.' }],
          }],
        }),
      },
    } as never)
    setRuntimeReady(true)
    configureWorkflowService({ getMainWindow: () => null })

    await runWorkflowSchedulerTick(new Date('2026-05-15T12:00:00.000Z'))

    assert.equal(prompts.length, 1)
    assert.equal(getWorkflow(workflow.id)?.latestRunStatus, 'running')

    await waitForCondition(() => getWorkflow(workflow.id)?.latestRunStatus === 'completed')

    const detail = getWorkflow(workflow.id)
    assert.equal(statusCalls, 1)
    assert.equal(detail?.latestRunStatus, 'completed')
    assert.equal(detail?.latestRunSummary, 'Workflow finished through status reconciliation.')
  })
})

test('workflow webhook server accepts only scoped JSON POST triggers', async () => {
  await withWorkflowRuntimeStore('webhook-server', async () => {
    const calls: Array<{ workflowId: string; payload: Record<string, unknown> }> = []
    configureWorkflowWebhookServer(async (input) => {
      if (input.auth.kind !== 'secret' || input.auth.secret !== 'sec/ret') throw new Error('Unexpected auth.')
      calls.push({ workflowId: input.workflowId, payload: input.payload })
    })
    const baseUrl = await ensureWorkflowWebhookServer()
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(getWorkflowWebhookBaseUrl(), baseUrl)

    const notFound = await fetch(`${baseUrl}/unknown`, { method: 'POST', body: '{}' })
    assert.equal(notFound.status, 404)

    const wrongMethod = await fetch(`${baseUrl}/workflows/wf`, { method: 'GET' })
    assert.equal(wrongMethod.status, 405)

    const badBody = await fetch(`${baseUrl}/workflows/wf`, {
      method: 'POST',
      headers: { authorization: 'Bearer sec/ret', 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(badBody.status, 400)

    const unauthorized = await fetch(`${baseUrl}/workflows/wf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(unauthorized.status, 401)

    const accepted = await fetch(`${baseUrl}/workflows/${encodeURIComponent('wf 1')}`, {
      method: 'POST',
      headers: { authorization: 'Bearer sec/ret', 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'test' }),
    })
    assert.equal(accepted.status, 202)
    assert.deepEqual(calls, [{
      workflowId: 'wf 1',
      payload: { source: 'test' },
    }])
  })
})

test('workflow webhook bind invariant accepts IPv4-mapped loopback addresses', () => {
  assert.equal(isWorkflowWebhookLoopbackBindAddress('127.0.0.1'), true)
  assert.equal(isWorkflowWebhookLoopbackBindAddress('::ffff:127.0.0.1'), true)
  assert.equal(isWorkflowWebhookLoopbackBindAddress('0.0.0.0'), false)
  assert.equal(isWorkflowWebhookLoopbackBindAddress('192.168.1.10'), false)
})

test('workflow webhook auth verifies HMAC payload signatures with replay bounds', async () => {
  await resetWorkflowWebhookSecurityStateForTests()
  const rawBody = JSON.stringify({ source: 'signed' })
  const timestamp = '2026-05-14T10:00:00.000Z'
  const signature = signWorkflowWebhookPayload('secret', rawBody, timestamp)

  assert.equal(verifyWorkflowWebhookAuth(
    { kind: 'signature', timestamp, signature, rawBody },
    'secret',
    new Date('2026-05-14T10:03:00.000Z'),
  ), true)
  assert.equal(verifyWorkflowWebhookAuth(
    { kind: 'signature', timestamp, signature, rawBody: JSON.stringify({ source: 'tampered' }) },
    'secret',
    new Date('2026-05-14T10:03:00.000Z'),
  ), false)
  assert.equal(verifyWorkflowWebhookAuth(
    { kind: 'signature', timestamp, signature, rawBody },
    'secret',
    new Date('2026-05-14T10:06:00.000Z'),
  ), false)

  const auth = { kind: 'signature' as const, timestamp, signature, rawBody }
  const transientClaim = await claimWorkflowWebhookSignatureOnce(auth, 'workflow-a', new Date('2026-05-14T10:03:00.000Z'))
  assert.ok(transientClaim, 'first signed delivery should claim replay key')
  assert.equal(await claimWorkflowWebhookSignatureOnce(auth, 'workflow-a', new Date('2026-05-14T10:03:01.000Z')), null)

  const fanoutClaim = await claimWorkflowWebhookSignatureOnce(auth, 'workflow-b', new Date('2026-05-14T10:03:01.000Z'))
  assert.ok(fanoutClaim, 'same signed provider event should be accepted for a different workflow')
  await fanoutClaim.accept()

  await transientClaim.release()
  const acceptedClaim = await claimWorkflowWebhookSignatureOnce(auth, 'workflow-a', new Date('2026-05-14T10:03:02.000Z'))
  assert.ok(acceptedClaim, 'released claim should allow provider retry after transient failure')
  await acceptedClaim.accept()
  assert.equal(await claimWorkflowWebhookSignatureOnce(auth, 'workflow-a', new Date('2026-05-14T10:03:03.000Z')), null)
  assert.equal(await claimWorkflowWebhookSignatureOnce(auth, 'workflow-b', new Date('2026-05-14T10:03:03.000Z')), null)
  await resetWorkflowWebhookSecurityStateForTests()
})

test('workflow webhook security store atomically claims requests, auth failures, and replay keys', async () => {
  const store = new InMemoryWorkflowWebhookSecurityStore()
  assert.equal(await store.claimRequest({
    source: 'source-a',
    nowMs: 1000,
    windowMs: 60_000,
    limit: 2,
  }), true)
  assert.equal(await store.claimRequest({
    source: 'source-a',
    nowMs: 1001,
    windowMs: 60_000,
    limit: 2,
  }), true)
  assert.equal(await store.claimRequest({
    source: 'source-a',
    nowMs: 1002,
    windowMs: 60_000,
    limit: 2,
  }), false)

  assert.equal(await store.checkAuthBackoff({ scope: 'scope-a', nowMs: 2000 }), true)
  await store.recordAuthFailure({
    scope: 'scope-a',
    source: 'source-a',
    nowMs: 2000,
    windowMs: 60_000,
    limit: 1,
    backoffMs: 60_000,
  })
  assert.equal(await store.checkAuthBackoff({ scope: 'scope-a', nowMs: 2001 }), false)

  const first = await store.claimSignature({
    key: 'replay-key',
    nowMs: 3000,
    windowMs: 60_000,
    cacheLimit: 10,
  })
  assert.ok(first)
  assert.equal(await store.claimSignature({
    key: 'replay-key',
    nowMs: 3001,
    windowMs: 60_000,
    cacheLimit: 10,
  }), null)
  await first.release()
  assert.ok(await store.claimSignature({
    key: 'replay-key',
    nowMs: 3002,
    windowMs: 60_000,
    cacheLimit: 10,
  }))
})

test('workflow webhook server throttles repeated unauthorized requests per workflow scope', async () => {
  await withWorkflowRuntimeStore('webhook-rate-limit', async () => {
    configureWorkflowWebhookServer(async () => {
      throw new Error('Handler should not run without auth.')
    })
    const baseUrl = await ensureWorkflowWebhookServer()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetchWorkflowWebhookWithRetry(`${baseUrl}/workflows/wf`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, 401)
    }

    const blocked = await fetchWorkflowWebhookWithRetry(`${baseUrl}/workflows/wf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(blocked.status, 429)

    const otherWorkflow = await fetchWorkflowWebhookWithRetry(`${baseUrl}/workflows/other-wf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(otherWorkflow.status, 401)
  })
})

test('workflow webhook public mode requires HMAC timestamp signatures', async () => {
  await withWorkflowRuntimeStore('webhook-public-signature', async () => {
    const calls: Array<{ workflowId: string; payload: Record<string, unknown> }> = []
    configureWorkflowWebhookServer(async (input) => {
      if (input.auth.kind !== 'signature') throw new Error('Expected signature auth.')
      if (!verifyWorkflowWebhookAuth(input.auth, 'secret', new Date('2026-05-14T10:03:00.000Z'))) {
        throw new WebhookHttpError(401, 'Workflow webhook authorization failed.')
      }
      calls.push({ workflowId: input.workflowId, payload: input.payload })
    }, { requireSignatureAuth: true })
    const baseUrl = await ensureWorkflowWebhookServer()
    const rawBody = JSON.stringify({ source: 'signed' })
    const timestamp = '2026-05-14T10:00:00.000Z'
    const signature = signWorkflowWebhookPayload('secret', rawBody, timestamp)

    const bearer = await fetchWorkflowWebhookWithRetry(`${baseUrl}/workflows/wf`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: rawBody,
    })
    assert.equal(bearer.status, 401)

    const signed = await fetchWorkflowWebhookWithRetry(`${baseUrl}/workflows/wf`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-cowork-timestamp': timestamp,
        'x-open-cowork-signature': signature,
      },
      body: rawBody,
    })
    assert.equal(signed.status, 202)
    assert.deepEqual(calls, [{
      workflowId: 'wf',
      payload: { source: 'signed' },
    }])
  })
})

test('workflow tool bridge requires bearer auth and creates workflows through the shared store path', async () => {
  await withWorkflowRuntimeStore('tool-bridge', async () => {
    let publishCount = 0
    configureWorkflowToolActions({ publishWorkflowUpdated: () => { publishCount += 1 } })
    await ensureWorkflowToolBridge()
    const env = getWorkflowToolBridgeEnvironment()
    const baseUrl = env.OPEN_COWORK_WORKFLOW_TOOL_URL
    const token = env.OPEN_COWORK_WORKFLOW_TOOL_TOKEN
    assert.equal(typeof baseUrl, 'string')
    assert.equal(typeof token, 'string')

    const unauthorized = await fetch(`${baseUrl}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manualWorkflowDraft),
    })
    assert.equal(unauthorized.status, 401)
    assert.match(await unauthorized.text(), /Unauthorized workflow tool request/)

    const wrongSameLengthToken = String(token).replace(/.$/, (char) => (char === 'A' ? 'B' : 'A'))
    const wrongSameLength = await fetch(`${baseUrl}/preview`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${wrongSameLengthToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(manualWorkflowDraft),
    })
    assert.equal(wrongSameLength.status, 401)

    const preview = await fetch(`${baseUrl}/preview`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(manualWorkflowDraft),
    })
    assert.equal(preview.status, 200)
    assert.equal((await preview.json() as { ok: boolean }).ok, true)

    const created = await fetch(`${baseUrl}/create`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(manualWorkflowDraft),
    })
    assert.equal(created.status, 200)
    const createdBody = await created.json() as { ok: boolean; workflow: { id: string; title: string; webhookUrl: string | null } }
    assert.equal(createdBody.ok, true)
    assert.equal(createdBody.workflow.title, 'Inbox summary')
    assert.equal(getWorkflow(createdBody.workflow.id)?.title, 'Inbox summary')
    assert.equal(publishCount, 1)
    assert.equal(getWorkflowWebhookBaseUrl(), null)
  })
})
