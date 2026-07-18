/**
 * AgentPresence — durable always-on assistant binding.
 *
 * Intentionally named to avoid collision with channel "typing presence"
 * (src/channel-actions.ts). Personas remain OpenCode-native agents; this module
 * only binds session + channel + wake metadata in gateway.db.
 */
import { randomUUID } from 'node:crypto'
import { openWorkDb, workStatePath } from './work-store.js'
import { listOpenCodeAgents } from './opencode-assets.js'
import { normalizeOptionalString, normalizeRequiredString } from './work-store/validators.js'

export type AgentPresenceKind = 'assistant'
export type AgentPresenceStatus = 'active' | 'paused' | 'blocked' | 'archived'

export interface AgentPresenceRecord {
  presenceId: string
  kind: AgentPresenceKind
  name: string
  opencodeAgent: string
  sessionId?: string
  directory?: string
  profile?: string
  status: AgentPresenceStatus
  wake: Record<string, unknown>
  provider?: string
  chatId?: string
  threadId?: string
  note?: string
  createdAt: string
  updatedAt: string
}

export interface AgentPresenceCreateInput {
  name: string
  opencodeAgent: string
  sessionId?: string
  directory?: string
  profile?: string
  status?: AgentPresenceStatus
  /** Reserved for future cadence/wake policy; not scheduled in v1 (sticky chat model). */
  wake?: Record<string, unknown>
  provider?: string
  chatId?: string
  threadId?: string
  note?: string
}

export interface AgentPresenceUpdateInput {
  name?: string
  opencodeAgent?: string
  sessionId?: string | null
  directory?: string | null
  profile?: string | null
  status?: AgentPresenceStatus
  wake?: Record<string, unknown>
  provider?: string | null
  chatId?: string | null
  threadId?: string | null
  note?: string | null
}

const STATUSES = new Set<AgentPresenceStatus>(['active', 'paused', 'blocked', 'archived'])

/** Public create always enforces OpenCode agent existence. */
export function createAgentPresence(input: AgentPresenceCreateInput, filePath = workStatePath()): AgentPresenceRecord {
  return createAgentPresenceInternal(input, filePath, false)
}

/**
 * Test-only helper: skips OpenCode agent existence (temp config dirs). Never used by HTTP/MCP/CLI.
 */
export function createAgentPresenceForTest(input: AgentPresenceCreateInput, filePath = workStatePath()): AgentPresenceRecord {
  return createAgentPresenceInternal(input, filePath, true)
}

function createAgentPresenceInternal(input: AgentPresenceCreateInput, filePath: string, skipAgentCheck: boolean): AgentPresenceRecord {
  const name = normalizeRequiredString(input.name, 'presence name', 120)
  const opencodeAgent = normalizeRequiredString(input.opencodeAgent, 'opencode agent', 120)
  if (!skipAgentCheck) assertOpenCodeAgentExists(opencodeAgent)
  const now = new Date().toISOString()
  const record: AgentPresenceRecord = {
    presenceId: `ap_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    kind: 'assistant',
    name,
    opencodeAgent,
    sessionId: normalizeOptionalString(input.sessionId, 200) || undefined,
    directory: normalizeOptionalString(input.directory, 1000) || undefined,
    profile: normalizeOptionalString(input.profile, 120) || undefined,
    status: normalizeStatus(input.status || 'active'),
    wake: input.wake && typeof input.wake === 'object' ? input.wake : {},
    provider: normalizeOptionalString(input.provider, 40) || undefined,
    chatId: normalizeOptionalString(input.chatId, 200) || undefined,
    threadId: normalizeOptionalString(input.threadId, 200) || undefined,
    note: normalizeOptionalString(input.note, 2000) || undefined,
    createdAt: now,
    updatedAt: now,
  }
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    upsertRow(db, record)
    db.exec('COMMIT')
    return record
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  } finally {
    db.close()
  }
}

export function listAgentPresences(filter: { status?: AgentPresenceStatus; includeArchived?: boolean } = {}, filePath = workStatePath()): AgentPresenceRecord[] {
  const db = openWorkDb(filePath)
  try {
    const rows = db.prepare('SELECT * FROM agent_presences ORDER BY updated_at DESC, presence_id ASC').all() as any[]
    return rows.map(rowToPresence)
      .filter(row => filter.status ? row.status === filter.status : true)
      .filter(row => filter.includeArchived || row.status !== 'archived')
  } finally {
    db.close()
  }
}

export function getAgentPresence(presenceId: string, filePath = workStatePath()): AgentPresenceRecord | undefined {
  const db = openWorkDb(filePath)
  try {
    const row = db.prepare('SELECT * FROM agent_presences WHERE presence_id = ?').get(presenceId) as any
    return row ? rowToPresence(row) : undefined
  } finally {
    db.close()
  }
}

export function resolveAgentPresenceForChannel(provider: string, chatId: string, threadId?: string, filePath = workStatePath()): AgentPresenceRecord | undefined {
  const db = openWorkDb(filePath)
  try {
    const thread = threadId || ''
    const exact = db.prepare(
      `SELECT * FROM agent_presences
       WHERE status = 'active' AND provider = ? AND chat_id = ? AND thread_id = ?
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(provider, chatId, thread) as any
    if (exact) return rowToPresence(exact)
    if (thread) {
      const fallback = db.prepare(
        `SELECT * FROM agent_presences
         WHERE status = 'active' AND provider = ? AND chat_id = ? AND (thread_id = '' OR thread_id IS NULL)
         ORDER BY updated_at DESC LIMIT 1`,
      ).get(provider, chatId) as any
      if (fallback) return rowToPresence(fallback)
    }
    return undefined
  } finally {
    db.close()
  }
}

