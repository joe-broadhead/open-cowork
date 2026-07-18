import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import {
  addWorkDependency,
  attachTaskDispatchEnvironment,
  attachTaskDispatchSession,
  closeWorkDb,
  completeWorkTaskRun,
  createRoadmap,
  createChannelClaimCodeRecord,
  createWorkTask,
  deleteProjectBinding,
  deleteWorkTask,
  disposeWorkStore,
  getChannelBinding,
  listTaskDispatchReceipts,
  listTaskDispatchAcquisitions,
  listChannelClaimCodesReadOnly,
  listWorkDependencies,
  loadWorkState,
  openWorkDb,
  reserveTaskDispatchStart,
  recoverInterruptedStorageRestore,
  journalTaskDispatchAcquisitionIntent,
  markTaskDispatchAcquisitionSettled,
  setWorkDbLeadershipEpochProvider,
  startWorkTaskRunFromDispatch,
  updateWorkTask,
  upsertChannelBinding,
  upsertProjectBinding,
} from '../work-store.js'
import type { EnvironmentRunRecord } from '../environments.js'
import { createStorageBackup } from '../storage.js'
import { restoreStorageBackup, restoreStorageBackupToStateDir, setRestoreAfterInstallHookForTest } from '../storage/restore.js'
import { CURRENT_WORK_STORE_SCHEMA_VERSION, migrateWorkStoreSchema } from '../work-store/schema.js'
import { createDaemonLeadership } from '../daemon-leadership.js'

