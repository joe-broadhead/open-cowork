import { buildChannelConnectorRegistry } from './channel-connectors.js'
import { listChannelSessions, listChannelSessionsReadOnly, type ChannelSessionLink } from './channel-sessions.js'
import { listActiveChannelClaimCodeRefsReadOnly } from './channel-claims.js'
import { getChannelSyncSummary, type ChannelSyncSummary } from './channel-sync.js'
import { buildCapacityReport, type GatewayCapacityReport } from './capacity.js'
import { getConfig, updateConfig, type GatewayConfig } from './config.js'
import { buildGovernanceReport } from './governance.js'
import { buildNeedsAttentionReport } from './human-loop.js'
import { applyLiveStateHygieneReset, buildLiveStateHygieneReport, type LiveStateHygieneReport } from './live-state-hygiene.js'
import { listPendingPermissions, listPendingQuestions } from './opencode-requests.js'
import { buildReadinessReport } from './readiness.js'
import { recoverMissingOpenCodeRuns } from './scheduler.js'
import { redactSensitiveText } from './security.js'
import {
  appendAuditEvent,
  applyActiveRunControl,
  emptyWorkState,
  listActiveRunControlSnapshots,
  listAlerts,
  listAlertsReadOnly,
  listHumanGates,
  listHumanGatesReadOnly,
  listWorkEvents,
  listWorkEventsReadOnly,
  loadWorkState,
  loadWorkStateReadOnly,
  recoverExpiredWorkLeases,
  summarizeWorkLeases,
  summarizeWorkTasks,
  type ActiveRunControlAction,
  type ActiveRunControlInput,
  type ActiveRunControlResult,
  type ActiveRunControlSnapshot,
  type WorkState,
} from './work-store.js'

export type OperatorSafetyState = 'ready_for_beta' | 'attention' | 'paused' | 'blocked'
export type OperatorSafetyAction = 'status' | 'hygiene' | 'pause' | 'resume' | 'recover' | 'reset-stale'

export interface OperatorSafetyReport {
  generatedAt: string
  state: OperatorSafetyState
  summary: string
  releaseClaim: {
    scope: string
    productionCertified: false
    notes: string[]
  }
  scheduler: {
    enabled: boolean
    maxConcurrent: number
    intervalMs: number
    runningRuns: number
    expiredLeases: number
    availableSlots: number
    leaseOwners: Record<string, number>
  }
  capacity: GatewayCapacityReport
  queue: ReturnType<typeof summarizeWorkTasks>
  activeRuns: ActiveRunControlSnapshot[]
  readiness: {
    state: string
    summary: string
    critical: number
    warnings: number
  }
  requests: {
    questionsAvailable: boolean
    permissionsAvailable: boolean
    errors: string[]
  }
  governance: {
    status: string
    summary: string
  }
  channels: {
    ready: string[]
    needsAttention: Array<{ provider: string; state: string; nextAction?: string }>
    deferred: Array<{ gate: string; reason: string }>
  }
  hygiene: {
    status: LiveStateHygieneReport['status']
    summary: string
    staleSignals: number
    resettable: number
  }
  attention: {
    gates: number
    questions: number
    permissions: number
    alerts: number
    criticalAlerts: number
    items: Array<{ kind: string; title: string; summary: string; nextAction: string }>
  }
  actions: Array<{
    action: OperatorSafetyAction | 'run-control'
    command: string
    description: string
  }>
}

export interface OperatorActionResult {
  action: OperatorSafetyAction
  applied: boolean
  result?: Record<string, unknown>
  report: OperatorSafetyReport
}

