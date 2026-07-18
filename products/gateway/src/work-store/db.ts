/**
 * Stateless work-store SQLite connection, caching, and row-decode helpers.
 *
 * Split verbatim out of `work-store.ts` (behavior-preserving pure move). Every
 * connection open/close/caching primitive and the low-level row/JSON decoders
 * live here so the transactional mutation core and the extracted read-only
 * query surfaces reuse one connection discipline instead of re-implementing it.
 * Signatures and names are identical to their previous `work-store.ts`
 * definitions; `work-store.ts` re-exports them so external importers are
 * unchanged.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseSync } from 'node:sqlite'
import { getConfigDir } from '../config.js'
import { assertSupportedWorkStoreSchemaVersion, CURRENT_WORK_STORE_SCHEMA_VERSION, migrateWorkStoreSchema, workStoreSchemaVersion } from './schema.js'

export interface WorkDbLeadershipEpoch {
  scope: string
  leaderId: string
  fencingToken: string
  leaseExpiresAt: string
  now: () => number
}

export class StaleWorkDbLeadershipError extends Error {
  readonly code = 'STALE_DAEMON_LEADERSHIP'

  constructor(message = 'Scheduler transaction refused because its daemon leadership epoch is stale') {
    super(message)
    this.name = 'StaleWorkDbLeadershipError'
  }
}

const workDbLeadershipEpoch = new AsyncLocalStorage<WorkDbLeadershipEpoch>()
let workDbLeadershipEpochProvider: (() => WorkDbLeadershipEpoch | undefined) | undefined

export function withWorkDbLeadershipEpoch<T>(epoch: WorkDbLeadershipEpoch, fn: () => T): T {
  return workDbLeadershipEpoch.run(epoch, fn)
}

export function currentWorkDbLeadershipEpoch(): WorkDbLeadershipEpoch | undefined {
  return workDbLeadershipEpoch.getStore()
}

export function setWorkDbLeadershipEpochProvider(provider: (() => WorkDbLeadershipEpoch | undefined) | undefined): void {
  workDbLeadershipEpochProvider = provider
}

export function isStaleWorkDbLeadershipError(error: unknown): error is StaleWorkDbLeadershipError {
  return error instanceof StaleWorkDbLeadershipError || (error as { code?: unknown } | null)?.code === 'STALE_DAEMON_LEADERSHIP'
}

export function workStatePath(): string {
  return path.join(process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir(), 'gateway.db')
}

export const STORAGE_RESTORE_JOURNAL_FILE = '.storage-restore-journal.json'

export interface StorageRestoreJournalEntry {
  name: string
  expectedSha256?: string
  hadTarget: boolean
}

export interface StorageRestoreJournal {
  version: 1
  operationId: string
  stateDir: string
  stageDirName: string
  entries: StorageRestoreJournalEntry[]
  createdAt: string
}

export interface StorageRestoreRecoveryResult {
  recovered: boolean
  action?: 'roll_forward' | 'roll_back'
  installed: string[]
}

export function storageRestoreJournalPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), STORAGE_RESTORE_JOURNAL_FILE)
}

export function writeStorageRestoreJournal(journal: StorageRestoreJournal): void {
  const validated = validateStorageRestoreJournal(journal, journal.stateDir)
  const journalPath = storageRestoreJournalPath(validated.stateDir)
  const temporary = `${journalPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(validated, null, 2), { mode: 0o600 })
  fsyncFile(temporary)
  fs.renameSync(temporary, journalPath)
  try { fs.chmodSync(journalPath, 0o600) } catch {}
  fsyncDirectory(validated.stateDir)
}

/**
 * Complete or roll back a restore whose durable journal survived interruption.
 * Every target is either still staged or already matches its recorded digest;
 * otherwise the previous generation is restored from the staged rollback copy.
 */
