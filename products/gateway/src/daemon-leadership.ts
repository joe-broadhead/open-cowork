import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { appendAuditEvent, recoverInterruptedStorageRestore, restrictSqliteDbPermissions, workStatePath, type WorkDbLeadershipEpoch } from './work-store.js'
import { redactSensitiveText } from './security.js'
import { assertSupportedWorkStoreSchemaVersion, workStoreSchemaVersion } from './work-store/schema.js'

export type DaemonLeadershipMode = 'single_daemon' | 'writer' | 'standby' | 'no_leader' | 'unavailable'

export interface DaemonLeadershipSnapshot {
  enabled: boolean
  scope: string
  mode: DaemonLeadershipMode
  canWrite: boolean
  daemonId: string
  instanceId: string
  leaderId?: string
  fencingToken?: string
  leaseStartedAt?: string
  leaseExpiresAt?: string
  leaseAgeMs?: number
  leaseRemainingMs?: number
  stale: boolean
  takeoverCount: number
  updatedAt?: string
  remediation: string
}

export interface DaemonLeadershipOptions {
  filePath?: string
  scope?: string
  daemonId?: string
  instanceId?: string
  leaseMs?: number
  now?: () => number
}

export interface DaemonLeadershipController {
  readonly filePath: string
  readonly scope: string
  readonly daemonId: string
  readonly instanceId: string
  readonly leaseMs: number
  acquireOrRenew(options?: { takeoverStale?: boolean; source?: string }): DaemonLeadershipSnapshot
  status(): DaemonLeadershipSnapshot
  captureEpoch(): WorkDbLeadershipEpoch | undefined
  canWrite(): boolean
  release(source?: string): DaemonLeadershipSnapshot
}

export interface DaemonWriteFence {
  canWrite: boolean
  leaseOwner: string
  generation: string
  leadership: DaemonLeadershipSnapshot
}

export interface DaemonMutationFence {
  requiresWriter: boolean
  allowed: boolean
  status: number
  method: string
  pathname: string
  error?: string
  safeNextAction: string
  leaseOwner?: string
  generation?: string
  leadership: DaemonLeadershipSnapshot
}

const DEFAULT_SCOPE = 'gateway-local-writer'
const DEFAULT_LEASE_MS = 90_000
const MIN_LEASE_MS = 10_000

let currentLeadership: DaemonLeadershipController | null = null

export function createDaemonLeadership(options: DaemonLeadershipOptions = {}): DaemonLeadershipController {
  return new SqliteDaemonLeadership(options)
}

export function setCurrentDaemonLeadership(controller: DaemonLeadershipController | null): void {
  currentLeadership = controller
}


export function clearCurrentDaemonLeadershipForTest(): void {
  setCurrentDaemonLeadership(null)
}

export function canCurrentDaemonWrite(): boolean {
  return currentLeadership ? currentLeadership.canWrite() : true
}

export function getCurrentDaemonLeadershipStatus(): DaemonLeadershipSnapshot {
  return currentLeadership ? currentLeadership.status() : singleDaemonSnapshot()
}

/** Raw transaction epoch. Never include this value in public status or logs. */
export function captureCurrentDaemonLeadershipEpoch(): WorkDbLeadershipEpoch | undefined {
  return currentLeadership?.captureEpoch()
}

export function recoverCurrentDaemonLeadership(source = 'operator'): DaemonLeadershipSnapshot {
  return currentLeadership
    ? currentLeadership.acquireOrRenew({ takeoverStale: true, source })
    : singleDaemonSnapshot()
}

export function startDaemonLeadershipHeartbeat(
  controller: DaemonLeadershipController,
  options: { intervalMs?: number; onStatus?: (snapshot: DaemonLeadershipSnapshot) => void } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs || Math.max(1_000, Math.min(30_000, Math.floor(controller.leaseMs / 3)))
  const timer = setInterval(() => {
    const snapshot = controller.acquireOrRenew({ takeoverStale: true, source: 'heartbeat' })
    options.onStatus?.(snapshot)
  }, intervalMs)
  timer.unref?.()
  return timer
}