export async function buildOperatorSafetyReport(client?: any, options: { now?: Date; config?: GatewayConfig; state?: WorkState; readOnly?: boolean } = {}): Promise<OperatorSafetyReport> {
  const generatedAt = (options.now || new Date()).toISOString()
  const config = options.config || getConfig()
  const state = options.state || (options.readOnly ? loadWorkStateReadOnlySafe() : loadWorkState())
  const queue = summarizeWorkTasks(state.tasks)
  const leases = summarizeWorkLeases(state, Date.parse(generatedAt))
  const [readiness, questionSource, permissionSource, hygiene] = await Promise.all([
    buildReadinessReport(client, { readOnly: options.readOnly }).catch((err: any) => ({ state: 'not_ready', summary: err?.message || String(err), checks: [] })),
    listPendingQuestions()
      .then(rows => ({ available: true, rows, error: undefined as string | undefined }))
      .catch((err: any) => ({ available: false, rows: [], error: err?.message || String(err) })),
    listPendingPermissions()
      .then(rows => ({ available: true, rows, error: undefined as string | undefined }))
      .catch((err: any) => ({ available: false, rows: [], error: err?.message || String(err) })),
    buildLiveStateHygieneReport(client, { now: new Date(generatedAt), config, state, readOnly: options.readOnly })
      .catch((err: any): LiveStateHygieneReport => ({
        generatedAt,
        status: 'attention',
        summary: redactSensitiveText(err?.message || String(err), config).substring(0, 300),
        releaseClaim: {
          scope: 'Local beta live-state hygiene only: reset stale support clutter without expanding public release or production claims.',
          productionCertified: false,
          notes: ['Hygiene diagnostics failed closed; no release or production claim is changed.'],
        },
        openCodeSessions: { checked: false, reachable: false, count: 0 },
        counts: { expired_claim_code: 0, stale_human_gate: 0, stale_session_link: 0, stale_parent_receipt: 0, session_source_unavailable: 0 },
        resettable: { total: 0, expiredClaimCodes: 0, expiredHumanGates: 0 },
        items: [],
      })),
  ])
  const questions = questionSource.rows
  const permissions = permissionSource.rows
  const requestSourceErrors = [questionSource.error, permissionSource.error].filter(Boolean) as string[]
  const requestSourcesUnavailable = !questionSource.available || !permissionSource.available
  const governance = buildGovernanceReport(state, config)
  const alerts = options.readOnly ? listAlertsReadOnlySafe({ status: 'open' }) : listAlerts({ status: 'open' })
  const activeRunEvents = options.readOnly ? listWorkEventsReadOnlySafe(250) : listWorkEvents(250)
  const activeRuns = listActiveRunControlSnapshots(state, activeRunEvents, Date.parse(generatedAt))
  const connectorRegistry = buildChannelConnectorRegistry({
    config,
    bindings: [
      ...(options.readOnly ? listChannelSessionsReadOnlySafe() : listChannelSessions()),
      ...channelBindingsFromProjectBindings(state),
    ],
    activeClaimRefs: options.readOnly ? activeClaimRefsReadOnlySafe(new Date(generatedAt)) : undefined,
    generatedAt,
  })
  const gates = options.readOnly ? listHumanGatesReadOnlySafe({ status: 'open' }) : listHumanGates({ status: 'open' })
  const attentionReport = buildNeedsAttentionReport({ state, gates, questions, permissions, config, readOnly: options.readOnly })
  const readinessChecks = Array.isArray((readiness as any).checks) ? (readiness as any).checks : []
  const criticalReadiness = readinessChecks.filter((check: any) => check.severity === 'critical' && check.status !== 'pass').length
  const warningReadiness = readinessChecks.filter((check: any) => check.severity !== 'critical' && check.status !== 'pass').length
  const criticalAlerts = alerts.filter(alert => alert.severity === 'critical').length
  const capacity = buildCapacityReport({ state, config, channelSync: options.readOnly ? getChannelSyncSummarySafe() : getChannelSyncSummary(), humanGates: gates, now: Date.parse(generatedAt) })
  const staleLiveState = hygiene.items.length
  const blocked = (readiness as any).state === 'not_ready' || governance.status === 'blocked' || criticalReadiness > 0 || criticalAlerts > 0
  const paused = !config.scheduler.enabled
  const attention = blocked
    ? 'blocked'
    : paused
      ? 'paused'
      : requestSourcesUnavailable || gates.length || questions.length || permissions.length || alerts.length || leases.expired || queue.blocked || staleLiveState
        ? 'attention'
        : 'ready_for_beta'

  const channelRows = connectorRegistry.connectors
  const readyChannels = channelRows
    .filter(connector => connector.state === 'ready')
    .map(connector => connector.provider)
  const needsAttention = channelRows
    .filter(connector => !readyChannels.includes(connector.provider) && connector.provider !== 'whatsapp')
    .map(connector => ({
      provider: connector.provider,
      state: connector.state,
      nextAction: connector.onboardingFlow?.primaryAction?.command || connector.onboardingFlow?.primaryAction?.summary,
    }))

  return {
    generatedAt,
    state: attention,
    summary: summaryForState(attention, { queue, gates: gates.length, questions: questions.length, permissions: permissions.length, alerts: alerts.length, expired: leases.expired, staleLiveState }),
    releaseClaim: {
      scope: 'Public local beta readiness for one trusted operator using OpenCode Web/TUI and validated trusted channel surfaces.',
      productionCertified: false,
      notes: [
        'The public release decision supports public local beta only; local production certification remains deferred until elapsed soak evidence and an affirmative production decision complete.',
        'Hosted, team, multi-tenant, and remote-worker claims remain deferred to the architecture-readiness tranche.',
        'WhatsApp live parity remains deferred until live provider proof is captured.',
        'This report is redacted and safe to share with operators.',
      ],
    },
    scheduler: {
      enabled: config.scheduler.enabled,
      maxConcurrent: config.scheduler.maxConcurrent,
      intervalMs: config.scheduler.intervalMs,
      runningRuns: leases.running,
      expiredLeases: leases.expired,
      availableSlots: Math.max(0, Number(config.scheduler.maxConcurrent || 0) - leases.running),
      leaseOwners: leases.owners,
    },
    capacity,
    queue,
    activeRuns,
    readiness: {
      state: String((readiness as any).state || 'unknown'),
      summary: String((readiness as any).summary || 'Readiness unavailable'),
      critical: criticalReadiness,
      warnings: warningReadiness,
    },
    requests: {
      questionsAvailable: questionSource.available,
      permissionsAvailable: permissionSource.available,
      errors: requestSourceErrors.map(message => redactSensitiveText(String(message), config).substring(0, 300)),
    },
    governance: {
      status: String(governance.status || 'unknown'),
      summary: String(governance.summary || 'Governance unavailable'),
    },
    channels: {
      ready: readyChannels,
      needsAttention,
      deferred: [
        { gate: 'whatsapp_live_parity', reason: 'Live WhatsApp proof is intentionally deferred for the next phase.' },
        { gate: 'production_soak', reason: 'Local production certification requires separate elapsed soak evidence and an affirmative production decision.' },
      ],
    },
    hygiene: {
      status: hygiene.status,
      summary: hygiene.summary,
      staleSignals: staleLiveState,
      resettable: hygiene.resettable.total,
    },
    attention: {
      gates: gates.length,
      questions: questions.length,
      permissions: permissions.length,
      alerts: alerts.length,
      criticalAlerts,
      items: attentionItems({ gates, questions, permissions, alerts, attentionReport, leasesExpired: leases.expired, requestSourcesUnavailable }),
    },
    actions: operatorActions(config.scheduler.enabled),
  }
}

