import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { getConfigDir } from '../config.js'
import { loadWorkStateReadOnly, listChannelBindingsReadOnly, getRow } from '../work-store.js'
import type {
  StorageSourceRecord,
  StorageSourceSpec,
  StorageBackupMetadata,
  StorageRecoveryDrillSummary,
  StorageRecoveryDrillEvidence,
  BackendMigrationEvidencePolicy,
} from './types.js'

export const CURRENT_BACKUP_VERSION = 1
export const DEFAULT_BACKUP_RETENTION = 20
export const CHANNEL_SYNC_OUTBOX_FILE = 'channel-sync.json.sqlite'
export const OPERATIONAL_SIDECAR_FILE = 'operational-sidecar.sqlite'
/** Legacy JSON sidecars (still backed up for restore of older states). */
export const SIDECAR_FILES = ['channel-sync.json', 'events.json', 'sessions.json']
export const BACKUP_FILE_NAMES = new Set([
  'gateway.db',
  CHANNEL_SYNC_OUTBOX_FILE,
  OPERATIONAL_SIDECAR_FILE,
  ...SIDECAR_FILES,
])
export const RECOVERY_DRILL_RETENTION = 20
export const BACKUP_COUNT_KEYS = ['roadmaps', 'supervisors', 'projectBindings', 'completionProposals', 'tasks', 'runs', 'channelBindings', 'events'] as const
export function storageStateDir(): string {
  return process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir()
}
export function storageRecoveryDrillDir(): string {
  return path.join(storageStateDir(), 'recovery-drills')
}
export function storageBackendDrillDir(): string {
  return path.join(storageStateDir(), 'backend-drills')
}
export function listStorageSources(options: { stateDir?: string } = {}): StorageSourceRecord[] {
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  return storageSourceSpecs(stateDir).map(spec => sourceRecord(spec, stateDir))
}
export function readSessionSidecarIds(stateDir: string): Set<string> | undefined {
  // JOE-996 / H4: prefer operational-sidecar.sqlite worker_sessions; fall back to legacy sessions.json.
  const sqlitePath = path.join(stateDir, OPERATIONAL_SIDECAR_FILE)
  if (fs.existsSync(sqlitePath)) {
    try {
      const db = new DatabaseSync(sqlitePath, { readOnly: true })
      try {
        const rows = db.prepare('SELECT id FROM worker_sessions').all() as Array<{ id?: unknown }>
        return new Set(rows.map((row) => String(row?.id || '').trim()).filter(Boolean))
      } finally {
        try { db.close() } catch {}
      }
    } catch {
      // fall through to legacy JSON
    }
  }
  const sessionPath = path.join(stateDir, 'sessions.json')
  if (!fs.existsSync(sessionPath)) return undefined
  const parsed = readJsonArtifact(sessionPath)
  if (!parsed.ok) return undefined
  const rows = Array.isArray((parsed.value as any)?.sessions) ? (parsed.value as any).sessions : []
  return new Set(rows.map((row: any) => String(row?.id || '').trim()).filter(Boolean))
}
export function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.map(row => String(row || '')).filter(Boolean) : []
  } catch {
    return []
  }
}
export function fingerprintId(value: unknown): string {
  const text = String(value ?? '')
  return text ? createHash('sha256').update(text).digest('hex').slice(0, 12) : ''
}
export function fingerprintIds(values: unknown[]): string[] {
  return values.map(fingerprintId).filter(Boolean)
}
export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(row => String(row || '')).filter(Boolean)
  const text = String(value || '')
  return text ? [text] : []
}
export function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}
export function backupSourceFiles(stateDir = storageStateDir()): string[] {
  const resolved = path.resolve(stateDir)
  return [
    workStatePathForStateDir(resolved),
    channelSyncOutboxPath(resolved),
    path.join(resolved, OPERATIONAL_SIDECAR_FILE),
    ...SIDECAR_FILES.map(name => path.join(resolved, name)),
  ]
}
export function storageSourceSpecs(stateDir: string): StorageSourceSpec[] {
  const resolved = path.resolve(stateDir)
  return [
    {
      id: 'state_dir',
      label: 'Gateway state directory',
      kind: 'operator_artifact',
      rawPath: resolved,
      directory: true,
      required: true,
      backedUp: false,
      owner: 'storage',
      description: 'Filesystem root for Gateway mutable local state.',
      remediation: 'Create the state directory with owner-only permissions or run setup before starting Gateway.',
    },
    {
      id: 'gateway_db',
      label: 'Gateway work graph database',
      kind: 'authoritative_sqlite',
      rawPath: workStatePathForStateDir(resolved),
      fileName: 'gateway.db',
      required: true,
      backedUp: true,
      owner: 'work-store',
      description: 'Authoritative source for roadmaps, issues, dependencies, runs, events, bindings, gates, alerts, and daemon leadership.',
      remediation: 'Restore gateway.db from a verified backup if it is missing or corrupt.',
    },
    {
      id: 'channel_sync_outbox',
      label: 'Channel sync outbox',
      kind: 'transactional_sqlite',
      rawPath: channelSyncOutboxPath(resolved),
      fileName: CHANNEL_SYNC_OUTBOX_FILE,
      required: false,
      backedUp: true,
      owner: 'channel-sync',
      description: 'Transactional channel delivery ledger for pending, leased, and delivered outbound sync messages.',
      remediation: 'Restore channel-sync.json.sqlite from backup or let Gateway recreate it after confirming no pending deliveries are needed.',
    },
    {
      id: 'channel_sync_checkpoint',
      label: 'Channel sync checkpoint cache',
      kind: 'derived_cache',
      rawPath: path.join(resolved, 'channel-sync.json'),
      fileName: 'channel-sync.json',
      json: true,
      required: false,
      backedUp: true,
      owner: 'channel-sync',
      description: 'Derived delivery checkpoint and pending inbound cache used to avoid duplicate cross-surface messages.',
      remediation: 'Restore channel-sync.json from backup or rebuild it intentionally during a quiet maintenance window.',
    },
    {
      id: 'operational_sidecar',
      label: 'Operational sidecar store',
      kind: 'transactional_sqlite',
      rawPath: path.join(resolved, OPERATIONAL_SIDECAR_FILE),
      fileName: OPERATIONAL_SIDECAR_FILE,
      required: false,
      backedUp: true,
      owner: 'operational-sidecar',
      description: 'SQLite store for operational events, worker session projection, and channel poll cursors (JOE-996 H3/H4/H8).',
      remediation: 'Restore operational-sidecar.sqlite from backup or let Gateway recreate it after confirming local tooling no longer needs prior telemetry/cursors.',
    },
    {
      id: 'events_sidecar',
      label: 'Events sidecar (legacy JSON)',
      kind: 'append_only_evidence',
      rawPath: path.join(resolved, 'events.json'),
      fileName: 'events.json',
      json: true,
      required: false,
      backedUp: true,
      owner: 'wakeup',
      description: 'Legacy bounded operational telemetry JSON. Migrated into operational-sidecar.sqlite on first open (H3).',
      remediation: 'Prefer operational-sidecar.sqlite; restore legacy events.json only for older backups.',
    },
    {
      id: 'sessions_sidecar',
      label: 'Sessions sidecar (legacy JSON)',
      kind: 'derived_cache',
      rawPath: path.join(resolved, 'sessions.json'),
      fileName: 'sessions.json',
      json: true,
      required: false,
      backedUp: true,
      owner: 'workers',
      description: 'Legacy worker registry JSON. Migrated into operational-sidecar.sqlite on first open (H4).',
      remediation: 'Prefer operational-sidecar.sqlite; restore legacy sessions.json only for older backups.',
    },
    {
      id: 'backups',
      label: 'Backup directory',
      kind: 'operator_artifact',
      rawPath: path.join(resolved, 'backups'),
      directory: true,
      required: false,
      backedUp: false,
      owner: 'storage',
      description: 'Operator-created local backup set with metadata and checksums.',
      remediation: 'Run `opencode-gateway backup create` to create a fresh backup.',
    },
    {
      id: 'recovery_drills',
      label: 'Recovery drill evidence directory',
      kind: 'operator_artifact',
      rawPath: path.join(resolved, 'recovery-drills'),
      directory: true,
      required: false,
      backedUp: false,
      owner: 'storage',
      description: 'Machine-readable recovery drill evidence and markdown reports.',
      remediation: 'Run `opencode-gateway backup drill` after storage, scheduler, or channel recovery changes.',
    },
  ]
}
export function sourceRecord(spec: StorageSourceSpec, stateDir: string): StorageSourceRecord {
  const stat = safeStat(spec.rawPath)
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    path: redactStatePath(spec.rawPath, stateDir),
    required: spec.required,
    backedUp: spec.backedUp,
    owner: spec.owner,
    description: spec.description,
    remediation: spec.remediation,
    exists: Boolean(stat),
    ...(stat && !spec.directory ? { size: stat.size } : {}),
    ...(stat ? { updatedAt: stat.mtime.toISOString() } : {}),
  }
}
export function safeStat(filePath: string): fs.Stats | undefined {
  try { return fs.statSync(filePath) } catch { return undefined }
}
export function openSqliteReadOnly(filePath: string): DatabaseSync {
  const resolved = path.resolve(filePath)
  const target = prepareReadOnlyDbTarget(resolved)
  const db = new DatabaseSync(target.path, { readOnly: true })
  const realClose = db.close.bind(db)
  ;(db as { close: () => void }).close = () => {
    try {
      realClose()
    } finally {
      target.cleanup()
    }
  }
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA query_only = ON')
  return db
}
export function readJsonArtifact(filePath: string): { ok: true; value: any } | { ok: false; error: string } {
  if (!fs.existsSync(filePath)) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}
