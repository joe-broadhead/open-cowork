import * as fs from 'node:fs'
import * as path from 'node:path'
import { getConfig, getConfigDir } from './config.js'
import { getHeartbeatStatus } from './heartbeat.js'
import { getWorkQueueSnapshot, getWorkQueueSnapshotReadOnly } from './scheduler.js'
import { listPendingPermissions, listPendingQuestions } from './opencode-requests.js'
import { listAlerts, listAlertsReadOnly, listHumanGates, listHumanGatesReadOnly, listWorkEvents, listWorkEventsReadOnly, workStatePath } from './work-store.js'
import { getWorkerCounts } from './workers.js'
import { allowsAllChannelTargets, getHttpAuthPosture, hasChannelAllowlist, hasHttpAuthTokens, isChannelProviderConfigured, isLocalHostname, extractHostname, redactSensitiveText } from './security.js'
import { buildGovernanceReport } from './governance.js'
import { detectGatewayProfileDrift } from './profile-drift.js'
import { buildDurableStateConsistencyProof, buildLocalDurableStateAdapterReport, runStorageDoctor, storageStateDir } from './storage.js'
import { buildSecretsLifecycleReport } from './secrets-lifecycle.js'
import { buildAuditRetentionReport } from './audit-retention.js'
import { buildObservabilitySnapshot } from './observability-snapshot.js'
import { buildNeedsAttentionReport } from './human-loop.js'
import { getCurrentDaemonLeadershipStatus, redactDaemonLeadershipSnapshot } from './daemon-leadership.js'
import { buildLocalReadinessCatalog } from './agent-catalog.js'
import { openCodeFetch } from './opencode-client.js'
import { withDeadline } from './deadlines.js'
import { loadDistributedOwnershipProvingRegistry } from './distributed-ownership-registry.js'

export type ReadinessState = 'ready' | 'degraded' | 'not_ready'
export type ReadinessCheckStatus = 'pass' | 'warn' | 'fail'
const OPENCODE_READINESS_TIMEOUT_MS = 2000

export interface ReadinessCheck {
  name: string
  status: ReadinessCheckStatus
  severity: 'info' | 'warning' | 'critical'
  summary: string
  details?: Record<string, unknown>
}

export interface ReadinessReport {
  state: ReadinessState
  summary: string
  generatedAt: string
  version: string
  mode: 'local_personal' | 'local_plus_channel' | 'tunneled_webhook' | 'unsupported'
  checks: ReadinessCheck[]
  queue: Record<string, number>
  scheduler: Record<string, unknown>
  storage: Record<string, unknown>
  requests: { questions: number; permissions: number }
  sessions: Record<string, number>
}

export function evaluateReadiness(checks: ReadinessCheck[]): { state: ReadinessState; summary: string } {
  const critical = checks.filter(check => check.status === 'fail' && check.severity === 'critical')
  if (critical.length) return { state: 'not_ready', summary: `${critical.length} critical readiness check${critical.length === 1 ? '' : 's'} failed` }
  const warnings = checks.filter(check => check.status !== 'pass')
  if (warnings.length) return { state: 'degraded', summary: `${warnings.length} readiness check${warnings.length === 1 ? '' : 's'} need attention` }
  return { state: 'ready', summary: 'Gateway is ready for public local beta operation' }
}

function readOnlyUnavailableCheck(name: string, err: any): ReadinessCheck {
  return {
    name,
    status: 'warn',
    severity: 'warning',
    summary: `Read-only readiness check unavailable: ${readinessErrorSummary(err)}`,
  }
}

function readinessErrorSummary(err: any): string {
  return redactSensitiveText(String(err?.message || err || 'unknown error')).substring(0, 300)
}

