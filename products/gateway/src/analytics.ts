import { getConfig, type GatewayConfig, type GovernanceBudgetConfig } from './config.js'
import { workStatePath } from './work-store.js'
import {
  emptyErrorClassCounts,
  getRunAnalyticsBundle,
  getRunAnalyticsGroups,
  getRunAnalyticsUsageTotals,
  type RunAnalyticsDimension,
  type RunAnalyticsFilter,
  type RunAnalyticsGroupRow,
  type RunAnalyticsOutcomeCounts,
  type RunAnalyticsRetryHotspot,
  type RunErrorClassCounts,
} from './work-store/analytics-queries.js'

/**
 * Read-only run-history analytics.
 *
 * Every figure here is derived from a bounded, indexed SQL aggregate over the
 * durable runs table (see the `getRunAnalytics*` functions in work-store.ts);
 * this module only shapes and derives (scorecards, underperformers, budget
 * comparison) from the already-grouped rows. It never mutates state and never
 * materializes the full run array, so cost tracks the requested window rather
 * than cumulative history.
 */

/** Default lookback window when a caller does not pass since/until. */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** Widest instant `new Date(ms).toISOString()` can represent without throwing. */
const MAX_TIME_MS = 8.64e15
/** Clamp an epoch-ms instant into the valid JS Date range so ISO conversion never throws. */
function clampTime(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.min(MAX_TIME_MS, Math.max(-MAX_TIME_MS, ms))
}

/** Caller-facing analytics request (window + scope + primary dimension). */
export interface AnalyticsRequest {
  /** Inclusive lower bound (epoch ms). Overrides windowDays when set. */
  since?: number
  /** Exclusive upper bound (epoch ms). Defaults to now. */
  until?: number
  /** Lookback length in days when `since` is not supplied. */
  windowDays?: number
  roadmapId?: string
  profile?: string
  agent?: string
  stage?: string
  /** Dimension for usage-by-dimension / scorecard grouping (default profile). */
  by?: RunAnalyticsDimension
  /** Retry-hotspot cap for the summary. */
  hotspotLimit?: number
}

/** Resolved window echoed back to callers. */
export interface AnalyticsWindow {
  since: number
  until: number
  sinceIso: string
  untilIso: string
  days: number
}

export interface AnalyticsScope {
  roadmapId?: string
  profile?: string
  agent?: string
  stage?: string
}

export interface AnalyticsUsageRow {
  key: string
  runCount: number
  costUsd: number
  tokens: number
  runtimeMs: number
}

export interface AnalyticsBudgetTrendEntry {
  name: string
  scope: 'global' | 'roadmap'
  roadmapId?: string
  /** Actual spend inside the requested window for this scope. */
  windowCostUsd: number
  dailyCostUsd?: number
  weeklyCostUsd?: number
  monthlyCostUsd?: number
  totalCostUsd?: number
  tokenLimit?: number
}

export interface AnalyticsBudgetTrend {
  enabled: boolean
  note: string
  entries: AnalyticsBudgetTrendEntry[]
}

export interface AnalyticsSummary {
  generatedAt: string
  window: AnalyticsWindow
  scope: AnalyticsScope
  dimension: RunAnalyticsDimension
  usageByDimension: AnalyticsUsageRow[]
  outcomeDistribution: RunAnalyticsOutcomeCounts & { completionRate: number }
  retryHotspots: RunAnalyticsRetryHotspot[]
  budgetTrend: AnalyticsBudgetTrend
}

/**
 * The operational-vs-genuine split of a group's errored runs (#202).
 *
 * `errored` decomposes into three cohorts so an operator can tell run-lifecycle
 * churn apart from a genuinely broken profile:
 *   - `operationalErrored` — Gateway run-lifecycle churn, NOT the profile's
 *     fault: recovered_session + force_done + lease_expired.
 *   - `externalErrored` — provider / account / infrastructure, outside the
 *     profile prompt's control: provider_balance + transport + provider_error.
 *   - `genuineErrored` — the profile / prompt / model's own fault:
 *     genuine_failure.
 *   - `unknownErrored` — errored with no durable result_json (crash/abort before
 *     the result was written); cause indeterminate: unknown.
 * The four sum to `errorClasses.total`. `genuineFailureRate` charges ONLY
 * `genuineErrored` against terminal runs, so session-recovery churn, a
 * provider-balance blip, and a resultless crash never inflate it — this is what
 * keeps the #205 alert from crying wolf on the dogfood pattern.
 */
