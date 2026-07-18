import { createHash } from 'node:crypto'
import { channelTargetFingerprint } from './security.js'
import type { AlertRecord, AuditLedgerRecord, ChannelBindingRecord, RunRecord, WorkEventRecord, WorkState, WorkTaskRecord } from './work-store.js'

export type ObservabilitySloStatus = 'pass' | 'warn' | 'fail'

export interface ObservabilitySloBudget {
  id: 'scheduler_latency' | 'run_dispatch' | 'channel_delivery' | 'progress_freshness' | 'dashboard_render' | 'recovery_time'
  label: string
  thresholdMs: number
  warningMs: number
  description: string
}

export interface ObservabilitySloResult extends ObservabilitySloBudget {
  status: ObservabilitySloStatus
  observedMs?: number
  releaseBlocking: boolean
  summary: string
  recommendedAction: string
  evidence: string[]
}

export interface TraceCorrelationIndex {
  generatedAt: string
  traceRootId: string
  tasks: Array<{ taskId: string; traceId: string; status: WorkTaskRecord['status']; runTraceIds: string[] }>
  runs: Array<{ runId: string; traceId: string; taskTraceId?: string; taskId: string; stage: string; status: RunRecord['status']; sessionHash: string }>
  events: Array<{ eventId: number; traceId: string; type: string; subjectId?: string }>
  channels: Array<{ provider: string; targetHash: string; traceId: string; taskTraceId?: string }>
  evidence: Array<{ ref: string; traceId: string; runTraceId?: string }>
  alerts: Array<{ alertId: string; traceId: string; target?: string; severity: AlertRecord['severity']; status: AlertRecord['status'] }>
  auditLedger: Array<{ eventId: string; traceId: string; action: string; result: string; retentionClass: string; correlationId?: string; evidenceRefs: string[] }>
}

export type SupportOperationsStatus = 'ready' | 'degraded' | 'blocked'
export type SupportServiceMode = 'local_public_beta' | 'local_release_candidate' | 'self_hosted_preview' | 'team_preview' | 'hosted_deferred' | 'unsupported'
export type SupportSourceHealthStatus = 'ready' | 'empty' | 'degraded' | 'unavailable' | 'not_measured'
export type SupportOperatorActionId = 'pause' | 'resume' | 'retry' | 'rollback' | 'evidence_export' | 'incident_bundle'

export interface SupportServiceLevel {
  mode: SupportServiceMode
  label: string
  releaseStatus: 'supported' | 'preview' | 'deferred' | 'unsupported'
  sloClaim: string
  telemetryBoundary: string
  supportAccessBoundary: string
  incidentResponseBoundary: string
}

export interface SupportOperatorAction {
  id: SupportOperatorActionId
  label: string
  command: string
  httpRoute?: string
  auditOperation: string
  safeByDefault: boolean
  summary: string
}

export interface SupportSourceHealth {
  source: string
  status: SupportSourceHealthStatus
  summary: string
  evidenceRefs: string[]
  staleAfterMs?: number
}

export interface SupportTraceCoverage {
  scheduler: number
  workers: number
  channels: number
  evidence: number
  auditLedger: number
  alerts: number
}

export type SupportSignalStatus = 'pass' | 'attention' | 'blocked'
export type SupportSignalSeverity = 'info' | 'warning' | 'critical'

export interface SupportSignal {
  id: string
  status: SupportSignalStatus
  severity: SupportSignalSeverity
  source: string
  observedAt: string
  summary: string
  recommendedAction: string
  releaseBlocking: boolean
  evidenceRefs: string[]
}

export interface SupportOperationsContract {
  generatedAt: string
  status: SupportOperationsStatus
  releaseClaim: 'local_preview_support_observability_only'
  currentMode: SupportServiceMode
  serviceLevels: SupportServiceLevel[]
  sourceHealth: SupportSourceHealth[]
  supportSignals: SupportSignal[]
  traceCoverage: SupportTraceCoverage
  operatorActions: SupportOperatorAction[]
  incidentBundle: {
    status: 'redacted_local_supported'
    command: string
    manifest: string
    forbiddenContents: string[]
  }
  escalation: {
    pause: string
    retry: string
    rollback: string
    exportEvidence: string
  }
  unsupportedClaims: string[]
}

