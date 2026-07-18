import type { GatewayConfig, GovernanceAction, GovernanceBudgetConfig } from './config.js'
import { getConfig } from './config.js'
import { loadWorkState, workStatePath, type RunRecord, type WorkState, type WorkTaskRecord } from './work-store.js'
import { getRunCostTokenTotals, getRunUsageTotalsBatch, type RunUsageQuery } from './work-store/analytics-queries.js'

export type GovernanceDecisionStatus = 'allowed' | 'warn' | 'blocked' | 'paused'

export interface GovernanceDecision {
  allowed: boolean
  status: GovernanceDecisionStatus
  action: GovernanceAction
  reason: string
  scope?: string
  limit?: number
  used?: number
  remaining?: number
}

export interface GovernanceReport {
  enabled: boolean
  status: 'ok' | 'warn' | 'blocked'
  summary: string
  generatedAt: string
  totals: { costUsd: number; tokens: number; runtimeMs: number }
  budgets: Array<GovernanceDecision & { name: string }>
}

/**
 * Per-scope run usage priced from SQL aggregates (never by JS-reducing the full
 * run array). `total*` is the all-time scope aggregate; the windowed costs mirror
 * governance's `eventTime(run) >= startOfDay/Week/Month` filters.
 */
interface BudgetUsage {
  totalCost: number
  totalTokens: number
  dailyCost: number
  weeklyCost: number
  monthlyCost: number
}

const ZERO_USAGE: BudgetUsage = { totalCost: 0, totalTokens: 0, dailyCost: 0, weeklyCost: 0, monthlyCost: 0 }

interface PricedBudget {
  name: string
  budget: GovernanceBudgetConfig
  filter: RunUsageQuery
}

export function evaluateGovernanceForTask(task: WorkTaskRecord, stage: string, _state: WorkState = loadWorkState(), config: GatewayConfig = getConfig(), now = Date.now(), filePath = workStatePath()): GovernanceDecision {
  if (!config.governance?.enabled) return allowed('Governance disabled')
  const checks = budgetChecksForTask(task, stage, config)
  const usageByName = priceBudgets(checks.map(check => ({ name: check.name, budget: check.budget, filter: scopeFilterForTask(check.scope, task, stage) })), now, filePath)
  let warning: GovernanceDecision | undefined
  for (const check of checks) {
    const decision = evaluateBudget(check.name, check.budget, usageByName.get(check.name) || ZERO_USAGE, config.governance.action)
    if (!decision.allowed) return decision
    if (decision.status === 'warn' && !warning) warning = decision
  }
  if (warning) return warning
  return allowed('Governance budgets allow dispatch')
}

export function evaluateRunRuntime(run: RunRecord, config: GatewayConfig = getConfig(), now = Date.now()): GovernanceDecision {
  const maxRunMs = Number(config.governance?.runtime?.maxRunMs || 0)
  if (!config.governance?.enabled || maxRunMs <= 0) return allowed('Runtime governance disabled')
  const runtimeMs = now - Date.parse(run.startedAt)
  if (!Number.isFinite(runtimeMs) || runtimeMs <= maxRunMs) return allowed('Runtime within limit')
  return { allowed: false, status: 'blocked', action: 'block', reason: `Run exceeded runtime ceiling (${formatDuration(runtimeMs)} > ${formatDuration(maxRunMs)})`, scope: `run:${run.id}`, limit: maxRunMs, used: runtimeMs, remaining: 0 }
}