export async function applyOperatorSafetyAction(action: OperatorSafetyAction, client?: any): Promise<OperatorActionResult> {
  if (action === 'status') return { action, applied: false, report: await buildOperatorSafetyReport(client, { readOnly: true }) }
  if (action === 'hygiene') return { action, applied: false, result: { hygiene: await buildLiveStateHygieneReport(client, { readOnly: true }) }, report: await buildOperatorSafetyReport(client, { readOnly: true }) }
  if (action === 'pause') {
    const config = getConfig()
    updateConfig({ scheduler: { ...config.scheduler, enabled: false } } as Partial<GatewayConfig>)
    auditOperatorAction(action, 'scheduler', 'ok')
    return { action, applied: true, result: { scheduler: getConfig().scheduler }, report: await buildOperatorSafetyReport(client) }
  }
  if (action === 'resume') {
    const config = getConfig()
    updateConfig({ scheduler: { ...config.scheduler, enabled: true } } as Partial<GatewayConfig>)
    auditOperatorAction(action, 'scheduler', 'ok')
    return { action, applied: true, result: { scheduler: getConfig().scheduler }, report: await buildOperatorSafetyReport(client) }
  }
  if (action === 'recover') {
    const retryLimit = getConfig().scheduler.retryLimit
    const expired = recoverExpiredWorkLeases(retryLimit)
    const orphaned = client ? await recoverMissingOpenCodeRuns(client, loadWorkState(), retryLimit) : { recovered: 0, blocked: 0, runIds: [] }
    auditOperatorAction(action, 'work-runs', 'ok')
    return { action, applied: Boolean(expired.recovered || expired.blocked || orphaned.recovered || orphaned.blocked), result: { expired, orphaned }, report: await buildOperatorSafetyReport(client) }
  }
  if (action === 'reset-stale') {
    const hygiene = await applyLiveStateHygieneReset(client)
    auditOperatorAction(action, 'live-state-hygiene', 'ok')
    return {
      action,
      applied: hygiene.applied,
      result: {
        expiredClaimCodes: hygiene.expiredClaimCodes,
        processedHumanGates: hygiene.processedHumanGates,
        hygiene: hygiene.report,
      },
      report: await buildOperatorSafetyReport(client),
    }
  }
  throw new Error(`unknown operator action: ${action}`)
}