export interface ObservabilityCliSummary {
  traceRootId: string
  status: ObservabilitySloStatus
  pass: number
  warn: number
  fail: number
  line: string
}

export const OBSERVABILITY_SLO_BUDGETS: ObservabilitySloBudget[] = [
  { id: 'scheduler_latency', label: 'Scheduler latency', thresholdMs: 5 * 60_000, warningMs: 2 * 60_000, description: 'Oldest pending high/medium priority task should not wait indefinitely before dispatch or explicit blocking.' },
  { id: 'run_dispatch', label: 'Run dispatch', thresholdMs: 2 * 60_000, warningMs: 60_000, description: 'Time from task creation to first run start should remain bounded for runnable work.' },
  { id: 'channel_delivery', label: 'Channel delivery', thresholdMs: 5 * 60_000, warningMs: 2 * 60_000, description: 'Channel delivery failures should settle as sent, retry/backoff, or dead-letter within a bounded window.' },
  { id: 'progress_freshness', label: 'Progress freshness', thresholdMs: 15 * 60_000, warningMs: 10 * 60_000, description: 'Running work should have recent progress, lifecycle, or recovery events.' },
  { id: 'dashboard_render', label: 'Dashboard render', thresholdMs: 2_000, warningMs: 1_000, description: 'Mission Control should render within a local operator-friendly budget.' },
  { id: 'recovery_time', label: 'Recovery time', thresholdMs: 5 * 60_000, warningMs: 2 * 60_000, description: 'Expired lease or orphan recovery should be visible and bounded.' },
]

export function traceCorrelationId(kind: string, ...parts: Array<string | number | undefined>): string {
  return `trace_${kind}_${hashText(parts.filter(value => value !== undefined && value !== '').join(':')).slice(0, 16)}`
}

export function buildTraceCorrelationIndex(input: {
  state: WorkState
  events?: WorkEventRecord[]
  alerts?: AlertRecord[]
  channelBindings?: ChannelBindingRecord[]
  auditLedger?: AuditLedgerRecord[]
  generatedAt?: string
}): TraceCorrelationIndex {
  const generatedAt = input.generatedAt || new Date().toISOString()
  const events = input.events || []
  const alerts = input.alerts || []
  const channelBindings = input.channelBindings || []
  const auditLedger = input.auditLedger || []
  const runsByTask = new Map<string, RunRecord[]>()
  for (const run of input.state.runs) runsByTask.set(run.taskId, [...(runsByTask.get(run.taskId) || []), run])
  const taskTraceIds = new Map(input.state.tasks.map(task => [task.id, traceCorrelationId('task', task.id)]))
  const runTraceIds = new Map(input.state.runs.map(run => [run.id, traceCorrelationId('run', run.taskId, run.id, run.stage)]))

  return {
    generatedAt,
    traceRootId: traceCorrelationId('root', generatedAt, input.state.tasks.length, input.state.runs.length, events.length),
    tasks: input.state.tasks.map(task => ({
      taskId: task.id,
      traceId: taskTraceIds.get(task.id)!,
      status: task.status,
      runTraceIds: (runsByTask.get(task.id) || []).map(run => runTraceIds.get(run.id)!),
    })),
    runs: input.state.runs.map(run => ({
      runId: run.id,
      traceId: runTraceIds.get(run.id)!,
      taskTraceId: taskTraceIds.get(run.taskId),
      taskId: run.taskId,
      stage: run.stage,
      status: run.status,
      sessionHash: hashText(run.sessionId).slice(0, 12),
    })),
    events: events.map(event => ({
      eventId: event.id,
      traceId: traceCorrelationId('event', event.id, event.type, event.subjectId),
      type: event.type,
      subjectId: safeTraceSubjectId(event.subjectId),
    })),
    channels: channelBindings.map(binding => ({
      provider: binding.provider,
      targetHash: channelTargetFingerprint(binding.provider, binding.chatId, binding.threadId),
      traceId: traceCorrelationId('channel', binding.provider, channelTargetFingerprint(binding.provider, binding.chatId, binding.threadId)),
      taskTraceId: binding.taskId ? taskTraceIds.get(binding.taskId) : undefined,
    })),
    evidence: input.state.runs.flatMap(run => (run.result?.evidence || []).map(item => ({
      ref: safeTraceEvidenceRef(item.ref),
      traceId: traceCorrelationId('evidence', run.id, item.ref),
      runTraceId: runTraceIds.get(run.id),
    }))),
    alerts: alerts.map(alert => ({
      alertId: alert.id,
      traceId: traceCorrelationId('alert', alert.id, alert.key, alert.target),
      target: safeTraceSubjectId(alert.target),
      severity: alert.severity,
      status: alert.status,
    })),
    auditLedger: auditLedger.map(row => ({
      eventId: row.eventId,
      traceId: row.traceId || traceCorrelationId('audit', row.eventId, row.action),
      action: safeTraceSubjectId(row.action) || row.action,
      result: row.result,
      retentionClass: row.retentionClass,
      correlationId: safeTraceSubjectId(row.correlationId),
      evidenceRefs: (row.evidenceRefs || []).map(safeTraceEvidenceRef),
    })),
  }
}