export function recoverInterruptedStorageRestore(
  stateDir: string,
  options: { afterInstall?: (entry: StorageRestoreJournalEntry, installedCount: number) => void } = {},
): StorageRestoreRecoveryResult {
  const resolvedStateDir = path.resolve(stateDir)
  const journalPath = storageRestoreJournalPath(resolvedStateDir)
  if (!fs.existsSync(journalPath)) {
    sweepOrphanedStorageRestoreStages(resolvedStateDir)
    return { recovered: false, installed: [] }
  }
  const journal = validateStorageRestoreJournal(readRestoreJournal(journalPath), resolvedStateDir)
  const stageDir = path.join(resolvedStateDir, journal.stageDirName)
  const newDir = path.join(stageDir, 'new')
  const rollbackDir = path.join(stageDir, 'rollback')
  const canRollForward = journal.entries.every(entry => {
    if (!entry.expectedSha256) return true
    const target = path.join(resolvedStateDir, entry.name)
    const staged = path.join(newDir, entry.name)
    return fileMatchesSha256(target, entry.expectedSha256) || fileMatchesSha256(staged, entry.expectedSha256)
  })
  const installed: string[] = []

  if (canRollForward) {
    for (const entry of journal.entries) {
      const target = path.join(resolvedStateDir, entry.name)
      if (entry.expectedSha256) {
        if (!fileMatchesSha256(target, entry.expectedSha256)) {
          const staged = path.join(newDir, entry.name)
          if (!fileMatchesSha256(staged, entry.expectedSha256)) throw new Error(`restore journal staged file is missing or corrupt: ${entry.name}`)
          fs.renameSync(staged, target)
          try { fs.chmodSync(target, 0o600) } catch {}
        }
      } else {
        fs.rmSync(target, { force: true })
      }
      fsyncDirectory(resolvedStateDir)
      installed.push(target)
      options.afterInstall?.(entry, installed.length)
    }
    finishStorageRestoreJournal(journalPath, stageDir, resolvedStateDir)
    return { recovered: true, action: 'roll_forward', installed }
  }

  for (const entry of journal.entries) {
    const target = path.join(resolvedStateDir, entry.name)
    const rollback = path.join(rollbackDir, entry.name)
    if (entry.hadTarget) {
      if (!fs.existsSync(rollback)) throw new Error(`restore rollback copy is missing: ${entry.name}`)
      fs.copyFileSync(rollback, target)
      fsyncFile(target)
      try { fs.chmodSync(target, 0o600) } catch {}
    } else {
      fs.rmSync(target, { force: true })
    }
    fsyncDirectory(resolvedStateDir)
    installed.push(target)
  }
  finishStorageRestoreJournal(journalPath, stageDir, resolvedStateDir)
  return { recovered: true, action: 'roll_back', installed }
}

function finishStorageRestoreJournal(journalPath: string, stageDir: string, stateDir: string): void {
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.rmSync(journalPath, { force: true })
  fsyncDirectory(stateDir)
}

function sweepOrphanedStorageRestoreStages(stateDir: string): void {
  if (!fs.existsSync(stateDir)) return
  let removed = false
  for (const name of fs.readdirSync(stateDir)) {
    if (!/^\.restore-stage-[A-Za-z0-9._-]+$/.test(name)) continue
    const candidate = path.join(stateDir, name)
    let stat: fs.Stats
    try { stat = fs.lstatSync(candidate) } catch { continue }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    fs.rmSync(candidate, { recursive: true, force: true })
    removed = true
  }
  if (removed) fsyncDirectory(stateDir)
}

function readRestoreJournal(journalPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  } catch (err) {
    throw new Error(`storage restore journal is unreadable: ${(err as Error)?.message || String(err)}`)
  }
}

