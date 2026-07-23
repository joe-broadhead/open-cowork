import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { RouteHandler } from '../daemon-router.js'
import { defineApiRouteContracts, json, pathMatch, readJsonBody, readJsonBodyAs } from '../daemon-router.js'
import { getConfig, getConfigPath, updateConfig } from '../config.js'
import { getHeartbeatStatus } from '../heartbeat.js'
import { getWorkQueueSnapshot } from '../scheduler.js'
import { getWorkerCounts } from '../workers.js'
import { getHttpAuthPosture, redactSensitiveObject, redactSensitiveText } from '../security.js'
import { buildReadinessReport } from '../readiness.js'
import { listAlertsReadOnly, listHumanGatesReadOnly, listWorkEnvironments, loadWorkState, updateAlertStatus, workStatePath } from '../work-store.js'
import { createStorageBackup, exportGatewayState, listStorageBackups, restoreStorageBackup, runStorageDoctor, runStorageRecoveryDrill, verifyStorageBackup } from '../storage.js'
import { buildGovernanceReport } from '../governance.js'
import { buildAnalyticsScorecard, buildAnalyticsSummary, parseAnalyticsRequestFromParams } from '../analytics.js'
import { buildNeedsAttentionReport } from '../human-loop.js'
import { listPendingPermissions, listPendingQuestions } from '../opencode-requests.js'
import { buildObservabilityMetrics, generateIncidentReport, runAlertEngine, type ObservabilityMetrics } from '../alerts.js'
import { buildTriageReport } from '../triage.js'
import { buildSupervisorObservability } from '../supervisor-observability.js'
import { resolveArtifactContent } from '../product-onboarding.js'
import { buildServiceHealthReport } from '../service-health.js'
import { readGatewayLogLines } from '../service-logs.js'
import { getMissionData } from '../mission-data.js'
import { buildEvidenceBundle } from '../evidence-export.js'
import { buildIncidentBundle } from '../incident-bundle.js'
import { buildObservabilitySnapshot, type ObservabilitySnapshot } from '../observability-snapshot.js'
import { getRuntimeMetricsSnapshot, renderPrometheusMetrics } from '../runtime-metrics.js'
import { applyOperatorActiveRunControl, applyOperatorSafetyAction, buildOperatorSafetyReport } from '../operator-safety.js'
import { buildLiveStateHygieneReport } from '../live-state-hygiene.js'
import { getCurrentDaemonLeadershipStatus, recoverCurrentDaemonLeadership, redactDaemonLeadershipSnapshot } from '../daemon-leadership.js'
import { requestDaemonShutdown } from '../daemon-lifecycle.js'
import { getRunArtifactManifestView, listRunArtifactManifestViews } from '../artifacts.js'
import { openCodeFetch } from '../opencode-client.js'
import { auditHttp, consumeDestructiveHttpApproval, requireDestructiveHttpApproval, stripApprovalFields } from './http-guardrails.js'
import { guardUnredactedExport } from '../unredacted-export-guard.js'

const zOperatorActionBody = z.object({
  action: z.enum(['status', 'hygiene', 'pause', 'resume', 'recover', 'reset-stale']),
}).passthrough()
const zActiveRunControlBody = z.object({
  action: z.enum(['cancel', 'stop', 'retry', 'restart']),
  note: z.string().optional(),
  expectedLeaseOwner: z.string().optional(),
  expectedSchedulerGeneration: z.string().optional(),
}).passthrough()
const zAlertActionBody = z.object({
  action: z.enum(['acknowledge', 'resolve', 'suppress']),
  note: z.string().optional(),
  suppressMs: z.number().optional(),
}).passthrough()
const zStorageBackupCreateBody = z.object({
  label: z.string().optional(),
  retention: z.number().optional(),
  allowActiveRuns: z.boolean().optional(),
}).passthrough()
const zStorageBackupVerifyBody = z.object({
  path: z.string().min(1, 'path required'),
}).passthrough()
const zStorageRecoveryDrillBody = z.object({
  path: z.string().optional(),
  label: z.string().optional(),
  outputDir: z.string().optional(),
  retryLimit: z.number().optional(),
}).passthrough()
const zDestructiveApprovalBody = z.object({
  dryRun: z.boolean().optional(),
  preview: z.boolean().optional(),
  gateId: z.string().optional(),
  approvedGateId: z.string().optional(),
  approvalId: z.string().optional(),
  note: z.string().optional(),
}).passthrough()
const zConfigPatchBody = zDestructiveApprovalBody.passthrough()
const zStorageRestoreBody = zDestructiveApprovalBody.extend({
  path: z.string().min(1, 'path required'),
  maintenanceMode: z.boolean().optional(),
  skipSafetyBackup: z.boolean().optional(),
}).passthrough()