export const SUPPORT_SERVICE_LEVELS: SupportServiceLevel[] = [
  {
    mode: 'local_public_beta',
    label: 'Local public beta',
    releaseStatus: 'supported',
    sloClaim: 'Local operator SLO budgets are best-effort readiness checks, not an external SLA.',
    telemetryBoundary: 'All metrics and traces are derived from local Gateway state and redacted artifacts.',
    supportAccessBoundary: 'The operator owns local access; support receives redacted bundles only.',
    incidentResponseBoundary: 'Local incident bundles and operator actions are supported.',
  },
  {
    mode: 'local_release_candidate',
    label: 'Local release candidate',
    releaseStatus: 'preview',
    sloClaim: 'RC SLO claims require elapsed soak evidence and final readiness decision.',
    telemetryBoundary: 'No hosted telemetry is implied.',
    supportAccessBoundary: 'Support access remains operator-mediated through redacted artifacts.',
    incidentResponseBoundary: 'Incident workflow is local and evidence-backed.',
  },
  {
    mode: 'self_hosted_preview',
    label: 'Self-hosted preview',
    releaseStatus: 'preview',
    sloClaim: 'Self-hosted SLOs require topology, backup, worker, and incident proof per deployment.',
    telemetryBoundary: 'Preview deployments must keep tenant/provider data local unless explicitly configured.',
    supportAccessBoundary: 'Support access requires a separate support principal and customer approval.',
    incidentResponseBoundary: 'Preview incident response uses exported redacted bundles.',
  },
  {
    mode: 'team_preview',
    label: 'Team preview',
    releaseStatus: 'preview',
    sloClaim: 'Team SLOs are bounded to tested team-preview surfaces only.',
    telemetryBoundary: 'Team data must remain scoped by tenant/org/project proof.',
    supportAccessBoundary: 'Support access needs audited role grants and tenant scope.',
    incidentResponseBoundary: 'Team incidents require tenant-scoped redacted bundles.',
  },
  {
    mode: 'hosted_deferred',
    label: 'Hosted',
    releaseStatus: 'deferred',
    sloClaim: 'Hosted SLO/SLA claims are unsupported until hosted telemetry, support, tenancy, and compliance work lands.',
    telemetryBoundary: 'No managed telemetry plane exists in this release.',
    supportAccessBoundary: 'No hosted support access path is implemented.',
    incidentResponseBoundary: 'Hosted incident response is deferred.',
  },
  {
    mode: 'unsupported',
    label: 'Unsupported modes',
    releaseStatus: 'unsupported',
    sloClaim: 'No support-grade claim is made for unsupported execution or channel modes.',
    telemetryBoundary: 'Unsupported modes must fail closed or be explicitly labeled.',
    supportAccessBoundary: 'Support cannot inspect unsupported mode state.',
    incidentResponseBoundary: 'Operators must fall back to local redacted evidence only.',
  },
]

