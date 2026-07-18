import { buildSupportOperationsContract, buildTraceCorrelationIndex, countChannelFailureEvents, evaluateObservabilitySLOs, summarizeObservabilityForCli, type ObservabilityCliSummary, type ObservabilitySloResult, type SupportOperationsContract, type SupportSourceHealth, type TraceCorrelationIndex } from './observability-contract.js'
import {
  listAlerts,
  listAlertsReadOnly,
  listAuditLedgerEntries,
  listAuditLedgerEntriesReadOnly,
  listChannelBindings,
  listChannelBindingsReadOnly,
  listWorkEvents,
  listWorkEventsReadOnly,
  emptyWorkState,
  loadWorkState,
  loadWorkStateReadOnly,
  type AlertRecord,
  type AuditLedgerRecord,
  type ChannelBindingRecord,
  type WorkEventRecord,
  type WorkState,
} from './work-store.js'

export interface ObservabilitySnapshotOptions {
  filePath?: string
  state?: WorkState
  events?: WorkEventRecord[]
  alertId?: string
  alerts?: AlertRecord[]
  channelBindings?: ChannelBindingRecord[]
  auditLedger?: AuditLedgerRecord[]
  alertLimit?: number
  eventLimit?: number
  auditLedgerLimit?: number
  generatedAt?: string
  now?: number
  dashboardRenderMs?: number
  readOnly?: boolean
}

export interface ObservabilitySnapshot {
  generatedAt: string
  state: WorkState
  events: WorkEventRecord[]
  alerts: AlertRecord[]
  channelBindings: ChannelBindingRecord[]
  auditLedger: AuditLedgerRecord[]
  trace: TraceCorrelationIndex
  slo: ObservabilitySloResult[]
  support: SupportOperationsContract
}

export interface ObservabilityEvidencePlaneFailedRunClassification {
  runId: string
  taskId: string
  traceId: string
  status: string
  failureClass: string
  summary: string
  safeNextAction: string
  evidenceRefs: string[]
}

export interface ObservabilityEvidencePlaneSurfaceAgreement {
  httpObservability: {
    route: 'GET /observability'
    traceRootId: string
    supportStatus: SupportOperationsContract['status']
    sloStatus: ObservabilityCliSummary['status']
  }
  cliStatus: ObservabilityCliSummary
  readiness: {
    checkName: 'support_observability'
    status: 'pass' | 'warn' | 'fail'
    summary: string
    traceRootId: string
  }
  missionControl: {
    sourceVocabulary: 'mission_control_source_contracts'
    state: 'ready' | 'degraded' | 'blocked'
    traceRootId: string
    nextAction: string
  }
  incidentBundle: {
    status: SupportOperationsContract['incidentBundle']['status']
    command: string
    forbiddenContents: string[]
  }
}

export interface ObservabilityEvidencePlaneReport {
  schemaVersion: 1
  mode: 'm49_observability_slo_incident_support_plane'
  generatedAt: string
  status: 'pass' | 'fail'
  releaseClaimEffect: 'local_observability_support_evidence_only'
  summary: string
  fixtureMode: boolean
  surfaceAgreement: ObservabilityEvidencePlaneSurfaceAgreement
  trace: {
    traceRootId: string
    tasks: number
    runs: number
    events: number
    channels: number
    evidenceRefs: number
    alerts: number
    auditLedger: number
    representativeRefs: string[]
  }
  localSloBudgets: Array<Pick<ObservabilitySloResult, 'id' | 'status' | 'warningMs' | 'thresholdMs' | 'observedMs' | 'releaseBlocking' | 'summary' | 'recommendedAction'>>
  sourceFreshness: Array<SupportSourceHealth & { safeNextAction: string }>
  failedRunClassifications: ObservabilityEvidencePlaneFailedRunClassification[]
  supportSignals: SupportOperationsContract['supportSignals']
  redaction: {
    checked: true
    forbiddenPatterns: string[]
    sampleSafe: boolean
  }
  unsupportedClaims: string[]
  acceptance: {
    representativeTraceCorrelates: boolean
    cliReadinessAndHttpShareSnapshot: boolean
    incidentBundleRedactedAndParseable: boolean
    localSloBudgetReportExists: boolean
    degradedSourcesHaveSafeNextActions: boolean
    failedRunsClassified: boolean
    evidenceRefsAreWindowedAndRedacted: boolean
    noRawProviderTargetsOrPrivatePaths: boolean
    noProductionSloOrManagedSupportClaim: boolean
  }
  errors: string[]
}