export async function buildReadinessReport(client?: any, options: { readOnly?: boolean } = {}): Promise<ReadinessReport> {
  const config = getConfig()
  const heartbeat = getHeartbeatStatus()
  const snapshot = options.readOnly ? getWorkQueueSnapshotReadOnly() : getWorkQueueSnapshot()
  const checks: ReadinessCheck[] = []
  const generatedAt = new Date().toISOString()

  const opencode = await checkOpenCode(config.opencodeUrl, client)
  checks.push(opencode)

  const addCheck = (name: string, build: () => ReadinessCheck) => {
    try {
      checks.push(build())
    } catch (err: any) {
      if (!options.readOnly) throw err
      checks.push(readOnlyUnavailableCheck(name, err))
    }
  }
  const addChecks = (name: string, build: () => ReadinessCheck[]) => {
    try {
      checks.push(...build())
    } catch (err: any) {
      if (!options.readOnly) throw err
      checks.push(readOnlyUnavailableCheck(name, err))
    }
  }

  addCheck('daemon_leadership', () => checkDaemonLeadership())
  addCheck('multi_writer_ownership', () => checkMultiWriterOwnership())
  addCheck('scheduler', () => checkScheduler(config.scheduler, snapshot.counts))
  addCheck('heartbeat', () => checkHeartbeat(heartbeat, config.scheduler.enabled ? config.scheduler.intervalMs : config.heartbeat.intervalMs))
  addCheck('storage', () => checkStorage(options.readOnly))
  addCheck('queue', () => checkQueue(snapshot.counts, config.scheduler.maxConcurrent))
  addCheck('recent_failures', () => checkRecentFailures(options.readOnly))
  addCheck('alerts', () => checkAlerts(options.readOnly))
  addCheck('support_observability', () => checkSupportObservability(options.readOnly))
  addCheck('needs_attention', () => checkNeedsAttention(config, options.readOnly))
  addCheck('governance', () => checkGovernance(snapshot.state, config))
  addCheck('profile_drift', () => checkProfileDrift(config))
  addCheck('secrets_lifecycle', () => checkSecretsLifecycle(config))
  addCheck('local_readiness_catalog', () => checkLocalReadinessCatalog(config, generatedAt, opencode, heartbeat))
  addCheck('audit_retention', () => checkAuditRetention())
  addChecks('security', () => checkSecurity(config))

  const [questions, permissions] = await Promise.all([
    listPendingQuestions().catch(() => []),
    listPendingPermissions().catch(() => []),
  ])
  if (questions.length || permissions.length) {
    checks.push({
      name: 'human_requests',
      status: 'warn',
      severity: 'warning',
      summary: `${questions.length} question(s), ${permissions.length} permission request(s) pending`,
      details: { questions: questions.length, permissions: permissions.length },
    })
  } else {
    checks.push({ name: 'human_requests', status: 'pass', severity: 'info', summary: 'No pending human requests' })
  }
  const gates = (() => {
    try {
      return options.readOnly ? listHumanGatesReadOnly({ status: 'open' }) : listHumanGates({ status: 'open' })
    } catch {
      return []
    }
  })()
  if (gates.length) {
    const escalated = gates.filter(gate => gate.status === 'escalated').length
    checks.push({ name: 'human_gates', status: escalated ? 'fail' : 'warn', severity: escalated ? 'critical' : 'warning', summary: `${gates.length} Gateway human gate(s) pending${escalated ? `, ${escalated} escalated` : ''}`, details: { pending: gates.length, escalated } })
  } else {
    checks.push({ name: 'human_gates', status: 'pass', severity: 'info', summary: 'No pending Gateway human gates' })
  }

  const channelMode = classifyMode(config)
  const verdict = evaluateReadiness(checks)
  return {
    ...verdict,
    generatedAt,
    version: readPackageVersion(),
    mode: channelMode,
    checks,
    queue: snapshot.counts,
    scheduler: config.scheduler,
    storage: storageSummary(options.readOnly),
    requests: { questions: questions.length, permissions: permissions.length },
    sessions: getWorkerCounts(),
  }
}

export function formatReadinessText(report: ReadinessReport): string {
  const lines = [
    `Readiness: ${report.state}`,
    `Summary: ${report.summary}`,
    `Mode: ${report.mode}`,
    `Queue: ${report.queue['pending'] || 0} pending | ${report.queue['running'] || 0} running | ${report.queue['blocked'] || 0} blocked | ${report.queue['paused'] || 0} paused`,
    `Requests: ${report.requests.questions} questions | ${report.requests.permissions} permissions`,
    '',
    'Checks:',
    ...report.checks.map(check => `- [${check.status}] ${check.name}: ${check.summary}`),
  ]
  return lines.join('\n')
}

