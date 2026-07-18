import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest } from '../config.js'
import { setChannelSession } from '../channel-sessions.js'
import { appendWorkEvent, clearWorkStateForTest, createRoadmapSupervisor, createWorkTask, loadWorkState, proposeRoadmapCompletion, reserveTaskDispatchStart, startWorkTaskRun, upsertProjectBinding, workStatePath } from '../work-store.js'
import { buildDurableStateConsistencyProof, buildDurableStateIntegrityReport, buildLocalDurableStateAdapterReport, createStorageBackup, describeStorageBackend, exportGatewayState, listStorageBackups, listStorageRecoveryDrills, restoreStorageBackup, runBackendRollbackDrill, runLocalDurableStateRepair, runStorageDoctor, runStorageLifecycleAudit, runStorageRecoveryDrill, validateLocalDurableStateBackupRoundTrip, verifyStorageBackup } from '../storage.js'

describe('storage operations', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-storage-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  const hashGatewayDbArtifacts = (stateDir: string) => {
    const hash = createHash('sha256')
    for (const name of ['gateway.db', 'gateway.db-wal', 'gateway.db-shm']) {
      const filePath = path.join(stateDir, name)
      hash.update(name)
      if (fs.existsSync(filePath)) hash.update(fs.readFileSync(filePath))
      else hash.update('<missing>')
    }
    return hash.digest('hex')
  }

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    vi.unstubAllGlobals()
  })

  it.skipIf(process.platform === 'win32')('keeps the database and its WAL/SHM sidecars owner-only after a write', () => {
    const dbPath = path.join(testDir, 'gateway.db')
    // Hold an extra connection so the WAL/SHM sidecars are not checkpointed away
    // when the work-store closes its own connection after the write.
    createWorkTask({ title: 'Create the database first' })
    const holder = new DatabaseSync(dbPath)
    try {
      holder.exec('PRAGMA journal_mode = WAL')
      createWorkTask({ title: 'Permission check' })

      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        expect(fs.existsSync(file), `${file} should exist`).toBe(true)
        expect((fs.statSync(file).mode & 0o777).toString(8), `${file} should be owner-only`).toBe('600')
      }
    } finally {
      holder.close()
    }
  })

  it('creates, lists, and verifies timestamped backups with metadata', () => {
    const task = createWorkTask({ title: 'Back me up' })
    createRoadmapSupervisor({ roadmapId: task.roadmapId, sessionId: 'ses_backup' })
    upsertProjectBinding({ alias: 'backup-project', roadmapId: task.roadmapId, sessionId: 'ses_backup' })
    proposeRoadmapCompletion({ roadmapId: task.roadmapId, evidence: ['backup evidence'] })
    setChannelSession('telegram', 'chat-1', 'ses_1', {})

    const backup = createStorageBackup({ label: 'test', now: new Date('2026-06-13T12:00:00.000Z') })
    const verification = verifyStorageBackup(backup.path)

    expect(backup.id).toBe('gateway-backup-20260613T120000Z-test')
    expect(backup.counts).toMatchObject({ tasks: 1, supervisors: 1, projectBindings: 1, completionProposals: 1, channelBindings: 1 })
    expect(backup.files.some(file => file.name === 'gateway.db')).toBe(true)
    expect(verification).toMatchObject({ ok: true, errors: [] })
    expect(listStorageBackups().map(row => row.id)).toContain(backup.id)
    expect(backup.version).toBe(1)
    expect(fs.existsSync(path.join(testDir, '.storage-operation.lock'))).toBe(false)
  })

  it('blocks work-store mutations while a storage operation lock is fresh', () => {
    const lockDir = path.join(testDir, '.storage-operation.lock')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ operation: 'backup', pid: process.pid }))

    expect(() => createWorkTask({ title: 'Blocked during backup' })).toThrow(/storage operation in progress/)
  })

  it('records full event counts in backup metadata beyond the recent-event window', () => {
    for (let i = 0; i < 505; i += 1) appendWorkEvent('backup.event_count_probe', `event-${i}`)

    const backup = createStorageBackup({ label: 'event-counts', now: new Date('2026-06-13T12:30:00.000Z') })
    const verification = verifyStorageBackup(backup.path)

    expect(backup.counts.events).toBe(505)
    expect(verification).toMatchObject({ ok: true, errors: [] })
  })

  it('refuses live backups while task runs are active unless explicitly allowed', () => {
    const task = createWorkTask({ title: 'Active backup guard' })
    startWorkTaskRun(task.id, 'implement', 'ses_active_backup', 'implementer')

    expect(() => createStorageBackup({ label: 'active' })).toThrow(/active run/)
    expect(listStorageBackups()).toHaveLength(0)

    const backup = createStorageBackup({ label: 'active-maintenance', allowActiveRuns: true })
    expect(verifyStorageBackup(backup.path)).toMatchObject({ ok: true })
  })

  it('refuses live backups while dispatch receipts are starting unless explicitly allowed', () => {
    const task = createWorkTask({ title: 'Dispatch backup guard' })
    reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', profile: 'implementer', leaseOwner: 'test', leaseMs: 60_000 })

    expect(() => createStorageBackup({ label: 'dispatch-active' })).toThrow(/starting dispatch/)
    expect(listStorageBackups()).toHaveLength(0)

    const backup = createStorageBackup({ label: 'dispatch-maintenance', allowActiveRuns: true })
    expect(verifyStorageBackup(backup.path)).toMatchObject({ ok: true })
  })

  it('includes the durable channel sync outbox in verified backups', () => {
    fs.mkdirSync(testDir, { recursive: true })
    const outboxPath = path.join(testDir, 'channel-sync.json.sqlite')
    const db = new DatabaseSync(outboxPath)
    try {
      db.exec('CREATE TABLE channel_sync_outbox (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO channel_sync_outbox (id, status) VALUES (\'delivery-1\', \'delivered\')')
    } finally {
      db.close()
    }

    const backup = createStorageBackup({ label: 'outbox' })
    const verification = verifyStorageBackup(backup.path)

    expect(backup.files.map(file => file.name)).toEqual(expect.arrayContaining(['gateway.db', 'channel-sync.json.sqlite']))
    expect(fs.existsSync(path.join(backup.path, 'channel-sync.json.sqlite'))).toBe(true)
    expect(verification).toMatchObject({ ok: true, errors: [] })
  })

  it('detects a corrupt durable channel sync outbox even when backup metadata matches the file bytes', () => {
    fs.mkdirSync(testDir, { recursive: true })
    const outboxPath = path.join(testDir, 'channel-sync.json.sqlite')
    const db = new DatabaseSync(outboxPath)
    try {
      db.exec('CREATE TABLE channel_sync_outbox (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO channel_sync_outbox (id, status) VALUES (\'delivery-1\', \'delivered\')')
    } finally {
      db.close()
    }
    const backup = createStorageBackup({ label: 'outbox-corrupt' })
    const backupOutbox = path.join(backup.path, 'channel-sync.json.sqlite')
    fs.writeFileSync(backupOutbox, 'not a sqlite database')
    const metadataFile = path.join(backup.path, 'metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
    const entry = metadata.files.find((file: any) => file.name === 'channel-sync.json.sqlite')
    entry.size = fs.statSync(backupOutbox).size
    entry.sha256 = createHash('sha256').update(fs.readFileSync(backupOutbox)).digest('hex')
    metadata.checksum = createHash('sha256').update(metadata.files.slice().sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))).map((file: any) => `${file.name}:${file.size}:${file.sha256}`).join('\n')).digest('hex')
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2))

    const verification = verifyStorageBackup(backup.path)

    expect(verification.ok).toBe(false)
    expect(verification.errors.join('\n')).toContain('channel-sync.json.sqlite integrity check failed')
  })

  it('includes derived sidecar files in verified backups', () => {
    writeChannelSyncCheckpoint(testDir)

    const backup = createStorageBackup({ label: 'sidecar' })
    const verification = verifyStorageBackup(backup.path)

    expect(backup.files.map(file => file.name)).toEqual(expect.arrayContaining(['gateway.db', 'channel-sync.json']))
    expect(fs.existsSync(path.join(backup.path, 'channel-sync.json'))).toBe(true)
    expect(verification).toMatchObject({ ok: true, errors: [] })
  })

  it('reports source inventory and clean storage doctor state', () => {
    createWorkTask({ title: 'Doctor source task' })
    writeChannelSyncCheckpoint(testDir)
    const backup = createStorageBackup({ label: 'doctor-clean' })

    const report = runStorageDoctor({ backupPath: backup.path, now: new Date('2026-06-13T15:00:00.000Z') })

    expect(report.status).toBe('ok')
    expect(report.sources.map(source => source.id)).toEqual(expect.arrayContaining(['gateway_db', 'channel_sync_outbox', 'channel_sync_checkpoint', 'backups']))
    expect(report.sources.find(source => source.id === 'gateway_db')).toMatchObject({ kind: 'authoritative_sqlite', required: true, backedUp: true })
    expect(report.backend).toMatchObject({
      mode: 'local_sqlite',
      releaseStatus: 'supported_public_local_beta',
      effectivePersistence: 'local_sqlite',
      hostedTeamStatus: 'unsupported_until_m25_decision',
      activation: expect.objectContaining({
        mode: 'backend_activation',
        status: 'local_sqlite_default',
        currentReleaseClaim: 'local_sqlite_public_beta',
        cutoverReadiness: 'not_selectable',
      }),
    })
    expect(report.consistency).toMatchObject({
      mode: 'm28_backend_consistency_proof',
      status: 'pass',
      runtimePosture: 'supported_local_sqlite',
      runtimeBackend: 'local_sqlite',
      effectivePersistence: 'local_sqlite',
      backup: expect.objectContaining({
        status: 'verified',
        freshness: 'current_counts_match',
        checksumPresent: true,
      }),
      rollback: expect.objectContaining({ status: 'drill_available' }),
      readModel: expect.objectContaining({
        status: 'pass',
        deterministicAfterRestart: true,
        counts: expect.objectContaining({ tasks: 1 }),
      }),
    })
    expect(report.lifecycle).toMatchObject({
      mode: 'm34_durable_state_lifecycle_audit',
      status: 'pass',
      releaseClaim: 'local_beta_lifecycle_audit_only_no_hosted_or_compliance_retention_claim',
      compaction: expect.objectContaining({ mode: 'dry_run', mutates: false }),
    })
    expect(report.consistency.contracts.map(contract => contract.domain)).toEqual(expect.arrayContaining(['work_graph', 'runs_leases', 'receipts', 'bindings']))
    expect(report.consistency.unsupportedClaims).toEqual(expect.arrayContaining(['hosted managed database', 'multi-tenant storage readiness']))
    expect(report.issues.filter(issue => issue.severity !== 'info')).toEqual([])
    expect(JSON.stringify(report)).not.toContain(testDir)
  })

  it('builds an M37 durable-state proof with ownership, backup, and lifecycle evidence', () => {
    createWorkTask({ title: 'M37 durable proof task' })
    createRoadmapSupervisor({ roadmapId: loadWorkState(workStatePath()).tasks[0]!.roadmapId, sessionId: 'ses_m37_supervisor' })
    writeChannelSyncCheckpoint(testDir)
    const backup = createStorageBackup({ label: 'm37-proof', now: new Date('2026-06-24T12:00:00.000Z') })

    const proof = buildDurableStateConsistencyProof({ backupPath: backup.path, now: new Date('2026-06-24T12:05:00.000Z') })

    expect(proof).toMatchObject({
      mode: 'durable_state_consistency',
      status: 'pass',
      releaseClaim: 'local_beta_durable_state_consistency_only_no_hosted_or_managed_storage_claim',
      scanner: expect.objectContaining({
        status: 'ok',
        criticalCount: 0,
        warningCount: 0,
        outputRedacted: true,
      }),
      backupRestore: expect.objectContaining({
        backup: expect.objectContaining({ status: 'verified', freshness: 'current_counts_match' }),
        rollback: expect.objectContaining({ status: 'drill_available' }),
        lifecycle: expect.objectContaining({ mode: 'm34_durable_state_lifecycle_audit', status: 'pass' }),
      }),
    })
    expect(proof.ownership.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gateway_db', owner: 'work-store', kind: 'authoritative_sqlite', backedUp: true }),
      expect.objectContaining({ id: 'channel_sync_outbox', owner: 'channel-sync', kind: 'transactional_sqlite', backedUp: true }),
      expect.objectContaining({ id: 'channel_sync_checkpoint', owner: 'channel-sync', backedUp: true }),
    ]))
    expect(proof.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'state_ownership_map', status: 'pass' }),
      expect.objectContaining({ id: 'consistency_scanner', status: 'pass' }),
      expect.objectContaining({ id: 'backup_restore_guard', status: 'pass' }),
      expect.objectContaining({ id: 'redacted_support_output', status: 'pass' }),
    ]))
    expect(proof.unsupportedClaims).toEqual(expect.arrayContaining(['hosted durable state readiness', 'managed backup/restore service']))
    expect(JSON.stringify(proof)).not.toContain(testDir)
  })

  it('builds an M44 durable-state integrity report with explicit inventory and repair boundaries', () => {
    createWorkTask({ title: 'M44 durable integrity task' })
    writeChannelSyncCheckpoint(testDir)
    const backup = createStorageBackup({ label: 'm44-integrity', now: new Date('2026-06-27T10:00:00.000Z') })

    const report = buildDurableStateIntegrityReport({
      backupPath: backup.path,
      now: new Date('2026-06-27T10:05:00.000Z'),
    })

    expect(report).toMatchObject({
      mode: 'durable_state_integrity',
      status: 'pass',
      releaseClaim: 'local_first_durable_state_integrity_only_no_managed_or_self_healing_claim',
      inventory: expect.objectContaining({
        requiredSourceCount: expect.any(Number),
        backedUpSourceCount: expect.any(Number),
      }),
      consistencyScan: expect.objectContaining({
        status: 'ok',
        criticalCount: 0,
        warningCount: 0,
        outputRedacted: true,
      }),
      backupRestore: expect.objectContaining({
        backup: expect.objectContaining({ status: 'verified', freshness: 'current_counts_match' }),
        rollback: expect.objectContaining({ status: 'drill_available' }),
        refusesUnsafeRestore: false,
      }),
      readOnlyDiagnostics: expect.objectContaining({
        mutatesLiveState: false,
        implicitRepairAllowed: false,
      }),
      evidencePolicy: expect.objectContaining({ redacted: true }),
    })
    expect(report.inventory.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gateway_db',
        owner: 'work-store',
        sourceOfTruth: 'gateway.db authoritative SQLite tables',
        retentionClass: 'authoritative_state',
        repairBoundary: 'restore_required',
      }),
      expect.objectContaining({
        id: 'channel_sync_checkpoint',
        owner: 'channel-sync',
        retentionClass: 'derived_sidecar',
        repairBoundary: 'operator_repair',
      }),
    ]))
    expect(report.inventory.classes.map(row => row.retentionClass)).toEqual(expect.arrayContaining([
      'authoritative_state',
      'durable_receipt',
      'bounded_event',
      'audit_ledger',
      'derived_sidecar',
      'backup_artifact',
    ]))
    expect(report.repairBoundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'inspect.storage_doctor', kind: 'inspect_only', mutatesLiveState: false }),
      expect.objectContaining({ id: 'restore.verified_backup', kind: 'restore_required', mutatesLiveState: true }),
    ]))
    expect(report.consistencyScan.representativeFixtures).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'read-only-diagnostics-do-not-repair', domain: 'read_only_diagnostic', status: 'pass', mutatesLiveState: false }),
      expect.objectContaining({ id: 'backup-restore-refusal', domain: 'backup_restore', status: 'pass', mutatesLiveState: false }),
    ]))
    expect(report.unsupportedClaims).toEqual(expect.arrayContaining([
      'managed backup/restore service',
      'self-healing repair of corrupt authoritative state',
      'multi-tenant storage isolation',
    ]))
    expect(JSON.stringify(report)).not.toContain(testDir)
  })

  it('builds an M49 local durable-state adapter report with capabilities and backup truth', () => {
    createWorkTask({ title: 'M49 adapter task' })
    writeChannelSyncCheckpoint(testDir)
    const backup = createStorageBackup({ label: 'm49-adapter', now: new Date('2026-06-29T12:00:00.000Z') })

    const report = buildLocalDurableStateAdapterReport({
      backupPath: backup.path,
      now: new Date('2026-06-29T12:05:00.000Z'),
    })

    expect(report).toMatchObject({
      mode: 'm49_local_durable_state_adapter',
      status: 'pass',
      releaseClaim: 'local_durable_state_adapter_only_no_hosted_or_managed_storage_claim',
      adapter: expect.objectContaining({
        backendMode: 'local_sqlite',
        effectivePersistence: 'local_sqlite',
      }),
      inspect: expect.objectContaining({
        mutatesLiveState: false,
        doctorStatus: 'ok',
        outputRedacted: true,
      }),
      backupRestore: expect.objectContaining({
        latestBackup: expect.objectContaining({ status: 'verified', freshness: 'current_counts_match' }),
        rollback: expect.objectContaining({ status: 'drill_available' }),
      }),
      repair: expect.objectContaining({
        implicitRepairAllowed: false,
        idempotencyKeyRequired: true,
        safetyBackupRequiredForRestore: true,
      }),
    })
    expect(report.adapter.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'inspect_state', status: 'supported', readOnly: true, mutatesLiveState: false }),
      expect.objectContaining({ id: 'restore_verified_backup', status: 'supported', requiresExplicitOperatorCall: true, mutatesLiveState: true }),
      expect.objectContaining({ id: 'hosted_multi_tenant_backend', status: 'unsupported' }),
    ]))
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'adapter_capability_matrix', status: 'pass' }),
      expect.objectContaining({ id: 'repair_requires_explicit_call', status: 'pass' }),
      expect.objectContaining({ id: 'backup_restore_round_trip_available', status: 'pass' }),
    ]))
    expect(report.unsupportedClaims).toEqual(expect.arrayContaining(['hosted durable-state readiness', 'managed backup/restore service']))
    expect(JSON.stringify(report)).not.toContain(testDir)
  })

  it('keeps M49 adapter inspect read-only for compatible checkpointed stores', () => {
    createWorkTask({ title: 'M49 compatible adapter read-only target' })
    const backup = createStorageBackup({ label: 'm49-compatible-read-only', now: new Date('2026-06-29T12:06:00.000Z') })
    const db = new DatabaseSync(workStatePath())
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
    const beforeHash = hashGatewayDbArtifacts(testDir)

    const report = buildLocalDurableStateAdapterReport({
      backupPath: backup.path,
      now: new Date('2026-06-29T12:07:00.000Z'),
    })
    const afterHash = hashGatewayDbArtifacts(testDir)

    expect(report.status).toBe('pass')
    expect(afterHash).toBe(beforeHash)
  })

  it('records idempotent M49 repair blocker receipts instead of implicit self-healing', async () => {
    createWorkTask({ title: 'M49 repair blocker target' })

    const first = await runLocalDurableStateRepair({
      operation: 'record_unsupported_repair_blocker',
      idempotencyKey: 'm49-repair-blocker',
      issueCodes: ['run_task_missing'],
      reason: 'Representative owner-specific repair requires a narrow work-store owner flow.',
      now: new Date('2026-06-29T12:15:00.000Z'),
    })
    const second = await runLocalDurableStateRepair({
      operation: 'record_unsupported_repair_blocker',
      idempotencyKey: 'm49-repair-blocker',
      issueCodes: ['different_issue'],
      reason: 'This should not replace the first receipt.',
      now: new Date('2026-06-29T12:20:00.000Z'),
    })

    expect(first).toMatchObject({
      mode: 'm49_local_durable_state_repair_receipt',
      status: 'blocked',
      mutatesLiveState: false,
      explicitOperatorCall: true,
      issueCodes: ['run_task_missing'],
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'repair_not_implemented_for_issue' })]),
    })
    expect(second).toEqual(first)
    expect(fs.existsSync(path.join(testDir, 'repair-evidence', 'm49-repair-blocker.json'))).toBe(true)
    expect(JSON.stringify(first)).not.toContain(testDir)
  })

  it('creates verified backups through the M49 repair contract idempotently', async () => {
    createWorkTask({ title: 'M49 repair backup target' })

    const receipt = await runLocalDurableStateRepair({
      operation: 'create_verified_backup',
      idempotencyKey: 'm49-create-backup',
      label: 'm49-create-backup',
      now: new Date('2026-06-29T12:25:00.000Z'),
    })
    const again = await runLocalDurableStateRepair({
      operation: 'create_verified_backup',
      idempotencyKey: 'm49-create-backup',
      label: 'm49-create-backup-retry',
      now: new Date('2026-06-29T12:26:00.000Z'),
    })

    expect(receipt).toMatchObject({
      status: 'pass',
      mutatesLiveState: false,
      backup: expect.objectContaining({ verified: true, errors: [] }),
      checks: expect.arrayContaining([expect.objectContaining({ id: 'backup_verified', status: 'pass' })]),
    })
    expect(again).toEqual(receipt)
    expect(listStorageBackups().filter(backup => backup.id.includes('m49-create-backup'))).toHaveLength(1)
  })

  it('blocks unknown M49 repair operations before restore can mutate state', async () => {
    createWorkTask({ title: 'M49 unknown repair operation target' })
    const backup = createStorageBackup({ label: 'm49-unknown-operation', now: new Date('2026-06-29T12:27:00.000Z') })
    const before = loadWorkState(workStatePath())

    const receipt = await runLocalDurableStateRepair({
      operation: 'restore_verified_backup_typo' as any,
      idempotencyKey: 'm49-unknown-repair-operation',
      backupPath: backup.path,
      maintenanceMode: true,
      now: new Date('2026-06-29T12:28:00.000Z'),
    })
    const after = loadWorkState(workStatePath())

    expect(receipt).toMatchObject({
      status: 'blocked',
      mutatesLiveState: false,
      blockers: [expect.objectContaining({ code: 'unknown_repair_operation', severity: 'critical' })],
      checks: expect.arrayContaining([expect.objectContaining({ id: 'known_repair_operation', status: 'fail' })]),
    })
    expect(after).toEqual(before)
  })

  it('creates restore safety backups from the explicit target state directory', async () => {
    createWorkTask({ title: 'M49 restore source task' })
    const sourceBackup = createStorageBackup({ label: 'm49-restore-source', now: new Date('2026-06-29T12:28:30.000Z') })
    const targetStateDir = path.join(testDir, 'm49-restore-target-state')
    const targetDbPath = path.join(targetStateDir, 'gateway.db')
    clearWorkStateForTest(targetDbPath)
    createWorkTask({ title: 'M49 restore target before' }, targetDbPath)

    const receipt = await runLocalDurableStateRepair({
      operation: 'restore_verified_backup',
      idempotencyKey: 'm49-restore-target-state',
      stateDir: targetStateDir,
      backupPath: sourceBackup.path,
      maintenanceMode: true,
      now: new Date('2026-06-29T12:29:00.000Z'),
    })
    const safetyBackups = listStorageBackups({ stateDir: targetStateDir })
    const safetyState = loadWorkState(path.join(safetyBackups[0]!.path, 'gateway.db'))
    const restoredState = loadWorkState(targetDbPath)

    expect(receipt).toMatchObject({
      status: 'pass',
      mutatesLiveState: true,
      restore: expect.objectContaining({ restoredFiles: expect.any(Number), safetyBackup: expect.stringContaining('<backup>') }),
    })
    expect(safetyBackups).toHaveLength(1)
    expect(safetyState.tasks.map(task => task.title)).toContain('M49 restore target before')
    expect(restoredState.tasks.map(task => task.title)).toContain('M49 restore source task')
  })

  it('validates an M49 local backup/restore round trip without mutating live state', async () => {
    createWorkTask({ title: 'M49 round trip source' })
    setChannelSession('telegram', 'fixture-round-trip-target', 'fixture_round_trip_session', { mode: 'chat' })
    const before = loadWorkState(workStatePath())

    const evidence = await validateLocalDurableStateBackupRoundTrip({
      label: 'm49-round-trip',
      now: new Date('2026-06-29T12:30:00.000Z'),
    })
    const after = loadWorkState(workStatePath())

    expect(evidence).toMatchObject({
      mode: 'm49_local_durable_state_backup_round_trip',
      status: 'pass',
      backup: expect.objectContaining({
        verification: expect.objectContaining({ ok: true, errors: [], path: expect.stringContaining('<backup>') }),
      }),
      recoveryDrill: expect.objectContaining({ status: 'pass', failedChecks: 0 }),
    })
    expect(evidence.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'backup_verified', status: 'pass' }),
      expect.objectContaining({ id: 'isolated_recovery_drill', status: 'pass' }),
    ]))
    expect(after).toEqual(before)
    expect(JSON.stringify(evidence)).not.toContain(testDir)
  })

  it('keeps M49 backup round-trip artifacts inside an explicit state directory', async () => {
    const stateDir = path.join(testDir, 'm49-round-trip-explicit-state')
    const dbPath = path.join(stateDir, 'gateway.db')
    clearWorkStateForTest(dbPath)
    createWorkTask({ title: 'M49 explicit state round trip source' }, dbPath)
    const defaultRecoveryDir = path.join(testDir, 'recovery-drills')
    for (let index = 0; index < 21; index++) {
      const sentinelDir = path.join(defaultRecoveryDir, `recovery-drill-20260601T0000${String(index).padStart(2, '0')}Z-default-sentinel`)
      fs.mkdirSync(sentinelDir, { recursive: true })
      fs.writeFileSync(path.join(sentinelDir, 'evidence.json'), JSON.stringify({ id: path.basename(sentinelDir), status: 'pass' }))
    }
    const defaultSentinelPath = path.join(defaultRecoveryDir, 'recovery-drill-20260601T000000Z-default-sentinel', 'evidence.json')

    const evidence = await validateLocalDurableStateBackupRoundTrip({
      stateDir,
      label: 'm49-explicit-state-round-trip',
      now: new Date('2026-06-29T12:31:00.000Z'),
    })
    const expectedEvidencePath = path.join(stateDir, 'recovery-drills', 'recovery-drill-20260629T123100Z-m49-explicit-state-round-trip', 'evidence.json')
    const defaultEvidencePath = path.join(testDir, 'recovery-drills', 'recovery-drill-20260629T123100Z-m49-explicit-state-round-trip', 'evidence.json')

    expect(evidence.status).toBe('pass')
    expect(fs.existsSync(expectedEvidencePath)).toBe(true)
    expect(fs.existsSync(defaultEvidencePath)).toBe(false)
    expect(fs.existsSync(defaultSentinelPath)).toBe(true)
    expect(JSON.stringify(evidence)).not.toContain(stateDir)
  })

  it('reports M44 durable-state drift without mutating live diagnostic state', () => {
    const task = createWorkTask({ title: 'M44 durable drift target' })
    const now = '2026-06-27T10:10:00.000Z'
    const db = new DatabaseSync(workStatePath())
    try {
      db.prepare('UPDATE tasks SET status = ?, current_run_id = ? WHERE id = ?').run('running', 'run_missing_projection', task.id)
      db.prepare(`INSERT INTO runs (
        id, task_id, stage, session_id, profile, status, attempt, started_at, lease_owner, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('run_orphan', 'task_missing', 'implement', 'ses_orphan', 'implementer', 'running', 1, now, '', '2026-06-27T10:00:00.000Z')
      db.prepare(`INSERT INTO task_dispatch_receipts (
        id, task_id, stage, idempotency_key, lease_owner, lease_expires_at, status, run_id, session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('dispatch_orphan', 'task_missing', 'implement', 'dispatch-key', 'worker', '2026-06-27T10:00:00.000Z', 'started', 'run_missing', 'ses_dispatch', now, now)
      db.prepare(`INSERT INTO delegation_progress_receipts (
        progress_key, idempotency_key, progress, subject_id, event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('progress_orphan', 'delegation_missing', 'completed', task.id, 999, now)
      db.prepare(`INSERT INTO channel_bindings (
        provider, chat_id, thread_id, session_id, mode, roadmap_id, task_id, title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('telegram', 'raw-chat-should-not-leak', '', 'ses_binding', 'task', task.roadmapId, 'task_missing', 'Bad binding', now, now)
    } finally {
      db.close()
    }
    const before = {
      tasks: countRows('tasks'),
      runs: countRows('runs'),
      receipts: countRows('task_dispatch_receipts'),
      progressReceipts: countRows('delegation_progress_receipts'),
      channelBindings: countRows('channel_bindings'),
    }

    const report = buildDurableStateIntegrityReport({ now: new Date('2026-06-27T10:11:00.000Z') })

    expect(report.status).toBe('fail')
    expect(report.consistencyScan.detectedIssueCodes).toEqual(expect.arrayContaining([
      'run_task_missing',
      'task_current_run_missing',
      'dispatch_receipt_task_missing',
      'progress_receipt_delegation_missing',
      'progress_receipt_event_missing',
      'channel_binding_task_missing',
    ]))
    expect(report.consistencyScan.representativeFixtures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'orphaned-runs-and-projections',
        status: 'fail',
        detectedIssueCodes: expect.arrayContaining(['run_task_missing', 'task_current_run_missing', 'dispatch_receipt_task_missing']),
        mutatesLiveState: false,
      }),
      expect.objectContaining({
        id: 'receipt-reference-and-event-drift',
        status: 'warn',
        detectedIssueCodes: expect.arrayContaining(['progress_receipt_event_missing']),
        mutatesLiveState: false,
      }),
    ]))
    expect(report.readOnlyDiagnostics).toMatchObject({
      mutatesLiveState: false,
      implicitRepairAllowed: false,
    })
    expect(report.repairBoundaries.find(row => row.id === 'inspect.storage_doctor')).toMatchObject({ mutatesLiveState: false })
    expect(report.repairBoundaries.find(row => row.id === 'repair.operator_reference_refresh')).toMatchObject({ mutatesLiveState: true })
    expect({
      tasks: countRows('tasks'),
      runs: countRows('runs'),
      receipts: countRows('task_dispatch_receipts'),
      progressReceipts: countRows('delegation_progress_receipts'),
      channelBindings: countRows('channel_bindings'),
    }).toEqual(before)
    expect(JSON.stringify(report)).not.toContain('raw-chat-should-not-leak')
    expect(JSON.stringify(report)).not.toContain('ses_binding')
    expect(JSON.stringify(report)).not.toContain('"task_missing"')
  })

  it('marks unsafe M44 backup and restore evidence as refused before repair claims', () => {
    createWorkTask({ title: 'M44 unsafe backup target' })
    const backup = createStorageBackup({ label: 'm44-unsafe' })
    fs.rmSync(path.join(backup.path, 'gateway.db'))

    const report = buildDurableStateIntegrityReport({
      backupPath: backup.path,
      now: new Date('2026-06-27T10:15:00.000Z'),
    })

    expect(report.status).toBe('fail')
    expect(report.backupRestore).toMatchObject({
      backup: expect.objectContaining({ status: 'failed' }),
      refusesUnsafeRestore: true,
    })
    expect(report.backupRestore.verificationErrors.join('\n')).toContain('gateway.db is missing')
    expect(report.consistencyScan.representativeFixtures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'backup-restore-refusal',
        status: 'fail',
        mutatesLiveState: false,
        evidence: expect.objectContaining({ errorCount: expect.any(Number) }),
      }),
    ]))
    expect(report.repairBoundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'restore.verified_backup',
        allowedWhen: expect.stringContaining('verified compatible backup'),
        forbiddenIn: expect.arrayContaining(['failed backup verification', 'read-only diagnostics']),
      }),
    ]))
  })

  it('describes the supported backend mode and hosted/team caveats without changing persistence', () => {
    const posture = describeStorageBackend({ stateDir: testDir })

    expect(posture).toMatchObject({
      mode: 'local_sqlite',
      transactionalAuthority: 'gateway_db',
      effectivePersistence: 'local_sqlite',
      authoritativeSources: expect.arrayContaining(['gateway_db', 'channel_sync_outbox']),
      sidecarSources: expect.arrayContaining(['channel_sync_checkpoint']),
      activation: expect.objectContaining({
        status: 'local_sqlite_default',
        runtimeBackend: 'local_sqlite',
        supportedDefault: 'local_sqlite',
        effectivePersistence: 'local_sqlite',
        cutoverReadiness: 'not_selectable',
        rollbackReadiness: 'drill_available_requires_verified_backup',
        consistencyScan: 'storage_doctor_available',
        supportedCommands: expect.arrayContaining([
          expect.objectContaining({ id: 'status', command: 'opencode-gateway backend status --json', safeByDefault: true }),
          expect.objectContaining({ id: 'rollback_dry_run', safeByDefault: true }),
        ]),
        unsupportedModes: expect.arrayContaining(['hosted managed database service', 'multi-tenant data isolation']),
      }),
    })
    expect(posture.caveats.join('\n')).toContain('Local SQLite is the only supported durable backend')
    expect(JSON.stringify(posture)).not.toContain(testDir)
  })


  it('detects corrupt JSON artifacts', () => {
    createWorkTask({ title: 'Doctor drift target' })
    fs.writeFileSync(path.join(testDir, 'events.json'), '{"broken"', { mode: 0o600 })

    const report = runStorageDoctor({ now: new Date('2026-06-13T15:05:00.000Z') })

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'json_artifact_corrupt', severity: 'warning', sourceId: 'events_sidecar' }),
    ]))
  })

  it('detects backend consistency drift across runs, leases, receipts, events, and projections', () => {
    const task = createWorkTask({ title: 'Consistency drift target' })
    const now = '2026-06-13T15:07:00.000Z'
    const db = new DatabaseSync(workStatePath())
    try {
      db.prepare('UPDATE tasks SET status = ?, current_run_id = ? WHERE id = ?').run('running', 'run_missing_projection', task.id)
      db.prepare(`INSERT INTO runs (
        id, task_id, stage, session_id, profile, status, attempt, started_at, lease_owner, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('run_orphan', 'task_missing', 'implement', 'ses_orphan', 'implementer', 'running', 1, now, '', '2026-06-13T15:00:00.000Z')
      db.prepare(`INSERT INTO task_dispatch_receipts (
        id, task_id, stage, idempotency_key, lease_owner, lease_expires_at, status, run_id, session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('dispatch_orphan', 'task_missing', 'implement', 'dispatch-key', 'worker', '2026-06-13T15:00:00.000Z', 'started', 'run_missing', 'ses_dispatch', now, now)
      db.prepare(`INSERT INTO delegation_progress_receipts (
        progress_key, idempotency_key, progress, subject_id, event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('progress_orphan', 'delegation_missing', 'completed', task.id, 999, now)
      db.prepare(`INSERT INTO delegation_progress_route_receipts (
        dedupe_key, progress_key, idempotency_key, progress, target_key, provider, session_id, delivery, state,
        reason, error, deferred_until, suppressed_until, progress_event_id, attempt_count, last_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('route_orphan', 'progress_missing', 'delegation_missing', 'completed', null, null, null, 'session', 'delivered', null, null, null, null, 999, 1, 999, now, now)
      db.prepare(`INSERT INTO channel_bindings (
        provider, chat_id, thread_id, session_id, mode, roadmap_id, task_id, title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('telegram', 'raw-chat-should-not-leak', '', 'ses_binding', 'task', task.roadmapId, 'task_missing', 'Bad binding', now, now)
      db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run('', task.id, '{"broken"', 'not-a-date')
    } finally {
      db.close()
    }

    const report = runStorageDoctor({ now: new Date('2026-06-13T15:08:00.000Z') })

    expect(report.status).toBe('down')
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'run_task_missing', severity: 'critical' }),
      expect.objectContaining({ code: 'run_lease_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'task_current_run_missing', severity: 'critical' }),
      expect.objectContaining({ code: 'dispatch_receipt_task_missing', severity: 'critical' }),
      expect.objectContaining({ code: 'dispatch_receipt_run_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'progress_receipt_delegation_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'progress_receipt_event_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'progress_route_receipt_delegation_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'progress_route_receipt_progress_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'progress_route_receipt_event_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'progress_route_receipt_session_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'channel_binding_task_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'event_type_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'event_timestamp_invalid', severity: 'warning' }),
      expect.objectContaining({ code: 'event_payload_unreadable', severity: 'warning' }),
    ]))
    expect(report.consistency).toMatchObject({
      status: 'fail',
      runtimePosture: 'degraded_backend',
      consistencyScan: expect.objectContaining({
        status: 'down',
        criticalCount: expect.any(Number),
        warningCount: expect.any(Number),
      }),
      readModel: expect.objectContaining({ status: 'fail', deterministicAfterRestart: false }),
    })
    expect(report.consistency.blockedStates.map(row => row.code)).toEqual(expect.arrayContaining(['run_task_missing', 'task_current_run_missing', 'dispatch_receipt_task_missing']))
    expect(JSON.stringify(report)).not.toContain('raw-chat-should-not-leak')
  })

  it('detects stale channel and project session bindings when the session sidecar is present', () => {
    const task = createWorkTask({ title: 'Stale session binding target' })
    upsertProjectBinding({ alias: 'stale-session-project', roadmapId: task.roadmapId, sessionId: 'ses_project_missing' })
    setChannelSession('telegram', 'raw-chat-should-not-leak', 'ses_channel_missing', { mode: 'task', taskId: task.id })
    fs.writeFileSync(path.join(testDir, 'sessions.json'), JSON.stringify({
      savedAt: '2026-06-24T12:10:00.000Z',
      sessions: [{
        id: 'ses_live',
        title: 'GW: live session',
        parentId: 'parent',
        status: 'running',
        startedAt: '2026-06-24T12:00:00.000Z',
        lastCheck: '2026-06-24T12:10:00.000Z',
        lastTodo: null,
        lastMessage: null,
      }],
    }, null, 2), { mode: 0o600 })

    const report = runStorageDoctor({ now: new Date('2026-06-24T12:15:00.000Z') })
    const proof = buildDurableStateConsistencyProof({ now: new Date('2026-06-24T12:15:00.000Z') })

    expect(report.status).toBe('degraded')
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'channel_binding_session_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'project_binding_session_missing', severity: 'warning' }),
    ]))
    expect(proof.status).toBe('warn')
    expect(proof.scanner.staleBindingIssueCodes).toEqual(expect.arrayContaining(['channel_binding_session_missing', 'project_binding_session_missing']))
    expect(proof.safeNextActions.join('\n')).toContain('rebind the trusted channel')
    expect(JSON.stringify(report)).not.toContain('raw-chat-should-not-leak')
    expect(JSON.stringify(report)).not.toContain('ses_channel_missing')
    expect(JSON.stringify(proof)).not.toContain('raw-chat-should-not-leak')
    expect(JSON.stringify(proof)).not.toContain('ses_project_missing')
  })

  it('runs lifecycle audit with a non-mutating compaction dry-run', () => {
    const task = createWorkTask({ title: 'Lifecycle dry-run target' })
    const db = new DatabaseSync(workStatePath())
    try {
      const insert = db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
      insert.run('noise.old', task.id, '{"ok":true}', '2026-01-01T00:00:00.000Z')
      insert.run('delegation.progress', task.id, '{"progress":"completed"}', '2026-01-01T00:00:00.000Z')
    } finally {
      db.close()
    }
    const before = countRows('events')

    const report = runStorageLifecycleAudit({ now: new Date('2026-06-24T10:00:00.000Z') })
    const after = countRows('events')

    expect(report).toMatchObject({
      mode: 'm34_durable_state_lifecycle_audit',
      status: 'pass',
      releaseClaim: 'local_beta_lifecycle_audit_only_no_hosted_or_compliance_retention_claim',
      compaction: expect.objectContaining({
        mode: 'dry_run',
        mutates: false,
        prunableEvents: 1,
        totalEvents: before,
      }),
    })
    expect(after).toBe(before)
    expect(report.compaction.affectedTypes).toEqual([
      expect.objectContaining({ type: 'noise.old', rows: 1, olderThanRetention: 1 }),
    ])
    expect(report.compaction.durableEventTypes).toContain('delegation.progress')
    expect(report.classes.map(row => row.retentionClass)).toEqual(expect.arrayContaining(['authoritative_state', 'durable_receipt', 'bounded_event', 'audit_ledger', 'derived_sidecar', 'backup_artifact']))
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'compaction_dry_run', status: 'pass', repairability: 'none' }),
      expect.objectContaining({ name: 'event_payloads_parse', status: 'pass' }),
    ]))
    expect(report.unsupportedClaims).toEqual(expect.arrayContaining(['multi-tenant retention or legal-hold compliance', 'managed backup/restore service']))
    expect(JSON.stringify(report)).not.toContain(testDir)
  })

  it('classifies durable receipt event-reference drift as operator-repairable', () => {
    const task = createWorkTask({ title: 'Lifecycle receipt drift target' })
    const now = '2026-06-24T10:05:00.000Z'
    const db = new DatabaseSync(workStatePath())
    try {
      db.prepare(`INSERT INTO delegation_receipts (
        idempotency_key, target_type, task_ids_json, roadmap_id, supervisor_id, project_binding_id,
        parent_session_id, links_json, next_scheduler_action, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('lifecycle-delegation', 'project', JSON.stringify([task.id]), task.roadmapId, null, null, 'ses_parent', '{}', 'none', now, now)
      db.prepare(`INSERT INTO delegation_progress_receipts (
        progress_key, idempotency_key, progress, subject_id, event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('progress-drift', 'lifecycle-delegation', 'completed', task.id, 999999, now)
    } finally {
      db.close()
    }

    const report = runStorageLifecycleAudit({ now: new Date('2026-06-24T10:06:00.000Z') })

    expect(report.status).toBe('warn')
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'progress_receipt_event_refs',
        status: 'warn',
        repairability: 'operator',
      }),
    ]))
    expect(report.classes.find(row => row.retentionClass === 'durable_receipt')).toMatchObject({ status: 'warn' })
    expect(report.repairPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'progress_receipt_event_refs',
        severity: 'warn',
        action: expect.stringContaining('durable receipts/read models authoritative'),
      }),
    ]))
    expect(JSON.stringify(report)).not.toContain(testDir)
  })

  it('fails lifecycle audit when durable delegation receipts reference missing tasks', () => {
    createWorkTask({ title: 'Lifecycle missing task target' })
    const now = '2026-06-24T10:10:00.000Z'
    const db = new DatabaseSync(workStatePath())
    try {
      db.prepare(`INSERT INTO delegation_receipts (
        idempotency_key, target_type, task_ids_json, roadmap_id, supervisor_id, project_binding_id,
        parent_session_id, links_json, next_scheduler_action, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('lifecycle-missing-task', 'project', JSON.stringify(['task_missing']), null, null, null, 'ses_parent', '{}', 'none', now, now)
    } finally {
      db.close()
    }

    const report = runStorageLifecycleAudit({ now: new Date('2026-06-24T10:11:00.000Z') })

    expect(report.status).toBe('fail')
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'delegation_receipt_task_refs',
        status: 'fail',
        repairability: 'restore_required',
      }),
    ]))
    expect(report.repairPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'delegation_receipt_task_refs',
        severity: 'fail',
        action: expect.stringContaining('restore from the latest verified backup'),
      }),
    ]))
    expect(JSON.stringify(report)).not.toContain('task_missing')
  })

  it('detects channel sync checkpoint and outbox mismatches', () => {
    createWorkTask({ title: 'Doctor channel target' })
    fs.writeFileSync(path.join(testDir, 'channel-sync.json'), JSON.stringify({
      savedAt: '2026-06-13T15:10:00.000Z',
      deliveries: {
        'ses_other:telegram:chat-other:': {
          sessionId: 'ses_other',
          provider: 'telegram',
          chatId: 'chat-other',
          initializedAt: '2026-06-13T15:10:00.000Z',
          updatedAt: '2026-06-13T15:10:00.000Z',
          lastMessageCreated: 0,
          lastMessageCreatedIds: [],
          seenMessageIds: [],
        },
      },
      pendingInbound: [],
    }, null, 2), { mode: 0o600 })
    const outboxPath = path.join(testDir, 'channel-sync.json.sqlite')
    const db = new DatabaseSync(outboxPath)
    try {
      db.exec(`
        CREATE TABLE channel_sync_outbox (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          thread_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      db.prepare("INSERT INTO channel_sync_outbox (id, session_id, provider, chat_id, thread_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run('delivery-1', 'ses_missing', 'telegram', 'chat-1', '', 'pending', '2026-06-13T15:10:00.000Z')
    } finally {
      db.close()
    }

    const report = runStorageDoctor()

    expect(report.status).toBe('degraded')
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'channel_outbox_checkpoint_mismatch', severity: 'warning', sourceId: 'channel_sync_outbox' }),
    ]))
  })

  it('detects backups missing migrated sidecar state', () => {
    createWorkTask({ title: 'Backup migration target' })
    const oldBackup = createStorageBackup({ label: 'before-sidecar' })
    writeChannelSyncCheckpoint(testDir)

    const staleReport = runStorageDoctor({ backupPath: oldBackup.path })
    expect(staleReport.status).toBe('degraded')
    expect(staleReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'backup_missing_source', sourceId: 'backups', severity: 'warning' }),
    ]))

    const freshBackup = createStorageBackup({ label: 'after-sidecar' })
    const freshReport = runStorageDoctor({ backupPath: freshBackup.path })
    expect(freshReport.issues.filter(issue => issue.code === 'backup_missing_source')).toEqual([])
  })

  it('detects corrupt or incomplete backups', () => {
    createWorkTask({ title: 'Corruption target' })
    const backup = createStorageBackup()
    fs.rmSync(path.join(backup.path, 'gateway.db'))

    const verification = verifyStorageBackup(backup.path)

    expect(verification.ok).toBe(false)
    expect(verification.errors.join('\n')).toContain('gateway.db is missing')
  })

  it('detects metadata counts that do not match the copied gateway database', () => {
    createWorkTask({ title: 'Count mismatch target' })
    const backup = createStorageBackup()
    const metadataFile = path.join(backup.path, 'metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
    metadata.counts.tasks += 1
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2))

    const verification = verifyStorageBackup(backup.path)

    expect(verification.ok).toBe(false)
    expect(verification.errors).toContain('metadata counts do not match gateway.db contents')
  })

  it('refuses backup directories with unmanifested unsafe or transient files', async () => {
    createWorkTask({ title: 'Unsafe extra file target' })
    const backup = createStorageBackup()
    fs.writeFileSync(path.join(backup.path, 'config.json'), '{"token":"secret"}')
    fs.writeFileSync(path.join(backup.path, 'gateway.db-wal'), 'stale wal')

    const verification = verifyStorageBackup(backup.path)

    expect(verification.ok).toBe(false)
    expect(verification.errors).toEqual(expect.arrayContaining([
      'unexpected file in backup directory: config.json',
      'unexpected file in backup directory: gateway.db-wal',
    ]))
    await expect(runStorageRecoveryDrill({ backupPath: backup.path, label: 'unsafe-extra' })).rejects.toThrow('recovery drill refused backup')
  })

  it('refuses backups with a missing checksum before restore', async () => {
    createWorkTask({ title: 'Manifest target' })
    const backup = createStorageBackup()
    expect(backup.version).toBe(1)
    const metadataFile = path.join(backup.path, 'metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
    delete metadata.checksum
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2))

    const verification = verifyStorageBackup(backup.path)

    expect(verification.ok).toBe(false)
    expect(verification.errors.join('\n')).toContain('metadata checksum is missing or invalid')
    await expect(restoreStorageBackup(backup.path, { maintenanceMode: true, skipSafetyBackup: true })).rejects.toThrow('backup verification failed')
  })

  it('refuses malformed files and counts metadata without throwing', async () => {
    createWorkTask({ title: 'Malformed manifest target' })
    const backup = createStorageBackup()
    const metadataFile = path.join(backup.path, 'metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
    metadata.files = { gateway: 'gateway.db' }
    metadata.counts = { tasks: 1 }
    metadata.checksum = 'not-the-manifest-checksum'
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2))

    const verification = verifyStorageBackup(backup.path)

    expect(verification.ok).toBe(false)
    expect(verification.errors).toEqual(expect.arrayContaining([
      'metadata files must be an array',
      'gateway.db is missing from backup metadata',
      'metadata counts.roadmaps is missing or invalid',
      'metadata counts.events is missing or invalid',
    ]))
    await expect(restoreStorageBackup(backup.path, { maintenanceMode: true, skipSafetyBackup: true })).rejects.toThrow('backup verification failed')

    const missingCountsBackup = createStorageBackup()
    const missingCountsMetadataFile = path.join(missingCountsBackup.path, 'metadata.json')
    const missingCountsMetadata = JSON.parse(fs.readFileSync(missingCountsMetadataFile, 'utf-8'))
    delete missingCountsMetadata.counts
    fs.writeFileSync(missingCountsMetadataFile, JSON.stringify(missingCountsMetadata, null, 2))

    const missingCounts = verifyStorageBackup(missingCountsBackup.path)
    expect(missingCounts.ok).toBe(false)
    expect(missingCounts.errors.join('\n')).toContain('metadata counts is missing or invalid')
    await expect(runStorageRecoveryDrill({ backupPath: missingCountsBackup.path, label: 'missing-counts' })).rejects.toThrow('recovery drill refused backup')
  })

  it('refuses malformed file manifest entries without throwing during checksum validation', () => {
    createWorkTask({ title: 'Malformed file entries target' })
    const backup = createStorageBackup()
    const metadataFile = path.join(backup.path, 'metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
    metadata.files = [
      ...metadata.files,
      null,
      {},
      { name: 'events.json', size: 'large', sha256: null },
    ]
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2))

    const verification = verifyStorageBackup(backup.path)

    expect(verification.ok).toBe(false)
    expect(verification.errors).toEqual(expect.arrayContaining([
      'backup metadata contains an invalid file entry',
      'backup metadata contains an invalid file name',
      'events.json size is missing or invalid',
    ]))
  })

  it('rejects backup metadata that tries to restore outside the Gateway state directory', async () => {
    createWorkTask({ title: 'Traversal target' })
    const backup = createStorageBackup()
    const metadataFile = path.join(backup.path, 'metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
    metadata.files = [{ name: '../outside.txt', size: 0, sha256: 'x' }]
    metadata.checksum = 'x'
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2))

    const verification = verifyStorageBackup(backup.path)

    expect(verification.ok).toBe(false)
    expect(verification.errors.join('\n')).toContain('simple basename')
    await expect(restoreStorageBackup(backup.path, { maintenanceMode: true, skipSafetyBackup: true })).rejects.toThrow('backup verification failed')
  })

  it('restores a verified backup and refuses active-daemon restore without maintenance mode', async () => {
    createWorkTask({ title: 'Before backup' })
    const backup = createStorageBackup()
    createWorkTask({ title: 'After backup' })
    expect(loadWorkState(workStatePath()).tasks.map(task => task.title)).toContain('After backup')
    fs.writeFileSync(path.join(testDir, 'sessions.json'), '{}')
    fs.writeFileSync(`${workStatePath()}-wal`, 'stale')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await expect(restoreStorageBackup(backup.path, { skipSafetyBackup: true })).rejects.toThrow('restore refused')

    const restored = await restoreStorageBackup(backup.path, { maintenanceMode: true, skipSafetyBackup: true })

    expect(restored.restored.some(file => file.endsWith('gateway.db'))).toBe(true)
    expect(fs.existsSync(path.join(testDir, 'sessions.json'))).toBe(false)
    expect(fs.existsSync(`${workStatePath()}-wal`)).toBe(false)
    expect(fs.readdirSync(testDir).some(name => name.startsWith('.restore-stage-'))).toBe(false)
    expect(loadWorkState(workStatePath()).tasks.map(task => task.title)).toEqual(['Before backup'])
  })

  it('exports durable state for audit or machine transfer', () => {
    createWorkTask({ title: 'Export me' })

    const exported = exportGatewayState() as any

    expect(exported.state.tasks[0].title).toBe('Export me')
    expect(exported.schema).toBeUndefined()
  })

  it('runs a recovery drill in an isolated restore path and records evidence', async () => {
    createWorkTask({ title: 'Drill source task' })
    setChannelSession('telegram', 'chat-drill-source', 'ses_drill_source', { mode: 'chat' })
    const backup = createStorageBackup({ label: 'drill-source', now: new Date('2026-06-13T13:00:00.000Z') })

    const evidence = await runStorageRecoveryDrill({
      backupPath: backup.path,
      label: 'test',
      now: new Date('2026-06-13T13:05:00.000Z'),
    })

    expect(evidence.status).toBe('pass')
    expect(evidence.backup.path).toBe(backup.path)
    expect(evidence.restore?.stateDir).toContain(path.join(testDir, 'recovery-drills', 'recovery-drill-20260613T130500Z-test', 'restored-state'))
    expect(evidence.restore?.counts.tasks).toBe(1)
    expect(evidence.drill?.expiredLease).toMatchObject({ recovered: 0, blocked: 1 })
    expect(evidence.drill?.orphanedRun.recovered).toBe(1)
    expect(evidence.drill?.channelBindings).toBe(1)
    expect(evidence.drill?.events).toEqual(expect.arrayContaining(['task.run.lease_expired', 'task.run.orphan_recovered', 'channel.binding.upserted']))
    expect(evidence.storageDoctor).toMatchObject({ status: 'ok' })
    expect(evidence.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'storage-doctor', status: 'pass' })]))
    expect(fs.existsSync(evidence.evidencePath)).toBe(true)
    expect(fs.existsSync(evidence.reportPath)).toBe(true)
    expect(listStorageRecoveryDrills()).toEqual(expect.arrayContaining([expect.objectContaining({
      id: evidence.id,
      status: 'pass',
      evidencePath: evidence.evidencePath,
      checks: expect.objectContaining({ failed: 0 }),
    })]))
    expect(loadWorkState(workStatePath()).tasks.map(task => task.title)).toEqual(['Drill source task'])
  })

  it('keeps live state environment and writes isolated drill mutations to the restored path', async () => {
    createWorkTask({ title: 'Live source task' })
    const backup = createStorageBackup({ label: 'env-safe-drill', now: new Date('2026-06-13T14:00:00.000Z') })
    const originalStateDir = process.env['OPENCODE_GATEWAY_STATE_DIR']
    const originalConfigDir = process.env['OPENCODE_GATEWAY_CONFIG_DIR']

    const pending = runStorageRecoveryDrill({
      backupPath: backup.path,
      label: 'env-safe',
      now: new Date('2026-06-13T14:05:00.000Z'),
    })

    expect(process.env['OPENCODE_GATEWAY_STATE_DIR']).toBe(originalStateDir)
    expect(process.env['OPENCODE_GATEWAY_CONFIG_DIR']).toBe(originalConfigDir)
    createWorkTask({ title: 'Concurrent live task' })

    const evidence = await pending
    const liveTitles = loadWorkState(workStatePath()).tasks.map(task => task.title)
    const restoredTitles = loadWorkState(path.join(evidence.restore!.stateDir, 'gateway.db')).tasks.map(task => task.title)

    expect(process.env['OPENCODE_GATEWAY_STATE_DIR']).toBe(originalStateDir)
    expect(liveTitles).toEqual(expect.arrayContaining(['Live source task', 'Concurrent live task']))
    expect(restoredTitles).toEqual(expect.arrayContaining(['Live source task', `Recovery drill expired lease ${evidence.id}`, `Recovery drill orphaned run ${evidence.id}`]))
    expect(restoredTitles).not.toContain('Concurrent live task')
  })




  it('records a backend rollback receipt only after restore, doctor, and recovery drill pass', async () => {
    createWorkTask({ title: 'Rollback source task' })
    const backup = createStorageBackup({ label: 'rollback-source', now: new Date('2026-06-13T16:20:00.000Z') })

    const receipt = await runBackendRollbackDrill({
      backupPath: backup.path,
      label: 'test-rollback',
      now: new Date('2026-06-13T16:25:00.000Z'),
    })

    expect(receipt.status).toBe('pass')
    expect(receipt.backup).toMatchObject({ id: backup.id, verification: expect.objectContaining({ ok: true }) })
    expect(receipt.restore?.counts.tasks).toBe(1)
    expect(receipt.storageDoctor).toMatchObject({ status: 'ok' })
    expect(receipt.recoveryDrill).toMatchObject({ status: 'pass' })
    expect(receipt.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'rollback-restore-counts', status: 'pass' }),
      expect.objectContaining({ name: 'rollback-storage-doctor', status: 'pass' }),
      expect.objectContaining({ name: 'rollback-recovery-drill', status: 'pass' }),
    ]))
    expect(fs.existsSync(receipt.evidencePath)).toBe(true)
    expect(fs.existsSync(receipt.reportPath)).toBe(true)
  })
})

function writeChannelSyncCheckpoint(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true })
  const checkpointPath = path.join(stateDir, 'channel-sync.json')
  fs.writeFileSync(checkpointPath, JSON.stringify({ schemaVersion: 1, deliveries: {}, pendingInbound: [] }, null, 2) + '\n', { mode: 0o600 })
  expect(fs.existsSync(checkpointPath)).toBe(true)
}

function countRows(table: string): number {
  const db = new DatabaseSync(workStatePath())
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as any).count || 0)
  } finally {
    db.close()
  }
}
