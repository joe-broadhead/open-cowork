import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  attachWorkflowRunSession,
  clearWorkflowStoreCache,
  createWorkflow,
  createWorkflowRun,
  getWorkflow,
  getWorkflowRun,
  listDueWorkflows,
  listWorkflows,
  markWorkflowRunCompleted,
  markWorkflowRunFailed,
  previewWorkflowDraft,
  regenerateWorkflowWebhookSecret,
  recoverInterruptedWorkflowRuns,
  parseWorkflowTriggersFromStorage,
  setWorkflowSecretStorageForTests,
  updateWorkflowStatus,
} from '../apps/desktop/src/main/workflow/workflow-store.ts'

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
    assert.match(raw, /enc:v1:/)
    assert.equal(raw.includes(webhookSecret!), false)

    const parsed = parseWorkflowTriggersFromStorage(raw)
    assert.equal(parsed.find((trigger) => trigger.type === 'webhook')?.webhookSecret, webhookSecret)
  } finally {
    db.close()
  }
}))

test('workflow store preserves plaintext webhook secrets that look like encrypted sentinels', () => withWorkflowStore('plaintext-secret-prefix', () => {
  setWorkflowSecretStorageForTests({ mode: 'plaintext' })

  const rawSecret = 'enc:v1:user-supplied-secret'
  const parsed = parseWorkflowTriggersFromStorage(JSON.stringify([
    { id: 'webhook', type: 'webhook', enabled: true, webhookSecret: rawSecret },
  ]))

  assert.equal(parsed[0]?.webhookSecret, rawSecret)
}))

test('workflow store treats valid non-array trigger JSON as empty', () => withWorkflowStore('non-array-triggers', () => {
  assert.deepEqual(parseWorkflowTriggersFromStorage('{}'), [])
  assert.deepEqual(parseWorkflowTriggersFromStorage('"manual"'), [])
}))

test('workflow store tracks run lifecycle and next scheduled run', () => withWorkflowStore('runs', () => {
  const workflow = createWorkflow(draft)
  const run = createWorkflowRun(workflow.id, 'manual', { source: 'test' })
  assert.equal(run?.status, 'queued')
  assert.throws(() => createWorkflowRun(workflow.id, 'manual', null), /already running/)

  const attached = attachWorkflowRunSession(workflow.id, run!.id, 'ses_run')
  assert.equal(attached?.status, 'running')
  assert.equal(getWorkflow(workflow.id)?.latestRunSessionId, 'ses_run')

  const completed = markWorkflowRunCompleted(run!.id, 'Sent summary.')
  assert.equal(completed?.status, 'completed')
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
  assert.equal(getWorkflowRun(running!.id)?.status, 'failed')
  assert.equal(getWorkflowRun(running!.id)?.finishedAt, '2026-05-15T11:00:00.000Z')
  assert.equal(getWorkflow(workflow.id)?.status, 'active')
  assert.equal(getWorkflow(workflow.id)?.latestRunSessionId, 'ses_running')
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
