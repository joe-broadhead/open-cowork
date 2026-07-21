import type { DatabaseSync } from 'node:sqlite'
import { getConfig } from '../config.js'
import {
  AUDIT_LEDGER_RETENTION_ANCHOR_HASH_KEY,
  AUDIT_LEDGER_RETENTION_MS,
  DURABLE_WORK_EVENT_TYPES,
  MAX_AUDIT_LEDGER_ROWS,
  MAX_WORK_EVENT_ROWS,
  WORK_EVENT_RETENTION_MS,
} from './types.js'
import { openWorkDb, workStatePath } from './db.js'
import { assertNoStorageOperationInProgress } from './storage-lock.js'

export interface AuditLedgerRetentionResult {
  pruned: number
  retained: number
  anchorId?: number
  anchorHash?: string
}

export interface RowRetentionResult {
  pruned: number
}

export interface WorkStoreRetentionMaintenanceOptions {
  now?: Date
  auditLedgerMaxAgeMs?: number
  auditLedgerMaxRows?: number
  /** Rows deleted per transaction during the chunked ledger prune (test hook). */
  auditLedgerDeleteChunkRows?: number
  /**
   * Terminal, non-lastRun, non-current runs older than this are pruned. Defaults
   * to `storage.retention.runsMaxAgeDays`. Set to 0 to skip run retention.
   */
  runsMaxAgeMs?: number
  /**
   * Idle receipt-table rows older than this are pruned. Defaults to
   * `storage.retention.receiptsMaxAgeDays`. Set to 0 to skip receipt retention.
   */
  receiptsMaxAgeMs?: number
  /** Rows deleted per transaction during the chunked run/receipt prunes (test hook). */
  rowDeleteChunkRows?: number
}

export interface WorkStoreRetentionMaintenanceResult {
  auditLedger: AuditLedgerRetentionResult
  runs: RowRetentionResult
  receipts: RowRetentionResult
}

const AUDIT_LEDGER_RETENTION_DELETE_CHUNK_ROWS = 10_000
const ROW_RETENTION_DELETE_CHUNK_ROWS = 5_000
const DAY_MS = 24 * 60 * 60 * 1000

// Idle receipt states that carry no in-flight lease/delivery obligation, so an
// old row in one of these states is safe to prune. Active states ('starting',
// 'leased', 'pending', 'deferred') are excluded belt-and-suspenders — at the
// retention window no lease/delivery is still live, but the guard keeps the
// prune correct even if the window is configured aggressively low.
const RECEIPT_TABLES: ReadonlyArray<{ table: string; timeColumn: string; skipWhere?: string }> = [
  { table: 'task_dispatch_receipts', timeColumn: 'created_at', skipWhere: "status = 'starting'" },
  { table: 'supervisor_wakeup_receipts', timeColumn: 'created_at', skipWhere: "status = 'leased'" },
  { table: 'delegation_progress_receipts', timeColumn: 'created_at' },
  { table: 'delegation_progress_route_receipts', timeColumn: 'created_at', skipWhere: "state IN ('pending', 'deferred')" },
]

/**
 * Enforce the audit ledger retention policy (age window plus row cap).
 *
 * The ledger is hash-chained in id order, so retention only ever removes a
 * contiguous prefix of the oldest rows. The entry hash of the newest pruned
 * row is stored in meta as the retention anchor; chain verification seeds
 * from that anchor so the retained suffix still verifies, and appends into an
 * emptied ledger continue the chain from the anchor.
 *
 * The prune is chunked: the boundary and final anchor are computed once, then
 * rows are deleted in bounded batches, each in its own short transaction, so a
 * first retention pass over a long-lived ledger never holds one unbounded
 * write transaction across the ledger's secondary indexes.
 */
