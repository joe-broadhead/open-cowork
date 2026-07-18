/**
 * Read-only run-aggregate query surface for the work store.
 *
 * These are the bounded, index-served SQL aggregates over the durable `runs`
 * table: run-usage cost/token/runtime totals (governance windows) and the
 * run-analytics grouped spend / outcome / retry-hotspot bundles (#193). They
 * are pure reads — every function opens a read-only connection, runs a single
 * indexed aggregate, and never materializes the run array or mutates state — so
 * they were split out of `work-store.ts` (which retains the transactional
 * mutation core) with no behavior change. Signatures and exported names are
 * identical to their previous `work-store.ts` definitions; importers reach them
 * here directly. Connection and row helpers are reused from `work-store.ts`.
 */
import { DatabaseSync } from 'node:sqlite'
import { getRow, queryRows, withWorkDbReadOnly, workStatePath } from './db.js'

/** Widest instant `new Date(ms).toISOString()` can represent without throwing. */
const MAX_TIME_MS = 8.64e15

/**
 * Epoch-ms → UTC ISO-8601, clamped into the representable Date range so an
 * out-of-range window bound (e.g. `since = 1e16`) can never throw a RangeError
 * mid-query. Callers pass window instants straight into SQL string comparisons,
 * so a clamped extreme simply widens the bound to the max/min instant.
 */
function epochMsToIso(ms: number): string {
  const clamped = Math.min(MAX_TIME_MS, Math.max(-MAX_TIME_MS, ms))
  return new Date(clamped).toISOString()
}

/** Totals returned by {@link getRunCostTokenTotals}, aggregated in SQL. */
export interface RunUsageTotals {
  runs: number
  costUsd: number
  tokens: number
  runtimeMs: number
}

/**
 * Scope for a run-usage aggregate. `taskId` / `roadmapId` / `stage` are index-
 * served equality filters; `since` bounds to runs whose event time
 * (`completed_at` falling back to `started_at`) is at or after the given epoch
 * millisecond instant — the SQL equivalent of governance's JS
 * `eventTime(run) >= startMs` window (daily / weekly / monthly budgets).
 */
export interface RunUsageQuery {
  taskId?: string
  roadmapId?: string
  stage?: string
  since?: number
}

/**
 * Inner SQL aggregate shared by {@link getRunCostTokenTotals} and
 * {@link getRunUsageTotalsBatch}. Reuses an already-open read-only handle so a
 * caller (e.g. governance) can compute several scoped windows in one connection.
 */