export function buildGovernanceReport(state: WorkState = loadWorkState(), config: GatewayConfig = getConfig(), now = Date.now(), filePath = workStatePath()): GovernanceReport {
  const runningRuntimeMs = state.runs.reduce((sum, run) => sum + runningRuntime(run, now), 0)
  if (!config.governance?.enabled) {
    return { enabled: false, status: 'ok', summary: 'Governance disabled', generatedAt: new Date(now).toISOString(), totals: reportTotals(runningRuntimeMs, filePath), budgets: [] }
  }
  const priced: PricedBudget[] = []
  if (hasBudget(config.governance.global)) priced.push({ name: 'global', budget: config.governance.global, filter: {} })
  for (const [roadmapId, budget] of Object.entries(config.governance.roadmaps || {})) priced.push({ name: `roadmap:${roadmapId}`, budget, filter: { roadmapId } })
  for (const [taskId, budget] of Object.entries(config.governance.tasks || {})) priced.push({ name: `task:${taskId}`, budget, filter: { taskId } })
  for (const [stage, budget] of Object.entries(config.governance.stages || {})) priced.push({ name: `stage:${stage}`, budget, filter: { stage } })
  const usageByName = priceBudgets(priced, now, filePath)
  const budgets = priced.map(entry => ({ ...evaluateBudget(entry.name, entry.budget, usageByName.get(entry.name) || ZERO_USAGE, config.governance!.action), name: entry.name }))
  const blocked = budgets.filter(row => !row.allowed)
  const warned = budgets.filter(row => row.status === 'warn')
  return {
    enabled: true,
    status: blocked.length ? 'blocked' : warned.length ? 'warn' : 'ok',
    summary: blocked.length ? `${blocked.length} budget limit(s) exhausted` : warned.length ? `${warned.length} budget limit(s) near exhaustion` : 'Governance budgets are within limits',
    generatedAt: new Date(now).toISOString(),
    totals: reportTotals(runningRuntimeMs, filePath),
    budgets,
  }
}

export function formatGovernanceReport(report: GovernanceReport): string {
  const lines = [
    `Governance: ${report.status}`,
    `Summary: ${report.summary}`,
    `Spend: $${report.totals.costUsd.toFixed(4)} | Tokens: ${report.totals.tokens.toLocaleString()} | Runtime: ${formatDuration(report.totals.runtimeMs)}`,
  ]
  for (const budget of report.budgets.slice(0, 8)) {
    lines.push(`- [${budget.status}] ${budget.name}: ${budget.reason}`)
  }
  return lines.join('\n')
}

/**
 * All-time report totals: cost / tokens / terminal runtime come from one SQL
 * aggregate over the durable runs table, and the in-flight running runtime is
 * added from the live state — mirroring the old
 * `totalUsage(state.runs).runtimeMs` (which counted `runtimeMs || now - startedAt`).
 */
function reportTotals(runningRuntimeMs: number, filePath: string): { costUsd: number; tokens: number; runtimeMs: number } {
  const totals = getRunCostTokenTotals({}, filePath)
  return { costUsd: totals.costUsd, tokens: totals.tokens, runtimeMs: totals.runtimeMs + runningRuntimeMs }
}

/**
 * Price every configured budget window in a single read-only connection. Only
 * the windows a budget actually declares are queried, so the batch stays small
 * and flat regardless of how much run history has accumulated.
 */
function priceBudgets(entries: PricedBudget[], now: number, filePath: string): Map<string, BudgetUsage> {
  const queries: RunUsageQuery[] = []
  const plans: Array<{ name: string; total?: number; daily?: number; weekly?: number; monthly?: number }> = []
  for (const entry of entries) {
    const plan: { name: string; total?: number; daily?: number; weekly?: number; monthly?: number } = { name: entry.name }
    const budget = entry.budget
    if (budget?.totalCostUsd !== undefined || budget?.tokenLimit !== undefined) { plan.total = queries.length; queries.push({ ...entry.filter }) }
    if (budget?.dailyCostUsd !== undefined) { plan.daily = queries.length; queries.push({ ...entry.filter, since: startOfDay(now) }) }
    if (budget?.weeklyCostUsd !== undefined) { plan.weekly = queries.length; queries.push({ ...entry.filter, since: startOfWeek(now) }) }
    if (budget?.monthlyCostUsd !== undefined) { plan.monthly = queries.length; queries.push({ ...entry.filter, since: startOfMonth(now) }) }
    plans.push(plan)
  }
  const totals = getRunUsageTotalsBatch(queries, filePath)
  const usageByName = new Map<string, BudgetUsage>()
  for (const plan of plans) {
    usageByName.set(plan.name, {
      totalCost: plan.total !== undefined ? totals[plan.total]!.costUsd : 0,
      totalTokens: plan.total !== undefined ? totals[plan.total]!.tokens : 0,
      dailyCost: plan.daily !== undefined ? totals[plan.daily]!.costUsd : 0,
      weeklyCost: plan.weekly !== undefined ? totals[plan.weekly]!.costUsd : 0,
      monthlyCost: plan.monthly !== undefined ? totals[plan.monthly]!.costUsd : 0,
    })
  }
  return usageByName
}

function scopeFilterForTask(scope: string, task: WorkTaskRecord, stage: string): RunUsageQuery {
  if (scope === 'roadmap') return { roadmapId: task.roadmapId }
  if (scope === 'task') return { taskId: task.id }
  if (scope === 'stage') return { stage }
  return {}
}