/** @public Loaded from the built module by the API reference generator. */
export const SYSTEM_API_ROUTE_CONTRACTS = defineApiRouteContracts([
  { method: 'POST', path: '/shutdown', requestBody: false, responses: [200] },
  { method: 'POST', path: '/restart', requestBody: false, responses: [200] },
  { method: 'POST', path: '/gateway/leadership/recover', requestBody: false, responses: [200, 409] },
  { method: 'GET', path: '/readiness', responses: [200, 503] },
  { method: 'POST', path: '/operator/actions', bodySchema: zOperatorActionBody, responses: [200, 400] },
  { method: 'POST', path: '/operator/runs/{runId}/actions', bodySchema: zActiveRunControlBody, responses: [200, 400, 404, 409, 422] },
  { method: 'GET', path: '/artifacts', responses: [200, 400, 404] },
  { method: 'GET', path: '/artifacts/manifest', responses: [200, 404] },
  { method: 'GET', path: '/evidence/export', responses: [200, 403] },
  { method: 'GET', path: '/alerts', responses: [200] },
  { method: 'POST', path: '/alerts/evaluate', requestBody: false, responses: [200] },
  { method: 'POST', path: '/alerts/{id}/action', bodySchema: zAlertActionBody, responses: [200, 400, 404] },
  { method: 'PATCH', path: '/config', bodySchema: zConfigPatchBody, responses: [200, 400, 428] },
  { method: 'GET', path: '/storage/doctor', responses: [200, 503] },
  { method: 'POST', path: '/storage/backups', bodySchema: zStorageBackupCreateBody, responses: [200, 400] },
  { method: 'POST', path: '/storage/backups/verify', bodySchema: zStorageBackupVerifyBody, responses: [200, 400, 422] },
  { method: 'POST', path: '/storage/recovery-drills', bodySchema: zStorageRecoveryDrillBody, responses: [200, 400, 422] },
  { method: 'POST', path: '/storage/restore', bodySchema: zStorageRestoreBody, responses: [200, 400, 428] },
] as const)

