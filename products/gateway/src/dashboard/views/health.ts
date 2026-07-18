import { esc, escAttr } from '../html.js'
import { asArray, shortId, fmtNumber, compactNumber, fmtMoney, fmtDuration, formatDateTime, timeUntil } from '../format.js'
import { card, headFig, mini, gauge } from '../components.js'
import { readinessLabel, serviceHealthLabel, serviceHealthClass, heartbeatLabel, heartbeatClass } from './shared.js'
import type { DashboardView } from '../types.js'
import type { ServiceHealthReport } from '../../service-health.js'
import type { HeartbeatStatus } from '../../heartbeat.js'
import type { ObservabilitySloResult } from '../../observability-contract.js'
import type { MissionAgentTeamSummary } from '../../mission-data.js'

function renderHealth(view: DashboardView): string {
  const budgetPct = budgetUsedPct(view.governance)
  const teamWarnings = view.agentTeams.totals.invalidReferences + view.agentTeams.teams.filter(team => team.health === 'warning').length
  return `<section class="view" data-view="health">
    <div class="view-head"><div><h1 class="page-h">Health And Governance</h1><p class="page-sub">Local-beta service health, local operating readiness, heartbeat, Gateway run budgets, alerts, agent teams, and scheduler profiles.</p></div><div class="head-figs">
      ${headFig(serviceHealthLabel(view.serviceHealth), 'service')}${headFig(readinessLabel(view.readiness), 'readiness')}${headFig(String(view.counts.alerts), 'alerts')}${headFig(budgetPct === undefined ? '--' : `${Math.max(0, 100 - budgetPct)}%`, 'headroom')}
    </div></div>
    ${card('Service Health', 'S', `<span class="pill ${serviceHealthClass(view.serviceHealth)}">${esc(serviceHealthLabel(view.serviceHealth))}</span>`, renderServiceHealth(view.serviceHealth))}
    ${card('Trace And SLOs', 'O', `<span class="pill ${observabilityClass(view.observabilitySlo)}">${esc(observabilityLabel(view.observabilitySlo))}</span>`, renderObservability(view))}
    ${card('Operating Readiness', 'H', `<span class="pill ${readinessClass(view.readiness)}">${esc(readinessLabel(view.readiness))}</span>`, renderReadiness(view.readiness))}
    <div class="grid-2">
      ${card('Heartbeat', 'P', `<span class="pill ${heartbeatClass(view.heartbeat)}">${esc(heartbeatLabel(view.heartbeat))}</span>`, renderHeartbeat(view.heartbeat))}
      ${card('Governance Budgets', 'G', `<span class="pill ${governanceClass(view.governance)}">${esc(governanceLabel(view.governance))}</span>`, renderGovernance(view.governance))}
    </div>
    <div class="grid-2">
      ${card('Active Alerts', '!', `<span class="pill ${view.counts.alerts ? 'bad' : 'good'}">${view.counts.alerts ? `${view.counts.alerts} active` : 'clear'}</span>`, renderAlerts(view.alerts))}
      ${card('Agent Teams', 'T', `<span class="pill ${teamWarnings ? 'warn' : 'good'}">${teamWarnings ? `${teamWarnings} warning${teamWarnings === 1 ? '' : 's'}` : `${view.agentTeams.totals.teams} teams`}</span>`, renderAgentTeams(view.agentTeams))}
    </div>
    ${card('Scheduler Profiles', 'P', `<span class="pill">${Object.keys(view.profiles || {}).length}</span>`, renderProfilesFromView(view))}
  </section>`
}
function renderReadiness(readiness: any): string {
  const checks = asArray(readiness?.checks)
  if (!checks.length) return '<p class="empty">No readiness checks available.</p>'
  return `<div class="lane">${checks.map((check: any) => `<div class="row compact"><span class="dot ${check.status === 'pass' ? 'done' : check.severity === 'critical' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(check.name)}: ${esc(check.summary)}</div><div class="meta">${esc(check.severity || 'info')}</div>${renderReadinessDetails(check)}</div><span class="pill ${check.status === 'pass' ? 'good' : check.severity === 'critical' ? 'bad' : 'warn'}">${esc(check.status || '?')}</span></div>`).join('')}</div>`
}