export interface ErrorClassSplit {
  errorClasses: RunErrorClassCounts
  operationalErrored: number
  externalErrored: number
  genuineErrored: number
  /** Errored runs with no durable result (crash/abort); excluded from genuine. */
  unknownErrored: number
  /** genuineErrored / terminal, 0 when there are no terminal runs. */
  genuineFailureRate: number
}

export interface AnalyticsScorecardRow extends ErrorClassSplit {
  key: string
  totalRuns: number
  passed: number
  failed: number
  blocked: number
  errored: number
  running: number
  terminal: number
  /** passed / terminal, 0 when there are no terminal runs. */
  completionRate: number
  /** Mean attempt number across the group's runs. */
  avgAttempts: number
  completedTasks: number
  costUsd: number
  tokens: number
  runtimeMs: number
  /** costUsd / completedTasks, undefined when nothing completed. */
  costPerCompletedTask?: number
}

export interface AnalyticsUnderperformer extends AnalyticsScorecardRow {
  reason: string
}

export interface AnalyticsScorecard {
  generatedAt: string
  window: AnalyticsWindow
  scope: AnalyticsScope
  dimension: RunAnalyticsDimension
  medians: { costUsd: number; completionRate: number }
  scorecards: AnalyticsScorecardRow[]
  underperformers: AnalyticsUnderperformer[]
  /** Window-wide errored-run diagnostics (sum across all scorecard groups). */
  overall: ErrorClassSplit & { terminal: number }
}

function resolveWindow(request: AnalyticsRequest, now: number): AnalyticsWindow {
  const until = request.until !== undefined && Number.isFinite(request.until) ? request.until : now
  const days = request.windowDays !== undefined && Number.isFinite(request.windowDays) && request.windowDays > 0
    ? request.windowDays
    : DEFAULT_ANALYTICS_WINDOW_DAYS
  const rawSince = request.since !== undefined && Number.isFinite(request.since) ? request.since : until - days * DAY_MS
  // Clamp both bounds into the representable Date range so out-of-range params
  // (e.g. ?since=1e16, or a huge --window pushing `since` below the min instant)
  // never make `toISOString()` throw a RangeError that would surface as an HTTP
  // 500 or an uncaught stack trace in the CLI offline fallback.
  const since = clampTime(rawSince)
  const clampedUntil = clampTime(until)
  return {
    since,
    until: clampedUntil,
    sinceIso: new Date(since).toISOString(),
    untilIso: new Date(clampedUntil).toISOString(),
    days: Math.max(0, (clampedUntil - since) / DAY_MS),
  }
}

function filterFor(window: AnalyticsWindow, request: AnalyticsRequest): RunAnalyticsFilter {
  return {
    since: window.since,
    until: window.until,
    roadmapId: request.roadmapId,
    profile: request.profile,
    agent: request.agent,
    stage: request.stage,
  }
}

function scopeFor(request: AnalyticsRequest): AnalyticsScope {
  return { roadmapId: request.roadmapId, profile: request.profile, agent: request.agent, stage: request.stage }
}

/** Median of a numeric list (0 for empty); used for underperformer thresholds. */
function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function completionRate(passed: number, terminal: number): number {
  return terminal > 0 ? passed / terminal : 0
}

/**
 * Decompose an errored-run class breakdown into the operational / external /
 * genuine cohorts (see {@link ErrorClassSplit}). `genuineFailureRate` charges
 * only the genuine cohort against terminal runs, so it is the profile's own
 * completion-health signal — free of Gateway session-recovery churn and
 * provider-balance blips.
 */
export function deriveErrorClassSplit(errorClasses: RunErrorClassCounts, terminal: number): ErrorClassSplit {
  const operationalErrored = errorClasses.recovered_session + errorClasses.force_done + errorClasses.lease_expired
  const externalErrored = errorClasses.provider_balance + errorClasses.transport + errorClasses.provider_error
  const genuineErrored = errorClasses.genuine_failure
  const unknownErrored = errorClasses.unknown
  return {
    errorClasses,
    operationalErrored,
    externalErrored,
    genuineErrored,
    unknownErrored,
    genuineFailureRate: terminal > 0 ? genuineErrored / terminal : 0,
  }
}

/** Sum two error-class breakdowns field-by-field (used for the window-wide overall). */
function addErrorClassCounts(a: RunErrorClassCounts, b: RunErrorClassCounts): RunErrorClassCounts {
  return {
    recovered_session: a.recovered_session + b.recovered_session,
    force_done: a.force_done + b.force_done,
    lease_expired: a.lease_expired + b.lease_expired,
    provider_balance: a.provider_balance + b.provider_balance,
    transport: a.transport + b.transport,
    provider_error: a.provider_error + b.provider_error,
    genuine_failure: a.genuine_failure + b.genuine_failure,
    unknown: a.unknown + b.unknown,
    total: a.total + b.total,
  }
}