async function checkOpenCode(opencodeUrl: string, client?: any): Promise<ReadinessCheck> {
  try {
    if (client?.session?.list) {
      const { createOpenCodeSessionRuntime } = await import('./opencode-session-runtime.js')
      await withDeadline(Promise.resolve(createOpenCodeSessionRuntime(client).listSessions()), OPENCODE_READINESS_TIMEOUT_MS, 'OpenCode session list').catch(() => undefined)
    }
    const res = await openCodeFetch(opencodeUrl, 'global/health', {}, { timeoutMs: OPENCODE_READINESS_TIMEOUT_MS })
    if (!res.ok) return { name: 'opencode', status: 'fail', severity: 'critical', summary: `OpenCode health returned HTTP ${res.status}` }
    return { name: 'opencode', status: 'pass', severity: 'info', summary: 'OpenCode is reachable' }
  } catch (err: any) {
    return { name: 'opencode', status: 'fail', severity: 'critical', summary: `OpenCode is unreachable: ${redactSensitiveText(err?.message || String(err))}` }
  }
}

function checkScheduler(scheduler: any, counts: Record<string, number>): ReadinessCheck {
  if (!scheduler?.enabled) return { name: 'scheduler', status: 'warn', severity: 'warning', summary: 'Scheduler is paused' }
  if ((counts['running'] || 0) > Number(scheduler.maxConcurrent || 0)) {
    return { name: 'scheduler', status: 'fail', severity: 'critical', summary: `Running tasks exceed max concurrency (${counts['running']} > ${scheduler.maxConcurrent})` }
  }
  return { name: 'scheduler', status: 'pass', severity: 'info', summary: `Scheduler enabled with max concurrency ${scheduler.maxConcurrent}` }
}

function checkDaemonLeadership(): ReadinessCheck {
  const snapshot = redactDaemonLeadershipSnapshot(getCurrentDaemonLeadershipStatus())
  if (snapshot.mode === 'writer' || snapshot.mode === 'single_daemon') {
    return {
      name: 'daemon_leadership',
      status: 'pass',
      severity: 'info',
      summary: snapshot.mode === 'writer' ? 'This daemon owns the local writer lease' : 'Single-daemon compatibility mode is active',
      details: snapshot as unknown as Record<string, unknown>,
    }
  }
  const status: ReadinessCheckStatus = snapshot.mode === 'unavailable' || snapshot.mode === 'no_leader' ? 'fail' : 'warn'
  return {
    name: 'daemon_leadership',
    status,
    severity: status === 'fail' ? 'critical' : 'warning',
    summary: snapshot.mode === 'standby'
      ? 'Another Gateway daemon owns the local writer lease'
      : snapshot.mode === 'no_leader'
        ? 'No Gateway daemon owns the local writer lease'
        : 'Gateway leadership state is unavailable',
    details: snapshot as unknown as Record<string, unknown>,
  }
}

/**
 * Informational multi-writer ownership posture (JOE-948/949).
 * Passes for the supported single-daemon production shape while still surfacing
 * open migrate hazards so experimental multi-replica is never mistaken for HA.
 * Does not degrade readiness (warn would permanently mark single-daemon degraded).
 */
function checkMultiWriterOwnership(): ReadinessCheck {
  const loaded = loadDistributedOwnershipProvingRegistry()
  if (!loaded.ok) {
    return {
      name: 'multi_writer_ownership',
      status: 'pass',
      severity: 'info',
      summary: `Proving registry unavailable; assume single-daemon production only (${redactSensitiveText(loaded.reason)})`,
      details: { registryPath: loaded.registryPath },
    }
  }
  const open = Array.isArray(loaded.registry.openMigrateHazards) ? loaded.registry.openMigrateHazards : []
  const registryStatus = typeof loaded.registry.status === 'string' ? loaded.registry.status : 'unknown'
  if (open.length === 0 && registryStatus === 'ready') {
    return {
      name: 'multi_writer_ownership',
      status: 'pass',
      severity: 'info',
      summary: 'Distributed-ownership proving registry is ready (no open migrate hazards)',
      details: { registryStatus, openMigrateHazards: open, registryPath: loaded.registryPath },
    }
  }
  return {
    name: 'multi_writer_ownership',
    status: 'pass',
    severity: 'info',
    summary: `Single-writer production only; experimental multi-replica still fails open migrate hazards (${open.join(', ') || 'none listed'}; registry status=${registryStatus})`,
    details: {
      registryStatus,
      openMigrateHazards: open,
      productionShape: 'single-daemon-per-state-dir',
      experimentalMultiReplica: 'lab-only-not-ha',
      registryPath: loaded.registryPath,
    },
  }
}