function validateStorageRestoreJournal(value: unknown, expectedStateDir: string): StorageRestoreJournal {
  const row = value as Partial<StorageRestoreJournal> | null
  const stateDir = path.resolve(String(row?.stateDir || ''))
  const stageDirName = String(row?.stageDirName || '')
  if (row?.version !== 1 || stateDir !== path.resolve(expectedStateDir)) throw new Error('storage restore journal has an unsupported version or state directory')
  if (!/^\.restore-stage-[A-Za-z0-9._-]+$/.test(stageDirName)) throw new Error('storage restore journal has an unsafe stage directory')
  if (!Array.isArray(row.entries) || !row.entries.length) throw new Error('storage restore journal has no entries')
  const seen = new Set<string>()
  const entries = row.entries.map(raw => {
    const entry = raw as Partial<StorageRestoreJournalEntry>
    const name = String(entry.name || '')
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..' || seen.has(name)) throw new Error(`storage restore journal has an unsafe or duplicate target: ${name}`)
    seen.add(name)
    const expectedSha256 = entry.expectedSha256 === undefined ? undefined : String(entry.expectedSha256)
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`storage restore journal has an invalid digest: ${name}`)
    if (typeof entry.hadTarget !== 'boolean') throw new Error(`storage restore journal is missing target history: ${name}`)
    return { name, expectedSha256, hadTarget: entry.hadTarget }
  })
  return {
    version: 1,
    operationId: String(row.operationId || ''),
    stateDir,
    stageDirName,
    entries,
    createdAt: String(row.createdAt || ''),
  }
}

function fileMatchesSha256(filePath: string, expected: string): boolean {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') === expected
  } catch {
    return false
  }
}

export function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