export function systemRoutes(): RouteHandler[] {
  return [async ({ req, url, client }) => {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', uptime: process.uptime() })
    }

    if (req.method === 'GET' && url.pathname === '/gateway/health') {
      const snapshot = getWorkQueueSnapshot()
      const health = await buildServiceHealthReport({ client, daemon: { pid: process.pid, uptime: process.uptime(), port: getConfig().httpPort } })
      return json({
        ...health,
        serviceCounts: health.serviceCounts || health.counts,
        counts: snapshot.counts,
        scheduler: getConfig().scheduler,
        heartbeat: getHeartbeatStatus(),
        queueCounts: snapshot.counts,
      })
    }

    if (req.method === 'GET' && url.pathname === '/gateway/leadership') {
      return json({ leadership: redactDaemonLeadershipSnapshot(getCurrentDaemonLeadershipStatus()) })
    }

    if (req.method === 'POST' && url.pathname === '/gateway/leadership/recover') {
      const leadership = recoverCurrentDaemonLeadership('operator')
      return json({ leadership: redactDaemonLeadershipSnapshot(leadership) }, leadership.canWrite ? 200 : 409)
    }

    if (req.method === 'GET' && url.pathname === '/doctor') {
      return json(await buildDoctorReport(client))
    }

    if (req.method === 'GET' && url.pathname === '/readiness') {
      const readiness = await buildReadinessReport(client)
      return json(readiness, readiness.state === 'not_ready' ? 503 : 200)
    }

    if (req.method === 'GET' && url.pathname === '/alpha-health') {
      const mission = await getMissionData()
      return json({ alphaHealth: mission.alphaHealth })
    }

    if (req.method === 'GET' && url.pathname === '/artifacts/manifest') {
      const stateFilePath = workStatePath()
      const state = loadWorkState(stateFilePath)
      const runId = url.searchParams.get('runId') || undefined
      const taskId = url.searchParams.get('taskId') || undefined
      const limit = Number(url.searchParams.get('limit') || 50)
      if (runId) {
        const artifactManifest = getRunArtifactManifestView(runId, state, stateFilePath)
        if (!artifactManifest) return json({ error: `artifact manifest not found for run: ${runId}` }, 404)
        return json({ artifactManifest })
      }
      return json({ artifactManifests: listRunArtifactManifestViews(state, stateFilePath, { taskId, limit }) })
    }

    if (req.method === 'GET' && url.pathname === '/artifacts') {
      const ref = url.searchParams.get('ref') || ''
      if (!ref) return json({ error: 'ref required' }, 400)
      try {
        const artifact = resolveArtifactContent(ref)
        return { status: 200, body: artifact.content, contentType: artifact.contentType }
      } catch (err: any) {
        return json({ error: err?.message || String(err) }, 404)
      }
    }

    if (req.method === 'GET' && url.pathname === '/evidence/export') {
      const unredacted = url.searchParams.get('redact') === 'false' || url.searchParams.get('unredacted') === 'true'
      const limited = guardUnredactedExport(req, {
        operation: 'evidence.export.unredacted',
        target: 'evidence/export',
        unredacted,
        url,
      })
      if (limited) return limited
      const bundle = buildEvidenceBundle({
        mode: unredacted ? 'unredacted' : 'redacted',
        allowUnredacted: unredacted,
        eventLimit: Number(url.searchParams.get('limit') || 250),
        target: {
          taskId: url.searchParams.get('taskId') || undefined,
          runId: url.searchParams.get('runId') || undefined,
          sessionId: url.searchParams.get('sessionId') || undefined,
          roadmapId: url.searchParams.get('roadmapId') || undefined,
          projectId: url.searchParams.get('projectId') || undefined,
        },
      })
      if (!unredacted) auditHttp(req, 'evidence.export.redacted', bundle.manifest.id, 'ok')
      if (url.searchParams.get('format') === 'markdown') return { status: 200, body: bundle.markdown, contentType: 'text/markdown; charset=utf-8' }
      return json(bundle)
    }

    if (req.method === 'GET' && url.pathname === '/governance') {
      return json({ governance: buildGovernanceReport() })
    }

    if (req.method === 'GET' && url.pathname === '/analytics') {
      // Read-only run-history analytics over a bounded, indexed SQL window.
      const request = parseAnalyticsRequestFromParams(url.searchParams)
      const analytics = url.searchParams.get('view') === 'scorecard'
        ? buildAnalyticsScorecard(request)
        : buildAnalyticsSummary(request)
      return json({ analytics })
    }

    if (req.method === 'GET' && url.pathname === '/attention') {
      const [questions, permissions] = await Promise.all([
        listPendingQuestions().catch(() => []),
        listPendingPermissions().catch(() => []),
      ])
      return json({ attention: buildNeedsAttentionReport({ questions, permissions }) })
    }

    if (req.method === 'GET' && url.pathname === '/triage') {
      // Performs no writes (though not guaranteed to open on a read-only
      // filesystem — it uses read-write DB handles for reads):
      // buildNeedsAttentionReport(readOnly) never creates gates — a pending
      // manual gate is surfaced as a synthesized virtual item without being
      // inserted — and listAlertsReadOnly reads the durable active-alert
      // snapshot (kept fresh by the heartbeat's alert engine) without running
      // the mutating detector, so triage mutates no state.
      const [questions, permissions] = await Promise.all([
        listPendingQuestions().catch(() => []),
        listPendingPermissions().catch(() => []),
      ])
      const attention = buildNeedsAttentionReport({ questions, permissions, readOnly: true })
      const alerts = listAlertsReadOnly({ status: 'open' })
      return json({ triage: buildTriageReport({ attention, alerts }) })
    }

    if (req.method === 'GET' && url.pathname === '/operator/status') {
      return json({ operator: await buildOperatorSafetyReport(client, { readOnly: true }) })
    }

    if (req.method === 'GET' && url.pathname === '/operator/hygiene') {
      return json({ hygiene: await buildLiveStateHygieneReport(client, { readOnly: true }) })
    }

    if (req.method === 'POST' && url.pathname === '/operator/actions') {
      const body = await readJsonBodyAs(req, zOperatorActionBody)
      const action = body.action
      return json({ operatorAction: await applyOperatorSafetyAction(action, client) })
    }

    const operatorRunActionMatch = pathMatch(url.pathname, /^\/operator\/runs\/([^/]+)\/actions$/)
    if (req.method === 'POST' && operatorRunActionMatch) {
      const body = await readJsonBodyAs(req, zActiveRunControlBody)
      const action = body.action
      const result = await applyOperatorActiveRunControl({
        runId: operatorRunActionMatch[0],
        action,
        note: body.note === undefined ? undefined : String(body.note),
        expectedLeaseOwner: body.expectedLeaseOwner === undefined ? undefined : String(body.expectedLeaseOwner),
        expectedSchedulerGeneration: body.expectedSchedulerGeneration === undefined ? undefined : String(body.expectedSchedulerGeneration),
        actor: 'operator-http',
        source: 'operator-http',
      }, client)
      return json({ activeRunControl: result })
    }

    if (req.method === 'GET' && url.pathname === '/alerts') {
      const [opencodeReachable, questions, permissions] = await Promise.all([
        checkOpenCodeReachable().catch(() => false),
        listPendingQuestions().catch(() => []),
        listPendingPermissions().catch(() => []),
      ])
      const snapshot = buildObservabilitySnapshot({ readOnly: true })
      return json({
        alerts: snapshot.alerts,
        metrics: buildReadOnlyAlertMetrics(snapshot, { opencodeReachable, questions: questions.length, permissions: permissions.length }),
      })
    }

    if (req.method === 'POST' && url.pathname === '/alerts/evaluate') {
      const opencodeReachable = await checkOpenCodeReachable().catch(() => false)
      const result = await runAlertEngine({ opencodeReachable })
      return json({ alerts: result.active, detected: result.detected, metrics: result.metrics })
    }

    const alertActionMatch = pathMatch(url.pathname, /^\/alerts\/([^/]+)\/action$/)
    if (req.method === 'POST' && alertActionMatch) {
      const body = await readJsonBodyAs(req, zAlertActionBody)
      const alert = updateAlertStatus(alertActionMatch[0], body.action, { note: body.note, suppressMs: body.suppressMs === undefined ? undefined : Number(body.suppressMs) })
      if (!alert) return json({ error: 'alert not found' }, 404)
      return json({ alert })
    }

    if (req.method === 'GET' && url.pathname === '/observability') {
      const opencodeReachable = await checkOpenCodeReachable().catch(() => false)
      const snapshot = buildObservabilitySnapshot()
      return json({ metrics: buildObservabilityMetrics({ opencodeReachable }, snapshot.alerts), runtime: getRuntimeMetricsSnapshot(), alerts: snapshot.alerts, supervisors: buildSupervisorObservability(), environments: listWorkEnvironments(), trace: snapshot.trace, slo: snapshot.slo, support: snapshot.support })
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      // Read surface (GET → 'read' capability): Prometheus text exposition of
      // real counters, gauges, and SLO-latency histograms. Observations are fed
      // from the durable snapshot so histograms carry real data and run counters
      // reconcile against actual state without hooking the scheduler internals.
      const snapshot = buildObservabilitySnapshot({ readOnly: true })
      const leadership = getCurrentDaemonLeadershipStatus()
      const queueDepth = snapshot.state.tasks.filter(task => task.status === 'pending' || task.status === 'running' || task.status === 'blocked').length
      const activeRuns = snapshot.state.runs.filter(run => run.status === 'running').length
      const body = renderPrometheusMetrics({
        queueDepth,
        activeRuns,
        leadershipWriter: leadership.canWrite,
        alertsActive: snapshot.alerts.length,
        runs: snapshot.state.runs.map(run => ({ id: run.id, status: run.status })),
        slo: snapshot.slo,
      })
      return { status: 200, body, contentType: 'text/plain; version=0.0.4; charset=utf-8' }
    }

    if (req.method === 'GET' && url.pathname === '/incident-report') {
      return json({ report: generateIncidentReport(url.searchParams.get('alertId') || undefined) })
    }

    if (req.method === 'GET' && url.pathname === '/incident-bundle') {
      const bundle = buildIncidentBundle({
        alertId: url.searchParams.get('alertId') || undefined,
        target: {
          taskId: url.searchParams.get('taskId') || undefined,
          runId: url.searchParams.get('runId') || undefined,
          sessionId: url.searchParams.get('sessionId') || undefined,
          roadmapId: url.searchParams.get('roadmapId') || undefined,
          projectId: url.searchParams.get('projectId') || undefined,
        },
      })
      auditHttp(req, 'incident.bundle.redacted', bundle.manifest.id, 'ok')
      if (url.searchParams.get('format') === 'markdown') return { status: 200, body: bundle.markdown, contentType: 'text/markdown; charset=utf-8' }
      return json(bundle)
    }

    if (req.method === 'GET' && url.pathname === '/logs') {
      const lines = Number(url.searchParams.get('lines') || 100)
      return json({ logs: readGatewayLogLines(lines) })
    }

    if (req.method === 'GET' && url.pathname === '/config') {
      const redact = url.searchParams.get('redact') !== 'false'
      const limited = guardUnredactedExport(req, {
        operation: 'config.read.unredacted',
        target: 'config',
        unredacted: !redact,
        url,
      })
      if (limited) return limited
      return json({ config: redact ? redactGatewayConfig(getConfig()) : getConfig(), path: getConfigPath() })
    }

    if (req.method === 'GET' && url.pathname === '/storage/backups') {
      return json({ backups: listStorageBackups() })
    }

    if (req.method === 'GET' && url.pathname === '/storage/doctor') {
      const report = runStorageDoctor({ backupPath: url.searchParams.get('backupPath') || undefined })
      return json({ storage: report }, report.status === 'down' ? 503 : 200)
    }

    if (req.method === 'POST' && url.pathname === '/storage/backups') {
      const body = await readJsonBodyAs(req, zStorageBackupCreateBody)
      const backup = createStorageBackup({ label: body.label ? String(body.label) : undefined, retention: body.retention === undefined ? undefined : Number(body.retention), allowActiveRuns: body.allowActiveRuns === true })
      auditHttp(req, 'storage.backup.create', backup.id, 'ok')
      return json({ backup })
    }

    if (req.method === 'POST' && url.pathname === '/storage/backups/verify') {
      const body = await readJsonBodyAs(req, zStorageBackupVerifyBody)
      const verification = verifyStorageBackup(String(body.path || ''))
      auditHttp(req, 'storage.backup.verify', verification.path, verification.ok ? 'ok' : 'error')
      return json({ verification }, verification.ok ? 200 : 422)
    }

    if (req.method === 'POST' && url.pathname === '/storage/recovery-drills') {
      const body = await readJsonBodyAs(req, zStorageRecoveryDrillBody)
      try {
        const drill = await runStorageRecoveryDrill({
          backupPath: body.path ? String(body.path) : undefined,
          label: body.label ? String(body.label) : undefined,
          outputDir: body.outputDir ? String(body.outputDir) : undefined,
          retryLimit: body.retryLimit === undefined ? undefined : Number(body.retryLimit),
        })
        auditHttp(req, 'storage.recovery_drill', drill.id, drill.status === 'pass' ? 'ok' : 'error')
        return json({ drill }, drill.status === 'pass' ? 200 : 422)
      } catch (err: any) {
        const message = err?.message || String(err)
        if (!message.startsWith('recovery drill refused backup:')) throw err
        auditHttp(req, 'storage.recovery_drill', body.path ? String(body.path) : 'latest-backup', 'error')
        return json({ error: message }, 422)
      }
    }

    if (req.method === 'GET' && url.pathname === '/storage/export') {
      // Full state dump is always unredacted-sensitive (JOE-952 / post-#959 SEC-2).
      const limited = guardUnredactedExport(req, {
        operation: 'storage.export.unredacted',
        target: 'gateway-state',
        unredacted: true,
        url,
      })
      if (limited) return limited
      return json(exportGatewayState())
    }

    if (req.method === 'POST' && url.pathname === '/storage/restore') {
      const body = await readJsonBodyAs(req, zStorageRestoreBody)
      if (wantsDryRun(url, body)) return json({ preview: previewStorageRestore(String(body.path || '')) })
      const approval = requireDestructiveHttpApproval(req, body, 'storage.restore', String(body.path || ''))
      if (approval) return approval
      const restored = await restoreStorageBackup(String(body.path || ''), { maintenanceMode: body.maintenanceMode === true, skipSafetyBackup: body.skipSafetyBackup === true })
      consumeDestructiveHttpApproval(req, body, 'storage.restore')
      auditHttp(req, 'storage.restore', restored.verification.path, 'ok')
      return json(restored)
    }

    if (req.method === 'PATCH' && url.pathname === '/config') {
      const body = await readJsonBodyAs(req, zConfigPatchBody)
      if (wantsDryRun(url, body)) return json({ preview: previewConfigUpdate(body) })
      const approval = requireDestructiveHttpApproval(req, body, 'config.update', 'config')
      if (approval) return approval
      const config = updateConfig(stripApprovalFields(body))
      consumeDestructiveHttpApproval(req, body, 'config.update')
      auditHttp(req, 'config.update', 'config', 'ok')
      return json({ config: redactGatewayConfig(config), path: getConfigPath() })
    }

    // Shutdown/restart are process-lifecycle operations, not data-destructive
    // ones: graceful shutdown preserves all durable state and a local operator
    // can always SIGTERM the process anyway, so a channel-routed human gate adds
    // no protection and only breaks `opencode-gateway stop`. They still require
    // the `admin` HTTP capability and are audited.
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      await readJsonBody(req)
      auditHttp(req, 'daemon.shutdown', 'daemon', 'ok')
      return json({ ok: true }, 200, () => requestDaemonShutdown({ reason: 'http /shutdown' }))
    }

    if (req.method === 'POST' && url.pathname === '/restart') {
      await readJsonBody(req)
      auditHttp(req, 'daemon.restart', 'daemon', 'ok')
      return json(
        { ok: true, message: 'Gateway restart requested. Service manager will restart the daemon if installed.' },
        200,
        // Exit non-zero so on-failure restart policies (launchd KeepAlive
        // SuccessfulExit=false, systemd Restart=on-failure) respawn the daemon;
        // a clean exit would intentionally stay down.
        () => requestDaemonShutdown({ reason: 'http /restart', exitCode: 1 }),
      )
    }

    return undefined
  }]
}