function hasCostBudget(budget?: GovernanceBudgetConfig): boolean {
  return Boolean(budget && (budget.dailyCostUsd !== undefined || budget.weeklyCostUsd !== undefined || budget.monthlyCostUsd !== undefined || budget.totalCostUsd !== undefined || budget.tokenLimit !== undefined))
}

/**
 * Best-effort budget-trend context: window actual spend vs. any configured
 * governance cost budget for the global scope and (when requested) the scoped
 * roadmap. This surfaces the configured limits alongside actual window spend;
 * the authoritative over/under decision (warn/block, daily/weekly/monthly
 * rollups) remains in governance to avoid duplicating that policy here.
 */
function buildBudgetTrend(window: AnalyticsWindow, request: AnalyticsRequest, config: GatewayConfig, filePath: string): AnalyticsBudgetTrend {
  if (!config.governance?.enabled) {
    return { enabled: false, note: 'Governance disabled; budget comparison available via the governance surface when enabled.', entries: [] }
  }
  const entries: AnalyticsBudgetTrendEntry[] = []
  const push = (name: string, scope: 'global' | 'roadmap', budget: GovernanceBudgetConfig, roadmapId?: string) => {
    if (!hasCostBudget(budget)) return
    // Window spend must reconcile with the summary's usageByDimension total, so
    // compute it from the same analytics aggregate: the full window (since AND
    // until), the entry's roadmap (falling back to the requested roadmap scope),
    // and the requested profile/agent/stage scope. getRunCostTokenTotals windows
    // on COALESCE(completed_at, started_at) and ignores those scopes, which is why
    // it could not reconcile with the started_at-windowed grouped totals.
    const windowCostUsd = getRunAnalyticsUsageTotals({
      since: window.since,
      until: window.until,
      roadmapId: roadmapId ?? request.roadmapId,
      profile: request.profile,
      agent: request.agent,
      stage: request.stage,
    }, filePath).costUsd
    entries.push({ name, scope, roadmapId, windowCostUsd, dailyCostUsd: budget.dailyCostUsd, weeklyCostUsd: budget.weeklyCostUsd, monthlyCostUsd: budget.monthlyCostUsd, totalCostUsd: budget.totalCostUsd, tokenLimit: budget.tokenLimit })
  }
  push('global', 'global', config.governance.global)
  const roadmapBudgets = config.governance.roadmaps || {}
  // When a roadmap scope is requested, compare just that roadmap; otherwise
  // include every roadmap that actually declares a budget (bounded by config).
  if (request.roadmapId) {
    const budget = roadmapBudgets[request.roadmapId]
    if (budget) push(`roadmap:${request.roadmapId}`, 'roadmap', budget, request.roadmapId)
  } else {
    for (const [roadmapId, budget] of Object.entries(roadmapBudgets)) push(`roadmap:${roadmapId}`, 'roadmap', budget, roadmapId)
  }
  const note = entries.length
    ? 'Actual window spend vs. configured governance cost budgets. Full over/under evaluation lives in the governance surface.'
    : 'Governance enabled but no cost budgets configured for the global or requested scope.'
  return { enabled: true, note, entries }
}

/**
 * Spend/usage by dimension + outcome distribution + retry hotspots + budget
 * trend for a bounded window and optional scope.
 */
export function buildAnalyticsSummary(request: AnalyticsRequest = {}, filePath = workStatePath(), now = Date.now()): AnalyticsSummary {
  const window = resolveWindow(request, now)
  const dimension = request.by || 'profile'
  const filter = filterFor(window, request)
  const bundle = getRunAnalyticsBundle(dimension, filter, { hotspotLimit: request.hotspotLimit ?? 5 }, filePath)
  const usageByDimension: AnalyticsUsageRow[] = bundle.groups.map(row => ({
    key: row.key,
    runCount: row.runCount,
    costUsd: row.costUsd,
    tokens: row.tokens,
    runtimeMs: row.runtimeMs,
  }))
  return {
    generatedAt: new Date(now).toISOString(),
    window,
    scope: scopeFor(request),
    dimension,
    usageByDimension,
    outcomeDistribution: {
      ...bundle.outcomes,
      completionRate: completionRate(bundle.outcomes.passed, bundle.outcomes.passed + bundle.outcomes.failed + bundle.outcomes.blocked + bundle.outcomes.errored),
    },
    retryHotspots: bundle.retryHotspots,
    budgetTrend: buildBudgetTrend(window, request, getConfig(), filePath),
  }
}

