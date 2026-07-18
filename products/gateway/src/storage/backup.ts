import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { getConfigPath, type GatewayConfig } from '../config.js'
import { loadWorkState, loadWorkStateReadOnly, listChannelBindings, listWorkEvents, closeWorkDb } from '../work-store.js'
import {
  CURRENT_BACKUP_VERSION,
  DEFAULT_BACKUP_RETENTION,
  BACKUP_COUNT_KEYS,
  storageStateDir,
  workStatePathForStateDir,
  channelSyncOutboxPath,
  backupSourceFiles,
  storageCountsForDb,
  storageTableCountForDb,
  storageSourceSpecs,
  normalizeBackupPath,
  readMetadata,
  backupFilePath,
  validateBackupFileName,
  checkDatabaseIntegrity,
  withReadOnlyStorageDb,
  countsMatchBackup,
  redactStatePath,
  backendMigrationEvidencePolicy,
} from './internal.js'
import type {
  StorageBackupSummary,
  StorageBackupFile,
  StorageBackupMetadata,
  StorageBackupVerification,
  StorageBackendPosture,
  BackendActivationReadiness,
  BackupFileEntryValidation,
} from './types.js'

const STORAGE_OPERATION_LOCK_NAME = '.storage-operation.lock'
const STORAGE_OPERATION_LOCK_STALE_MS = 30 * 60 * 1000
const heldStorageOperationLocks = new Map<string, number>()

export function createStorageBackup(options: { label?: string; retention?: number; now?: Date; allowActiveRuns?: boolean; stateDir?: string } = {}): StorageBackupSummary {
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  return withStorageOperationLock(stateDir, 'backup', () => createStorageBackupLocked({ ...options, stateDir }))
}

export function withStorageOperationLock<T>(stateDir: string, operation: 'backup' | 'restore', fn: () => T): T {
  const resolvedStateDir = path.resolve(stateDir)
  fs.mkdirSync(resolvedStateDir, { recursive: true, mode: 0o700 })
  const lockPath = path.join(resolvedStateDir, STORAGE_OPERATION_LOCK_NAME)
  const depth = heldStorageOperationLocks.get(lockPath) || 0
  if (depth > 0) {
    heldStorageOperationLocks.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      const next = (heldStorageOperationLocks.get(lockPath) || 1) - 1
      if (next > 0) heldStorageOperationLocks.set(lockPath, next)
      else heldStorageOperationLocks.delete(lockPath)
    }
  }
  acquireStorageOperationLock(lockPath, operation)
  heldStorageOperationLocks.set(lockPath, 1)
  let releaseNow = true
  try {
    const result = fn()
    if (result && typeof (result as any).then === 'function') {
      releaseNow = false
      return ((result as unknown as Promise<unknown>).finally(() => releaseStorageOperationLock(lockPath)) as unknown) as T
    }
    return result
  } finally {
    if (releaseNow) releaseStorageOperationLock(lockPath)
  }
}

