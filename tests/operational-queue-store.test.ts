import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  OPERATIONAL_QUEUE_STORE_SCHEMA_VERSION,
  blockOperationalQueueItem,
  buildOperationalQueueAlerts,
  buildOperationalQueueKeys,
  clearOperationalQueueStoreCache,
  enqueueOperationalRun,
  finishOperationalQueueItem,
  getOperationalQueueDb,
  getOperationalQueueItem,
  listOperationalQueueItems,
  listWorkspaceProfiles,
  recordOperationalQueueItemCost,
  resolveEffectiveAutonomy,
  retryOperationalQueueItem,
  startOperationalQueueItem,
  startRunnableOperationalQueueItems,
} from '../apps/desktop/src/main/operational-queue-store.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-operational-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetOperationalStore(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearOperationalQueueStoreCache()
}

function withOperationalStore(name: string, fn: () => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetOperationalStore(userDataDir)
    fn()
  } finally {
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

test('operational queues serialize write-capable runs for the same project target', () => withOperationalStore('write-serialize', () => {
  const first = enqueueOperationalRun({
    runKind: 'agent',
    runId: 'agent-run-1',
    title: 'Write project file',
    requestedAutonomy: 'bounded-auto',
    globalMaxAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    agentName: 'build',
    projectId: '/workspace/acme',
    writeCapable: true,
  })
  const second = enqueueOperationalRun({
    runKind: 'crew',
    runId: 'crew-run-1',
    title: 'Update the same project',
    requestedAutonomy: 'bounded-auto',
    globalMaxAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    crewId: 'crew-1',
    projectId: '/workspace/acme',
    writeCapable: true,
  })

  assert.deepEqual(first.queueKeys.includes('project:/workspace/acme'), true)
  assert.equal(first.effectiveAutonomy, 'supervised')
  assert.equal(second.effectiveAutonomy, 'supervised')
  assert.deepEqual(startRunnableOperationalQueueItems().map((item) => item.id), [first.id])
  assert.equal(getOperationalQueueItem(first.id)?.status, 'running')
  assert.equal(getOperationalQueueItem(second.id)?.status, 'queued')

  finishOperationalQueueItem(first.id, 'completed')
  assert.deepEqual(startRunnableOperationalQueueItems().map((item) => item.id), [second.id])
  assert.equal(getOperationalQueueItem(second.id)?.status, 'running')
}))

test('operational queues allow read-only research fanout without serialization keys', () => withOperationalStore('read-fanout', () => {
  const first = enqueueOperationalRun({
    runKind: 'agent',
    runId: 'read-1',
    title: 'Research source A',
    requestedAutonomy: 'draft',
    workspaceProfileId: 'personal-sandbox',
    agentName: 'explore',
    projectId: '/workspace/acme',
    writeCapable: false,
  })
  const second = enqueueOperationalRun({
    runKind: 'agent',
    runId: 'read-2',
    title: 'Research source B',
    requestedAutonomy: 'draft',
    workspaceProfileId: 'personal-sandbox',
    agentName: 'explore',
    projectId: '/workspace/acme',
    writeCapable: false,
  })

  assert.deepEqual(first.queueKeys, [])
  assert.deepEqual(second.queueKeys, [])
  assert.deepEqual(new Set(startRunnableOperationalQueueItems().map((item) => item.id)), new Set([first.id, second.id]))
}))

test('operational queues honor explicit parallelism caps for shared write targets', () => withOperationalStore('parallel-cap', () => {
  const first = enqueueOperationalRun({
    runKind: 'agent',
    runId: 'parallel-1',
    title: 'Write shard A',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    projectId: '/workspace/acme',
    writeCapable: true,
    caps: { maxParallel: 2 },
  })
  const second = enqueueOperationalRun({
    runKind: 'agent',
    runId: 'parallel-2',
    title: 'Write shard B',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    projectId: '/workspace/acme',
    writeCapable: true,
    caps: { maxParallel: 2 },
  })
  const third = enqueueOperationalRun({
    runKind: 'agent',
    runId: 'parallel-3',
    title: 'Write shard C',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    projectId: '/workspace/acme',
    writeCapable: true,
    caps: { maxParallel: 2 },
  })

  assert.deepEqual(startRunnableOperationalQueueItems().map((item) => item.id), [first.id, second.id])
  assert.equal(getOperationalQueueItem(third.id)?.status, 'queued')
}))

test('starting one operational item does not accidentally claim unrelated queued runs', () => withOperationalStore('start-one', () => {
  const first = enqueueOperationalRun({
    runKind: 'crew',
    runId: 'crew-specific-1',
    title: 'Specific crew run',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    crewId: 'crew-specific',
    writeCapable: true,
  })
  const second = enqueueOperationalRun({
    runKind: 'crew',
    runId: 'crew-specific-2',
    title: 'Second crew run',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    crewId: 'crew-other',
    writeCapable: true,
  })

  assert.equal(startOperationalQueueItem(second.id)?.status, 'running')
  assert.equal(getOperationalQueueItem(first.id)?.status, 'queued')
  assert.equal(getOperationalQueueItem(second.id)?.status, 'running')
}))

test('blocked operational items keep their queue keys occupied until resolved', () => withOperationalStore('blocked-occupies', () => {
  const first = enqueueOperationalRun({
    runKind: 'crew',
    runId: 'crew-blocked-1',
    title: 'Blocked crew run',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    crewId: 'crew-blocked',
    writeCapable: true,
  })
  const second = enqueueOperationalRun({
    runKind: 'crew',
    runId: 'crew-blocked-2',
    title: 'Next crew run',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    crewId: 'crew-blocked',
    writeCapable: true,
  })

  assert.equal(startOperationalQueueItem(first.id)?.status, 'running')
  assert.equal(blockOperationalQueueItem(first.id, 'Waiting for approval.')?.status, 'blocked')
  assert.equal(startOperationalQueueItem(second.id)?.status, 'queued')
}))

test('operational queue state survives store reopen', () => withOperationalStore('survives-restart', () => {
  const queued = enqueueOperationalRun({
    runKind: 'sop',
    runId: 'sop-run-1',
    title: 'Run SOP',
    requestedAutonomy: 'approve',
    workspaceProfileId: 'automation-workspace',
    projectId: '/workspace/acme',
    writeCapable: true,
  })

  clearOperationalQueueStoreCache()

  assert.equal(getOperationalQueueItem(queued.id)?.status, 'queued')
  assert.equal(listOperationalQueueItems().length, 1)
}))

test('workspace profiles expose filesystem, external authority, cleanup, and retention', () => withOperationalStore('profiles', () => {
  const profiles = listWorkspaceProfiles()
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]))

  assert.equal(profileById.size, 5)
  assert.equal(profileById.get('project-workspace')?.authority.filesystem.mode, 'project')
  assert.equal(profileById.get('project-workspace')?.authority.isolation.projectBound, true)
  assert.equal(profileById.get('channel-sandbox')?.authority.isolation.channelBound, true)
  assert.equal(profileById.get('high-risk-isolated')?.authority.isolation.highRiskIsolated, true)
  assert.ok((profileById.get('automation-workspace')?.authority.cleanup.retentionDays || 0) > 0)
}))