export function fsyncDirectory(dirPath: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(dirPath, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Some filesystems do not permit directory fsync. File fsync plus atomic
    // rename remains the strongest portable fallback available to this tool.
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

const initializedWorkDbFiles = new Set<string>()

/**
 * Long-lived per-path connection + prepared-statement cache.
 *
 * Every store op used to open a fresh DatabaseSync (busy_timeout + WAL +
 * foreign_keys PRAGMAs + a 3-file chmod hardening pass ≈ up to 6 syscalls) and
 * recompile all ~154 prepared statements before closing. That fixed per-op cost
 * dominated latency at low history depth. We now keep one connection per
 * resolved path, apply the PRAGMAs + permission hardening once, and cache
 * prepared statements on the connection so each distinct SQL string is compiled
 * at most once per process.
 *
 * Correctness:
 * - BEGIN IMMEDIATE semantics are unchanged. Between transactions the connection
 *   sits in autocommit holding no lock, so cross-process WAL serialization and
 *   the writer/standby leadership model behave exactly as with fresh handles.
 * - Callers still invoke db.close(); on a cached handle that is a no-op — the
 *   real handle stays open until closeWorkDb()/disposeWorkStore(). Read-only
 *   connections (openWorkDbReadOnly) are never cached and close for real.
 * - A bounded LRU keeps at most WORK_DB_CACHE_LIMIT handles open so a single
 *   process touching hundreds of temp databases (the test suite) cannot leak
 *   fds. Only idle non-current-path handles are evicted, and a cache miss just
 *   re-opens, so eviction is always safe.
 * - Backup/restore/test-reset/graceful-shutdown call closeWorkDb() before the
 *   file is checkpointed, copied, overwritten, or deleted.
 */
interface CachedWorkDb {
  db: DatabaseSync
  realClose: () => void
  /**
   * Inode of the main db file at open time. If the file is deleted or replaced
   * out-of-band (test harnesses that rm their state dir between cases; an
   * externally-swapped database), a cache hit would otherwise keep writing to
   * the ghost inode. On every hit we re-stat and drop the handle if the inode
   * changed, so the cache self-heals rather than serving a stale connection.
   */
  ino: number
}
const workDbCache = new Map<string, CachedWorkDb>()
const WORK_DB_CACHE_LIMIT = 16

// Paths currently inside a live withWorkDb/mutateWorkState call (refcounted for
// re-entrant/nested opens). A path in this set holds a handle that may be mid
// BEGIN IMMEDIATE, so the LRU must never evict (realClose) it out from under an
// open transaction — doing so loses the write when COMMIT hits a finalized
// handle. Idle (unreferenced) connections are still evicted normally.
const activeWorkDbPaths = new Map<string, number>()

export function markWorkDbActive(dbPath: string): void {
  activeWorkDbPaths.set(dbPath, (activeWorkDbPaths.get(dbPath) || 0) + 1)
}

export function unmarkWorkDbActive(dbPath: string): void {
  const next = (activeWorkDbPaths.get(dbPath) || 0) - 1
  if (next > 0) activeWorkDbPaths.set(dbPath, next)
  else activeWorkDbPaths.delete(dbPath)
}

function currentInode(dbPath: string): number | undefined {
  try { return fs.statSync(dbPath).ino } catch { return undefined }
}

function installWorkDbStatementCache(db: DatabaseSync): void {
  const rawPrepare = db.prepare.bind(db)
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  ;(db as { prepare: (sql: string) => ReturnType<DatabaseSync['prepare']> }).prepare = (sql: string) => {
    let stmt = cache.get(sql)
    if (!stmt) {
      stmt = rawPrepare(sql)
      cache.set(sql, stmt)
    }
    return stmt
  }
}

function installWorkDbTransactionFence(db: DatabaseSync): void {
  const rawExec = db.exec.bind(db)
  const rawPrepare = db.prepare.bind(db)
  let transactionOpen = false
  let transactionEpoch: WorkDbLeadershipEpoch | undefined
  let transactionFenceActive = false

  ;(db as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (isBeginSql(sql)) {
      const fence = resolveWorkDbLeadershipFence()
      rawExec(sql)
      transactionOpen = true
      transactionFenceActive = fence.required
      transactionEpoch = fence.epoch
      if (!fence.epoch) return
      try {
        assertWorkDbLeadershipEpoch(db, fence.epoch)
      } catch (err) {
        try { rawExec('ROLLBACK') } catch {}
        transactionOpen = false
        transactionFenceActive = false
        transactionEpoch = undefined
        throw err
      }
      return
    }
    if (isCommitSql(sql)) {
      try {
        if (transactionFenceActive && transactionEpoch) assertWorkDbLeadershipEpoch(db, transactionEpoch)
        rawExec(sql)
      } catch (err) {
        try { rawExec('ROLLBACK') } catch {}
        throw err
      } finally {
        transactionOpen = false
        transactionFenceActive = false
        transactionEpoch = undefined
      }
      return
    }
    if (isRollbackSql(sql)) {
      rawExec(sql)
      transactionOpen = false
      transactionFenceActive = false
      transactionEpoch = undefined
      return
    }
    if (!isPotentiallyMutatingExec(sql)) {
      rawExec(sql)
      return
    }
    runFencedWorkDbMutation(db, rawExec, () => rawExec(sql), transactionOpen, transactionFenceActive ? transactionEpoch : undefined)
  }

  ;(db as { prepare: DatabaseSync['prepare'] }).prepare = ((sql: string) => {
    const statement = rawPrepare(sql)
    if (!isPotentiallyMutatingStatement(sql)) return statement
    const rawRun = statement.run.bind(statement)
    const fencedRun = (...params: any[]) =>
      runFencedWorkDbMutation(db, rawExec, () => rawRun(...params), transactionOpen, transactionFenceActive ? transactionEpoch : undefined)
    ;(statement as any).run = fencedRun
    return statement
  }) as DatabaseSync['prepare']
}

function assertReusableWorkDbHandle(db: DatabaseSync): void {
  const foundVersion = workStoreSchemaVersion(db)
  assertSupportedWorkStoreSchemaVersion(foundVersion)
  const openFence = inspectWorkDbLeadershipFence()
  if (openFence.epoch) assertWorkDbLeadershipEpoch(db, openFence.epoch)
}

function inspectWorkDbLeadershipFence(): { required: boolean; epoch?: WorkDbLeadershipEpoch } {
  const scopedEpoch = workDbLeadershipEpoch.getStore()
  const providerConfigured = workDbLeadershipEpochProvider !== undefined
  const epoch = scopedEpoch || workDbLeadershipEpochProvider?.()
  const required = Boolean(scopedEpoch) || providerConfigured
  return { required, epoch }
}

function resolveWorkDbLeadershipFence(): { required: boolean; epoch?: WorkDbLeadershipEpoch } {
  const fence = inspectWorkDbLeadershipFence()
  const { required, epoch } = fence
  if (required && !epoch) {
    throw new StaleWorkDbLeadershipError('Gateway write refused because this daemon does not own the writer lease')
  }
  return fence
}

function assertWorkDbLeadershipEpoch(db: DatabaseSync, epoch: WorkDbLeadershipEpoch): void {
  try {
    const now = new Date(epoch.now()).toISOString()
    const row = db.prepare(`SELECT 1 AS valid
      FROM daemon_leadership
      WHERE scope = ? AND leader_id = ? AND fencing_token = ? AND lease_expires_at > ?`).get(
      epoch.scope,
      epoch.leaderId,
      epoch.fencingToken,
      now,
    ) as { valid?: number } | undefined
    if (row?.valid !== 1) throw new StaleWorkDbLeadershipError()
  } catch (err) {
    if (isStaleWorkDbLeadershipError(err)) throw err
    throw new StaleWorkDbLeadershipError(`Gateway write could not validate daemon leadership: ${(err as Error)?.message || String(err)}`)
  }
}

function runFencedWorkDbMutation<T>(
  db: DatabaseSync,
  rawExec: (sql: string) => void,
  mutate: () => T,
  transactionOpen: boolean,
  activeEpoch?: WorkDbLeadershipEpoch,
): T {
  if (transactionOpen) {
    if (activeEpoch) assertWorkDbLeadershipEpoch(db, activeEpoch)
    else {
      const fence = resolveWorkDbLeadershipFence()
      if (fence.epoch) assertWorkDbLeadershipEpoch(db, fence.epoch)
    }
    return mutate()
  }
  const fence = resolveWorkDbLeadershipFence()
  if (!fence.required) return mutate()
  rawExec('BEGIN IMMEDIATE')
  try {
    assertWorkDbLeadershipEpoch(db, fence.epoch!)
    const result = mutate()
    assertWorkDbLeadershipEpoch(db, fence.epoch!)
    rawExec('COMMIT')
    return result
  } catch (err) {
    try { rawExec('ROLLBACK') } catch {}
    throw err
  }
}

function isBeginSql(sql: string): boolean {
  return /^\s*BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?\s*;?\s*$/i.test(sql)
}

function isCommitSql(sql: string): boolean {
  return /^\s*(?:COMMIT|END)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql)
}

function isRollbackSql(sql: string): boolean {
  return /^\s*ROLLBACK(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql)
}

function isPotentiallyMutatingExec(sql: string): boolean {
  const normalized = sql.trim().replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+/, '').trim().toUpperCase()
  if (!normalized) return false
  if (/^(?:SELECT|EXPLAIN|VALUES)\b/.test(normalized)) return false
  if (/^PRAGMA\s+(?:BUSY_TIMEOUT|FOREIGN_KEYS|JOURNAL_MODE|QUERY_ONLY)\s*=/.test(normalized)) return false
  return true
}