function checkHeartbeat(heartbeat: any, intervalMs: number): ReadinessCheck {
  if (heartbeat?.status === 'error') return { name: 'heartbeat', status: 'fail', severity: 'critical', summary: heartbeat.lastError || 'Heartbeat failed' }
  const lastCompleted = Date.parse(heartbeat?.lastCompletedAt || '')
  const staleAfter = Math.max(intervalMs * 3, 5 * 60 * 1000)
  if (!Number.isFinite(lastCompleted)) return { name: 'heartbeat', status: 'warn', severity: 'warning', summary: 'Heartbeat has not completed yet' }
  const age = Date.now() - lastCompleted
  if (age > staleAfter) return { name: 'heartbeat', status: 'warn', severity: 'warning', summary: `Heartbeat is stale by ${Math.round(age / 1000)}s`, details: { ageMs: age, staleAfterMs: staleAfter } }
  return { name: 'heartbeat', status: 'pass', severity: 'info', summary: 'Heartbeat is fresh' }
}

function checkStorage(readOnly = false): ReadinessCheck {
  try {
    const dir = getConfigDir()
    if (!readOnly) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = fs.statSync(dir)
    const dbPath = workStatePath()
    const doctor = runStorageDoctor({ stateDir: storageStateDir() })
    const durableState = buildDurableStateConsistencyProof({ stateDir: storageStateDir() })
    const durableStateAdapter = buildLocalDurableStateAdapterReport({ stateDir: storageStateDir() })
    const backend = doctor.backend
    const status: ReadinessCheck['status'] = doctor.status === 'down' || durableStateAdapter.status === 'fail'
      ? 'fail'
      : doctor.status === 'degraded' || durableStateAdapter.status === 'warn'
        ? 'warn'
        : 'pass'
    const severity: ReadinessCheck['severity'] = status === 'fail' ? 'critical' : status === 'warn' ? 'warning' : 'info'
    return {
      name: 'storage',
      status,
      severity,
      summary: `Gateway state directory is writable (${(stat.mode & 0o777).toString(8)}); backend activation is ${backend.activation.status}; consistency proof is ${doctor.consistency.status}; durable state proof is ${durableState.status}; adapter is ${durableStateAdapter.status}`,
      details: { configDir: dir, gatewayDb: dbPath, dbExists: fs.existsSync(dbPath), backend, consistency: doctor.consistency, durableState, durableStateAdapter, storageDoctorStatus: doctor.status },
    }
  } catch (err: any) {
    return { name: 'storage', status: 'fail', severity: 'critical', summary: `Gateway state directory is not writable: ${err?.message || err}` }
  }
}

function checkQueue(counts: Record<string, number>, maxConcurrent: number): ReadinessCheck {
  if ((counts['blocked'] || 0) > 0) return { name: 'queue', status: 'warn', severity: 'warning', summary: `${counts['blocked']} blocked task(s) need attention` }
  if ((counts['running'] || 0) > maxConcurrent) return { name: 'queue', status: 'fail', severity: 'critical', summary: 'Queue violates configured concurrency' }
  return { name: 'queue', status: 'pass', severity: 'info', summary: 'Queue is internally consistent' }
}

function checkRecentFailures(readOnly = false): ReadinessCheck {
  const cutoff = Date.now() - 60 * 60 * 1000
  let events
  try {
    events = readOnly ? listWorkEventsReadOnly(500) : listWorkEvents(500)
  } catch (err: any) {
    if (readOnly) return { name: 'recent_failures', status: 'warn', severity: 'warning', summary: `Recent failure scan unavailable: ${readinessErrorSummary(err)}` }
    throw err
  }
  const failures = events.filter(event => Date.parse(event.createdAt) >= cutoff && /failed|error|blocked|denied|rejected/i.test(`${event.type} ${JSON.stringify(event.payload)}`))
  if (failures.length >= 5) return { name: 'recent_failures', status: 'warn', severity: 'warning', summary: `${failures.length} failure-like events in the last hour` }
  return { name: 'recent_failures', status: 'pass', severity: 'info', summary: 'No elevated recent failure rate' }
}

