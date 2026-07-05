import { createWorkflowFromTool, previewWorkflowFromTool } from '@open-cowork/runtime-host/workflow/workflow-tool-actions'
import { attachWorkflowRunSession, claimDueWorkflowRun, clearWorkflowStoreCache, createWorkflow, createWorkflowRun, getWorkflow, getWorkflowRun, getWorkflowRunProjectionCheckpoint, listDueWorkflows, listWorkflows, markWorkflowRunCompleted, markWorkflowRunFailed, previewWorkflowDraft, regenerateWorkflowWebhookSecret, recoverInterruptedWorkflowRuns, parseWorkflowTriggersFromStorage, serializeWorkflowTriggersForStorage, setWorkflowDatabaseForTests, setWorkflowSecretStorageForTests, updateWorkflowStatus } from '@open-cowork/runtime-host/workflow/workflow-store'
import { normalizeWorkflowDraft, previewWorkflowDraft as previewWorkflowDraftCalculation } from '@open-cowork/runtime-host/workflow/workflow-normalization'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { cloudProjectionFenceObserved } from '../packages/shared/src/cloud-session-contract.ts'
function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-workflow-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function withWorkflowStore(name: string, run: (userDataDir: string) => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearWorkflowStoreCache()
    run(userDataDir)
  } finally {
    setWorkflowSecretStorageForTests(null)
    clearWorkflowStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

async function withWorkflowStoreAsync(name: string, run: (userDataDir: string) => Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearWorkflowStoreCache()
    await run(userDataDir)
  } finally {
    setWorkflowSecretStorageForTests(null)
    clearWorkflowStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

const draft = {
  title: 'Inbox summary',
  instructions: 'Scan the inbox and email a concise workload summary.',
  agentName: 'build',
  skillNames: ['email-triage'],
  toolIds: ['gmail'],
  projectDirectory: null,
  draftSessionId: 'ses_draft',
  triggers: [
    { id: 'manual', type: 'manual' as const, enabled: true },
    {
      id: 'daily',
      type: 'schedule' as const,
      enabled: true,
      schedule: { type: 'daily' as const, timezone: 'UTC', runAtHour: 9, runAtMinute: 0 },
    },
    { id: 'webhook', type: 'webhook' as const, enabled: true },
  ],
}

test('workflow store saves thread-created workflows and exposes webhook URLs', () => withWorkflowStore('store', (userDataDir) => {
  const preview = previewWorkflowDraft(draft)
  assert.equal(preview.ok, true)
  assert.equal(preview.normalizedDraft?.triggers.some((trigger) => trigger.type === 'manual'), true)

  const workflow = createWorkflow(draft, 'http://127.0.0.1:47839')
  assert.equal(workflow.title, 'Inbox summary')
  assert.equal(workflow.agentName, 'build')
  assert.equal(workflow.draftSessionId, 'ses_draft')
  assert.deepEqual(workflow.steps.map((step) => step.title), [
    'Prepare run context',
    'Execute saved instructions',
    'Review and summarize output',
  ])
  assert.equal(workflow.webhookUrl, `http://127.0.0.1:47839/workflows/${workflow.id}`)

  const listed = listWorkflows('http://127.0.0.1:47839')
  assert.equal(listed.workflows.length, 1)
  assert.equal(listed.workflows[0]?.id, workflow.id)

  const dbPath = join(userDataDir, 'workflows.sqlite')
  assert.equal(existsSync(dbPath), true)
  if (process.platform !== 'win32') {
    assert.equal(statSync(dbPath).mode & 0o777, 0o600)
  }
}))

test('workflow store encrypts webhook secrets at the SQLite boundary when secure storage is available', () => withWorkflowStore('secret-storage', (userDataDir) => {
  setWorkflowSecretStorageForTests({
    mode: 'encrypted',
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^sealed:/, ''),
  })

  const workflow = createWorkflow(draft)
  const webhookSecret = workflow.triggers.find((trigger) => trigger.type === 'webhook')?.webhookSecret
  assert.equal(typeof webhookSecret, 'string')

  const db = new DatabaseSync(join(userDataDir, 'workflows.sqlite'))
  try {
    const row = db.prepare('select triggers_json from workflows where id = ?').get(workflow.id) as { triggers_json?: string }
    const raw = row.triggers_json || ''
    assert.match(raw, /__openCoworkEncryptedWebhookSecret/)
    assert.equal(raw.includes(webhookSecret!), false)

    const parsed = parseWorkflowTriggersFromStorage(raw)
    assert.equal(parsed.find((trigger) => trigger.type === 'webhook')?.webhookSecret, webhookSecret)
  } finally {
    db.close()
  }
}))

test('workflow store preserves plaintext webhook secrets that look like encrypted sentinels', () => withWorkflowStore('plaintext-secret-prefix', () => {
  setWorkflowSecretStorageForTests({
    mode: 'encrypted',
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: () => {
      throw new Error('not ciphertext')
    },
  })

  const rawSecret = 'enc:v1:user-supplied-secret'
  const parsed = parseWorkflowTriggersFromStorage(JSON.stringify([
    { id: 'webhook', type: 'webhook', enabled: true, webhookSecret: rawSecret },
  ]))

  assert.equal(parsed[0]?.webhookSecret, rawSecret)
}))

test('workflow store decrypts legacy prefixed webhook secrets in plaintext mode when possible', () => withWorkflowStore('legacy-secret-prefix', () => {
  setWorkflowSecretStorageForTests({
    mode: 'plaintext',
    decryptString: (value) => value.toString('utf8').replace(/^sealed:/, ''),
  })

  const rawSecret = 'legacy-webhook-secret'
  const parsed = parseWorkflowTriggersFromStorage(JSON.stringify([
    {
      id: 'webhook',
      type: 'webhook',
      enabled: true,
      webhookSecret: `enc:v1:${Buffer.from(`sealed:${rawSecret}`, 'utf8').toString('base64')}`,
    },
  ]))

  assert.equal(parsed[0]?.webhookSecret, rawSecret)
}))

test('workflow store preserves encrypted webhook secret records when decryption fails', () => withWorkflowStore('secret-record-preserve', () => {
  setWorkflowSecretStorageForTests({
    mode: 'encrypted',
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: () => {
      throw new Error('keychain unavailable')
    },
  })

  const storedSecret = {
    __openCoworkEncryptedWebhookSecret: 2,
    value: Buffer.from('sealed:webhook-secret', 'utf8').toString('base64'),
  }
  const parsed = parseWorkflowTriggersFromStorage(JSON.stringify([
    { id: 'webhook', type: 'webhook', enabled: true, webhookSecret: storedSecret },
  ]))

  assert.deepEqual(parsed[0]?.webhookSecret, storedSecret)
  const serialized = JSON.parse(serializeWorkflowTriggersForStorage(parsed)) as Array<{ webhookSecret?: unknown }>
  assert.deepEqual(serialized[0]?.webhookSecret, storedSecret)
}))

test('workflow normalization uses explicit calculation adapters', () => {
  const normalized = normalizeWorkflowDraft({
    ...draft,
    projectDirectory: ' /tmp/project ',
    steps: [{ id: 'triage', title: 'Triage inbox', detail: 'Group urgent messages.' }],
    triggers: [{ id: '', type: 'webhook', enabled: true }],
  }, {
    now: new Date('2026-05-15T08:00:00.000Z'),
    idGenerator: () => 'generated-id',
    secretGenerator: () => 'generated-secret',
  })

  assert.equal(normalized.projectDirectory, '/tmp/project')
  assert.deepEqual(normalized.steps, [{ id: 'triage', title: 'Triage inbox', detail: 'Group urgent messages.' }])
  assert.deepEqual(normalized.triggers.map((trigger) => `${trigger.id}:${trigger.type}`), [
    'generated-id:manual',
    'generated-id:webhook',
  ])
  assert.equal(normalized.triggers.find((trigger) => trigger.type === 'webhook')?.webhookSecret, 'generated-secret')

  const derivedSteps = normalizeWorkflowDraft({
    ...draft,
    instructions: '1. Collect the inbox\n2. Summarize urgent work\n3. Send the digest',
    triggers: [{ id: 'manual', type: 'manual', enabled: true }],
  })
  assert.deepEqual(derivedSteps.steps.map((step) => step.title), [
    'Collect the inbox',
    'Summarize urgent work',
    'Send the digest',
  ])

  const sentenceDerivedSteps = normalizeWorkflowDraft({
    ...draft,
    instructions: 'Collect the inbox. Summarize urgent work! Send the digest?',
    triggers: [{ id: 'manual', type: 'manual', enabled: true }],
  })
  assert.deepEqual(sentenceDerivedSteps.steps.map((step) => step.title), [
    'Collect the inbox',
    'Summarize urgent work',
    'Send the digest',
  ])

  const preview = previewWorkflowDraftCalculation({
    ...draft,
    projectDirectory: '/missing/project',
    triggers: [{ id: 'manual', type: 'manual', enabled: true }],
  }, {
    projectDirectoryExists: () => false,
  })

  assert.equal(preview.ok, false)
  assert.deepEqual(preview.missing, ['Workflow project directory "/missing/project" is not available.'])
})

test('workflow store accepts explicit database and secret adapters in tests', () => {
  const db = new DatabaseSync(':memory:')
  try {
    setWorkflowDatabaseForTests(db)
    setWorkflowSecretStorageForTests({ mode: 'plaintext' })
    const workflow = createWorkflow({
      ...draft,
      skillNames: [],
      toolIds: [],
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
    }, null, { now: new Date('2026-05-15T08:00:00.000Z') })

    assert.equal(workflow.title, 'Inbox summary')
    assert.equal(listWorkflows().workflows[0]?.id, workflow.id)
  } finally {
    setWorkflowSecretStorageForTests(null)
    clearWorkflowStoreCache()
    db.close()
  }
})

test('workflow store treats valid non-array trigger JSON as empty', () => withWorkflowStore('non-array-triggers', () => {
  assert.deepEqual(parseWorkflowTriggersFromStorage('{}'), [])
  assert.deepEqual(parseWorkflowTriggersFromStorage('"manual"'), [])
}))

test('workflow store skips malformed trigger array entries during storage parsing', () => withWorkflowStore('malformed-trigger-entries', () => {
  const parsed = parseWorkflowTriggersFromStorage(JSON.stringify([
    null,
    'manual',
    {},
    [],
    { id: 'manual', type: 'manual', enabled: true },
    { id: 'webhook', type: 'webhook', enabled: true, webhookSecret: 'secret' },
  ]))

  assert.deepEqual(parsed.map((trigger) => trigger.type), ['manual', 'webhook'])
  assert.equal(parsed[1]?.webhookSecret, 'secret')
}))

test('workflow store tracks run lifecycle and next scheduled run', () => withWorkflowStore('runs', () => {
  const workflow = createWorkflow(draft)
  const run = createWorkflowRun(workflow.id, 'manual', { source: 'test' })
  assert.equal(run?.status, 'queued')
  assert.equal(run?.projectionFence?.scope, 'workflow-run')
  assert.equal(run?.projectionFence?.workflowId, workflow.id)
  assert.equal(run?.projectionFence?.runId, run?.id)
  assert.equal(cloudProjectionFenceObserved(run!.projectionFence!, getWorkflowRunProjectionCheckpoint(run!.id)!), true)
  assert.throws(() => createWorkflowRun(workflow.id, 'manual', null), /already running/)

  const attached = attachWorkflowRunSession(workflow.id, run!.id, 'ses_run')
  assert.equal(attached?.status, 'running')
  assert.equal(cloudProjectionFenceObserved(attached!.projectionFence!, getWorkflowRunProjectionCheckpoint(run!.id)!), true)
  assert.ok((attached?.projectionFence?.projectionVersion || 0) > (run?.projectionFence?.projectionVersion || 0))
  assert.equal(getWorkflow(workflow.id)?.latestRunSessionId, 'ses_run')

  const completed = markWorkflowRunCompleted(run!.id, 'Sent summary.')
  assert.equal(completed?.status, 'completed')
  assert.equal(cloudProjectionFenceObserved(completed!.projectionFence!, getWorkflowRunProjectionCheckpoint(run!.id)!), true)
  assert.ok((completed?.projectionFence?.projectionVersion || 0) > (attached?.projectionFence?.projectionVersion || 0))
  const failedAfterComplete = markWorkflowRunFailed(run!.id, 'Late model error.')
  assert.equal(failedAfterComplete?.status, 'completed')
  const afterComplete = getWorkflow(workflow.id)
  assert.equal(afterComplete?.status, 'active')
  assert.equal(afterComplete?.latestRunSummary, 'Sent summary.')
  assert.ok(afterComplete?.nextRunAt)

  const failedRun = createWorkflowRun(workflow.id, 'manual', null)
  markWorkflowRunFailed(failedRun!.id, 'Mailbox unavailable.')
  const afterFailure = getWorkflow(workflow.id)
  assert.equal(afterFailure?.status, 'active')
  assert.equal(afterFailure?.latestRunStatus, 'failed')
  assert.equal(afterFailure?.latestRunSummary, 'Mailbox unavailable.')
}))

test('workflow run completion preserves paused workflow status', () => withWorkflowStore('complete-paused', () => {
  const workflow = createWorkflow(draft)
  const run = createWorkflowRun(workflow.id, 'manual', { source: 'test' })
  assert.equal(getWorkflow(workflow.id)?.status, 'running')

  updateWorkflowStatus(workflow.id, 'paused')
  const completed = markWorkflowRunCompleted(run!.id, 'Sent summary.')
  assert.equal(completed?.status, 'completed')

  const afterComplete = getWorkflow(workflow.id)
  assert.equal(afterComplete?.status, 'paused')
  assert.equal(afterComplete?.latestRunStatus, 'completed')
  assert.equal(afterComplete?.latestRunSummary, 'Sent summary.')
  assert.equal(afterComplete?.nextRunAt, null)
}))

test('workflow store recovers interrupted queued and running runs without keeping workflows blocked', () => withWorkflowStore('recovery', () => {
  const workflow = createWorkflow(draft)
  const queued = createWorkflowRun(workflow.id, 'manual', { source: 'queued' })
  assert.equal(getWorkflow(workflow.id)?.status, 'running')

  const recoveredQueued = recoverInterruptedWorkflowRuns('Recovered after app restart.', new Date('2026-05-15T10:00:00.000Z'))
  assert.deepEqual(recoveredQueued.map((run) => run.id), [queued!.id])
  assert.equal(recoveredQueued[0]?.status, 'failed')
  assert.equal(recoveredQueued[0]?.error, 'Recovered after app restart.')
  assert.equal(getWorkflowRun(queued!.id)?.status, 'failed')
  assert.equal(getWorkflow(workflow.id)?.status, 'active')
  assert.equal(getWorkflow(workflow.id)?.latestRunStatus, 'failed')

  const running = createWorkflowRun(workflow.id, 'manual', { source: 'running' })
  attachWorkflowRunSession(workflow.id, running!.id, 'ses_running')
  const recoveredRunning = recoverInterruptedWorkflowRuns('Recovered running session.', new Date('2026-05-15T11:00:00.000Z'))

  assert.deepEqual(recoveredRunning.map((run) => run.id), [running!.id])
  assert.equal(cloudProjectionFenceObserved(recoveredRunning[0]!.projectionFence!, getWorkflowRunProjectionCheckpoint(running!.id)!), true)
  assert.equal(getWorkflowRun(running!.id)?.status, 'failed')
  assert.equal(getWorkflowRun(running!.id)?.finishedAt, '2026-05-15T11:00:00.000Z')
  assert.equal(getWorkflow(workflow.id)?.status, 'active')
  assert.equal(getWorkflow(workflow.id)?.latestRunSessionId, 'ses_running')
}))

test('workflow store atomically claims a due scheduled workflow and creates its run', () => withWorkflowStore('claim-due', () => {
  const createdAt = new Date('2026-05-15T08:00:00.000Z')
  const dueAt = new Date('2026-05-15T09:00:00.000Z')
  const workflow = createWorkflow({
    ...draft,
    triggers: [{
      id: 'once',
      type: 'schedule',
      enabled: true,
      schedule: { type: 'one_time', timezone: 'UTC', startAt: dueAt.toISOString() },
    }],
  }, null, { now: createdAt })

  const claimed = claimDueWorkflowRun(dueAt)
  assert.equal(claimed?.workflowId, workflow.id)
  assert.equal(claimed?.triggerType, 'schedule')
  assert.equal(claimed?.status, 'queued')
  assert.equal(cloudProjectionFenceObserved(claimed!.projectionFence!, getWorkflowRunProjectionCheckpoint(claimed!.id)!), true)
  assert.deepEqual(claimed?.triggerPayload, {
    source: 'schedule',
    scheduledFor: dueAt.toISOString(),
  })

  const afterClaim = getWorkflow(workflow.id)
  assert.equal(afterClaim?.status, 'running')
  assert.equal(afterClaim?.latestRunId, claimed?.id)
  assert.equal(afterClaim?.latestRunStatus, 'queued')
  assert.equal(claimDueWorkflowRun(dueAt), null)
}))

test('workflow preview accepts manual-only workflows', () => {
  const preview = previewWorkflowDraft({
    ...draft,
    triggers: [{ id: 'manual', type: 'manual', enabled: true }],
  })

  assert.equal(preview.ok, true)
  assert.equal(preview.normalizedDraft?.triggers.length, 1)
  assert.equal(preview.normalizedDraft?.triggers[0]?.type, 'manual')
})

test('workflow preview blocks missing required agents and create enforces the same capability check', () => {
  const missingAgentDraft = {
    ...draft,
    agentName: 'missing-agent',
    skillNames: [],
    toolIds: [],
    triggers: [{ id: 'manual', type: 'manual' as const, enabled: true }],
  }
  const capabilities = { agentNames: ['build'], skillNames: [], toolIds: [] }
  const preview = previewWorkflowDraft(missingAgentDraft, { capabilities })

  assert.equal(preview.ok, false)
  assert.deepEqual(preview.missing, ['Workflow agent "missing-agent" is not available.'])
  assert.deepEqual(preview.gaps?.map((gap) => `${gap.severity}:${gap.field}:${gap.value}`), ['required:agentName:missing-agent'])

  assert.throws(
    () => createWorkflow(missingAgentDraft, null, { capabilities }),
    /Workflow agent "missing-agent" is not available/,
  )
})

test('workflow preview represents missing optional skill and tool references as gaps', () => {
  const preview = previewWorkflowDraft({
    ...draft,
    skillNames: ['ghost-skill'],
    toolIds: ['ghost-tool'],
    triggers: [{ id: 'manual', type: 'manual' as const, enabled: true }],
  }, { capabilities: { agentNames: ['build'], skillNames: [], toolIds: [] } })

  assert.equal(preview.ok, true)
  assert.deepEqual(preview.missing, [])
  assert.deepEqual(preview.gaps?.map((gap) => `${gap.severity}:${gap.field}:${gap.value}`), [
    'optional:skillNames:ghost-skill',
    'optional:toolIds:ghost-tool',
  ])
})

test('workflow preview blocks unavailable project directories', () => {
  const projectDirectory = join(tmpdir(), `open-cowork-missing-workflow-project-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const preview = previewWorkflowDraft({
    ...draft,
    skillNames: [],
    toolIds: [],
    projectDirectory,
    triggers: [{ id: 'manual', type: 'manual' as const, enabled: true }],
  }, { capabilities: { agentNames: ['build'], skillNames: [], toolIds: [] } })

  assert.equal(preview.ok, false)
  assert.deepEqual(preview.missing, [`Workflow project directory "${projectDirectory}" is not available.`])
})

test('workflow tool create requires and consumes a confirmed preview token', async () => {
  await withWorkflowStoreAsync('tool-preview-token', async () => {
    await assert.rejects(
      () => createWorkflowFromTool({ previewToken: 'missing-token' }),
      /valid confirmed preview token/,
    )

    const preview = await previewWorkflowFromTool({
      ...draft,
      skillNames: [],
      toolIds: [],
      triggers: [{ id: 'manual', type: 'manual' as const, enabled: true }],
    })
    assert.equal(preview.ok, true)
    assert.equal(typeof preview.previewToken, 'string')

    const result = await createWorkflowFromTool({ previewToken: preview.previewToken! })
    assert.equal(result.ok, true)
    assert.equal(result.workflow.title, 'Inbox summary')

    await assert.rejects(
      () => createWorkflowFromTool({ previewToken: preview.previewToken! }),
      /valid confirmed preview token/,
    )
  })
})

test('workflow store pauses, resumes, archives, regenerates webhook secrets, and lists due workflows', () => withWorkflowStore('status', () => {
  const createdAt = new Date('2026-05-15T08:00:00.000Z')
  const dueAt = new Date('2026-05-15T09:00:00.000Z')
  const workflow = createWorkflow({
    ...draft,
    triggers: [{
      id: 'once',
      type: 'schedule',
      enabled: true,
      schedule: { type: 'one_time', timezone: 'UTC', startAt: dueAt.toISOString() },
    }, { id: 'webhook', type: 'webhook', enabled: true }],
  }, 'http://127.0.0.1:47839', { now: createdAt })
  assert.equal(listDueWorkflows(dueAt).length, 1)

  const paused = updateWorkflowStatus(workflow.id, 'paused')
  assert.equal(paused?.status, 'paused')
  assert.equal(listDueWorkflows(dueAt).length, 0)

  const resumed = updateWorkflowStatus(workflow.id, 'active', null, { now: createdAt })
  assert.equal(resumed?.status, 'active')

  const first = getWorkflow(workflow.id, 'http://127.0.0.1:47839')
  const firstUrl = first?.webhookUrl
  const firstSecret = first?.triggers.find((trigger) => trigger.type === 'webhook')?.webhookSecret
  const regenerated = regenerateWorkflowWebhookSecret(workflow.id, 'http://127.0.0.1:47839')
  const regeneratedSecret = regenerated?.triggers.find((trigger) => trigger.type === 'webhook')?.webhookSecret
  assert.equal(regenerated?.webhookUrl, firstUrl)
  assert.notEqual(regeneratedSecret, firstSecret)

  const archived = updateWorkflowStatus(workflow.id, 'archived')
  assert.equal(archived?.status, 'archived')
}))