export const SUPPORT_OPERATOR_ACTIONS: SupportOperatorAction[] = [
  { id: 'pause', label: 'Pause dispatch', command: 'opencode-gateway operator pause', httpRoute: 'POST /operator/actions action=pause', auditOperation: 'operator.pause', safeByDefault: true, summary: 'Stop new scheduler dispatch while current OpenCode sessions finish.' },
  { id: 'resume', label: 'Resume dispatch', command: 'opencode-gateway operator resume', httpRoute: 'POST /operator/actions action=resume', auditOperation: 'operator.resume', safeByDefault: true, summary: 'Resume scheduler dispatch after degraded state is understood.' },
  { id: 'retry', label: 'Recover and retry', command: 'opencode-gateway operator recover', httpRoute: 'POST /operator/actions action=recover', auditOperation: 'operator.recover', safeByDefault: true, summary: 'Recover expired leases and missing OpenCode runs using bounded retry policy.' },
  { id: 'rollback', label: 'Rollback state', command: 'opencode-gateway storage restore <backup> --maintenance-mode', httpRoute: 'POST /storage/restore', auditOperation: 'storage.restore', safeByDefault: false, summary: 'Restore a verified backup behind an audited destructive-action gate.' },
  { id: 'evidence_export', label: 'Export evidence', command: 'opencode-gateway evidence export <output-dir>', httpRoute: 'GET /evidence/export', auditOperation: 'evidence.export.redacted', safeByDefault: true, summary: 'Write a redacted local evidence bundle for support review.' },
  { id: 'incident_bundle', label: 'Create incident bundle', command: 'opencode-gateway evidence incident <output-dir>', httpRoute: 'GET /incident-bundle', auditOperation: 'incident.bundle.redacted', safeByDefault: true, summary: 'Write a redacted incident bundle with trace, SLO, alert, audit, and evidence context.' },
]

export function buildSupportOperationsContract(input: {
  generatedAt?: string
  trace?: TraceCorrelationIndex
  slo?: ObservabilitySloResult[]
  alerts?: AlertRecord[]
  currentMode?: SupportServiceMode
  sourceHealth?: SupportSourceHealth[]
} = {}): SupportOperationsContract {
  const generatedAt = input.generatedAt || new Date().toISOString()
  const trace = input.trace
  const slo = input.slo || []
  const alerts = input.alerts || []
  const sourceHealth = input.sourceHealth || defaultSupportSourceHealth(trace, slo, alerts)
  const supportSignals = buildSupportSignals({ generatedAt, slo, alerts, sourceHealth })
  const releaseBlockingSignals = supportSignals.filter(signal => signal.releaseBlocking)
  const attentionSignals = supportSignals.filter(signal => signal.status !== 'pass')
  const status: SupportOperationsStatus = releaseBlockingSignals.length
    ? 'blocked'
    : attentionSignals.length
      ? 'degraded'
      : 'ready'
  return {
    generatedAt,
    status,
    releaseClaim: 'local_preview_support_observability_only',
    currentMode: input.currentMode || 'local_public_beta',
    serviceLevels: SUPPORT_SERVICE_LEVELS,
    sourceHealth,
    supportSignals,
    traceCoverage: {
      scheduler: trace?.tasks.length || 0,
      workers: trace?.runs.length || 0,
      channels: trace?.channels.length || 0,
      evidence: trace?.evidence.length || 0,
      auditLedger: trace?.auditLedger.length || 0,
      alerts: trace?.alerts.length || 0,
    },
    operatorActions: SUPPORT_OPERATOR_ACTIONS,
    incidentBundle: {
      status: 'redacted_local_supported',
      command: 'opencode-gateway evidence incident <output-dir> [--alert id]',
      manifest: 'incident.json + incident.md + nested redacted evidence bundle',
      forbiddenContents: ['raw provider payloads', 'private transcripts', 'chat IDs', 'phone numbers', 'webhook URLs', 'bearer tokens', 'local private paths'],
    },
    escalation: {
      pause: 'Pause scheduler dispatch before inspecting broad queue, channel, or worker degradation.',
      retry: 'Use bounded recovery/retry for expired leases, missing OpenCode runs, and retryable channel failures.',
      rollback: 'Restore only verified backups behind an audited destructive-action gate.',
      exportEvidence: 'Share only redacted evidence or incident bundles unless a local admin intentionally exports unredacted data.',
    },
    unsupportedClaims: ['hosted SLO/SLA', 'managed support readiness', 'compliance monitoring certification', 'raw transcript telemetry', 'provider payload retention'],
  }
}