function checkAlerts(readOnly = false): ReadinessCheck {
  let alerts
  try {
    alerts = readOnly ? listAlertsReadOnly({ status: 'open' }) : listAlerts({ status: 'open' })
  } catch (err: any) {
    if (readOnly) return { name: 'alerts', status: 'warn', severity: 'warning', summary: `Alert scan unavailable: ${readinessErrorSummary(err)}` }
    throw err
  }
  const critical = alerts.filter(alert => alert.severity === 'critical').length
  if (critical) return { name: 'alerts', status: 'fail', severity: 'critical', summary: `${critical} critical alert(s) active`, details: { active: alerts.length, critical } }
  if (alerts.length) return { name: 'alerts', status: 'warn', severity: 'warning', summary: `${alerts.length} alert(s) active`, details: { active: alerts.length } }
  return { name: 'alerts', status: 'pass', severity: 'info', summary: 'No active alerts' }
}

function checkSupportObservability(readOnly = false): ReadinessCheck {
  try {
    const snapshot = buildObservabilitySnapshot({ eventLimit: 300, auditLedgerLimit: 100, readOnly })
    const support = snapshot.support
    const status: ReadinessCheckStatus = support.status === 'blocked' ? 'fail' : support.status === 'degraded' ? 'warn' : 'pass'
    const severity: ReadinessCheck['severity'] = status === 'fail' ? 'critical' : status === 'warn' ? 'warning' : 'info'
    return {
      name: 'support_observability',
      status,
      severity,
      summary: `Support observability is ${support.status}; trace coverage includes ${support.traceCoverage.scheduler} task(s), ${support.traceCoverage.workers} run(s), ${support.traceCoverage.channels} channel target(s), ${support.traceCoverage.auditLedger} audit row(s)`,
      details: {
        generatedAt: support.generatedAt,
        releaseClaim: support.releaseClaim,
        currentMode: support.currentMode,
        traceRootId: snapshot.trace.traceRootId,
        traceCoverage: support.traceCoverage,
        sourceHealth: support.sourceHealth,
        supportSignals: support.supportSignals.map(signal => ({
          id: signal.id,
          status: signal.status,
          severity: signal.severity,
          source: signal.source,
          observedAt: signal.observedAt,
          summary: signal.summary,
          recommendedAction: signal.recommendedAction,
          releaseBlocking: signal.releaseBlocking,
          evidenceRefs: signal.evidenceRefs,
        })),
        operatorActions: support.operatorActions.map(action => ({
          id: action.id,
          command: action.command,
          httpRoute: action.httpRoute,
          auditOperation: action.auditOperation,
          safeByDefault: action.safeByDefault,
        })),
        incidentBundle: support.incidentBundle,
        serviceLevels: support.serviceLevels.map(level => ({
          mode: level.mode,
          releaseStatus: level.releaseStatus,
          sloClaim: level.sloClaim,
          supportAccessBoundary: level.supportAccessBoundary,
          incidentResponseBoundary: level.incidentResponseBoundary,
        })),
        unsupportedClaims: support.unsupportedClaims,
      },
    }
  } catch (err: any) {
    return { name: 'support_observability', status: 'fail', severity: 'critical', summary: `Support observability snapshot failed: ${err?.message || err}` }
  }
}

function checkNeedsAttention(config: any, readOnly = false): ReadinessCheck {
  try {
    const report = buildNeedsAttentionReport({ config, readOnly })
    const critical = report.items.filter(item => item.severity === 'critical').length
    const high = report.items.filter(item => item.severity === 'high').length
    const status: ReadinessCheckStatus = critical ? 'fail' : report.items.length ? 'warn' : 'pass'
    const severity: ReadinessCheck['severity'] = critical ? 'critical' : report.items.length ? 'warning' : 'info'
    const summary = report.items.length
      ? `${report.items.length} item(s) need operator attention (${critical} critical, ${high} high)`
      : 'No items need operator attention'
    return {
      name: 'needs_attention',
      status,
      severity,
      summary,
      details: {
        generatedAt: report.generatedAt,
        counts: report.counts,
        items: report.items.map(item => ({
          id: item.id,
          kind: item.kind,
          severity: item.severity,
          title: item.title,
          action: item.action,
          taskId: item.taskId,
          roadmapId: item.roadmapId,
        })),
      },
    }
  } catch (err: any) {
    return { name: 'needs_attention', status: 'fail', severity: 'critical', summary: `Needs-attention scan failed: ${err?.message || err}` }
  }
}