describe('durable storage hardening', () => {
  let testDir = ''
  let store = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-durable-storage-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
  })

  afterEach(() => {
    setRestoreAfterInstallHookForTest(undefined)
    setWorkDbLeadershipEpochProvider(undefined)
    disposeWorkStore()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('migrates a version-1 database transactionally without losing receipts', () => {
    const task = createWorkTask({ title: 'legacy receipt' }, store)
    const receipt = reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', leaseOwner: 'legacy-owner' }, store)!
    closeWorkDb(store)
    const legacy = new DatabaseSync(store)
    legacy.exec('ALTER TABLE task_dispatch_receipts DROP COLUMN acquisition_journal_json')
    legacy.exec('PRAGMA user_version = 1')
    legacy.close()

    expect(loadWorkState(store).tasks.map(row => row.id)).toContain(task.id)
    expect(listTaskDispatchReceipts({ taskId: task.id }, store)).toEqual([expect.objectContaining({ id: receipt.id })])
    closeWorkDb(store)
    const migrated = new DatabaseSync(store, { readOnly: true })
    expect(Number((migrated.prepare('PRAGMA user_version').get() as any).user_version)).toBe(CURRENT_WORK_STORE_SCHEMA_VERSION)
    expect((migrated.prepare('PRAGMA table_info(task_dispatch_receipts)').all() as any[]).map(row => row.name)).toContain('acquisition_journal_json')
    migrated.close()
  })

  it('rolls back DDL when a schema version update fails', () => {
    createWorkTask({ title: 'migration rollback' }, store)
    closeWorkDb(store)
    const db = new DatabaseSync(store)
    db.exec('ALTER TABLE task_dispatch_receipts DROP COLUMN acquisition_journal_json')
    db.exec('PRAGMA user_version = 1')
    const rawExec = db.exec.bind(db)
    ;(db as any).exec = (sql: string) => {
      if (/PRAGMA user_version = 2/.test(sql)) throw new Error('injected version write failure')
      rawExec(sql)
    }
    expect(() => migrateWorkStoreSchema(db)).toThrow('injected version write failure')
    expect(Number((db.prepare('PRAGMA user_version').get() as any).user_version)).toBe(1)
    expect((db.prepare('PRAGMA table_info(task_dispatch_receipts)').all() as any[]).map(row => row.name)).not.toContain('acquisition_journal_json')
    db.close()
  })

  it('rejects a future database version without dropping existing data', () => {
    const task = createWorkTask({ title: 'future data survives' }, store)
    closeWorkDb(store)
    const future = new DatabaseSync(store)
    future.exec(`PRAGMA user_version = ${CURRENT_WORK_STORE_SCHEMA_VERSION + 1}`)
    future.close()

    expect(() => loadWorkState(store)).toThrow('newer than this binary supports')
    const inspection = new DatabaseSync(store, { readOnly: true })
    expect((inspection.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id) as any).title).toBe('future data survives')
    inspection.close()
  })

  it('rejects a future database version before reusing a cached writer handle', () => {
    const task = createWorkTask({ title: 'cached future guard' }, store)
    const cached = openWorkDb(store)
    cached.exec(`PRAGMA user_version = ${CURRENT_WORK_STORE_SCHEMA_VERSION + 1}`)
    cached.close()

    expect(() => updateWorkTask(task.id, { title: 'old binary write' }, store)).toThrow('newer than this binary supports')

    const inspection = new DatabaseSync(store, { readOnly: true })
    expect((inspection.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id) as any).title).toBe('cached future guard')
    inspection.close()
  })

  it('refuses leadership DDL against a future-version database', () => {
    createWorkTask({ title: 'future leadership guard' }, store)
    closeWorkDb(store)
    const future = new DatabaseSync(store)
    future.exec(`PRAGMA user_version = ${CURRENT_WORK_STORE_SCHEMA_VERSION + 1}`)
    future.close()

    const leadership = createDaemonLeadership({ filePath: store, daemonId: 'old-binary', instanceId: 'old-binary:1' })
    expect(leadership.acquireOrRenew().canWrite).toBe(false)
    const inspection = new DatabaseSync(store, { readOnly: true })
    const tables = (inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).not.toContain('daemon_leadership')
    expect(tables).not.toContain('daemon_identity')
    inspection.close()
  })

  it('does not migrate an older database while the process lacks writer leadership', () => {
    createWorkTask({ title: 'standby migration guard' }, store)
    closeWorkDb(store)
    const legacy = new DatabaseSync(store)
    legacy.exec('DROP INDEX IF EXISTS idx_session_admissions_idempotency')
    legacy.exec('ALTER TABLE session_admissions DROP COLUMN last_error')
    legacy.exec('ALTER TABLE session_admissions DROP COLUMN idempotency_key')
    legacy.exec('ALTER TABLE session_admissions DROP COLUMN status')
    legacy.exec('PRAGMA user_version = 2')
    legacy.close()
    setWorkDbLeadershipEpochProvider(() => undefined)

    expect(() => loadWorkState(store)).toThrow('does not own the writer lease')
    const inspection = new DatabaseSync(store, { readOnly: true })
    expect(Number((inspection.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(2)
    expect((inspection.prepare('PRAGMA table_info(session_admissions)').all() as Array<{ name: string }>).map(row => row.name)).not.toContain('status')
    inspection.close()
  })

  it('allows current-schema standby reads while fencing every write', () => {
    const task = createWorkTask({ title: 'standby readable' }, store)
    closeWorkDb(store)
    setWorkDbLeadershipEpochProvider(() => undefined)

    expect(loadWorkState(store).tasks.some(row => row.id === task.id)).toBe(true)
    expect(() => createWorkTask({ title: 'standby write' }, store)).toThrow('does not own the writer lease')
  })

  it('fences every write transaction when the daemon leadership epoch becomes stale', () => {
    let now = 1_000
    const task = createWorkTask({ title: 'leadership fenced' }, store)
    const writer = createDaemonLeadership({ filePath: store, daemonId: 'writer-a', instanceId: 'writer-a:1', leaseMs: 10_000, now: () => now })
    expect(writer.acquireOrRenew().canWrite).toBe(true)
    setWorkDbLeadershipEpochProvider(() => writer.captureEpoch())
    expect(updateWorkTask(task.id, { title: 'writer update' }, store)?.title).toBe('writer update')

    now += 10_001
    const successor = createDaemonLeadership({ filePath: store, daemonId: 'writer-b', instanceId: 'writer-b:1', leaseMs: 10_000, now: () => now })
    expect(successor.acquireOrRenew().canWrite).toBe(true)
    expect(() => updateWorkTask(task.id, { title: 'stale update' }, store)).toThrow('does not own the writer lease')

    setWorkDbLeadershipEpochProvider(undefined)
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)?.title).toBe('writer update')
  })

  it('fences prepared-statement autocommit mutations after leadership changes', () => {
    let now = 1_000
    createWorkTask({ title: 'initialize claim schema' }, store)
    const writer = createDaemonLeadership({ filePath: store, daemonId: 'claim-a', instanceId: 'claim-a:1', leaseMs: 10_000, now: () => now })
    expect(writer.acquireOrRenew().canWrite).toBe(true)
    setWorkDbLeadershipEpochProvider(() => writer.captureEpoch())
    now += 10_001
    const successor = createDaemonLeadership({ filePath: store, daemonId: 'claim-b', instanceId: 'claim-b:1', leaseMs: 10_000, now: () => now })
    expect(successor.acquireOrRenew().canWrite).toBe(true)

    expect(() => createChannelClaimCodeRecord({
      id: 'claim_stale',
      provider: 'telegram',
      action: 'trust_target',
      codeHash: 'a'.repeat(64),
      codeFingerprint: 'stale',
      expiresAt: new Date(now + 60_000).toISOString(),
    }, store)).toThrow('does not own the writer lease')
    setWorkDbLeadershipEpochProvider(undefined)
    expect(listChannelClaimCodesReadOnly({}, store)).toEqual([])
  })

  it('rolls forward an interrupted mixed-generation restore before reopening storage', async () => {
    const task = createWorkTask({ title: 'backup generation' }, store)
    const sessions = path.join(testDir, 'sessions.json')
    fs.writeFileSync(sessions, JSON.stringify({ generation: 'backup' }))
    const backup = createStorageBackup({ stateDir: testDir, label: 'atomic-restore' })
    updateWorkTask(task.id, { title: 'live generation' }, store)
    fs.writeFileSync(sessions, JSON.stringify({ generation: 'live' }))

    setRestoreAfterInstallHookForTest(installed => {
      if (installed === 1) throw new Error('injected restore crash')
    })
    await expect(restoreStorageBackupToStateDir(backup.path, testDir, { maintenanceMode: true, skipSafetyBackup: true })).rejects.toThrow('injected restore crash')
    setRestoreAfterInstallHookForTest(undefined)
    expect(fs.existsSync(path.join(testDir, '.storage-restore-journal.json'))).toBe(true)

    const leadership = createDaemonLeadership({ filePath: store, daemonId: 'post-restore', instanceId: 'post-restore:1' })
    expect(leadership.acquireOrRenew().canWrite).toBe(true)
    leadership.release('test')

    expect(loadWorkState(store).tasks.find(row => row.id === task.id)?.title).toBe('backup generation')
    expect(JSON.parse(fs.readFileSync(sessions, 'utf8'))).toEqual({ generation: 'backup' })
    expect(fs.existsSync(path.join(testDir, '.storage-restore-journal.json'))).toBe(false)
    expect(fs.readdirSync(testDir).some(name => name.startsWith('.restore-stage-'))).toBe(false)
  })

  it('sweeps orphaned restore stage directories when no durable journal exists', () => {
    const orphan = path.join(testDir, '.restore-stage-orphaned')
    fs.mkdirSync(path.join(orphan, 'new'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(orphan, 'new', 'gateway.db'), 'partial')

    expect(recoverInterruptedStorageRestore(testDir)).toEqual({ recovered: false, installed: [] })
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('rejects a verified backup carrying a future work-store version', async () => {
    createWorkTask({ title: 'future backup' }, store)
    const backup = createStorageBackup({ stateDir: testDir, label: 'future-schema' })
    const backupDb = path.join(backup.path, 'gateway.db')
    const db = new DatabaseSync(backupDb)
    db.exec(`PRAGMA user_version = ${CURRENT_WORK_STORE_SCHEMA_VERSION + 1}`)
    db.close()
    rewriteBackupDigest(backup.path, 'gateway.db')

    await expect(restoreStorageBackupToStateDir(backup.path, testDir, { maintenanceMode: true, skipSafetyBackup: true })).rejects.toThrow('newer than this binary supports')
  })

  it('treats an authenticated health response as an active daemon during restore', async () => {
    const task = createWorkTask({ title: 'protected live state' }, store)
    const backup = createStorageBackup({ stateDir: testDir, label: 'active-daemon-guard' })
    updateWorkTask(task.id, { title: 'newer live state' }, store)
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('{"error":"authentication required"}', { status: 403 })
    try {
      await expect(restoreStorageBackup(backup.path, { skipSafetyBackup: true })).rejects.toThrow('daemon is active')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)?.title).toBe('newer live state')
  })

  it('probes configured daemon host before restoring live state', async () => {
    updateConfig({ security: { httpHost: '192.0.2.44', allowNonLocalHttp: true } } as any)
    const task = createWorkTask({ title: 'configured host live state' }, store)
    const backup = createStorageBackup({ stateDir: testDir, label: 'configured-host-daemon-guard' })
    updateWorkTask(task.id, { title: 'newer configured host state' }, store)
    const realFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = async (input: any) => {
      const url = String(input)
      seen.push(url)
      if (url.includes('127.0.0.1')) {
        const error = new Error('connect ECONNREFUSED') as Error & { code?: string }
        error.code = 'ECONNREFUSED'
        throw error
      }
      if (url.includes('192.0.2.44')) return new Response('{"ok":true}', { status: 200 })
      throw new Error(`unexpected health probe ${url}`)
    }
    try {
      await expect(restoreStorageBackup(backup.path, { skipSafetyBackup: true })).rejects.toThrow('daemon is active')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen.some(url => url.includes('127.0.0.1'))).toBe(true)
    expect(seen.some(url => url.includes('192.0.2.44'))).toBe(true)
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)?.title).toBe('newer configured host state')
  })

  it('enforces binding references and rolls back the binding when its audit event fails', () => {
    expect(() => upsertChannelBinding({ provider: 'telegram', chatId: 'missing', sessionId: 'ses', mode: 'task', taskId: 'task_missing' }, store)).toThrow('task not found')
    const task = createWorkTask({ title: 'atomic binding' }, store)
    closeWorkDb(store)
    const db = new DatabaseSync(store)
    db.exec(`CREATE TRIGGER fail_binding_audit BEFORE INSERT ON events
      WHEN NEW.type = 'channel.binding.upserted'
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`)
    db.close()

    expect(() => upsertChannelBinding({ provider: 'telegram', chatId: 'atomic', sessionId: 'ses_atomic', mode: 'task', taskId: task.id }, store)).toThrow('injected audit failure')
    expect(getChannelBinding('telegram', 'atomic', undefined, store)).toBeUndefined()
  })

  it('removes deleted-task references but preserves a newer independent mirrored binding', () => {
    const roadmap = createRoadmap({ title: 'binding cleanup' }, store)
    const task = createWorkTask({ title: 'delete me', roadmapId: roadmap.id }, store)
    const dependent = createWorkTask({ title: 'dependent', roadmapId: roadmap.id }, store)
    addWorkDependency({ taskId: dependent.id, dependsOnTaskId: task.id, type: 'blocked_by' }, store)
    reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', leaseOwner: 'cleanup-test' }, store)
    upsertChannelBinding({ provider: 'telegram', chatId: 'task-chat', sessionId: 'ses_task', mode: 'task', taskId: task.id }, store)
    expect(deleteWorkTask(task.id, store)).toMatchObject({ deleted: true })
    expect(listWorkDependencies(undefined, store).some(row => row.taskId === task.id || row.dependsOnTaskId === task.id)).toBe(false)
    expect(listTaskDispatchReceipts({ taskId: task.id }, store)).toEqual([])
    expect(getChannelBinding('telegram', 'task-chat', undefined, store)).toBeUndefined()

    const project = upsertProjectBinding({ alias: 'mirror', roadmapId: roadmap.id, sessionId: 'ses_project', provider: 'telegram', chatId: 'project-chat' }, store)
    upsertChannelBinding({ provider: 'telegram', chatId: 'project-chat', sessionId: 'ses_independent', mode: 'chat' }, store)
    expect(deleteProjectBinding(project.id, store)).toBe(true)
    expect(getChannelBinding('telegram', 'project-chat', undefined, store)).toMatchObject({ mode: 'chat', sessionId: 'ses_independent' })
  })

  it('refuses task deletion until every external acquisition is durably settled', () => {
    const task = createWorkTask({ title: 'retain recovery journal' }, store)
    const receipt = reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', leaseOwner: 'delete-test' }, store)!
    journalTaskDispatchAcquisitionIntent(receipt.id, { kind: 'session', provider: 'opencode' }, store)
    expect(() => deleteWorkTask(task.id, store)).toThrow('external acquisitions remain unsettled')
    expect(loadWorkState(store).tasks.some(row => row.id === task.id)).toBe(true)

    markTaskDispatchAcquisitionSettled(receipt.id, 'session', { status: 'released' }, store)
    expect(deleteWorkTask(task.id, store).deleted).toBe(true)
  })

  it('transfers successful dispatch acquisitions to the run lifecycle so completed tasks remain deletable', () => {
    const task = createWorkTask({ title: 'deletable after dispatch', pipeline: ['implement'] }, store)
    const receipt = reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', leaseOwner: 'owner-1', leaseMs: 60_000 }, store)!
    journalTaskDispatchAcquisitionIntent(receipt.id, { kind: 'environment', provider: 'local-process' }, store)
    attachTaskDispatchEnvironment(receipt.id, envRun({ id: 'env_dispatch_success' }), store)
    journalTaskDispatchAcquisitionIntent(receipt.id, { kind: 'session', provider: 'opencode' }, store)
    attachTaskDispatchSession(receipt.id, 'ses_dispatch_success', store)

    const started = startWorkTaskRunFromDispatch(receipt.id, task.id, 'implement', 'ses_dispatch_success', 'implementer', store, { owner: 'owner-1', generation: 'gen-1', leaseMs: 60_000 }, { environment: envRun({ id: 'env_dispatch_success' }) })!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: [], raw: 'done' }, 2, store)

    expect(listTaskDispatchAcquisitions(store).filter(row => row.dispatchId === receipt.id).map(row => row.status)).toEqual(['released', 'released'])
    expect(deleteWorkTask(task.id, store).deleted).toBe(true)
  })
})

