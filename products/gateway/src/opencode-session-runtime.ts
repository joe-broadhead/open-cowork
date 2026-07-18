/**
 * OpenCode session lifecycle port.
 *
 * Deliberately separate from `gateway-runtime.ts` (daemon client holder).
 * Prefer this module over sprinkling `client.session.*` across edges.
 */
import type { OpencodeClient } from '@opencode-ai/sdk'
import { getDaemonClient } from './gateway-runtime.js'
import { getConfig } from './config.js'
import { loadWorkState, openWorkDb, withWorkDbLeadershipEpoch, workStatePath, type WorkDbLeadershipEpoch } from './work-store.js'
import { listChannelSessions } from './channel-sessions.js'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { captureCurrentDaemonLeadershipEpoch, getCurrentDaemonLeadershipStatus } from './daemon-leadership.js'

export interface SessionCreateInput {
  title: string
  directory?: string
  agent?: string
}

export interface SessionPromptInput {
  sessionId: string
  directory?: string
  agent?: string
  model?: string | { providerID: string; modelID: string; variant?: string } | unknown
  skills?: string[]
  permission?: unknown
  system?: string
  parts: Array<{ type: 'text'; text: string }>
  /** Prefer fire-and-forget (current product behavior). Uses promptAsync when available. */
  async?: boolean
  /** Bound dead-transport waits (e.g. supervisor wake lease window). */
  signal?: AbortSignal
}

export interface SessionAdmitInput {
  title?: string
  agent?: string
  directory?: string
  presenceId?: string
  taskId?: string
  purpose?: 'interactive' | 'worker' | 'presence'
  peerId?: string
}

export interface SessionAdmitResult {
  sessionId: string
  admissionId: string
  purpose: string
  agent?: string
  directory?: string
  peerId?: string
}

export interface OpenCodeSessionRuntime {
  createSession(input: SessionCreateInput): Promise<{ id: string }>
  getSession(sessionId: string, directory?: string): Promise<{ data?: any; missing: boolean }>
  listSessions(directory?: string): Promise<any[]>
  prompt(input: SessionPromptInput): Promise<unknown>
  abort(sessionId: string, directory?: string): Promise<void>
  deleteSession(sessionId: string, directory?: string): Promise<void>
  messages(sessionId: string, directory?: string, limit?: number): Promise<any[]>
}

function clientOrThrow(explicit?: OpencodeClient): OpencodeClient {
  const client = explicit || getDaemonClient()
  if (!client) throw new Error('OpenCode client is not available (daemon not started?)')
  return client
}

export function createOpenCodeSessionRuntime(client?: OpencodeClient): OpenCodeSessionRuntime {
  return {
    async createSession(input) {
      const c = clientOrThrow(client)
      const options: any = {
        body: { title: input.title },
      }
      if (input.directory) options.query = { directory: input.directory }
      if (input.agent) options.body.agent = input.agent
      const session = await c.session.create(options)
      const id = session.data?.id
      if (!id) throw new Error('OpenCode session create returned no id')
      return { id: String(id) }
    },

    async getSession(sessionId, directory) {
      const c = clientOrThrow(client)
      try {
        const response = await c.session.get({
          path: { id: sessionId },
          query: directory ? { directory } : undefined,
        } as any)
        if (!response.data) return { missing: true }
        return { data: response.data, missing: false }
      } catch (err: any) {
        const msg = String(err?.message || err || '')
        if (/404|not found/i.test(msg)) return { missing: true }
        throw err
      }
    },

    async listSessions(directory) {
      const c = clientOrThrow(client)
      const response = await c.session.list(directory ? { query: { directory } } as any : undefined as any)
      return (response.data as any[]) || []
    },

    async prompt(input) {
      const c = clientOrThrow(client)
      const body: any = {
        parts: input.parts,
      }
      if (input.agent) body.agent = input.agent
      if (input.model) body.model = input.model
      if (input.skills) body.skills = input.skills
      if (input.permission) body.permission = input.permission
      if (input.system) body.system = input.system

      const path = { id: input.sessionId }
      const query = input.directory ? { directory: input.directory } : undefined
      const signal = input.signal
      const promptAsync = (c.session as any).promptAsync as undefined | ((args: any) => Promise<unknown>)

      // Always return the underlying promise so callers can chain .then/.catch
      // (scheduler completion + failure paths depend on that). Prefer promptAsync
      // when the SDK exposes it and async is not forced off.
      if (input.async !== false && typeof promptAsync === 'function') {
        return promptAsync.call(c.session, { path, query, body, signal })
      }
      return c.session.prompt({ path, query, body, signal } as any)
    },

    async abort(sessionId, directory) {
      const c = clientOrThrow(client)
      await c.session.abort({
        path: { id: sessionId },
        query: directory ? { directory } : undefined,
      } as any).catch(() => undefined)
    },

    async deleteSession(sessionId, directory) {
      const c = clientOrThrow(client)
      await c.session.delete({
        path: { id: sessionId },
        query: directory ? { directory } : undefined,
      } as any)
    },

    async messages(sessionId, directory, limit = 50) {
      const c = clientOrThrow(client)
      const response = await c.session.messages({
        path: { id: sessionId },
        query: { ...(directory ? { directory } : {}), limit },
      } as any)
      return (response.data as any[]) || []
    },
  }
}