function checkGovernance(state: any, config: any): ReadinessCheck {
  const report = buildGovernanceReport(state, config)
  if (report.status === 'blocked') return { name: 'governance', status: 'fail', severity: 'critical', summary: report.summary, details: report.totals }
  if (report.status === 'warn') return { name: 'governance', status: 'warn', severity: 'warning', summary: report.summary, details: report.totals }
  return { name: 'governance', status: 'pass', severity: 'info', summary: report.summary, details: report.totals }
}

function checkProfileDrift(config: any): ReadinessCheck {
  const drift = detectGatewayProfileDrift(config)
  if (drift.length) return { name: 'gateway_profiles', status: 'warn', severity: 'warning', summary: `${drift.length} Gateway-owned profile default(s) are stale or missing`, details: { drift } }
  return { name: 'gateway_profiles', status: 'pass', severity: 'info', summary: 'Gateway-owned profile defaults are current' }
}

function checkSecretsLifecycle(config: any): ReadinessCheck {
  const report = buildSecretsLifecycleReport(config)
  const critical = report.risks.filter(risk => risk.severity === 'critical')
  const status: ReadinessCheckStatus = critical.length ? 'fail' : report.risks.length ? 'warn' : 'pass'
  const severity: ReadinessCheck['severity'] = critical.length ? 'critical' : report.risks.length ? 'warning' : 'info'
  const summary = report.risks.length
    ? `Secret lifecycle has ${report.risks.length} posture risk${report.risks.length === 1 ? '' : 's'}; local secret references are available and hosted/team vaulting remains unsupported`
    : 'Secret lifecycle is local-operator managed with value-free secret references; hosted/team vaulting remains unsupported'
  return {
    name: 'security_secret_lifecycle',
    status,
    severity,
    summary,
    details: {
      mode: report.mode,
      releaseStatus: report.releaseStatus,
      vaultStatus: report.vaultStatus,
      hostedTeamStatus: report.hostedTeamStatus,
      teamPreviewStatus: report.teamPreviewStatus,
      rawSecretPolicy: report.rawSecretPolicy,
      scopedInjection: report.scopedInjection,
      totals: report.totals,
      configuredInputs: report.configuredInputs.map(input => ({
        id: input.id,
        class: input.class,
        secret: input.secret,
        configuredVia: input.configuredVia,
        env: input.env,
        configKeys: input.configKeys,
        referenceIds: input.referenceIds,
      })),
      secretReferences: report.secretReferences.map(reference => ({
        id: reference.id,
        inputId: reference.inputId,
        class: reference.class,
        secret: reference.secret,
        owner: reference.owner,
        provider: reference.provider,
        source: reference.source,
        storageMode: reference.storageMode,
        location: reference.location,
        scope: reference.scope,
        injection: reference.injection,
        lastSeen: reference.lastSeen,
        rotation: reference.rotation,
        revocation: reference.revocation,
        capability: reference.capability,
        audit: reference.audit,
        redaction: reference.redaction,
      })),
      operatorPosture: report.operatorPosture,
      auditEventTypes: report.auditEventTypes,
      risks: report.risks.map(risk => ({
        code: risk.code,
        severity: risk.severity,
        inputId: risk.inputId,
        summary: risk.summary,
        remediation: risk.remediation,
      })),
      caveats: report.caveats,
    },
  }
}

function checkLocalReadinessCatalog(config: any, generatedAt: string, opencode: ReadinessCheck, heartbeat: any): ReadinessCheck {
  const catalog = buildLocalReadinessCatalog({
    config,
    generatedAt,
    opencode: { status: opencode.status, summary: opencode.summary },
    heartbeat,
  })
  const blocked = catalog.entries.filter(entry => entry.status === 'blocked')
  const critical = blocked.filter(catalogCriticalBlocker)
  const attention = catalog.entries.filter(entry => entry.status === 'partial' || entry.status === 'unknown')
  const status: ReadinessCheckStatus = critical.length ? 'fail' : blocked.length || attention.length ? 'warn' : 'pass'
  return {
    name: 'local_readiness_catalog',
    status,
    severity: critical.length ? 'critical' : blocked.length || attention.length ? 'warning' : 'info',
    summary: critical.length
      ? `${critical.length} local readiness catalog item(s) are critically blocked.`
      : blocked.length || attention.length
        ? `${blocked.length + attention.length} local readiness catalog item(s) need setup attention.`
        : 'Local readiness catalog is supported or explicitly waived.',
    details: {
      mode: catalog.mode,
      totals: catalog.totals,
      releaseClaimBoundary: catalog.releaseClaimBoundary,
      redaction: catalog.redaction,
      entries: catalog.entries.map(entry => ({
        id: entry.id,
        category: entry.category,
        status: entry.status,
        statusCode: entry.statusCode,
        summary: entry.summary,
        remediation: entry.remediation,
        evidenceRefs: entry.evidenceRefs,
        capabilities: entry.capabilities.map(capability => ({
          id: capability.id,
          status: capability.status,
          summary: capability.summary,
          remediation: capability.remediation,
        })),
      })),
    },
  }
}