function toScorecardRow(row: RunAnalyticsGroupRow): AnalyticsScorecardRow {
  return {
    key: row.key,
    totalRuns: row.runCount,
    passed: row.passed,
    failed: row.failed,
    blocked: row.blocked,
    errored: row.errored,
    running: row.running,
    terminal: row.terminal,
    completionRate: completionRate(row.passed, row.terminal),
    avgAttempts: row.runCount > 0 ? row.attemptSum / row.runCount : 0,
    completedTasks: row.completedTasks,
    costUsd: row.costUsd,
    tokens: row.tokens,
    runtimeMs: row.runtimeMs,
    costPerCompletedTask: row.completedTasks > 0 ? row.costUsd / row.completedTasks : undefined,
    ...deriveErrorClassSplit(row.errorClasses, row.terminal),
  }
}

/**
 * Per-profile / per-agent completion + cost scorecard, plus derived
 * underperformers (STRICTLY above-median spend AND STRICTLY below-median
 * completion among rows that produced terminal runs). Medians are computed over
 * the same window's scorecard rows so the selection is self-referential and
 * needs no config; a group must be strictly worse than its peers on both axes,
 * so a single rated group or an all-equal set flags nothing.
 */
export function buildAnalyticsScorecard(request: AnalyticsRequest = {}, filePath = workStatePath(), now = Date.now()): AnalyticsScorecard {
  const window = resolveWindow(request, now)
  const dimension = request.by || 'profile'
  const groups = getRunAnalyticsGroups(dimension, filterFor(window, request), filePath)
  const scorecards = groups.map(toScorecardRow)
  // Only rows that reached a terminal state can meaningfully under/over-perform.
  const rated = scorecards.filter(row => row.terminal > 0)
  const medianCost = median(rated.map(row => row.costUsd))
  const medianCompletion = median(rated.map(row => row.completionRate))
  // An underperformer must be STRICTLY worse than its peers on both axes — above
  // median spend AND below median completion. With a single rated group (median
  // == itself) or all groups equal, nothing is strictly worse, so nothing is
  // flagged. This requires at least two rated groups for any peer comparison to
  // be meaningful and avoids false-positives (e.g. a 100%-completion high-cost
  // group at/above median completion is never flagged).
  const underperformers: AnalyticsUnderperformer[] = (rated.length >= 2 ? rated : [])
    .filter(row => row.costUsd > medianCost && row.completionRate < medianCompletion)
    .map(row => ({
      ...row,
      reason: `Spend $${row.costUsd.toFixed(4)} > median $${medianCost.toFixed(4)} and completion ${(row.completionRate * 100).toFixed(1)}% < median ${(medianCompletion * 100).toFixed(1)}%`,
    }))
    .sort((a, b) => (b.costUsd - a.costUsd) || (a.completionRate - b.completionRate))
  const overallErrorClasses = scorecards.reduce((sum, row) => addErrorClassCounts(sum, row.errorClasses), emptyErrorClassCounts())
  const overallTerminal = scorecards.reduce((sum, row) => sum + row.terminal, 0)
  return {
    generatedAt: new Date(now).toISOString(),
    window,
    scope: scopeFor(request),
    dimension,
    medians: { costUsd: medianCost, completionRate: medianCompletion },
    scorecards,
    underperformers,
    overall: { ...deriveErrorClassSplit(overallErrorClasses, overallTerminal), terminal: overallTerminal },
  }
}