export function evaluateObservabilitySLOs(input: {
  state: WorkState
  events?: WorkEventRecord[]
  channelFailureCount?: number
  dashboardRenderMs?: number
  now?: number
}): ObservabilitySloResult[] {
  const now = input.now || Date.now()
  const events = input.events || []
  const budgets = Object.fromEntries(OBSERVABILITY_SLO_BUDGETS.map(row => [row.id, row])) as Record<ObservabilitySloBudget['id'], ObservabilitySloBudget>
  const liveWork = hasLiveWork(input.state)
  const channelFailures = Number(input.channelFailureCount || 0)
  return [
    evaluateBudget(budgets.scheduler_latency, oldestPendingAge(input.state.tasks, now), 'No pending work older than the scheduler latency budget.', 'oldest pending task age'),
    evaluateBudget(budgets.run_dispatch, activeDispatchMs(input.state), 'No active runnable work has dispatch latency evidence.', 'max active task-created to run-start latency'),
    evaluateBudget(
      budgets.channel_delivery,
      channelFailures ? budgets.channel_delivery.thresholdMs + 1 : 0,
      'No unsettled channel delivery failures observed.',
      'channel failure count',
      {
        statusOverride: channelFailures && !liveWork ? 'warn' : undefined,
        releaseBlocking: channelFailures ? liveWork : false,
        recommendedAction: channelFailures && !liveWork
          ? 'Keep the historical channel failure in support evidence, but do not block release readiness unless new work is actively waiting on delivery.'
          : undefined,
      },
    ),
    evaluateBudget(budgets.progress_freshness, progressFreshnessMs(input.state, events, now), 'Running work has recent lifecycle/progress evidence.', 'stale progress age'),
    evaluateBudget(budgets.dashboard_render, input.dashboardRenderMs, 'Dashboard render time not supplied by this local surface.', 'dashboard render time'),
    evaluateBudget(budgets.recovery_time, recoveryTimeMs(events, now), 'No stale recovery events outside the recovery budget.', 'oldest unresolved recovery event age'),
  ]
}

export function countChannelFailureEvents(events: WorkEventRecord[] = []): number {
  return events.filter(isChannelFailureEvent).length
}

export function isChannelFailureEvent(event: WorkEventRecord): boolean {
  const text = `${event.type} ${JSON.stringify(event.payload || {})}`
  return /channel|telegram|whatsapp|discord/i.test(text) && /fail|error|denied/i.test(text)
}

export function formatObservabilitySLOs(results: ObservabilitySloResult[]): string {
  return results.map(row => `[${row.status}] ${row.label}: ${row.summary}`).join('\n')
}