function catalogCriticalBlocker(entry: { id: string; category: string; statusCode: string }): boolean {
  if (entry.category === 'runtime') return true
  if (entry.id === 'setup:channel_credentials') return true
  if (entry.category === 'channel') return true
  if (entry.statusCode.includes('webhook') || entry.statusCode.includes('credential') || entry.statusCode.includes('trust')) return true
  return false
}

function checkAuditRetention(): ReadinessCheck {
  const report = buildAuditRetentionReport()
  return {
    name: 'compliance_audit_retention',
    status: 'pass',
    severity: 'info',
    summary: 'Audit/retention model supports local redacted evidence plus an append-only local ledger foundation; hosted compliance storage is not a release claim',
    details: {
      mode: report.mode,
      releaseStatus: report.releaseStatus,
      complianceLedgerStatus: report.complianceLedgerStatus,
      hostedStatus: report.hostedStatus,
      localEvidenceStatus: report.localEvidenceStatus,
      rawTranscriptPolicy: report.rawTranscriptPolicy,
      totals: report.totals,
      eventClasses: report.eventClasses.map(row => row.class),
      retentionClasses: report.retentionPolicies.map(row => row.class),
      supportedSurfaces: report.currentSurfaces.filter(surface => surface.supportedNow).map(surface => surface.surface),
      designOnlySurfaces: report.currentSurfaces.filter(surface => !surface.supportedNow).map(surface => surface.surface),
      ledger: report.ledger,
      forbiddenIncidentContents: report.incidentEvidence.forbiddenContents,
      caveats: report.caveats,
    },
  }
}