test('autonomy ladder clamps higher autonomy to global policy ceilings', () => withOperationalStore('autonomy', () => {
  assert.equal(resolveEffectiveAutonomy('bounded-auto', 'approve'), 'approve')
  assert.equal(resolveEffectiveAutonomy('supervised', 'draft'), 'draft')
  assert.equal(resolveEffectiveAutonomy('observe', 'bounded-auto'), 'observe')

  const item = enqueueOperationalRun({
    runKind: 'automation',
    runId: 'automation-run-1',
    title: 'Attempt high autonomy',
    requestedAutonomy: 'bounded-auto',
    globalMaxAutonomy: 'approve',
    workspaceProfileId: 'automation-workspace',
    projectId: '/workspace/acme',
    writeCapable: true,
  })

  assert.equal(item.requestedAutonomy, 'bounded-auto')
  assert.equal(item.effectiveAutonomy, 'approve')
}))

test('queue keys include per-agent, crew, project, channel, and external-system targets for writes only', () => {
  assert.deepEqual(buildOperationalQueueKeys({
    writeCapable: false,
    agentName: 'build',
    projectId: '/workspace/acme',
  }), [])

  assert.deepEqual(buildOperationalQueueKeys({
    writeCapable: true,
    agentName: 'build',
    crewId: 'crew-1',
    projectId: '/workspace/acme',
    channelId: 'slack:C123',
    externalSystemIds: ['github', 'github', 'sheets'],
  }), [
    'agent:build',
    'channel:slack:C123',
    'crew:crew-1',
    'external_system:github',
    'external_system:sheets',
    'project:/workspace/acme',
  ])
})