export async function applyOperatorActiveRunControl(input: ActiveRunControlInput, client?: any): Promise<{ control: ActiveRunControlResult; report: OperatorSafetyReport }> {
  const control = applyActiveRunControl({
    ...input,
    actor: input.actor || 'operator-cli',
    source: input.source || 'operator-safety',
  })
  if (control.applied && control.abortedSessionId) {
    await client?.session?.abort?.({ path: { id: control.abortedSessionId } }).catch(() => undefined)
  }
  auditOperatorRunControl(input.action, input.runId, control.reason === 'applied' ? 'ok' : control.outcome === 'denied' ? 'denied' : 'ok', input.actor || 'operator-cli', input.source || 'operator-safety', {
    reason: control.reason,
    outcome: control.outcome,
    restartBehavior: control.restartBehavior,
    taskId: control.task?.id,
  })
  return { control, report: await buildOperatorSafetyReport(client) }
}

export function formatOperatorSafetyText(input: Partial<OperatorSafetyReport> | undefined): string {
  const report = normalizeOperatorSafetyReportForText(input)
  const lines = [
    `Operator state: ${report.state}`,
    `Summary: ${report.summary}`,
    `Scope: ${report.releaseClaim.scope}`,
    `Production certified: no`,
    '',
    `Scheduler: ${report.scheduler.enabled ? 'enabled' : 'paused'} | ${report.scheduler.runningRuns}/${report.scheduler.maxConcurrent} running | ${report.scheduler.availableSlots} slots | ${report.scheduler.expiredLeases} expired leases`,
    `Capacity: ${report.capacity.scheduler.availableSlots} slots | ${report.capacity.scheduler.pending} pending | ${report.capacity.dimensions.filter(row => row.status !== 'ok').length} pressure dimensions | ${report.capacity.providerBackoff.length} provider backoff(s)`,
    `Queue: ${report.queue.pending} pending, ${report.queue.running} running, ${report.queue.blocked} blocked, ${report.queue.paused} paused, ${report.queue.done} done`,
    `Active runs: ${report.activeRuns.length}`,
    `Readiness: ${report.readiness.state} | ${report.readiness.summary}`,
    `Governance: ${report.governance.status} | ${report.governance.summary}`,
    `Live-state hygiene: ${report.hygiene.status} | ${report.hygiene.summary}`,
    `Channels ready: ${report.channels.ready.length ? report.channels.ready.join(', ') : 'none'}`,
    `Attention: ${report.attention.gates} gates, ${report.attention.questions} questions, ${report.attention.permissions} permissions, ${report.attention.alerts} alerts`,
  ]
  if (report.attention.items.length) {
    lines.push('', 'Needs attention:')
    for (const item of report.attention.items.slice(0, 8)) lines.push(`- ${item.title}: ${item.summary} Next: ${item.nextAction}`)
  }
  const pressureRows = report.capacity.dimensions.filter(row => row.status !== 'ok').slice(0, 8)
  if (pressureRows.length) {
    lines.push('', 'Capacity pressure:')
    for (const row of pressureRows) lines.push(`- ${row.dimension}:${row.key} ${row.used}/${row.limit} (${row.pending} pending)`)
  }
  if (report.capacity.providerBackoff.length) {
    lines.push('', 'Provider backoff:')
    for (const row of report.capacity.providerBackoff.slice(0, 5)) lines.push(`- ${row.provider}: retry after ${row.retryAfter} (${row.pending} pending)`)
  }
  if (report.activeRuns.length) {
    lines.push('', 'Active runs:')
    for (const run of report.activeRuns.slice(0, 8)) {
      const control = run.cancellable
        ? `cancel: opencode-gateway operator run ${run.runId} cancel --lease-owner ${run.leaseOwner || 'unknown'}`
        : `control blocked: ${run.heartbeatFreshness}`
      const last = run.lastOperatorAction ? ` last ${run.lastOperatorAction.action}/${run.lastOperatorAction.outcome}` : ''
      lines.push(`- [${run.heartbeatFreshness}] ${run.stage} ${run.runId} task=${run.taskId} lease=${run.leaseOwner || 'missing'}${last}; ${control}`)
    }
  }
  lines.push('', 'Deferred release gates:')
  for (const gate of report.channels.deferred) lines.push(`- ${gate.gate}: ${gate.reason}`)
  lines.push('', 'Operator commands:')
  for (const action of report.actions) lines.push(`- ${action.command} - ${action.description}`)
  return lines.join('\n')
}