export function redactDaemonLeadershipSnapshot(snapshot: DaemonLeadershipSnapshot): DaemonLeadershipSnapshot {
  return {
    ...snapshot,
    daemonId: fingerprint(snapshot.daemonId),
    instanceId: fingerprint(snapshot.instanceId),
    leaderId: snapshot.leaderId ? fingerprint(snapshot.leaderId) : undefined,
    fencingToken: snapshot.fencingToken ? fingerprint(snapshot.fencingToken) : undefined,
    remediation: publicText(snapshot.remediation),
  }
}


export function currentDaemonWriteFence(component = 'gateway'): DaemonWriteFence {
  const snapshot = getCurrentDaemonLeadershipStatus()
  const publicSnapshot = redactDaemonLeadershipSnapshot(snapshot)
  const stableOwnerId = publicSnapshot.fencingToken || publicSnapshot.leaderId || publicSnapshot.instanceId
  const leaseOwner = `${component}:${publicSnapshot.mode}:${publicSnapshot.instanceId}`
  const generation = `${publicSnapshot.scope}:${publicSnapshot.mode}:${stableOwnerId}`
  return {
    canWrite: snapshot.canWrite,
    leaseOwner,
    generation,
    leadership: publicSnapshot,
  }
}

export function daemonMutationRequiresWriter(method: string | undefined, pathname: string): boolean {
  const normalizedMethod = String(method || 'GET').toUpperCase()
  if (normalizedMethod === 'GET' && (pathname === '/incident-bundle' || pathname === '/evidence/export')) return true
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') return false
  if (pathname === '/gateway/leadership/recover') return false
  return true
}

export function evaluateDaemonMutationFence(input: { method?: string; pathname: string; component?: string }): DaemonMutationFence {
  const method = String(input.method || 'GET').toUpperCase()
  const pathname = input.pathname || '/'
  const requiresWriter = daemonMutationRequiresWriter(method, pathname)
  const fence = currentDaemonWriteFence(input.component || 'route')
  if (!requiresWriter) {
    return {
      requiresWriter,
      allowed: true,
      status: 200,
      method,
      pathname,
      safeNextAction: 'No writer lease required for this read-only or leadership-recovery operation.',
      leaseOwner: fence.leaseOwner,
      generation: fence.generation,
      leadership: fence.leadership,
    }
  }
  if (fence.canWrite) {
    return {
      requiresWriter,
      allowed: true,
      status: 200,
      method,
      pathname,
      safeNextAction: 'No action required.',
      leaseOwner: fence.leaseOwner,
      generation: fence.generation,
      leadership: fence.leadership,
    }
  }
  return {
    requiresWriter,
    allowed: false,
    status: 409,
    method,
    pathname,
    error: `Gateway daemon is ${fence.leadership.mode}; local writer lease is required for ${method} ${pathname}.`,
    safeNextAction: fence.leadership.remediation,
    leadership: fence.leadership,
  }
}

export function recordDaemonMutationDenied(input: { method?: string; pathname: string; source?: string; actor?: string }): void {
  const decision = evaluateDaemonMutationFence({ method: input.method, pathname: input.pathname, component: input.source || 'route' })
  if (decision.allowed) return
  try {
    appendAuditEvent({
      actor: input.actor || 'daemon',
      source: input.source || 'daemon-leadership',
      operation: 'daemon.mutation.denied',
      target: `${decision.method} ${decision.pathname}`,
      result: 'denied',
      details: {
        reason: decision.error,
        safeNextAction: decision.safeNextAction,
        leadership: decision.leadership,
      },
    })
  } catch {}
}

class SqliteDaemonLeadership implements DaemonLeadershipController {
  readonly filePath: string
  readonly scope: string
  readonly daemonId: string
  readonly instanceId: string
  readonly leaseMs: number
  private readonly now: () => number
  private lastSnapshot: DaemonLeadershipSnapshot

  constructor(options: DaemonLeadershipOptions = {}) {
    this.filePath = path.resolve(options.filePath || workStatePath())
    this.scope = options.scope || DEFAULT_SCOPE
    this.now = options.now || Date.now
    this.leaseMs = Math.max(MIN_LEASE_MS, Math.floor(options.leaseMs || DEFAULT_LEASE_MS))
    this.daemonId = options.daemonId || ensurePersistentDaemonId(this.filePath, this.scope, this.now)
    this.instanceId = options.instanceId || `${this.daemonId}:${process.pid}:${randomUUID()}`
    this.lastSnapshot = this.readStatus()
  }