export interface ObservabilityEvidencePlaneOptions {
  filePath?: string
  generatedAt?: string
  fixture?: boolean
  readOnly?: boolean
  sources?: Partial<Pick<ObservabilitySnapshotOptions, 'state' | 'events' | 'alerts' | 'channelBindings' | 'auditLedger'>>
}

const SENSITIVE_TEXT_PATTERN = /(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/)[^\s'",)]+|Bearer\s+[A-Za-z0-9._-]{8,}|(?:token|secret)[=:]\s*[A-Za-z0-9._-]{8,}|(?:telegram|whatsapp|discord):(?!<redacted:id>)[^\s'",)]+/i
const SENSITIVE_TEXT_REPLACE_PATTERN = /(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/)[^\s'",)]+|Bearer\s+[A-Za-z0-9._-]{8,}|(?:token|secret)[=:]\s*[A-Za-z0-9._-]{8,}|(?:telegram|whatsapp|discord):(?!<redacted:id>)[^\s'",)]+/gi

export function buildObservabilitySnapshot(options: ObservabilitySnapshotOptions = {}): ObservabilitySnapshot {
  const generatedAt = options.generatedAt || new Date().toISOString()
  const readOnly = Boolean(options.readOnly)
  // Trace correlation and SLO evaluation reason over the full run history, so
  // this on-demand snapshot explicitly asks for every run (never the bounded
  // live window) and stays correct even if the default read is later windowed.
  const state = options.state || (readOnly ? readOnlyOr(() => loadWorkStateReadOnly(options.filePath, { runsScope: 'all' }), emptyWorkState()) : loadWorkState(options.filePath, { runsScope: 'all' }))
  const events = options.events || (readOnly
    ? readOnlyOr(() => listWorkEventsReadOnly(options.eventLimit ?? 300, options.filePath), [])
    : listWorkEvents(options.eventLimit ?? 300, options.filePath))
  const alerts = options.alerts || (
    options.alertId
      ? (readOnly ? readOnlyOr(() => listAlertsReadOnly({}, options.filePath), []) : listAlerts({}, options.filePath)).filter(alert => alert.id === options.alertId)
      : (readOnly ? readOnlyOr(() => listAlertsReadOnly({ status: 'open' }, options.filePath), []) : listAlerts({ status: 'open' }, options.filePath)).slice(0, options.alertLimit)
  )
  const channelBindings = options.channelBindings || (readOnly
    ? readOnlyOr(() => listChannelBindingsReadOnly({}, options.filePath), [])
    : listChannelBindings({}, options.filePath))
  const auditLedger = options.auditLedger || (readOnly
    ? readOnlyOr(() => listAuditLedgerEntriesReadOnly({ limit: options.auditLedgerLimit ?? 100 }, options.filePath), [])
    : listAuditLedgerEntries({ limit: options.auditLedgerLimit ?? 100 }, options.filePath))
  const trace = buildTraceCorrelationIndex({ state, events, alerts, channelBindings, auditLedger, generatedAt })
  const slo = evaluateObservabilitySLOs({
    state,
    events,
    channelFailureCount: countChannelFailureEvents(events),
    dashboardRenderMs: options.dashboardRenderMs,
    now: options.now ?? Date.parse(generatedAt),
  })
  const support = buildSupportOperationsContract({ generatedAt, trace, slo, alerts })
  return { generatedAt, state, events, alerts, channelBindings, auditLedger, trace, slo, support }
}

export function buildObservabilityEvidencePlaneReport(options: ObservabilityEvidencePlaneOptions = {}): ObservabilityEvidencePlaneReport {
  const generatedAt = options.generatedAt || new Date().toISOString()
  const fixtureSources = options.fixture === false ? undefined : buildObservabilityEvidencePlaneFixtureSources(generatedAt)
  const sources = options.sources || fixtureSources
  const snapshot = buildObservabilitySnapshot({
    filePath: options.filePath,
    generatedAt,
    now: Date.parse(generatedAt),
    readOnly: options.readOnly ?? true,
    dashboardRenderMs: 850,
    ...(sources || {}),
  })
  const cliStatus = summarizeObservabilityForCli(snapshot.trace, snapshot.slo)
  const readinessStatus = snapshot.support.status === 'blocked' ? 'fail' : snapshot.support.status === 'degraded' ? 'warn' : 'pass'
  const surfaceAgreement: ObservabilityEvidencePlaneSurfaceAgreement = {
    httpObservability: {
      route: 'GET /observability',
      traceRootId: snapshot.trace.traceRootId,
      supportStatus: snapshot.support.status,
      sloStatus: cliStatus.status,
    },
    cliStatus,
    readiness: {
      checkName: 'support_observability',
      status: readinessStatus,
      summary: `Support observability is ${snapshot.support.status}; trace root ${snapshot.trace.traceRootId}`,
      traceRootId: snapshot.trace.traceRootId,
    },
    missionControl: {
      sourceVocabulary: 'mission_control_source_contracts',
      state: snapshot.support.status === 'blocked' ? 'blocked' : snapshot.support.status === 'degraded' ? 'degraded' : 'ready',
      traceRootId: snapshot.trace.traceRootId,
      nextAction: snapshot.support.status === 'ready'
        ? 'Continue monitoring from Mission Control, CLI status, or a redacted incident bundle.'
        : 'Open the support observability details, then pause/recover/export evidence using the surfaced operator action.',
    },
    incidentBundle: {
      status: snapshot.support.incidentBundle.status,
      command: snapshot.support.incidentBundle.command,
      forbiddenContents: snapshot.support.incidentBundle.forbiddenContents,
    },
  }
  const failedRunClassifications = classifyFailedRuns(snapshot)
  const sourceFreshness = snapshot.support.sourceHealth.map(source => ({
    ...source,
    evidenceRefs: source.evidenceRefs.map(redactSupportEvidenceRef),
    safeNextAction: safeNextActionForSupportSource(source.status),
  }))
  const localSloBudgets = snapshot.slo.map(row => ({
    id: row.id,
    status: row.status,
    warningMs: row.warningMs,
    thresholdMs: row.thresholdMs,
    observedMs: row.observedMs,
    releaseBlocking: row.releaseBlocking,
    summary: row.summary,
    recommendedAction: row.recommendedAction,
  }))
  const representativeRefs = [
    snapshot.trace.tasks[0]?.traceId,
    snapshot.trace.runs[0]?.traceId,
    snapshot.trace.channels[0]?.traceId,
    snapshot.trace.evidence[0]?.ref,
    snapshot.trace.alerts[0]?.traceId,
    snapshot.trace.auditLedger[0]?.traceId,
  ].filter(Boolean) as string[]
  const traceSummary = {
    traceRootId: snapshot.trace.traceRootId,
    tasks: snapshot.trace.tasks.length,
    runs: snapshot.trace.runs.length,
    events: snapshot.trace.events.length,
    channels: snapshot.trace.channels.length,
    evidenceRefs: snapshot.trace.evidence.length,
    alerts: snapshot.trace.alerts.length,
    auditLedger: snapshot.trace.auditLedger.length,
    representativeRefs,
  }
  const forbiddenPatterns = [
    'local private path literals',
    'bearer token literals',
    'private transcript markers',
    'raw provider payload markers',
    'raw Telegram target fixture',
    'raw WhatsApp phone fixture',
    'secret-like fixture values',
  ]
  const sample = JSON.stringify({ surfaceAgreement, trace: traceSummary, localSloBudgets, sourceFreshness, failedRunClassifications, supportSignals: snapshot.support.supportSignals })
  const redactionSampleSafe = !containsSensitiveText(sample)
  const acceptance = {
    representativeTraceCorrelates: Boolean(snapshot.trace.tasks.length && snapshot.trace.runs.length && snapshot.trace.channels.length && snapshot.trace.evidence.length && snapshot.trace.auditLedger.length),
    cliReadinessAndHttpShareSnapshot: surfaceAgreement.httpObservability.traceRootId === cliStatus.traceRootId
      && surfaceAgreement.readiness.traceRootId === cliStatus.traceRootId
      && surfaceAgreement.missionControl.traceRootId === cliStatus.traceRootId,
    incidentBundleRedactedAndParseable: snapshot.support.incidentBundle.status === 'redacted_local_supported'
      && ['raw provider payloads', 'private transcripts', 'chat IDs', 'bearer tokens', 'local private paths'].every(item => snapshot.support.incidentBundle.forbiddenContents.includes(item)),
    localSloBudgetReportExists: localSloBudgets.length === 6 && localSloBudgets.every(row => row.warningMs > 0 && row.thresholdMs >= row.warningMs),
    degradedSourcesHaveSafeNextActions: sourceFreshness.every(source => source.status === 'ready' || source.status === 'empty' || source.safeNextAction.length > 0),
    failedRunsClassified: failedRunClassifications.length > 0 && failedRunClassifications.every(row => row.safeNextAction.length > 0 && row.summary.length > 0 && !containsSensitiveText(row.summary) && row.evidenceRefs.every(ref => !containsSensitiveText(ref))),
    evidenceRefsAreWindowedAndRedacted: representativeRefs.length >= 4 && representativeRefs.every(ref => ref.length <= 220),
    noRawProviderTargetsOrPrivatePaths: redactionSampleSafe,
    noProductionSloOrManagedSupportClaim: snapshot.support.unsupportedClaims.includes('hosted SLO/SLA')
      && snapshot.support.unsupportedClaims.includes('managed support readiness'),
  }
  const errors = Object.entries(acceptance)
    .filter(([, passed]) => !passed)
    .map(([key]) => `acceptance_failed:${key}`)
  return {
    schemaVersion: 1,
    mode: 'm49_observability_slo_incident_support_plane',
    generatedAt,
    status: errors.length ? 'fail' : 'pass',
    releaseClaimEffect: 'local_observability_support_evidence_only',
    summary: errors.length
      ? 'Local observability evidence plane has unresolved acceptance failures.'
      : 'Local observability evidence plane correlates trace, SLO, source freshness, incident/support, CLI, readiness, and Mission Control surfaces from one snapshot.',
    fixtureMode: Boolean(fixtureSources && !options.sources),
    surfaceAgreement,
    trace: traceSummary,
    localSloBudgets,
    sourceFreshness,
    failedRunClassifications,
    supportSignals: snapshot.support.supportSignals,
    redaction: { checked: true, forbiddenPatterns, sampleSafe: redactionSampleSafe },
    unsupportedClaims: snapshot.support.unsupportedClaims,
    acceptance,
    errors,
  }
}

function readOnlyOr<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function buildObservabilityEvidencePlaneFixtureSources(generatedAt: string): Pick<ObservabilitySnapshotOptions, 'state' | 'events' | 'alerts' | 'channelBindings' | 'auditLedger'> {
  const now = Date.parse(generatedAt)
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
  const state = emptyWorkState()
  state.tasks = [
    {
      id: 'task_m49_trace',
      roadmapId: 'roadmap_m49_observability',
      title: 'observability trace fixture',
      description: 'Representative local task for trace correlation proof.',
      status: 'running',
      priority: 'HIGH',
      agent: 'gateway-planner',
      pipeline: ['plan', 'verify'],
      currentStage: 'verify',
      currentRunId: 'run_m49_trace',
      attempts: { verify: 1 },
      createdAt: iso(-90_000),
      updatedAt: iso(-30_000),
    },
    {
      id: 'task_m49_failed',
      roadmapId: 'roadmap_m49_observability',
      title: 'failed run classification fixture',
      description: 'Representative failed run for incident triage proof.',
      status: 'blocked',
      priority: 'MEDIUM',
      agent: 'gateway-verifier',
      pipeline: ['verify'],
      currentStage: 'verify',
      currentRunId: 'run_m49_failed',
      attempts: { verify: 2 },
      note: 'Blocked by redacted provider delivery evidence.',
      createdAt: iso(-600_000),
      updatedAt: iso(-60_000),
    },
  ]
  state.runs = [
    {
      id: 'run_m49_trace',
      taskId: 'task_m49_trace',
      stage: 'verify',
      sessionId: 'ses_m49_private_trace',
      profile: 'gateway-verifier',
      status: 'running',
      attempt: 1,
      startedAt: iso(-60_000),
      leaseOwner: 'scheduler-main',
      leaseExpiresAt: iso(120_000),
      result: {
        status: 'unknown',
        summary: 'Running observability fixture.',
        artifacts: [],
        evidence: [{ type: 'file', ref: 'file:m49-observability-fixture.md', summary: 'Safe local fixture evidence.' }],
        raw: '',
      },
    },
    {
      id: 'run_m49_failed',
      taskId: 'task_m49_failed',
      stage: 'verify',
      sessionId: 'ses_m49_private_failed',
      profile: 'gateway-verifier',
      status: 'failed',
      attempt: 2,
      startedAt: iso(-500_000),
      completedAt: iso(-90_000),
      result: {
        status: 'fail',
        failureClass: 'verification_failed',
        summary: 'Provider delivery failed with redacted evidence.',
        artifacts: [],
        evidence: [
          { type: 'log', ref: 'telegram:fixture-chat-private:private-topic', summary: 'Provider target must be redacted.' },
          { type: 'file', ref: '/private/support-notes.md', summary: 'Local path must be redacted.' },
        ],
        raw: 'redacted fixture',
      },
    },
  ]
  return {
    state,
    events: [
      { id: 1001, type: 'task.run.started', subjectId: 'task_m49_trace', payload: { runId: 'run_m49_trace' }, createdAt: iso(-60_000) } as WorkEventRecord,
      { id: 1002, type: 'delegation.progress.notified', subjectId: 'task_m49_trace', payload: { status: 'sent' }, createdAt: iso(-20_000) } as WorkEventRecord,
      { id: 1003, type: 'channel.delivery.failed', subjectId: 'task_m49_failed', payload: { provider: 'telegram', error: 'HTTP 400 redacted' }, createdAt: iso(-80_000) } as WorkEventRecord,
      { id: 1004, type: 'task.run.failed', subjectId: 'task_m49_failed', payload: { runId: 'run_m49_failed', failureClass: 'verification_failed' }, createdAt: iso(-75_000) } as WorkEventRecord,
    ],
    alerts: [{
      id: 'alert_m49_channel_delivery',
      key: 'channel.delivery.failed',
      severity: 'warning',
      status: 'active',
      source: 'channels',
      target: 'task_m49_failed',
      summary: 'Channel delivery degraded for observability fixture.',
      nextAction: 'Inspect redacted channel receipts and retry only after trust/binding status is healthy.',
      evidence: ['telegram:fixture-chat-private:private-topic', '/private/support-notes.md'],
      firstSeenAt: iso(-80_000),
      lastSeenAt: iso(-75_000),
      dedupeCount: 1,
      details: {},
    } as AlertRecord],
    channelBindings: [{
      provider: 'telegram',
      chatId: 'fixture-chat-private',
      threadId: 'private-topic',
      sessionId: 'ses_m49_private_trace',
      taskId: 'task_m49_trace',
      mode: 'task',
      createdAt: iso(-120_000),
      updatedAt: iso(-20_000),
    } as ChannelBindingRecord],
    auditLedger: [{
      eventId: 'audit_m49_pause',
      sourceEventId: 1004,
      sourceEventType: 'task.run.failed',
      traceId: 'trace_audit_m49_pause',
      action: 'operator.pause',
      result: 'ok',
      occurredAt: iso(-70_000),
      retentionClass: 'security_audit',
      correlationId: 'ses_m49_private_failed',
      evidenceRefs: ['telegram:fixture-chat-private:private-topic', '/private/support-notes.md'],
      entryHash: 'hash_m49_pause',
    } as AuditLedgerRecord],
  }
}

function classifyFailedRuns(snapshot: ObservabilitySnapshot): ObservabilityEvidencePlaneFailedRunClassification[] {
  const traceByRun = new Map(snapshot.trace.runs.map(row => [row.runId, row.traceId]))
  return snapshot.state.runs
    .filter(run => ['failed', 'blocked', 'errored'].includes(run.status))
    .map(run => ({
      runId: run.id,
      taskId: run.taskId,
      traceId: traceByRun.get(run.id) || '',
      status: run.status,
      failureClass: run.result?.failureClass || (run.status === 'blocked' ? 'blocked' : 'implementation_failed'),
      summary: redactSensitiveText(run.result?.summary || `${run.stage} ended ${run.status}.`),
      safeNextAction: failedRunNextAction(run.result?.failureClass || run.status),
      evidenceRefs: (run.result?.evidence || []).map(item => item.ref).map(redactEvidenceRef),
    }))
}

function failedRunNextAction(failureClass: string): string {
  if (failureClass === 'needs_credentials') return 'Open the credential gate and retry only after the scoped secret reference is available.'
  if (failureClass === 'blocked') return 'Resolve the named blocker or record an explicit waiver before retrying.'
  if (failureClass === 'verification_failed') return 'Inspect the trace and evidence refs, then rerun verification after the fix is committed.'
  return 'Inspect the correlated trace, recover stale ownership if needed, then retry through the scheduler.'
}

function safeNextActionForSupportSource(status: SupportSourceHealth['status']): string {
  if (status === 'ready') return 'No action required.'
  if (status === 'empty') return 'Continue; this source has no selected rows for the current local snapshot.'
  if (status === 'not_measured') return 'Collect this source before using the evidence for release or support decisions.'
  if (status === 'unavailable') return 'Restore the unavailable source or record an explicit bounded waiver.'
  return 'Inspect this degraded source and repair or accept it before making readiness claims.'
}

function redactEvidenceRef(value: string): string {
  if (/\/Users\/|\/private\/|\/var\/folders\/|\/tmp\//.test(value)) return '<redacted:evidence-ref>'
  const providerTarget = /^(telegram|whatsapp|discord):([^:]+)(?::(.+))?$/i.exec(value)
  if (providerTarget) return `${providerTarget[1]!.toLowerCase()}:<redacted:id>${providerTarget[3] ? ':<redacted:thread>' : ''}`
  return value
}

function redactSupportEvidenceRef(value: string): string {
  const channelTarget = /^channel:(telegram|whatsapp|discord):(.+)$/i.exec(value)
  if (channelTarget) return `channel:${channelTarget[1]!.toLowerCase()}:<redacted:id>`
  return redactEvidenceRef(value)
}

function containsSensitiveText(value: string): boolean {
  return SENSITIVE_TEXT_PATTERN.test(value)
}

function redactSensitiveText(value: string): string {
  return value.replace(SENSITIVE_TEXT_REPLACE_PATTERN, match => {
    if (/^(telegram|whatsapp|discord):/i.test(match)) return `${match.split(':')[0]!.toLowerCase()}:<redacted:id>`
    if (/^Bearer\s+/i.test(match)) return 'Bearer <redacted:token>'
    if (/^(token|secret)[=:]/i.test(match)) return '<redacted:secret>'
    return '<redacted:path>'
  })
}