export function getOpenCodeSessionRuntime(): OpenCodeSessionRuntime {
  return createOpenCodeSessionRuntime()
}

/**
 * Capacity-gated session factory. Never a free-spawn API.
 *
 * `load` counts scheduler runs, sticky channel sessions, AND the sessions this
 * factory has itself admitted that are still live in OpenCode — so repeated
 * admits actually raise the load they are checked against. Without the
 * live-admitted term an admit loop would never move `load` (an admission is
 * neither a run nor a channel session), which would make this a de-facto
 * free-spawn API. Worker/presence admits bind to scheduler maxConcurrent;
 * interactive admits use a soft ceiling of 2x maxConcurrent and also count
 * sticky channel sessions.
 */
// Serialize admits so the check→create→record sequence is atomic: without this,
// concurrent admits observe the same pre-insert `load` and all pass, overshooting
// `limit`. Admits are rare and admin-gated, so a global one-at-a-time chain is
// cheap and removes the TOCTOU window entirely.
let admitChain: Promise<unknown> = Promise.resolve()
const ADMISSION_RECONCILE_GRACE_MS = 5 * 60_000

export function admitOpenCodeSession(input: SessionAdmitInput, runtime = getOpenCodeSessionRuntime()): Promise<SessionAdmitResult> {
  const run = admitChain.then(() => admitOpenCodeSessionLocked(input, runtime), () => admitOpenCodeSessionLocked(input, runtime))
  admitChain = run.catch(() => undefined)
  return run
}