function isPotentiallyMutatingStatement(sql: string): boolean {
  const normalized = sql.trim().replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+/, '').trim().toUpperCase()
  return !/^(?:SELECT|EXPLAIN|PRAGMA|VALUES)\b/.test(normalized)
}

function evictIdleWorkDbConnections(keepPath: string): void {
  // Map iterates in insertion order; openWorkDb re-inserts on hit so the first
  // non-current key is the least-recently-used idle connection. Never evict a
  // path currently in use (active transaction / live with-handle): closing it
  // would finalize a handle mid-transaction and lose the pending write. If every
  // non-keepPath connection is in use we skip eviction and let the cache grow
  // transiently rather than corrupt an active writer.
  while (workDbCache.size >= WORK_DB_CACHE_LIMIT) {
    let victim: string | undefined
    for (const key of workDbCache.keys()) {
      if (key !== keepPath && !activeWorkDbPaths.has(key)) { victim = key; break }
    }
    if (victim === undefined) break
    closeWorkDb(victim)
  }
}

/**
 * Forget that a db path has been schema-initialized in this process, so the next
 * write-open re-runs the init block — crucially the forward-only "refuse a schema
 * newer than this binary" guard. Call whenever the db file is replaced out-of-band
 * (e.g. restoring a backup); otherwise the stale initialized marker makes
 * openWorkDb skip the guard and a newer-schema restore would be silently
 * downgraded (the DELETE+reinsert write path dropping unknown columns).
 */