function normalizeOperatorSafetyReportForText(input: Partial<OperatorSafetyReport> | undefined): OperatorSafetyReport {
  const report = (input || {}) as any
  const scheduler = { ...(report.scheduler || {}) }
  const capacity = { ...(report.capacity || {}) }
  const capacityScheduler = { ...(capacity.scheduler || {}) }
  const queue = { ...(report.queue || {}) }
  const readiness = { ...(report.readiness || {}) }
  const governance = { ...(report.governance || {}) }
  const hygiene = { ...(report.hygiene || {}) }
  const channels = { ...(report.channels || {}) }
  const attention = { ...(report.attention || {}) }
  return {
    generatedAt: String(report.generatedAt || new Date(0).toISOString()),
    state: (report.state || 'attention') as OperatorSafetyState,
    summary: String(report.summary || 'Operator report is incomplete; local fallback data may be partial.'),
    releaseClaim: {
      scope: String(report.releaseClaim?.scope || 'Public local beta readiness for one trusted local operator.'),
      productionCertified: false,
      notes: Array.isArray(report.releaseClaim?.notes) ? report.releaseClaim.notes.map(String) : [],
    },
    scheduler: {
      enabled: Boolean(scheduler.enabled),
      maxConcurrent: Number(scheduler.maxConcurrent || 0),
      intervalMs: Number(scheduler.intervalMs || 0),
      runningRuns: Number(scheduler.runningRuns || 0),
      expiredLeases: Number(scheduler.expiredLeases || 0),
      availableSlots: Number(scheduler.availableSlots || 0),
      leaseOwners: scheduler.leaseOwners && typeof scheduler.leaseOwners === 'object' ? scheduler.leaseOwners : {},
    },
    capacity: {
      generatedAt: String(capacity.generatedAt || report.generatedAt || new Date(0).toISOString()),
      scheduler: {
        running: Number(capacityScheduler.running || 0),
        starting: Number(capacityScheduler.starting || 0),
        maxConcurrent: Number(capacityScheduler.maxConcurrent || scheduler.maxConcurrent || 0),
        availableSlots: Number(capacityScheduler.availableSlots || scheduler.availableSlots || 0),
        pending: Number(capacityScheduler.pending || 0),
        oldestPending: capacityScheduler.oldestPending,
      },
      dimensions: Array.isArray(capacity.dimensions) ? capacity.dimensions : [],
      providerBackoff: Array.isArray(capacity.providerBackoff) ? capacity.providerBackoff : [],
      humanGatePressure: Number(capacity.humanGatePressure || 0),
    },
    queue: {
      total: Number(queue.total || 0),
      pending: Number(queue.pending || 0),
      running: Number(queue.running || 0),
      done: Number(queue.done || 0),
      blocked: Number(queue.blocked || 0),
      paused: Number(queue.paused || 0),
      cancelled: Number(queue.cancelled || 0),
      archived: Number(queue.archived || 0),
      high: Number(queue.high || 0),
      medium: Number(queue.medium || 0),
      low: Number(queue.low || 0),
    } as OperatorSafetyReport['queue'],
    activeRuns: Array.isArray(report.activeRuns) ? report.activeRuns : [],
    readiness: {
      state: String(readiness.state || 'unknown'),
      summary: String(readiness.summary || 'Readiness unavailable'),
      critical: Number(readiness.critical || 0),
      warnings: Number(readiness.warnings || 0),
    },
    requests: {
      questionsAvailable: Boolean(report.requests?.questionsAvailable),
      permissionsAvailable: Boolean(report.requests?.permissionsAvailable),
      errors: Array.isArray(report.requests?.errors) ? report.requests.errors.map(String) : [],
    },
    governance: {
      status: String(governance.status || 'unknown'),
      summary: String(governance.summary || 'Governance unavailable'),
    },
    channels: {
      ready: Array.isArray(channels.ready) ? channels.ready.map(String) : [],
      needsAttention: Array.isArray(channels.needsAttention) ? channels.needsAttention : [],
      deferred: Array.isArray(channels.deferred) ? channels.deferred : [],
    },
    hygiene: {
      status: hygiene.status || 'attention',
      summary: String(hygiene.summary || 'Live-state hygiene unavailable'),
      staleSignals: Number(hygiene.staleSignals || 0),
      resettable: Number(hygiene.resettable || 0),
    },
    attention: {
      gates: Number(attention.gates || 0),
      questions: Number(attention.questions || 0),
      permissions: Number(attention.permissions || 0),
      alerts: Number(attention.alerts || 0),
      criticalAlerts: Number(attention.criticalAlerts || 0),
      items: Array.isArray(attention.items) ? attention.items : [],
    },
    actions: Array.isArray(report.actions) ? report.actions : operatorActions(Boolean(scheduler.enabled)),
  }
}

