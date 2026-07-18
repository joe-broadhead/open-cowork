import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { generateIncidentReport } from './alerts.js'
import { getConfig, getConfigDir, type GatewayConfig } from './config.js'
import { buildEvidenceBundle, writeEvidenceBundle, type EvidenceExportTarget } from './evidence-export.js'
import { buildEvidencePipelineV2, type EvidencePipelineV2Report } from './evidence-contract.js'
import { formatObservabilitySLOs, type ObservabilitySloResult, type SupportOperationsContract, type TraceCorrelationIndex } from './observability-contract.js'
import { buildObservabilitySnapshot } from './observability-snapshot.js'
import { replacePhoneLikeText, replacePrivateText, replaceProviderTargetText, replaceSessionIdText } from './operational-redaction.js'
import { redactSensitiveText } from './security.js'
import { listAuditLedgerEntries, type AlertRecord, type AuditLedgerQueryOptions, type AuditLedgerRecord } from './work-store.js'

export interface IncidentBundleOptions {
  alertId?: string
  target?: EvidenceExportTarget
  filePath?: string
  rootDir?: string
  stateDir?: string
  config?: GatewayConfig
  now?: Date
  auditLedger?: AuditLedgerQueryOptions
}

export interface IncidentBundleAuditLedgerRow {
  eventId: string
  sourceEventId?: number
  sourceEventType?: string
  class: string
  action: string
  result: string
  occurredAt: string
  traceId: string
  correlationId?: string
  retentionClass: string
  evidenceRefs: string[]
  previousHash?: string
  entryHash: string
}

export type IncidentBundleSourceStatus = 'green' | 'degraded' | 'stale' | 'blocked' | 'unknown'
export type IncidentBundleFailureSeverity = 'info' | 'warning' | 'critical'
export type IncidentBundleWindowScope = 'complete' | 'selected'

export const INCIDENT_BUNDLE_REDACTION_TRANSFORMATIONS = [
  'raw channel targets are fingerprinted',
  'session IDs are hashed',
  'local private paths are replaced with path hashes',
  'token-like and key-like values are redacted',
  'private transcript text markers are redacted',
  'phone-like identifiers are fingerprinted',
] as const

export interface IncidentBundleSourceFreshness {
  source: string
  status: IncidentBundleSourceStatus
  observedAt: string
  ageMs: number
  staleAfterMs?: number
  summary: string
  nextAction: string
  evidenceRefs: string[]
}

export interface IncidentBundleFailureClassification {
  code: string
  severity: IncidentBundleFailureSeverity
  source: string
  summary: string
  nextAction: string
  traceId?: string
  evidenceRefs: string[]
}

export interface IncidentBundleWindow {
  total: number
  shown: number
  omitted: number
  limit: number
  scope: IncidentBundleWindowScope
  sourceLimit?: number
}

export interface IncidentBundleManifest {
  schemaVersion: 1
  id: string
  generatedAt: string
  status: 'ok' | 'degraded' | 'blocked'
  target: EvidenceExportTarget
  alertId?: string
  evidenceBundleId: string
  traceRootId: string
  counts: {
    alerts: number
    tasks: number
    runs: number
    events: number
    channels: number
    auditLedger: number
  }
  slo: ObservabilitySloResult[]
  support: SupportOperationsContract
  alerts: Array<{ id: string; severity: AlertRecord['severity']; status: AlertRecord['status']; traceId: string; summary: string; nextAction: string }>
  sourceFreshness: IncidentBundleSourceFreshness[]
  failureClassification: IncidentBundleFailureClassification[]
  windows: {
    traceTasks: IncidentBundleWindow
    traceRuns: IncidentBundleWindow
    auditLedger: IncidentBundleWindow
  }
  auditLedger: IncidentBundleAuditLedgerRow[]
  redaction: {
    enabled: true
    note: string
    forbiddenContents: string[]
    transformations: string[]
  }
  pipeline: EvidencePipelineV2Report
  manifestHash: string
}

