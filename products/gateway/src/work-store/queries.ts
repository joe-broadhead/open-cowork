/**
 * Read-only run-query surface for the work store.
 *
 * These are the targeted, index-served reads over the durable `runs` table:
 * run-detail lookups by id/session, recent-run listings per task/roadmap, the
 * cumulative run-count reads that guard the scheduler's per-task run cap, and
 * the artifact-reference membership probe. They are pure reads — every function
 * opens a read-only connection (or reuses a read helper) and never mutates
 * state — so they were split out of `work-store.ts` (which retains the
 * transactional mutation core) with no behavior change. Signatures and exported
 * names are identical to their previous `work-store.ts` definitions; importers
 * reach them here directly. Connection and row helpers are reused from
 * `work-store.ts`.
 */
import { getRow, parseJSON, queryRows, withWorkDbReadOnly, workStatePath } from './db.js'
import { rowToRun } from './row-mappers.js'
import {
  getRunFromDb,
  TERMINAL_WORK_TASK_STATUSES,
  type RunRecord,
} from '../work-store.js'

/**
 * Read-only sibling of `getRun`: a targeted run-detail read by id (or
 * bound session id) over a read-only handle, so a drill-down never creates the
 * database or its schema as a side effect. Mirrors {@link getRunBySessionId},
 * which is also read-only. Throws if the store does not exist yet — callers
 * treat that as a graceful not-found.
 */
export function getRunReadOnly(id: string, filePath = workStatePath()): RunRecord | undefined {
  return withWorkDbReadOnly(filePath, db => getRunFromDb(db, id))
}

/**
 * True when any run references `ref` among its result artifacts, result evidence
 * refs, or environment artifacts — checked straight against the durable runs
 * table so artifact resolution stays correct regardless of how the live read is
 * windowed. A LIKE pre-filter narrows to candidate rows, then the exact
 * per-run ref set is rebuilt (mirroring the old full-scan membership test) so a
 * substring collision can never authorize an unrelated ref.
 */
export function runReferencesArtifact(ref: string, filePath = workStatePath()): boolean {
  const normalized = String(ref || '').trim()
  if (!normalized) return false
  const like = `%${normalized.replace(/[\\%_]/g, match => `\\${match}`)}%`
  return withWorkDbReadOnly(filePath, db => {
    const rows = queryRows(db, "SELECT result_json, environment_json FROM runs WHERE result_json LIKE ? ESCAPE '\\' OR environment_json LIKE ? ESCAPE '\\'", like, like)
    for (const row of rows) {
      const result = parseJSON<{ artifacts?: unknown[]; evidence?: Array<{ ref?: unknown }> }>(row['result_json'], {})
      for (const artifact of result.artifacts || []) if (String(artifact) === normalized) return true
      for (const evidence of result.evidence || []) if (String(evidence?.ref || '') === normalized) return true
      const environment = parseJSON<{ artifacts?: unknown[] }>(row['environment_json'], {})
      for (const artifact of environment.artifacts || []) if (String(artifact) === normalized) return true
    }
    return false
  })
}

/**
 * Recent runs for a single task, newest first, read straight from the indexed
 * runs table (idx_runs_task) so it stays flat regardless of total history.
 */
export function getRunsForTask(taskId: string, options: { limit?: number } = {}, filePath = workStatePath()): RunRecord[] {
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)))
  return withWorkDbReadOnly(filePath, db =>
    queryRows(db, 'SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?', taskId, limit)
      .map(rowToRun)
      .filter(Boolean) as RunRecord[])
}

/**
 * Total cumulative run count for a single task, read as an indexed COUNT(*)
 * (idx_runs_task on runs(task_id, started_at)) so it is flat regardless of total
 * history — never loads run rows. The scheduler uses this to enforce
 * `scheduler.maxRunsPerTask`, the ceiling on how many runs one task may ever
 * accumulate (a runaway Issue in the dogfood silently reached 81 runs).
 */
export function countRunsForTask(taskId: string, filePath = workStatePath()): number {
  return withWorkDbReadOnly(filePath, db => {
    const row = db.prepare(`
      SELECT COUNT(r.id) + COALESCE(MAX(c.pruned_runs), 0) AS count
        FROM (SELECT ? AS task_id) input
        LEFT JOIN runs r ON r.task_id = input.task_id
        LEFT JOIN task_run_counters c ON c.task_id = input.task_id
    `).get(taskId) as any
    return Number(row?.count || 0)
  })
}

/**
 * Non-terminal tasks whose cumulative run count is at or above `threshold`,
 * highest first. Terminal tasks (done/cancelled/archived — see
 * `TERMINAL_WORK_TASK_STATUSES`) that legitimately retried past the
 * threshold are excluded in the JOIN *before* the LIMIT, so a genuinely-stuck
 * live task can never be crowded out of the window by a backlog of terminal
 * tasks. Powers the stuck-task alert (#203).
 *
 * Cost: the GROUP BY COUNT(*) is output-bounded by `limit` but its work is
 * O(runs) between retention prunes (an index-only scan of idx_runs_task joined
 * to the tasks PK), not a constant-time point lookup. That is acceptable at the
 * periodic alert cadence; the per-task {@link countRunsForTask} in the scheduler
 * hot path is the genuinely point-bounded read.
 */
export function listTaskRunCountsAtOrAbove(threshold: number, limit = 50, filePath = workStatePath()): Array<{ taskId: string; runCount: number }> {
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
  const boundedThreshold = Math.max(1, Math.floor(threshold))
  const terminalPlaceholders = TERMINAL_WORK_TASK_STATUSES.map(() => '?').join(', ')
  return withWorkDbReadOnly(filePath, db =>
    (db.prepare(
      `SELECT t.id AS task_id, COUNT(r.id) + COALESCE(MAX(c.pruned_runs), 0) AS count
         FROM tasks t
         LEFT JOIN runs r ON r.task_id = t.id
         LEFT JOIN task_run_counters c ON c.task_id = t.id
        WHERE t.status NOT IN (${terminalPlaceholders})
        GROUP BY t.id
       HAVING count >= ?
        ORDER BY count DESC, t.id ASC
        LIMIT ?`,
    ).all(...TERMINAL_WORK_TASK_STATUSES, boundedThreshold, boundedLimit) as any[])
      .map(row => ({ taskId: String(row['task_id']), runCount: Number(row['count'] || 0) })))
}

/** Recent runs for every task under a roadmap, newest first (bounded). */
export function getRunsForRoadmap(roadmapId: string, options: { limit?: number } = {}, filePath = workStatePath()): RunRecord[] {
  const limit = Math.max(1, Math.min(2000, Math.floor(options.limit ?? 200)))
  return withWorkDbReadOnly(filePath, db =>
    queryRows(db, 'SELECT * FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE roadmap_id = ?) ORDER BY started_at DESC, rowid DESC LIMIT ?', roadmapId, limit)
      .map(rowToRun)
      .filter(Boolean) as RunRecord[])
}

/** Most recent run bound to an OpenCode session id, if any. */
export function getRunBySessionId(sessionId: string, filePath = workStatePath()): RunRecord | undefined {
  return withWorkDbReadOnly(filePath, db => {
    const row = getRow(db, 'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', sessionId)
    return row ? (rowToRun(row) ?? undefined) : undefined
  })
}

/** True when the task has ever produced a run (EXISTS, no materialization). */
export function taskHasAnyRun(taskId: string, filePath = workStatePath()): boolean {
  return withWorkDbReadOnly(filePath, db => Boolean(getRow(db, 'SELECT 1 AS present FROM runs WHERE task_id = ? LIMIT 1', taskId)?.['present']))
}