export function resetWorkDbInitState(filePath: string): void {
  initializedWorkDbFiles.delete(path.resolve(filePath))
}

/** Close and drop the cached write handle for a path (idempotent). */
export function closeWorkDb(filePath: string): void {
  const dbPath = path.resolve(filePath)
  const cached = workDbCache.get(dbPath)
  if (!cached) return
  workDbCache.delete(dbPath)
  try { cached.realClose() } catch {}
}

/**
 * Close every cached write handle. Call from daemon graceful shutdown so the
 * process exits without dangling SQLite handles.
 */
export function disposeWorkStore(): void {
  for (const key of [...workDbCache.keys()]) closeWorkDb(key)
}

export function openWorkDb(filePath: string): DatabaseSync {
  const dbPath = path.resolve(filePath)
  const restoreJournal = storageRestoreJournalPath(path.dirname(dbPath))
  if (fs.existsSync(restoreJournal)) {
    closeWorkDb(dbPath)
    recoverInterruptedStorageRestore(path.dirname(dbPath))
    initializedWorkDbFiles.delete(dbPath)
  }
  const cached = workDbCache.get(dbPath)
  if (cached) {
    const ino = currentInode(dbPath)
    if (ino !== undefined && ino === cached.ino) {
      try {
        assertReusableWorkDbHandle(cached.db)
      } catch (err) {
        closeWorkDb(dbPath)
        initializedWorkDbFiles.delete(dbPath)
        throw err
      }
      workDbCache.delete(dbPath)
      workDbCache.set(dbPath, cached)
      return cached.db
    }
    // File vanished or was replaced under us: drop the stale handle and re-open.
    closeWorkDb(dbPath)
    initializedWorkDbFiles.delete(dbPath)
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(dbPath)
  try {
    // Install the fence before any connection open can change persistent state.
    // In particular, a standby must never migrate or switch journal mode on the
    // active writer's database merely because it served a read path.
    installWorkDbTransactionFence(db)
    db.exec('PRAGMA busy_timeout = 5000')
    const foundVersion = workStoreSchemaVersion(db)
    assertSupportedWorkStoreSchemaVersion(foundVersion)
    const openFence = inspectWorkDbLeadershipFence()
    if (openFence.required && !openFence.epoch && foundVersion < CURRENT_WORK_STORE_SCHEMA_VERSION) {
      throw new StaleWorkDbLeadershipError('Gateway schema migration refused because this daemon does not own the writer lease')
    }
    if (openFence.epoch) assertWorkDbLeadershipEpoch(db, openFence.epoch)
    if (!openFence.required || openFence.epoch) db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    // Run the cheap version guard on every physical connection open. Legacy
    // version-0 files are adopted and migrated without dropping rows; future
    // versions fail closed before a cached handle can be published.
    if (!openFence.required || openFence.epoch) migrateWorkStoreSchema(db)
    initializedWorkDbFiles.add(dbPath)
    restrictSqliteDbPermissions(dbPath)
    installWorkDbStatementCache(db)
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }
  const realClose = db.close.bind(db)
  evictIdleWorkDbConnections(dbPath)
  workDbCache.set(dbPath, { db, realClose, ino: currentInode(dbPath) ?? -1 })
  // Neutralize caller db.close(): the shared handle lives until closeWorkDb().
  ;(db as { close: () => void }).close = () => {}
  return db
}

// The WAL/SHM sidecars hold the same durable data as the main database pending
// checkpoint but are created by SQLite with the process umask. Restrict them to
// owner-only alongside the main file every time the database is write-opened;
// callers run this after `PRAGMA journal_mode = WAL` (or after schema writes)
// so the sidecars exist by the time it runs. Shared by every SQLite store in
// the gateway (work store, channel-sync outbox, daemon leadership).
export function restrictSqliteDbPermissions(dbPath: string): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
    } catch {}
  }
}