export function summarizeObservabilityForCli(trace: Pick<TraceCorrelationIndex, 'traceRootId'> | undefined, results: ObservabilitySloResult[] = []): ObservabilityCliSummary {
  const pass = results.filter(row => row.status === 'pass').length
  const warn = results.filter(row => row.status === 'warn').length
  const fail = results.filter(row => row.status === 'fail').length
  const status: ObservabilitySloStatus = fail ? 'fail' : warn ? 'warn' : 'pass'
  const traceRootId = trace?.traceRootId || 'trace_unavailable'
  return {
    traceRootId,
    status,
    pass,
    warn,
    fail,
    line: `Trace: ${traceRootId} | SLO: ${status} (${pass} pass, ${warn} warn, ${fail} fail)`,
  }
}

function evaluateBudget(
  budget: ObservabilitySloBudget,
  observedMs: number | undefined,
  emptySummary: string,
  evidenceLabel: string,
  options: { statusOverride?: ObservabilitySloStatus; releaseBlocking?: boolean; recommendedAction?: string } = {},
): ObservabilitySloResult {
  if (observedMs === undefined) {
    return {
      ...budget,
      status: options.statusOverride || 'warn',
      releaseBlocking: options.releaseBlocking ?? false,
      summary: emptySummary,
      recommendedAction: options.recommendedAction || `Collect ${budget.label.toLowerCase()} evidence before using this local readiness budget for release decisions.`,
      evidence: ['observedMs=missing'],
    }
  }
  const boundedObservedMs = Math.max(0, observedMs)
  const measuredStatus: ObservabilitySloStatus = boundedObservedMs > budget.thresholdMs ? 'fail' : boundedObservedMs > budget.warningMs ? 'warn' : 'pass'
  const status = options.statusOverride || measuredStatus
  return {
    ...budget,
    status,
    releaseBlocking: options.releaseBlocking ?? status === 'fail',
    observedMs: boundedObservedMs,
    summary: `${evidenceLabel} ${formatDuration(boundedObservedMs)} (warn ${formatDuration(budget.warningMs)}, fail ${formatDuration(budget.thresholdMs)})`,
    recommendedAction: options.recommendedAction || defaultSloRecommendedAction(budget, status),
    evidence: [`observedMs=${Math.round(boundedObservedMs)}`, `warningMs=${budget.warningMs}`, `thresholdMs=${budget.thresholdMs}`],
  }
}

function oldestPendingAge(tasks: WorkTaskRecord[], now: number): number {
  const ages = tasks
    .filter(task => task.status === 'pending' && !task.earliestStartAt)
    .map(task => now - Date.parse(task.createdAt))
    .filter(Number.isFinite)
  return ages.length ? Math.max(...ages) : 0
}

function activeDispatchMs(state: WorkState): number {
  const tasksById = new Map(state.tasks.map(task => [task.id, task]))
  const latencies = state.runs.filter(run => {
    const task = tasksById.get(run.taskId)
    return Boolean(task && (task.status === 'running' || run.status === 'running'))
  }).map(run => {
    const task = tasksById.get(run.taskId)
    return task ? Date.parse(run.startedAt) - Date.parse(task.createdAt) : 0
  }).filter(value => Number.isFinite(value) && value >= 0)
  return latencies.length ? Math.max(...latencies) : 0
}

function hasLiveWork(state: WorkState): boolean {
  return state.tasks.some(task => ['pending', 'running'].includes(task.status))
    || state.runs.some(run => run.status === 'running')
}

function progressFreshnessMs(state: WorkState, events: WorkEventRecord[], now: number): number {
  const runningTaskIds = new Set(state.tasks.filter(task => task.status === 'running').map(task => task.id))
  if (!runningTaskIds.size) return 0
  const latest = events
    .filter(event => runningTaskIds.has(String(event.subjectId || '')) || event.type.includes('progress') || event.type.startsWith('task.run'))
    .map(event => Date.parse(event.createdAt))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]
  if (!latest) {
    const oldestRun = state.runs.filter(run => run.status === 'running').map(run => Date.parse(run.startedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0]
    return oldestRun ? now - oldestRun : 0
  }
  return now - latest
}