function loadWorkStateReadOnlySafe(): WorkState {
  try {
    return loadWorkStateReadOnly()
  } catch {
    return emptyWorkState()
  }
}

function listAlertsReadOnlySafe(filter: Parameters<typeof listAlertsReadOnly>[0]): ReturnType<typeof listAlertsReadOnly> {
  try {
    return listAlertsReadOnly(filter)
  } catch {
    return []
  }
}

function listHumanGatesReadOnlySafe(filter: Parameters<typeof listHumanGatesReadOnly>[0]): ReturnType<typeof listHumanGatesReadOnly> {
  try {
    return listHumanGatesReadOnly(filter)
  } catch {
    return []
  }
}

function listWorkEventsReadOnlySafe(limit: number): ReturnType<typeof listWorkEventsReadOnly> {
  try {
    return listWorkEventsReadOnly(limit)
  } catch {
    return []
  }
}

function listChannelSessionsReadOnlySafe(): ChannelSessionLink[] {
  try {
    return listChannelSessionsReadOnly()
  } catch {
    return []
  }
}

function getChannelSyncSummarySafe(): ChannelSyncSummary {
  try {
    return getChannelSyncSummary()
  } catch {
    return { active: false, deliveriesTracked: 0, pendingInbound: 0, outbox: { pending: 0, leased: 0, delivered: 0, deadLetter: 0, providerBackoff: [] } }
  }
}

function activeClaimRefsReadOnlySafe(now: Date): Record<string, string[]> {
  const refs: Record<string, string[]> = {}
  for (const provider of ['telegram', 'whatsapp', 'discord']) {
    try {
      refs[provider] = listActiveChannelClaimCodeRefsReadOnly(provider, now)
    } catch {
      refs[provider] = []
    }
  }
  return refs
}

function channelBindingsFromProjectBindings(state: WorkState): ChannelSessionLink[] {
  return state.projectBindings
    .filter(binding => binding.provider && binding.chatId && binding.sessionId)
    .map(binding => ({
      provider: String(binding.provider),
      chatId: String(binding.chatId),
      threadId: binding.threadId,
      sessionId: binding.sessionId,
      mode: 'roadmap' as const,
      roadmapId: binding.roadmapId,
      title: binding.title || binding.alias,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    }))
}

function summaryForState(state: OperatorSafetyState, counts: { queue: ReturnType<typeof summarizeWorkTasks>; gates: number; questions: number; permissions: number; alerts: number; expired: number; staleLiveState: number }): string {
  if (state === 'blocked') return 'Operator intervention is required before scaling agent execution.'
  if (state === 'paused') return 'Scheduler dispatch is paused; active OpenCode sessions can finish but new durable Issues will not start.'
  if (state === 'attention') return `${counts.queue.pending} pending Issues with ${counts.gates + counts.questions + counts.permissions + counts.alerts + counts.expired + counts.staleLiveState} operator attention signal(s).`
  return 'Ready for local beta execution on validated surfaces; deferred gates remain explicit.'
}