function renderReadinessDetails(check: any): string {
  if (check?.name === 'storage') return renderBackendActivationDetails(check)
  if (check?.name !== 'security_secret_lifecycle') return ''
  const posture = check.details?.operatorPosture
  if (!posture) return ''
  const references = asArray(posture.references)
  const guardrails = posture.injectionGuardrails || {}
  const health = posture.rotationHealth || {}
  const revocation = posture.revocation || {}
  const guardrailText = [
    guardrails.exactReferences ? 'exact refs' : '',
    guardrails.exactEnvAllowlist ? 'exact env' : '',
    guardrails.providerScopeEnforced ? 'provider scope' : '',
    guardrails.projectScopeRequired ? 'project scope' : '',
    guardrails.workerLeaseRequired ? 'worker lease' : '',
    guardrails.revokedReferencesDenied ? 'revoked denied' : '',
  ].filter(Boolean).join(' / ')
  const rows = references.slice(0, 6).map((reference: any) => `<tr><td class="name">${esc(reference.inputId || reference.id)}</td><td>${esc(reference.source || '--')}</td><td>${esc(reference.scope?.path || '--')}</td><td>${esc(reference.capability || '--')}</td><td><span class="pill ${secretHealthClass(reference.rotation?.health)}">${esc(reference.rotation?.health || '--')}</span></td><td><span class="pill ${reference.revocation?.state === 'revoked' ? 'bad' : 'good'}">${esc(reference.revocation?.state || '--')}</span></td></tr>`).join('')
  return `<div class="meta">Secret posture: ${esc(posture.mode || 'secret lifecycle')} / rotation h:${fmtNumber(health.healthy || 0)} d:${fmtNumber(health.due || 0)} o:${fmtNumber(health.overdue || 0)} b:${fmtNumber(health.blocked || 0)} u:${fmtNumber(health.unsupported || 0)} / revocation active:${fmtNumber(revocation.active || 0)} revoked:${fmtNumber(revocation.revoked || 0)} / ${esc(guardrailText || 'guardrails unavailable')}</div>
    ${rows ? `<div class="table-wrap" style="margin-top:8px"><table class="table"><thead><tr><th>Reference</th><th>Source</th><th>Scope</th><th>Capability</th><th>Rotation</th><th>Revocation</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty good" style="margin-top:8px">No configured secret references.</p>'}
    <div class="src-note">Secret lifecycle rows are value-free. Mission Control renders reference IDs, scopes, posture, and denial policy only.</div>`
}

function renderBackendActivationDetails(check: any): string {
  const backend = check.details?.backend
  const activation = backend?.activation
  if (!activation) return ''
  const blockers = asArray(activation.blockers)
  const commands = asArray(activation.supportedCommands)
  const commandRows = commands.slice(0, 5).map((command: any) => `<tr><td class="name">${esc(command.id || '--')}</td><td>${esc(command.command || '--')}</td><td>${command.safeByDefault ? '<span class="pill good">safe dry-run</span>' : '<span class="pill warn">operator gated</span>'}</td></tr>`).join('')
  const blockerText = blockers.length
    ? blockers.slice(0, 4).map((blocker: any) => `${blocker.severity}:${blocker.code}`).join(' / ')
    : 'none'
  return `<div class="meta">Backend activation: ${esc(activation.status || '--')} / runtime ${esc(backend.mode || '--')} / persistence ${esc(backend.effectivePersistence || '--')} / cutover ${esc(activation.cutoverReadiness || '--')} / rollback ${esc(activation.rollbackReadiness || '--')} / blockers ${esc(blockerText)}</div>
    ${commandRows ? `<div class="table-wrap" style="margin-top:8px"><table class="table"><thead><tr><th>Command</th><th>Operator Invocation</th><th>Gate</th></tr></thead><tbody>${commandRows}</tbody></table></div>` : ''}
    <div class="src-note">Backend activation is value-free. Mission Control renders env var names, mode, proof gates, and blocker codes only; connection strings and credentials are never shown.</div>`
}

function secretHealthClass(health: unknown): string {
  if (health === 'healthy') return 'good'
  if (health === 'blocked' || health === 'overdue') return 'bad'
  return 'warn'
}

function renderServiceHealth(report: ServiceHealthReport): string {
  const rows = asArray(report.components)
  const counts = serviceHealthCounts(report)
  const summary = `<div class="grid-3">${mini('OK', fmtNumber(counts.ok))}${mini('Degraded', fmtNumber(counts.degraded))}${mini('Down', fmtNumber(counts.down))}</div>`
  if (!rows.length) return `${summary}<p class="empty" style="margin-top:10px">Service health report is unavailable.</p>`
  return `${summary}<div class="lane" style="margin-top:10px">${rows.map((row: any) => `<div class="row compact"><span class="dot ${row.status === 'ok' ? 'done' : row.status === 'down' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(row.label)}: ${esc(row.summary)}</div><div class="meta">${esc(row.detail || '')}${row.status !== 'ok' ? ` / next: ${esc(row.remediation || '')}` : ''}</div></div><span class="pill ${row.status === 'ok' ? 'good' : row.status === 'down' ? 'bad' : 'warn'}">${esc(row.status || '?')}</span></div>`).join('')}</div><div class="src-note">Generated ${report.generatedAt ? esc(formatDateTime(report.generatedAt)) : '--'} from daemon, dashboard, storage, scheduler, channel adapters, OpenCode connectivity, and config checks.</div>`
}

function renderObservability(view: DashboardView): string {
  const trace = view.traceCorrelation
  const slo = view.observabilitySlo
  const support = view.supportOperations
  const counts = {
    pass: slo.filter(row => row.status === 'pass').length,
    warn: slo.filter(row => row.status === 'warn').length,
    fail: slo.filter(row => row.status === 'fail').length,
  }
  const status = observabilityLabel(slo)
  const sourceHealthRows = asArray(support?.sourceHealth).slice(0, 5)
  const actionRows = asArray(support?.operatorActions).slice(0, 6)
  const traceRows = [
    ...(trace?.tasks || []).slice(0, 4).map(row => `<div class="row compact"><span class="dot ${row.status === 'done' ? 'done' : row.status === 'running' ? 'running' : row.status === 'blocked' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(row.traceId)}</div><div class="meta">task ${esc(shortId(row.taskId))} / ${esc(row.status)} / ${row.runTraceIds.length} run trace${row.runTraceIds.length === 1 ? '' : 's'}</div></div><span class="pill purple">task</span></div>`),
    ...(trace?.runs || []).slice(0, 4).map(row => `<div class="row compact"><span class="dot ${row.status === 'passed' ? 'done' : row.status === 'running' ? 'running' : row.status === 'failed' || row.status === 'errored' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(row.traceId)}</div><div class="meta">run ${esc(shortId(row.runId))} / ${esc(row.stage)} / taskTrace ${esc(row.taskTraceId || 'none')}</div></div><span class="pill purple">run</span></div>`),
    ...(trace?.auditLedger || []).slice(0, 3).map(row => `<div class="row compact"><span class="dot ${row.result === 'ok' ? 'done' : row.result === 'denied' || row.result === 'error' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(row.traceId)}</div><div class="meta">audit ${esc(shortId(row.eventId))} / ${esc(row.action)} / ${esc(row.result)}</div></div><span class="pill purple">audit</span></div>`),
  ]
  return `<div class="grid-4">${mini('Trace root', trace?.traceRootId || 'unavailable')}${mini('SLO status', status)}${mini('Results', `${counts.pass}/${counts.warn}/${counts.fail} p/w/f`)}${mini('Support', support?.status || 'unavailable')}</div>
    <div class="lane" style="margin-top:10px">
      ${slo.length ? slo.map(row => `<div class="row compact"><span class="dot ${row.status === 'pass' ? 'done' : row.status === 'fail' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(row.label)}</div><div class="meta">${esc(row.summary)}</div></div><span class="pill ${row.status === 'pass' ? 'good' : row.status === 'fail' ? 'bad' : 'warn'}">${esc(row.status)}</span></div>`).join('') : '<p class="empty">No SLO snapshot is available.</p>'}
      ${support ? `<div class="row compact"><span class="dot ${support.status === 'ready' ? 'done' : support.status === 'blocked' ? 'blocked' : 'pending'}"></span><div><div class="title">Support operations: ${esc(support.releaseClaim)}</div><div class="meta">mode ${esc(support.currentMode)} / incident ${esc(support.incidentBundle.status)} / actions ${support.operatorActions.length}</div></div><span class="pill ${support.status === 'ready' ? 'good' : support.status === 'blocked' ? 'bad' : 'warn'}">${esc(support.status)}</span></div>` : '<p class="empty">Support operations contract is unavailable.</p>'}
      ${sourceHealthRows.length ? sourceHealthRows.map((row: any) => `<div class="row compact"><span class="dot ${row.status === 'ready' || row.status === 'empty' ? 'done' : row.status === 'unavailable' || row.status === 'degraded' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(row.source)}</div><div class="meta">${esc(row.summary)}</div></div><span class="pill ${row.status === 'ready' || row.status === 'empty' ? 'good' : row.status === 'unavailable' || row.status === 'degraded' ? 'bad' : 'warn'}">${esc(row.status)}</span></div>`).join('') : ''}
      ${actionRows.length ? actionRows.map((row: any) => `<div class="row compact"><span class="dot ${row.safeByDefault ? 'done' : 'pending'}"></span><div><div class="title">${esc(row.label)}</div><div class="meta">${esc(row.command)} / audit ${esc(row.auditOperation)}</div></div><span class="pill ${row.safeByDefault ? 'good' : 'warn'}">${row.safeByDefault ? 'safe' : 'gated'}</span></div>`).join('') : ''}
      ${traceRows.length ? traceRows.join('') : '<p class="empty">No trace samples are available.</p>'}
    </div>
    <div class="src-note">source: /observability. Trace samples use deterministic correlation IDs; channel targets, session IDs, private paths, and provider payloads stay hashed or redacted. Hosted SLO and managed-support claims remain unsupported.</div>`
}

function observabilityLabel(rows: ObservabilitySloResult[]): string {
  if (!rows.length) return 'Unavailable'
  if (rows.some(row => row.status === 'fail')) return 'Fail'
  if (rows.some(row => row.status === 'warn')) return 'Warn'
  return 'Pass'
}

function observabilityClass(rows: ObservabilitySloResult[]): string {
  if (!rows.length) return 'warn'
  if (rows.some(row => row.status === 'fail')) return 'bad'
  if (rows.some(row => row.status === 'warn')) return 'warn'
  return 'good'
}

function serviceHealthCounts(report: ServiceHealthReport): Record<'ok' | 'degraded' | 'down', number> {
  const counts = (report as any).serviceCounts || report.counts || {}
  return { ok: Number(counts.ok || 0), degraded: Number(counts.degraded || 0), down: Number(counts.down || 0) }
}
function renderHeartbeat(heartbeat: HeartbeatStatus): string {
  return `<div class="grid-3">${mini('Status', heartbeatLabel(heartbeat))}${mini('Next Ping', heartbeat.nextDueAt ? `<span data-countdown="${escAttr(heartbeat.nextDueAt)}">${esc(timeUntil(heartbeat.nextDueAt))}</span>` : '--', true)}${mini('Cycle Time', heartbeat.lastDurationMs !== undefined ? fmtDuration(heartbeat.lastDurationMs) : '--')}</div><div class="lane" style="margin-top:10px"><div class="row compact"><div><div class="title">${esc(heartbeat.lastSummary || 'No heartbeat has run yet.')}</div><div class="meta">interval ${fmtDuration(heartbeat.intervalMs)} / ticks ${heartbeat.tickCount} / skipped ${heartbeat.skippedTicks}${heartbeat.lastCompletedAt ? ` / completed ${formatDateTime(heartbeat.lastCompletedAt)}` : ''}</div></div><span class="pill ${heartbeat.schedulerEnabled ? 'good' : 'warn'}">${heartbeat.schedulerEnabled ? 'scheduler on' : 'scheduler off'}</span></div>${heartbeat.lastError ? `<div class="row compact"><div><div class="title bad-text">${esc(heartbeat.lastError)}</div><div class="meta">last heartbeat error</div></div></div>` : ''}</div>`
}

function renderGovernance(governance: any): string {
  const budgets = asArray(governance?.budgets)
  const totals = governance?.totals || {}
  const pct = budgetUsedPct(governance)
  return `<div class="grid-2"><div>${pct === undefined ? '<p class="empty">No global budget gauge available.</p>' : gauge(pct, pct >= 80 ? 'var(--orange)' : 'var(--green)', 'Budget used', `${Math.max(0, 100 - pct)}% headroom`)}</div><div class="lane">${mini('Run Spend', fmtMoney(Number(totals.costUsd || 0)))}${mini('Run Tokens', compactNumber(Number(totals.tokens || 0)))}${mini('Runtime', fmtDuration(Number(totals.runtimeMs || 0)))}</div></div><div class="src-note">source: Gateway run records. This is separate from Usage, which reads opencode.db.</div>${budgets.length ? `<div class="lane" style="margin-top:10px">${budgets.map((budget: any) => `<div class="row compact"><div><div class="title">${esc(budget.name || budget.scope || 'budget')}</div><div class="meta">${esc(budget.reason || '')}</div></div><span class="pill ${budget.status === 'blocked' || budget.status === 'paused' ? 'bad' : budget.status === 'warn' ? 'warn' : 'good'}">${esc(budget.status || '?')}</span></div>`).join('')}</div>` : '<p class="empty" style="margin-top:10px">No budgets configured. Add governance.global, governance.roadmaps, governance.tasks, or governance.stages limits.</p>'}`
}

function renderAlerts(alerts: any[]): string {
  const rows = asArray(alerts)
  if (!rows.length) return '<p class="empty good">No active incidents.</p>'
  return `<div class="lane">${rows.map((alert: any) => `<div class="row compact"><span class="dot ${alert.severity === 'critical' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(alert.summary || alert.key || 'alert')}</div><div class="meta">${esc(alert.source || '?')} / ${esc(alert.key || alert.id || '?')} / ${esc(alert.nextAction || '')}</div></div><span class="pill ${alert.severity === 'critical' ? 'bad' : alert.severity === 'warning' ? 'warn' : 'good'}">${esc(alert.severity || '?')}</span></div>`).join('')}</div>`
}

function renderProfilesFromView(view: DashboardView): string {
  const profiles = Object.entries(view.profiles || {})
  return profiles.length ? renderProfiles(Object.fromEntries(profiles)) : '<p class="empty">Profiles are unavailable in this payload.</p>'
}
function renderProfiles(profiles: Record<string, any>): string {
  const rows = Object.entries(profiles || {}).sort(([a], [b]) => a.localeCompare(b))
  if (!rows.length) return '<p class="empty">No scheduler profiles configured.</p>'
  return `<div class="lane">${rows.map(([name, profile]) => `<div class="row compact"><div><div class="title">${esc(name)} -> ${esc(profile.agent || '?')}</div><div class="meta">${esc(profile.model?.providerID || '?')}/${esc(profile.model?.modelID || '?')} / ${esc(profile.role || 'role')}</div></div><span class="pill purple">${esc(profile.role || 'role')}</span></div>`).join('')}</div>`
}
function renderAgentTeams(summary: MissionAgentTeamSummary): string {
  const teams = asArray(summary.teams)
  const invalid = asArray(summary.invalidReferences)
  const rows = teams.map(team => {
    const roleText = asArray(team.roles).map((role: any) => `${role.stage}:${role.profile}${role.agent ? ` -> ${role.agent}` : ''}`).join(' / ') || 'no roles'
    const refs = team.references || { roadmaps: 0, tasks: 0, activeTasks: 0, recentRuns: 0 }
    const warningText = asArray(team.warnings).join(' / ')
    return `<div class="row compact"><div><div class="title">${esc(team.name)}${team.description ? ` - ${esc(team.description)}` : ''}</div><div class="meta">${esc(roleText)} / ${fmtNumber(refs.roadmaps)} roadmaps / ${fmtNumber(refs.tasks)} tasks / ${fmtNumber(refs.recentRuns)} runs${warningText ? ` / ${esc(warningText)}` : ''}</div></div><span class="pill ${team.health === 'warning' ? 'warn' : 'good'}">${esc(team.revision || 'ok')}</span></div>`
  })
  const invalidRows = invalid.map((ref: any) => `<div class="row compact"><span class="dot blocked"></span><div><div class="title">Missing team ${esc(ref.agentTeam)}</div><div class="meta">${esc(ref.kind)} ${esc(shortId(ref.id))}${ref.title ? ` / ${esc(ref.title)}` : ''} / ${esc(ref.reason || 'invalid reference')}</div></div><span class="pill bad">invalid</span></div>`)
  if (!rows.length && !invalidRows.length) return '<p class="empty">No agent teams are configured.</p>'
  return `<div class="lane">${[...invalidRows, ...rows].join('')}</div><div class="src-note">source: normalized Gateway config plus Project, Issue, and recent run references. Profile permissions and credentials are not included.</div>`
}
function readinessClass(readiness: any): string {
  if (readiness?.state === 'ready') return 'good'
  if (readiness?.state === 'degraded') return 'warn'
  return 'bad'
}
function governanceLabel(governance: any): string {
  if (!governance?.enabled) return 'Disabled'
  if (governance.status === 'blocked') return 'Blocked'
  if (governance.status === 'warn') return 'Warn'
  return 'OK'
}

function governanceClass(governance: any): string {
  if (governance?.status === 'blocked') return 'bad'
  if (governance?.status === 'warn') return 'warn'
  return 'good'
}

function budgetUsedPct(governance: any): number | undefined {
  const budget = asArray(governance?.budgets).find((row: any) => Number(row.limit || 0) > 0 && Number(row.used || 0) >= 0)
  if (!budget) return undefined
  return Math.max(0, Math.min(100, Math.round((Number(budget.used || 0) / Number(budget.limit)) * 100)))
}

export { renderHealth }