function recoveryTimeMs(events: WorkEventRecord[], now: number): number {
  const recoveryEvents = events.filter(event => event.type.includes('recovered') || event.type.includes('lease_expired'))
  if (!recoveryEvents.length) return 0
  const oldest = recoveryEvents.map(event => Date.parse(event.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0]
  return oldest ? now - oldest : 0
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

function safeTraceSubjectId(value?: string): string | undefined {
  if (!value) return value
  if (/^ses[_A-Za-z0-9-]+/.test(value)) return `<redacted:session:${hashText(value).slice(0, 12)}>`
  return value
}

function safeTraceEvidenceRef(value: string): string {
  const text = String(value || '')
  if (/\/Users\/|\/private\/|\/var\/folders\/|\/tmp\//.test(text)) return `<redacted:evidence-ref:${hashText(text).slice(0, 12)}>`
  if (/\bHTTP\s+\d{3}\b/i.test(text) || /\b(Telegram|WhatsApp|Discord)\b.*\b(send|rich send|provider|delivery).*\b(failed|error)\b/i.test(text) || /"error_code"|"description"|"ok"\s*:/i.test(text)) {
    return `<redacted:provider-payload:${hashText(text).slice(0, 12)}>`
  }
  const providerTarget = /^(telegram|whatsapp|discord):([^:]+)(?::(.+))?$/i.exec(text)
  if (providerTarget) {
    const provider = providerTarget[1]!.toLowerCase()
    const thread = providerTarget[3]
    return thread
      ? `${provider}:<redacted:id>:<redacted:thread:${hashText(thread).slice(0, 12)}>`
      : `${provider}:<redacted:id>`
  }
  const redacted = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer <redacted>')
    .replace(/\b(token|secret|password|credential|api[_-]?key|webhook)[=:][^\s,;]+/gi, '$1=<redacted>')
    .replace(/\b\d{10,16}\b/g, '<redacted:id>')
    .replace(/\b(task|run)=([A-Za-z0-9_-]{8,})\b/g, '$1=<redacted:id>')
  return redacted.length > 180 ? `${redacted.slice(0, 177)}...` : redacted
}

function defaultSupportSourceHealth(trace: TraceCorrelationIndex | undefined, slo: ObservabilitySloResult[], alerts: AlertRecord[]): SupportSourceHealth[] {
  return [
    {
      source: 'trace_correlation',
      status: trace?.traceRootId ? 'ready' : 'unavailable',
      summary: trace?.traceRootId ? `Trace root ${trace.traceRootId} is available.` : 'Trace root unavailable.',
      evidenceRefs: trace?.traceRootId ? [`trace:${trace.traceRootId}`] : [],
    },
    {
      source: 'slo_budgets',
      status: slo.some(row => row.status === 'fail') ? 'degraded' : slo.length ? 'ready' : 'not_measured',
      summary: slo.length ? `${slo.length} local SLO budget(s) evaluated.` : 'SLO budgets were not evaluated.',
      evidenceRefs: slo.map(row => `slo:${row.id}:${row.status}`),
    },
    {
      source: 'audit_ledger',
      status: trace?.auditLedger.length ? 'ready' : 'empty',
      summary: trace?.auditLedger.length ? `${trace.auditLedger.length} audit ledger row(s) correlated.` : 'No audit ledger rows were selected for this snapshot.',
      evidenceRefs: (trace?.auditLedger || []).slice(0, 10).map(row => `audit:${row.eventId}`),
    },
    {
      source: 'channels',
      status: trace?.channels.length ? 'ready' : 'empty',
      summary: trace?.channels.length ? `${trace.channels.length} channel target(s) correlated with hashed targets.` : 'No channel targets were selected for this snapshot.',
      evidenceRefs: (trace?.channels || []).slice(0, 10).map(row => `channel:${row.provider}:${row.targetHash}`),
    },
    {
      source: 'alerts',
      status: alerts.some(alert => alert.severity === 'critical' && (alert.status === 'active' || alert.status === 'acknowledged')) ? 'degraded' : alerts.length ? 'ready' : 'empty',
      summary: alerts.length ? `${alerts.length} alert(s) included in the support snapshot.` : 'No active alerts selected.',
      evidenceRefs: alerts.slice(0, 10).map(alert => `alert:${alert.id}`),
    },
  ]
}

function buildSupportSignals(input: {
  generatedAt: string
  slo: ObservabilitySloResult[]
  alerts: AlertRecord[]
  sourceHealth: SupportSourceHealth[]
}): SupportSignal[] {
  const signals: SupportSignal[] = []
  for (const row of input.slo) {
    signals.push({
      id: `slo_${row.id}`,
      status: row.releaseBlocking ? 'blocked' : row.status === 'pass' ? 'pass' : 'attention',
      severity: row.releaseBlocking ? 'critical' : row.status === 'pass' ? 'info' : 'warning',
      source: `observability_slo.${row.id}`,
      observedAt: input.generatedAt,
      summary: row.summary,
      recommendedAction: row.recommendedAction,
      releaseBlocking: row.releaseBlocking,
      evidenceRefs: row.evidence.map(safeTraceEvidenceRef),
    })
  }
  for (const alert of input.alerts) {
    const active = alert.status === 'active' || alert.status === 'acknowledged'
    const releaseBlocking = active && alert.severity === 'critical'
    const safeSource = safeTraceSubjectId(alert.source) || 'unknown'
    signals.push({
      id: `alert_${hashText(`${alert.key}:${alert.id}`).slice(0, 12)}`,
      status: releaseBlocking ? 'blocked' : active ? 'attention' : 'pass',
      severity: releaseBlocking ? 'critical' : active ? 'warning' : 'info',
      source: `alert.${safeSource}`,
      observedAt: alert.lastSeenAt || alert.firstSeenAt || input.generatedAt,
      summary: `Alert ${safeSource} is ${alert.status} with ${alert.severity} severity.`,
      recommendedAction: releaseBlocking
        ? 'Resolve, suppress, or export a redacted incident bundle for the critical alert before advancing release readiness.'
        : 'Review the redacted alert context and resolve or suppress it before using support evidence.',
      releaseBlocking,
      evidenceRefs: [`alert:${alert.id}`, ...alert.evidence.map(safeTraceEvidenceRef)],
    })
  }
  for (const source of input.sourceHealth) {
    if (!['degraded', 'unavailable'].includes(source.status)) continue
    signals.push({
      id: `source_${hashText(source.source).slice(0, 12)}`,
      status: source.status === 'unavailable' ? 'blocked' : 'attention',
      severity: source.status === 'unavailable' ? 'critical' : 'warning',
      source: `support_source.${source.source}`,
      observedAt: input.generatedAt,
      summary: source.summary,
      recommendedAction: source.status === 'unavailable'
        ? 'Restore the unavailable support source or record an explicit release waiver before advancing readiness.'
        : 'Review the degraded source and keep it visible as support attention until repaired or waived.',
      releaseBlocking: source.status === 'unavailable',
      evidenceRefs: source.evidenceRefs.map(safeTraceEvidenceRef),
    })
  }
  return signals
}

function defaultSloRecommendedAction(budget: ObservabilitySloBudget, status: ObservabilitySloStatus): string {
  if (status === 'pass') return `No ${budget.label.toLowerCase()} action needed.`
  if (budget.id === 'scheduler_latency') return 'Inspect pending work, capacity, and dependency blockers before dispatching more agents.'
  if (budget.id === 'run_dispatch') return 'Inspect active task dispatch latency, recover stale leases, or pause dispatch before expanding work.'
  if (budget.id === 'channel_delivery') return 'Inspect channel delivery receipts, retry/backoff state, and trusted bindings before claiming channel delivery health.'
  if (budget.id === 'progress_freshness') return 'Inspect active work progress, recover missing session ownership, or mark blocked work explicitly.'
  if (budget.id === 'dashboard_render') return 'Capture Mission Control render timing in the same local environment before using dashboard performance as release evidence.'
  return 'Inspect unresolved recovery events and complete bounded recovery before claiming readiness.'
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