function budgetChecksForTask(task: WorkTaskRecord, stage: string, config: GatewayConfig): Array<{ name: string; budget: GovernanceBudgetConfig; scope: string }> {
  const checks: Array<{ name: string; budget: GovernanceBudgetConfig; scope: string }> = []
  if (hasBudget(config.governance.global)) checks.push({ name: 'global', budget: config.governance.global, scope: 'global' })
  const roadmapBudget = config.governance.roadmaps?.[task.roadmapId]
  if (hasBudget(roadmapBudget)) checks.push({ name: `roadmap:${task.roadmapId}`, budget: roadmapBudget, scope: 'roadmap' })
  const taskBudget = config.governance.tasks?.[task.id]
  if (hasBudget(taskBudget)) checks.push({ name: `task:${task.id}`, budget: taskBudget, scope: 'task' })
  const stageBudget = config.governance.stages?.[stage]
  if (hasBudget(stageBudget)) checks.push({ name: `stage:${stage}`, budget: stageBudget, scope: 'stage' })
  return checks
}

function evaluateBudget(name: string, budget: GovernanceBudgetConfig | undefined, usage: BudgetUsage, defaultAction: GovernanceAction): GovernanceDecision {
  if (!hasBudget(budget)) return allowed(`${name} has no budget`)
  const action = budget!.action || defaultAction
  const checks = [
    budget!.dailyCostUsd !== undefined ? limitCheck(name, 'daily cost', usage.dailyCost, budget!.dailyCostUsd, action) : undefined,
    budget!.weeklyCostUsd !== undefined ? limitCheck(name, 'weekly cost', usage.weeklyCost, budget!.weeklyCostUsd, action) : undefined,
    budget!.monthlyCostUsd !== undefined ? limitCheck(name, 'monthly cost', usage.monthlyCost, budget!.monthlyCostUsd, action) : undefined,
    budget!.totalCostUsd !== undefined ? limitCheck(name, 'total cost', usage.totalCost, budget!.totalCostUsd, action) : undefined,
    budget!.tokenLimit !== undefined ? limitCheck(name, 'tokens', usage.totalTokens, budget!.tokenLimit, action) : undefined,
  ].filter(Boolean) as GovernanceDecision[]
  return checks.find(check => !check.allowed) || checks.find(check => check.status === 'warn') || allowed(`${name} budget is within limits`)
}

function limitCheck(scope: string, label: string, used: number, limit: number, action: GovernanceAction): GovernanceDecision {
  const remaining = Math.max(0, limit - used)
  if (used >= limit) return { allowed: action === 'warn', status: action === 'pause' ? 'paused' : action === 'warn' ? 'warn' : 'blocked', action, reason: `${scope} ${label} exhausted (${formatLimit(used)} / ${formatLimit(limit)})`, scope, used, limit, remaining }
  if (limit > 0 && used / limit >= 0.8) return { allowed: true, status: 'warn', action, reason: `${scope} ${label} near exhaustion (${formatLimit(used)} / ${formatLimit(limit)})`, scope, used, limit, remaining }
  return { ...allowed(`${scope} ${label} remaining ${formatLimit(remaining)}`), scope, used, limit, remaining }
}

function runningRuntime(run: RunRecord, now: number): number {
  if (run.status !== 'running') return 0
  const startedAt = Date.parse(run.startedAt || '')
  return Number.isFinite(startedAt) && now > startedAt ? now - startedAt : 0
}

function hasBudget(budget?: GovernanceBudgetConfig): budget is GovernanceBudgetConfig {
  return Boolean(budget && (budget.dailyCostUsd !== undefined || budget.weeklyCostUsd !== undefined || budget.monthlyCostUsd !== undefined || budget.totalCostUsd !== undefined || budget.tokenLimit !== undefined))
}

function allowed(reason: string): GovernanceDecision {
  return { allowed: true, status: 'allowed', action: 'block', reason }
}

function startOfDay(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function startOfWeek(now: number): number {
  const date = new Date(startOfDay(now))
  const day = date.getDay() || 7
  date.setDate(date.getDate() - day + 1)
  return date.getTime()
}

function startOfMonth(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

function formatLimit(value: number): string {
  return value < 1000 ? value.toFixed(value < 10 ? 4 : 2).replace(/\.0+$/, '') : Math.round(value).toLocaleString()
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}