function runUsageTotalsOnDb(db: DatabaseSync, filter: RunUsageQuery): RunUsageTotals {
  const clauses: string[] = []
  const params: Array<string> = []
  if (filter.taskId) { clauses.push('task_id = ?'); params.push(filter.taskId) }
  if (filter.stage) { clauses.push('stage = ?'); params.push(filter.stage) }
  if (filter.roadmapId) { clauses.push('task_id IN (SELECT id FROM tasks WHERE roadmap_id = ?)'); params.push(filter.roadmapId) }
  if (filter.since !== undefined && Number.isFinite(filter.since)) {
    // completed_at is stored NULL until a run finishes, so fall back to
    // started_at to mirror governance's `completedAt || startedAt` event time.
    // Both columns hold UTC ISO-8601 strings, so lexical >= equals chronological >=.
    clauses.push('COALESCE(completed_at, started_at) >= ?')
    params.push(epochMsToIso(filter.since))
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const row = getRow(
    db,
    `SELECT
       COUNT(*) AS runs,
       COALESCE(SUM(cost_usd), 0) AS cost_usd,
       COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(reasoning_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)), 0) AS tokens,
       COALESCE(SUM(runtime_ms), 0) AS runtime_ms
     FROM runs ${where}`,
    ...params,
  )
  return {
    runs: Number(row?.['runs'] || 0),
    costUsd: Number(row?.['cost_usd'] || 0),
    tokens: Number(row?.['tokens'] || 0),
    runtimeMs: Number(row?.['runtime_ms'] || 0),
  }
}

/**
 * All-time cost / token / runtime totals computed by a single SQL aggregate over
 * the runs table. This stays correct and cheap at any history size — it never
 * materializes (or JSON-parses) the run array — so it is the scalable substitute
 * for JS-reducing `loadWorkState().runs`.
 */
export function getRunCostTokenTotals(filter: RunUsageQuery = {}, filePath = workStatePath()): RunUsageTotals {
  return withWorkDbReadOnly(filePath, db => runUsageTotalsOnDb(db, filter))
}

/**
 * Batched twin of {@link getRunCostTokenTotals}: evaluates many scoped windows
 * inside a single read-only connection. Governance uses this to price every
 * configured budget window per cycle without re-materializing or JS-reducing the
 * full run history (which was the remaining O(cumulative-runs) scheduler stall).
 */
export function getRunUsageTotalsBatch(queries: RunUsageQuery[], filePath = workStatePath()): RunUsageTotals[] {
  if (!queries.length) return []
  return withWorkDbReadOnly(filePath, db => queries.map(query => runUsageTotalsOnDb(db, query)))
}

/**
 * Time window + scope for the read-only run-analytics aggregates. Every window
 * bound is applied to the indexed `started_at` column (idx_runs_started_at) so
 * the aggregate cost tracks the size of the window, not cumulative history. The
 * scope equality filters narrow further before the GROUP BY runs. `since` is an
 * inclusive lower bound and `until` an exclusive upper bound, both epoch ms.
 */
export interface RunAnalyticsFilter {
  since?: number
  until?: number
  roadmapId?: string
  /** Matches the effective profile: COALESCE(resolved_profile, profile). */
  profile?: string
  /** Matches resolved_agent. */
  agent?: string
  stage?: string
}

/** Dimension a run-analytics aggregate groups by. */
export type RunAnalyticsDimension = 'profile' | 'agent' | 'roadmap'

/**
 * Diagnostic class for an errored run, inferred from its `result_json` cause
 * text (#202). Four cohorts, documented in analytics.ts and the case study:
 *   - operational (Gateway run-lifecycle churn, not the profile's fault):
 *     `recovered_session`, `force_done`, `lease_expired`
 *   - external (provider/account/infra, outside the profile prompt's control):
 *     `provider_balance`, `transport`, `provider_error`
 *   - genuine (the profile / prompt / model's own fault): `genuine_failure`
 *   - unknown (errored with no durable result_json — a crash/abort before the
 *     result was written; cause is indeterminate): `unknown`. Excluded from the
 *     genuine cohort so a resultless errored run can never trip the #205 alert
 *     (a missing result is not evidence the profile is at fault).
 */
export type RunErrorClass =
  | 'recovered_session'
  | 'force_done'
  | 'lease_expired'
  | 'provider_balance'
  | 'transport'
  | 'provider_error'
  | 'genuine_failure'
  | 'unknown'

/** Per-class errored-run counts over a window/scope; `total` = all errored runs. */
export interface RunErrorClassCounts {
  recovered_session: number
  force_done: number
  lease_expired: number
  provider_balance: number
  transport: number
  provider_error: number
  genuine_failure: number
  /** Errored run with no durable result_json (crash/abort); cause indeterminate. */
  unknown: number
  total: number
}

/** All-zero {@link RunErrorClassCounts} (a group with no errored runs). */
export function emptyErrorClassCounts(): RunErrorClassCounts {
  return { recovered_session: 0, force_done: 0, lease_expired: 0, provider_balance: 0, transport: 0, provider_error: 0, genuine_failure: 0, unknown: 0, total: 0 }
}

/**
 * SQL scalar that classifies an errored run by cause from its `result_json`
 * string. Branches are ordered by precedence (first match wins); the LIKE
 * patterns match the durable result summary/feedback/raw text the work store
 * writes for each cause. Kept as pure bounded SQL so the breakdown never
 * materializes or JSON-parses the run array (see the module header).
 *
 * The provider/transport arms deliberately require HTTP-context patterns
 * (`HTTP 402`, `HTTP 504`, ...) rather than bare status numbers. A bare-number
 * match (`%429%`, `%402%`, `%504%`) would misfire on a genuine implement
 * failure whose text incidentally contains such a digit run ("expected 429
 * items", "diff touched 504 lines", "$0.402"), silently moving it out of the
 * genuine cohort and hiding a truly degraded profile from the #205 alert. The
 * durable provider/transport text always carries the HTTP prefix (the dogfood
 * cause was "HTTP 402: [DeepSeek] Insufficient Balance"), so true positives
 * still classify while incidental digits stay genuine.
 *
 * A NULL/empty `result_json` (errored crash/abort before any result was
 * written) classifies as `unknown` — its cause is indeterminate, so it is kept
 * out of the genuine cohort rather than defaulting to `genuine_failure`.
 */
const RUN_ERROR_CLASS_SQL = `CASE
  WHEN result_json IS NULL OR result_json = '' OR result_json = '{}' THEN 'unknown'
  WHEN result_json LIKE '%missing OpenCode session%' THEN 'recovered_session'
  WHEN result_json LIKE '%requested by Gateway%' THEN 'force_done'
  WHEN result_json LIKE '%expired scheduler lease%' THEN 'lease_expired'
  WHEN result_json LIKE '%Insufficient Balance%' OR result_json LIKE '%HTTP 402%' THEN 'provider_balance'
  WHEN result_json LIKE '%fetch failed%' OR result_json LIKE '%timeout%' OR result_json LIKE '%timed out%' OR result_json LIKE '%ETIMEDOUT%' OR result_json LIKE '%ECONNRESET%' OR result_json LIKE '%ECONNREFUSED%' OR result_json LIKE '%ECONN%' OR result_json LIKE '%socket hang up%' OR result_json LIKE '%network%' OR result_json LIKE '%HTTP 500%' OR result_json LIKE '%HTTP 502%' OR result_json LIKE '%HTTP 503%' OR result_json LIKE '%HTTP 504%' THEN 'transport'
  WHEN result_json LIKE '%unauthorized%' OR result_json LIKE '%forbidden%' OR result_json LIKE '%invalid api key%' OR result_json LIKE '%authentication%' OR result_json LIKE '%rate limit%' OR result_json LIKE '%too many requests%' OR result_json LIKE '%HTTP 400%' OR result_json LIKE '%HTTP 401%' OR result_json LIKE '%HTTP 403%' OR result_json LIKE '%HTTP 404%' OR result_json LIKE '%HTTP 409%' OR result_json LIKE '%HTTP 429%' THEN 'provider_error'
  ELSE 'genuine_failure'
END`

/** One grouped row of the run-analytics aggregate, computed entirely in SQL. */
export interface RunAnalyticsGroupRow {
  /** Dimension value; unresolved agents/roadmaps collapse to '(unassigned)'. */
  key: string
  runCount: number
  costUsd: number
  tokens: number
  runtimeMs: number
  passed: number
  failed: number
  blocked: number
  errored: number
  running: number
  /** passed + failed + blocked + errored (runs that reached a terminal state). */
  terminal: number
  /** Distinct task_id values with at least one passed run in the window/scope. */
  completedTasks: number
  attemptSum: number
  maxAttempt: number
  /** Diagnostic breakdown of this group's `errored` runs by cause (#202). */
  errorClasses: RunErrorClassCounts
}

/** Outcome distribution (status counts) over a window/scope. */
export interface RunAnalyticsOutcomeCounts {
  total: number
  running: number
  passed: number
  failed: number
  blocked: number
  errored: number
}

/** A high-retry task surfaced by the analytics hotspot query. */
export interface RunAnalyticsRetryHotspot {
  taskId: string
  roadmapId?: string
  maxAttempt: number
  runCount: number
  costUsd: number
}

/** Combined analytics aggregates produced in a single read-only connection. */
export interface RunAnalyticsBundle {
  groups: RunAnalyticsGroupRow[]
  outcomes: RunAnalyticsOutcomeCounts
  retryHotspots: RunAnalyticsRetryHotspot[]
}

const RUN_TOKEN_SUM_SQL =
  'COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(reasoning_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)'

/** WHERE clause + params shared by every run-analytics aggregate. */
function runAnalyticsWhere(filter: RunAnalyticsFilter): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  // Window first: started_at is indexed, so bounding it keeps the scan (and the
  // grouping that follows) proportional to the window rather than all history.
  if (filter.since !== undefined && Number.isFinite(filter.since)) { clauses.push('started_at >= ?'); params.push(epochMsToIso(filter.since)) }
  if (filter.until !== undefined && Number.isFinite(filter.until)) { clauses.push('started_at < ?'); params.push(epochMsToIso(filter.until)) }
  if (filter.roadmapId) { clauses.push('task_id IN (SELECT id FROM tasks WHERE roadmap_id = ?)'); params.push(filter.roadmapId) }
  if (filter.profile) { clauses.push("COALESCE(NULLIF(resolved_profile, ''), profile) = ?"); params.push(filter.profile) }
  // Match the same coalesced expression the aggregate groups on (see
  // runAnalyticsDimensionExpr) so scoping by the emitted '(unassigned)' agent
  // key drills into that group instead of matching zero rows.
  if (filter.agent) { clauses.push("COALESCE(NULLIF(resolved_agent, ''), '(unassigned)') = ?"); params.push(filter.agent) }
  if (filter.stage) { clauses.push('stage = ?'); params.push(filter.stage) }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/** SQL expression the grouped aggregate keys on for each dimension. */
function runAnalyticsDimensionExpr(dimension: RunAnalyticsDimension): string {
  if (dimension === 'agent') return "COALESCE(NULLIF(resolved_agent, ''), '(unassigned)')"
  if (dimension === 'roadmap') return "COALESCE((SELECT roadmap_id FROM tasks WHERE tasks.id = runs.task_id), '(unassigned)')"
  return "COALESCE(NULLIF(resolved_profile, ''), profile)"
}

/**
 * Per-key errored-run breakdown by diagnostic class, keyed on the same
 * dimension expression the grouped aggregate uses. Bounded to the window/scope
 * and restricted to `status = 'errored'`, so it scans only the (small) errored
 * subset. Returns a Map so {@link runAnalyticsGroupsOnDb} can attach a zeroed
 * count to groups with no errored runs.
 */
function runErrorClassesByKeyOnDb(db: DatabaseSync, dimension: RunAnalyticsDimension, filter: RunAnalyticsFilter): Map<string, RunErrorClassCounts> {
  const { where, params } = runAnalyticsWhere(filter)
  const keyExpr = runAnalyticsDimensionExpr(dimension)
  const errWhere = where ? `${where} AND status = 'errored'` : "WHERE status = 'errored'"
  const rows = queryRows(
    db,
    `SELECT ${keyExpr} AS key, ${RUN_ERROR_CLASS_SQL} AS klass, COUNT(*) AS n
     FROM runs ${errWhere}
     GROUP BY ${keyExpr}, ${RUN_ERROR_CLASS_SQL}`,
    ...params,
  )
  const byKey = new Map<string, RunErrorClassCounts>()
  for (const row of rows) {
    const key = String(row['key'] || '(unassigned)')
    const klass = String(row['klass'] || 'genuine_failure') as RunErrorClass
    const n = Number(row['n'] || 0)
    const counts = byKey.get(key) || emptyErrorClassCounts()
    if (klass in counts) counts[klass] = n
    counts.total += n
    byKey.set(key, counts)
  }
  return byKey
}

function runAnalyticsGroupsOnDb(db: DatabaseSync, dimension: RunAnalyticsDimension, filter: RunAnalyticsFilter): RunAnalyticsGroupRow[] {
  const { where, params } = runAnalyticsWhere(filter)
  const keyExpr = runAnalyticsDimensionExpr(dimension)
  const errorClassesByKey = runErrorClassesByKeyOnDb(db, dimension, filter)
  const rows = queryRows(
    db,
    `SELECT
       ${keyExpr} AS key,
       COUNT(*) AS run_count,
       COALESCE(SUM(cost_usd), 0) AS cost_usd,
       COALESCE(SUM(${RUN_TOKEN_SUM_SQL}), 0) AS tokens,
       COALESCE(SUM(runtime_ms), 0) AS runtime_ms,
       SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
       SUM(CASE WHEN status = 'errored' THEN 1 ELSE 0 END) AS errored,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       COUNT(DISTINCT CASE WHEN status = 'passed' THEN task_id END) AS completed_tasks,
       COALESCE(SUM(attempt), 0) AS attempt_sum,
       COALESCE(MAX(attempt), 0) AS max_attempt
     FROM runs ${where}
     GROUP BY ${keyExpr}
     ORDER BY cost_usd DESC, run_count DESC`,
    ...params,
  )
  return rows.map(row => {
    const passed = Number(row['passed'] || 0)
    const failed = Number(row['failed'] || 0)
    const blocked = Number(row['blocked'] || 0)
    const errored = Number(row['errored'] || 0)
    return {
      key: String(row['key'] || '(unassigned)'),
      runCount: Number(row['run_count'] || 0),
      costUsd: Number(row['cost_usd'] || 0),
      tokens: Number(row['tokens'] || 0),
      runtimeMs: Number(row['runtime_ms'] || 0),
      passed,
      failed,
      blocked,
      errored,
      running: Number(row['running'] || 0),
      terminal: passed + failed + blocked + errored,
      completedTasks: Number(row['completed_tasks'] || 0),
      attemptSum: Number(row['attempt_sum'] || 0),
      maxAttempt: Number(row['max_attempt'] || 0),
      errorClasses: errorClassesByKey.get(String(row['key'] || '(unassigned)')) || emptyErrorClassCounts(),
    }
  })
}

function runAnalyticsOutcomesOnDb(db: DatabaseSync, filter: RunAnalyticsFilter): RunAnalyticsOutcomeCounts {
  const { where, params } = runAnalyticsWhere(filter)
  const row = getRow(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
       SUM(CASE WHEN status = 'errored' THEN 1 ELSE 0 END) AS errored
     FROM runs ${where}`,
    ...params,
  )
  return {
    total: Number(row?.['total'] || 0),
    running: Number(row?.['running'] || 0),
    passed: Number(row?.['passed'] || 0),
    failed: Number(row?.['failed'] || 0),
    blocked: Number(row?.['blocked'] || 0),
    errored: Number(row?.['errored'] || 0),
  }
}

function runAnalyticsHotspotsOnDb(db: DatabaseSync, filter: RunAnalyticsFilter, limit: number): RunAnalyticsRetryHotspot[] {
  const { where, params } = runAnalyticsWhere(filter)
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)))
  const rows = queryRows(
    db,
    `SELECT
       task_id,
       (SELECT roadmap_id FROM tasks WHERE tasks.id = runs.task_id) AS roadmap_id,
       MAX(attempt) AS max_attempt,
       COUNT(*) AS run_count,
       COALESCE(SUM(cost_usd), 0) AS cost_usd
     FROM runs ${where}
     GROUP BY task_id
     HAVING MAX(attempt) > 1
     ORDER BY max_attempt DESC, run_count DESC, cost_usd DESC, task_id ASC
     LIMIT ?`,
    ...params,
    bounded,
  )
  return rows.map(row => ({
    taskId: String(row['task_id'] || ''),
    roadmapId: row['roadmap_id'] ? String(row['roadmap_id']) : undefined,
    maxAttempt: Number(row['max_attempt'] || 0),
    runCount: Number(row['run_count'] || 0),
    costUsd: Number(row['cost_usd'] || 0),
  }))
}

/**
 * Grouped spend / outcome aggregate over the runs table for one dimension,
 * bounded by the indexed started_at window. Read-only, computed in SQL — never
 * materializes the run array.
 */
export function getRunAnalyticsGroups(dimension: RunAnalyticsDimension, filter: RunAnalyticsFilter = {}, filePath = workStatePath()): RunAnalyticsGroupRow[] {
  return withWorkDbReadOnly(filePath, db => runAnalyticsGroupsOnDb(db, dimension, filter))
}

/**
 * Window/scope cost + token + runtime totals over the runs table using the SAME
 * `started_at` window and scope predicates as {@link getRunAnalyticsGroups}, so
 * the returned spend reconciles exactly with the summed `usageByDimension` cost
 * for an identical window+scope. Unlike {@link getRunCostTokenTotals} (which
 * windows on `COALESCE(completed_at, started_at)` for governance parity), this
 * mirrors the analytics aggregate's `started_at` window and honours the profile/
 * agent/stage scope filters.
 */
export function getRunAnalyticsUsageTotals(filter: RunAnalyticsFilter = {}, filePath = workStatePath()): RunUsageTotals {
  return withWorkDbReadOnly(filePath, db => {
    const { where, params } = runAnalyticsWhere(filter)
    const row = getRow(
      db,
      `SELECT
         COUNT(*) AS runs,
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(${RUN_TOKEN_SUM_SQL}), 0) AS tokens,
         COALESCE(SUM(runtime_ms), 0) AS runtime_ms
       FROM runs ${where}`,
      ...params,
    )
    return {
      runs: Number(row?.['runs'] || 0),
      costUsd: Number(row?.['cost_usd'] || 0),
      tokens: Number(row?.['tokens'] || 0),
      runtimeMs: Number(row?.['runtime_ms'] || 0),
    }
  })
}

/**
 * Combined analytics bundle (grouped usage + outcome distribution + retry
 * hotspots) computed in a single read-only connection so a summary surface pays
 * for one connection, not three.
 */
export function getRunAnalyticsBundle(dimension: RunAnalyticsDimension, filter: RunAnalyticsFilter = {}, options: { hotspotLimit?: number } = {}, filePath = workStatePath()): RunAnalyticsBundle {
  return withWorkDbReadOnly(filePath, db => ({
    groups: runAnalyticsGroupsOnDb(db, dimension, filter),
    outcomes: runAnalyticsOutcomesOnDb(db, filter),
    retryHotspots: runAnalyticsHotspotsOnDb(db, filter, options.hotspotLimit ?? 5),
  }))
}