export function channelSyncDeliveryKeys(value: any): Set<string> {
  const keys = new Set<string>()
  const deliveries = value?.deliveries && typeof value.deliveries === 'object' && !Array.isArray(value.deliveries) ? value.deliveries : {}
  for (const [key, row] of Object.entries(deliveries)) {
    if (typeof key === 'string' && key) keys.add(key)
    const candidate = channelSyncKeyFromParts((row as any)?.sessionId, (row as any)?.provider, (row as any)?.chatId, (row as any)?.threadId)
    if (candidate) keys.add(candidate)
  }
  return keys
}
export function inspectChannelSyncOutbox(filePath: string, checkpointKeys: Set<string>): { pendingRows: number; mismatches: string[]; error?: string; code?: string; summary?: string } {
  if (!fs.existsSync(filePath)) return { pendingRows: 0, mismatches: [] }
  const integrity = checkDatabaseIntegrity(filePath)
  if (integrity !== 'ok') return { pendingRows: 0, mismatches: [], error: integrity, code: 'channel_outbox_integrity_failed', summary: 'Channel sync outbox failed SQLite integrity check.' }
  try {
    const db = openSqliteReadOnly(filePath)
    try {
      if (!sqliteTableExists(db, 'channel_sync_outbox')) {
        return { pendingRows: 0, mismatches: [], error: 'channel_sync_outbox table is missing', code: 'channel_outbox_schema_missing', summary: 'Channel sync outbox schema is missing.' }
      }
      const rows = db.prepare("SELECT session_id, provider, chat_id, thread_id, status FROM channel_sync_outbox WHERE status != 'delivered' ORDER BY updated_at ASC LIMIT 1000").all() as any[]
      const mismatches = rows
        .map(row => channelSyncKeyFromParts(row.session_id, row.provider, row.chat_id, row.thread_id))
        .filter((key): key is string => Boolean(key))
        .filter(key => checkpointKeys.size > 0 && !checkpointKeys.has(key))
      return { pendingRows: rows.length, mismatches: [...new Set(mismatches)] }
    } finally {
      db.close()
    }
  } catch (err: any) {
    return { pendingRows: 0, mismatches: [], error: err?.message || String(err) }
  }
}
export function sqliteTableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as any
  return row?.name === table
}
export function channelSyncKeyFromParts(sessionId: unknown, provider: unknown, chatId: unknown, threadId: unknown): string | undefined {
  const session = cleanDoctorString(sessionId)
  const channelProvider = cleanDoctorString(provider)
  const chat = cleanDoctorString(chatId)
  if (!session || !channelProvider || !chat) return undefined
  return `${session}:${channelProvider}:${chat}:${cleanDoctorString(threadId) || ''}`
}
export function latestBackupPath(stateDir: string): string | undefined {
  const dir = path.join(stateDir, 'backups')
  if (!fs.existsSync(dir)) return undefined
  const candidates = fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(candidate => fs.existsSync(path.join(candidate, 'metadata.json')))
    .map(candidate => ({ candidate, metadata: readMetadata(candidate) }))
    .filter((row): row is { candidate: string; metadata: StorageBackupMetadata } => Boolean(row.metadata?.createdAt))
    .sort((a, b) => a.metadata.createdAt.localeCompare(b.metadata.createdAt))
  return candidates.at(-1)?.candidate
}
export function storageCountsForDb(dbPath: string): StorageBackupMetadata['counts'] {
  return withReadOnlyStorageDb(dbPath, readOnlyDbPath => {
    const state = loadWorkStateReadOnly(readOnlyDbPath, { runsScope: 'all' })
    return {
      roadmaps: state.roadmaps.length,
      supervisors: state.supervisors.length,
      projectBindings: state.projectBindings.length,
      completionProposals: state.completionProposals.length,
      tasks: state.tasks.length,
      runs: state.runs.length,
      channelBindings: listChannelBindingsReadOnly({}, readOnlyDbPath).length,
      events: storageTableCountForDb(readOnlyDbPath, 'events'),
    }
  })
}
export function storageTableCountForDb(dbPath: string, table: string): number {
  const db = openSqliteReadOnly(dbPath)
  try { return lifecycleCount(db, table) } finally { db.close() }
}
export function readModelChecksum(counts: StorageBackupMetadata['counts']): string {
  return createHash('sha256').update(JSON.stringify({ counts })).digest('hex')
}
export function backendMigrationEvidencePolicy(): BackendMigrationEvidencePolicy {
  return {
    redacted: true,
    allowed: [
      'backend mode and release status',
      'record counts and read-model checksum',
      'backup IDs, checksums, and verification status',
      'blocker codes and redacted remediation text',
    ],
    forbidden: [
      'connection strings, database usernames, passwords, hosts, or DSNs',
      'raw channel targets, provider payloads, private transcript text, or provider tokens',
      'private local notes or unredacted operator secrets',
      'claims that storage is self-hosted/team/hosted production ready',
    ],
  }
}
export function normalizeDoctorNow(value?: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  return cleanDoctorString(value) || new Date().toISOString()
}
export function redactStatePath(filePath: string, stateDir: string): string {
  return redactPath(filePath, stateDir, '<state>')
}
export function redactPath(filePath: string, rootDir: string, label: string): string {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(filePath)
  const relative = path.relative(root, resolved)
  if (relative === '') return `${label}/.`
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return `${label}/${relative}`
  return `<redacted:path:${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}>`
}
export function cleanDoctorString(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  return text || undefined
}
export function channelSyncOutboxPath(stateDir = storageStateDir()): string {
  return path.join(stateDir, CHANNEL_SYNC_OUTBOX_FILE)
}
export function workStatePathForStateDir(stateDir: string): string {
  return path.join(path.resolve(stateDir), 'gateway.db')
}
export function restoreTargetPath(name: string, stateDir = storageStateDir()): string {
  const nameError = validateBackupFileName(name)
  if (nameError) throw new Error(nameError)
  if (name === 'gateway.db') {
    const target = workStatePathForStateDir(stateDir)
    assertChildPath(stateDir, target, `restore target escapes Gateway state directory: ${name}`)
    return target
  }
  const target = path.resolve(stateDir, name)
  assertChildPath(stateDir, target, `restore target escapes Gateway state directory: ${name}`)
  return target
}
export function recoveryDrillId(now: Date, label?: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const suffix = label ? '-' + label.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 48) : ''
  return `recovery-drill-${stamp}${suffix}`
}
export function normalizeBackupPath(inputPath: string): string {
  return path.basename(inputPath) === 'metadata.json' ? path.dirname(inputPath) : inputPath
}
export function validateBackupFileName(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name) return 'backup metadata contains an invalid file name'
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || path.basename(name) !== name) {
    return `backup file name must be a simple basename: ${String(name)}`
  }
  if (!BACKUP_FILE_NAMES.has(name)) return `unsupported backup file in metadata: ${name}`
  return undefined
}
export function backupFilePath(backupPath: string, name: string): string {
  const target = path.resolve(backupPath, name)
  assertChildPath(backupPath, target, `backup file escapes backup directory: ${name}`)
  return target
}
export function assertChildPath(parent: string, target: string, message: string): void {
  const root = path.resolve(parent)
  const resolved = path.resolve(target)
  if (path.dirname(resolved) !== root) throw new Error(message)
}
export function readMetadata(backupPath: string): StorageBackupMetadata | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(backupPath, 'metadata.json'), 'utf-8')) } catch { return undefined }
}
export function summarizeRecoveryDrillEvidence(drillPath: string): StorageRecoveryDrillSummary | undefined {
  try {
    const evidencePath = path.join(drillPath, 'evidence.json')
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8')) as StorageRecoveryDrillEvidence
    if (!evidence?.id || !evidence.startedAt || !evidence.completedAt) return undefined
    const checks = Array.isArray(evidence.checks) ? evidence.checks : []
    return {
      id: evidence.id,
      status: evidence.status,
      startedAt: evidence.startedAt,
      completedAt: evidence.completedAt,
      path: drillPath,
      evidencePath: evidence.evidencePath || evidencePath,
      reportPath: evidence.reportPath || path.join(drillPath, 'report.md'),
      backupPath: evidence.backup?.path,
      restoredStateDir: evidence.restore?.stateDir,
      checks: {
        total: checks.length,
        passed: checks.filter(check => check.status === 'pass').length,
        failed: checks.filter(check => check.status === 'fail').length,
      },
      error: evidence.status === 'fail' ? checks.filter(check => check.status === 'fail').map(check => check.summary).join('; ') : undefined,
    }
  } catch {
    return undefined
  }
}
export function countsMatchBackup(actual: StorageBackupMetadata['counts'], expected: StorageBackupMetadata['counts']): boolean {
  return BACKUP_COUNT_KEYS.every(key => actual[key] === expected[key])
}
export function checkDatabaseIntegrity(filePath: string): string {
  try {
    const db = openSqliteReadOnly(filePath)
    try { return String(getRow(db, 'PRAGMA integrity_check')?.['integrity_check'] || 'unknown') } finally { db.close() }
  } catch (err: any) {
    return err?.message || String(err)
  }
}
export function lifecycleCount(db: DatabaseSync, table: string): number {
  if (!sqliteTableExists(db, table)) return 0
  return lifecycleCountSql(db, `SELECT COUNT(*) AS count FROM ${table}`)
}
export function lifecycleCountSql(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as any
  const count = Number(row?.count || 0)
  return Number.isFinite(count) ? count : 0
}
export function withReadOnlyStorageDb<T>(dbPath: string, fn: (readOnlyDbPath: string) => T): T {
  const target = prepareReadOnlyDbTarget(dbPath)
  try {
    return fn(target.path)
  } finally {
    target.cleanup()
  }
}
function prepareReadOnlyDbTarget(dbPath: string): { path: string; cleanup: () => void } {
  const resolved = path.resolve(dbPath)
  if (!hasNonEmptyWal(resolved)) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-readonly-'))
    const tempDbPath = path.join(tempDir, path.basename(resolved))
    fs.copyFileSync(resolved, tempDbPath)
    return { path: tempDbPath, cleanup: () => { try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {} } }
  }
  const sidecarsBefore = readOnlySidecarSnapshot(resolved)
  return { path: resolved, cleanup: () => cleanupGeneratedReadOnlySidecars(resolved, sidecarsBefore) }
}
function hasNonEmptyWal(dbPath: string): boolean {
  try {
    return fs.statSync(`${path.resolve(dbPath)}-wal`).size > 0
  } catch {
    return false
  }
}
function readOnlySidecarSnapshot(dbPath: string): Set<string> {
  return new Set(sqliteSidecars(dbPath).filter(file => fs.existsSync(file)))
}
function cleanupGeneratedReadOnlySidecars(dbPath: string, sidecarsBefore: Set<string>): void {
  for (const file of sqliteSidecars(dbPath)) {
    if (sidecarsBefore.has(file)) continue
    try { fs.rmSync(file, { force: true }) } catch {}
  }
}
function sqliteSidecars(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`]
}
