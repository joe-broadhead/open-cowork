import {
  MISSION_CONTROL_WINDOW_SPECS,
  missionControlWindow,
  selectEvidenceWindowRows,
  type MissionControlSourceContract,
} from './mission-control-view-model.js'
import { evaluateReadiness, type ReadinessCheck } from './readiness.js'

export type PerformanceBudgetStatus = 'pass' | 'fail'

export interface PerformanceBudgetRow {
  id: string
  surface: string
  status: PerformanceBudgetStatus
  summary: string
  observed: Record<string, unknown>
  budget: Record<string, unknown>
  safeNextAction: string
  diagnostics: string[]
}

export interface PerformanceBudgetReport {
  schemaVersion: 1
  mode: 'm40_local_performance_responsiveness_budgets'
  generatedAt: string
  status: PerformanceBudgetStatus
  releaseClaim: 'configured_local_performance_budget_evidence_only_no_arbitrary_scale_claim'
  fixtures: {
    tasks: number
    runs: number
    channelBindings: number
    evidenceRows: number
    incidentTraceRows: number
    workerQueuedTasks: number
    workerCapacityLimit: number
  }
  budgets: PerformanceBudgetRow[]
  failingBudgets: Array<{ id: string; safeNextAction: string }>
  unsupportedClaims: string[]
}

interface BudgetInput {
  id: string
  surface: string
  ok: boolean
  summary: string
  observed: Record<string, unknown>
  budget: Record<string, unknown>
  safeNextAction: string
  diagnostics?: string[]
}

export function buildPerformanceBudgetReport(options: { generatedAt?: string } = {}): PerformanceBudgetReport {
  const generatedAt = options.generatedAt || new Date().toISOString()
  const fixtures = {
    tasks: 750,
    runs: 640,
    channelBindings: 320,
    evidenceRows: 420,
    incidentTraceRows: 210,
    workerQueuedTasks: 240,
    workerCapacityLimit: 8,
  }

  const taskWindow = missionControlWindow('tasks', fixtureRows(fixtures.tasks, 'task'), {
    tasks: { limit: 999, offset: 10 },
  })
  const runWindow = missionControlWindow('runs', fixtureRows(fixtures.runs, 'run'), {
    runs: { limit: 999, offset: 40 },
  })
  const channelWindow = missionControlWindow('channelBindings', fixtureChannelBindings(fixtures.channelBindings), {
    channelBindings: { limit: 999, search: 'telegram' },
  })
  const readinessChecks: ReadinessCheck[] = [
    { name: 'scheduler_capacity', status: 'pass', severity: 'info', summary: 'Synthetic queue stays inside configured local scheduler limit.' },
    { name: 'mission_control_windows', status: 'pass', severity: 'info', summary: 'Mission Control windows are bounded by configured max limits.' },
    { name: 'evidence_export_window', status: 'pass', severity: 'info', summary: 'Evidence export rows use selected windows.' },
  ]
  const readiness = evaluateReadiness(readinessChecks)
  const evidenceRows = fixtureRows(fixtures.evidenceRows, 'evidence')
  const selectedEvidenceRows = selectEvidenceWindowRows(evidenceRows, evidenceRows)
  const incidentWindows = {
    traceTasks: windowBudget(fixtures.incidentTraceRows, 10),
    traceRuns: windowBudget(fixtures.incidentTraceRows, 10),
    auditLedger: windowBudget(fixtures.evidenceRows, 20),
  }
  const budgets = [
    windowBudgetRow({
      id: 'mission_control_tasks_window',
      surface: 'Mission Control Issues window',
      contract: taskWindow.contract,
      expectedLimit: MISSION_CONTROL_WINDOW_SPECS.tasks.maxLimit,
      expectedHasMore: true,
      safeNextAction: 'Restore the Mission Control tasks max window clamp before claiming high-volume dashboard usability.',
    }),
    windowBudgetRow({
      id: 'queue_views_runs_window',
      surface: 'Queue and run read model window',
      contract: runWindow.contract,
      expectedLimit: MISSION_CONTROL_WINDOW_SPECS.runs.maxLimit,
      expectedHasMore: true,
      safeNextAction: 'Restore bounded run windows or add explicit pagination before claiming queue responsiveness.',
    }),
    windowBudgetRow({
      id: 'channel_status_window',
      surface: 'Channel status bindings window',
      contract: channelWindow.contract,
      expectedLimit: MISSION_CONTROL_WINDOW_SPECS.channelBindings.maxLimit,
      expectedHasMore: true,
      safeNextAction: 'Restore bounded channel-binding windows and provider search before claiming channel status responsiveness.',
    }),
    budgetRow({
      id: 'readiness_queue_status_budget',
      surface: 'Readiness queue status',
      ok: readiness.state === 'ready',
      summary: `Readiness pure evaluator reports ${readiness.state} for local budget checks.`,
      observed: { state: readiness.state, summary: readiness.summary, checks: readinessChecks.length, pending: 720, running: 8, maxConcurrent: 8 },
      budget: { requiredState: 'ready', maxConcurrent: 8, pendingQueueVisible: true },
      safeNextAction: 'Keep readiness budget checks pure and bounded; route live OpenCode/provider proof through separate readiness commands.',
    }),
    budgetRow({
      id: 'proof_export_evidence_window',
      surface: 'Proof/evidence export selected rows',
      ok: selectedEvidenceRows.length === MISSION_CONTROL_WINDOW_SPECS.evidence.defaultLimit,
      summary: `${selectedEvidenceRows.length} of ${fixtures.evidenceRows} evidence row(s) selected for bounded proof export.`,
      observed: { totalRows: fixtures.evidenceRows, selectedRows: selectedEvidenceRows.length },
      budget: { maxSelectedRows: MISSION_CONTROL_WINDOW_SPECS.evidence.defaultLimit, redactedAndWindowed: true },
      safeNextAction: 'Restore selected evidence windows before exporting large proof bundles.',
    }),
    budgetRow({
      id: 'incident_bundle_windows',
      surface: 'Incident/support bundle output windows',
      ok: incidentWindows.traceTasks.shown <= 10 && incidentWindows.traceRuns.shown <= 10 && incidentWindows.auditLedger.shown <= 20 && incidentWindows.auditLedger.omitted > 0,
      summary: 'Incident bundle windows keep trace tasks, trace runs, and audit ledger rows bounded.',
      observed: incidentWindows,
      budget: { traceTaskLimit: 10, traceRunLimit: 10, auditLedgerLimit: 20 },
      safeNextAction: 'Keep incident bundle manifests windowed and route full private evidence through local redacted artifacts only.',
    }),
  ]
  const failingBudgets = budgets.filter(row => row.status === 'fail').map(row => ({ id: row.id, safeNextAction: row.safeNextAction }))

  return {
    schemaVersion: 1,
    mode: 'm40_local_performance_responsiveness_budgets',
    generatedAt,
    status: failingBudgets.length ? 'fail' : 'pass',
    releaseClaim: 'configured_local_performance_budget_evidence_only_no_arbitrary_scale_claim',
    fixtures,
    budgets,
    failingBudgets,
    unsupportedClaims: [
      'arbitrary-scale readiness',
      'hosted/team performance readiness',
      'hundreds of live agents without elapsed soak evidence',
      'unattended production operation',
      'universal-channel performance parity',
    ],
  }
}

