/**
 * Alerts domain for Durable Gateway work-store (JOE-942 / JOE-919).
 * Behavior-preserving extract from work-store.ts.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { openWorkDb, queryRows, withWorkDb, withWorkDbReadOnly, workStatePath } from './db.js'
import { rowToAlert } from './row-mappers.js'
import { normalizeAlertEvidence, normalizeOptionalString, normalizeRequiredString } from './validators.js'
import type { AlertInput, AlertRecord, AlertSeverity, AlertStatus, AlertUpsertResult } from './types.js'
import { appendWorkEventRow } from './event-append.js'

function normalizeAlertSeverity(value: unknown): AlertSeverity {
  if (value === 'info' || value === 'warning' || value === 'critical') return value
  throw new Error(`alert severity must be info, warning, or critical: ${String(value)}`)
}

export function listAlerts(filter: { status?: AlertStatus | 'open'; source?: string } = {}, filePath = workStatePath()): AlertRecord[] {
  return withWorkDb(filePath, db => listAlertsFromDb(db, filter))
}

export function listAlertsReadOnly(filter: { status?: AlertStatus | 'open'; source?: string } = {}, filePath = workStatePath()): AlertRecord[] {
  return withWorkDbReadOnly(filePath, db => listAlertsFromDb(db, filter))
}

function listAlertsFromDb(db: DatabaseSync, filter: { status?: AlertStatus | 'open'; source?: string } = {}): AlertRecord[] {
  // Filter in SQL so the indexed alert queries (idx_alerts_status_seen,
  // idx_alerts_source) bound the work instead of materializing every alert row
  // ever recorded on each 60s alert-engine pass and dashboard render.
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.status === 'open') {
    clauses.push("status IN ('active', 'acknowledged')")
  } else if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  if (filter.source) {
    clauses.push('source = ?')
    params.push(filter.source)
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = queryRows(db, `SELECT * FROM alerts${where} ORDER BY last_seen_at DESC`, ...params)
  return rows.map(rowToAlert).filter(Boolean) as AlertRecord[]
}


export function upsertAlert(input: AlertInput, options: { dedupeMs?: number; now?: number } = {}, filePath = workStatePath()): AlertUpsertResult {
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const nowMs = options.now || Date.now()
      const now = new Date(nowMs).toISOString()
      const key = normalizeRequiredString(input.key, 'alert.key', 240)
      const source = normalizeRequiredString(input.source, 'alert.source', 120)
      const severity = normalizeAlertSeverity(input.severity)
      const summary = normalizeRequiredString(input.summary, 'alert.summary', 1000)
      const nextAction = normalizeRequiredString(input.nextAction, 'alert.nextAction', 1000)
      const target = normalizeOptionalString(input.target, 240)
      const evidence = normalizeAlertEvidence(input.evidence || [])
      const details = input.details && typeof input.details === 'object' && !Array.isArray(input.details) ? input.details : {}
      const existing = rowToAlert(db.prepare("SELECT * FROM alerts WHERE key = ? AND status IN ('active', 'acknowledged', 'suppressed') ORDER BY last_seen_at DESC LIMIT 1").get(key))
      if (existing) {
        const suppressed = existing.status === 'suppressed' && Date.parse(existing.suppressedUntil || '') > nowMs
        const notify = !suppressed && (!existing.lastNotifiedAt || nowMs - Date.parse(existing.lastNotifiedAt) >= (options.dedupeMs || 15 * 60 * 1000))
        db.prepare(`UPDATE alerts SET severity = ?, source = ?, target = ?, summary = ?, evidence_json = ?, next_action = ?, last_seen_at = ?, last_notified_at = ?, dedupe_count = ?, details_json = ? WHERE id = ?`)
          .run(severity, source, target || null, summary, JSON.stringify(evidence), nextAction, now, notify ? now : existing.lastNotifiedAt || null, existing.dedupeCount + 1, JSON.stringify(details), existing.id)
        appendWorkEventRow(db, 'alert.detected', existing.id, { key, severity, source, target, notify, dedupeCount: existing.dedupeCount + 1 }, now)
        const alert = rowToAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(existing.id))!
        db.exec('COMMIT')
        return { alert, created: false, notify }
      }
      const id = `alert_${randomUUID()}`
      db.prepare(`INSERT INTO alerts (id, key, status, severity, source, target, summary, evidence_json, next_action, first_seen_at, last_seen_at, last_notified_at, dedupe_count, details_json)
        VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(id, key, severity, source, target || null, summary, JSON.stringify(evidence), nextAction, now, now, now, JSON.stringify(details))
      appendWorkEventRow(db, 'alert.detected', id, { key, severity, source, target, created: true }, now)
      const alert = rowToAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(id))!
      db.exec('COMMIT')
      return { alert, created: true, notify: true }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function resolveAlertsNotInKeys(source: string, activeKeys: Set<string>, filePath = workStatePath(), nowMs = Date.now()): number {
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const now = new Date(nowMs).toISOString()
      const rows = queryRows(db, "SELECT * FROM alerts WHERE source = ? AND status IN ('active', 'acknowledged')", source).map(rowToAlert).filter(Boolean) as AlertRecord[]
      let resolved = 0
      for (const alert of rows) {
        if (activeKeys.has(alert.key)) continue
        db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ?, last_seen_at = ? WHERE id = ?").run(now, now, alert.id)
        appendWorkEventRow(db, 'alert.resolved', alert.id, { key: alert.key, source }, now)
        resolved++
      }
      db.exec('COMMIT')
      return resolved
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally { db.close() }
}

export function updateAlertStatus(id: string, action: 'acknowledge' | 'resolve' | 'suppress', input: { note?: string; suppressMs?: number } = {}, filePath = workStatePath()): AlertRecord | undefined {
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = rowToAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(id))
      if (!existing) {
        db.exec('ROLLBACK')
        return undefined
      }
      const now = new Date().toISOString()
      const note = normalizeOptionalString(input.note, 1000)
      if (action === 'acknowledge') db.prepare("UPDATE alerts SET status = 'acknowledged', acknowledged_at = ?, last_seen_at = ? WHERE id = ?").run(now, now, id)
      else if (action === 'resolve') db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ?, last_seen_at = ? WHERE id = ?").run(now, now, id)
      else db.prepare("UPDATE alerts SET status = 'suppressed', suppressed_until = ?, last_seen_at = ? WHERE id = ?").run(new Date(Date.now() + (input.suppressMs || 60 * 60 * 1000)).toISOString(), now, id)
      appendWorkEventRow(db, `alert.${action}`, id, { key: existing.key, note }, now)
      const alert = rowToAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(id))!
      db.exec('COMMIT')
      return alert
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally { db.close() }
}