export interface IncidentBundle {
  manifest: IncidentBundleManifest
  markdown: string
  evidence: ReturnType<typeof buildEvidenceBundle>
  trace: TraceCorrelationIndex
}

export function buildIncidentBundle(options: IncidentBundleOptions = {}): IncidentBundle {
  const config = options.config || getConfig()
  const stateDir = path.resolve(options.stateDir || process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir())
  const rootDir = path.resolve(options.rootDir || process.cwd())
  const generatedAt = (options.now || new Date()).toISOString()
  const snapshot = buildObservabilitySnapshot({ filePath: options.filePath, alertId: options.alertId, alertLimit: 20, eventLimit: 300, generatedAt, now: Date.parse(generatedAt) })
  const alerts = snapshot.alerts
  const evidence = buildEvidenceBundle({
    target: options.target || targetFromAlert(alerts[0]),
    filePath: options.filePath,
    rootDir,
    stateDir,
    config,
    now: options.now,
    eventLimit: 300,
  })
  const trace = snapshot.trace
  const slo = snapshot.slo
  const auditLedgerLimit = normalizedAuditLedgerLimit(options.auditLedger?.limit)
  const auditLedger = listAuditLedgerEntries({ ...(options.auditLedger || {}), limit: auditLedgerLimit }, options.filePath).map(compactAuditLedgerRow)
  const alertTrace = new Map(trace.alerts.map(row => [row.alertId, row.traceId]))
  const sourceFreshness = buildIncidentSourceFreshness(snapshot, generatedAt, config)
  const failureClassification = classifyIncidentFailures(alerts, slo, snapshot.support, trace, alertTrace, config)
  const windows = {
    traceTasks: windowCount(trace.tasks.length, 10, 'complete'),
    traceRuns: windowCount(trace.runs.length, 10, 'complete'),
    auditLedger: windowCount(auditLedger.length, 20, 'selected', auditLedgerLimit),
  }
  const status = alerts.some(alert => alert.severity === 'critical') || slo.some(row => row.status === 'fail') || sourceFreshness.some(row => row.status === 'blocked')
    ? 'blocked'
    : alerts.length || slo.some(row => row.status === 'warn') || sourceFreshness.some(row => row.status === 'degraded' || row.status === 'stale')
      ? 'degraded'
      : 'ok'
  const pipeline = buildEvidencePipelineV2({
    surface: 'incident_bundle',
    contracts: [evidence.manifest.evidenceContract],
    generatedAt,
    decision: {
      state: status === 'blocked' ? 'decision_blocked' : 'no_decision',
      claimChange: status === 'blocked' ? 'blocked' : 'no_release_claim_expansion',
      claimEffect: 'local_evidence_integrity_only',
      summary: status === 'blocked'
        ? 'Incident bundle is blocked for readiness claims while still share-safe for local support.'
        : 'Incident bundle is share-safe local support evidence only.',
      safeNextAction: status === 'blocked'
        ? 'Resolve incident blockers and regenerate bundle before using it for release decisions.'
        : 'Share only the redacted incident bundle inside the local-beta support boundary.',
      evidenceRefs: [`evidence:${evidence.manifest.id}`, `trace:${trace.traceRootId}`],
    },
  })
  const id = `incident_${timestampId(generatedAt)}_${hashText([options.alertId || '', evidence.manifest.id, trace.traceRootId].join(':')).slice(0, 12)}`
  const manifest: IncidentBundleManifest = {
    schemaVersion: 1,
    id,
    generatedAt,
    status,
    target: evidence.manifest.target,
    alertId: options.alertId,
    evidenceBundleId: evidence.manifest.id,
    traceRootId: trace.traceRootId,
    counts: {
      alerts: alerts.length,
      tasks: trace.tasks.length,
      runs: trace.runs.length,
      events: trace.events.length,
      channels: trace.channels.length,
      auditLedger: auditLedger.length,
    },
    slo,
    support: snapshot.support,
    alerts: alerts.map(alert => ({
      id: alert.id,
      severity: alert.severity,
      status: alert.status,
      traceId: alertTrace.get(alert.id) || '',
      summary: safeIncidentText(alert.summary, config),
      nextAction: safeIncidentText(alert.nextAction, config),
    })),
    sourceFreshness,
    failureClassification,
    windows,
    auditLedger,
    redaction: {
      enabled: true,
      note: 'Incident bundles are local redacted artifacts. Use evidence export with explicit local-admin intent for unredacted debugging only.',
      forbiddenContents: snapshot.support.incidentBundle.forbiddenContents,
      transformations: [...INCIDENT_BUNDLE_REDACTION_TRANSFORMATIONS],
    },
    pipeline,
    manifestHash: '',
  }
  manifest.manifestHash = hashText(JSON.stringify({ ...manifest, manifestHash: undefined }))
  return { manifest, markdown: formatIncidentBundleMarkdown(manifest, trace, safeIncidentText(generateIncidentReport(options.alertId), config)), evidence, trace }
}