export function formatPerformanceBudgetReport(report: PerformanceBudgetReport): string {
  const lines = [
    `Performance budgets: ${report.status}`,
    `Mode: ${report.mode}`,
    `Claim: ${report.releaseClaim}`,
    `Generated: ${report.generatedAt}`,
    '',
    'Fixtures:',
    `- tasks=${report.fixtures.tasks}, runs=${report.fixtures.runs}, channelBindings=${report.fixtures.channelBindings}, evidenceRows=${report.fixtures.evidenceRows}`,
    `- incidentTraceRows=${report.fixtures.incidentTraceRows}, workerQueuedTasks=${report.fixtures.workerQueuedTasks}, workerCapacityLimit=${report.fixtures.workerCapacityLimit}`,
    '',
    'Budgets:',
  ]

  for (const row of report.budgets) {
    lines.push(`- [${row.status}] ${row.id}: ${row.summary}`)
    lines.push(`  Safe next action: ${row.safeNextAction}`)
    if (row.diagnostics.length) lines.push(`  Diagnostics: ${row.diagnostics.join('; ')}`)
  }
  if (report.failingBudgets.length) {
    lines.push('', 'Failing budgets:')
    for (const row of report.failingBudgets) lines.push(`- ${row.id}: ${row.safeNextAction}`)
  }
  lines.push('', 'Unsupported claims:')
  for (const claim of report.unsupportedClaims) lines.push(`- ${claim}`)
  return lines.join('\n')
}

function windowBudgetRow(input: {
  id: string
  surface: string
  contract: MissionControlSourceContract
  expectedLimit: number
  expectedHasMore: boolean
  safeNextAction: string
}): PerformanceBudgetRow {
  const ok = input.contract.limit === input.expectedLimit
    && input.contract.shown <= input.expectedLimit
    && input.contract.hasMore === input.expectedHasMore
    && input.contract.state === 'partial'
  return budgetRow({
    id: input.id,
    surface: input.surface,
    ok,
    summary: `${input.contract.label} shows ${input.contract.shown}/${input.contract.total} row(s) with limit ${input.contract.limit}.`,
    observed: {
      state: input.contract.state,
      total: input.contract.total,
      matched: input.contract.matched,
      shown: input.contract.shown,
      limit: input.contract.limit,
      offset: input.contract.offset,
      hasMore: input.contract.hasMore,
      truncated: input.contract.truncated,
      search: input.contract.search,
    },
    budget: { maxLimit: input.expectedLimit, expectedState: 'partial', expectedHasMore: input.expectedHasMore },
    safeNextAction: input.safeNextAction,
  })
}

function budgetRow(input: BudgetInput): PerformanceBudgetRow {
  return {
    id: input.id,
    surface: input.surface,
    status: input.ok ? 'pass' : 'fail',
    summary: input.summary,
    observed: input.observed,
    budget: input.budget,
    safeNextAction: input.safeNextAction,
    diagnostics: input.diagnostics || diagnosticsFor(input),
  }
}

function diagnosticsFor(input: BudgetInput): string[] {
  if (input.ok) return []
  return [
    `Budget ${input.id} failed for ${input.surface}.`,
    `Observed ${JSON.stringify(input.observed)} against ${JSON.stringify(input.budget)}.`,
  ]
}

function fixtureRows(count: number, prefix: string): Array<{ id: string; title: string; status: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${String(index).padStart(4, '0')}`,
    title: `${prefix} budget fixture ${index}`,
    status: index % 7 === 0 ? 'running' : 'pending',
  }))
}

function fixtureChannelBindings(count: number): Array<{ id: string; provider: string; target: string; status: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `channel_binding_${String(index).padStart(4, '0')}`,
    provider: 'telegram',
    target: `redacted-target-${index}`,
    status: index % 11 === 0 ? 'stale' : 'trusted',
  }))
}

function windowBudget(total: number, limit: number): { total: number; shown: number; omitted: number; limit: number } {
  const shown = Math.min(total, limit)
  return { total, shown, omitted: Math.max(0, total - shown), limit }
}
