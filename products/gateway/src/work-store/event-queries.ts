/**
 * Work event / audit ledger / delegation-route list and append APIs (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { AuditLedgerQueryOptions } from '../audit-ledger.js'
import {
  openWorkDb,
  queryRows,
  withWorkDb,
  withWorkDbReadOnly,
  workStatePath,
} from './db.js'
import { assertNoStorageOperationInProgress } from './storage-lock.js'
import { pruneWorkEvents } from './retention.js'
import { rowToAuditLedger, rowToEvent } from './row-mappers.js'
import {
  appendWorkEventRow,
  appendAuditLedgerRowForWorkEvent,
  upsertDelegationProgressRouteReceiptFromEvent,
  rowToDelegationProgressRouteReceipt,
} from './event-append.js'
import {
  WORK_EVENT_TYPE_QUERY_LIMIT,
  type AuditEventInput,
  type AuditLedgerRecord,
  type DelegationProgressRouteReceiptRecord,
  type WorkEventRecord,
} from './types.js'

export function appendWorkEvent(type: string, subjectId?: string, payload: Record<string, unknown> = {}, filePath = workStatePath()): number {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const id = appendWorkEventRow(db, type, subjectId, payload)
      db.exec('COMMIT')
      return id
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function appendWorkEvents(events: Array<{ type: string; subjectId?: string; payload?: Record<string, unknown> }>, filePath = workStatePath()): number[] {
  if (!events.length) return []
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
    const ids: number[] = []
    for (const event of events) {
      const payload = event.payload || {}
      const result = insert.run(event.type, event.subjectId || null, JSON.stringify(payload), now) as any
      const id = Number(result?.lastInsertRowid || 0)
      ids.push(id)
      const record = { id, type: event.type, subjectId: event.subjectId, payload, createdAt: now }
      appendAuditLedgerRowForWorkEvent(db, record)
      upsertDelegationProgressRouteReceiptFromEvent(db, record)
    }
    pruneWorkEvents(db, now)
    db.exec('COMMIT')
    return ids
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  } finally {
    db.close()
  }
}

export function appendAuditEvent(input: AuditEventInput, filePath = workStatePath()): number {
  return appendWorkEvent('audit.security', input.target, {
    actor: input.actor,
    source: input.source,
    operation: input.operation,
    target: input.target,
    result: input.result,
    details: input.details || {},
  }, filePath)
}

export function listWorkEvents(limit = 100, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDb(filePath, db => listWorkEventsFromDb(db, limit))
}

export function listWorkEventsReadOnly(limit = 100, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDbReadOnly(filePath, db => listWorkEventsFromDb(db, limit))
}

function listWorkEventsFromDb(db: DatabaseSync, limit = 100): WorkEventRecord[] {
  const rows = queryRows(db, 'SELECT * FROM events ORDER BY id DESC LIMIT ?', Math.max(1, Math.min(limit, 500)))
  return rows.reverse().map(rowToEvent)
}

export function listRecentWorkEvents(type: string, subjectId: string, since: Date, limit = 1000, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDb(filePath, db => {
    const rows = db.prepare('SELECT * FROM events WHERE type = ? AND subject_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?')
      .all(type, subjectId, since.toISOString(), Math.max(1, Math.min(limit, 5000))) as any[]
    return rows.map(rowToEvent)
  })
}

export function listWorkEventsByType(type: string, limit = 1000, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDb(filePath, db => {
    const rows = db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?')
      .all(type, Math.max(1, Math.min(limit, WORK_EVENT_TYPE_QUERY_LIMIT))) as any[]
    return rows.reverse().map(rowToEvent)
  })
}

export function listDelegationProgressRouteReceipts(options: {
  dedupeKey?: string
  progressKey?: string
  idempotencyKey?: string
  since?: Date
  limit?: number
} = {}, filePath = workStatePath()): DelegationProgressRouteReceiptRecord[] {
  return withWorkDb(filePath, db => listDelegationProgressRouteReceiptsFromDb(db, options))
}

export function listDelegationProgressRouteReceiptsReadOnly(options: {
  dedupeKey?: string
  progressKey?: string
  idempotencyKey?: string
  since?: Date
  limit?: number
} = {}, filePath = workStatePath()): DelegationProgressRouteReceiptRecord[] {
  return withWorkDbReadOnly(filePath, db => listDelegationProgressRouteReceiptsFromDb(db, options))
}

function listDelegationProgressRouteReceiptsFromDb(db: DatabaseSync, options: {
  dedupeKey?: string
  progressKey?: string
  idempotencyKey?: string
  since?: Date
  limit?: number
} = {}): DelegationProgressRouteReceiptRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.dedupeKey) {
    clauses.push('dedupe_key = ?')
    params.push(options.dedupeKey)
  }
  if (options.progressKey) {
    clauses.push('progress_key = ?')
    params.push(options.progressKey)
  }
  if (options.idempotencyKey) {
    clauses.push('idempotency_key = ?')
    params.push(options.idempotencyKey)
  }
  if (options.since) {
    clauses.push('updated_at >= ?')
    params.push(options.since.toISOString())
  }
  const limit = Math.max(1, Math.min(options.limit || 1000, WORK_EVENT_TYPE_QUERY_LIMIT))
  const rows = db.prepare(`SELECT * FROM delegation_progress_route_receipts${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC, last_event_id DESC LIMIT ?`)
    .all(...params, limit) as any[]
  return rows.map(rowToDelegationProgressRouteReceipt).filter(Boolean) as DelegationProgressRouteReceiptRecord[]
}

export function listAuditLedgerEntries(options: AuditLedgerQueryOptions = {}, filePath = workStatePath()): AuditLedgerRecord[] {
  return withWorkDb(filePath, db => listAuditLedgerEntriesFromDb(db, options))
}

export function listAuditLedgerEntriesReadOnly(options: AuditLedgerQueryOptions = {}, filePath = workStatePath()): AuditLedgerRecord[] {
  return withWorkDbReadOnly(filePath, db => listAuditLedgerEntriesFromDb(db, options))
}

function listAuditLedgerEntriesFromDb(db: DatabaseSync, options: AuditLedgerQueryOptions = {}): AuditLedgerRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.class) {
    clauses.push('class = ?')
    params.push(options.class)
  }
  if (options.sourceEventType) {
    clauses.push('source_event_type = ?')
    params.push(options.sourceEventType)
  }
  if (options.traceId) {
    clauses.push('trace_id = ?')
    params.push(options.traceId)
  }
  if (options.correlationId) {
    clauses.push('correlation_id = ?')
    params.push(options.correlationId)
  }
  if (options.since) {
    clauses.push('occurred_at >= ?')
    params.push(options.since)
  }
  if (options.until) {
    clauses.push('occurred_at <= ?')
    params.push(options.until)
  }
  const limit = Math.max(1, Math.min(options.limit || 100, 1000))
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = queryRows(db, `SELECT * FROM audit_ledger ${where} ORDER BY id DESC LIMIT ?`, ...params, limit)
  return rows.reverse().map(rowToAuditLedger)
}

export function listAllWorkEventsByType(type: string, filePath = workStatePath()): WorkEventRecord[] {
  return withWorkDb(filePath, db => {
    const rows = queryRows(db, 'SELECT * FROM events WHERE type = ? ORDER BY id ASC', type)
    return rows.map(rowToEvent)
  })
}