export function writeIncidentBundle(bundle: IncidentBundle, outputDir = defaultIncidentBundleDir(bundle.manifest.id)): { directory: string; manifestPath: string; markdownPath: string; evidenceDir: string } {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const manifestPath = path.join(outputDir, 'incident.json')
  const markdownPath = path.join(outputDir, 'incident.md')
  const evidenceDir = path.join(outputDir, 'evidence')
  fs.writeFileSync(manifestPath, `${JSON.stringify(bundle.manifest, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(markdownPath, `${bundle.markdown}\n`, { mode: 0o600 })
  writeEvidenceBundle(bundle.evidence, evidenceDir)
  return { directory: outputDir, manifestPath, markdownPath, evidenceDir }
}

export function defaultIncidentBundleDir(bundleId: string): string {
  return path.join(process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir(), 'incident-bundles', bundleId)
}

function buildIncidentSourceFreshness(snapshot: ReturnType<typeof buildObservabilitySnapshot>, generatedAt: string, config: GatewayConfig): IncidentBundleSourceFreshness[] {
  const rows: IncidentBundleSourceFreshness[] = snapshot.support.sourceHealth.map(source => ({
    source: source.source,
    status: sourceHealthStatus(source.status),
    observedAt: generatedAt,
    ageMs: 0,
    staleAfterMs: source.staleAfterMs,
    summary: safeIncidentText(source.summary, config),
    nextAction: sourceHealthNextAction(source.status),
    evidenceRefs: safeRefs(source.evidenceRefs, config),
  }))
  for (const slo of snapshot.slo) {
    if (slo.id !== 'progress_freshness' || slo.status === 'pass') continue
    rows.push({
      source: 'progress_freshness',
      status: slo.status === 'fail' ? 'stale' : 'degraded',
      observedAt: generatedAt,
      ageMs: Math.max(0, slo.observedMs || 0),
      staleAfterMs: slo.thresholdMs,
      summary: safeIncidentText(slo.summary, config),
      nextAction: 'Inspect the correlated task/run trace, then recover or retry stale work from durable state.',
      evidenceRefs: safeRefs(slo.evidence, config),
    })
  }
  rows.push({
    source: 'evidence_refs',
    status: snapshot.trace.evidence.length ? 'green' : 'unknown',
    observedAt: generatedAt,
    ageMs: 0,
    summary: snapshot.trace.evidence.length ? `${snapshot.trace.evidence.length} run evidence reference(s) correlated.` : 'No run evidence references were correlated.',
    nextAction: snapshot.trace.evidence.length ? 'No action needed.' : 'Attach or regenerate redacted evidence before using this bundle for release/support proof.',
    evidenceRefs: safeRefs(snapshot.trace.evidence.slice(0, 10).map(row => row.ref), config),
  })
  return rows
}

function classifyIncidentFailures(
  alerts: AlertRecord[],
  slo: ObservabilitySloResult[],
  support: SupportOperationsContract,
  trace: TraceCorrelationIndex,
  alertTrace: Map<string, string>,
  config: GatewayConfig,
): IncidentBundleFailureClassification[] {
  const rows: IncidentBundleFailureClassification[] = []
  for (const alert of alerts) {
    const traceId = alertTrace.get(alert.id)
    rows.push({
      code: `alert_${safeCode(alert.source)}_${alert.severity}`,
      severity: alertSeverity(alert.severity),
      source: alert.source,
      summary: safeIncidentText(alert.summary, config),
      nextAction: safeIncidentText(alert.nextAction, config),
      traceId,
      evidenceRefs: actionableIncidentRefs(alert.evidence || [], [`trace:${traceId || trace.traceRootId}`, `alert:${safeCode(alert.source)}`], config),
    })
  }
  for (const row of slo.filter(item => item.status !== 'pass')) {
    rows.push({
      code: `slo_${row.id}_${row.status}`,
      severity: row.status === 'fail' ? 'critical' : 'warning',
      source: row.id,
      summary: safeIncidentText(row.summary, config),
      nextAction: row.status === 'fail' ? 'Pause broad dispatch if this affects multiple runs, then inspect the correlated trace.' : 'Watch this budget and collect fresh evidence if it persists.',
      evidenceRefs: actionableIncidentRefs(row.evidence, [`trace:${trace.traceRootId}`, `slo:${safeCode(row.id)}`], config),
    })
  }
  for (const source of support.sourceHealth.filter(row => row.status === 'degraded' || row.status === 'unavailable')) {
    rows.push({
      code: `source_${safeCode(source.source)}_${source.status}`,
      severity: source.status === 'unavailable' ? 'critical' : 'warning',
      source: source.source,
      summary: safeIncidentText(source.summary, config),
      nextAction: sourceHealthNextAction(source.status),
      evidenceRefs: actionableIncidentRefs(source.evidenceRefs, [`trace:${trace.traceRootId}`, `source:${safeCode(source.source)}`], config),
    })
  }
  if (!trace.evidence.length) {
    rows.push({
      code: 'missing_evidence_refs',
      severity: 'warning',
      source: 'evidence',
      summary: 'No run evidence references were correlated into this incident bundle.',
      nextAction: 'Regenerate or attach a redacted evidence export before using this bundle as release evidence.',
      evidenceRefs: [`trace:${trace.traceRootId}`, 'evidence:missing'],
    })
  }
  return rows
}

function sourceHealthStatus(status: SupportOperationsContract['sourceHealth'][number]['status']): IncidentBundleSourceStatus {
  switch (status) {
    case 'ready':
      return 'green'
    case 'degraded':
      return 'degraded'
    case 'unavailable':
      return 'blocked'
    case 'empty':
    case 'not_measured':
      return 'unknown'
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

function sourceHealthNextAction(status: SupportOperationsContract['sourceHealth'][number]['status']): string {
  if (status === 'ready') return 'No action needed.'
  if (status === 'degraded') return 'Inspect the named source and resolve or accept the degraded condition before claiming readiness.'
  if (status === 'unavailable') return 'Restore the named source or pause affected work until it is available.'
  return 'Collect fresh source evidence if this bundle is used for release or support decisions.'
}

function alertSeverity(severity: AlertRecord['severity']): IncidentBundleFailureSeverity {
  if (severity === 'critical') return 'critical'
  if (severity === 'warning') return 'warning'
  return 'info'
}

function normalizedAuditLedgerLimit(limit?: number): number {
  return Math.max(1, Math.min(limit || 100, 1000))
}

function windowCount(total: number, limit: number, scope: IncidentBundleWindowScope, sourceLimit?: number): IncidentBundleWindow {
  const shown = Math.min(total, limit)
  return { total, shown, omitted: Math.max(0, total - shown), limit, scope, sourceLimit }
}

function safeRefs(refs: string[] = [], config: GatewayConfig): string[] {
  return refs.slice(0, 20).map(ref => safeIncidentText(String(ref), config)).filter(Boolean)
}

function actionableIncidentRefs(refs: string[] = [], fallback: string[], config: GatewayConfig): string[] {
  const safe = safeRefs(refs, config)
  return safe.length ? safe : fallback.filter(Boolean)
}

function safeCode(value: string | undefined): string {
  const code = String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return code || 'unknown'
}

function formatIncidentBundleMarkdown(manifest: IncidentBundleManifest, trace: TraceCorrelationIndex, incidentReport: string): string {
  return [
    '# Gateway Incident Bundle',
    '',
    `- Bundle: \`${manifest.id}\``,
    `- Generated: ${manifest.generatedAt}`,
    `- Status: ${manifest.status}`,
    `- Evidence bundle: ${manifest.evidenceBundleId}`,
    `- Trace root: ${manifest.traceRootId}`,
    `- Manifest hash: ${manifest.manifestHash}`,
    `- Evidence pipeline: ${manifest.pipeline.status} (${manifest.pipeline.decision.claimChange})`,
    `- Counts: ${manifest.counts.alerts} alerts, ${manifest.counts.tasks} tasks, ${manifest.counts.runs} runs, ${manifest.counts.events} events, ${manifest.counts.channels} channel targets, ${manifest.counts.auditLedger} audit ledger rows`,
    '',
    '## SLO Status',
    '',
    formatObservabilitySLOs(manifest.slo),
    '',
    '## Support Operations',
    '',
    `- Support posture: ${manifest.support.status}`,
    `- Release claim: ${manifest.support.releaseClaim}`,
    `- Current mode: ${manifest.support.currentMode}`,
    `- Trace coverage: ${manifest.support.traceCoverage.scheduler} tasks, ${manifest.support.traceCoverage.workers} runs, ${manifest.support.traceCoverage.channels} channel targets, ${manifest.support.traceCoverage.auditLedger} audit rows`,
    `- Incident bundle: ${manifest.support.incidentBundle.status}`,
    `- Unsupported claims: ${manifest.support.unsupportedClaims.join(', ')}`,
    '',
    '## Source Freshness',
    '',
    manifest.sourceFreshness.length
      ? manifest.sourceFreshness.map(source => `- [${source.status}] ${source.source}: ${source.summary}\n  Next: ${source.nextAction}`).join('\n')
      : 'No observability sources were measured.',
    '',
    '## Failure Classification',
    '',
    manifest.failureClassification.length
      ? manifest.failureClassification.map(row => `- [${row.severity}] ${row.code}: ${row.summary}${row.traceId ? ` trace=${row.traceId}` : ''}\n  Next: ${row.nextAction}`).join('\n')
      : 'No failures classified.',
    '',
    '## Output Windows',
    '',
    `- Trace tasks: ${formatWindow(manifest.windows.traceTasks)}`,
    `- Trace runs: ${formatWindow(manifest.windows.traceRuns)}`,
    `- Audit ledger: ${formatWindow(manifest.windows.auditLedger)}`,
    '',
    'Operator actions:',
    '',
    ...manifest.support.operatorActions.map(action => `- ${action.label}: \`${action.command}\` audit=${action.auditOperation}${action.safeByDefault ? '' : ' (requires explicit gate)'}`),
    '',
    '## Alerts',
    '',
    manifest.alerts.length ? manifest.alerts.map(alert => `- [${alert.severity}/${alert.status}] ${alert.summary} (${alert.id}) trace=${alert.traceId}\n  Next: ${alert.nextAction}`).join('\n') : 'No alerts selected.',
    '',
    '## Trace Samples',
    '',
    ...trace.tasks.slice(0, 10).map(task => `- task ${task.taskId} trace=${task.traceId} status=${task.status} runs=${task.runTraceIds.length}`),
    ...trace.runs.slice(0, 10).map(run => `- run ${run.runId} trace=${run.traceId} taskTrace=${run.taskTraceId || 'none'} stage=${run.stage} status=${run.status}`),
    '',
    '## Audit Ledger',
    '',
    manifest.auditLedger.length
      ? manifest.auditLedger.slice(0, 20).map(row => `- ${row.class} ${row.action} result=${row.result} trace=${row.traceId} hash=${row.entryHash.slice(0, 16)}`).join('\n')
      : 'No audit ledger rows selected.',
    '',
    '## Redacted Incident Report',
    '',
    incidentReport,
    '',
    '## Sharing',
    '',
    '- Share `incident.md`, `incident.json`, and the nested redacted evidence bundle when asking for help.',
    '- Do not share unredacted bundles unless you intentionally ran an explicit local-admin export.',
  ].join('\n')
}

