/**
 * JOE-996 / H1: durable coordination state for ChannelSyncBridge.
 *
 * Authoritative store is `channel-sync.json.sqlite` (same file as the outbox).
 * Legacy `channel-sync.json` is imported once when the SQLite coordination
 * tables are empty. Outbound delivery receipts remain in `channel_sync_outbox`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { recoverInterruptedStorageRestore, restrictSqliteDbPermissions } from './work-store.js'
import { queueEvent } from './wakeup.js'

const RECENT_SEEN_LIMIT = 5000

export interface DeliveryCheckpoint {
  sessionId: string
  provider: string
  chatId: string
  threadId?: string
  initializedAt: string
  updatedAt: string
  lastMessageCreated: number
  lastMessageCreatedIds: string[]
  seenMessageIds: string[]
}

export interface PendingInbound {
  sessionId: string
  provider: string
  chatId: string
  threadId?: string
  textHash: string
  createdAt: number
  submitLeaseUntil?: number
  submittedAt?: number
  providerMessageId?: string
  messageId?: string
}

export interface InboundReceipt {
  sessionId: string
  provider: string
  chatId: string
  threadId?: string
  providerMessageId: string
  textHash: string
  createdAt: number
  submitLeaseUntil?: number
  submittedAt?: number
}

export interface ChannelSyncState {
  savedAt: string
  deliveries: Record<string, DeliveryCheckpoint>
  pendingInbound: PendingInbound[]
  inboundReceipts: Record<string, InboundReceipt>
}

export function emptyChannelSyncState(now = Date.now()): ChannelSyncState {
  return {
    savedAt: new Date(now).toISOString(),
    deliveries: {},
    pendingInbound: [],
    inboundReceipts: {},
  }
}

function openCoordDb(outboxFile: string): DatabaseSync {
  const dbPath = path.resolve(outboxFile)
  recoverInterruptedStorageRestore(path.dirname(dbPath))
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
  try { fs.chmodSync(path.dirname(dbPath), 0o700) } catch {}
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_sync_coord_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_sync_deliveries (
      checkpoint_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      initialized_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_created INTEGER NOT NULL DEFAULT 0,
      last_message_created_ids_json TEXT NOT NULL DEFAULT '[]',
      seen_message_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS channel_sync_pending_inbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      text_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      submit_lease_until INTEGER,
      submitted_at INTEGER,
      provider_message_id TEXT,
      message_id TEXT
    );
    CREATE TABLE IF NOT EXISTS channel_sync_inbound_receipts (
      receipt_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      provider_message_id TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      submit_lease_until INTEGER,
      submitted_at INTEGER
    );
  `)
  restrictSqliteDbPermissions(dbPath)
  return db
}

export function loadChannelSyncCoordinationState(
  outboxFile: string,
  legacyJsonFile: string,
  now = Date.now(),
): ChannelSyncState {
  const db = openCoordDb(outboxFile)
  try {
    const deliveryCount = Number((db.prepare('SELECT COUNT(*) AS c FROM channel_sync_deliveries').get() as { c?: number })?.c || 0)
    const pendingCount = Number((db.prepare('SELECT COUNT(*) AS c FROM channel_sync_pending_inbound').get() as { c?: number })?.c || 0)
    const receiptCount = Number((db.prepare('SELECT COUNT(*) AS c FROM channel_sync_inbound_receipts').get() as { c?: number })?.c || 0)
    if (deliveryCount === 0 && pendingCount === 0 && receiptCount === 0 && fs.existsSync(legacyJsonFile)) {
      const imported = importLegacyJson(legacyJsonFile, now)
      if (imported) {
        persistState(db, imported)
        return imported
      }
    }
    return readStateFromDb(db, now)
  } finally {
    try { db.close() } catch {}
  }
}

export function saveChannelSyncCoordinationState(outboxFile: string, state: ChannelSyncState): void {
  const db = openCoordDb(outboxFile)
  try {
    persistState(db, state)
  } finally {
    try { db.close() } catch {}
  }
}

export function readChannelSyncCoordinationState(
  outboxFile: string,
  legacyJsonFile?: string,
  now = Date.now(),
): ChannelSyncState | null {
  if (!fs.existsSync(outboxFile) && legacyJsonFile && fs.existsSync(legacyJsonFile)) {
    return importLegacyJson(legacyJsonFile, now)
  }
  if (!fs.existsSync(outboxFile)) return null
  try {
    return loadChannelSyncCoordinationState(outboxFile, legacyJsonFile || '', now)
  } catch {
    return null
  }
}

function persistState(db: DatabaseSync, state: ChannelSyncState): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO channel_sync_coord_meta (key, value) VALUES ('saved_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(state.savedAt)
    db.prepare('DELETE FROM channel_sync_deliveries').run()
    db.prepare('DELETE FROM channel_sync_pending_inbound').run()
    db.prepare('DELETE FROM channel_sync_inbound_receipts').run()

    const insertDelivery = db.prepare(`
      INSERT INTO channel_sync_deliveries (
        checkpoint_key, session_id, provider, chat_id, thread_id,
        initialized_at, updated_at, last_message_created,
        last_message_created_ids_json, seen_message_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const [key, row] of Object.entries(state.deliveries)) {
      insertDelivery.run(
        key,
        row.sessionId,
        row.provider,
        row.chatId,
        row.threadId || '',
        row.initializedAt,
        row.updatedAt,
        row.lastMessageCreated,
        JSON.stringify(row.lastMessageCreatedIds || []),
        JSON.stringify(row.seenMessageIds || []),
      )
    }

    const insertPending = db.prepare(`
      INSERT INTO channel_sync_pending_inbound (
        session_id, provider, chat_id, thread_id, text_hash, created_at,
        submit_lease_until, submitted_at, provider_message_id, message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const row of state.pendingInbound) {
      insertPending.run(
        row.sessionId,
        row.provider,
        row.chatId,
        row.threadId || '',
        row.textHash,
        row.createdAt,
        row.submitLeaseUntil ?? null,
        row.submittedAt ?? null,
        row.providerMessageId ?? null,
        row.messageId ?? null,
      )
    }

    const insertReceipt = db.prepare(`
      INSERT INTO channel_sync_inbound_receipts (
        receipt_key, session_id, provider, chat_id, thread_id,
        provider_message_id, text_hash, created_at, submit_lease_until, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const [key, row] of Object.entries(state.inboundReceipts)) {
      insertReceipt.run(
        key,
        row.sessionId,
        row.provider,
        row.chatId,
        row.threadId || '',
        row.providerMessageId,
        row.textHash,
        row.createdAt,
        row.submitLeaseUntil ?? null,
        row.submittedAt ?? null,
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

function readStateFromDb(db: DatabaseSync, now: number): ChannelSyncState {
  const savedAt = String((db.prepare("SELECT value FROM channel_sync_coord_meta WHERE key = 'saved_at'").get() as { value?: string } | undefined)?.value || new Date(now).toISOString())
  const deliveries: Record<string, DeliveryCheckpoint> = {}
  for (const row of db.prepare('SELECT * FROM channel_sync_deliveries').all() as Array<Record<string, unknown>>) {
    const key = String(row['checkpoint_key'] || '')
    if (!key) continue
    deliveries[key] = {
      sessionId: String(row['session_id'] || ''),
      provider: String(row['provider'] || ''),
      chatId: String(row['chat_id'] || ''),
      threadId: String(row['thread_id'] || '') || undefined,
      initializedAt: String(row['initialized_at'] || new Date(now).toISOString()),
      updatedAt: String(row['updated_at'] || new Date(now).toISOString()),
      lastMessageCreated: Number(row['last_message_created'] || 0),
      lastMessageCreatedIds: parseStringArray(row['last_message_created_ids_json']).slice(-RECENT_SEEN_LIMIT),
      seenMessageIds: parseStringArray(row['seen_message_ids_json']).slice(-RECENT_SEEN_LIMIT),
    }
  }
  const pendingInbound: PendingInbound[] = (db.prepare('SELECT * FROM channel_sync_pending_inbound ORDER BY id ASC').all() as Array<Record<string, unknown>>).map((row) => ({
    sessionId: String(row['session_id'] || ''),
    provider: String(row['provider'] || ''),
    chatId: String(row['chat_id'] || ''),
    threadId: String(row['thread_id'] || '') || undefined,
    textHash: String(row['text_hash'] || ''),
    createdAt: Number(row['created_at'] || 0),
    submitLeaseUntil: row['submit_lease_until'] == null ? undefined : Number(row['submit_lease_until']),
    submittedAt: row['submitted_at'] == null ? undefined : Number(row['submitted_at']),
    providerMessageId: row['provider_message_id'] == null ? undefined : String(row['provider_message_id']),
    messageId: row['message_id'] == null ? undefined : String(row['message_id']),
  }))
  const inboundReceipts: Record<string, InboundReceipt> = {}
  for (const row of db.prepare('SELECT * FROM channel_sync_inbound_receipts').all() as Array<Record<string, unknown>>) {
    const key = String(row['receipt_key'] || '')
    if (!key) continue
    inboundReceipts[key] = {
      sessionId: String(row['session_id'] || ''),
      provider: String(row['provider'] || ''),
      chatId: String(row['chat_id'] || ''),
      threadId: String(row['thread_id'] || '') || undefined,
      providerMessageId: String(row['provider_message_id'] || ''),
      textHash: String(row['text_hash'] || ''),
      createdAt: Number(row['created_at'] || 0),
      submitLeaseUntil: row['submit_lease_until'] == null ? undefined : Number(row['submit_lease_until']),
      submittedAt: row['submitted_at'] == null ? undefined : Number(row['submitted_at']),
    }
  }
  return { savedAt, deliveries, pendingInbound, inboundReceipts }
}

function importLegacyJson(legacyJsonFile: string, now: number): ChannelSyncState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyJsonFile, 'utf-8'))
    return {
      savedAt: typeof parsed?.savedAt === 'string' ? parsed.savedAt : new Date(now).toISOString(),
      deliveries: normalizeDeliveries(parsed?.deliveries, now),
      pendingInbound: normalizePending(parsed?.pendingInbound),
      inboundReceipts: normalizeInboundReceipts(parsed?.inboundReceipts),
    }
  } catch (err: any) {
    // Match prior loadState behavior: quarantine corrupt JSON when possible.
    const quarantine = `${legacyJsonFile}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, '-')}`
    try {
      fs.renameSync(legacyJsonFile, quarantine)
      console.error(`[channel-sync] state file was unreadable (${err?.message || String(err)}); quarantined to ${quarantine} and reinitialized delivery checkpoints`)
      queueEvent(`Channel sync state was corrupt; quarantined to ${path.basename(quarantine)} and reinitialized delivery checkpoints`)
    } catch {
      // leave null → caller reinitializes empty
    }
    return null
  }
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function normalizeThreadId(threadId?: string | null): string {
  return threadId ? String(threadId) : ''
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function normalizeProviderMessageId(value?: string | null): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized ? normalized.substring(0, 300) : undefined
}

function normalizeDeliveries(value: any, now: number): Record<string, DeliveryCheckpoint> {
  const out: Record<string, DeliveryCheckpoint> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, row] of Object.entries(value)) {
    if (!row || typeof row !== 'object') continue
    const r = row as any
    if (typeof r.sessionId !== 'string' || typeof r.provider !== 'string' || typeof r.chatId !== 'string') continue
    out[key] = {
      sessionId: r.sessionId,
      provider: r.provider,
      chatId: r.chatId,
      threadId: normalizeThreadId(r.threadId) || undefined,
      initializedAt: typeof r.initializedAt === 'string' ? r.initializedAt : new Date(now).toISOString(),
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(now).toISOString(),
      lastMessageCreated: Number(r.lastMessageCreated || 0),
      lastMessageCreatedIds: Array.isArray(r.lastMessageCreatedIds) ? r.lastMessageCreatedIds.filter((id: any) => typeof id === 'string').slice(-RECENT_SEEN_LIMIT) : [],
      seenMessageIds: Array.isArray(r.seenMessageIds) ? r.seenMessageIds.filter((id: any) => typeof id === 'string').slice(-RECENT_SEEN_LIMIT) : [],
    }
  }
  return out
}

function normalizePending(value: any): PendingInbound[] {
  if (!Array.isArray(value)) return []
  return value.filter((row: any) =>
    row
    && typeof row.sessionId === 'string'
    && typeof row.provider === 'string'
    && typeof row.chatId === 'string'
    && (typeof row.textHash === 'string' || typeof row.text === 'string')
    && typeof row.createdAt === 'number',
  ).map((row: any) => ({
    sessionId: row.sessionId,
    provider: row.provider,
    chatId: row.chatId,
    threadId: normalizeThreadId(row.threadId) || undefined,
    textHash: typeof row.textHash === 'string' ? row.textHash : hashText(row.text),
    createdAt: row.createdAt,
    submitLeaseUntil: typeof row.submitLeaseUntil === 'number' ? row.submitLeaseUntil : undefined,
    submittedAt: typeof row.submittedAt === 'number' ? row.submittedAt : undefined,
    providerMessageId: normalizeProviderMessageId(row.providerMessageId),
    messageId: typeof row.messageId === 'string' ? row.messageId : undefined,
  }))
}

function normalizeInboundReceipts(value: any): Record<string, InboundReceipt> {
  const out: Record<string, InboundReceipt> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, row] of Object.entries(value)) {
    const r = row as any
    const providerMessageId = normalizeProviderMessageId(r?.providerMessageId)
    if (!r || typeof r !== 'object' || typeof r.provider !== 'string' || typeof r.chatId !== 'string' || !providerMessageId || typeof r.textHash !== 'string' || typeof r.createdAt !== 'number') continue
    const normalized: InboundReceipt = {
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
      provider: r.provider,
      chatId: r.chatId,
      threadId: normalizeThreadId(r.threadId) || undefined,
      providerMessageId,
      textHash: r.textHash,
      createdAt: r.createdAt,
      submitLeaseUntil: typeof r.submitLeaseUntil === 'number' ? r.submitLeaseUntil : undefined,
      submittedAt: typeof r.submittedAt === 'number' ? r.submittedAt : undefined,
    }
    out[key || hashText([normalized.provider, normalized.chatId, normalized.threadId || '', providerMessageId].join('\u0000'))] = normalized
  }
  return out
}