function buildReadOnlyAlertMetrics(
  snapshot: ObservabilitySnapshot,
  input: { opencodeReachable: boolean; questions: number; permissions: number },
): ObservabilityMetrics {
  const config = getConfig()
  const now = Date.parse(snapshot.generatedAt)
  const runs = snapshot.state.runs
  const completedRuntimes = runs
    .filter(run => run.completedAt && Number(run.runtimeMs) > 0)
    .map(run => Number(run.runtimeMs))
  const environments = runs.map(run => run.environment).filter(Boolean)
  const costUsd = runs.reduce((sum, run) => sum + Number(run.costUsd || 0), 0)
  const tokens = runs.reduce((sum, run) => sum
    + Number(run.inputTokens || 0)
    + Number(run.outputTokens || 0)
    + Number(run.reasoningTokens || 0)
    + Number(run.cacheReadTokens || 0)
    + Number(run.cacheWriteTokens || 0), 0)
  const averageRuntimeMs = completedRuntimes.length
    ? Math.round(completedRuntimes.reduce((sum, value) => sum + value, 0) / completedRuntimes.length)
    : 0
  const openGates = (() => {
    try { return listHumanGatesReadOnly({ status: 'open' }).length } catch { return 0 }
  })()
  return {
    generatedAt: snapshot.generatedAt,
    scheduler: {
      enabled: config.scheduler.enabled,
      maxConcurrent: config.scheduler.maxConcurrent,
      intervalMs: config.scheduler.intervalMs,
    },
    queue: {
      pending: snapshot.state.tasks.filter(task => task.status === 'pending').length,
      running: snapshot.state.tasks.filter(task => task.status === 'running').length,
      blocked: snapshot.state.tasks.filter(task => task.status === 'blocked').length,
      paused: snapshot.state.tasks.filter(task => task.status === 'paused').length,
      done: snapshot.state.tasks.filter(task => task.status === 'done').length,
    },
    runs: {
      total: runs.length,
      running: runs.filter(run => run.status === 'running').length,
      failedLastHour: runs.filter(run => ['failed', 'blocked', 'errored'].includes(run.status)
        && Date.parse(run.completedAt || run.startedAt) >= now - 60 * 60 * 1000).length,
      averageRuntimeMs,
    },
    environments: {
      total: environments.length,
      active: environments.filter(environment => environment?.status === 'prepared' || environment?.status === 'blocked').length,
      retained: environments.filter(environment => environment?.status === 'retained').length,
      cleanupFailed: environments.filter(environment => environment?.status === 'cleanup_failed').length,
    },
    cost: { totalUsd: costUsd, tokens },
    human: { gates: openGates, questions: input.questions, permissions: input.permissions },
    channels: {
      bindings: snapshot.channelBindings.length,
      recentFailures: snapshot.events.filter(event => /channel sync .*failed|send failed|rejected untrusted/i.test(JSON.stringify(event.payload || {}))).length,
    },
    opencode: { reachable: input.opencodeReachable },
    alerts: {
      active: snapshot.alerts.length,
      critical: snapshot.alerts.filter(alert => alert.severity === 'critical').length,
      warning: snapshot.alerts.filter(alert => alert.severity === 'warning').length,
    },
  }
}