test('operational queue alerts surface stuck running items', () => withOperationalStore('alerts', () => {
  const item = enqueueOperationalRun({
    runKind: 'automation',
    runId: 'slow-run',
    title: 'Slow run',
    requestedAutonomy: 'approve',
    workspaceProfileId: 'automation-workspace',
    writeCapable: false,
    caps: { maxRunDurationMinutes: 1 },
  })
  const [started] = startRunnableOperationalQueueItems()
  assert.equal(started?.id, item.id)
  getOperationalQueueDb().prepare(`
    update operational_queue_items
    set started_at = ?, updated_at = ?
    where id = ?
  `).run('2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z', item.id)

  const alerts = buildOperationalQueueAlerts('2026-05-10T00:03:00.000Z')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]?.kind, 'stuck_run')
  assert.equal(alerts[0]?.queueItemId, item.id)
}))

test('operational queue alerts surface budget and blocked runs', () => withOperationalStore('budget-blocked-alerts', () => {
  const expensive = enqueueOperationalRun({
    runKind: 'crew',
    runId: 'expensive-run',
    title: 'Expensive run',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    writeCapable: false,
    caps: { maxCostUsd: 5 },
  })
  const blocked = enqueueOperationalRun({
    runKind: 'automation',
    runId: 'blocked-run',
    title: 'Blocked run',
    requestedAutonomy: 'approve',
    workspaceProfileId: 'automation-workspace',
    writeCapable: false,
  })

  startRunnableOperationalQueueItems()
  recordOperationalQueueItemCost(expensive.id, 5.01)
  blockOperationalQueueItem(blocked.id, 'Waiting for approval.')

  const alerts = buildOperationalQueueAlerts('2026-05-10T00:04:00.000Z')
  assert.deepEqual(new Set(alerts.map((alert) => alert.kind)), new Set(['budget_exceeded', 'blocked_run']))
  assert.equal(alerts.find((alert) => alert.kind === 'blocked_run')?.message, 'Waiting for approval.')
}))

test('operational queue retry budget controls failed run requeueing', () => withOperationalStore('retry-budget', () => {
  const item = enqueueOperationalRun({
    runKind: 'agent',
    runId: 'retry-run',
    title: 'Retry run',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    writeCapable: false,
    caps: { maxRetries: 1 },
  })

  startRunnableOperationalQueueItems()
  finishOperationalQueueItem(item.id, 'failed', { error: 'First attempt failed.' })
  assert.equal(retryOperationalQueueItem(item.id)?.status, 'queued')

  startRunnableOperationalQueueItems()
  finishOperationalQueueItem(item.id, 'failed', { error: 'Second attempt failed.' })
  assert.equal(retryOperationalQueueItem(item.id)?.status, 'failed')
}))

test('finishing an operational queue item preserves previously recorded cost by default', () => withOperationalStore('finish-cost', () => {
  const item = enqueueOperationalRun({
    runKind: 'crew',
    runId: 'cost-preserved',
    title: 'Preserve cost',
    requestedAutonomy: 'supervised',
    workspaceProfileId: 'project-workspace',
    writeCapable: false,
  })

  startRunnableOperationalQueueItems()
  recordOperationalQueueItemCost(item.id, 2.75)
  finishOperationalQueueItem(item.id, 'completed')
  assert.equal(getOperationalQueueItem(item.id)?.costUsd, 2.75)
}))

test('operational queue database records schema metadata', () => withOperationalStore('schema', () => {
  const db = getOperationalQueueDb()
  const meta = db.prepare('select value from operational_meta where key = ?').get('schema_version') as { value?: string } | undefined
  assert.equal(Number(meta?.value), OPERATIONAL_QUEUE_STORE_SCHEMA_VERSION)
}))
