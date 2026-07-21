/**
 * Task dispatch receipts and acquisition journal (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts (keeps dependency graph acyclic).
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  cleanupFailedEnvironmentRun,
  environmentControllerForBackend,
  redactEnvironmentRecord,
  type EnvironmentRunRecord,
} from '../environments.js'
import {
  currentWorkDbLeadershipEpoch,
  openWorkDb,
  parseJSON,
  queryRows,
  withWorkDb,
  workStatePath,
} from './db.js'
import { assertNoStorageOperationInProgress } from './storage-lock.js'
import { rowToTask, rowToTaskDispatchReceipt } from './row-mappers.js'
import {
  normalizeJsonObject,
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeStage,
} from './validators.js'
import type {
  TaskDispatchAcquisitionKind,
  TaskDispatchAcquisitionRecord,
  TaskDispatchAcquisitionStatus,
  TaskDispatchReceiptRecord,
  TaskDispatchReceiptStatus,
} from './types.js'
import { appendWorkEventRow } from './event-append.js'

export function assertNoUnsettledTaskDispatchAcquisitions(db: DatabaseSync, taskIds: Set<string>): void {
  if (!taskIds.size) return
  const read = db.prepare('SELECT status, acquisition_journal_json FROM task_dispatch_receipts WHERE task_id = ?')
  const unsettled: string[] = []
  for (const taskId of taskIds) {
    const rows = read.all(taskId) as Array<{ status?: unknown; acquisition_journal_json?: unknown }>
    if (rows.some(row => row.status !== 'started' && normalizeStoredTaskDispatchAcquisitions(parseJSON(row.acquisition_journal_json, []))
      .some(acquisition => acquisition.status === 'intent' || acquisition.status === 'acquired'))) {
      unsettled.push(taskId)
    }
  }
  if (unsettled.length) {
    throw new Error(`task deletion refused while external acquisitions remain unsettled: ${unsettled.join(', ')}`)
  }
}

export function reserveTaskDispatchStart(input: { taskId: string; stage: string; profile?: string; leaseOwner?: string; leaseMs?: number; idempotencyKey?: string; now?: number }, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const nowMs = input.now || Date.now()
      const now = new Date(nowMs).toISOString()
      const stage = normalizeStage(input.stage, 'stage')
      const idempotencyKey = normalizeOptionalString(input.idempotencyKey, 240)
      if (idempotencyKey) {
        const existing = rowToTaskDispatchReceipt(db.prepare('SELECT * FROM task_dispatch_receipts WHERE idempotency_key = ?').get(idempotencyKey))
        if (existing) {
          db.exec('ROLLBACK')
          return existing
        }
      }
      const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId))
      if (!task || task.status !== 'pending' || task.currentRunId || (task.currentStage || task.pipeline[0] || 'implement') !== stage) {
        db.exec('ROLLBACK')
        return undefined
      }
      const active = rowToTaskDispatchReceipt(db.prepare("SELECT * FROM task_dispatch_receipts WHERE task_id = ? AND stage = ? AND status = 'starting' AND lease_expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1").get(input.taskId, stage, now))
      if (active) {
        db.exec('ROLLBACK')
        return undefined
      }
      const leaseMs = Math.max(60 * 1000, Math.min(input.leaseMs || 60 * 60 * 1000, 24 * 60 * 60 * 1000))
      const receipt: TaskDispatchReceiptRecord = {
        id: `dispatch_${randomUUID()}`,
        taskId: input.taskId,
        stage,
        profile: normalizeOptionalString(input.profile, 120),
        idempotencyKey: idempotencyKey || `dispatch:${input.taskId}:${stage}:${input.leaseOwner || 'scheduler'}:${now}`,
        leaseOwner: normalizeOptionalString(input.leaseOwner, 200) || `scheduler-${process.pid}`,
        leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
        status: 'starting',
        createdAt: now,
        updatedAt: now,
      }
      upsertTaskDispatchReceiptRow(db, receipt)
      appendWorkEventRow(db, 'task.dispatch.starting', input.taskId, { dispatchId: receipt.id, stage, leaseOwner: receipt.leaseOwner, leaseExpiresAt: receipt.leaseExpiresAt }, now)
      db.exec('COMMIT')
      return receipt
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function attachTaskDispatchEnvironment(dispatchId: string, environment: EnvironmentRunRecord, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  return updateTaskDispatchReceipt(dispatchId, filePath, receipt => {
    if (receipt.status !== 'starting') return false
    receipt.environment = environment
    return true
  }, (receipt, db, now) => {
    upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind: 'environment',
      status: 'acquired',
      provider: environment.backend,
      resourceId: environment.leaseId || environment.id,
      resource: environment as unknown as Record<string, unknown>,
    }, now)
  })
}

export function journalTaskDispatchAcquisitionIntent(
  dispatchId: string,
  input: { kind: TaskDispatchAcquisitionKind; provider: string; idempotencyKey?: string; metadata?: Record<string, unknown> },
  filePath = workStatePath(),
): TaskDispatchAcquisitionRecord | undefined {
  let acquisition: TaskDispatchAcquisitionRecord | undefined
  updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'starting') return false
    acquisition = upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind: input.kind,
      status: 'intent',
      provider: normalizeRequiredString(input.provider, 'acquisition.provider', 120),
      idempotencyKey: normalizeOptionalString(input.idempotencyKey, 240) || `${dispatchId}:${input.kind}`,
      metadata: normalizeJsonObject(input.metadata || {}, 'acquisition.metadata'),
    }, now)
    return true
  })
  return acquisition
}

export function attachTaskDispatchSession(dispatchId: string, sessionId: string, filePath = workStatePath()): TaskDispatchAcquisitionRecord | undefined {
  let acquisition: TaskDispatchAcquisitionRecord | undefined
  updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'starting') return false
    receipt.sessionId = normalizeRequiredString(sessionId, 'sessionId', 200)
    acquisition = upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind: 'session',
      status: 'acquired',
      provider: 'opencode',
      resourceId: receipt.sessionId,
      resource: { sessionId: receipt.sessionId },
    }, now)
    return true
  })
  return acquisition
}

export function markTaskDispatchAcquisitionSettled(
  dispatchId: string,
  kind: TaskDispatchAcquisitionKind,
  input: { status: 'released' | 'failed'; error?: string } = { status: 'released' },
  filePath = workStatePath(),
): TaskDispatchAcquisitionRecord | undefined {
  let acquisition: TaskDispatchAcquisitionRecord | undefined
  updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    acquisition = upsertTaskDispatchAcquisitionRow(db, receipt, {
      kind,
      status: input.status,
      provider: kind === 'session' ? 'opencode' : receipt.environment?.backend || 'environment',
      error: normalizeOptionalString(input.error, 1000),
    }, now)
    return true
  })
  return acquisition
}

export function listTaskDispatchAcquisitions(filePath = workStatePath()): TaskDispatchAcquisitionRecord[] {
  return withWorkDb(filePath, db => {
    const rows = queryRows(db, `SELECT id, task_id, stage, lease_owner, status, lease_expires_at, acquisition_journal_json
      FROM task_dispatch_receipts
      WHERE acquisition_journal_json IS NOT NULL AND acquisition_journal_json != '[]'
      ORDER BY created_at ASC, id ASC`)
    return rows.flatMap(row => taskDispatchAcquisitionRows(row))
  })
}

export function markTaskDispatchStarted(dispatchId: string, input: { runId: string; sessionId: string }, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  return updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'starting') return false
    receipt.status = 'started'
    receipt.runId = input.runId
    receipt.sessionId = input.sessionId
    appendWorkEventRow(db, 'task.dispatch.started', receipt.taskId, { dispatchId: receipt.id, runId: input.runId, sessionId: input.sessionId, stage: receipt.stage }, now)
    return true
  })
}

export function markTaskDispatchPromptSubmitted(dispatchId: string, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  return updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'started') return false
    receipt.promptSubmittedAt = receipt.promptSubmittedAt || now
    appendWorkEventRow(db, 'task.dispatch.prompt_submitted', receipt.runId || receipt.taskId, { dispatchId: receipt.id, taskId: receipt.taskId, stage: receipt.stage, sessionId: receipt.sessionId, runId: receipt.runId, promptSubmittedAt: receipt.promptSubmittedAt }, now)
    return true
  })
}

export function markTaskDispatchFailed(dispatchId: string | undefined, reason: string, filePath = workStatePath()): TaskDispatchReceiptRecord | undefined {
  if (!dispatchId) return undefined
  return updateTaskDispatchReceipt(dispatchId, filePath, (receipt, db, now) => {
    if (receipt.status !== 'starting') return false
    receipt.status = 'failed'
    receipt.failureReason = normalizeOptionalString(reason, 1000) || 'dispatch failed'
    appendWorkEventRow(db, 'task.dispatch.failed', receipt.taskId, { dispatchId: receipt.id, stage: receipt.stage, reason: receipt.failureReason }, now)
    return true
  })
}

export function recoverExpiredTaskDispatchStarts(filePath = workStatePath(), now = Date.now()): { recovered: number; dispatchIds: string[] } {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const nowIso = new Date(now).toISOString()
      const expired = listTaskDispatchReceiptsFromDb(db, { status: 'starting' })
        .filter(receipt => Date.parse(receipt.leaseExpiresAt) <= now)
      for (const receipt of expired) {
        let environmentRecovery: Record<string, unknown> | undefined
        if (receipt.environment && receipt.environment.status !== 'released') {
          const before = receipt.environment
          try {
            receipt.environment = environmentControllerForBackend(before.backend).release(before)
            upsertTaskDispatchAcquisitionRow(db, receipt, {
              kind: 'environment',
              status: 'released',
              provider: before.backend,
              resourceId: before.leaseId || before.id,
              resource: receipt.environment as unknown as Record<string, unknown>,
            }, nowIso)
            environmentRecovery = { eventType: 'environment.released', environmentId: receipt.environment.id, status: receipt.environment.status, cleanup: receipt.environment.cleanup.state }
            appendWorkEventRow(db, 'environment.released', receipt.taskId, {
              dispatchId: receipt.id,
              environmentId: receipt.environment.id,
              action: 'release',
              actor: 'scheduler',
              note: 'expired dispatch-start recovery',
              environment: redactEnvironmentRecord(receipt.environment),
            }, nowIso)
          } catch (err: any) {
            receipt.environment = cleanupFailedEnvironmentRun(before, err?.message || String(err))
            upsertTaskDispatchAcquisitionRow(db, receipt, {
              kind: 'environment',
              status: 'failed',
              provider: before.backend,
              resourceId: before.leaseId || before.id,
              resource: receipt.environment as unknown as Record<string, unknown>,
              error: err?.message || String(err),
            }, nowIso)
            environmentRecovery = { eventType: 'environment.cleanup_failed', environmentId: receipt.environment.id, status: receipt.environment.status, cleanup: receipt.environment.cleanup.state }
            appendWorkEventRow(db, 'environment.cleanup_failed', receipt.taskId, {
              dispatchId: receipt.id,
              environmentId: receipt.environment.id,
              action: 'release',
              actor: 'scheduler',
              note: 'expired dispatch-start recovery',
              environment: redactEnvironmentRecord(receipt.environment),
            }, nowIso)
          }
        }
        receipt.status = 'failed'
        receipt.failureReason = 'Dispatch start lease expired before run start.'
        receipt.updatedAt = nowIso
        upsertTaskDispatchReceiptRow(db, receipt)
        appendWorkEventRow(db, 'task.dispatch.start_expired', receipt.taskId, {
          dispatchId: receipt.id,
          stage: receipt.stage,
          profile: receipt.profile,
          leaseOwner: receipt.leaseOwner,
          leaseExpiresAt: receipt.leaseExpiresAt,
          environmentRecovery,
          recovered: true,
        }, nowIso)
      }
      db.exec('COMMIT')
      return { recovered: expired.length, dispatchIds: expired.map(receipt => receipt.id) }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function countActiveTaskDispatchStarts(filter: { stage?: string; profile?: string } = {}, filePath = workStatePath(), now = Date.now()): number {
  return withWorkDb(filePath, db => {
    const clauses = ["status = 'starting'", 'lease_expires_at > ?']
    const params: unknown[] = [new Date(now).toISOString()]
    if (filter.stage) {
      clauses.push('stage = ?')
      params.push(filter.stage)
    }
    if (filter.profile) {
      clauses.push('profile = ?')
      params.push(filter.profile)
    }
    const row = db.prepare(`SELECT COUNT(*) AS count FROM task_dispatch_receipts WHERE ${clauses.join(' AND ')}`).get(...params) as any
    return Number(row?.count || 0)
  })
}

export function listTaskDispatchReceipts(filter: { taskId?: string; status?: TaskDispatchReceiptStatus; stage?: string; profile?: string } = {}, filePath = workStatePath()): TaskDispatchReceiptRecord[] {
  return withWorkDb(filePath, db => listTaskDispatchReceiptsFromDb(db, filter))
}

export function listTaskDispatchReceiptsFromDb(db: DatabaseSync, filter: { taskId?: string; status?: TaskDispatchReceiptStatus; stage?: string; profile?: string } = {}): TaskDispatchReceiptRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.taskId) {
    clauses.push('task_id = ?')
    params.push(filter.taskId)
  }
  if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  if (filter.stage) {
    clauses.push('stage = ?')
    params.push(filter.stage)
  }
  if (filter.profile) {
    clauses.push('profile = ?')
    params.push(filter.profile)
  }
  const rows = queryRows(db, `SELECT * FROM task_dispatch_receipts${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC`, ...params)
  return rows.map(rowToTaskDispatchReceipt).filter(Boolean) as TaskDispatchReceiptRecord[]
}

export function updateTaskDispatchReceipt(
  dispatchId: string,
  filePath: string,
  fn: (receipt: TaskDispatchReceiptRecord, db: DatabaseSync, now: string) => boolean,
  afterChange?: (receipt: TaskDispatchReceiptRecord, db: DatabaseSync, now: string) => void,
): TaskDispatchReceiptRecord | undefined {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const receipt = rowToTaskDispatchReceipt(db.prepare('SELECT * FROM task_dispatch_receipts WHERE id = ?').get(dispatchId))
      if (!receipt) {
        db.exec('ROLLBACK')
        return undefined
      }
      const now = new Date().toISOString()
      const changed = fn(receipt, db, now)
      if (!changed) {
        db.exec('ROLLBACK')
        return undefined
      }
      afterChange?.(receipt, db, now)
      receipt.updatedAt = now
      upsertTaskDispatchReceiptRow(db, receipt)
      db.exec('COMMIT')
      return receipt
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

interface StoredTaskDispatchAcquisition {
  kind: TaskDispatchAcquisitionKind
  status: TaskDispatchAcquisitionStatus
  provider: string
  idempotencyKey: string
  resourceId?: string
  resource?: Record<string, unknown>
  metadata: Record<string, unknown>
  leadershipScope?: string
  leaderId?: string
  fencingToken?: string
  createdAt: string
  updatedAt: string
  error?: string
}

export function upsertTaskDispatchAcquisitionRow(
  db: DatabaseSync,
  receipt: TaskDispatchReceiptRecord,
  input: {
    kind: TaskDispatchAcquisitionKind
    status: TaskDispatchAcquisitionStatus
    provider: string
    idempotencyKey?: string
    resourceId?: string
    resource?: Record<string, unknown>
    metadata?: Record<string, unknown>
    error?: string
  },
  now: string,
): TaskDispatchAcquisitionRecord {
  const raw = db.prepare('SELECT acquisition_journal_json FROM task_dispatch_receipts WHERE id = ?').get(receipt.id) as { acquisition_journal_json?: unknown } | undefined
  const journal = normalizeStoredTaskDispatchAcquisitions(parseJSON(raw?.acquisition_journal_json, []))
  const index = journal.findIndex(row => row.kind === input.kind)
  const previous = index >= 0 ? journal[index] : undefined
  const epoch = currentWorkDbLeadershipEpoch()
  const preserveAcquired = input.status === 'intent' && previous && previous.status !== 'failed' && previous.status !== 'released'
  const next: StoredTaskDispatchAcquisition = preserveAcquired
    ? { ...previous, updatedAt: now }
    : {
        kind: input.kind,
        status: input.status,
        provider: input.provider || previous?.provider || 'unknown',
        idempotencyKey: input.idempotencyKey || previous?.idempotencyKey || `${receipt.id}:${input.kind}`,
        resourceId: input.resourceId || previous?.resourceId,
        resource: input.resource || previous?.resource,
        metadata: { ...(previous?.metadata || {}), ...(input.metadata || {}) },
        leadershipScope: previous?.leadershipScope || epoch?.scope,
        leaderId: previous?.leaderId || epoch?.leaderId,
        fencingToken: previous?.fencingToken || epoch?.fencingToken,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        error: input.error || (input.status === 'acquired' || input.status === 'released' ? undefined : previous?.error),
      }
  if (index >= 0) journal[index] = next
  else journal.push(next)
  db.prepare('UPDATE task_dispatch_receipts SET acquisition_journal_json = ? WHERE id = ?').run(JSON.stringify(journal), receipt.id)
  return taskDispatchAcquisitionRecord(receipt, next)
}

export function normalizeStoredTaskDispatchAcquisitions(value: unknown): StoredTaskDispatchAcquisition[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(raw => {
    const row = raw as Partial<StoredTaskDispatchAcquisition> | null
    if (
      (row?.kind !== 'environment' && row?.kind !== 'session') ||
      (row.status !== 'intent' && row.status !== 'acquired' && row.status !== 'released' && row.status !== 'failed') ||
      typeof row.provider !== 'string' ||
      typeof row.idempotencyKey !== 'string' ||
      typeof row.createdAt !== 'string' ||
      typeof row.updatedAt !== 'string'
    ) return []
    return [{
      kind: row.kind,
      status: row.status,
      provider: row.provider,
      idempotencyKey: row.idempotencyKey,
      resourceId: typeof row.resourceId === 'string' ? row.resourceId : undefined,
      resource: row.resource && typeof row.resource === 'object' && !Array.isArray(row.resource) ? row.resource : undefined,
      metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {},
      leadershipScope: typeof row.leadershipScope === 'string' ? row.leadershipScope : undefined,
      leaderId: typeof row.leaderId === 'string' ? row.leaderId : undefined,
      fencingToken: typeof row.fencingToken === 'string' ? row.fencingToken : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      error: typeof row.error === 'string' ? row.error : undefined,
    }]
  })
}

export function taskDispatchAcquisitionRows(row: Record<string, unknown>): TaskDispatchAcquisitionRecord[] {
  const receipt: TaskDispatchReceiptRecord = {
    id: String(row['id'] || ''),
    taskId: String(row['task_id'] || ''),
    stage: String(row['stage'] || ''),
    idempotencyKey: '',
    leaseOwner: String(row['lease_owner'] || ''),
    leaseExpiresAt: String(row['lease_expires_at'] || ''),
    status: row['status'] === 'started' || row['status'] === 'failed' ? row['status'] : 'starting',
    createdAt: '',
    updatedAt: '',
  }
  return normalizeStoredTaskDispatchAcquisitions(parseJSON(row['acquisition_journal_json'], []))
    .map(acquisition => taskDispatchAcquisitionRecord(receipt, acquisition))
}

export function taskDispatchAcquisitionRecord(receipt: TaskDispatchReceiptRecord, acquisition: StoredTaskDispatchAcquisition): TaskDispatchAcquisitionRecord {
  return {
    dispatchId: receipt.id,
    taskId: receipt.taskId,
    stage: receipt.stage,
    leaseOwner: receipt.leaseOwner,
    kind: acquisition.kind,
    status: acquisition.status,
    provider: acquisition.provider,
    idempotencyKey: acquisition.idempotencyKey,
    resourceId: acquisition.resourceId,
    resource: acquisition.resource,
    metadata: acquisition.metadata,
    leadershipScope: acquisition.leadershipScope,
    leaderId: acquisition.leaderId,
    fencingToken: acquisition.fencingToken,
    leaseExpiresAt: receipt.leaseExpiresAt,
    dispatchStatus: receipt.status,
    createdAt: acquisition.createdAt,
    updatedAt: acquisition.updatedAt,
    error: acquisition.error,
  }
}

export function upsertTaskDispatchReceiptRow(db: DatabaseSync, receipt: TaskDispatchReceiptRecord): void {
  db.prepare(`INSERT INTO task_dispatch_receipts (
    id, task_id, stage, profile, idempotency_key, lease_owner, lease_expires_at, status,
    run_id, session_id, environment_json, prompt_submitted_at, failure_reason, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    task_id = excluded.task_id,
    stage = excluded.stage,
    profile = excluded.profile,
    idempotency_key = excluded.idempotency_key,
    lease_owner = excluded.lease_owner,
    lease_expires_at = excluded.lease_expires_at,
    status = excluded.status,
    run_id = excluded.run_id,
    session_id = excluded.session_id,
    environment_json = excluded.environment_json,
    prompt_submitted_at = excluded.prompt_submitted_at,
    failure_reason = excluded.failure_reason,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    receipt.id,
    receipt.taskId,
    receipt.stage,
    receipt.profile || null,
    receipt.idempotencyKey,
    receipt.leaseOwner,
    receipt.leaseExpiresAt,
    receipt.status,
    receipt.runId || null,
    receipt.sessionId || null,
    receipt.environment ? JSON.stringify(receipt.environment) : null,
    receipt.promptSubmittedAt || null,
    receipt.failureReason || null,
    receipt.createdAt,
    receipt.updatedAt,
  )
}

export function cleanupDeletedTaskReferences(db: DatabaseSync, taskIds: Set<string>): void {
  const deleteDispatch = db.prepare('DELETE FROM task_dispatch_receipts WHERE task_id = ?')
  const deleteBindings = db.prepare('DELETE FROM channel_bindings WHERE task_id = ?')
  const deleteGates = db.prepare('DELETE FROM human_gates WHERE task_id = ?')
  const clearAdmissions = db.prepare('UPDATE session_admissions SET task_id = NULL WHERE task_id = ?')
  for (const taskId of taskIds) {
    deleteDispatch.run(taskId)
    deleteBindings.run(taskId)
    deleteGates.run(taskId)
    clearAdmissions.run(taskId)
  }
}