export function runWorkStoreRetentionMaintenance(filePath = workStatePath(), options: WorkStoreRetentionMaintenanceOptions = {}): WorkStoreRetentionMaintenanceResult {
  assertNoStorageOperationInProgress(filePath)
  const retentionConfig = getConfig().storage.retention
  const now = options.now || new Date()
  const runsMaxAgeMs = Math.max(0, options.runsMaxAgeMs ?? retentionConfig.runsMaxAgeDays * DAY_MS)
  const receiptsMaxAgeMs = Math.max(0, options.receiptsMaxAgeMs ?? retentionConfig.receiptsMaxAgeDays * DAY_MS)
  const chunkRows = Math.max(1, options.rowDeleteChunkRows ?? ROW_RETENTION_DELETE_CHUNK_ROWS)
  const db = openWorkDb(filePath)
  try {
    const auditLedger = enforceAuditLedgerRetention(db, options)
    const runs = runsMaxAgeMs > 0
      ? enforceRunRetention(db, new Date(now.getTime() - runsMaxAgeMs).toISOString(), chunkRows)
      : { pruned: 0 }
    const receipts = receiptsMaxAgeMs > 0
      ? enforceReceiptRetention(db, new Date(now.getTime() - receiptsMaxAgeMs).toISOString(), chunkRows)
      : { pruned: 0 }
    return { auditLedger, runs, receipts }
  } finally {
    db.close()
  }
}

/**
 * Prune truly-old run history while preserving every live consumer's view.
 *
 * A run is deleted only when it is ALL of:
 *  - terminal (status != 'running'),
 *  - started before the cutoff (older than the configured window, which sits
 *    well outside the analytics/governance read windows),
 *  - NOT the most-recent run for its task — every run at the task's max
 *    started_at is kept, so `getWorkQueueSnapshot`'s per-task `lastRun` survives
 *    regardless of age (ties at the max instant are all preserved), and
 *  - NOT referenced by any task's current_run_id.
 *
 * The delete is chunked (one bounded transaction per batch) and the preserved
 * set is stable across batches (we never delete a task's max-started_at run or a
 * current run), so the loop is monotonic and terminates.
 */