async function admitOpenCodeSessionLocked(input: SessionAdmitInput, runtime: OpenCodeSessionRuntime): Promise<SessionAdmitResult> {
  const config = getConfig()
  // Only state.runs is read here, and solely to count running runs. The live
  // window already carries every WHERE status='running' row, so the live scope
  // yields an identical count without materializing terminal-run JSON.
  const state = loadWorkState(undefined, { runsScope: 'live' })
  const runningRuns = state.runs.filter(run => run.status === 'running').length
  const channelSessions = listChannelSessions().length
  const liveAdmitted = await countLiveAdmittedSessions(runtime)
  const hardMax = Math.max(1, config.scheduler.maxConcurrent || 1)
  const purpose = input.purpose || 'interactive'
  const load = liveAdmitted + (purpose === 'interactive' ? runningRuns + Math.ceil(channelSessions / 4) : runningRuns)
  const limit = purpose === 'interactive' ? hardMax * 2 : hardMax
  if (load >= limit) {
    throw new Error(`session admit refused: capacity full (load=${load}, limit=${limit}, purpose=${purpose}, runningRuns=${runningRuns}, liveAdmitted=${liveAdmitted})`)
  }

  const directory = normalizeAdmitDirectory(input.directory)
  const admissionId = `adm_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const idempotencyKey = `session-admission:${admissionId}`
  const titleTag = `[gateway-admission:${admissionId}]`
  const title = `${(input.title || `GW:admit:${purpose}`).substring(0, 200 - titleTag.length - 1)} ${titleTag}`
  const leadership = getCurrentDaemonLeadershipStatus()
  const initiatingEpoch = captureCurrentDaemonLeadershipEpoch()
  if (leadership.enabled && !initiatingEpoch) throw new Error('session admit refused: daemon writer leadership is required')
  const admission = {
    admissionId,
    idempotencyKey,
    purpose,
    agent: input.agent,
    directory,
    presenceId: input.presenceId,
    taskId: input.taskId,
    peerId: input.peerId,
  }
  runInAdmissionEpoch(initiatingEpoch, () => recordSessionAdmissionIntent(admission))

  let created: { id: string }
  try {
    created = await runtime.createSession({ title, directory, agent: input.agent })
  } catch (err) {
    try { runInAdmissionEpoch(initiatingEpoch, () => failSessionAdmission(admissionId, err)) } catch {}
    throw err
  }

  try {
    runInAdmissionEpoch(initiatingEpoch, () => completeSessionAdmission(admissionId, created.id))
  } catch (err) {
    let cleanupVerified = false
    try { cleanupVerified = await deleteOpenCodeSessionAndVerify(runtime, created.id, directory) } catch {}
    throw new Error(`session admit persistence was fenced after OpenCode creation; cleanup ${cleanupVerified ? 'verified' : 'left for durable admission reconciliation'}: ${(err as Error)?.message || String(err)}`)
  }
  return {
    sessionId: created.id,
    admissionId,
    purpose,
    agent: input.agent,
    directory,
    peerId: input.peerId,
  }
}

export async function reconcilePendingSessionAdmissions(
  runtime = getOpenCodeSessionRuntime(),
  options: { now?: number; graceMs?: number } = {},
): Promise<{ checked: number; cleaned: number; retained: number }> {
  const now = options.now ?? Date.now()
  const graceMs = Math.max(1_000, options.graceMs ?? ADMISSION_RECONCILE_GRACE_MS)
  const pending = listPendingSessionAdmissionRows()
  let cleaned = 0
  let retained = 0
  for (const row of pending) {
    const titleTag = `[gateway-admission:${row.admissionId}]`
    let sessions: any[]
    try {
      sessions = await runtime.listSessions(row.directory)
    } catch {
      retained++
      continue
    }
    const matches = sessions.filter(session => String(session?.title || '').includes(titleTag) && session?.id)
    let cleanupVerified = true
    for (const session of matches) {
      const sessionId = String(session.id)
      try {
        if (!(await deleteOpenCodeSessionAndVerify(runtime, sessionId, row.directory))) cleanupVerified = false
      } catch {
        cleanupVerified = false
      }
    }
    const createdAt = Date.parse(row.createdAt)
    const absenceAuthoritative = !matches.length && Number.isFinite(createdAt) && now - createdAt >= graceMs
    if (!cleanupVerified || (!matches.length && !absenceAuthoritative)) {
      retained++
      continue
    }
    settlePendingSessionAdmission(row.admissionId, matches.length ? 'reconciled orphan session' : 'no matching session after reconciliation grace')
    cleaned++
  }
  return { checked: pending.length, cleaned, retained }
}

async function deleteOpenCodeSessionAndVerify(runtime: OpenCodeSessionRuntime, sessionId: string, directory?: string): Promise<boolean> {
  await runtime.abort(sessionId, directory).catch(() => undefined)
  await runtime.deleteSession(sessionId, directory).catch(err => {
    if (!isMissingSessionError(err)) throw err
  })
  return (await runtime.getSession(sessionId, directory)).missing
}

function isMissingSessionError(err: unknown): boolean {
  const status = Number((err as any)?.status || (err as any)?.statusCode || (err as any)?.response?.status || (err as any)?.data?.statusCode || (err as any)?.error?.status)
  return status === 404 || /(^|\D)404(\D|$)|not found/i.test(String((err as any)?.message || err))
}

/**
 * A caller-supplied session directory must be an absolute path — never a
 * relative or traversal-y value that could root a session outside the operator's
 * intended tree. (Compounds with the admin tier now required to admit.)
 */
function normalizeAdmitDirectory(directory?: string): string | undefined {
  const value = String(directory || '').trim()
  if (!value) return undefined
  if (!path.isAbsolute(value)) throw new Error(`session admit refused: directory must be an absolute path (got ${value})`)
  return value
}

/**
 * Count the sessions this factory has admitted that are still live in OpenCode.
 * Lists live sessions for every distinct admitted directory, then counts how many
 * of those live session ids were admitted by us (indexed `session_id` lookup over
 * the whole table — NOT a recent-N window, so a long-lived admitted session can
 * never be churned out of view). The count self-cleans as sessions end.
 */
async function countLiveAdmittedSessions(runtime: OpenCodeSessionRuntime): Promise<number> {
  const liveIds = new Set<string>()
  for (const directory of listAdmittedDirectories()) {
    const sessions = await runtime.listSessions(directory).catch(() => [] as any[])
    for (const session of sessions) if (session?.id) liveIds.add(String(session.id))
  }
  if (!liveIds.size) return 0
  return countAdmittedSessionIds([...liveIds])
}

/** Distinct directories ever used for an admission (small set — one per workdir). */
function listAdmittedDirectories(): Array<string | undefined> {
  const db = openWorkDb(workStatePath())
  try {
    const rows = db.prepare("SELECT DISTINCT directory FROM session_admissions WHERE status IN ('active', 'creating')").all() as Array<{ directory: string | null }>
    return rows.map(row => row.directory || undefined)
  } finally {
    db.close()
  }
}

/** How many of `sessionIds` were admitted by this factory (indexed, whole-table). */
function countAdmittedSessionIds(sessionIds: string[]): number {
  if (!sessionIds.length) return 0
  const db = openWorkDb(workStatePath())
  try {
    const placeholders = sessionIds.map(() => '?').join(', ')
    const row = db.prepare(
      `SELECT COUNT(DISTINCT session_id) AS count FROM session_admissions WHERE status = 'active' AND session_id IN (${placeholders})`,
    ).get(...sessionIds) as { count?: number } | undefined
    return Number(row?.count || 0)
  } finally {
    db.close()
  }
}

function runInAdmissionEpoch<T>(epoch: WorkDbLeadershipEpoch | undefined, fn: () => T): T {
  return epoch ? withWorkDbLeadershipEpoch(epoch, fn) : fn()
}

function recordSessionAdmissionIntent(row: {
  admissionId: string
  idempotencyKey: string
  purpose: string
  agent?: string
  directory?: string
  presenceId?: string
  taskId?: string
  peerId?: string
}): void {
  const db = openWorkDb(workStatePath())
  try {
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`INSERT INTO session_admissions (
      admission_id, session_id, status, idempotency_key, purpose, agent, directory, presence_id, task_id, peer_id, created_at
    ) VALUES (?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.admissionId,
      `pending:${row.admissionId}`,
      row.idempotencyKey,
      row.purpose,
      row.agent || null,
      row.directory || null,
      row.presenceId || null,
      row.taskId || null,
      row.peerId || null,
      new Date().toISOString(),
    )
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  } finally {
    db.close()
  }
}

