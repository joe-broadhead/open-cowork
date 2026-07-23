/**
 * JOE-996 progressive slice: durable SQLite store for operational multi-writer
 * hazards that previously lived in JSON sidecars.
 *
 * Migrates:
 *   H3 events.json        → operational_events
 *   H4 sessions.json      → worker_sessions
 *   H8 telegram-polling.json → channel_poll_cursors
 *
 * Still open (not this module): H1 channel-sync.json coordination, H13 notify
 * in-flight leases. Registry remains status=partial until those close.
 *
 * SQLite + BEGIN IMMEDIATE avoids JSON rewrite corruption under concurrent
 * writers on a shared volume. Production shape remains single-daemon until
 * open migrate hazards are empty and proving status=ready.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getConfigDir } from './config.js'
import { recoverInterruptedStorageRestore, restrictSqliteDbPermissions } from './work-store.js'

export const OPERATIONAL_SIDECAR_FILE = 'operational-sidecar.sqlite'
export const LEGACY_EVENTS_JSON = 'events.json'
export const LEGACY_SESSIONS_JSON = 'sessions.json'
export const LEGACY_TELEGRAM_POLLING_JSON = 'telegram-polling.json'

const MAX_OPERATIONAL_EVENTS = 100
const MAX_WORKER_SESSIONS = 200

export type WorkerSessionRow = {
  id: string
  title: string
  parentId: string
  status: 'running' | 'idle' | 'completed' | 'errored' | 'unknown'
  startedAt: string
  lastCheck: string
  lastTodo: string | null
  lastMessage: string | null
}

export function operationalSidecarPath(stateDir?: string): string {
  const root = stateDir || process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir()
  return path.join(root, OPERATIONAL_SIDECAR_FILE)
}

function stateDirFromDbPath(dbPath: string): string {
  return path.dirname(path.resolve(dbPath))
}

function openSidecarDb(filePath = operationalSidecarPath()): DatabaseSync {
  const dbPath = path.resolve(filePath)
  const dir = path.dirname(dbPath)
  recoverInterruptedStorageRestore(dir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS operational_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_check TEXT NOT NULL,
        last_todo TEXT,
        last_message TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_poll_cursors (
        provider TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    restrictSqliteDbPermissions(dbPath)
    migrateLegacyJsonIfNeeded(db, dir)
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }
  return db
}

function withSidecarDb<T>(fn: (db: DatabaseSync) => T, filePath = operationalSidecarPath()): T {
  const db = openSidecarDb(filePath)
  try {
    return fn(db)
  } finally {
    try { db.close() } catch {}
  }
}

function migrateLegacyJsonIfNeeded(db: DatabaseSync, stateDir: string): void {
  const eventCount = Number((db.prepare('SELECT COUNT(*) AS c FROM operational_events').get() as { c?: number } | undefined)?.c || 0)
  if (eventCount === 0) {
    const legacy = path.join(stateDir, LEGACY_EVENTS_JSON)
    if (fs.existsSync(legacy)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, 'utf-8'))
        const events = Array.isArray(parsed?.events)
          ? parsed.events.filter((e: unknown) => typeof e === 'string').slice(-MAX_OPERATIONAL_EVENTS)
          : []
        if (events.length) {
          const insert = db.prepare('INSERT INTO operational_events (line, created_at) VALUES (?, ?)')
          const now = new Date().toISOString()
          db.exec('BEGIN IMMEDIATE')
          try {
            for (const line of events) insert.run(line, now)
            db.exec('COMMIT')
          } catch (err) {
            try { db.exec('ROLLBACK') } catch {}
            throw err
          }
        }
      } catch {
        // Corrupt legacy JSON: leave empty SQLite table (same as previous fail-open load).
      }
    }
  }

  const sessionCount = Number((db.prepare('SELECT COUNT(*) AS c FROM worker_sessions').get() as { c?: number } | undefined)?.c || 0)
  if (sessionCount === 0) {
    const legacy = path.join(stateDir, LEGACY_SESSIONS_JSON)
    if (fs.existsSync(legacy)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, 'utf-8'))
        const rows = Array.isArray(parsed?.sessions) ? parsed.sessions : []
        const insert = db.prepare(`
          INSERT OR REPLACE INTO worker_sessions
            (id, title, parent_id, status, started_at, last_check, last_todo, last_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const row of rows) {
            if (!isWorkerSessionRow(row)) continue
            insert.run(
              row.id,
              row.title,
              row.parentId,
              row.status,
              row.startedAt,
              row.lastCheck,
              row.lastTodo,
              row.lastMessage,
            )
          }
          db.exec('COMMIT')
        } catch (err) {
          try { db.exec('ROLLBACK') } catch {}
          throw err
        }
      } catch {
        // Corrupt legacy JSON: leave empty table.
      }
    }
  }

  const telegram = db.prepare("SELECT cursor FROM channel_poll_cursors WHERE provider = 'telegram'").get() as { cursor?: number } | undefined
  if (!telegram) {
    const legacy = path.join(stateDir, LEGACY_TELEGRAM_POLLING_JSON)
    if (fs.existsSync(legacy)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, 'utf-8')) as { lastUpdateId?: unknown }
        const cursor = normalizeCursor(parsed.lastUpdateId)
        if (cursor > 0) {
          db.prepare(`
            INSERT OR REPLACE INTO channel_poll_cursors (provider, cursor, updated_at)
            VALUES ('telegram', ?, ?)
          `).run(cursor, new Date().toISOString())
        }
      } catch {
        // ignore corrupt legacy
      }
    }
  }
}

function isWorkerSessionRow(row: any): row is WorkerSessionRow {
  return Boolean(
    row
    && typeof row.id === 'string'
    && typeof row.title === 'string'
    && typeof row.parentId === 'string'
    && ['running', 'idle', 'completed', 'errored', 'unknown'].includes(row.status)
    && typeof row.startedAt === 'string'
    && typeof row.lastCheck === 'string',
  )
}

function normalizeCursor(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

export function loadOperationalEvents(filePath = operationalSidecarPath()): string[] {
  return withSidecarDb((db) => {
    const rows = db.prepare('SELECT line FROM operational_events ORDER BY id ASC').all() as Array<{ line: string }>
    return rows.map((r) => String(r.line)).slice(-MAX_OPERATIONAL_EVENTS)
  }, filePath)
}

export function replaceOperationalEvents(events: string[], filePath = operationalSidecarPath()): void {
  const bounded = events.slice(-MAX_OPERATIONAL_EVENTS)
  withSidecarDb((db) => {
    const insert = db.prepare('INSERT INTO operational_events (line, created_at) VALUES (?, ?)')
    const now = new Date().toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM operational_events').run()
      for (const line of bounded) insert.run(line, now)
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  }, filePath)
}

export function appendOperationalEvent(line: string, filePath = operationalSidecarPath()): string[] {
  return withSidecarDb((db) => {
    const now = new Date().toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO operational_events (line, created_at) VALUES (?, ?)').run(line, now)
      const count = Number((db.prepare('SELECT COUNT(*) AS c FROM operational_events').get() as { c?: number }).c || 0)
      if (count > MAX_OPERATIONAL_EVENTS) {
        db.prepare(`
          DELETE FROM operational_events
          WHERE id NOT IN (
            SELECT id FROM operational_events ORDER BY id DESC LIMIT ?
          )
        `).run(MAX_OPERATIONAL_EVENTS)
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
    const rows = db.prepare('SELECT line FROM operational_events ORDER BY id ASC').all() as Array<{ line: string }>
    return rows.map((r) => String(r.line))
  }, filePath)
}

export function clearOperationalEvents(filePath = operationalSidecarPath()): void {
  withSidecarDb((db) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM operational_events').run()
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  }, filePath)
}

export function loadWorkerSessions(filePath = operationalSidecarPath()): WorkerSessionRow[] {
  return withSidecarDb((db) => {
    const rows = db.prepare(`
      SELECT id, title, parent_id, status, started_at, last_check, last_todo, last_message
      FROM worker_sessions
    `).all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      parentId: String(row.parent_id),
      status: row.status as WorkerSessionRow['status'],
      startedAt: String(row.started_at),
      lastCheck: String(row.last_check),
      lastTodo: row.last_todo == null ? null : String(row.last_todo),
      lastMessage: row.last_message == null ? null : String(row.last_message),
    })).filter(isWorkerSessionRow)
  }, filePath)
}

export function replaceWorkerSessions(sessions: WorkerSessionRow[], filePath = operationalSidecarPath()): void {
  const bounded = [...sessions]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, MAX_WORKER_SESSIONS)
  withSidecarDb((db) => {
    const insert = db.prepare(`
      INSERT INTO worker_sessions
        (id, title, parent_id, status, started_at, last_check, last_todo, last_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM worker_sessions').run()
      for (const row of bounded) {
        insert.run(
          row.id,
          row.title,
          row.parentId,
          row.status,
          row.startedAt,
          row.lastCheck,
          row.lastTodo,
          row.lastMessage,
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  }, filePath)
}

export function clearWorkerSessions(filePath = operationalSidecarPath()): void {
  withSidecarDb((db) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM worker_sessions').run()
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  }, filePath)
}

export function loadChannelPollCursor(provider: string, filePath = operationalSidecarPath()): number {
  return withSidecarDb((db) => {
    const row = db.prepare('SELECT cursor FROM channel_poll_cursors WHERE provider = ?').get(provider) as { cursor?: number } | undefined
    return normalizeCursor(row?.cursor)
  }, filePath)
}

export function saveChannelPollCursor(provider: string, cursor: number, filePath = operationalSidecarPath()): void {
  const normalized = normalizeCursor(cursor)
  if (!normalized) return
  withSidecarDb((db) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`
        INSERT INTO channel_poll_cursors (provider, cursor, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          cursor = excluded.cursor,
          updated_at = excluded.updated_at
      `).run(provider, normalized, new Date().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  }, filePath)
}

export function clearChannelPollCursor(provider: string, filePath = operationalSidecarPath()): void {
  withSidecarDb((db) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM channel_poll_cursors WHERE provider = ?').run(provider)
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  }, filePath)
}

/** Test helper: wipe all operational sidecar tables for the current state dir. */
export function clearOperationalSidecarForTest(filePath = operationalSidecarPath()): void {
  const dbPath = path.resolve(filePath)
  if (!fs.existsSync(dbPath)) return
  withSidecarDb((db) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM operational_events').run()
      db.prepare('DELETE FROM worker_sessions').run()
      db.prepare('DELETE FROM channel_poll_cursors').run()
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  }, filePath)
}

export function operationalSidecarStateDir(filePath = operationalSidecarPath()): string {
  return stateDirFromDbPath(filePath)
}