function enforceRunRetention(db: DatabaseSync, cutoff: string, chunkRows: number): RowRetentionResult {
  const selectBatch = db.prepare(
    `SELECT r.id AS id, r.task_id AS task_id FROM runs r
       WHERE r.status != 'running'
         AND r.started_at < ?
         AND r.id NOT IN (SELECT current_run_id FROM tasks WHERE current_run_id IS NOT NULL)
         AND r.started_at < (SELECT MAX(r2.started_at) FROM runs r2 WHERE r2.task_id = r.task_id)
       LIMIT ?`,
  )
  const deleteById = db.prepare('DELETE FROM runs WHERE id = ?')
  let pruned = 0
  while (true) {
    db.exec('BEGIN IMMEDIATE')
    let deleted = 0
    try {
      const rows = selectBatch.all(cutoff, chunkRows) as Array<{ id: string; task_id: string }>
      const prunedByTask = new Map<string, number>()
      for (const row of rows) {
        const changes = Number((deleteById.run(row.id) as { changes?: number }).changes || 0)
        deleted += changes
        if (changes > 0) prunedByTask.set(row.task_id, (prunedByTask.get(row.task_id) || 0) + changes)
      }
      incrementPrunedRunCounters(db, prunedByTask)
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
    pruned += deleted
    if (deleted === 0) break
  }
  return { pruned }
}

function incrementPrunedRunCounters(db: DatabaseSync, prunedByTask: Map<string, number>): void {
  if (!prunedByTask.size) return
  const now = new Date().toISOString()
  const upsert = db.prepare(`INSERT INTO task_run_counters (task_id, pruned_runs, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      pruned_runs = task_run_counters.pruned_runs + excluded.pruned_runs,
      updated_at = excluded.updated_at`)
  for (const [taskId, count] of prunedByTask) upsert.run(taskId, count, now)
}

/**
 * Prune idle receipt-table rows older than the cutoff. These tables are
 * idempotency/lease/delivery ledgers with no full-history consumer (every reader
 * queries by key, by active lease/delivery state, or with a bounded recent
 * limit — verified against work-store readers), so age-based pruning is safe.
 * Rows still in an active lease/delivery state are skipped defensively.
 */
function enforceReceiptRetention(db: DatabaseSync, cutoff: string, chunkRows: number): RowRetentionResult {
  let pruned = 0
  for (const { table, timeColumn, skipWhere } of RECEIPT_TABLES) {
    const where = `${timeColumn} < ?${skipWhere ? ` AND NOT (${skipWhere})` : ''}`
    // rowid is a stable identifier on every one of these tables (none are
    // WITHOUT ROWID), so a bounded rowid batch keeps each delete transaction small.
    const deleteBatch = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`)
    while (true) {
      db.exec('BEGIN IMMEDIATE')
      let deleted = 0
      try {
        deleted = Number((deleteBatch.run(cutoff, chunkRows) as { changes?: number }).changes || 0)
        db.exec('COMMIT')
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
        throw err
      }
      pruned += deleted
      if (deleted === 0) break
    }
  }
  return { pruned }
}

function enforceAuditLedgerRetention(db: DatabaseSync, options: WorkStoreRetentionMaintenanceOptions = {}): AuditLedgerRetentionResult {
  const now = options.now || new Date()
  const maxAgeMs = Math.max(0, options.auditLedgerMaxAgeMs ?? AUDIT_LEDGER_RETENTION_MS)
  const maxRows = Math.max(1, options.auditLedgerMaxRows ?? MAX_AUDIT_LEDGER_ROWS)
  const chunkRows = Math.max(1, options.auditLedgerDeleteChunkRows ?? AUDIT_LEDGER_RETENTION_DELETE_CHUNK_ROWS)
  const cutoff = new Date(now.getTime() - maxAgeMs).toISOString()

  // Phase 1: compute the prune boundary and the final retention anchor from a
  // single consistent snapshot before deleting anything.
  db.exec('BEGIN IMMEDIATE')
  let total = 0
  let boundaryId = 0
  let anchorId = 0
  let anchorHash = ''
  try {
    total = Number((db.prepare('SELECT COUNT(*) AS count FROM audit_ledger').get() as any)?.count || 0)
    if (total) {
      // Age boundary: prune the prefix that ends just before the oldest row
      // still inside the retention window. Using the first retained id keeps
      // the pruned region contiguous even if occurred_at is not perfectly
      // monotonic with id.
      const firstRetainedByAge = db.prepare('SELECT id FROM audit_ledger WHERE occurred_at >= ? ORDER BY id ASC LIMIT 1').get(cutoff) as any
      const ageBoundary = firstRetainedByAge?.id
        ? Number(firstRetainedByAge.id) - 1
        : Number((db.prepare('SELECT MAX(id) AS id FROM audit_ledger').get() as any)?.id || 0)

      // Row-cap boundary: keep only the newest maxRows rows.
      let capBoundary = 0
      if (total > maxRows) {
        const firstRetainedByCap = db.prepare('SELECT id FROM audit_ledger ORDER BY id DESC LIMIT 1 OFFSET ?').get(maxRows - 1) as any
        capBoundary = Number(firstRetainedByCap?.id || 0) - 1
      }

      boundaryId = Math.max(ageBoundary, capBoundary)
      if (boundaryId > 0) {
        const anchorRow = db.prepare('SELECT id, entry_hash FROM audit_ledger WHERE id <= ? ORDER BY id DESC LIMIT 1').get(boundaryId) as any
        if (anchorRow?.entry_hash) {
          anchorId = Number(anchorRow.id)
          anchorHash = String(anchorRow.entry_hash)
        }
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
  if (!total) return { pruned: 0, retained: 0 }
  if (boundaryId <= 0 || !anchorHash) return { pruned: 0, retained: total }

  // Phase 2: chunked delete up to the boundary, one bounded transaction per
  // batch. Each batch advances the retention anchor to the newest row it
  // deleted inside the same transaction, so the chain verifies at every
  // intermediate point and a crash mid-prune leaves a verifiable ledger; the
  // final batch lands the anchor exactly on the boundary row's hash.
  let pruned = 0
  const setAnchor = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  while (true) {
    db.exec('BEGIN IMMEDIATE')
    let done = false
    try {
      const chunkTopRow = db.prepare('SELECT id, entry_hash FROM audit_ledger WHERE id <= ? ORDER BY id ASC LIMIT 1 OFFSET ?').get(boundaryId, chunkRows - 1) as any
      const chunkTop = chunkTopRow?.entry_hash
        ? { id: Number(chunkTopRow.id), hash: String(chunkTopRow.entry_hash) }
        : { id: anchorId, hash: anchorHash }
      const result = db.prepare('DELETE FROM audit_ledger WHERE id <= ?').run(chunkTop.id) as any
      const changes = Number(result?.changes || 0)
      if (changes > 0) setAnchor.run(AUDIT_LEDGER_RETENTION_ANCHOR_HASH_KEY, chunkTop.hash)
      pruned += changes
      done = changes === 0 || chunkTop.id >= anchorId
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
    if (done) break
  }
  if (!pruned) return { pruned: 0, retained: total }
  return { pruned, retained: total - pruned, anchorId, anchorHash }
}

export function readAuditLedgerRetentionAnchorHash(db: DatabaseSync): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(AUDIT_LEDGER_RETENTION_ANCHOR_HASH_KEY) as any
    return row?.value ? String(row.value) : undefined
  } catch {
    return undefined
  }
}

const WORK_EVENT_PRUNE_MIN_INTERVAL_MS = 60_000
const WORK_EVENT_PRUNED_AT_KEY = 'eventsAgePrunedAt'

export function pruneWorkEvents(db: DatabaseSync, nowIso: string): void {
  // Best-effort housekeeping, throttled as a whole: once durable rows alone
  // exceed the row cap, the cap probe below always finds a boundary and the
  // DELETE range-scans every durable row under it (`type NOT IN` gets no index
  // help) while deleting nothing — running that on every append costs
  // milliseconds per mutation forever. The cap and the 30-day age cutoff are
  // both approximate between runs, exactly like the age prune already was.
  const lastRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(WORK_EVENT_PRUNED_AT_KEY) as any
  const lastPruneMs = Date.parse(String(lastRow?.value || ''))
  if (Number.isFinite(lastPruneMs) && Date.parse(nowIso) - lastPruneMs < WORK_EVENT_PRUNE_MIN_INTERVAL_MS) return
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(WORK_EVENT_PRUNED_AT_KEY, nowIso)

  const durable = `(${DURABLE_WORK_EVENT_TYPES.map(type => `'${type.replace(/'/g, "''")}'`).join(', ')})`

  // Row-cap enforcement: a single primary-key probe at the cap boundary finds
  // the newest row that falls outside the retained window (if any). Deleting
  // non-durable rows at or below that id is equivalent to the old
  // "NOT IN newest-10k ids" anti-join without materializing the id set.
  const capBoundary = db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?').get(MAX_WORK_EVENT_ROWS) as any
  if (capBoundary?.id) {
    db.prepare(`DELETE FROM events WHERE type NOT IN ${durable} AND id <= ?`).run(Number(capBoundary.id))
  }

  // Age-based pruning scans the unindexed created_at column; the 30-day cutoff
  // makes sub-minute staleness immaterial.
  const cutoff = new Date(Date.parse(nowIso) - WORK_EVENT_RETENTION_MS).toISOString()
  db.prepare(`DELETE FROM events WHERE created_at < ? AND type NOT IN ${durable}`).run(cutoff)
}
