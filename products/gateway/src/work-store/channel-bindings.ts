/**
 * Channel bindings and claim codes for Durable Gateway work-store (JOE-942 / JOE-919).
 * Behavior-preserving extract from work-store.ts.
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkDb, queryRows, withWorkDb, withWorkDbReadOnly, workStatePath } from './db.js'
import { assertNoStorageOperationInProgress } from './storage-lock.js'
import { rowToChannelBinding, rowToChannelClaimCode } from './row-mappers.js'
import {
  normalizeHash,
  normalizeOptionalIsoTime,
  normalizeOptionalString,
  normalizeProviderId,
  normalizeRequiredString,
  normalizeThreadId,
} from './validators.js'
import type {
  ChannelBindingMode,
  ChannelBindingRecord,
  ChannelClaimAction,
  ChannelClaimCodeRecord,
  ChannelClaimStatus,
} from './types.js'
import { appendWorkEventRow } from './event-append.js'

function normalizeChannelBindingMode(value: unknown): ChannelBindingMode {
  if (value === undefined || value === null || value === '') return 'chat'
  if (value === 'chat' || value === 'task' || value === 'roadmap') return value
  throw new Error(`channel binding mode must be chat, task, or roadmap: ${String(value)}`)
}

function normalizeChannelClaimAction(value: unknown): ChannelClaimAction {
  if (value === 'trust_target' || value === 'prove_denial') return value
  throw new Error('claim.action must be trust_target or prove_denial')
}

export function getChannelBinding(provider: string, chatId: string, threadId?: string, filePath = workStatePath()): ChannelBindingRecord | undefined {
  return withWorkDb(filePath, db => {
    const row = db.prepare('SELECT * FROM channel_bindings WHERE provider = ? AND chat_id = ? AND thread_id = ?')
      .get(provider, chatId, normalizeThreadId(threadId)) as any
    return row ? rowToChannelBinding(row) || undefined : undefined
  })
}

export function upsertChannelBinding(input: {
  provider: string
  chatId: string
  threadId?: string
  sessionId: string
  mode?: ChannelBindingMode
  roadmapId?: string
  taskId?: string
  title?: string
}, filePath = workStatePath()): ChannelBindingRecord {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const provider = normalizeProviderId(input.provider, 'channelBinding.provider')
      const chatId = normalizeRequiredString(input.chatId, 'channelBinding.chatId', 200)
      const threadId = normalizeThreadId(input.threadId)
      const sessionId = normalizeRequiredString(input.sessionId, 'channelBinding.sessionId', 200)
      const mode = normalizeChannelBindingMode(input.mode)
      const existingRow = db.prepare('SELECT * FROM channel_bindings WHERE provider = ? AND chat_id = ? AND thread_id = ?').get(provider, chatId, threadId)
      const existing = existingRow ? rowToChannelBinding(existingRow) || undefined : undefined
      const roadmapId = mode === 'roadmap' ? normalizeRequiredString(input.roadmapId, 'channelBinding.roadmapId', 120) : undefined
      const taskId = mode === 'task' ? normalizeRequiredString(input.taskId, 'channelBinding.taskId', 120) : undefined
      if (roadmapId) {
        const roadmap = db.prepare('SELECT status FROM roadmaps WHERE id = ?').get(roadmapId) as { status?: unknown } | undefined
        if (!roadmap) throw new Error(`roadmap not found: ${roadmapId}`)
        if (roadmap.status === 'archived') throw new Error(`roadmap is archived: ${roadmapId}`)
      }
      if (taskId) {
        const task = db.prepare('SELECT roadmap_id FROM tasks WHERE id = ?').get(taskId) as { roadmap_id?: unknown } | undefined
        if (!task) throw new Error(`task not found: ${taskId}`)
        if (!db.prepare('SELECT id FROM roadmaps WHERE id = ?').get(task.roadmap_id)) throw new Error(`task roadmap not found: ${String(task.roadmap_id || '')}`)
      }
      const now = new Date().toISOString()
      const record: ChannelBindingRecord = {
        provider,
        chatId,
        threadId: threadId || undefined,
        sessionId,
        mode,
        roadmapId,
        taskId,
        title: normalizeOptionalString(input.title, 200),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      }
      upsertChannelBindingRow(db, record, now)
      appendWorkEventRow(db, 'channel.binding.upserted', record.sessionId, { provider: record.provider, chatId: record.chatId, threadId: record.threadId, mode: record.mode, roadmapId: record.roadmapId, taskId: record.taskId }, now)
      db.exec('COMMIT')
      return record
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function listChannelBindings(filter: { provider?: string; chatId?: string; threadId?: string; sessionId?: string } = {}, filePath = workStatePath()): ChannelBindingRecord[] {
  return withWorkDb(filePath, db => listChannelBindingsFromDb(db, filter))
}

export function listChannelBindingsReadOnly(filter: { provider?: string; chatId?: string; threadId?: string; sessionId?: string } = {}, filePath = workStatePath()): ChannelBindingRecord[] {
  return withWorkDbReadOnly(filePath, db => listChannelBindingsFromDb(db, filter))
}

function listChannelBindingsFromDb(db: DatabaseSync, filter: { provider?: string; chatId?: string; threadId?: string; sessionId?: string } = {}): ChannelBindingRecord[] {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.provider) { clauses.push('provider = ?'); params.push(filter.provider) }
  if (filter.chatId) { clauses.push('chat_id = ?'); params.push(filter.chatId) }
  if (filter.threadId !== undefined) { clauses.push('thread_id = ?'); params.push(normalizeThreadId(filter.threadId)) }
  if (filter.sessionId) { clauses.push('session_id = ?'); params.push(filter.sessionId) }
  const sql = `SELECT * FROM channel_bindings${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`
  return queryRows(db, sql, ...params).map(rowToChannelBinding).filter(Boolean) as ChannelBindingRecord[]
}

export function deleteChannelBinding(provider: string, chatId: string, threadId?: string, filePath = workStatePath()): boolean {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const normalizedThreadId = normalizeThreadId(threadId)
      const binding = rowToChannelBinding(db.prepare('SELECT * FROM channel_bindings WHERE provider = ? AND chat_id = ? AND thread_id = ?').get(provider, chatId, normalizedThreadId)) || undefined
      if (!binding) {
        db.exec('ROLLBACK')
        return false
      }
      const result = db.prepare('DELETE FROM channel_bindings WHERE provider = ? AND chat_id = ? AND thread_id = ?')
        .run(provider, chatId, normalizedThreadId) as any
      const deleted = Number(result?.changes || 0) > 0
      if (deleted) appendWorkEventRow(db, 'channel.binding.deleted', binding.sessionId, { provider, chatId, threadId: normalizedThreadId || undefined }, new Date().toISOString())
      db.exec('COMMIT')
      return deleted
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function createChannelClaimCodeRecord(input: {
  id: string
  provider: string
  action: ChannelClaimAction
  codeHash: string
  codeFingerprint: string
  createdBy?: string
  createdAt?: string
  expiresAt: string
}, filePath = workStatePath()): ChannelClaimCodeRecord {
  const now = normalizeOptionalIsoTime(input.createdAt, 'createdAt') || new Date().toISOString()
  const record: ChannelClaimCodeRecord = {
    id: normalizeRequiredString(input.id, 'claim.id', 120),
    provider: normalizeProviderId(input.provider, 'claim.provider'),
    action: normalizeChannelClaimAction(input.action),
    codeHash: normalizeHash(input.codeHash, 'claim.codeHash'),
    codeFingerprint: normalizeRequiredString(input.codeFingerprint, 'claim.codeFingerprint', 40),
    status: 'pending',
    createdBy: normalizeOptionalString(input.createdBy, 120) || 'operator',
    createdAt: now,
    expiresAt: normalizeOptionalIsoTime(input.expiresAt, 'expiresAt') || (() => { throw new Error('expiresAt must be an ISO timestamp') })(),
  }
  const db = openWorkDb(filePath)
  try {
    db.prepare(`INSERT INTO channel_claim_codes (
      id, provider, action, code_hash, code_fingerprint, status, created_by, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.provider, record.action, record.codeHash, record.codeFingerprint, record.status, record.createdBy, record.createdAt, record.expiresAt)
  } finally {
    db.close()
  }
  return record
}

export function findChannelClaimCodeByHash(codeHash: string, filePath = workStatePath()): ChannelClaimCodeRecord | undefined {
  return withWorkDb(filePath, db => {
    const row = db.prepare('SELECT * FROM channel_claim_codes WHERE code_hash = ? ORDER BY created_at DESC LIMIT 1')
      .get(normalizeHash(codeHash, 'claim.codeHash')) as any
    return row ? rowToChannelClaimCode(row) || undefined : undefined
  })
}

export function listChannelClaimCodes(filter: { provider?: string; status?: ChannelClaimStatus; now?: Date } = {}, filePath = workStatePath()): ChannelClaimCodeRecord[] {
  return withWorkDb(filePath, db => listChannelClaimCodesFromDb(db, filter))
}

export function listChannelClaimCodesReadOnly(filter: { provider?: string; status?: ChannelClaimStatus; now?: Date } = {}, filePath = workStatePath()): ChannelClaimCodeRecord[] {
  return withWorkDbReadOnly(filePath, db => listChannelClaimCodesFromDb(db, filter))
}

function listChannelClaimCodesFromDb(db: DatabaseSync, filter: { provider?: string; status?: ChannelClaimStatus; now?: Date } = {}): ChannelClaimCodeRecord[] {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.provider) { clauses.push('provider = ?'); params.push(normalizeProviderId(filter.provider, 'claim.provider')) }
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status) }
  if (filter.now) { clauses.push('expires_at > ?'); params.push(filter.now.toISOString()) }
  const sql = `SELECT * FROM channel_claim_codes${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`
  return queryRows(db, sql, ...params).map(rowToChannelClaimCode).filter(Boolean) as ChannelClaimCodeRecord[]
}

export function updateChannelClaimCodeStatus(id: string, update: {
  status: ChannelClaimStatus
  acceptedAt?: string
  acceptedTargetHash?: string
  deniedAt?: string
  denialReason?: string
}, filePath = workStatePath()): ChannelClaimCodeRecord | undefined {
  return withWorkDb(filePath, db => {
    db.prepare(`UPDATE channel_claim_codes SET
      status = ?,
      accepted_at = COALESCE(?, accepted_at),
      accepted_target_hash = COALESCE(?, accepted_target_hash),
      denied_at = COALESCE(?, denied_at),
      denial_reason = COALESCE(?, denial_reason)
      WHERE id = ?`)
      .run(
        update.status,
        update.acceptedAt || null,
        normalizeOptionalString(update.acceptedTargetHash, 80) || null,
        update.deniedAt || null,
        normalizeOptionalString(update.denialReason, 120) || null,
        normalizeRequiredString(id, 'claim.id', 120),
      )
    const row = db.prepare('SELECT * FROM channel_claim_codes WHERE id = ?').get(id) as any
    return row ? rowToChannelClaimCode(row) || undefined : undefined
  })
}

export function clearChannelBindingsForTest(filePath = workStatePath()): void {
  const db = openWorkDb(filePath)
  try { db.exec('DELETE FROM channel_bindings') }
  finally { db.close() }
}

export function upsertChannelBindingRow(db: DatabaseSync, input: { provider: string; chatId: string; threadId?: string; sessionId: string; mode?: ChannelBindingMode; roadmapId?: string; taskId?: string; title?: string; createdAt?: string }, now: string): void {
  db.prepare(`INSERT INTO channel_bindings (
    provider, chat_id, thread_id, session_id, mode, roadmap_id, task_id, title, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider, chat_id, thread_id) DO UPDATE SET
    session_id = excluded.session_id,
    mode = excluded.mode,
    roadmap_id = excluded.roadmap_id,
    task_id = excluded.task_id,
    title = excluded.title,
    updated_at = excluded.updated_at`)
    .run(input.provider, input.chatId, normalizeThreadId(input.threadId), input.sessionId, input.mode || 'chat', input.roadmapId || null, input.taskId || null, input.title || null, input.createdAt || now, now)
}