function formatWindow(window: IncidentBundleWindow): string {
  const totalLabel = window.scope === 'selected' ? 'selected' : 'total'
  const sourceLimit = window.sourceLimit ? `, selection cap ${window.sourceLimit}` : ''
  return `showing ${window.shown}/${window.total} ${totalLabel} (sample limit ${window.limit}${sourceLimit}, omitted ${window.omitted})`
}

function compactAuditLedgerRow(row: AuditLedgerRecord): IncidentBundleAuditLedgerRow {
  return {
    eventId: row.eventId,
    sourceEventId: row.sourceEventId,
    sourceEventType: row.sourceEventType,
    class: row.class,
    action: row.action,
    result: row.result,
    occurredAt: row.occurredAt,
    traceId: row.traceId,
    correlationId: row.correlationId,
    retentionClass: row.retentionClass,
    evidenceRefs: [...row.evidenceRefs],
    previousHash: row.previousHash,
    entryHash: row.entryHash,
  }
}

function targetFromAlert(alert?: AlertRecord): EvidenceExportTarget {
  if (!alert?.target) return {}
  if (alert.target.startsWith('task_')) return { taskId: alert.target }
  if (alert.target.startsWith('run_')) return { runId: alert.target }
  if (alert.target.startsWith('roadmap_')) return { roadmapId: alert.target }
  return {}
}

