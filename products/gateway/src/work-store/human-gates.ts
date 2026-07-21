/**
 * Human gates domain for Durable Gateway work-store (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts (keeps dependency graph acyclic).
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { getConfig, type HumanGateTimeoutAction } from '../config.js'
import { openWorkDb, queryRows, withWorkDb, withWorkDbReadOnly, workStatePath } from './db.js'
import { rowToHumanGate } from './row-mappers.js'
import {
  normalizeOptionalIsoTime,
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeStage,
} from './validators.js'
import {
  OPEN_HUMAN_GATE_STATUSES,
  type HumanGateDecision,
  type HumanGateInput,
  type HumanGateRecord,
  type HumanGateScope,
  type HumanGateStatus,
  type HumanGateType,
  type ManualGate,
  type WorkTaskRecord,
} from './types.js'
import { appendWorkEventRow } from './event-append.js'

export function listHumanGates(filter: { status?: HumanGateStatus | 'open'; taskId?: string; roadmapId?: string } = {}, filePath = workStatePath()): HumanGateRecord[] {
  return withWorkDb(filePath, db => listHumanGatesFromDb(db, filter))
}

export function listHumanGatesReadOnly(filter: { status?: HumanGateStatus | 'open'; taskId?: string; roadmapId?: string } = {}, filePath = workStatePath()): HumanGateRecord[] {
  return withWorkDbReadOnly(filePath, db => listHumanGatesFromDb(db, filter))
}

function listHumanGatesFromDb(db: DatabaseSync, filter: { status?: HumanGateStatus | 'open'; taskId?: string; roadmapId?: string } = {}): HumanGateRecord[] {
  // Filter in SQL so idx_human_gates_status / idx_human_gates_task serve the
  // hot dashboard/alert-engine queries instead of loading every gate row.
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.status === 'open') {
    clauses.push(`status IN (${OPEN_HUMAN_GATE_STATUSES.map(() => '?').join(', ')})`)
    params.push(...OPEN_HUMAN_GATE_STATUSES)
  } else if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  if (filter.taskId) {
    clauses.push('task_id = ?')
    params.push(filter.taskId)
  }
  if (filter.roadmapId) {
    clauses.push('roadmap_id = ?')
    params.push(filter.roadmapId)
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = queryRows(db, `SELECT * FROM human_gates${where} ORDER BY requested_at ASC`, ...params)
  return rows.map(rowToHumanGate).filter(Boolean) as HumanGateRecord[]
}

export function getHumanGate(id: string, filePath = workStatePath()): HumanGateRecord | undefined {
  return withWorkDb(filePath, db => rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id)) || undefined)
}

export function createHumanGate(input: HumanGateInput, filePath = workStatePath()): HumanGateRecord {
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const gate = insertHumanGateRow(db, input, new Date().toISOString(), { force: true })!
      db.exec('COMMIT')
      return gate
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function ensureHumanGate(input: HumanGateInput, filePath = workStatePath()): HumanGateRecord | undefined {
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const gate = insertHumanGateRow(db, input, new Date().toISOString(), { force: false })
      db.exec('COMMIT')
      return gate
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function manualGateReason(gate: ManualGate): string {
  if (gate === 'approval_required') return 'Waiting for operator approval'
  if (gate === 'credentials_required') return 'Waiting for credentials'
  if (gate === 'external_dependency') return 'Waiting for an external dependency'
  return 'Waiting for user input'
}

export function humanGateInputForManualTask(task: WorkTaskRecord): HumanGateInput {
  const manualGate = task.manualGate || 'waiting_for_user'
  return {
    type: humanGateTypeForManualGate(manualGate),
    roadmapId: task.roadmapId,
    taskId: task.id,
    stage: task.currentStage || task.pipeline[0] || 'implement',
    reason: manualGateReason(manualGate),
    requestedBy: 'gateway.manual_gate',
    scopeKey: `manual:${task.id}:${manualGate}`,
    details: { manualGate },
  }
}

function humanGateTypeForManualGate(gate: ManualGate): HumanGateType {
  if (gate === 'approval_required') return 'task_start'
  if (gate === 'credentials_required') return 'credential_use'
  if (gate === 'external_dependency') return 'external_side_effect'
  return 'manual'
}

export function insertHumanGateRow(db: DatabaseSync, input: HumanGateInput, now: string, options: { force: boolean }): HumanGateRecord | undefined {
  const type = normalizeHumanGateType(input.type)
  const taskId = normalizeOptionalString(input.taskId, 120)
  const roadmapId = normalizeOptionalString(input.roadmapId, 120)
  const runId = normalizeOptionalString(input.runId, 120)
  const stage = input.stage ? normalizeStage(input.stage, 'stage') : undefined
  const reason = normalizeRequiredString(input.reason, 'reason', 1000)
  const requestedBy = normalizeOptionalString(input.requestedBy, 120) || 'gateway'
  const timeoutAction = normalizeHumanGateTimeoutAction(input.timeoutAction || getConfig().humanLoop.timeoutAction)
  const expiresAt = normalizeOptionalIsoTime(input.expiresAt, 'expiresAt') || defaultHumanGateExpiresAt(taskId, now)
  const scopeKey = normalizeOptionalString(input.scopeKey, 300) || defaultHumanGateScopeKey({ type, taskId, roadmapId, runId, stage })
  const details = input.details && typeof input.details === 'object' && !Array.isArray(input.details) ? input.details : {}

  if (!options.force && scopeKey) {
    const approved = rowToHumanGate(db.prepare("SELECT * FROM human_gates WHERE scope_key = ? AND status = 'approved' ORDER BY updated_at DESC LIMIT 1").get(scopeKey))
    if (approved) return undefined
    const existingOpen = rowToHumanGate(db.prepare("SELECT * FROM human_gates WHERE scope_key = ? AND status IN ('pending', 'escalated') ORDER BY requested_at ASC LIMIT 1").get(scopeKey))
    if (existingOpen) return existingOpen
  }

  const id = `gate_${randomUUID()}`
  db.prepare(`INSERT INTO human_gates (
    id, type, status, roadmap_id, task_id, run_id, stage, reason, requested_by, requested_at, updated_at,
    expires_at, timeout_action, scope_key, details_json
  ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    type,
    roadmapId || null,
    taskId || null,
    runId || null,
    stage || null,
    reason,
    requestedBy,
    now,
    now,
    expiresAt || null,
    timeoutAction,
    scopeKey || null,
    JSON.stringify(details),
  )
  appendWorkEventRow(db, 'human_gate.created', taskId || roadmapId || id, { gateId: id, type, stage, reason, expiresAt, timeoutAction }, now)
  return rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(id))!
}

function defaultHumanGateExpiresAt(taskId: string | undefined, now: string): string | undefined {
  const config = getConfig().humanLoop
  if (!config.enabled) return undefined
  void taskId
  return new Date(Date.parse(now) + config.defaultTimeoutMs).toISOString()
}

function defaultHumanGateScopeKey(input: { type: HumanGateType; taskId?: string; roadmapId?: string; runId?: string; stage?: string }): string | undefined {
  if (input.runId) return `${input.type}:run:${input.runId}`
  if (input.taskId) return `${input.type}:task:${input.taskId}:${input.stage || ''}`
  if (input.roadmapId) return `${input.type}:roadmap:${input.roadmapId}:${input.stage || ''}`
  return undefined
}

function normalizeHumanGateType(value: unknown): HumanGateType {
  if (value === 'task_start' || value === 'stage_transition' || value === 'external_side_effect' || value === 'budget_exception' || value === 'destructive_action' || value === 'credential_use' || value === 'manual') return value
  throw new Error(`human gate type must be task_start, stage_transition, external_side_effect, budget_exception, destructive_action, credential_use, or manual: ${String(value)}`)
}

export function normalizeHumanGateDecision(value: unknown): HumanGateDecision {
  if (value === 'approve' || value === 'reject') return value
  throw new Error(`human gate decision must be approve or reject: ${String(value)}`)
}

export function normalizeHumanGateScope(value: unknown): HumanGateScope {
  if (value === undefined || value === null || value === '') return 'once'
  if (value === 'once' || value === 'always') return value
  throw new Error(`human gate scope must be once or always: ${String(value)}`)
}

function normalizeHumanGateTimeoutAction(value: unknown): HumanGateTimeoutAction {
  if (value === 'remind' || value === 'escalate' || value === 'pause' || value === 'block') return value
  throw new Error(`human gate timeout action must be remind, escalate, pause, or block: ${String(value)}`)
}