function createStorageBackupLocked(options: { label?: string; retention?: number; now?: Date; allowActiveRuns?: boolean; stateDir?: string } = {}): StorageBackupSummary {
  const now = options.now || new Date()
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  const dbPath = workStatePathForStateDir(stateDir)
  if (!fs.existsSync(dbPath)) loadWorkState(dbPath, { runsScope: 'all' })
  const id = backupId(now, options.label)
  const backupPath = path.join(stateDir, 'backups', id)
  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 })

  // Drop any cached long-lived write handle so wal_checkpoint(FULL) can fully
  // fold the WAL back into the main file and the copy below is a consistent
  // snapshot. The next store op re-opens lazily.
  closeWorkDb(dbPath)
  checkpointDatabase(dbPath)
  checkpointDatabase(channelSyncOutboxPath(stateDir))
  const sqliteLocks = acquireSqliteSnapshotLocks([dbPath, channelSyncOutboxPath(stateDir)])
  try {
    const state = loadWorkStateReadOnly(dbPath, { runsScope: 'all' })
    const activeRuns = state.runs.filter(run => run.status === 'running')
    const activeDispatchStarts = listActiveDispatchStartsForBackup(dbPath, now)
    if ((activeRuns.length || activeDispatchStarts.length) && options.allowActiveRuns !== true) {
      try { fs.rmSync(backupPath, { recursive: true, force: true }) } catch {}
      throw new Error(`backup refused: ${activeRuns.length} active run(s) and ${activeDispatchStarts.length} starting dispatch(es) are writing Gateway state; pause work or pass allowActiveRuns=true during a maintenance window`)
    }
    const files: StorageBackupFile[] = []
    for (const source of backupSourceFiles(stateDir)) {
      if (!fs.existsSync(source)) continue
      const target = path.join(backupPath, path.basename(source))
      copyBackupSourceFile(source, target, sqliteLocks)
      try { fs.chmodSync(target, 0o600) } catch {}
      files.push(fileEntry(target, path.basename(source)))
    }

    const copiedDbPath = path.join(backupPath, 'gateway.db')
    const counts = fs.existsSync(copiedDbPath)
      ? storageCountsForDb(copiedDbPath)
      : {
          roadmaps: state.roadmaps.length,
          supervisors: state.supervisors.length,
          projectBindings: state.projectBindings.length,
          completionProposals: state.completionProposals.length,
          tasks: state.tasks.length,
          runs: state.runs.length,
          channelBindings: listChannelBindings({}, dbPath).length,
          events: storageTableCountForDb(dbPath, 'events'),
        }
    const metadata: StorageBackupMetadata = {
      version: CURRENT_BACKUP_VERSION,
      id,
      createdAt: now.toISOString(),
      packageVersion: readPackageVersion(),
      configHash: fs.existsSync(getConfigPath()) ? sha256File(getConfigPath()) : undefined,
      counts,
      files,
      checksum: checksumManifest(files),
    }
    writeMetadata(backupPath, metadata)
    const verification = verifyStorageBackup(backupPath)
    if (!verification.ok) {
      try { fs.rmSync(backupPath, { recursive: true, force: true }) } catch {}
      throw new Error(`backup verification failed: ${verification.errors.join('; ')}`)
    }
    pruneBackups(options.retention ?? DEFAULT_BACKUP_RETENTION, stateDir)
    return { ...metadata, path: backupPath }
  } finally {
    releaseSqliteSnapshotLocks(sqliteLocks)
  }
}
export function listStorageBackups(options: { stateDir?: string } = {}): StorageBackupSummary[] {
  const dir = path.join(path.resolve(options.stateDir || storageStateDir()), 'backups')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(candidate => fs.existsSync(path.join(candidate, 'metadata.json')))
    .map(candidate => {
      const verification = verifyStorageBackup(candidate)
      return { ...(verification.metadata || readMetadata(candidate) || emptyMetadata(path.basename(candidate))), path: candidate, ok: verification.ok, errors: verification.errors }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
export function verifyStorageBackup(inputPath: string): StorageBackupVerification {
  const backupPath = normalizeBackupPath(inputPath)
  const errors: string[] = []
  const metadata = readMetadata(backupPath)
  if (!metadata) return { ok: false, path: backupPath, errors: ['metadata.json is missing or invalid'] }
  const files = Array.isArray(metadata.files) ? metadata.files : []
  if (!Number.isInteger(metadata.version)) errors.push('metadata version is missing or invalid')
  else if (metadata.version !== CURRENT_BACKUP_VERSION) errors.push(`unsupported backup version: ${metadata.version}`)
  if (!Array.isArray(metadata.files)) errors.push('metadata files must be an array')
  validateBackupCounts(metadata.counts, errors)
  if (typeof metadata.checksum !== 'string' || !metadata.checksum) errors.push('metadata checksum is missing or invalid')
  if (!files.some(file => file?.name === 'gateway.db')) errors.push('gateway.db is missing from backup metadata')
  validateBackupDirectoryContents(backupPath, files, errors)

  const seenNames = new Set<string>()
  const validFiles: StorageBackupFile[] = []
  for (const file of files) {
    const entry = validateBackupFileEntry(file)
    if (!entry.ok) {
      errors.push(entry.error)
      continue
    }
    if (seenNames.has(entry.file.name)) {
      errors.push(`${entry.file.name} is duplicated in backup metadata`)
      continue
    }
    seenNames.add(entry.file.name)
    validFiles.push(entry.file)
    const filePath = backupFilePath(backupPath, entry.file.name)
    if (!fs.existsSync(filePath)) {
      errors.push(`${entry.file.name} is missing`)
      continue
    }
    const stat = fs.statSync(filePath)
    if (stat.size !== entry.file.size) errors.push(`${entry.file.name} size mismatch`)
    const actual = sha256File(filePath)
    if (actual !== entry.file.sha256) errors.push(`${entry.file.name} checksum mismatch`)
  }

  const manifest = checksumManifest(validFiles)
  if (metadata.checksum && manifest !== metadata.checksum) errors.push('metadata checksum mismatch')
  const dbPath = backupFilePath(backupPath, 'gateway.db')
  if (fs.existsSync(dbPath)) {
    const integrity = withReadOnlyStorageDb(dbPath, checkDatabaseIntegrity)
    if (integrity !== 'ok') errors.push(`gateway.db integrity check failed: ${integrity}`)
    else if (backupCountsStructurallyValid(metadata.counts)) {
      const actualCounts = storageCountsForDb(dbPath)
      if (!countsMatchBackup(actualCounts, metadata.counts)) errors.push('metadata counts do not match gateway.db contents')
    }
  }
  const outboxPath = backupFilePath(backupPath, 'channel-sync.json.sqlite')
  if (fs.existsSync(outboxPath)) {
    const integrity = withReadOnlyStorageDb(outboxPath, checkDatabaseIntegrity)
    if (integrity !== 'ok') errors.push(`channel-sync.json.sqlite integrity check failed: ${integrity}`)
  }
  return { ok: errors.length === 0, path: backupPath, metadata, errors }
}
export function exportGatewayState(): Record<string, unknown> {
  const state = loadWorkState(undefined, { runsScope: 'all' })
  return {
    exportedAt: new Date().toISOString(),
    configHash: fs.existsSync(getConfigPath()) ? sha256File(getConfigPath()) : undefined,
    state,
    channelBindings: listChannelBindings(),
    recentEvents: listWorkEvents(500),
  }
}
export function describeStorageBackend(options: { stateDir?: string; config?: GatewayConfig; env?: NodeJS.ProcessEnv } = {}): StorageBackendPosture {
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  const specs = storageSourceSpecs(stateDir)
  const mode = 'local_sqlite' as const
  const activation = backendActivationReadiness()
  return {
    mode,
    releaseStatus: 'supported_public_local_beta',
    transactionalAuthority: 'gateway_db',
    effectivePersistence: 'local_sqlite',
    hostedTeamStatus: 'unsupported_until_m25_decision',
    stateDir: redactStatePath(stateDir, stateDir),
    gatewayDb: redactStatePath(workStatePathForStateDir(stateDir), stateDir),
    authoritativeSources: specs.filter(source => source.kind === 'authoritative_sqlite' || source.kind === 'transactional_sqlite').map(source => source.id),
    sidecarSources: specs.filter(source => source.kind === 'derived_cache' || source.kind === 'append_only_evidence').map(source => source.id),
    activation,
    caveats: [
      'Local SQLite is the only supported durable backend for the current public local beta.',
      'Self-hosted team, hosted control-plane, and multi-tenant storage modes are not supported release claims.',
      'Do not claim hosted/team durability until the backend, identity, secrets, audit, topology, cutover, and final readiness gates close.',
    ],
  }
}
function backendActivationReadiness(): BackendActivationReadiness {
  return {
    mode: 'backend_activation',
    status: 'local_sqlite_default',
    runtimeBackend: 'local_sqlite',
    supportedDefault: 'local_sqlite',
    effectivePersistence: 'local_sqlite',
    currentReleaseClaim: 'local_sqlite_public_beta',
    cutoverReadiness: 'not_selectable',
    rollbackReadiness: 'drill_available_requires_verified_backup',
    consistencyScan: 'storage_doctor_available',
    requiredProofs: [
      'storage doctor consistency scan has no critical failures',
      'fresh verified backup exists for the selected state',
      'rollback dry-run restores an isolated backup and passes recovery drill',
      'redacted evidence review confirms no connection strings, credentials, raw channel targets, or private transcript text',
    ],
    supportedCommands: [
      { id: 'status', command: 'opencode-gateway backend status --json', purpose: 'Show backend mode, activation state, blockers, and supported commands without exposing credentials.', safeByDefault: true },
      { id: 'consistency_scan', command: 'opencode-gateway backend doctor --json', purpose: 'Run storage doctor consistency, drift, backup, and backend posture checks.', safeByDefault: true },
      { id: 'consistency_proof', command: 'opencode-gateway backend consistency-proof --json', purpose: 'Summarize backend consistency, backup, rollback, and read-model proof without exposing raw state.', safeByDefault: true },
      { id: 'durable_state_adapter', command: 'opencode-gateway backend durable-state-adapter --json', purpose: 'Show the local durable-state adapter capabilities, repair boundary, and backup/restore truth.', safeByDefault: true },
      { id: 'durable_state_round_trip', command: 'opencode-gateway backend durable-state-round-trip --json', purpose: 'Create or verify a backup and run an isolated local backup/restore recovery proof.', safeByDefault: true },
      { id: 'rollback_dry_run', command: 'opencode-gateway backend rollback-dry-run --from <backup-path> --json', purpose: 'Restore an isolated backup and prove rollback/recovery without touching live state.', safeByDefault: true },
    ],
    blockers: [],
    unsupportedModes: [
      'hosted managed database service',
      'hosted control-plane production storage',
      'multi-tenant data isolation',
      'managed backups or production backend cutover',
    ],
    evidencePolicy: backendMigrationEvidencePolicy(),
  }
}
function backupId(now: Date, label?: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const suffix = label ? '-' + label.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 48) : ''
  return `gateway-backup-${stamp}${suffix}`
}
function acquireStorageOperationLock(lockPath: string, operation: 'backup' | 'restore'): void {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 })
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err
    const stat = fs.statSync(lockPath)
    if (Date.now() - stat.mtimeMs <= STORAGE_OPERATION_LOCK_STALE_MS) {
      throw new Error(`storage ${operation} refused: another backup/restore operation is in progress`)
    }
    fs.rmSync(lockPath, { recursive: true, force: true })
    fs.mkdirSync(lockPath, { mode: 0o700 })
  }
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ operation, pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
}
function releaseStorageOperationLock(lockPath: string): void {
  heldStorageOperationLocks.delete(lockPath)
  try { fs.rmSync(lockPath, { recursive: true, force: true }) } catch {}
}
interface SqliteSnapshotLock {
  filePath: string
  db: DatabaseSync
}
function acquireSqliteSnapshotLocks(files: string[]): SqliteSnapshotLock[] {
  const locks: SqliteSnapshotLock[] = []
  try {
    for (const filePath of files.map(file => path.resolve(file))) {
      if (!fs.existsSync(filePath)) continue
      const db = new DatabaseSync(filePath)
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('BEGIN IMMEDIATE')
      locks.push({ filePath, db })
    }
    return locks
  } catch (err) {
    releaseSqliteSnapshotLocks(locks)
    throw err
  }
}
function releaseSqliteSnapshotLocks(locks: SqliteSnapshotLock[]): void {
  for (const lock of locks.reverse()) {
    try { lock.db.exec('ROLLBACK') } catch {}
    try { lock.db.close() } catch {}
  }
}
function snapshotLockFor(locks: SqliteSnapshotLock[], filePath: string): DatabaseSync | undefined {
  const resolved = path.resolve(filePath)
  return locks.find(lock => lock.filePath === resolved)?.db
}
function listActiveDispatchStartsForBackup(dbPath: string, now: Date): string[] {
  if (!fs.existsSync(dbPath)) return []
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const rows = db.prepare("SELECT id FROM task_dispatch_receipts WHERE status = 'starting' AND lease_expires_at > ?").all(now.toISOString()) as Array<{ id?: unknown }>
    return rows.map(row => String(row.id || '')).filter(Boolean)
  } catch {
    return []
  } finally {
    db.close()
  }
}
function pruneBackups(retention: number, stateDir = storageStateDir()): void {
  if (retention <= 0) return
  const backups = listStorageBackups({ stateDir })
  for (const backup of backups.slice(0, Math.max(0, backups.length - retention))) fs.rmSync(backup.path, { recursive: true, force: true })
}
function validateBackupFileEntry(file: unknown): BackupFileEntryValidation {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return { ok: false, error: 'backup metadata contains an invalid file entry' }
  const input = file as any
  const nameError = validateBackupFileName(input.name)
  if (nameError) return { ok: false, error: nameError }
  if (!Number.isInteger(input.size) || input.size < 0) return { ok: false, error: `${input.name} size is missing or invalid` }
  if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256)) return { ok: false, error: `${input.name} checksum is missing or invalid` }
  return { ok: true, file: { name: input.name, size: input.size, sha256: input.sha256.toLowerCase() } }
}
function validateBackupCounts(counts: unknown, errors: string[]): void {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    errors.push('metadata counts is missing or invalid')
    return
  }
  for (const key of BACKUP_COUNT_KEYS) {
    if (!Number.isInteger((counts as any)[key]) || (counts as any)[key] < 0) errors.push(`metadata counts.${key} is missing or invalid`)
  }
}
function validateBackupDirectoryContents(backupPath: string, files: StorageBackupFile[], errors: string[]): void {
  if (!fs.existsSync(backupPath)) {
    errors.push('backup directory is missing')
    return
  }
  const allowed = new Set(['metadata.json'])
  for (const file of files) if (!validateBackupFileName(file?.name)) allowed.add(file.name)
  for (const entry of fs.readdirSync(backupPath)) {
    if (allowed.has(entry)) continue
    errors.push(`unexpected file in backup directory: ${entry}`)
  }
}
function writeMetadata(backupPath: string, metadata: StorageBackupMetadata): void {
  const file = path.join(backupPath, 'metadata.json')
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 })
}
function emptyMetadata(id: string): StorageBackupMetadata {
  return { version: 0, id, createdAt: '', packageVersion: '', counts: { roadmaps: 0, supervisors: 0, projectBindings: 0, completionProposals: 0, tasks: 0, runs: 0, channelBindings: 0, events: 0 }, files: [], checksum: '' }
}
function fileEntry(filePath: string, name: string): StorageBackupFile {
  const stat = fs.statSync(filePath)
  return { name, size: stat.size, sha256: sha256File(filePath) }
}
function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}
function checksumManifest(files: StorageBackupFile[]): string {
  const input = files.slice().sort((a, b) => a.name.localeCompare(b.name)).map(file => `${file.name}:${file.size}:${file.sha256}`).join('\n')
  return createHash('sha256').update(input).digest('hex')
}
function backupCountsStructurallyValid(counts: unknown): counts is StorageBackupMetadata['counts'] {
  return Boolean(counts && typeof counts === 'object' && BACKUP_COUNT_KEYS.every(key => Number.isInteger((counts as any)[key]) && (counts as any)[key] >= 0))
}
function checkpointDatabase(filePath: string): void {
  if (!fs.existsSync(filePath)) return
  const db = new DatabaseSync(filePath)
  try {
    const row = (db.prepare('PRAGMA wal_checkpoint(FULL)').all() as any[])[0] || {}
    const busy = Number(row.busy ?? row[0] ?? 0)
    const log = Number(row.log ?? row[1] ?? 0)
    const checkpointed = Number(row.checkpointed ?? row[2] ?? 0)
    if (busy !== 0) throw new Error(`SQLite WAL checkpoint incomplete for ${path.basename(filePath)}: busy=${busy}`)
    if (log >= 0 && checkpointed >= 0 && checkpointed < log) throw new Error(`SQLite WAL checkpoint incomplete for ${path.basename(filePath)}: checkpointed ${checkpointed}/${log} frame(s)`)
  } finally { db.close() }
}
function copyBackupSourceFile(source: string, target: string, locks: SqliteSnapshotLock[]): void {
  if (isSqliteBackupSource(source)) {
    copySqliteSnapshot(source, target, snapshotLockFor(locks, source))
    return
  }
  fs.copyFileSync(source, target)
}
function isSqliteBackupSource(source: string): boolean {
  const name = path.basename(source)
  return name === 'gateway.db' || name === 'channel-sync.json.sqlite'
}
function copySqliteSnapshot(source: string, target: string, lockedDb?: DatabaseSync): void {
  fs.rmSync(target, { force: true })
  if (lockedDb) {
    fs.copyFileSync(source, target)
    try { fs.chmodSync(target, 0o600) } catch {}
    return
  }
  const db = new DatabaseSync(source)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`VACUUM INTO ${sqlString(target)}`)
  } finally {
    db.close()
  }
}
function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}
function readPackageVersion(): string {
  try {
    const file = new URL('../package.json', import.meta.url)
    return JSON.parse(fs.readFileSync(file, 'utf-8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}