/** Parse an analytics request from HTTP query params (all optional). */
export function parseAnalyticsRequestFromParams(params: URLSearchParams): AnalyticsRequest {
  const dimension = params.get('by')
  const numeric = (value: string | null): number | undefined => {
    if (value === null || value === '') return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return {
    windowDays: numeric(params.get('window') ?? params.get('windowDays')),
    since: numeric(params.get('since')),
    until: numeric(params.get('until')),
    roadmapId: params.get('roadmapId') || undefined,
    profile: params.get('profile') || undefined,
    agent: params.get('agent') || undefined,
    stage: params.get('stage') || undefined,
    by: dimension === 'agent' || dimension === 'roadmap' || dimension === 'profile' ? dimension : undefined,
    hotspotLimit: numeric(params.get('limit')),
  }
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

/** Human-readable text rendering of the analytics summary (CLI / MCP default). */
export function formatAnalyticsSummaryText(summary: AnalyticsSummary): string {
  const lines: string[] = [
    `# Run Analytics (last ${summary.window.days.toFixed(0)}d, by ${summary.dimension})`,
    `Window: ${summary.window.sinceIso} -> ${summary.window.untilIso}`,
  ]
  const scopeBits = Object.entries(summary.scope).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`)
  if (scopeBits.length) lines.push(`Scope: ${scopeBits.join(', ')}`)
  const outcome = summary.outcomeDistribution
  lines.push('', `Outcomes: ${outcome.total} runs | passed ${outcome.passed} | failed ${outcome.failed} | blocked ${outcome.blocked} | errored ${outcome.errored} | running ${outcome.running} | completion ${(outcome.completionRate * 100).toFixed(1)}%`)
  lines.push('', `Spend by ${summary.dimension}:`)
  if (!summary.usageByDimension.length) lines.push('  (no runs in window)')
  for (const row of summary.usageByDimension) {
    lines.push(`  - ${row.key}: ${row.runCount} runs | ${formatUsd(row.costUsd)} | ${row.tokens.toLocaleString()} tok | ${Math.round(row.runtimeMs / 1000)}s`)
  }
  if (summary.retryHotspots.length) {
    lines.push('', 'Retry hotspots:')
    for (const spot of summary.retryHotspots) lines.push(`  - ${spot.taskId}: attempt ${spot.maxAttempt} | ${spot.runCount} runs | ${formatUsd(spot.costUsd)}`)
  }
  if (summary.budgetTrend.entries.length) {
    lines.push('', 'Budget trend (window spend vs configured limits):')
    for (const entry of summary.budgetTrend.entries) {
      const limit = entry.monthlyCostUsd ?? entry.weeklyCostUsd ?? entry.dailyCostUsd ?? entry.totalCostUsd
      lines.push(`  - ${entry.name}: ${formatUsd(entry.windowCostUsd)} spent${limit !== undefined ? ` | limit ${formatUsd(limit)}` : ''}`)
    }
  } else {
    lines.push('', `Budget trend: ${summary.budgetTrend.note}`)
  }
  return lines.join('\n')
}

/** Human-readable text rendering of the scorecard (CLI / MCP default). */
export function formatAnalyticsScorecardText(scorecard: AnalyticsScorecard): string {
  const lines: string[] = [
    `# ${scorecard.dimension} Scorecard (last ${scorecard.window.days.toFixed(0)}d)`,
    `Window: ${scorecard.window.sinceIso} -> ${scorecard.window.untilIso}`,
    `Medians: cost ${formatUsd(scorecard.medians.costUsd)} | completion ${(scorecard.medians.completionRate * 100).toFixed(1)}%`,
    '',
  ]
  const overall = scorecard.overall
  if (overall.errorClasses.total > 0) {
    lines.push(`Errored breakdown: ${overall.errorClasses.total} errored = ${overall.operationalErrored} operational + ${overall.externalErrored} external + ${overall.genuineErrored} genuine + ${overall.unknownErrored} unknown | genuine failure rate ${(overall.genuineFailureRate * 100).toFixed(1)}%`)
    lines.push('')
  }
  if (!scorecard.scorecards.length) lines.push('(no runs in window)')
  for (const row of scorecard.scorecards) {
    const cpct = row.costPerCompletedTask !== undefined ? formatUsd(row.costPerCompletedTask) : 'n/a'
    lines.push(`- ${row.key}: ${row.totalRuns} runs | completion ${(row.completionRate * 100).toFixed(1)}% | genuine-fail ${(row.genuineFailureRate * 100).toFixed(1)}% | avgAttempts ${row.avgAttempts.toFixed(2)} | ${formatUsd(row.costUsd)} | cost/completed ${cpct}`)
    if (row.errorClasses.total > 0) lines.push(`    errored ${row.errorClasses.total}: ${formatErrorClasses(row.errorClasses)} (operational ${row.operationalErrored} | external ${row.externalErrored} | genuine ${row.genuineErrored} | unknown ${row.unknownErrored})`)
  }
  if (scorecard.underperformers.length) {
    lines.push('', 'Underperformers (high spend, low completion):')
    for (const row of scorecard.underperformers) lines.push(`  - ${row.key}: ${row.reason}`)
  }
  return lines.join('\n')
}

/** Compact `class=count` list of the non-zero errored classes for a group. */
function formatErrorClasses(counts: RunErrorClassCounts): string {
  const parts = (['recovered_session', 'force_done', 'lease_expired', 'provider_balance', 'transport', 'provider_error', 'genuine_failure', 'unknown'] as const)
    .filter(klass => counts[klass] > 0)
    .map(klass => `${klass}=${counts[klass]}`)
  return parts.length ? parts.join(', ') : 'none'
}