function safeIncidentText(value: string, config: GatewayConfig): string {
  let text = redactSensitiveText(value || '', config)
    .replace(/(?:\/Users\/[^\s"'`),;]+|\/var\/[^\s"'`),;]+|\/tmp\/[^\s"'`),;]+|\/private\/[^\s"'`),;]+)/g, match => `<path:${hashText(match).slice(0, 10)}>${path.sep}${path.basename(match)}`)
    .replace(/\b(target|chat|thread|topic)\s+([A-Za-z0-9][A-Za-z0-9._:-]{5,})\b/gi, (_match, label, raw) => `${label} <redacted:${String(label).toLowerCase()}:${hashText(String(raw)).slice(0, 12)}>`)
  text = replaceProviderTargetText(text, ({ provider, chatId, threadId }) => `${provider}:target:${hashText(String(chatId)).slice(0, 12)}${threadId ? ':thread:' + hashText(String(threadId)).slice(0, 8) : ''}`)
  text = replaceSessionIdText(text, raw => `<redacted:session:${hashText(raw).slice(0, 12)}>`)
  text = replacePrivateText(text, raw => `<redacted:private-text:${hashText(raw).slice(0, 12)}>`)
  text = replacePhoneLikeText(text, raw => `<redacted:phone:${hashText(raw).slice(0, 12)}>`)
  return text.slice(0, 12_000)
}

function timestampId(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, 14)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