export async function buildDoctorReport(client: any): Promise<Record<string, unknown>> {
  const cfg = getConfig()
  const snapshot = getWorkQueueSnapshot()
  let opencode: Record<string, unknown> = { ok: false }
  try {
    const res = await openCodeFetch(cfg.opencodeUrl, 'global/health', {}, { timeoutMs: 2000 })
    opencode = { ok: res.ok, status: res.status, ...(res.ok ? await res.json() as any : {}) }
  } catch (err: any) {
    opencode = { ok: false, error: redactSensitiveText(err?.message || String(err)) }
  }
  let sessions = 0
  try {
    const { createOpenCodeSessionRuntime } = await import('../opencode-session-runtime.js')
    sessions = (await createOpenCodeSessionRuntime(client).listSessions()).length
  } catch {}
  return {
    daemon: { ok: true, uptime: process.uptime(), pid: process.pid, port: cfg.httpPort },
    opencode,
    scheduler: cfg.scheduler,
    heartbeat: getHeartbeatStatus(),
    counts: snapshot.counts,
    gatewaySessions: getWorkerCounts(),
    sessions,
    config: { path: getConfigPath(), value: redactGatewayConfig(cfg) },
    storage: runStorageDoctor(),
    security: {
      httpHost: cfg.security.httpHost,
      allowNonLocalHttp: cfg.security.allowNonLocalHttp,
      publicWebhookMode: cfg.security.publicWebhookMode,
      unsafeAllowNoAuth: cfg.security.unsafeAllowNoAuth,
      httpAuth: getHttpAuthPosture(),
    },
    files: gatewayFileStatus(),
  }
}