export function updateAgentPresence(presenceId: string, input: AgentPresenceUpdateInput, filePath = workStatePath()): AgentPresenceRecord | undefined {
  const db = openWorkDb(filePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    const existing = db.prepare('SELECT * FROM agent_presences WHERE presence_id = ?').get(presenceId) as any
    if (!existing) {
      db.exec('ROLLBACK')
      return undefined
    }
    const current = rowToPresence(existing)
    if (input.opencodeAgent) assertOpenCodeAgentExists(input.opencodeAgent)
    const next: AgentPresenceRecord = {
      ...current,
      name: input.name !== undefined ? normalizeRequiredString(input.name, 'presence name', 120) : current.name,
      opencodeAgent: input.opencodeAgent !== undefined ? normalizeRequiredString(input.opencodeAgent, 'opencode agent', 120) : current.opencodeAgent,
      sessionId: input.sessionId === null ? undefined : input.sessionId !== undefined ? (normalizeOptionalString(input.sessionId, 200) || undefined) : current.sessionId,
      directory: input.directory === null ? undefined : input.directory !== undefined ? (normalizeOptionalString(input.directory, 1000) || undefined) : current.directory,
      profile: input.profile === null ? undefined : input.profile !== undefined ? (normalizeOptionalString(input.profile, 120) || undefined) : current.profile,
      status: input.status !== undefined ? normalizeStatus(input.status) : current.status,
      wake: input.wake !== undefined ? (input.wake && typeof input.wake === 'object' ? input.wake : {}) : current.wake,
      provider: input.provider === null ? undefined : input.provider !== undefined ? (normalizeOptionalString(input.provider, 40) || undefined) : current.provider,
      chatId: input.chatId === null ? undefined : input.chatId !== undefined ? (normalizeOptionalString(input.chatId, 200) || undefined) : current.chatId,
      threadId: input.threadId === null ? undefined : input.threadId !== undefined ? (normalizeOptionalString(input.threadId, 200) || undefined) : current.threadId,
      note: input.note === null ? undefined : input.note !== undefined ? (normalizeOptionalString(input.note, 2000) || undefined) : current.note,
      updatedAt: new Date().toISOString(),
    }
    upsertRow(db, next)
    db.exec('COMMIT')
    return next
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  } finally {
    db.close()
  }
}

export function clearAgentPresencesForTest(filePath = workStatePath()): void {
  const db = openWorkDb(filePath)
  try {
    db.exec('DELETE FROM agent_presences')
  } finally {
    db.close()
  }
}

function assertOpenCodeAgentExists(name: string): void {
  const agents = listOpenCodeAgents()
  if (!(name in agents)) {
    throw new Error(`OpenCode agent not found: ${name}. Create it with opencode_agent_upsert (mode primary) before binding AgentPresence.`)
  }
}

function normalizeStatus(status: string): AgentPresenceStatus {
  const value = String(status || '').trim() as AgentPresenceStatus
  if (!STATUSES.has(value)) throw new Error(`invalid agent presence status: ${status}`)
  return value
}

function upsertRow(db: ReturnType<typeof openWorkDb>, record: AgentPresenceRecord): void {
  db.prepare(`INSERT INTO agent_presences (
    presence_id, kind, name, opencode_agent, session_id, directory, profile, status, wake_json,
    provider, chat_id, thread_id, note, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(presence_id) DO UPDATE SET
    kind = excluded.kind,
    name = excluded.name,
    opencode_agent = excluded.opencode_agent,
    session_id = excluded.session_id,
    directory = excluded.directory,
    profile = excluded.profile,
    status = excluded.status,
    wake_json = excluded.wake_json,
    provider = excluded.provider,
    chat_id = excluded.chat_id,
    thread_id = excluded.thread_id,
    note = excluded.note,
    updated_at = excluded.updated_at
  `).run(
    record.presenceId,
    record.kind,
    record.name,
    record.opencodeAgent,
    record.sessionId || null,
    record.directory || null,
    record.profile || null,
    record.status,
    JSON.stringify(record.wake || {}),
    record.provider || null,
    record.chatId || null,
    record.threadId || '',
    record.note || null,
    record.createdAt,
    record.updatedAt,
  )
}

function rowToPresence(row: any): AgentPresenceRecord {
  let wake: Record<string, unknown> = {}
  try {
    wake = row.wake_json ? JSON.parse(String(row.wake_json)) : {}
  } catch {
    wake = {}
  }
  return {
    presenceId: String(row.presence_id),
    kind: 'assistant',
    name: String(row.name),
    opencodeAgent: String(row.opencode_agent),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    directory: row.directory ? String(row.directory) : undefined,
    profile: row.profile ? String(row.profile) : undefined,
    status: String(row.status) as AgentPresenceStatus,
    wake: wake && typeof wake === 'object' ? wake : {},
    provider: row.provider ? String(row.provider) : undefined,
    chatId: row.chat_id ? String(row.chat_id) : undefined,
    threadId: row.thread_id ? String(row.thread_id) : undefined,
    note: row.note ? String(row.note) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
