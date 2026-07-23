/**
 * Worker / session projection for Mission Control.
 *
 * JOE-996 / H4: authoritative persistence is operational-sidecar.sqlite
 * (not sessions.json). Legacy sessions.json is imported once on first open.
 */
import {
  loadWorkerSessions,
  operationalSidecarPath,
  replaceWorkerSessions,
  type WorkerSessionRow,
} from './operational-sidecar-store.js'
import { openCodeFetch } from './opencode-client.js'

export type WorkerState = WorkerSessionRow

const workers = new Map<string, WorkerState>()
let loaded = false

function ensureLoaded(): void {
  if (!loaded) loadWorkerState()
}

export function trackWorker(state: WorkerState): void {
  ensureLoaded()
  workers.set(state.id, state)
  saveWorkerState()
}

export function updateWorker(id: string, patch: Partial<Omit<WorkerState, 'id'>>): void {
  ensureLoaded()
  const current = workers.get(id)
  if (!current) return
  workers.set(id, { ...current, ...patch, lastCheck: patch.lastCheck || new Date().toISOString() })
  saveWorkerState()
}

export function listWorkers(): WorkerState[] {
  ensureLoaded()
  return Array.from(workers.values())
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
}

export function getWorkerCounts(): { total: number; running: number; idle: number; completed: number } {
  const all = listWorkers()
  return {
    total: all.length,
    running: all.filter(w => w.status === 'running').length,
    idle: all.filter(w => w.status === 'idle').length,
    completed: all.filter(w => w.status === 'completed').length,
  }
}

export function loadWorkerState(_filePath?: string): WorkerState[] {
  loaded = true
  try {
    const rows = loadWorkerSessions()
    workers.clear()
    for (const row of rows) workers.set(row.id, row)
  } catch {
    // Fail closed to empty map on corrupt/missing store (same as prior JSON).
  }
  return Array.from(workers.values())
}

export function saveWorkerState(_filePath?: string): void {
  try {
    replaceWorkerSessions(Array.from(workers.values()))
  } catch {
    // Best-effort projection — do not take down the daemon.
  }
}

export async function reconcileWorkersFromOpenCode(opencodeUrl: string): Promise<number> {
  ensureLoaded()
  try {
    const res = await openCodeFetch(opencodeUrl, 'session', {}, { timeoutMs: 2000 })
    if (!res.ok) return 0
    const sessions = await res.json()
    return reconcileOpenCodeSessions(Array.isArray(sessions) ? sessions : [])
  } catch {
    return 0
  }
}

export function reconcileOpenCodeSessions(sessions: any[], now = Date.now()): number {
  ensureLoaded()
  let reconciled = 0
  for (const session of sessions) {
    const rawTitle = String(session?.title || '')
    if (!rawTitle.startsWith('GW:') || !session?.id) continue
    const existing = workers.get(session.id)
    const hasRun = hasSessionActivity(session)
    const createdMs = typeof session?.time?.created === 'number' ? session.time.created : now
    const staleEmpty = !hasRun && now - createdMs > 10 * 60 * 1000
    if (staleEmpty && !existing) continue

    const status: WorkerState['status'] = existing?.status === 'completed' || existing?.status === 'errored'
      ? existing.status
      : hasRun
        ? 'completed'
        : staleEmpty
          ? 'unknown'
          : 'running'

    workers.set(session.id, {
      id: session.id,
      title: rawTitle.replace(/^GW:/, '').trim() || existing?.title || 'Worker',
      parentId: existing?.parentId || 'opencode-reconcile',
      status,
      startedAt: existing?.startedAt || new Date(createdMs).toISOString(),
      lastCheck: new Date(now).toISOString(),
      lastTodo: existing?.lastTodo || null,
      lastMessage: existing?.lastMessage || null,
    })
    reconciled++
  }
  saveWorkerState()
  return reconciled
}

function hasSessionActivity(session: any): boolean {
  const tokens = session?.tokens || {}
  return Boolean(
    session?.cost > 0 ||
    tokens.input > 0 ||
    tokens.output > 0 ||
    tokens.reasoning > 0 ||
    tokens.cache?.read > 0 ||
    tokens.cache?.write > 0,
  )
}

export function clearWorkersForTest(): void {
  // Memory only — persist/reload tests call loadWorkerState after clear.
  loaded = true
  workers.clear()
}

/** Path of the durable operational sidecar (tests / diagnostics). */
export function workerSessionsStorePath(): string {
  return operationalSidecarPath()
}