function attentionItems(input: { gates: any[]; questions: any[]; permissions: any[]; alerts: any[]; attentionReport: any; leasesExpired: number; requestSourcesUnavailable?: boolean }): OperatorSafetyReport['attention']['items'] {
  const rows: OperatorSafetyReport['attention']['items'] = []
  if (input.leasesExpired) rows.push({ kind: 'lease', title: 'Expired scheduler leases', summary: `${input.leasesExpired} running run lease(s) expired.`, nextAction: 'Run `opencode-gateway operator recover`.' })
  if (input.requestSourcesUnavailable) rows.push({ kind: 'requests', title: 'OpenCode request source unavailable', summary: 'Gateway could not confirm pending questions or permissions.', nextAction: 'Open OpenCode Web/TUI and verify request state before claiming beta readiness.' })
  for (const alert of input.alerts.slice(0, 4)) rows.push({ kind: 'alert', title: String(alert.summary || alert.key || 'Alert'), summary: String(alert.source || alert.severity || 'Gateway alert'), nextAction: String(alert.nextAction || 'Inspect Mission Control Health.') })
  for (const gate of input.gates.slice(0, 4)) rows.push({ kind: 'gate', title: String(gate.reason || gate.type || 'Human gate'), summary: String(gate.scopeKey || gate.status || 'pending'), nextAction: `Review human gate ${gate.id}.` })
  if (input.questions.length) rows.push({ kind: 'question', title: 'OpenCode questions pending', summary: `${input.questions.length} question(s) need an answer.`, nextAction: 'Answer in OpenCode Web/TUI or the bound trusted channel.' })
  if (input.permissions.length) rows.push({ kind: 'permission', title: 'OpenCode permissions pending', summary: `${input.permissions.length} permission request(s) need approval.`, nextAction: 'Approve or deny in OpenCode Web/TUI.' })
  const unified = Array.isArray(input.attentionReport?.items) ? input.attentionReport.items : []
  for (const item of unified.slice(0, Math.max(0, 8 - rows.length))) {
    rows.push({ kind: String(item.kind || 'attention'), title: String(item.title || 'Attention item'), summary: String(item.summary || ''), nextAction: String(item.action || 'Open Mission Control.') })
  }
  return dedupeAttentionRows(rows).slice(0, 12)
}

function dedupeAttentionRows(rows: OperatorSafetyReport['attention']['items']): OperatorSafetyReport['attention']['items'] {
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = `${row.kind}:${row.title}:${row.summary}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function operatorActions(enabled: boolean): OperatorSafetyReport['actions'] {
  return [
    { action: 'status', command: 'opencode-gateway operator status', description: 'Print this redacted operator report.' },
    { action: 'hygiene', command: 'opencode-gateway operator hygiene', description: 'Inspect stale claim codes, human gates, session links, and parent receipt clutter without writing state.' },
    { action: enabled ? 'pause' : 'resume', command: `opencode-gateway operator ${enabled ? 'pause' : 'resume'}`, description: enabled ? 'Pause new scheduler dispatch while active sessions continue.' : 'Resume scheduler dispatch for runnable durable Issues.' },
    { action: 'recover', command: 'opencode-gateway operator recover', description: 'Recover expired leases and missing OpenCode sessions using existing retry policy.' },
    { action: 'run-control', command: 'opencode-gateway operator run <runId> <cancel|stop|retry|restart> --lease-owner <owner>', description: 'Apply a lease-safe control to one active run; retry/restart requeue durable work and do not reuse the current OpenCode session.' },
    { action: 'reset-stale', command: 'opencode-gateway operator reset-stale', description: 'Expire resettable stale support artifacts and apply configured human-gate timeout policy.' },
    { action: 'status', command: 'opencode-gateway readiness', description: 'Inspect lower-level local operating readiness checks.' },
  ]
}

function auditOperatorAction(action: OperatorSafetyAction, target: string, result: 'ok' | 'denied' | 'error'): void {
  try {
    appendAuditEvent({
      actor: 'operator-cli',
      source: 'operator-safety',
      operation: `operator.${action}`,
      target,
      result,
    })
  } catch {}
}

function auditOperatorRunControl(action: ActiveRunControlAction, runId: string, result: 'ok' | 'denied' | 'error', actor: string, source: string, details: Record<string, unknown>): void {
  try {
    appendAuditEvent({
      actor,
      source,
      operation: `operator.run.${action}`,
      target: runId,
      result,
      details,
    })
  } catch {}
}