function completeSessionAdmission(admissionId: string, sessionId: string): void {
  const db = openWorkDb(workStatePath())
  try {
    db.exec('BEGIN IMMEDIATE')
    const result = db.prepare("UPDATE session_admissions SET session_id = ?, status = 'active', last_error = NULL WHERE admission_id = ? AND status = 'creating'")
      .run(sessionId, admissionId) as { changes?: number }
    if (Number(result.changes || 0) !== 1) throw new Error(`session admission intent is missing or already settled: ${admissionId}`)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  } finally {
    db.close()
  }
}

function failSessionAdmission(admissionId: string, error: unknown): void {
  settlePendingSessionAdmission(admissionId, (error as Error)?.message || String(error))
}

function settlePendingSessionAdmission(admissionId: string, reason: string): void {
  const db = openWorkDb(workStatePath())
  try {
    db.exec('BEGIN IMMEDIATE')
    db.prepare("UPDATE session_admissions SET status = 'failed', last_error = ? WHERE admission_id = ? AND status = 'creating'")
      .run(String(reason).substring(0, 1000), admissionId)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  } finally {
    db.close()
  }
}

function listPendingSessionAdmissionRows(): Array<{ admissionId: string; directory?: string; createdAt: string }> {
  const db = openWorkDb(workStatePath())
  try {
    const rows = db.prepare("SELECT admission_id, directory, created_at FROM session_admissions WHERE status = 'creating' ORDER BY created_at ASC").all() as Array<{
      admission_id: string
      directory: string | null
      created_at: string
    }>
    return rows.map(row => ({ admissionId: row.admission_id, directory: row.directory || undefined, createdAt: row.created_at }))
  } finally {
    db.close()
  }
}