  acquireOrRenew(options: { takeoverStale?: boolean; source?: string } = {}): DaemonLeadershipSnapshot {
    const takeoverStale = options.takeoverStale !== false
    const nowMs = this.now()
    const nowIso = iso(nowMs)
    const leaseExpiresAt = iso(nowMs + this.leaseMs)
    let audit: { operation: string; result: 'ok' | 'denied' | 'error'; details?: Record<string, unknown> } | undefined
    try {
      const db = openLeadershipDb(this.filePath)
      try {
        db.exec('BEGIN IMMEDIATE')
        const row = readLeadershipRow(db, this.scope)
        if (!row) {
          const token = newFencingToken(this.instanceId, 1)
          db.prepare(`INSERT INTO daemon_leadership (
            scope, leader_id, daemon_id, fencing_token, lease_started_at, lease_expires_at, updated_at, takeover_count, pid, hostname
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(this.scope, this.instanceId, this.daemonId, token, nowIso, leaseExpiresAt, nowIso, process.pid, os.hostname())
          db.exec('COMMIT')
          this.lastSnapshot = this.snapshotFromRow({
            scope: this.scope,
            leader_id: this.instanceId,
            daemon_id: this.daemonId,
            fencing_token: token,
            lease_started_at: nowIso,
            lease_expires_at: leaseExpiresAt,
            updated_at: nowIso,
            takeover_count: 0,
          }, 'writer')
          audit = { operation: 'daemon.leadership.acquire', result: 'ok' }
          return this.lastSnapshot
        }

        const rowExpiresAt = Date.parse(String(row.lease_expires_at || ''))
        const stale = !Number.isFinite(rowExpiresAt) || rowExpiresAt <= nowMs
        if (row.leader_id === this.instanceId && !stale) {
          const renewed = db.prepare(`UPDATE daemon_leadership
            SET lease_expires_at = ?, updated_at = ?, pid = ?, hostname = ?
            WHERE scope = ? AND leader_id = ? AND fencing_token = ? AND lease_expires_at > ?`)
            .run(leaseExpiresAt, nowIso, process.pid, os.hostname(), this.scope, this.instanceId, row.fencing_token, nowIso) as { changes?: number }
          if (Number(renewed.changes || 0) !== 1) throw new Error('leadership renewal lost its fencing epoch')
          db.exec('COMMIT')
          this.lastSnapshot = this.snapshotFromRow({ ...row, lease_expires_at: leaseExpiresAt, updated_at: nowIso }, 'writer')
          return this.lastSnapshot
        }

        if (stale && takeoverStale) {
          const takeoverCount = Number(row.takeover_count || 0) + 1
          const token = newFencingToken(this.instanceId, takeoverCount + 1)
          const taken = db.prepare(`UPDATE daemon_leadership
            SET leader_id = ?, daemon_id = ?, fencing_token = ?, lease_started_at = ?, lease_expires_at = ?, updated_at = ?, takeover_count = ?, pid = ?, hostname = ?
            WHERE scope = ? AND leader_id = ? AND fencing_token = ? AND (lease_expires_at <= ? OR julianday(lease_expires_at) IS NULL)`)
            .run(this.instanceId, this.daemonId, token, nowIso, leaseExpiresAt, nowIso, takeoverCount, process.pid, os.hostname(), this.scope, row.leader_id, row.fencing_token, nowIso) as { changes?: number }
          if (Number(taken.changes || 0) !== 1) throw new Error('stale leadership takeover lost its compare-and-set race')
          db.exec('COMMIT')
          this.lastSnapshot = this.snapshotFromRow({
            scope: this.scope,
            leader_id: this.instanceId,
            daemon_id: this.daemonId,
            fencing_token: token,
            lease_started_at: nowIso,
            lease_expires_at: leaseExpiresAt,
            updated_at: nowIso,
            takeover_count: takeoverCount,
          }, 'writer')
          audit = {
            operation: 'daemon.leadership.takeover_stale',
            result: 'ok',
            details: { previousLeader: fingerprint(String(row.leader_id || '')) },
          }
          return this.lastSnapshot
        }

        db.exec('COMMIT')
        this.lastSnapshot = this.snapshotFromRow(row, 'standby')
        audit = stale
          ? { operation: 'daemon.leadership.takeover_stale', result: 'denied', details: { reason: 'takeover disabled' } }
          : undefined
        return this.lastSnapshot
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
        throw err
      } finally {
        db.close()
      }
    } catch (err: any) {
      this.lastSnapshot = unavailableSnapshot(this.scope, this.daemonId, this.instanceId, err?.message || String(err))
      audit = { operation: 'daemon.leadership.acquire', result: 'error', details: { error: safeError(err) } }
      return this.lastSnapshot
    } finally {
      if (audit) this.recordAudit(audit.operation, audit.result, { source: options.source || 'daemon', snapshot: redactDaemonLeadershipSnapshot(this.lastSnapshot), ...(audit.details || {}) })
    }
  }

  status(): DaemonLeadershipSnapshot {
    this.lastSnapshot = this.readStatus()
    return this.lastSnapshot
  }

  captureEpoch(): WorkDbLeadershipEpoch | undefined {
    const snapshot = this.readStatus()
    this.lastSnapshot = snapshot
    if (
      snapshot.mode !== 'writer' ||
      !snapshot.canWrite ||
      snapshot.leaderId !== this.instanceId ||
      !snapshot.fencingToken ||
      !snapshot.leaseExpiresAt
    ) return undefined
    return {
      scope: snapshot.scope,
      leaderId: snapshot.leaderId,
      fencingToken: snapshot.fencingToken,
      leaseExpiresAt: snapshot.leaseExpiresAt,
      now: this.now,
    }
  }

  canWrite(): boolean {
    const snapshot = this.lastSnapshot
    if (snapshot.mode !== 'writer' || !snapshot.canWrite) return false
    const expiresAt = Date.parse(snapshot.leaseExpiresAt || '')
    return Number.isFinite(expiresAt) && expiresAt > this.now()
  }

  release(source = 'daemon'): DaemonLeadershipSnapshot {
    let released = false
    try {
      const db = openLeadershipDb(this.filePath)
      try {
        db.exec('BEGIN IMMEDIATE')
        const token = this.lastSnapshot.fencingToken || ''
        const result = db.prepare('DELETE FROM daemon_leadership WHERE scope = ? AND leader_id = ? AND fencing_token = ?')
          .run(this.scope, this.instanceId, token) as any
        released = Number(result?.changes || 0) > 0
        db.exec('COMMIT')
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
        throw err
      } finally {
        db.close()
      }
    } catch {}
    this.lastSnapshot = this.readStatus()
    if (released) this.recordAudit('daemon.leadership.release', 'ok', { source, snapshot: redactDaemonLeadershipSnapshot(this.lastSnapshot) })
    return this.lastSnapshot
  }

  private readStatus(): DaemonLeadershipSnapshot {
    try {
      const db = openLeadershipDb(this.filePath, { readOnly: true })
      try {
        const row = readLeadershipRow(db, this.scope)
        if (!row) return noLeaderSnapshot(this.scope, this.daemonId, this.instanceId)
        return this.snapshotFromRow(row, row.leader_id === this.instanceId ? 'writer' : 'standby')
      } finally {
        db.close()
      }
    } catch (err: any) {
      return unavailableSnapshot(this.scope, this.daemonId, this.instanceId, err?.message || String(err))
    }
  }

  private snapshotFromRow(row: any, ownerMode: 'writer' | 'standby'): DaemonLeadershipSnapshot {
    const now = this.now()
    const expiresAt = Date.parse(String(row.lease_expires_at || ''))
    const startedAt = Date.parse(String(row.lease_started_at || ''))
    const stale = !Number.isFinite(expiresAt) || expiresAt <= now
    const ownsFreshLease = ownerMode === 'writer' && !stale
    const mode: DaemonLeadershipMode = ownsFreshLease ? 'writer' : 'standby'
    return {
      enabled: true,
      scope: this.scope,
      mode,
      canWrite: ownsFreshLease,
      daemonId: this.daemonId,
      instanceId: this.instanceId,
      leaderId: String(row.leader_id || ''),
      fencingToken: String(row.fencing_token || ''),
      leaseStartedAt: typeof row.lease_started_at === 'string' ? row.lease_started_at : undefined,
      leaseExpiresAt: typeof row.lease_expires_at === 'string' ? row.lease_expires_at : undefined,
      leaseAgeMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : undefined,
      leaseRemainingMs: Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : undefined,
      stale,
      takeoverCount: Number(row.takeover_count || 0),
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined,
      remediation: ownsFreshLease
        ? 'No action required.'
        : stale
          ? 'Leader lease is stale; run `opencode-gateway status` or restart Gateway to let the local writer recover leadership.'
          : 'Another Gateway daemon owns the local writer lease. Stop the duplicate daemon or wait for its lease to expire before takeover.',
    }
  }

  private recordAudit(operation: string, result: 'ok' | 'denied' | 'error', details: Record<string, unknown>): void {
    try {
      appendAuditEvent({
        actor: 'daemon',
        source: 'daemon-leadership',
        operation,
        target: this.scope,
        result,
        details,
      }, this.filePath)
    } catch {}
  }
}

function ensurePersistentDaemonId(filePath: string, scope: string, now: () => number): string {
  const db = openLeadershipDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = db.prepare('SELECT daemon_id FROM daemon_identity WHERE scope = ?').get(scope) as any
      if (typeof existing?.daemon_id === 'string' && existing.daemon_id) {
        db.exec('COMMIT')
        return existing.daemon_id
      }
      const id = `daemon_${randomUUID()}`
      const nowIso = iso(now())
      db.prepare('INSERT INTO daemon_identity (scope, daemon_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(scope, id, nowIso, nowIso)
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

function openLeadershipDb(filePath: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const dbPath = path.resolve(filePath)
  recoverInterruptedStorageRestore(path.dirname(dbPath))
  if (options.readOnly && !fs.existsSync(dbPath)) throw new Error(`Gateway state database not found: ${dbPath}`)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
  const db = options.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  assertSupportedWorkStoreSchemaVersion(workStoreSchemaVersion(db))
  if (options.readOnly) {
    db.exec('PRAGMA query_only = ON')
    return db
  }
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_identity (
      scope TEXT PRIMARY KEY,
      daemon_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daemon_leadership (
      scope TEXT PRIMARY KEY,
      leader_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      fencing_token TEXT NOT NULL,
      lease_started_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      takeover_count INTEGER NOT NULL DEFAULT 0,
      pid INTEGER,
      hostname TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_daemon_leadership_expires ON daemon_leadership(lease_expires_at);
  `)
  // Owner-only for the main file and the WAL/SHM sidecars, which inherit the
  // process umask; the WAL pragma and schema writes above guarantee they exist.
  restrictSqliteDbPermissions(dbPath)
  return db
}

function readLeadershipRow(db: DatabaseSync, scope: string): any | undefined {
  return db.prepare('SELECT * FROM daemon_leadership WHERE scope = ?').get(scope) as any
}

function newFencingToken(instanceId: string, term: number): string {
  return `fence_${term}_${fingerprint(`${instanceId}:${Date.now()}:${randomUUID()}`)}`
}

function singleDaemonSnapshot(): DaemonLeadershipSnapshot {
  return {
    enabled: false,
    scope: DEFAULT_SCOPE,
    mode: 'single_daemon',
    canWrite: true,
    daemonId: 'single-daemon',
    instanceId: 'single-daemon',
    stale: false,
    takeoverCount: 0,
    remediation: 'Single-daemon compatibility mode is active; no leadership controller is installed.',
  }
}

function noLeaderSnapshot(scope: string, daemonId: string, instanceId: string): DaemonLeadershipSnapshot {
  return {
    enabled: true,
    scope,
    mode: 'no_leader',
    canWrite: false,
    daemonId,
    instanceId,
    stale: true,
    takeoverCount: 0,
    remediation: 'No local writer lease exists. Start or restart Gateway so this daemon can acquire leadership.',
  }
}

function unavailableSnapshot(scope: string, daemonId: string, instanceId: string, error: string): DaemonLeadershipSnapshot {
  return {
    enabled: true,
    scope,
    mode: 'unavailable',
    canWrite: false,
    daemonId,
    instanceId,
    stale: true,
    takeoverCount: 0,
    remediation: `Leadership state is unavailable: ${safeError(error)}.`,
  }
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function safeError(value: unknown): string {
  return publicText(String(value || 'unknown error'))
}

function publicText(value: string): string {
  let text = redactSensitiveText(String(value || ''))
  for (const privatePath of [os.homedir(), process.cwd()].filter(Boolean)) {
    text = text.split(privatePath).join('<redacted-path>')
  }
  text = text.replace(/(?:[A-Za-z]:)?\/(?:Users|home)\/[^/\s)]+/g, '<redacted-path>')
  return text.replace(/\s+/g, ' ').slice(0, 300)
}
