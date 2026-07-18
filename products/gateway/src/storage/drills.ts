import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  appendWorkEvent,
  createWorkTask,
  startWorkTaskRun,
  recoverExpiredWorkLeases,
  recoverOrphanedWorkRuns,
  upsertChannelBinding,
  listChannelBindings,
  loadWorkState,
  listWorkEvents,
} from '../work-store.js'
import {
  RECOVERY_DRILL_RETENTION,
  BACKUP_FILE_NAMES,
  storageStateDir,
  storageRecoveryDrillDir,
  storageBackendDrillDir,
  storageCountsForDb,
  storageTableCountForDb,
  recoveryDrillId,
  countsMatchBackup,
  summarizeRecoveryDrillEvidence,
} from './internal.js'
import { createStorageBackup, verifyStorageBackup } from './backup.js'
import { restoreStorageBackupToStateDir } from './restore.js'
import { runStorageDoctor, sanitizeStorageDoctorForMigrationEvidence } from './doctor.js'
import type {
  StorageRecoveryDrillSummary,
  StorageRecoveryDrillEvidence,
  StorageRecoveryDrillCheck,
  StorageBackupSummary,
  StorageBackupMetadata,
  StorageDoctorReport,
  BackendRollbackReceipt,
} from './types.js'

export function listStorageRecoveryDrills(options: { limit?: number } = {}): StorageRecoveryDrillSummary[] {
  const dir = storageRecoveryDrillDir()
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 10)))
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(candidate => fs.existsSync(path.join(candidate, 'evidence.json')))
    .map(candidate => summarizeRecoveryDrillEvidence(candidate))
    .filter((summary): summary is StorageRecoveryDrillSummary => Boolean(summary))
    .sort((a, b) => Date.parse(b.completedAt || b.startedAt) - Date.parse(a.completedAt || a.startedAt))
    .slice(0, limit)
}
export async function runStorageRecoveryDrill(options: { backupPath?: string; label?: string; outputDir?: string; retryLimit?: number; now?: Date; stateDir?: string } = {}): Promise<StorageRecoveryDrillEvidence> {
  const started = options.now || new Date()
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  const id = recoveryDrillId(started, options.label)
  const evidenceDir = path.resolve(options.outputDir || path.join(stateDir, 'recovery-drills', id))
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const checks: StorageRecoveryDrillCheck[] = []
  let createdBackup: StorageBackupSummary | undefined
  let backupPath = options.backupPath

  if (!backupPath) {
    createdBackup = createStorageBackup({ label: options.label || 'recovery-drill', now: started, stateDir })
    backupPath = createdBackup.path
  }

  const verification = verifyStorageBackup(backupPath)
  checks.push(check(
    'backup-manifest',
    verification.ok,
    verification.ok ? 'Backup manifest, file checksums, and SQLite integrity verified.' : `Backup verification failed: ${verification.errors.join('; ')}`,
    { errors: verification.errors },
  ))
  checks.push(check(
    'backup-scope',
    verification.ok && backupContainsOnlyAllowedFiles(verification.metadata),
    'Backup includes only Gateway durable state files and sidecars; config, pid files, WAL/SHM files, logs, and secrets are excluded.',
    { files: metadataFileNames(verification.metadata) },
  ))

  if (!verification.ok) {
    const failed = finalizeDrillEvidence({
      id,
      status: 'fail',
      startedAt: started.toISOString(),
      evidenceDir,
      backup: { path: verification.path, id: verification.metadata?.id || createdBackup?.id, created: Boolean(createdBackup), verification },
      checks,
    })
    throw new Error(`recovery drill refused backup: ${verification.errors.join('; ')}; evidence: ${failed.evidencePath}`)
  }

  const restoreDir = path.join(evidenceDir, 'restored-state')
  const retryLimit = Math.max(1, Math.min(10, options.retryLimit ?? 1))
  const restoreDbPath = path.join(restoreDir, 'gateway.db')
  const restore = await restoreStorageBackupToStateDir(verification.path, restoreDir, { maintenanceMode: true, skipSafetyBackup: true })
  const restoredDoctor = runStorageDoctor({ stateDir: restoreDir, backupPath: verification.path, now: started })
  checks.push(check('storage-doctor', restoredDoctor.status === 'ok', restoredDoctor.status === 'ok' ? 'Restored storage sources are consistent.' : `Restored storage doctor reported ${restoredDoctor.status}.`, { status: restoredDoctor.status, issues: restoredDoctor.issues }))
  const drill = await Promise.resolve().then(() => {
    const restoredState = loadWorkState(restoreDbPath, { runsScope: 'all' })
    const counts = {
      roadmaps: restoredState.roadmaps.length,
      supervisors: restoredState.supervisors.length,
      projectBindings: restoredState.projectBindings.length,
      completionProposals: restoredState.completionProposals.length,
      tasks: restoredState.tasks.length,
      runs: restoredState.runs.length,
      channelBindings: listChannelBindings({}, restoreDbPath).length,
      events: storageTableCountForDb(restoreDbPath, 'events'),
    }
    checks.push(check('restore-isolated-state', fs.existsSync(restoreDbPath), `Restored backup into isolated state directory: ${restoreDir}.`, { restored: restore.restored }))
    checks.push(check('restore-counts', countsMatchBackup(counts, verification.metadata!.counts), 'Restored durable counts match backup metadata before drill mutations.', { counts, expected: verification.metadata!.counts }))

    appendWorkEvent('storage.recovery_drill.started', id, { backupPath: verification.path, restoreDir }, restoreDbPath)
    const expiredTask = createWorkTask({ title: `Recovery drill expired lease ${id}`, pipeline: ['implement'] }, restoreDbPath)
    const expiredRun = startWorkTaskRun(expiredTask.id, 'implement', `${id}_expired_session`, 'implementer', restoreDbPath, { owner: 'recovery-drill', leaseMs: 1 })
    const expiredLease = recoverExpiredWorkLeases(retryLimit, restoreDbPath, Date.now() + 60_000)
    checks.push(check('scheduler-expired-lease', expiredLease.blocked === 1 && expiredLease.recovered === 0 && expiredLease.runIds.includes(expiredRun!.run.id), 'Expired scheduler lease was blocked after simulated restart so an old OpenCode session cannot duplicate live work.', expiredLease))

    const orphanTask = createWorkTask({ title: `Recovery drill orphaned run ${id}`, pipeline: ['implement'] }, restoreDbPath)
    const orphanRun = startWorkTaskRun(orphanTask.id, 'implement', `${id}_orphan_session`, 'implementer', restoreDbPath, { owner: 'recovery-drill', leaseMs: 60 * 60 * 1000 })
    upsertChannelBinding({ provider: 'telegram', chatId: `recovery-drill-${id}`, sessionId: orphanRun!.run.sessionId, mode: 'task', taskId: orphanTask.id, title: 'Recovery drill channel binding' }, restoreDbPath)
    const orphanedRun = recoverOrphanedWorkRuns(new Set(), retryLimit, restoreDbPath, Date.now() + 60_000)
    checks.push(check('scheduler-orphaned-run', orphanedRun.recovered === 1 && orphanedRun.runIds.includes(orphanRun!.run.id), 'Missing OpenCode session recovered to retryable work.', orphanedRun))

    const channelBindings = listChannelBindings({ sessionId: orphanRun!.run.sessionId }, restoreDbPath)
    checks.push(check('channel-consistency', channelBindings.length === 1 && channelBindings[0]!.taskId === orphanTask.id, 'Channel binding remained linked to the recovered task in restored state.', { channelBindings }))
    appendWorkEvent('storage.recovery_drill.completed', id, { status: 'pass', expiredLease, orphanedRun, channelBindings: channelBindings.length }, restoreDbPath)

    const events = listWorkEvents(40, restoreDbPath).map(event => event.type)
    return { counts, expiredLease, orphanedRun, channelBindings: channelBindings.length, events }
  })

  const evidence = finalizeDrillEvidence({
    id,
    status: checks.every(row => row.status === 'pass') ? 'pass' : 'fail',
    startedAt: started.toISOString(),
    evidenceDir,
    backup: { path: verification.path, id: verification.metadata?.id || createdBackup?.id, created: Boolean(createdBackup), verification },
    restore: { stateDir: restoreDir, restoredFiles: restore.restored, safetyBackup: restore.safetyBackup, counts: drill.counts },
    storageDoctor: restoredDoctor,
    drill: { expiredLease: drill.expiredLease, orphanedRun: drill.orphanedRun, channelBindings: drill.channelBindings, events: drill.events },
    checks,
  })
  pruneRecoveryDrills(RECOVERY_DRILL_RETENTION, stateDir)
  return evidence
}
export async function runBackendRollbackDrill(options: { backupPath: string; label?: string; outputDir?: string; now?: Date }): Promise<BackendRollbackReceipt> {
  const started = options.now || new Date()
  const id = backendMigrationId(started, options.label || 'rollback')
  const evidenceDir = path.resolve(options.outputDir || path.join(storageBackendDrillDir(), id))
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const checks: StorageRecoveryDrillCheck[] = []
  const verification = verifyStorageBackup(options.backupPath)
  checks.push(check(
    'backup-manifest',
    verification.ok,
    verification.ok ? 'Rollback backup manifest, file checksums, and SQLite integrity verified.' : `Rollback backup verification failed: ${verification.errors.join('; ')}`,
    { errors: verification.errors },
  ))

  let restore: Awaited<ReturnType<typeof restoreStorageBackupToStateDir>> | undefined
  let counts: StorageBackupMetadata['counts'] | undefined
  let storageDoctor: StorageDoctorReport | undefined
  let recoveryDrill: StorageRecoveryDrillEvidence | undefined
  if (verification.ok) {
    const restoreDir = path.join(evidenceDir, 'restored-state')
    restore = await restoreStorageBackupToStateDir(verification.path, restoreDir, { maintenanceMode: true, skipSafetyBackup: true })
    counts = storageCountsForDb(path.join(restoreDir, 'gateway.db'))
    checks.push(check('rollback-restore-isolated-state', fs.existsSync(path.join(restoreDir, 'gateway.db')), 'Rollback backup restored into an isolated state directory.', { restored: restore.restored.length }))
    checks.push(check('rollback-restore-counts', countsMatchBackup(counts, verification.metadata!.counts), 'Rollback restore counts match backup metadata before resuming work.', { counts, expected: verification.metadata!.counts }))
    storageDoctor = sanitizeStorageDoctorForMigrationEvidence(runStorageDoctor({ stateDir: restoreDir, backupPath: verification.path, now: started }))
    checks.push(check('rollback-storage-doctor', storageDoctor.status === 'ok', storageDoctor.status === 'ok' ? 'Rollback restored state passes storage doctor.' : `Rollback restored state returned storage doctor ${storageDoctor.status}.`, { status: storageDoctor.status, issues: storageDoctor.issues.map(issue => issue.code) }))
    recoveryDrill = await runStorageRecoveryDrill({
      backupPath: verification.path,
      label: `${options.label || 'rollback'}-recovery`,
      outputDir: path.join(evidenceDir, 'recovery-drill'),
      now: started,
    })
    checks.push(check('rollback-recovery-drill', recoveryDrill.status === 'pass', recoveryDrill.status === 'pass' ? 'Recovery drill passed before rollback receipt was accepted.' : 'Recovery drill failed before rollback receipt acceptance.', { recoveryDrill: recoveryDrill.id, status: recoveryDrill.status }))
  }

  return finalizeBackendRollbackReceipt({
    id,
    mode: 'backend_rollback_drill',
    status: checks.every(row => row.status === 'pass') ? 'pass' : 'fail',
    startedAt: started.toISOString(),
    evidenceDir,
    backup: { path: verification.path, id: verification.metadata?.id, verification },
    ...(restore && counts ? { restore: { stateDir: path.dirname(restore.restored.find(file => path.basename(file) === 'gateway.db') || path.join(evidenceDir, 'restored-state', 'gateway.db')), restoredFiles: restore.restored, counts } } : {}),
    ...(storageDoctor ? { storageDoctor } : {}),
    ...(recoveryDrill ? { recoveryDrill: summarizeNestedRecoveryDrill(recoveryDrill) } : {}),
    checks,
  })
}
function backendMigrationId(now: Date, label: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const suffix = label.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 48) || 'backend'
  return `backend-${stamp}-${suffix}`
}
function pruneRecoveryDrills(retention: number, stateDir = storageStateDir()): void {
  if (retention <= 0) return
  const dir = path.join(path.resolve(stateDir), 'recovery-drills')
  if (!fs.existsSync(dir)) return
  const drills = fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(candidate => fs.existsSync(path.join(candidate, 'evidence.json')))
    .sort()
  for (const drill of drills.slice(0, Math.max(0, drills.length - retention))) fs.rmSync(drill, { recursive: true, force: true })
}
function summarizeNestedRecoveryDrill(evidence: StorageRecoveryDrillEvidence): BackendRollbackReceipt['recoveryDrill'] {
  return {
    id: evidence.id,
    status: evidence.status,
    evidencePath: evidence.evidencePath,
    reportPath: evidence.reportPath,
    checks: {
      total: evidence.checks.length,
      passed: evidence.checks.filter(check => check.status === 'pass').length,
      failed: evidence.checks.filter(check => check.status === 'fail').length,
    },
  }
}
function finalizeBackendRollbackReceipt(input: Omit<BackendRollbackReceipt, 'completedAt' | 'evidencePath' | 'reportPath'>): BackendRollbackReceipt {
  const evidencePath = path.join(input.evidenceDir, 'rollback-receipt.json')
  const reportPath = path.join(input.evidenceDir, 'rollback-report.md')
  const receipt: BackendRollbackReceipt = {
    ...input,
    completedAt: new Date().toISOString(),
    evidencePath,
    reportPath,
  }
  fs.writeFileSync(evidencePath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  fs.writeFileSync(reportPath, formatBackendRollbackReport(receipt), { mode: 0o600 })
  return receipt
}
function formatBackendRollbackReport(receipt: BackendRollbackReceipt): string {
  const lines = [
    `# Gateway Backend Rollback Drill ${receipt.id}`,
    '',
    `Status: ${receipt.status}`,
    `Started: ${receipt.startedAt}`,
    `Completed: ${receipt.completedAt}`,
    `Backup: ${receipt.backup.path}`,
    receipt.restore ? `Restored state: ${receipt.restore.stateDir}` : undefined,
    receipt.recoveryDrill ? `Recovery drill: ${receipt.recoveryDrill.status} (${receipt.recoveryDrill.evidencePath})` : undefined,
    '',
    '## Checks',
    '',
    ...receipt.checks.map(row => `- ${row.status}: ${row.name} - ${row.summary}`),
    '',
    '## Release Boundary',
    '',
    'This receipt proves only a local preview cutover rollback drill. It does not make Postgres-compatible, self-hosted, hosted, team, or multi-tenant storage a supported release claim.',
    '',
  ].filter((line): line is string => line !== undefined)
  return lines.join('\n')
}
function check(name: string, passed: boolean, summary: string, details?: Record<string, unknown>): StorageRecoveryDrillCheck {
  return { name, status: passed ? 'pass' : 'fail', summary, ...(details ? { details } : {}) }
}
function backupContainsOnlyAllowedFiles(metadata: StorageBackupMetadata | undefined): boolean {
  return Boolean(Array.isArray(metadata?.files) && metadata.files.every(file => BACKUP_FILE_NAMES.has(file.name)))
}
function metadataFileNames(metadata: StorageBackupMetadata | undefined): string[] {
  return Array.isArray(metadata?.files) ? metadata.files.map(file => String(file?.name || '')) : []
}
function finalizeDrillEvidence(input: Omit<StorageRecoveryDrillEvidence, 'completedAt' | 'evidencePath' | 'reportPath'>): StorageRecoveryDrillEvidence {
  const evidencePath = path.join(input.evidenceDir, 'evidence.json')
  const reportPath = path.join(input.evidenceDir, 'report.md')
  const evidence: StorageRecoveryDrillEvidence = {
    ...input,
    completedAt: new Date().toISOString(),
    evidencePath,
    reportPath,
  }
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  fs.writeFileSync(reportPath, formatRecoveryDrillReport(evidence), { mode: 0o600 })
  return evidence
}
function formatRecoveryDrillReport(evidence: StorageRecoveryDrillEvidence): string {
  const lines = [
    `# Gateway Recovery Drill ${evidence.id}`,
    '',
    `Status: ${evidence.status}`,
    `Started: ${evidence.startedAt}`,
    `Completed: ${evidence.completedAt}`,
    `Backup: ${evidence.backup.path}`,
    evidence.restore ? `Restored state: ${evidence.restore.stateDir}` : undefined,
    '',
    '## Checks',
    '',
    ...evidence.checks.map(row => `- ${row.status}: ${row.name} - ${row.summary}`),
    '',
  ].filter((line): line is string => line !== undefined)
  return lines.join('\n')
}