function gatewayFileStatus(): Record<string, unknown> {
  const dir = path.dirname(getConfigPath())
  const files = [
    getConfigPath(),
    path.join(dir, 'gateway.db'),
    path.join(dir, 'channel-sync.json'),
    path.join(dir, 'channel-sync.json.sqlite'),
    path.join(dir, 'operational-sidecar.sqlite'),
    path.join(dir, 'events.json'),
    path.join(dir, 'sessions.json'),
  ]
  return Object.fromEntries(files.map(file => [file, fileStatus(file)]))
}

function fileStatus(file: string): Record<string, unknown> {
  try {
    const stat = fs.statSync(file)
    return { exists: true, mode: (stat.mode & 0o777).toString(8), size: stat.size, updatedAt: stat.mtime.toISOString() }
  } catch {
    return { exists: false }
  }
}

export function redactGatewayConfig(config: any): any {
  return redactSensitiveObject(JSON.parse(JSON.stringify(config)), config)
}

/**
 * A destructive route serves a mutation-free blast-radius preview instead of
 * acting when the caller opts into dry-run via ?dryRun=true / ?preview=true or a
 * { dryRun: true } / { preview: true } body field. Absent the opt-in, behavior is
 * identical to before.
 */
function wantsDryRun(url: URL, body?: any): boolean {
  const flag = url.searchParams.get('dryRun') || url.searchParams.get('preview')
  if (flag === 'true' || flag === '1') return true
  return body?.dryRun === true || body?.preview === true
}