function openWorkDbReadOnly(filePath: string): DatabaseSync {
  const dbPath = path.resolve(filePath)
  if (fs.existsSync(storageRestoreJournalPath(path.dirname(dbPath)))) recoverInterruptedStorageRestore(path.dirname(dbPath))
  if (!fs.existsSync(dbPath)) throw new Error(`Gateway state database not found: ${dbPath}`)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA query_only = ON')
    assertSupportedWorkStoreSchemaVersion(workStoreSchemaVersion(db))
    return db
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }
}

/**
 * Open the writable work database, run `fn`, and always close the handle.
 * Wrappers that own an explicit transaction (BEGIN IMMEDIATE / COMMIT /
 * ROLLBACK) keep their expanded open/try/finally shells on purpose; everything
 * else routes through here.
 */
export function withWorkDb<T>(filePath: string, fn: (db: DatabaseSync) => T): T {
  const db = openWorkDb(filePath)
  const dbPath = path.resolve(filePath)
  markWorkDbActive(dbPath)
  try {
    return fn(db)
  } finally {
    unmarkWorkDbActive(dbPath)
    db.close()
  }
}

/**
 * Read-only twin of {@link withWorkDb}. Exported so the extracted read-only
 * run-aggregate query surface (`work-store/analytics-queries.ts`) reuses the
 * exact same read-only open/close discipline instead of re-implementing it.
 */
export function withWorkDbReadOnly<T>(filePath: string, fn: (db: DatabaseSync) => T): T {
  const db = openWorkDbReadOnly(filePath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/**
 * Shape of a row returned by node:sqlite. Columns decode to string | number |
 * bigint | null | Uint8Array; typing them as `unknown` forces call sites to
 * coerce through the defensive rowToX converters instead of trusting `any`.
 */
export type SqliteRow = Record<string, unknown>

/** Typed `.all()` — replaces `db.prepare(sql).all() as any[]` at query sites. */
export function queryRows(db: DatabaseSync, sql: string, ...params: unknown[]): SqliteRow[] {
  return db.prepare(sql).all(...(params as never[])) as SqliteRow[]
}

/** Typed `.get()` — replaces `db.prepare(sql).get() as any` at query sites. */
export function getRow(db: DatabaseSync, sql: string, ...params: unknown[]): SqliteRow | undefined {
  return db.prepare(sql).get(...(params as never[])) as SqliteRow | undefined
}

/**
 * Fail-closed JSON column decoder. Every raw DB column that stores JSON is
 * routed through here so a corrupt or non-string value yields the caller's
 * default instead of throwing and taking down a read/mutation (or the durable
 * audit-ledger verification path). Accepts `unknown` because SQLite columns can
 * come back null/number; only a non-empty string is parsed, and a payload that
 * decodes to null/undefined also falls back so callers never see a surprise
 * null where they expected an object/array default.
 */
export function parseJSON<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : (parsed as T)
  } catch {
    return fallback
  }
}