function checkSecurity(config: any): ReadinessCheck[] {
  const checks: ReadinessCheck[] = []
  const host = config.security?.httpHost || '127.0.0.1'
  const nonLocalHost = !isLocalHostname(extractHostname(host))
  if (nonLocalHost && !config.security?.allowNonLocalHttp) {
    checks.push({ name: 'security_http_boundary', status: 'fail', severity: 'critical', summary: `Non-local HTTP host ${host} is not explicitly allowed` })
  } else if (nonLocalHost && !hasHttpAuthTokens() && !config.security?.publicWebhookMode && !config.security?.unsafeAllowNoAuth) {
    checks.push({ name: 'security_http_boundary', status: 'fail', severity: 'critical', summary: 'Exposed HTTP mode has no bearer token, public webhook mode, or unsafe acknowledgement', details: { ...getHttpAuthPosture() } })
  } else if (nonLocalHost && config.security?.unsafeAllowNoAuth) {
    checks.push({ name: 'security_http_boundary', status: 'fail', severity: 'critical', summary: 'Exposed HTTP mode allows unauthenticated access by explicit unsafe config', details: { ...getHttpAuthPosture(), unsafeAllowNoAuth: true } })
  } else {
    checks.push({ name: 'security_http_boundary', status: 'pass', severity: 'info', summary: nonLocalHost ? 'Exposed HTTP mode has capability-scoped controls' : 'Daemon is localhost-bound', details: { ...getHttpAuthPosture() } })
  }

  const telegram = isChannelProviderConfigured('telegram', config)
  const whatsapp = isChannelProviderConfigured('whatsapp', config)
  const discord = isChannelProviderConfigured('discord', config)
  const missingAllowlists = [
    telegram && !hasChannelAllowlist('telegram', config) && !allowsAllChannelTargets('telegram', config) ? 'telegram' : '',
    whatsapp && !hasChannelAllowlist('whatsapp', config) && !allowsAllChannelTargets('whatsapp', config) ? 'whatsapp' : '',
    discord && !hasChannelAllowlist('discord', config) && !allowsAllChannelTargets('discord', config) ? 'discord' : '',
  ].filter(Boolean)
  const unsafeChannelTrust = [
    telegram && allowsAllChannelTargets('telegram', config) ? 'telegram' : '',
    whatsapp && allowsAllChannelTargets('whatsapp', config) ? 'whatsapp' : '',
    discord && allowsAllChannelTargets('discord', config) ? 'discord' : '',
  ].filter(Boolean)
  checks.push(missingAllowlists.length
    ? { name: 'security_channel_trust', status: 'fail', severity: 'critical', summary: `Configured channel(s) missing fail-closed allowlists: ${missingAllowlists.join(', ')}` }
    : unsafeChannelTrust.length
      ? { name: 'security_channel_trust', status: 'warn', severity: 'warning', summary: `Unsafe allow-all channel trust enabled for ${unsafeChannelTrust.join(', ')}` }
      : { name: 'security_channel_trust', status: 'pass', severity: 'info', summary: 'Configured channels have explicit allowlists or no channel is configured' })

  const configSecrets = [config.channels?.telegram?.botToken, config.channels?.whatsapp?.accessToken, config.channels?.whatsapp?.verifyToken, config.channels?.whatsapp?.appSecret, config.channels?.discord?.botToken, config.channels?.discord?.publicKey].filter(Boolean)
  checks.push(configSecrets.length
    ? { name: 'security_secret_placement', status: 'warn', severity: 'warning', summary: `${configSecrets.length} secret(s) are stored in Gateway config; prefer environment variables and rotate if exposed` }
    : { name: 'security_secret_placement', status: 'pass', severity: 'info', summary: 'No channel secrets stored in Gateway config' })

  const exposedOrChannel = nonLocalHost || telegram || whatsapp || discord || config.security?.publicWebhookMode
  const permissive = Object.entries(config.profiles || {}).filter(([, profile]: any) => profile?.permission?.bash === 'allow' || profile?.permission?.edit === 'allow')
  checks.push(exposedOrChannel && permissive.length
    ? { name: 'security_dangerous_permissions', status: 'warn', severity: 'warning', summary: `${permissive.length} profile(s) allow bash or edit; keep exposed/channel deployments supervised` }
    : { name: 'security_dangerous_permissions', status: 'pass', severity: 'info', summary: 'Dangerous tool permissions are not exposed beyond local mode' })

  return checks
}

function classifyMode(config: any): ReadinessReport['mode'] {
  const telegram = isChannelProviderConfigured('telegram', config)
  const whatsapp = isChannelProviderConfigured('whatsapp', config)
  const discord = isChannelProviderConfigured('discord', config)
  const nonLocalHost = !isLocalHostname(extractHostname(config.security?.httpHost || '127.0.0.1'))
  if (nonLocalHost && config.security?.publicWebhookMode) return 'tunneled_webhook'
  if (nonLocalHost) return 'unsupported'
  if (telegram || whatsapp || discord) return 'local_plus_channel'
  return 'local_personal'
}

function storageSummary(readOnly = false): Record<string, unknown> {
  const file = workStatePath()
  const stateDir = storageStateDir()
  const backupDir = path.join(stateDir, 'backups')
  if (readOnly && !fs.existsSync(stateDir)) return { gatewayDb: file, dbExists: false, backupDir, error: 'state directory missing' }
  const doctor = runStorageDoctor({ stateDir })
  const durableState = buildDurableStateConsistencyProof({ stateDir })
  const durableStateAdapter = buildLocalDurableStateAdapterReport({ stateDir })
  return {
    gatewayDb: file,
    dbExists: fs.existsSync(file),
    backupDir,
    latestBackupAt: latestBackupAt(backupDir),
    backend: doctor.backend,
    consistency: doctor.consistency,
    durableState,
    durableStateAdapter,
    storageDoctorStatus: doctor.status,
  }
}

function latestBackupAt(dir: string): string | undefined {
  try {
    const entries = fs.readdirSync(dir).map(name => path.join(dir, name, 'metadata.json')).filter(file => fs.existsSync(file)).map(file => fs.statSync(file).mtimeMs)
    const latest = Math.max(...entries)
    return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined
  } catch {
    return undefined
  }
}

function readPackageVersion(): string {
  try {
    const file = new URL('../package.json', import.meta.url)
    return JSON.parse(fs.readFileSync(file, 'utf-8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}