function rewriteBackupDigest(backupPath: string, name: string): void {
  const metadataPath = path.join(backupPath, 'metadata.json')
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  const target = path.join(backupPath, name)
  const entry = metadata.files.find((row: any) => row.name === name)
  entry.size = fs.statSync(target).size
  entry.sha256 = sha256(target)
  metadata.checksum = createHash('sha256').update(metadata.files
    .slice()
    .sort((a: any, b: any) => a.name.localeCompare(b.name))
    .map((row: any) => `${row.name}:${row.size}:${row.sha256}`)
    .join('\n')).digest('hex')
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n')
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function envRun(overrides: Partial<EnvironmentRunRecord> = {}): EnvironmentRunRecord {
  return {
    id: 'env_durable',
    name: 'local-node',
    backend: 'local-process',
    status: 'prepared',
    specHash: 'durable-hardening',
    workdir: '/tmp/project',
    runtime: process.execPath,
    startedAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ttlMs: 3600000,
    cleanup: { retainOnFailure: false, retainOnSuccess: false, state: 'pending' },
    resources: { timeoutMs: 3600000 },
    network: { mode: 'restricted' },
    secrets: { allowedNames: [] },
    preflight: { ok: true, checked: ['node'], missing: [], warnings: [], commandRefs: ['command -v node'] },
    artifacts: [],
    metadata: {},
    ...overrides,
  }
}