function previewStorageRestore(backupPath: string): Record<string, unknown> {
  const snapshot = getWorkQueueSnapshot()
  let verification: Record<string, unknown>
  try {
    verification = verifyStorageBackup(backupPath) as unknown as Record<string, unknown>
  } catch (err: any) {
    verification = { ok: false, path: backupPath, error: redactSensitiveText(err?.message || String(err)) }
  }
  return {
    operation: 'storage.restore',
    dryRun: true,
    mutates: false,
    backup: verification,
    currentState: snapshot.counts,
    summary: `Would replace the live Gateway durable state (task counts: ${JSON.stringify(snapshot.counts)}) with the contents of backup ${backupPath || '(unspecified)'}. A safety backup is taken first unless skipSafetyBackup=true.`,
  }
}

function previewConfigUpdate(body: any): Record<string, unknown> {
  const patch = stripApprovalFields(body && typeof body === 'object' ? { ...body, dryRun: undefined, preview: undefined } : {})
  const affectedKeys = Object.keys(patch).filter(key => patch[key] !== undefined)
  return {
    operation: 'config.update',
    dryRun: true,
    mutates: false,
    affectedKeys,
    proposedPatch: redactSensitiveObject(JSON.parse(JSON.stringify(patch)), getConfig()),
    summary: `Would merge and re-normalize ${affectedKeys.length} top-level config section(s): ${affectedKeys.join(', ') || '(none)'}. The current config is backed up before write.`,
  }
}

async function checkOpenCodeReachable(): Promise<boolean> {
  try {
    const res = await openCodeFetch(getConfig().opencodeUrl, 'global/health', {}, { timeoutMs: 2000 })
    return res.ok
  } catch {
    return false
  }
}
